import type { JsonObject, OffloadInput, ToolOptions, WorkerOptions } from './contracts.js';
import { errorCode } from './contracts.js';
import type { Tempo, Timeline } from './timeline.js';
import type { ToolInputMap, ToolRequest, TrailerToolName } from './tool-types.js';
export { compareAudio, testAudioConversion } from './audio-test.js';
export type { CaptureAdapter, CaptureRequest, ToolOptions, WorkerOptions } from './contracts.js';
export { assertInspection, INSPECTION_SCHEMA, queryInspection } from './inspection.js';
export { testTrailerLiveMP4 } from './live-mp4-test.js';
export { assertScore, createScoreCodec, importMidi, renderScore } from './music.js';
export { renderTrailerBundle } from './onchain-render.js';
export { testTrailerBundle } from './onchain-test.js';
export { buildTrailerSdkPreview, compileTrailerProject, verifyTrailerBundle } from './onchain.js';
export { createInspectionProbe, graphSnapshot, gridSnapshot, meshSnapshot } from './probe.js';
export { assertProgram, assertSceneData, createSceneCodec, createScenePlayer } from './program.js';
export { prepareTrailerPublication } from './publication.js';
export { reviewTrailerBundleReuse, reviewTrailerSharedSourceReuse } from './reuse-review.js';
export type * from './timeline.js';
export { beatToSeconds, boundaryFrame, editSeconds, sourceFrame } from './timing.js';
export type * from './tool-types.js';
export { CAPTURE_SCHEMA, registerCaptureAdapter, TIMELINE_SCHEMA, TOOL_SCHEMAS, validateTimeline };
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { captureWithAdapter, registerCaptureAdapter } from './adapters/index.js';
import { assertInspection, clipMedia, inspectSnapshot, mediaSnapshot } from './inspection.js';
import { assertSchema, assertTimeline, CAPTURE_SCHEMA, TIMELINE_SCHEMA, TOOL_SCHEMAS, validateTimeline } from './schema.js';
import { beatToSeconds, editSeconds } from './timing.js';
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const defaultPython = () => process.env.TRAILER_PYTHON ?? (existsSync(path.join(packageRoot, '.venv/bin/python')) ? path.join(packageRoot, '.venv/bin/python') : 'python3');
function inside(root: string, file: string) {
    const rel = path.relative(root, file);
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel))
        throw Error('Path must stay inside trailer workspace: ' + file);
    return file;
}
async function file(root: string, base: string, p: unknown) {
    if (typeof p !== 'string' || !p || /[\0\r\n]/.test(p))
        throw Error('Invalid file path');
    const candidate = inside(root, path.resolve(base, p));
    const resolved = inside(root, await realpath(candidate));
    if (!(await stat(resolved)).isFile())
        throw Error('Expected a file: ' + p);
    return resolved;
}
async function noSymlinks(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink())
            throw Error('Output directory contains a symlink: ' + entry.name);
        if (entry.isDirectory())
            await noSymlinks(path.join(dir, entry.name));
    }
}
async function output(root: string, p: string) {
    const candidate = inside(root, path.resolve(root, p));
    let parent = candidate;
    for (;;) {
        try {
            inside(root, await realpath(parent));
            break;
        }
        catch (e) {
            if (errorCode(e) !== 'ENOENT')
                throw e;
            parent = path.dirname(parent);
        }
    }
    await mkdir(candidate, { recursive: true });
    inside(root, await realpath(candidate));
    await noSymlinks(candidate);
    return candidate;
}
export async function runWorker<T extends object = JsonObject>(op: string, input: unknown, { python = defaultPython(), log = () => { }, signal }: WorkerOptions = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const proc = spawn(python, [path.join(packageRoot, 'python/worker.py'), op], { stdio: ['pipe', 'pipe', 'pipe'], signal });
        const out: Buffer[] = [];
        let error = '';
        proc.stdout.on('data', b => out.push(b));
        proc.stderr.on('data', b => { error = (error + b.toString()).slice(-12000); log(b.toString()); });
        proc.once('error', reject);
        proc.once('close', code => {
            let value;
            try {
                value = JSON.parse(Buffer.concat(out).toString());
            }
            catch {
                reject(Error('Trailer worker failed; install requirements.txt and ffmpeg. ' + error));
                return;
            }
            if (code !== 0)
                reject(Object.assign(Error(value.error?.message ?? error), { result: value }));
            else
                resolve(value);
        });
        proc.stdin.on('error', () => { });
        proc.stdin.end(JSON.stringify(input));
    });
}
export function checkLoad(operation: string) {
    const oneMinute = os.loadavg()[0];
    if (oneMinute > 40)
        throw Object.assign(Error('Mac load exceeds 40; offload ' + operation + ' to ssh yuna-mbp using the private offload helper.'), { code: 'OFFLOAD_REQUIRED', load: oneMinute });
    return oneMinute;
}
function plan(x: ToolInputMap['trailer-plan']) {
    const visuals = x.sources.filter(s => s.kind !== 'audio');
    if (!visuals.length)
        throw Error('At least one visual source is required');
    const audio = x.sources.find(s => s.kind === 'audio');
    const total = x.durationBeats ?? 64;
    let shots = [];
    let start = 0;
    const count = visuals.length + (x.font ? 1 : 0), beats = total / count;
    for (const [i, s] of visuals.entries()) {
        shots.push({ id: 'shot-' + (i + 1), startBeat: start, beats, kind: s.kind === 'image' ? 'image' : 'video', source: s.id, in: 0, fit: (s.pixelArt ?? s.kind === 'gameboy') ? 'integer' : 'contain', transition: { type: i ? 'dither' : 'cut', beats: Math.min(.25, beats), pixelScale: 1 } });
        start += beats;
    }
    if (x.font)
        shots.push({ id: 'end-card', startBeat: start, beats, kind: 'card', text: { lines: [x.brief], font: x.font, fontSize: 8, scale: 4, typingCps: 40 }, transition: { type: 'glitch', beats: Math.min(.25, beats), pixelScale: 4 } });
    const t = { version: 1, name: 'launch-trailer', brief: x.brief, fps: 30, seed: 7,
        tempo: x.bpm ? { bpm: x.bpm, ...(audio ? { audioSource: audio.id } : {}) } : audio ? { audioSource: audio.id, mode: 'detected' } : { bpm: 120 },
        sources: x.sources, shots, audio: audio ? [{ id: 'bed', source: audio.id, role: 'bed', startBeat: 0, beats: total, gain: 1, fadeIn: .05, fadeOut: 1.2 }] : [],
        targets: x.targets ?? [{ id: '16x9', width: 1920, height: 1080, maxBytes: 14500000, loudness: -14, truePeak: -1.5 }, { id: '9x16', width: 1080, height: 1920, maxBytes: 14500000, loudness: -14, truePeak: -1.5 }, { id: '1x1', width: 1080, height: 1080, maxBytes: 14500000, loudness: -14, truePeak: -1.5 }] };
    assertTimeline(t);
    return { timeline: t, notes: ['Scaffold uses available sources in order. Replace in/out and ramp points using capture metadata.',
            'The brief is stored as creative direction; this tool does not call a language model.', ...(!audio ? ['120 BPM is a declared placeholder. Supply original project audio before attack verification.'] : [])] };
}
async function resolveTimeline(root: string, x: {
    timeline?: Timeline;
    timelinePath?: string;
}, context: WorkerOptions) {
    let t: Timeline, base = root;
    if ((x.timeline === undefined) === (x.timelinePath === undefined))
        throw Error('Provide exactly one of timeline or timelinePath');
    if (x.timelinePath) {
        const p = await file(root, root, x.timelinePath);
        base = path.dirname(p);
        t = JSON.parse(await readFile(p, 'utf8'));
    }
    else
        t = structuredClone(x.timeline!);
    assertTimeline(t);
    for (const s of t.sources) {
        if (s.pixelArt === undefined && s.kind === 'gameboy')
            s.pixelArt = true;
        s.path = await file(root, base, s.path);
        if (s.metadataPath)
            s.metadataPath = await file(root, base, s.metadataPath);
        for (const v of s.variants ?? []) {
            v.path = await file(root, base, v.path);
            if (v.metadataPath)
                v.metadataPath = await file(root, base, v.metadataPath);
        }
        if (s.sha256) {
            const hash = createHash('sha256').update(await readFile(s.path)).digest('hex');
            if (hash !== s.sha256)
                throw Error('Source digest mismatch: ' + s.id);
        }
    }
    for (const s of t.shots)
        for (const text of [s.text, s.caption])
            if (text)
                text.font = await file(root, base, text.font);
    if (t.reference) {
        const r = t.reference;
        r.font = await file(root, base, r.font);
        r.capturesRoot = inside(root, await realpath(inside(root, path.resolve(base, r.capturesRoot))));
        const cap = r.capturesRoot;
        for (const rel of ['game/title.json', 'game/title.mkv', 'site/site-1920x1080.json', 'site/site-1920x1080.mkv',
            ...t.targets.flatMap(o => ['site/site-' + o.width + 'x' + o.height + '-opening.json', 'site/site-' + o.width + 'x' + o.height + '-opening.mkv'])])
            await file(root, cap, rel);
        if (t.tempo.beats)
            throw Error('CRUCIBLE v3 reference requires its constant beat period');
        const audio = t.sources.find(s => s.id === t.tempo.audioSource);
        if (!audio)
            throw Error('Reference requires the original audio source');
    }
    if (!t.tempo.bpm && !t.tempo.beatSeconds && !t.tempo.beats) {
        const s = t.sources.find(s => s.id === t.tempo.audioSource)!;
        const analyzed = await runWorker<{
            tempo: Tempo;
        }>('beats', { audioPath: s.path }, context);
        t.tempo = { ...analyzed.tempo, audioSource: s.id };
    }
    for (const layer of t.audio ?? [])
        if (layer.role === 'bed' && layer.source === t.tempo.audioSource && layer.in === undefined)
            layer.in = beatToSeconds(t.tempo, 0);
    return t;
}
export async function runTrailerTool(toolName: TrailerToolName, input: unknown, { workspaceRoot = '.', python, log, signal, checkMachineLoad = true, allowOffload = true }: ToolOptions = {}) {
    if (!TOOL_SCHEMAS[toolName])
        throw Error('Unknown trailer tool: ' + toolName);
    assertSchema(input, TOOL_SCHEMAS[toolName]);
    const { name, input: x } = { name: toolName, input: structuredClone(input) } as ToolRequest;
    if (name === 'trailer-plan')
        return plan(x);
    const root = await realpath(workspaceRoot);
    const context = { ...(python ? { python } : {}), ...(log ? { log } : {}), ...(signal ? { signal } : {}) };
    async function onHelper(name: string, x: OffloadInput) { if (!allowOffload) {
        checkLoad(name);
        throw Error('Remote offload is disabled in this worker');
    } const { offload } = await import('./offload.js'); return offload(name.slice('trailer-'.length), x, context); }
    if (name === 'trailer-onchain-reuse-review') {
        const manifest = await file(root, root, path.join(x.bundleDir, 'bundle.json'));
        x.outDir = await output(root, x.outDir);
        return (await import('./reuse-review.js')).reviewTrailerBundleReuse({ ...x, workspaceRoot: root, bundleDir: path.dirname(manifest) });
    }
    if ((name === 'trailer-onchain' || name === 'trailer-onchain-prepare' || name === 'trailer-onchain-test' || name === 'trailer-onchain-live-test' || name === 'trailer-onchain-render' || name === 'trailer-audio-test' || name === 'trailer-music')) {
        if (checkMachineLoad)
            checkLoad(name);
        x.outDir = await output(root, x.outDir);
        const onchain = await import('./onchain.js');
        if (name === 'trailer-onchain') {
            if ((x.project === undefined) === (x.projectPath === undefined))
                throw Error('Provide exactly one project or projectPath');
            if (x.projectPath) {
                const p = await file(root, root, x.projectPath);
                if ((await stat(p)).size > 2000000)
                    throw Error('Project exceeds 2 MB');
                x.project = JSON.parse(await readFile(p, 'utf8'));
            }
            return onchain.compileTrailerProject(x.project!, { workspaceRoot: root, engineRoot: x.engineRoot, sdkRoot: x.sdkRoot, outDir: x.outDir });
        }
        if (name === 'trailer-onchain-prepare') {
            const manifest = await file(root, root, path.join(x.bundleDir, 'bundle.json'));
            if (x.imagePath)
                x.imagePath = await file(root, root, x.imagePath);
            return (await import('./publication.js')).prepareTrailerPublication({ ...x, metadata: x.metadata as {
                    name: string;
                    description?: string;
                } | undefined, bundleDir: path.dirname(manifest) });
        }
        if (name === 'trailer-onchain-render') {
            const manifest = await file(root, root, path.join(x.bundleDir, 'bundle.json'));
            if (x.preparedDir)
                x.preparedDir = path.dirname(await file(root, root, path.join(x.preparedDir, 'preparation.json')));
            return (await import('./onchain-render.js')).renderTrailerBundle({ ...x, bundleDir: path.dirname(manifest) }, { log: log ?? (() => { }) });
        }
        if (name === 'trailer-onchain-live-test') {
            const manifest = await file(root, root, path.join(x.bundleDir, 'bundle.json'));
            if (x.preparedDir)
                x.preparedDir = path.dirname(await file(root, root, path.join(x.preparedDir, 'preparation.json')));
            return (await import('./live-mp4-test.js')).testTrailerLiveMP4({ ...x, bundleDir: path.dirname(manifest) });
        }
        if (name === 'trailer-onchain-test') {
            const manifest = await file(root, root, path.join(x.bundleDir, 'bundle.json'));
            if (x.preparedDir)
                x.preparedDir = path.dirname(await file(root, root, path.join(x.preparedDir, 'preparation.json')));
            return (await import('./onchain-test.js')).testTrailerBundle({ ...x, bundleDir: path.dirname(manifest) });
        }
        if (name === 'trailer-audio-test')
            return (await import('./audio-test.js')).testAudioConversion(x, { workspaceRoot: root });
        const e = await onchain.loadEngine(x.engineRoot), music = await import('./music.js');
        let bytes: Uint8Array, score, warnings: string[] = [];
        if (x.midiPath) {
            if (x.recipe || x.score)
                throw Error('Choose one MIDI, score or recipe');
            const p = await file(root, root, x.midiPath);
            if ((await stat(p)).size > 1048576)
                throw Error('MIDI exceeds 1 MiB');
            ({ score, warnings } = music.importMidi(new Uint8Array(await readFile(p))));
            bytes = music.createScoreCodec(e.codec).encode(score);
        }
        else if (x.score) {
            if (x.recipe)
                throw Error('Choose one score or recipe');
            score = x.score;
            bytes = music.createScoreCodec(e.codec).encode(score);
        }
        else if (x.recipe) {
            const api = await import(new URL('packages/audio/src/store.ts', pathToFileURL(e.root + '/')).href);
            bytes = api.storeMusic(x.recipe);
            api.loadMusic(bytes);
        }
        else
            throw Error('Supply midiPath, score or recipe');
        const musicPath = path.join(x.outDir, 'music.bin');
        await writeFile(musicPath, bytes);
        if (score)
            await writeFile(path.join(x.outDir, 'score.json'), JSON.stringify(score, null, 2) + '\n');
        return { musicPath, bytes: bytes.length, sha256: onchain.digest(bytes), mode: score ? 'score' : 'recipe', warnings, auditionRequired: true };
    }
    if (name === 'trailer-cue-sync') {
        if (x.cuesPath) {
            const p = await file(root, root, x.cuesPath);
            x.cues = JSON.parse(await readFile(p, 'utf8')).cues;
        }
        if (!x.cues)
            throw Error('Provide cues or cuesPath');
        const result = (await import('./cue-sync.js')).syncCues({ ...x, cues: x.cues as (number | {
                seconds: number;
            })[] });
        if (x.outPath) {
            const dest = inside(root, path.resolve(root, x.outPath));
            await output(root, path.dirname(dest));
            await writeFile(dest, JSON.stringify(result, null, 1) + '\n');
        }
        return result;
    }
    if (name === 'trailer-score') {
        if ((x.arrangement === undefined) === (x.arrangementPath === undefined))
            throw Error('Provide exactly one arrangement or arrangementPath');
        if (x.arrangementPath)
            x.arrangement = JSON.parse(await readFile(await file(root, root, x.arrangementPath), 'utf8'));
        x.outDir = await output(root, x.outDir);
        const engineRoot = x.engineRoot ?? process.env.KEEL_ENGINE_ROOT ?? path.join(os.homedir(), 'dev/keel-engine');
        return (await import('./score-render.js')).renderArrangement(x.arrangement!, { engineRoot, outDir: x.outDir });
    }
    if (name === 'trailer-footage') {
        if (checkMachineLoad && os.loadavg()[0] > 60)
            checkLoad(name);
        x.mediaPath = await file(root, root, x.mediaPath);
        x.outDir = await output(root, x.outDir);
        return runWorker('footage', x, context);
    }
    if (checkMachineLoad && name === 'trailer-capture')
        checkLoad(name);
    if (name === 'trailer-inspect') {
        if ((x.snapshot === undefined) === (x.snapshotPath === undefined))
            throw Error('Provide exactly one of snapshot or snapshotPath');
        if (x.snapshotPath) {
            const p = await file(root, root, x.snapshotPath);
            if ((await stat(p)).size > 64000000)
                throw Error('Snapshot exceeds 64 MB');
            x.snapshot = JSON.parse(await readFile(p, 'utf8'));
            delete x.snapshotPath;
        }
        assertInspection(x.snapshot);
        x.outDir = await output(root, x.outDir);
        if (x.remote || (checkMachineLoad && os.loadavg()[0] > 40))
            return onHelper(name, x);
        return inspectSnapshot({ ...x, snapshot: x.snapshot! }, (op, data) => runWorker(op, data, context));
    }
    if (name === 'trailer-snapshot' || name === 'trailer-clip') {
        if (name === 'trailer-snapshot' && (Number(x.mediaPath !== undefined) + Number(x.timeline !== undefined) + Number(x.timelinePath !== undefined) !== 1))
            throw Error('Provide one mediaPath, timeline or timelinePath');
        if (x.mediaPath)
            x.mediaPath = await file(root, root, x.mediaPath);
        else if (name === 'trailer-snapshot') {
            x.timeline = await resolveTimeline(root, x, context);
            delete x.timelinePath;
            if (x.target && !x.timeline.targets.some(t => t.id === x.target))
                throw Error('Unknown target');
        }
        x.outDir = await output(root, x.outDir);
        if (x.remote || (checkMachineLoad && os.loadavg()[0] > 40))
            return onHelper(name, x);
        if (name === 'trailer-clip')
            return clipMedia(x, (op, data) => runWorker(op, data, context));
        return mediaSnapshot(x, (op, data) => runWorker(op, data, context));
    }
    if (name === 'trailer-beats') {
        x.audioPath = await file(root, root, x.audioPath);
        const result = await runWorker('beats', x, context);
        if (x.outPath) {
            const dest = inside(root, path.resolve(root, x.outPath));
            await output(root, path.dirname(dest));
            try {
                if ((await lstat(dest)).isSymbolicLink())
                    throw Error('Cannot write beats to a symlink');
            }
            catch (e) {
                if (errorCode(e) !== 'ENOENT')
                    throw e;
            }
            await writeFile(dest, JSON.stringify(result, null, 2) + '\n');
        }
        return result;
    }
    if (name === 'trailer-capture') {
        const c = x.capture;
        for (const k of ['path', 'rom', 'guestRom', 'symbolsPath'] as const)
            if (c[k])
                c[k] = await file(root, root, c[k]);
        if (c.inspectionFrames?.some(f => f >= (c.frames ?? 600)))
            throw Error('Inspection frame falls outside capture');
        if (c.adapter === 'web' && !c.url)
            throw Error('Web capture requires url');
        if (c.adapter === 'gameboy' && !c.rom)
            throw Error('Game Boy capture requires rom');
        if (['video', 'image'].includes(c.adapter) && !c.path)
            throw Error('File capture requires path');
        for (const e of c.events ?? []) {
            if (e.action === 'press' || e.action === 'release') {
                if (!e.button)
                    throw Error('Input event requires button');
            }
            if (e.action === 'write' && (e.address === undefined || e.value === undefined || e.address > 65535 || e.value > 255))
                throw Error('Memory write requires 16-bit address and byte value');
            if (e.side === 'guest' && !c.guestRom)
                throw Error('Guest input requires guestRom');
            if (e.frame >= (c.frames ?? 600))
                throw Error('Input event falls outside capture');
        }
        for (const r of c.reads ?? []) {
            if (r.address === undefined && !r.symbol)
                throw Error('Read requires address or symbol');
            if (r.side === 'guest' && !c.guestRom)
                throw Error('Guest read requires guestRom');
        }
        x.outDir = await output(root, x.outDir);
        return captureWithAdapter(c, x.outDir, { worker: (op, data) => runWorker(op, data, context) });
    }
    if (name === 'trailer-export-validate') {
        x.packageDir = await file(root, root, path.join(x.packageDir, 'manifest.json'));
        x.packageDir = path.dirname(x.packageDir);
        return runWorker('export-validate', x, context);
    }
    let sourceCheckpoint: string | undefined;
    if (name === 'trailer-export') {
        x.attributionPaths = await Promise.all((x.attributionPaths ?? []).map(p => file(root, root, p)));
        sourceCheckpoint = x.timelinePath ? await readFile(await file(root, root, x.timelinePath), 'utf8') : JSON.stringify(x.timeline, null, 2) + '\n';
    }
    const timeline = await resolveTimeline(root, x, context);
    const execution: JsonObject & {
        timeline: Timeline;
        outDir?: string;
        renderDir?: string;
        targets?: string[];
        remote?: string;
    } = { ...x, timeline };
    delete execution.timelinePath;
    if (sourceCheckpoint !== undefined) {
        execution.workspaceRoot = root;
        execution.sourceCheckpoint = sourceCheckpoint;
    }
    if (execution.targets?.some(id => !timeline.targets.some(t => t.id === id)))
        throw Error('Unknown target');
    if (name === 'trailer-stills') {
        const end = timeline.shots.at(-1)!;
        const total = editSeconds(timeline.tempo, end.startBeat + end.beats) - (timeline.loop ? editSeconds(timeline.tempo, timeline.loop.seamBeats) : 0);
        if (x.times.some(t => t >= total))
            throw Error('Still time falls outside timeline');
    }
    if (execution.outDir)
        execution.outDir = await output(root, execution.outDir);
    if (execution.renderDir) {
        execution.renderDir = await output(root, execution.renderDir);
        const manifest = JSON.parse(await readFile(await file(root, execution.renderDir, 'render.json'), 'utf8')) as {
            outputs: {
                path: string;
                target: string;
            }[];
        };
        for (const item of manifest.outputs) {
            item.path = await file(root, execution.renderDir, item.path);
            inside(execution.renderDir, item.path);
            if (!timeline.targets.some(t => t.id === item.target))
                throw Error('Manifest has unknown target');
        }
    }
    if ((name === 'trailer-render' || name === 'trailer-stills') && (execution.remote || (checkMachineLoad && os.loadavg()[0] > 40))) {
        if (!allowOffload) {
            checkLoad(name);
            throw Error('Remote offload is disabled in this worker');
        }
        const { offload } = await import('./offload.js');
        return offload(name.slice('trailer-'.length), { ...execution, outDir: execution.outDir! }, context);
    }
    return runWorker(name.slice('trailer-'.length), execution, context);
}
