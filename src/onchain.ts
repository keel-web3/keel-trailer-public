import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { buildBrowserPlayer } from './build-browser-player.js';
import type { EngineModule, EngineToolkit } from './contracts.js';
import { auditTrailerAdapterBoundary } from './dependency-boundary.js';
import type { SynthScore } from './music.js';
import { createScoreCodec, importMidi } from './music.js';
import { trailerEntry } from './player-ui.js';
import type { SceneProgram } from './program.js';
import { assertProgram, createSceneCodec } from './program.js';
export interface TrailerProject {
    liveMP4?: {
        scale?: number;
        autoplay?: boolean;
    };
    program: SceneProgram;
    modules: string[];
    adapterPath: string;
    assets?: {
        id: string;
        path: string;
        mediaType: string;
    }[];
    music?: {
        mode: 'file' | 'midi';
        path: string;
    } | {
        mode: 'score';
        score: SynthScore;
    } | {
        mode: 'recipe';
        recipe: object;
    };
}
export interface TrailerResource {
    engineId?: string;
    engineExport?: string;
    id: string;
    role: 'module' | 'asset' | 'entrypoint';
    path: string;
    mediaType: string;
    sha256: string;
    byteLength: number;
    compression: 'none' | 'gzip';
    storedByteLength: number;
    version?: string;
    needs?: string[];
}
export interface TrailerBundle {
    modules: string[];
    music: {
        mode: 'file' | 'recipe' | 'score';
    } | null;
    adapterBoundary?: TrailerAdapterBoundary;
    liveMP4: {
        scale: number;
        autoplay: boolean;
    } | null;
    dimensions: {
        width: number;
        height: number;
        fps: number;
    };
    schema: 'keel-trailer-bundle@1';
    status: 'local-candidate';
    programSha256: string;
    resources: TrailerResource[];
    bytes: {
        program: number;
        music?: number;
        source: number;
        stored: number;
        previewSource?: number;
        previewStored?: number;
        creatorAdapterContribution?: number;
        inlinedSharedCode?: number;
    };
    previews: {
        path: string;
        sha256: string;
        byteLength: number;
    }[];
    publication: {
        status: 'not-published';
        payloadStorage: 'compact';
        viewer: 'verification-shell';
        newStoredBytes?: null;
        reusedStoredBytes?: null;
        blockedReason?: string;
        required: string[];
    };
}
export interface TrailerAdapterBoundary {
    schema: "keel-trailer-adapter-boundary@1";
    status: "blocked-shared-source-in-adapter" | "requires-authenticated-module-reuse";
    linkedEngineModules: string[];
    creatorSources: {
        path: string;
        byteLength: number;
    }[];
    inlinedSharedSources: {
        path: string;
        byteLength: number;
    }[];
    creatorSourceBytes: number;
    inlinedSharedSourceBytes: number;
    publicationReady: false;
    uploadPlan: null;
    next: string;
}
export { assertTrailerDataOnlyUpload, auditTrailerAdapterBoundary } from './dependency-boundary.js';
const here = path.dirname(fileURLToPath(import.meta.url));
export const digest = (b: import('node:crypto').BinaryLike) => createHash('sha256').update(b).digest('hex');
const json = (x: unknown) => JSON.stringify(x).replaceAll('<', '\\u003c');
const moduleId = (id: string) => 'engine.' + id.replaceAll('/', '.');
export async function loadEngine(root: string = process.env.KEEL_ENGINE_ROOT ?? path.join(os.homedir(), 'dev/keel-engine')): Promise<EngineToolkit> {
    root = await realpath(root);
    const load = (p: string) => import(pathToFileURL(path.join(root, p)).href);
    const [codec, workspace, bundle, esbuild, runtime] = await Promise.all([load('packages/codec/src/runtime.ts'), load('packages/keel/src/workspace.ts'), load('packages/keel/src/bundle.ts'), load('node_modules/esbuild/lib/main.js'), load('packages/runtime/src/index.ts')]);
    return { root, codec, ...workspace, ...bundle, ...esbuild, ...runtime } as EngineToolkit;
}
export async function localFile(root: string, p: unknown) { root = await realpath(root); if (typeof p !== 'string' || !p || /[\0\r\n]/.test(p))
    throw TypeError('Invalid path'); const target = await realpath(path.resolve(root, p)), rel = path.relative(root, target); if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel))
    throw Error('Path must stay inside trailer workspace'); if (!(await stat(target)).isFile())
    throw Error('Expected a file'); return target; }
async function boundedRead(file: string, max: number = 2000000) { if ((await stat(file)).size > max)
    throw RangeError('File exceeds byte budget'); return readFile(file); }
export async function compileTrailerProject(project: TrailerProject, { workspaceRoot, engineRoot, sdkRoot, outDir }: {
    workspaceRoot?: string;
    engineRoot?: string;
    sdkRoot?: string;
    outDir: string;
}) {
    const root = await realpath(workspaceRoot ?? '.');
    sdkRoot ??= process.env.KEEL_SDK_ROOT ?? path.join(os.homedir(), '.keel/keel-sdk');
    if (!project || Object.keys(project).some(k => !['program', 'modules', 'adapterPath', 'assets', 'music', 'liveMP4'].includes(k)))
        throw TypeError('Invalid trailer project');
    assertProgram(project.program);
    if (!Array.isArray(project.modules) || project.modules.length > 48 || project.modules.some(id => typeof id !== 'string'))
        throw TypeError('Invalid module selection');
    const e = await loadEngine(engineRoot), workspace = await e.readWorkspace(e.root), byId = new Map(workspace.map(m => [m.manifest.id, m]));
    const selected = new Map<string, EngineModule>();
    function select(id: string) { if (selected.has(id))
        return; const m = byId.get(id); if (!m)
        throw Error('Unknown engine module ' + id); selected.set(id, m); for (const need of m.manifest.needs) {
        if (need.startsWith('contract:')) {
            const wanted = need.slice(9);
            const providers = project.modules.map(n => byId.get(n)).filter((n): n is EngineModule => Boolean(n)).filter(n => n.manifest.provides.some(v => { const a = e.splitRef(v), b = e.splitRef(wanted); return a.name === b.name && e.satisfies(a.range, b.range); }));
            if (!providers.length)
                throw Error('Select a provider for ' + need);
            for (const provider of providers)
                select(provider.manifest.id);
        }
        else
            select(e.splitRef(need).name);
    } }
    if (project.liveMP4) {
        if (Object.keys(project.liveMP4).some(k => !['scale', 'autoplay'].includes(k)) || !Number.isInteger(project.liveMP4.scale ?? 6) || (project.liveMP4.scale ?? 6) < 1 || (project.liveMP4.scale ?? 6) > 8)
            throw TypeError('Invalid live MP4 options');
        select('keel/capture');
    }
    select('keel/runtime');
    select('keel/codec');
    for (const id of project.modules)
        select(id);
    if (project.music?.mode === 'recipe')
        select('keel/audio');
    const registry = e.createEngine();
    for (const m of selected.values())
        registry.define(m.manifest, () => ({}));
    const resolution = registry.resolve();
    if (!resolution.ok)
        throw Error(JSON.stringify(resolution.problems));
    const resources: (TrailerResource & {
        bytes: Buffer;
    })[] = [];
    const add = (id: string, role: TrailerResource['role'], input: string | Uint8Array, extra: Partial<TrailerResource> = {}) => { const bytes = Buffer.from(input); const gz = gzipSync(bytes, { level: 9 }); const compression = gz.length < bytes.length ? 'gzip' : 'none', stored = compression === 'gzip' ? gz : bytes; const r = { id, role, path: 'resources/' + id + '.' + (role === 'module' ? 'js' : 'bin'), mediaType: role === 'module' ? 'text/javascript' : 'application/octet-stream', sha256: digest(bytes), byteLength: bytes.length, compression, storedByteLength: stored.length, ...extra } as TrailerResource; resources.push({ ...r, bytes }); return r; };
    for (const id of ['keel/runtime', ...resolution.order.filter(id => id !== 'keel/runtime')]) {
        const b = await e.bundleModule(selected.get(id)!, workspace);
        // The shell scans classic source for module syntax. Worker-source templates may
        // contain a newline followed by "import" as data; lower templates to ordinary
        // strings without changing their value, so that data cannot trip that scanner.
        const classic = await e.transform(b.code, { target: 'es2022', supported: { 'template-literal': false }, minify: true, legalComments: 'none', charset: 'ascii' });
        add(moduleId(id), 'module', classic.code, { engineId: id, version: b.manifest.version, needs: b.manifest.needs });
    }
    const sceneBytes = createSceneCodec(e.codec).encode(project.program);
    add('trailer.scene', 'asset', sceneBytes);
    const assets = project.assets ?? [];
    if (!Array.isArray(assets) || assets.length > 30)
        throw RangeError('Asset count exceeded');
    for (const asset of assets) {
        if (!asset || Object.keys(asset).some(k => !['id', 'path', 'mediaType'].includes(k)) || !/^asset\.[a-z0-9_.-]{1,80}$/.test(asset.id) || resources.some(r => r.id === asset.id) || typeof asset.mediaType !== 'string')
            throw TypeError('Invalid asset');
        add(asset.id, 'asset', await boundedRead(await localFile(root, asset.path)), { mediaType: asset.mediaType });
    }
    let music: {
        mode: 'file' | 'recipe' | 'score';
    } | null = null;
    if (project.music) {
        const m = project.music;
        if (Object.keys(m).some(k => !['mode', 'recipe', 'score', 'path'].includes(k)) || !['file', 'recipe', 'score', 'midi'].includes(m.mode))
            throw TypeError('Invalid music');
        const sourceKey = m.mode === 'recipe' ? 'recipe' : m.mode === 'score' ? 'score' : 'path';
        if ((m as unknown as Record<string, unknown>)[sourceKey] === undefined || Object.keys(m).some(k => k !== 'mode' && k !== sourceKey))
            throw TypeError('Music needs exactly one source matching its mode');
        let bytes;
        if (m.mode === 'recipe') {
            const audio = await import(pathToFileURL(path.join(e.root, 'packages/audio/src/store.ts')).href);
            bytes = audio.storeMusic(m.recipe);
            const plan = audio.loadMusic(bytes);
            if (Math.abs(60 / plan.barSec * 4 - project.program.bpm) > .001)
                throw Error('Generated score BPM must match scene BPM (pin tempo); scene-v1 does not silently retime music');
            if (plan.bars.length * plan.barSec > 120)
                throw RangeError('Generated music exceeds 120 seconds');
        }
        else if (m.mode === 'score' || m.mode === 'midi') {
            const score = m.mode === 'score' ? m.score : importMidi(await boundedRead(await localFile(root, m.path), 1048576)).score;
            if (score.bpm !== project.program.bpm)
                throw Error('Score BPM must match scene BPM');
            if (score.duration * 60 / score.bpm / score.ppq + 1e-6 < project.program.duration * 60 / project.program.bpm / project.program.ppq)
                throw Error('Score ends before the trailer');
            bytes = createScoreCodec(e.codec).encode(score);
        }
        else
            bytes = await boundedRead(await localFile(root, m.path));
        music = { mode: m.mode === 'midi' ? 'score' : m.mode };
        add('trailer.music', 'asset', bytes);
        add('trailer.tone', 'module', await readFile(path.join(e.root, 'vendor/tone-15.1.22-native.js')), { version: '15.1.22', needs: [] });
        add('trailer.audio', 'module', await readFile(path.join(e.root, 'vendor/keel-audio-1.0.0.min.js')), { version: '1.0.0', needs: ['trailer.tone'] });
    }
    const adapterPath = await localFile(root, project.adapterPath), links = new Map([...selected.values()].map(m => [m.packageName, m.manifest.id]));
    const adapter = await e.build({ entryPoints: [adapterPath], bundle: true, write: false, metafile: true, format: 'iife', globalName: 'KEEL_TRAILER_SCENE', platform: 'browser', target: 'es2022', minify: true, legalComments: 'none', plugins: [{ name: 'engine-links', setup(build) { build.onResolve({ filter: /^@keel(?:-engine\/|\/game-engine\/)/ }, args => { const spec = args.path.replace('@keel/game-engine/', '@keel-engine/'), name = spec.split('/').slice(0, 2).join('/'), id = links.get(name); if (!id)
                    throw Error('Adapter imports an unselected engine module ' + args.path); return { path: id, namespace: 'engine-api' }; }); build.onLoad({ filter: /.*/, namespace: 'engine-api' }, args => ({ contents: 'module.exports=globalThis.KEEL_ENGINE.get(' + JSON.stringify(args.path) + ');', loader: 'js' })); } }] });
    // The adapter is evaluated after engine.start, so it may import initialized APIs.
    const adapterBoundary = auditTrailerAdapterBoundary({ metafile: adapter.metafile, workspaceRoot: root });
    add('trailer.adapter', 'asset', adapter.outputFiles[0].contents, { mediaType: 'text/javascript' });
    if (project.liveMP4) {
        const encoder = await e.build({ entryPoints: [path.join(e.root, 'packages/capture/src/offline.ts')], bundle: true, write: false, format: 'iife', globalName: 'KEEL_CAPTURE_OFFLINE', platform: 'browser', target: 'es2022', minify: true, legalComments: 'inline' });
        const source = encoder.outputFiles[0].text.replaceAll('https://mozilla.org/MPL/2.0/', 'the distributed LICENSE-Mediabunny.txt').replace(/https:\/\/(?:www\.webmproject\.org\/vp9\/mp4\/|aomediacodec\.github\.io\/av1-isobmff\/|www\.w3\.org\/TR\/webcodecs-(?:aac|vorbis|flac)-codec-registration\/)/g, 'the corresponding codec specification');
        add('engine.capture.offline', 'module', source, { version: '1.0.0', needs: [], engineExport: '@keel-engine/capture/offline' });
    }
    const player = await buildBrowserPlayer(e.build);
    add('trailer.player', 'module', player.outputFiles[0].contents, { version: '1.0.0', needs: ['engine.keel.codec'] });
    const scripts = resources.filter(r => r.role === 'module').map(r => '<script src="' + r.id + '"></script>').join('');
    const boot = `(async()=>{await KEEL_ENGINE.start();const s=document.createElement('script');s.textContent=new TextDecoder().decode(__KEEL_CONTENT__.bytes('trailer.adapter'));document.head.append(s);await KEEL_TRAILER_PLAYER.mountTrailer(${json({ music, liveMP4: project.liveMP4 ?? null })});})().catch(e=>{document.querySelector('output').textContent=e.message;globalThis.__TRAILER_ERROR__=e.message;console.error(e);});`;
    const entry = trailerEntry({ scripts, boot });
    add('trailer.entry', 'entrypoint', entry, { mediaType: 'text/html' });
    const total = resources.reduce((n, r) => n + r.byteLength, 0);
    if (total > 8000000)
        throw RangeError('Trailer resources exceed 8 MB');
    await mkdir(path.join(outDir, 'resources'), { recursive: true });
    for (const r of resources)
        await writeFile(path.join(outDir, r.path), r.bytes);
    await writeFile(path.join(outDir, 'adapter-metafile.json'), JSON.stringify(adapter.metafile, null, 2) + '\n');
    await writeFile(path.join(outDir, 'dependency-boundary.json'), JSON.stringify(adapterBoundary, null, 2) + '\n');
    const stored = resources.reduce((n, r) => n + r.storedByteLength, 0);
    const manifest: TrailerBundle = { previews: [], adapterBoundary, schema: 'keel-trailer-bundle@1', status: 'local-candidate', programSha256: digest(sceneBytes), music, liveMP4: project.liveMP4 ? { scale: project.liveMP4.scale ?? 6, autoplay: project.liveMP4.autoplay ?? false } : null, dimensions: { width: project.program.width, height: project.program.height, fps: project.program.fps }, modules: resolution.order, resources: resources.map(({ bytes, ...r }) => r), bytes: { program: sceneBytes.length, music: resources.find(r => r.id === 'trailer.music')?.byteLength ?? 0, source: total, stored, previewSource: total, previewStored: stored, creatorAdapterContribution: adapterBoundary.creatorSourceBytes, inlinedSharedCode: adapterBoundary.inlinedSharedSourceBytes }, publication: { status: 'not-published', payloadStorage: 'compact', viewer: 'verification-shell', newStoredBytes: null, reusedStoredBytes: null, blockedReason: adapterBoundary.inlinedSharedSources.length ? 'shared-source-still-in-preview-adapter' : 'selected-chain-reuse-unverified', required: ['exact source-version/API bindings for shared adapter imports', 'selected-chain module reuse/read-back', 'registered shell and prepared COPY builder', 'complete tokenURI and read-gas validation'] } };
    await writeFile(path.join(outDir, 'bundle.json'), JSON.stringify(manifest, null, 2) + '\n');
    const data = Object.fromEntries(resources.filter(r => r.role === 'asset').map(r => [r.id, r.bytes.toString('base64')]));
    const content = '<script>globalThis.__KEEL_CONTENT__={bytes:id=>Uint8Array.from(atob(' + json(data) + '[id]),c=>c.charCodeAt(0))};</script>';
    const preview = entry.replace('<head>', '<head>' + content).replace(/<script src="([^"]+)"><\/script>/g, (_, id) => '<script>' + resources.find(r => r.id === id)!.bytes.toString().replace(/<\/script/gi, '<\\/script') + '</script>');
    await writeFile(path.join(outDir, 'preview.html'), preview);
    const prepare = { bundleDir: path.relative(root, outDir), outDir: path.relative(root, outDir) + '-prepared', sdkRoot, localProof: true };
    await writeFile(path.join(outDir, 'prepare-request.json'), JSON.stringify(prepare, null, 2) + '\n');
    manifest.previews = [{ path: 'preview.html', sha256: digest(Buffer.from(preview)), byteLength: Buffer.byteLength(preview) }];
    if (sdkRoot) {
        const verified = await buildTrailerSdkPreview(manifest, { outDir, sdkRoot });
        manifest.previews.push({ path: 'verified-preview.html', sha256: verified.sha256, byteLength: verified.byteLength });
    }
    await writeFile(path.join(outDir, 'bundle.json'), JSON.stringify(manifest, null, 2) + '\n');
    return { manifestPath: path.join(outDir, 'bundle.json'), previewPath: path.join(outDir, sdkRoot ? 'verified-preview.html' : 'preview.html'), preparePath: path.join(outDir, 'prepare-request.json'), ...manifest };
}
export async function verifyTrailerBundle(directory: string): Promise<TrailerBundle> { const manifest = JSON.parse((await boundedRead(await localFile(directory, 'bundle.json'))).toString('utf8')); if (manifest.schema !== 'keel-trailer-bundle@1' || !Array.isArray(manifest.resources) || manifest.resources.length > 128)
    throw TypeError('Invalid bundle'); const ids = new Set(); for (const r of manifest.resources) {
    if (ids.has(r.id))
        throw Error('Duplicate resource');
    ids.add(r.id);
    const bytes = await boundedRead(await localFile(directory, r.path), 8000000);
    if (bytes.length !== r.byteLength || digest(bytes) !== r.sha256)
        throw Error('Resource digest mismatch: ' + r.id);
} return manifest; }
export async function buildTrailerSdkPreview(manifest: TrailerBundle, { outDir, sdkRoot }: {
    outDir: string;
    sdkRoot: string;
}) {
    const sdk = await import(pathToFileURL(path.join(await realpath(sdkRoot), 'packages/sdk/dist/inline-viewer-graph.js')).href);
    const shell = await sdk.buildKeelInlineShellFragments(), modules: unknown[] = [], assets: unknown[] = [];
    let entry: unknown;
    for (const [i, r] of manifest.resources.entries()) {
        const source = await readFile(path.join(outDir, r.path));
        if (r.role === 'module')
            modules.push(await sdk.buildKeelInlineModuleFragment({ moduleId: r.id, version: r.version, mediaType: r.mediaType, decodedBytes: source, compression: r.compression, execution: 'classic', phase: 'runtime', weight: i }));
        else if (r.role === 'asset')
            assets.push({ id: r.id, mediaType: r.mediaType, source, compression: r.compression });
        else
            entry = { id: r.id, mediaType: 'text/html', source, compression: r.compression };
    }
    const document: {rootBytes: Uint8Array; byteLength: number} = await sdk.buildKeelInlineLocalDocument({ shell, modules, assets, entry, payloadStorage: 'compact' });
    await writeFile(path.join(outDir, 'verified-preview.html'), document.rootBytes);
    return { byteLength: document.byteLength, sha256: digest(document.rootBytes), publication: 'not-published' };
}
