import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest, localFile, verifyTrailerBundle } from './onchain.js';
const hash = (b: import('node:crypto').BinaryLike) => '0x' + digest(b);
const integrity = (b: Uint8Array) => ({ algorithm: 'sha256', digest: hash(b), byteLength: b.length });
function tableOf(payloads: {
    storedIntegrity: {
        byteLength: number;
        digest: string;
    };
    objectId: string;
    containerId: string;
}[]) { const table = Buffer.alloc(64 + 128 * payloads.length); table.writeBigUInt64BE(32n, 24); table.writeBigUInt64BE(BigInt(payloads.length), 56); payloads.forEach((p, i) => { const o = 64 + i * 128; table.writeBigUInt64BE(BigInt(p.storedIntegrity.byteLength), o + 24); Buffer.from(p.storedIntegrity.digest.slice(2), 'hex').copy(table, o + 32); Buffer.from(p.objectId.slice(2), 'hex').copy(table, o + 64); Buffer.from(p.containerId.slice(2), 'hex').copy(table, o + 96); }); return table; }
// Explicit local fixtures only. These are not deployed addresses or receipts.
function proofTarget(resources: import('./onchain.js').TrailerResource[]) { const a = (n: number) => '0x' + n.toString(16).padStart(40, '0'), h = (n: number) => '0x' + n.toString(16).padStart(64, '0'); return { chainId: 31337, store: a(1), objectIds: Object.fromEntries(resources.map(r => [r.id, hash(Buffer.from('local-proof:' + r.sha256))])), context: { protocol: 'keel-context@1', chainId: '31337', collection: a(2), tokenId: '1', derivedTokenSeed: h(42), seedRegistry: a(3), seedSetId: h(4), seedSourceCollection: a(2), seedSourceTokenId: '1', composerManager: a(5), composerModuleId: h(6), composerAddress: a(7), composerRevision: '1', composerCodeHash: h(8), containerTableHandle: h(9), containerTableRevision: '1', containerTableObjectId: h(10), presentationDigest: h(11), presentationDigestType: 'keccak256:keel.evm-prepared-fragment-presentation@1' } }; }
export async function prepareTrailerPublication({ bundleDir, outDir, sdkRoot = process.env.KEEL_SDK_ROOT ?? path.join(os.homedir(), '.keel/keel-sdk'), target: suppliedTarget, localProof, metadata = { name: 'KEEL scene trailer' }, imagePath }: {
    bundleDir: string;
    outDir: string;
    sdkRoot?: string;
    target?: never;
    localProof: true;
    metadata?: {
        name: string;
        description?: string;
    };
    imagePath?: string;
}) {
    // The plugin owns playback proof, not a second public publication pipeline.
    // Public objects and revisions must pass the core MCP's authenticated reuse
    // and publication checks. Caller-provided IDs are not proof of reuse.
    if (suppliedTarget || localProof !== true)
        throw Object.assign(new TypeError('Public trailer publication must use keel-inline-reuse-plan first, keel-revision-plan for declared changes, and keel-inline-publication-check before publish-plan. Reuse the registered shell, composer and engine objects. This tool accepts localProof:true only; caller-supplied public bindings are forbidden.'), { code: 'KEEL_PUBLICATION_REUSE_REQUIRED' });
    const manifest = await verifyTrailerBundle(bundleDir);
    const target = proofTarget(manifest.resources);
    if (!Number.isSafeInteger(target.chainId) || target.chainId <= 0 || !/^0x[0-9a-f]{40}$/i.test(target.store ?? ''))
        throw TypeError('Invalid publication target');
    if (!metadata || Object.keys(metadata).some(k => !['name', 'description'].includes(k)) || typeof metadata.name !== 'string' || metadata.name.length > 128 || (metadata.description !== undefined && (typeof metadata.description !== 'string' || metadata.description.length > 4096)))
        throw TypeError('Invalid trailer metadata');
    const sdk = await import(pathToFileURL(path.join(await realpath(sdkRoot), 'packages/sdk/dist/index.js')).href);
    if (typeof sdk.prepareKeelDensePayload !== 'function')
        throw Error('The selected KEEL SDK lacks the automatic prepared COPY saver. Update the SDK; do not substitute a trailer-specific codec or encoder.');
    const items = [], payloads = [];
    let rawStoredBytes = 0;
    let transportProfile: string | undefined;
    for (const r of manifest.resources) {
        const source = await readFile(await localFile(bundleDir, r.path)), payload = sdk.prepareKeelDensePayload(source), compression = payload.compression, stored = payload.compressedBytes, objectId = target.objectIds?.[r.id];
        if (!/^0x[0-9a-f]{64}$/.test(objectId ?? '') || /^0x0{64}$/.test(objectId))
            throw TypeError('Missing exact object binding for ' + r.id);
        if (transportProfile && transportProfile !== payload.transportProfile)
            throw Error('SDK payload transport defaults differ');
        transportProfile = payload.transportProfile;
        const binding = await sdk.buildKeelOnchainContainerBinding({ chainId: target.chainId, store: target.store, objectId, compression, bytes: source, storedBytes: stored });
        const slot = await sdk.buildOnchainKeelViewerSlot({ id: r.id, role: r.role, mediaType: r.mediaType, aliases: [], bytes: source, chainId: target.chainId, store: target.store, objectId, compression, storedBytes: stored, container: { bytes: source, memberOffset: 0 }, containerReference: binding, containerBindings: [binding] });
        items.push(slot.item);
        payloads.push({ containerId: binding.id, objectId, storedIntegrity: integrity(stored), storedDense: payload.storedDense });
        rawStoredBytes += stored.length;
    }
    const table = tableOf(payloads), tableDigest = hash(table);
    if ((target.context as typeof target.context & {
        containerTableDigest?: string;
    }).containerTableDigest && (target.context as typeof target.context & {
        containerTableDigest?: string;
    }).containerTableDigest !== tableDigest)
        throw Error('Selected context table digest differs from the exact prepared resources');
    const context = sdk.validateKeelEmbeddedContainerContext({ ...target.context, containerTableDigest: tableDigest }, target.chainId);
    const shell = await sdk.buildKeelPreparedDenseCopyShell({ embeddedContainerDelivery: { chainId: target.chainId, store: target.store }, context });
    const segments = [{ id: 'shell-prefix', role: 'shell', html: Buffer.from(shell.prefix).toString() }, ...payloads.map((p, i) => ({ id: manifest.resources[i].id + '.payload', role: manifest.resources[i].role === 'module' ? 'module' : 'creator', html: (i ? ',' : '') + sdk.serializeKeelDenseTransportJSON(p) })), { id: 'shell-bridge', role: 'shell', html: Buffer.from(shell.containerBridge).toString() }, ...items.map((item, i) => ({ id: manifest.resources[i].id + '.descriptor', role: 'descriptor', html: ',' + sdk.serializeKeelDenseTransportJSON(item) })), { id: 'shell-suffix', role: 'shell', html: Buffer.from(shell.suffix).toString() }];
    const html = segments.map(s => s.html).join('');
    const audit = sdk.inspectKeelInlinePayloadCarriage(Buffer.from(html));
    if (audit.preparedDenseCopy?.transportProfile !== transportProfile)
        throw Error('SDK shell and payload carriage differ');
    sdk.assertKeelFreshPayloadAudit(audit);
    sdk.assertKeelFreshPayloadCarriage(Buffer.from(html));
    const animation = sdk.toKeelDenseTransportDataURL('html', html), meta: {
        name: string;
        description?: string;
        animation_url: string;
        image?: string;
    } = { ...metadata, animation_url: animation };
    if (imagePath) {
        const bytes = await readFile(imagePath);
        sdk.assertKeelInlineImageBytes(bytes, 'image/png', 'Trailer poster');
        meta.image = 'data:image/png;base64,' + bytes.toString('base64');
    }
    const tokenURI = sdk.toKeelDenseTransportDataURL('metadata', JSON.stringify(meta));
    if (Buffer.byteLength(tokenURI) > 2000000)
        throw RangeError('Complete prepared tokenURI exceeds 2,000,000 bytes');
    const decodedMeta = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(sdk.decodeKeelInlineDataURI(tokenURI, 'application/json')));
    const decodedHTML = sdk.decodeKeelInlineDataURI(decodedMeta.animation_url, 'text/html');
    if (digest(decodedHTML) !== digest(Buffer.from(html)))
        throw Error('Full tokenURI changed the trailer bytes');
    await mkdir(path.join(outDir, 'parts'), { recursive: true });
    const parts = [];
    for (const [i, s] of segments.entries()) {
        const inner = sdk.toKeelDenseTransportDataURL('html', s.html).split(',').slice(1).join(','), quoted = JSON.stringify(inner).slice(1, -1), encoded = sdk.toKeelDenseTransportDataURL('metadata', quoted).split(',').slice(1).join(','), bytes = Buffer.from(encoded);
        if (Buffer.from(sdk.decodeKeelPreparedDenseCopyFragment(bytes)).toString() !== s.html)
            throw Error('Prepared fragment differs from source');
        const file = 'parts/' + String(i).padStart(3, '0') + '-' + s.id + '.txt';
        await writeFile(path.join(outDir, file), bytes);
        parts.push({ id: String(s.id), role: s.role, path: file, sha256: digest(bytes), byteLength: bytes.length });
    }
    const joined = (await Promise.all(parts.map(p => readFile(path.join(outDir, p.path), 'utf8')))).join('');
    const split = tokenURI.indexOf(joined);
    if (split < 0)
        throw Error('Prepared COPY parts do not assemble the complete tokenURI');
    const metadataParts = [];
    for (const [id, text] of [['metadata-prefix', tokenURI.slice(0, split)], ['metadata-suffix', tokenURI.slice(split + joined.length)]]) {
        const bytes = Buffer.from(text), file = 'parts/' + id + '.txt';
        await writeFile(path.join(outDir, file), bytes);
        metadataParts.push({ id, role: 'metadata', path: file, sha256: digest(bytes), byteLength: bytes.length });
    }
    const body = parts.map(p => p.path), orderedTokenURIParts = [metadataParts[0].path, ...body, metadataParts[1].path];
    const reassembled = Buffer.concat(await Promise.all(orderedTokenURIParts.map(p => readFile(path.join(outDir, p)))));
    if (digest(reassembled) !== digest(Buffer.from(tokenURI)))
        throw Error('Complete prepared COPY assembly mismatch');
    const report = { schema: 'keel-trailer-prepared-copy@1', status: 'local-proof-only', chainId: target.chainId, store: target.store, bindingAuthentication: 'fictional-local-test-bindings', transport: transportProfile, contractOperation: 'verified-copy', programSha256: manifest.programSha256, bundleSha256: digest(await readFile(path.join(bundleDir, 'bundle.json'))), tableDigest, parts: [...metadataParts, ...parts], orderedBodyParts: body, orderedTokenURIParts, bytes: { compressedResources: rawStoredBytes, preparedBody: parts.reduce((n, p) => n + p.byteLength, 0), completeTokenURI: Buffer.byteLength(tokenURI) }, tokenURIHash: digest(Buffer.from(tokenURI)), htmlHash: digest(Buffer.from(html)), uploadPlan: null, objectWrites: [], requiredBeforePublication: ['core MCP keel-inline-reuse-plan and declared keel-revision-plan; never upload preview engine dependencies', 'authenticated selected-chain module reuse and object readback', 'matching registered canonical shell and COPY composer', 'complete metadata/image/context binding and public tokenURI read gas', 'offline browser playback of exact returned tokenURI'], signing: 'not-performed', submission: 'not-performed' };
    await writeFile(path.join(outDir, 'prepared.html'), html);
    await writeFile(path.join(outDir, 'tokenURI.txt'), tokenURI);
    await writeFile(path.join(outDir, 'packtable.bin'), table);
    await writeFile(path.join(outDir, 'preparation.json'), JSON.stringify(report, null, 2) + '\n');
    return { ...report, reportPath: path.join(outDir, 'preparation.json'), previewPath: path.join(outDir, 'prepared.html'), tokenURIPath: path.join(outDir, 'tokenURI.txt') };
}
