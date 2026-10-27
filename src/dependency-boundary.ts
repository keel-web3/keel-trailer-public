import type { TrailerAdapterBoundary, TrailerBundle } from './onchain.js';
import path from 'node:path';
// Local preview bundling is allowed. It is never evidence that shared systems
// should become new paid creator bytes. Classify the actual esbuild output,
// including transitive relative/absolute imports, rather than file names alone.
export function auditTrailerAdapterBoundary({ metafile, workspaceRoot, workingDirectory = process.cwd() }: {
    metafile: import("esbuild").Metafile;
    workspaceRoot: string;
    workingDirectory?: string;
}): TrailerAdapterBoundary {
    if (!metafile?.inputs || !metafile?.outputs || !path.isAbsolute(workspaceRoot))
        throw TypeError('Adapter source evidence and an absolute workspace are required');
    const contributions = new Map<string, number>(), linked = new Set<string>();
    for (const output of Object.values(metafile.outputs))
        for (const [source, entry] of Object.entries(output.inputs ?? {})) {
            const n = entry.bytesInOutput;
            if (!Number.isSafeInteger(n) || n < 0)
                throw TypeError('Invalid adapter source contribution');
            contributions.set(source, (contributions.get(source) ?? 0) + n);
        }
    const inlinedSharedSources = [], creatorSources = [];
    for (const [source, byteLength] of contributions) {
        if (source.startsWith('engine-api:')) {
            linked.add(source.slice('engine-api:'.length));
            continue;
        }
        if (byteLength === 0)
            continue;
        const absolutePath = path.resolve(workingDirectory, source), relative = path.relative(workspaceRoot, absolutePath);
        const entry = { path: absolutePath, byteLength };
        if (absolutePath.split(path.sep).includes('node_modules') || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
            inlinedSharedSources.push(entry);
        else
            creatorSources.push(entry);
    }
    return {
        schema: 'keel-trailer-adapter-boundary@1',
        status: inlinedSharedSources.length ? 'blocked-shared-source-in-adapter' : 'requires-authenticated-module-reuse',
        linkedEngineModules: [...linked].sort(), creatorSources, inlinedSharedSources,
        creatorSourceBytes: creatorSources.reduce((n, x) => n + x.byteLength, 0),
        inlinedSharedSourceBytes: inlinedSharedSources.reduce((n, x) => n + x.byteLength, 0),
        publicationReady: false, uploadPlan: null,
        next: inlinedSharedSources.length
            ? 'Link these systems through their exact published module APIs. Do not upload the preview adapter as a replacement engine.'
            : 'Authenticate every engine, player and audio module through core KEEL selected-chain reuse before planning scene/music uploads.'
    };
}
export function assertTrailerDataOnlyUpload(manifest: TrailerBundle, resourceIds: string[]) {
    if (!manifest?.resources || !Array.isArray(resourceIds) || !resourceIds.length || new Set(resourceIds).size !== resourceIds.length)
        throw TypeError('Declare exact per-trailer data resources');
    const byId = new Map(manifest.resources.map(r => [r.id, r]));
    const resources = resourceIds.map(id => { const r = byId.get(id); if (!r)
        throw TypeError('Unknown trailer resource ' + id); return r; });
    // The current strict per-work tape consists of scene cues and music data.
    // Shared runtime/module updates use the core module revision workflow separately.
    for (const r of resources)
        if (!['trailer.scene', 'trailer.music'].includes(r.id) || r.role !== 'asset' || r.mediaType !== 'application/octet-stream')
            throw Object.assign(new TypeError('Per-trailer upload cannot include engine, adapter, player, audio library or video bytes: ' + r.id), { code: 'KEEL_TRAILER_SHARED_UPLOAD_BLOCKED' });
    const boundary = manifest.adapterBoundary;
    if (!boundary)
        throw Object.assign(new TypeError('Missing compiler source boundary; regenerate dependency evidence before publication'), { code: 'KEEL_TRAILER_BOUNDARY_REQUIRED' });
    if (boundary.inlinedSharedSources?.length)
        throw Object.assign(new TypeError('The adapter still embeds shared game systems; resolve published module bindings before publication'), { code: 'KEEL_TRAILER_SHARED_SOURCE_IN_ADAPTER' });
    return { schema: 'keel-trailer-data-upload@1', resourceIds: [...resourceIds], sourceBytes: resources.reduce((n, r) => n + r.byteLength, 0), publicationReady: false, uploadPlan: null, required: 'Core MCP authenticated module reuse, revision and complete tokenURI/public read-back gates' };
}
