import type { EngineRuntime } from './runtime-types.js';
// Record the already-rendered canvas with keel/capture. The browser encoder
// runs independently; there is no second scene, GPU context, or replay loop.
export async function encodeTrailerMP4({ engine, canvas, duration, fps, audioStream, signal, scale = 6 }: {
    engine: EngineRuntime;
    canvas: HTMLCanvasElement;
    duration: number;
    fps: number;
    audioStream?: MediaStream;
    signal?: AbortSignal;
    scale?: number;
}) {
    const mime = globalThis.MediaRecorder && ['video/mp4;codecs=avc1.42001f,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4'].find(t => MediaRecorder.isTypeSupported(t));
    if (!mime)
        throw Error('This browser cannot encode MP4; engine playback remains available');
    const blob = await engine.get('keel/capture').createCapture(canvas).video({ seconds: duration, fps, type: mime, requireType: true, scale, audio: audioStream, signal });
    if (!/^video\/mp4(?:;|$)/i.test(blob.type) || !blob.size)
        throw Error('Capture did not return an MP4');
    return blob;
}
const event = (node: HTMLVideoElement, name: string, trigger: (() => void) | undefined) => new Promise<void>((resolve, reject) => {
    const clean = () => { node.removeEventListener(name, done); node.removeEventListener('error', fail); };
    const done = () => { clean(); resolve(); }, fail = () => { clean(); reject(Error('Encoded MP4 could not be decoded')); };
    node.addEventListener(name, done, { once: true });
    node.addEventListener('error', fail, { once: true });
    trigger?.();
});
export async function installTrailerMP4({ blob, canvas, position, playing, onHandoff, signal }: {
    blob: Blob;
    canvas: HTMLCanvasElement;
    position: () => number;
    playing: () => boolean;
    onHandoff: (video: HTMLVideoElement) => void;
    signal?: AbortSignal;
}) {
    const url = URL.createObjectURL(blob), video = document.createElement('video');
    video.playsInline = true;
    video.loop = true;
    video.preload = 'auto';
    video.muted = true;
    video.style.cssText = canvas.style.cssText;
    video.dataset.trailerMp4 = 'true';
    try {
        await event(video, 'loadedmetadata', () => { video.src = url; });
        const check = () => { if (signal?.aborted)
            throw new DOMException('Capture cancelled', 'AbortError'); };
        const align = async () => {
            check();
            const t = Math.min(position() % video.duration, Math.max(0, video.duration - .01));
            if (Math.abs(video.currentTime - t) > .01)
                await event(video, 'seeked', () => { video.currentTime = t; });
        };
        await align();
        if (playing())
            await video.play();
        if (video.readyState < 2)
            await event(video, 'loadeddata', undefined);
        // The engine keeps running while decoding. Align again to the latest clock,
        // then switch picture and sound together without an intermediate blank frame.
        if (Math.abs(video.currentTime - position() % video.duration) > .05)
            await align();
        check();
        if (playing())
            await video.play();
        else
            video.pause();
        // Seek completion can arrive late on a busy device. Let the muted video
        // clock converge to the engine clock before switching the visible surface.
        const until = performance.now() + 20000;
        const drift = () => { let d = video.currentTime - position() % video.duration; if (d > video.duration / 2)
            d -= video.duration; if (d < -video.duration / 2)
            d += video.duration; return d; };
        while (playing() && Math.abs(drift()) > .04) {
            check();
            if (performance.now() > until)
                throw Error('MP4 playback alignment timed out');
            video.playbackRate = Math.max(.5, Math.min(1.5, 1 - drift() * .7));
            await new Promise(r => setTimeout(r, 40));
        }
        video.playbackRate = 1;
        if (!playing()) {
            video.pause();
            await align();
        }
        canvas.replaceWith(video);
        onHandoff(video);
        return { video, url, blob };
    }
    catch (error) {
        video.pause();
        video.removeAttribute('src');
        video.load();
        URL.revokeObjectURL(url);
        throw error;
    }
}
