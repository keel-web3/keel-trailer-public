#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { errorCode, errorMessage } from './contracts.js';
import { runTrailerTool, TIMELINE_SCHEMA, TOOL_SCHEMAS, validateTimeline } from './index.js';
import type { TrailerToolName } from './tool-types.js';
const [op, ...args] = process.argv.slice(2);
const help = 'keel-trailer plan|capture|beats|render|verify|stills|lint|export|export-validate|snapshot|clip|inspect|onchain|onchain-prepare|onchain-test|onchain-render|music|audio-test|footage|cue-sync|score --json request.json [--workspace DIR]\nkeel-trailer render TIMELINE --out DIR [--preview] [--targets 16x9,9x16]\nkeel-trailer render TIMELINE --out DIR --stills 1,7.5\nkeel-trailer schema|tools|validate TIMELINE\nSet TRAILER_PYTHON to the interpreter with requirements.txt installed.';
function opt(key: string, fallback?: string): string | undefined { const i = args.indexOf('--' + key); return i < 0 ? fallback : args[i + 1]; }
async function finish(value: string, code = 0): Promise<never> {
    await new Promise<void>((resolve, reject) => process.stdout.write(value + '\n', error => error ? reject(error) : resolve()));
    process.exit(code);
}
try {
    if (!op || op === '--help') {
        await finish(help);
    }
    if (op === 'schema') {
        await finish(JSON.stringify(TIMELINE_SCHEMA, null, 2));
    }
    if (op === 'tools') {
        await finish(JSON.stringify(TOOL_SCHEMAS, null, 2));
    }
    if (op === 'validate') {
        if (!args[0])
            throw Error('Timeline path required');
        const r = validateTimeline(JSON.parse(await readFile(args[0], 'utf8')));
        await finish(JSON.stringify(r, null, 2), r.valid ? 0 : 1);
    }
    let input: Record<string, unknown>;
    const json = opt('json'), targets = opt('targets'), stills = opt('stills'), attribution = opt('attribution');
    if (json)
        input = JSON.parse(await readFile(json, 'utf8')) as Record<string, unknown>;
    else if (op === 'lint') {
        input = { timelinePath: args[0] };
        if (targets)
            input.targets = targets.split(',');
        if (opt('samples'))
            input.samplesPerShot = Number(opt('samples'));
        if (args.includes('--strict'))
            input.strict = true;
    }
    else if (['render', 'stills', 'verify', 'export'].includes(op)) {
        input = { timelinePath: args[0], ...(op === 'verify' ? { renderDir: opt('out', 'artifacts') } : { outDir: opt('out', 'artifacts') }) };
        if (op === 'export') {
            if (opt('timecode-frame'))
                input.startTimecodeFrame = Number(opt('timecode-frame'));
            if (attribution)
                input.attributionPaths = attribution.split(',');
        }
        if (args.includes('--preview'))
            input.preview = true;
        if (opt('remote'))
            input.remote = opt('remote');
        if (targets)
            input.targets = targets.split(',');
        if (stills) {
            delete input.preview;
            input.times = stills.split(',').map(Number);
        }
    }
    else if (op === 'export-validate')
        input = { packageDir: args[0] };
    else if (op === 'beats')
        input = { audioPath: args[0], ...(opt('bpm') ? { bpm: Number(opt('bpm')) } : {}), ...(opt('out') ? { outPath: opt('out') } : {}) };
    else
        throw Error('Use --json request.json for ' + op);
    const name = stills ? 'trailer-stills' : 'trailer-' + op;
    if (!Object.hasOwn(TOOL_SCHEMAS, name))
        throw Error('Unknown trailer command: ' + op);
    const result = await runTrailerTool(name as TrailerToolName, input, { workspaceRoot: opt('workspace', process.cwd()), log: s => process.stderr.write(s) });
    console.log(JSON.stringify(result, null, 2));
    if (op === 'lint' && result && typeof result === 'object' && 'passed' in result && !result.passed)
        process.exitCode = 1;
}
catch (error) {
    const load = error !== null && typeof error === 'object' && 'load' in error ? error.load : undefined;
    console.log(JSON.stringify({ error: { code: errorCode(error) ?? 'TRAILER_ERROR', message: errorMessage(error), ...(load ? { load } : {}) } }));
    process.exitCode = 1;
}
