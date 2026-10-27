import type { JsonObject, OffloadInput } from './contracts.js';
import { errorCode, errorMessage } from './contracts.js';
// Private helper only: transfers an already validated render request to the user-owned Mac.
// No Git push, publication, credentials or signing. Remote/local scratch is removed in finally.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
function command(binary: string, args: string[], log: (message: string) => void = () => { }) {
    return new Promise<string>((resolve, reject) => {
        const p = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '', err = '';
        p.stdout.on('data', d => { out += d; });
        p.stderr.on('data', d => { err = (err + d).slice(-12000); log(d.toString()); });
        p.once('error', reject);
        p.once('close', c => c === 0 ? resolve(out) : reject(Error(binary + ' failed: ' + err)));
    });
}
export async function offload(op: string, input: OffloadInput, { log = () => { } }: {
    log?: (message: string) => void;
} = {}) {
    if (!['render', 'stills', 'snapshot', 'clip', 'inspect'].includes(op))
        throw Error('Capture needs its browser/ROM runtime on the selected machine');
    const stage = await mkdtemp(path.join(os.tmpdir(), 'keel-trailer-offload-'));
    const id = 'keel-trailer-' + randomUUID();
    const relative = 'work/' + id;
    const host = 'yuna-mbp';
    const ssh = (s: string) => command('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, 'export PATH="$HOME/.local/share/keel-trailer-runtime/bin":/opt/homebrew/bin:$PATH; ' + s], log);
    let created = false;
    try {
        const free = await ssh('df -Pk "$HOME"');
        const available = Number(free.trim().split('\n').at(-1)!.trim().split(/\s+/)[3]) * 1024;
        if (available < 12 * 1024 ** 3)
            throw Error('yuna-mbp has less than 12 GiB free; inspect its disk before offloading');
        await ssh('command -v ffmpeg && python3 -c "import sys; assert sys.version_info >= (3,11)"');
        await ssh('mkdir -p "$HOME/' + relative + '"');
        created = true;
        const pkg = fileURLToPath(new URL('../', import.meta.url));
        await mkdir(path.join(stage, 'pkg'));
        for (const part of ['dist', 'python', 'assets', 'package.json', 'requirements.txt'])
            await cp(path.join(pkg, part), path.join(stage, 'pkg', part), { recursive: true, filter: p => !p.includes('__pycache__') });
        const x = structuredClone(input), t = x.timeline;
        const mapping = new Map();
        let index = 0;
        async function media(p: string) {
            if (mapping.has(p))
                return mapping.get(p);
            let target;
            if (t?.reference && p.startsWith(input.timeline!.reference!.capturesRoot + path.sep))
                target = path.join('captures', path.relative(input.timeline!.reference!.capturesRoot, p));
            else
                target = path.join('media', String(index++) + path.extname(p));
            const dest = path.join(stage, target);
            await mkdir(path.dirname(dest), { recursive: true });
            await cp(p, dest);
            mapping.set(p, target);
            return target;
        }
        for (const s of t?.sources ?? []) {
            s.path = await media(s.path);
            if (s.metadataPath)
                s.metadataPath = await media(s.metadataPath);
            for (const v of s.variants ?? []) {
                v.path = await media(v.path);
                if (v.metadataPath)
                    v.metadataPath = await media(v.metadataPath);
            }
        }
        for (const shot of t?.shots ?? [])
            for (const text of [shot.text, shot.caption])
                if (text)
                    text.font = await media(text.font);
        if (t?.reference) {
            t.reference.font = await media(t.reference.font);
            t.reference.capturesRoot = 'captures';
        }
        if (x.mediaPath)
            x.mediaPath = await media(x.mediaPath);
        const localOutput = x.outDir;
        x.outDir = 'output';
        delete x.remote;
        await writeFile(path.join(stage, 'request.json'), JSON.stringify({ name: 'trailer-' + op, input: x }));
        await command('rsync', ['-a', stage + '/', host + ':' + relative + '/'], log);
        await writeFile(path.join(stage, 'run.js'), "import {readFile} from 'node:fs/promises';import {runTrailerTool} from './pkg/dist/index.js';const x=JSON.parse(await readFile('request.json','utf8'));try{console.log(JSON.stringify(await runTrailerTool(x.name,x.input,{workspaceRoot:'.',python:'.venv/bin/python',allowOffload:false,log:s=>process.stderr.write(s)})));}catch(e){console.log(JSON.stringify({error:e.message}));process.exitCode=1;}");
        await command('rsync', ['-a', path.join(stage, 'run.js'), host + ':' + relative + '/run.js'], log);
        await ssh('cd "$HOME/' + relative + '" && command -v ffmpeg && command -v node && python3 -m venv .venv && .venv/bin/python -m pip install -q -r pkg/requirements.txt && node run.js > result.json');
        await command('rsync', ['-a', host + ':' + relative + '/output/', localOutput + '/'], log);
        await command('rsync', ['-a', host + ':' + relative + '/result.json', path.join(stage, 'result.json')], log);
        const result = JSON.parse(await readFile(path.join(stage, 'result.json'), 'utf8'));
        function rebase(v: unknown): unknown {
            if (typeof v === 'string' && v.includes('/' + relative + '/output'))
                return path.join(localOutput, v.split('/' + relative + '/output/')[1] ?? '');
            if (Array.isArray(v))
                return v.map(rebase);
            if (v && typeof v === 'object')
                return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, rebase(val)]));
            return v;
        }
        function remoteRoot(v: unknown): string | undefined {
            const marker = '/' + relative + '/output';
            if (typeof v === 'string' && v.includes(marker))
                return v.slice(0, v.indexOf(marker) + marker.length);
            if (v && typeof v === 'object')
                for (const x of Object.values(v)) {
                    const root = remoteRoot(x);
                    if (root)
                        return root;
                }
        }
        const root = remoteRoot(result);
        if (root) {
            const f = path.join(localOutput, 'index.html');
            try {
                const html = await readFile(f, 'utf8');
                await writeFile(f, html.replaceAll(root, JSON.stringify(localOutput).slice(1, -1).replaceAll('<', '\\u003c')));
            }
            catch (e) {
                if (errorCode(e) !== 'ENOENT')
                    throw e;
            }
        }
        const local = rebase(result) as JsonObject;
        local.execution = { host, offloaded: true, privateTransfer: true };
        for (const name of ['render.json', 'verification.json', 'inspection.json', 'snapshots.json', 'clip.json']) {
            const f = path.join(localOutput, name);
            try {
                const m = JSON.parse(await readFile(f, 'utf8'));
                await writeFile(f, JSON.stringify(rebase(m), null, 2) + '\n');
            }
            catch (e) {
                if (errorCode(e) !== 'ENOENT')
                    throw e;
            }
        }
        return local;
    }
    finally {
        if (created)
            await ssh('rm -rf "$HOME/' + relative + '"').catch(e => log('Remote scratch cleanup failed: ' + errorMessage(e) + '\n'));
        await rm(stage, { recursive: true, force: true });
    }
}
