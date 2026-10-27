import type { ClipInput, InspectInput, SnapshotInput, WorkerFunction, WorkerReport } from './contracts.js';
import type { InspectionSnapshot } from './probe.js';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { INSPECTION_SCHEMA } from './inspection-schema.js';
import { assertSchema } from './schema.js';
export { INSPECTION_SCHEMA };
const numeric = (a: unknown, name: string) => { if (!Array.isArray(a) || a.some(v => typeof v !== 'number' || !Number.isFinite(v)))
    throw Error(name + ' must be finite numeric data'); };
export function assertInspection(input: unknown) {
    const s = input as InspectionSnapshot;
    assertSchema(s, INSPECTION_SCHEMA);
    let count = 0;
    const seen = new Set();
    function jsonData(v: unknown) {
        if (v === null || typeof v === 'string' || typeof v === 'boolean')
            return;
        if (typeof v === 'number') {
            if (!Number.isFinite(v))
                throw Error('Inspection data must be finite');
            return;
        }
        if (typeof v === 'object' && !Array.isArray(v) && ![Object.prototype, null].includes(Object.getPrototypeOf(v)))
            throw Error('Inspection requires plain JSON data');
        if (typeof v !== 'object' || seen.has(v))
            throw Error('Inspection requires acyclic JSON data');
        seen.add(v);
        if (Array.isArray(v)) {
            for (const item of v)
                jsonData(item);
            seen.delete(v);
            return;
        }
        for (const d of Object.values(Object.getOwnPropertyDescriptors(v))) {
            if (!d.enumerable)
                continue;
            if (!('value' in d))
                throw Error('Inspection data cannot use getters');
            jsonData(d.value);
        }
        seen.delete(v);
    }
    jsonData(s);
    const unique = (rows: {
        id: string;
    }[] | undefined, name: string) => { const ids = new Set(); for (const x of rows ?? []) {
        if (ids.has(x.id))
            throw Error('Duplicate ' + name + ' id: ' + x.id);
        ids.add(x.id);
    } return ids; };
    unique(s.meshes, 'mesh');
    unique(s.graphs, 'graph');
    unique(s.grids, 'grid');
    for (const m of s.meshes ?? []) {
        if (m.positions.length % 3 || m.indices.length % 3)
            throw Error('Mesh positions/indices must be complete triples');
        if (m.indices.some(i => i >= m.positions.length / 3))
            throw Error('Mesh index outside vertices');
        for (const [k, a] of Object.entries(m.attributes ?? {})) {
            numeric(a, 'Mesh attribute ' + k);
            if (a.length % (m.positions.length / 3))
                throw Error('Mesh attribute length must be a multiple of vertices');
            count += a.length;
        }
        count += m.positions.length + m.indices.length;
    }
    for (const g of s.grids ?? []) {
        if (g.width * g.height > 2000000)
            throw Error('Grid exceeds 2 million cells');
        if (!Object.keys(g.channels).length)
            throw Error('Grid requires a channel');
        for (const [k, a] of Object.entries(g.channels)) {
            numeric(a, 'Grid channel ' + k);
            if (a.length !== g.width * g.height)
                throw Error('Grid channel length must equal width × height');
            count += a.length;
        }
    }
    for (const g of s.graphs ?? []) {
        count += g.edges.reduce((n, e) => n + (e.points?.length ?? 0) * 3, 0);
        const ids = unique(g.nodes, 'node');
        unique(g.edges, 'edge');
        if (g.edges.some(e => !ids.has(e.from) || !ids.has(e.to)))
            throw Error('Graph edge refers to missing node');
        count += g.nodes.length + g.edges.length;
    }
    if (count > 10000000)
        throw Error('Inspection exceeds 10 million numeric values; expose a selected region');
    return s;
}
export function queryInspection(snapshot: InspectionSnapshot, { pointer, start = 0, count = 100 }: {
    pointer: string;
    start?: number;
    count?: number;
}) {
    if (/~(?![01])/.test(pointer))
        throw Error('Invalid RFC 6901 escape');
    if (pointer !== '' && !pointer.startsWith('/'))
        throw Error('Use an RFC 6901 JSON pointer');
    let value: unknown = snapshot;
    for (const p of pointer === '' ? [] : pointer.slice(1).split('/').map(p => p.replaceAll('~1', '/').replaceAll('~0', '~'))) {
        if (value === null || typeof value !== 'object' || !Object.hasOwn(value, p))
            throw Error('Unknown inspection pointer: ' + pointer);
        value = (value as Record<string, unknown>)[p];
    }
    if (Array.isArray(value))
        return { pointer, start, total: value.length, values: (value as unknown[]).slice(start, start + count), truncated: start + count < value.length };
    const json = JSON.stringify(value);
    if (json.length > 200000)
        throw Error('Query is too large; select a leaf array and use start/count');
    return { pointer, value };
}
export async function inspectSnapshot(input: InspectInput, worker: WorkerFunction) {
    const snapshot = assertInspection(input.snapshot);
    const out = input.outDir;
    const queries = (input.queries ?? []).map(q => queryInspection(snapshot, q));
    const bytes = JSON.stringify(snapshot, null, 2) + '\n', raw = path.join(out, 'snapshot.json');
    await writeFile(raw, bytes);
    const report = await worker<WorkerReport>('inspect', input);
    report.snapshotPath = raw;
    report.snapshotSha256 = createHash('sha256').update(bytes).digest('hex');
    report.queries = queries;
    const html = await readFile(new URL('../assets/inspection.html', import.meta.url), 'utf8');
    await writeFile(path.join(out, 'index.html'), html.replace('/*INSPECTION_PAYLOAD*/', JSON.stringify({ snapshot, report }).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029')));
    report.viewer = path.join(out, 'index.html');
    await writeFile(path.join(out, 'inspection.json'), JSON.stringify(report, null, 2) + '\n');
    return report;
}
export async function mediaSnapshot(input: SnapshotInput, worker: WorkerFunction) {
    const result = await worker<WorkerReport & {
        stills: {
            path: string;
        }[];
    }>('snapshot', input);
    const html = await readFile(new URL('../assets/media.html', import.meta.url), 'utf8');
    const data = { ...result, stills: result.stills.map(x => ({ ...x, image: path.basename(x.path) })) };
    await writeFile(path.join(input.outDir, 'index.html'), html.replace('/*MEDIA_PAYLOAD*/', JSON.stringify(data).replaceAll('<', '\\u003c')));
    result.viewer = path.join(input.outDir, 'index.html');
    await writeFile(path.join(input.outDir, 'snapshots.json'), JSON.stringify(result, null, 2) + '\n');
    return result;
}
export async function clipMedia(input: ClipInput, worker: WorkerFunction) {
    const result = await worker<WorkerReport & {
        path: string;
        previewPath: string;
    }>('clip', input);
    const html = await readFile(new URL('../assets/clip.html', import.meta.url), 'utf8');
    const display = { ...result, path: path.basename(result.path), previewPath: path.basename(result.previewPath) };
    await writeFile(path.join(input.outDir, 'index.html'), html.replace('/*CLIP_PAYLOAD*/', JSON.stringify(display).replaceAll('<', '\\u003c')));
    result.viewer = path.join(input.outDir, 'index.html');
    await writeFile(path.join(input.outDir, 'clip.json'), JSON.stringify(result, null, 2) + '\n');
    return result;
}
