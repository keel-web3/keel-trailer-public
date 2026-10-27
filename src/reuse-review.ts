import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { TrailerAdapterBoundary } from './onchain.js';
import { localFile, verifyTrailerBundle } from './onchain.js';
export interface TrailerSourceRoot {
    path: string;
    prefix: string;
}
export interface TrailerReuseReview {
    schema: 'keel-trailer-reuse-review@1';
    chainId: number;
    status: 'blocked-unresolved-source-bindings' | 'requires-authenticated-module-reuse';
    rows: {
        path: string;
        source: string | null;
        byteLength: number;
        providers: {
            resourceId: string;
            digest: string;
            byteLength: number;
        }[];
        status: 'unmapped-source-root' | 'source-not-in-selected-published-graph' | 'coverage-only-source-version-unverified';
    }[];
    matchedPublishedResources: number;
    unmatchedManifestResources: string[];
    bytes: {
        creatorAdapterSource: number;
        inlinedSharedSource: number;
        sourceOutsideSelectedGraph: number;
    };
    publicationReady: false;
    uploadPlan: null;
    chainWrites: 0;
    required: string;
    scope: string;
}
// A source-path match is only coverage, never version compatibility. In particular,
// equal export names in different game generations cannot authorize an API bridge.
export function reviewTrailerSharedSourceReuse({ boundary, reference, sourceManifest, sourceRoots }: {
    boundary: TrailerAdapterBoundary;
    reference: {
        chainId: number;
        modules: {
            id: string;
            integrity: {
                digest: string;
                byteLength: number;
            };
        }[];
    };
    sourceManifest: {
        resources: {
            id: string;
            sha256: string;
            bytes: number;
            sources?: string[];
        }[];
    };
    sourceRoots: TrailerSourceRoot[];
}): TrailerReuseReview {
    if (boundary?.schema !== 'keel-trailer-adapter-boundary@1' || !Array.isArray(boundary.inlinedSharedSources))
        throw TypeError('Compiler source-boundary evidence is required');
    if (!Number.isSafeInteger(reference?.chainId) || reference.chainId < 1 || !Array.isArray(reference.modules) || !Array.isArray(sourceManifest?.resources))
        throw TypeError('Selected-chain decoded graph and source manifest are required');
    if (!Array.isArray(sourceRoots) || !sourceRoots.length || sourceRoots.length > 16)
        throw TypeError('Declare source root mappings');
    const roots = sourceRoots.map(r => { if (!path.isAbsolute(r.path) || typeof r.prefix !== 'string' || !r.prefix || r.prefix.includes('..') || r.prefix.startsWith('/') || r.prefix.includes('\\'))
        throw TypeError('Invalid source root mapping'); return { path: path.resolve(r.path), prefix: r.prefix.replace(/\/$/, '') }; }).sort((a, b) => b.path.length - a.path.length);
    const modules = new Map();
    for (const m of reference.modules) {
        if (modules.has(m.id))
            throw TypeError('Duplicate published resource identity');
        modules.set(m.id, m);
    }
    const accepted: typeof sourceManifest.resources = [], unmatched: string[] = [];
    for (const r of sourceManifest.resources) {
        const m = modules.get(r.id), digest = r.sha256?.startsWith('0x') ? r.sha256 : '0x' + r.sha256;
        if (!m || !/^0x[0-9a-f]{64}$/.test(digest) || m.integrity?.digest !== digest || m.integrity?.byteLength !== r.bytes) {
            unmatched.push(r.id);
            continue;
        }
        accepted.push(r);
    }
    if (!accepted.length)
        throw TypeError('Source manifest has no exact byte-matched published resources');
    const rows: TrailerReuseReview['rows'] = boundary.inlinedSharedSources.map(s => {
        const root = roots.find(r => { const rel = path.relative(r.path, s.path); return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); });
        const source = root ? root.prefix + '/' + path.relative(root.path, s.path).split(path.sep).join('/') : null;
        const providers = source ? accepted.filter(r => r.sources?.includes(source)) : [];
        return { path: s.path, source, byteLength: s.byteLength, providers: providers.map(r => ({ resourceId: r.id, digest: r.sha256, byteLength: r.bytes })), status: !source ? 'unmapped-source-root' : !providers.length ? 'source-not-in-selected-published-graph' : 'coverage-only-source-version-unverified' };
    });
    return { schema: 'keel-trailer-reuse-review@1', chainId: reference.chainId, status: rows.length ? 'blocked-unresolved-source-bindings' : 'requires-authenticated-module-reuse', rows, matchedPublishedResources: accepted.length, unmatchedManifestResources: unmatched,
        bytes: { creatorAdapterSource: boundary.creatorSourceBytes, inlinedSharedSource: boundary.inlinedSharedSourceBytes, sourceOutsideSelectedGraph: rows.filter(r => !r.providers.length).reduce((n, r) => n + r.byteLength, 0) },
        publicationReady: false, uploadPlan: null, chainWrites: 0,
        required: 'Resolve exact compatible source/API versions and dependency graph through core KEEL selected-chain read-back. Do not infer compatibility from names or upload this preview adapter as an engine update.',
        scope: 'Local source coverage review of the supplied decoded selected-chain graph. Neither missing index entries nor this bounded graph prove whole-chain absence.' };
}
export async function reviewTrailerBundleReuse({ workspaceRoot, bundleDir, referencePath, sourceManifestPath, sourceRoots, outDir }: {
    workspaceRoot: string;
    bundleDir: string;
    referencePath: string;
    sourceManifestPath: string;
    sourceRoots: TrailerSourceRoot[];
    outDir: string;
}) {
    const manifest = await verifyTrailerBundle(bundleDir);
    if (!manifest.adapterBoundary)
        throw Error('Bundle has no adapter source-boundary evidence');
    const reference = JSON.parse(await readFile(await localFile(workspaceRoot, referencePath), 'utf8'));
    const sourceManifest = JSON.parse(await readFile(await localFile(workspaceRoot, sourceManifestPath), 'utf8'));
    const report: TrailerReuseReview & {
        trailerData?: {
            id: string;
            byteLength: number;
            sha256: string;
        }[];
    } = reviewTrailerSharedSourceReuse({ boundary: manifest.adapterBoundary, reference, sourceManifest, sourceRoots });
    report.trailerData = manifest.resources.filter(r => ['trailer.scene', 'trailer.music'].includes(r.id)).map(r => ({ id: r.id, byteLength: r.byteLength, sha256: r.sha256 }));
    await mkdir(outDir, { recursive: true });
    const reportPath = path.join(outDir, 'reuse-review.json');
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    return { reportPath, ...report };
}
