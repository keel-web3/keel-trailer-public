import type { SceneProgram } from './program.js';
import type { EngineRuntime, FixedEncoder, NativeScene, SceneWorker } from './runtime-types.js';
import { createScenePlayer } from './program.js';
import { createWorkerScene } from './worker-scene.js';
// The optional shared engine encoder consumes fixed-step native game frames.
// Playback speed, pause and visibility do not change exported media time.
export async function encodeOfflineTrailer({ engine, program, buffer, signal, scale = 6, onProgress = () => { } }: {
    engine: EngineRuntime;
    program: SceneProgram;
    buffer: AudioBuffer | null;
    signal?: AbortSignal;
    scale?: number;
    onProgress?: (value: number, detail: {
        frames: number;
        total: number;
    }) => void;
}) {
    const api = globalThis.KEEL_CAPTURE_OFFLINE;
    if (!api?.createFixedFrameEncoder)
        throw Error('The shared KEEL fixed-frame encoder is missing');
    const seconds = program.duration * 60 / (program.bpm * program.ppq), count = Math.ceil(seconds * program.fps);
    if (!Number.isInteger(scale) || scale < 1 || scale > 8)
        throw Error('Invalid nearest-neighbour video scale');
    let encoder: FixedEncoder | null = null, scene: NativeScene | null = null, worker: SceneWorker | null = null, finished = false;
    try {
        encoder = await api.createFixedFrameEncoder({ width: program.width * scale, height: program.height * scale, fps: program.fps, frames: count, audio: buffer ? { rate: buffer.sampleRate, channels: Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c)) } : null, signal });
        worker = await createWorkerScene({ program, content: globalThis.__KEEL_CONTENT__, signal });
        let canvas, player;
        if (!worker) {
            canvas = document.createElement('canvas');
            canvas.width = program.width;
            canvas.height = program.height;
            scene = await globalThis.KEEL_TRAILER_SCENE.createTrailerScene({ canvas, engine, program, content: globalThis.__KEEL_CONTENT__, background: true });
            player = createScenePlayer(program, { reset: s => scene!.reset(s), call: (n, a, c) => scene!.actions[n](...a, c), step: (dt, f) => scene!.step(dt, f), prepare: f => scene!.prepareFrame?.(f), render: a => scene!.render(a) });
        }
        globalThis.__TRAILER_WORKER_DEBUG__ = { renderer: worker ? 'offscreen-worker' : 'main-thread-fallback', inFlight: 1 };
        let slice = performance.now();
        for (let f = 0; f < count; f++) {
            if (signal?.aborted)
                throw new DOMException('Encoding cancelled', 'AbortError');
            if (worker) {
                const { bitmap, resources } = await worker.frame(f);
                if (resources)
                    globalThis.__TRAILER_WORKER_DEBUG__.resources = resources;
                try {
                    await encoder.addFrame(bitmap, f);
                }
                finally {
                    bitmap.close();
                }
            }
            else {
                await player!.seekPrepared(f / program.fps);
                await encoder.addFrame(canvas!, f);
            }
            onProgress((f + 1) / count, { frames: f + 1, total: count });
            // Bound foreground work while asynchronous WebCodecs applies backpressure.
            if (performance.now() - slice >= 4) {
                await new Promise(r => setTimeout(r, 0));
                slice = performance.now();
            }
        }
        const result = await encoder.finish();
        finished = true;
        return result;
    }
    finally {
        worker?.dispose();
        scene?.dispose?.();
        if (encoder && !finished)
            await encoder.cancel();
    }
}
