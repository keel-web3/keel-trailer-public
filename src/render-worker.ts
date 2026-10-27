import { errorMessage } from './contracts.js';
import type { ScenePlayer, SceneProgram } from './program.js';
import { createScenePlayer } from './program.js';
import type { NativeScene } from './runtime-types.js';
declare const postMessage: (message: unknown, transfer?: Transferable[]) => void;
declare const close: () => void;
type Request = {
    id: number;
    type: 'init';
    program: SceneProgram;
} | {
    id: number;
    type: 'frame';
    frame: number;
    fps: number;
} | {
    id: number;
    type: 'dispose';
};
// The native scene adapter owns its canvas; audio remains on the parent path.
Reflect.set(globalThis, 'document', { createElement(name: string) { if (name !== 'canvas')
        throw Error('The scene requires a canvas-only worker adapter'); return new OffscreenCanvas(1, 1); } });
let canvas: OffscreenCanvas | undefined, scene: NativeScene | undefined, player: ScenePlayer | undefined;
globalThis.onmessage = async ({ data }: MessageEvent<Request>) => {
    try {
        if (data.type === 'init') {
            await globalThis.KEEL_ENGINE.start();
            canvas = new OffscreenCanvas(data.program.width, data.program.height);
            const owned = await globalThis.KEEL_TRAILER_SCENE.createTrailerScene({ canvas, engine: globalThis.KEEL_ENGINE, program: data.program, background: true });
            scene = owned;
            player = createScenePlayer(data.program, { reset: s => owned.reset(s), call: (n, a, c) => owned.actions[n](...a, c), step: (dt, f) => owned.step(dt, f), prepare: f => owned.prepareFrame?.(f), render: a => owned.render(a) });
            postMessage({ id: data.id, type: 'ready' });
        }
        else if (data.type === 'frame') {
            if (!player || !canvas || !scene)
                throw Error('Worker scene is not ready');
            if (data.frame !== player.frame + 1)
                throw Error('Worker frame sequence is incomplete');
            await player.seekPrepared(data.frame / data.fps);
            const bitmap = await createImageBitmap(canvas);
            postMessage({ id: data.id, type: 'frame', frame: data.frame, bitmap, ...(data.frame % 60 === 0 ? { resources: scene.resourceStats?.() } : {}) }, [bitmap]);
        }
        else if (data.type === 'dispose') {
            scene?.dispose?.();
            close();
        }
    }
    catch (error) {
        postMessage({ id: data.id, type: 'error', error: errorMessage(error) });
    }
};
