import { errorMessage } from './contracts.js';
import type { EncodedMovie } from './runtime-types.js';
import { installTrailerMP4 } from './live-mp4.js';
import { createScoreCodec, renderScore } from './music.js';
import { encodeOfflineTrailer } from './offline-mp4.js';
import { attachPlayerUI } from './player-ui.js';
import { createSceneCodec, createScenePlayer } from './program.js';
export async function mountTrailer({ music = null, liveMP4 = null }: {
    music?: {
        mode: 'file' | 'recipe' | 'score';
    } | null;
    liveMP4?: {
        scale?: number;
        autoplay?: boolean;
    } | null;
} = {}) {
    const mounted = performance.now(), phases: {
        engineMs: number;
        audioMs?: number;
        audioError?: string;
        sceneMs?: number;
        warmupMs?: number;
    } = { engineMs: 0 };
    globalThis.__TRAILER_PHASES__ = phases;
    const status = document.querySelector('output')!;
    status.textContent = 'Preparing scene…';
    const engine = globalThis.KEEL_ENGINE;
    await engine.start();
    phases.engineMs = performance.now() - mounted;
    const codec = engine.get('keel/codec'), p = createSceneCodec(codec).decode(globalThis.__KEEL_CONTENT__.bytes('trailer.scene'));
    const canvas = document.querySelector<HTMLCanvasElement>('main>canvas') ?? document.querySelector<HTMLCanvasElement>('canvas')!;
    canvas.width = p.width;
    canvas.height = p.height;
    let context: AudioContext | null = null, buffer: AudioBuffer | null = null;
    const audioStarted = performance.now(), audioPrepared = prepareAudio().then(() => { phases.audioMs = performance.now() - audioStarted; }, e => { phases.audioError = errorMessage(e); throw e; });
    audioPrepared.catch(() => { });
    const scene = await globalThis.KEEL_TRAILER_SCENE.createTrailerScene({ canvas, engine, program: p, content: globalThis.__KEEL_CONTENT__ });
    phases.sceneMs = performance.now() - mounted - phases.engineMs;
    for (const a of p.actions)
        if (typeof scene.actions[a.name] !== 'function' || scene.arities?.[a.name] !== a.arity)
            throw Error('Scene adapter action mismatch: ' + a.name);
    const player = createScenePlayer(p, { reset: s => scene.reset(s), call: (n, a, c) => scene.actions[n](...a, c), step: (dt, f) => scene.step(dt, f), prepare: f => scene.prepareFrame?.(f), render: a => scene.render(a) });
    let source: AudioBufferSourceNode | null = null, start = 0, offset = 0, playing = false, hasSound = !music, raf = 0, media: HTMLVideoElement | null = null, encoding: Promise<EncodedMovie | null> | null = null, encoded: EncodedMovie | null = null, encodeError: string | null = null, progress = 0, lastUi = 0, muted = false;
    const samples: number[] = [], intervals: number[] = [];
    let previousDraw = 0, preparedMs = 0, handoffError = 0, encodedFrames = 0, encodingMs = 0, drawTask: Promise<unknown> | null = null, drawing = false;
    const now = () => hasSound && context ? context.currentTime : performance.now() / 1000;
    const position = () => media ? media.currentTime : playing ? (offset + now() - start) % player.duration : offset;
    const error = (e: unknown) => { status.textContent = errorMessage(e); globalThis.__TRAILER_ERROR__ = errorMessage(e); };
    const ui = attachPlayerUI({ scene, duration: player.duration, onPlay: () => { if (playing && hasSound)
            pause();
        else
            play().catch(error); }, onSeek: t => seek(t).catch(error), onSound: () => sound().catch(error), onSave: () => { if (!encoded)
            return; const a = document.createElement('a'); a.href = encoded.url; a.download = 'trailer.mp4'; a.hidden = true; document.body.append(a); a.click(); setTimeout(() => a.remove(), 1000); } });
    async function prepareAudio() {
        if (!music)
            return;
        context = globalThis.KEEL_AUDIO.ctx;
        const bytes = globalThis.__KEEL_CONTENT__.bytes('trailer.music');
        let rendered;
        if (music.mode === 'file')
            rendered = await context.decodeAudioData(bytes.slice().buffer);
        else if (music.mode === 'score')
            rendered = await renderScore(globalThis.Tone, createScoreCodec(codec).decode(bytes));
        else
            rendered = await engine.get('keel/audio').render(globalThis.Tone, engine.get('keel/audio').loadMusic(bytes), { preroll: 0, rate: 48000, overrun: 0 });
        if (music.mode !== 'recipe' && rendered.duration + 1 / rendered.sampleRate < p.duration * 60 / (p.bpm * p.ppq))
            throw Error('Audio ends before the trailer');
        buffer = context.createBuffer(rendered.numberOfChannels, Math.round(p.duration * 60 / (p.bpm * p.ppq) * rendered.sampleRate), rendered.sampleRate);
        for (let c = 0; c < buffer.numberOfChannels; c++) {
            const from = rendered.getChannelData(c), to = buffer.getChannelData(c);
            if (music.mode === 'recipe') {
                for (let at = 0; at < to.length; at += from.length)
                    to.set(from.subarray(0, Math.min(from.length, to.length - at)), at);
            }
            else
                to.set(from.subarray(0, to.length));
        }
    }
    function stopSource() { if (source) {
        try {
            source.stop();
        }
        catch { }
        source.disconnect();
        source = null;
    } }
    function startSource() { stopSource(); if (!buffer || !hasSound || media)
        return; source = context!.createBufferSource(); source.buffer = buffer; source.loop = true; source.connect(globalThis.KEEL_AUDIO.destination); source.start(context!.currentTime, offset % buffer.duration); }
    function updateUI() { ui.update({ playing, time: position(), muted, hasSound, media: encoded ? 'mp4' : encoding ? 'encoding' : encodeError ? 'error' : 'engine', progress, encodeError }); }
    function pause() { offset = position(); media?.pause(); playing = false; stopSource(); cancelAnimationFrame(raf); updateUI(); }
    function prepareAt(time: number) { const task = (drawTask ?? Promise.resolve()).then(() => { if (!media)
        return player.seekPrepared(time); }); drawTask = task; task.then(() => { if (drawTask === task)
        drawTask = null; }, () => { if (drawTask === task)
        drawTask = null; }); return task; }
    async function seek(t: number) { pause(); offset = Math.max(0, Math.min(player.duration - .001, t)); const held = offset; if (media)
        media.currentTime = held;
    else
        await prepareAt(held); updateUI(); return held; }
    async function draw() {
        if (!playing || drawing)
            return;
        drawing = true;
        try {
            const t = position(), began = performance.now();
            if (!media) {
                const target = Math.floor(t * p.fps + 1e-8);
                if (target !== player.frame)
                    await prepareAt(t);
                samples.push(performance.now() - began);
                if (samples.length > 4096)
                    samples.shift();
                if (previousDraw) {
                    intervals.push(began - previousDraw);
                    if (intervals.length > 4096)
                        intervals.shift();
                }
                previousDraw = began;
            }
            if (began - lastUi >= 100) {
                updateUI();
                lastUi = began;
            }
            if (playing)
                raf = requestAnimationFrame(() => draw().catch(error));
        }
        finally {
            drawing = false;
        }
    }
    async function enableSound() {
        if (!music) {
            hasSound = true;
            return;
        }
        const held = position(), wasPlaying = playing;
        // Both controls call this from the trusted input handler. Unmute the media
        // immediately while that gesture is active; the offline score is already ready.
        muted = false;
        globalThis.KEEL_AUDIO.muted = false;
        if (media) {
            media.muted = false;
            hasSound = true;
            if (wasPlaying)
                await media.play();
            updateUI();
            return;
        }
        const started = await globalThis.KEEL_AUDIO.start();
        if (!started)
            throw Error('Sound could not start');
        await context!.resume();
        await audioPrepared;
        const resumedPosition = position();
        hasSound = true;
        offset = resumedPosition;
        start = now();
        if (playing)
            startSource();
        updateUI();
    }
    async function sound() { if (!hasSound) {
        await enableSound();
        if (!playing)
            await play();
        return;
    } muted = !muted; if (media)
        media.muted = muted; globalThis.KEEL_AUDIO.muted = muted; updateUI(); }
    async function play() {
        if (playing && hasSound)
            return;
        ui.button.disabled = true;
        try {
            if (!hasSound)
                await enableSound();
            cancelAnimationFrame(raf);
            if (media) {
                media.muted = muted;
                await media.play();
                playing = true;
                draw();
                return;
            }
            await prepareAt(offset);
            start = now();
            playing = true;
            previousDraw = 0;
            startSource();
            draw().catch(error);
            updateUI();
        }
        finally {
            ui.button.disabled = false;
        }
    }
    function beginEncoding() {
        if (!liveMP4 || encoding || encoded || globalThis.__KEEL_TRAILER_TEST_MODE__)
            return;
        const began = performance.now();
        encoding = audioPrepared.then(() => encodeOfflineTrailer({ engine, program: p, buffer, scale: liveMP4.scale ?? 6, onProgress(value, detail) { progress = value; encodedFrames = detail.frames; } }))
            .then(result => { encodingMs = performance.now() - began; encodedFrames = result.frames; return installTrailerMP4({ blob: result.blob, canvas, position, playing: () => playing, onHandoff(video) { handoffError = Math.abs(video.currentTime - position()); offset = position(); media = video; media.muted = !hasSound || muted; stopSource(); const release = () => { (drawTask ?? Promise.resolve()).finally(() => scene.dispose?.()).catch(error); }; if (video.requestVideoFrameCallback)
                video.requestVideoFrameCallback(release);
            else
                setTimeout(release, 100); } }); })
            .then(result => { encoded = result; document.body.dataset.media = 'mp4'; updateUI(); return result; })
            .catch(e => { encodeError = errorMessage(e); updateUI(); return null; })
            .finally(() => { encoding = null; updateUI(); });
        updateUI();
    }
    document.addEventListener('visibilitychange', () => { if (document.hidden)
        pause(); });
    let phase = performance.now();
    // Native preparation initializes resources without replaying the entire film.
    if (scene.prepare)
        await scene.prepare((value, label) => ui.prepare(value, label));
    player.reset();
    await player.seekPrepared(0);
    phases.warmupMs = performance.now() - phase;
    preparedMs = performance.now() - mounted;
    ui.ready();
    const percentile = (a: number[], q: number) => { const sorted = [...a].sort((x, y) => x - y); return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0; };
    const api = { player, play, pause, seek, get duration() { return player.duration; }, get fps() { return p.fps; }, get media() { return { state: encoded ? 'mp4' : encoding ? 'encoding' : 'engine', error: encodeError, progress, bytes: encoded?.blob.size ?? 0, type: encoded?.blob.type ?? null, src: encoded?.url ?? null }; }, get movieReady() { return encoding; }, get movieBlob() { return encoded?.blob ?? null; }, get stats() { return { resources: scene.resourceStats?.(), encoderResources: globalThis.__TRAILER_WORKER_DEBUG__?.resources, preparedMs, frames: samples.length, renderP50: percentile(samples, .5), renderP95: percentile(samples, .95), intervalP50: percentile(intervals, .5), intervalP95: percentile(intervals, .95), handoffError, exportMode: 'fixed-frames', encoderThread: globalThis.__TRAILER_WORKER_DEBUG__?.renderer ?? 'starting', encodedFrames, encodingMs }; }, get audio() { return { enabled: hasSound, muted, context: context?.state, master: globalThis.KEEL_AUDIO?.destination?.gain.value, bufferDuration: buffer?.duration }; }, get state() { return scene.snapshot?.() ?? null; }, async movieBytes() { return encoded ? Array.from(new Uint8Array(await encoded.blob.arrayBuffer())) : null; }, async audioSamples() { return buffer ? { sampleRate: buffer.sampleRate, channels: Array.from({ length: buffer.numberOfChannels }, (_, i) => Array.from(buffer!.getChannelData(i))) } : null; } };
    globalThis.__TRAILER__ = api;
    document.body.dataset.ready = 'true';
    if (liveMP4?.autoplay && !globalThis.__KEEL_TRAILER_TEST_MODE__) {
        start = now();
        playing = true;
        draw().catch(error);
    }
    beginEncoding();
    updateUI();
    return api;
}
