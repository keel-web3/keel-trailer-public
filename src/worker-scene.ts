interface WorkerReply {
    bitmap?: ImageBitmap;
    resources?: Record<string, unknown>;
}
import { errorMessage } from './contracts.js';
import type { SceneProgram } from './program.js';
import type { SceneWorker, VerifiedContent } from './runtime-types.js';
const exclusions = new Set(['trailer.tone', 'trailer.audio', 'trailer.player', 'engine.capture.offline']);
export async function createWorkerScene({ program, content, signal }: {
    program: SceneProgram;
    content: VerifiedContent;
    signal?: AbortSignal;
}): Promise<SceneWorker | null> {
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || typeof __KEEL_TRAILER_RENDER_WORKER_SOURCE__ === 'undefined')
        return null;
    if (!globalThis.KEEL_TRAILER_SCENE?.supportsWorkerExport)
        return null;
    const records = content?.resources?.();
    if (!Array.isArray(records))
        return null;
    const modules = records.filter(r => r.role === 'module' && !exclusions.has(r.id));
    if (!modules.length || !records.some(r => r.id === 'trailer.adapter'))
        return null;
    // Verified sources keep execution order. No shell, loader, soundtrack,
    // encoder or remote imports are copied into this worker.
    const parts: BlobPart[] = [];
    let slice = performance.now();
    for (const r of modules) {
        parts.push(Uint8Array.from(content.bytes(r.id)).buffer);
        if (performance.now() - slice >= 3) {
            await new Promise(r => setTimeout(r, 0));
            slice = performance.now();
        }
    }
    if (signal?.aborted)
        throw new DOMException('Encoding cancelled', 'AbortError');
    parts.push(Uint8Array.from(content.bytes('trailer.adapter')).buffer, __KEEL_TRAILER_RENDER_WORKER_SOURCE__);
    const url = URL.createObjectURL(new Blob(parts.flatMap(p => [p, '\n;\n']), { type: 'text/javascript' }));
    let worker;
    try {
        worker = new Worker(url);
    }
    catch (e) {
        globalThis.__TRAILER_WORKER_DEBUG__ = { error: errorMessage(e) };
        return null;
    }
    finally {
        URL.revokeObjectURL(url);
    }
    let id = 0, closed = false;
    const pending = new Map<number, {
        resolve: (value: WorkerReply) => void;
        reject: (error: unknown) => void;
    }>();
    const fail = (e: unknown) => { for (const p of pending.values())
        p.reject(e); pending.clear(); };
    worker.onmessage = ({ data }) => { const p = pending.get(data.id); if (!p) {
        data.bitmap?.close();
        return;
    } pending.delete(data.id); data.type === 'error' ? p.reject(Error(data.error)) : p.resolve(data); };
    worker.onerror = e => fail(Error(errorMessage(e) || 'Scene worker failed'));
    const dispose = () => { if (closed)
        return; closed = true; signal?.removeEventListener('abort', abort); worker.terminate(); fail(new DOMException('Scene worker closed', 'AbortError')); };
    const abort = () => dispose();
    signal?.addEventListener('abort', abort, { once: true });
    const request = (data: Record<string, unknown>) => { if (closed || signal?.aborted)
        return Promise.reject(new DOMException('Encoding cancelled', 'AbortError')); if (pending.size)
        return Promise.reject(Error('Concurrent worker frame requests are not allowed')); return new Promise<WorkerReply>((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); worker.postMessage({ ...data, id: n }); }); };
    try {
        await request({ type: 'init', program });
        return { frame: async (index: number) => { const value = await request({ type: 'frame', frame: index, fps: program.fps }); if (!value.bitmap)
                throw Error('Worker did not return a frame bitmap'); return { bitmap: value.bitmap, resources: value.resources }; }, dispose };
    }
    catch (e) {
        dispose();
        if (signal?.aborted)
            throw e;
        globalThis.__TRAILER_WORKER_DEBUG__ = { error: errorMessage(e) };
        return null;
    }
}
