import type { BrowserOptions, RenderOptions } from './runtime-types.js';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openTrailerBrowser, pcmWav, soundtrack } from './onchain-browser.js';
import { digest } from './onchain.js';
function processTask(command: string, args: string[]) {
    const proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] }), out: Buffer[] = [];
    let error = '', failure: Error | undefined;
    proc.stdout.on('data', b => out.push(b));
    proc.stderr.on('data', b => error = (error + b).slice(-12000));
    proc.stdin.on('error', e => failure = e);
    const done = new Promise<number | null>(resolve => { proc.once('error', e => { failure = e; resolve(-1); }); proc.once('close', resolve); });
    return { proc, async finish() { const code = await done; if (code !== 0 || failure)
            throw Error(failure?.message ?? error); return Buffer.concat(out); }, get failure() { return failure; } };
}
export async function renderTrailerBundle({ bundleDir, preparedDir, outDir, scale = 4, crf = 12, readyTimeoutMs = 120000 }: RenderOptions, { playwright, log = () => { } }: BrowserOptions & {
    log?: (message: string) => void;
} = {}) {
    if (!Number.isSafeInteger(scale) || scale < 1 || scale > 12 || !Number.isSafeInteger(crf) || crf < 0 || crf > 28)
        throw RangeError('Invalid integer scale or CRF');
    await mkdir(outDir, { recursive: true });
    const run = await openTrailerBrowser({ bundleDir, preparedDir, readyTimeoutMs }, { playwright });
    let encoder;
    try {
        const { frame, manifest } = run, info = await frame.evaluate(() => ({ width: document.querySelector<HTMLCanvasElement>('canvas')!.width, height: document.querySelector<HTMLCanvasElement>('canvas')!.height, fps: __TRAILER__.fps, duration: __TRAILER__.duration }));
        const width = info.width * scale, height = info.height * scale, frames = Math.ceil(info.duration * info.fps);
        if (width % 2 || height % 2 || width > 7680 || height > 4320 || width * height > 33177600)
            throw RangeError('Output must have even dimensions within 7680x4320');
        const nativePath = path.join(outDir, 'native.mkv'), audioPath = path.join(outDir, 'soundtrack.wav'), videoPath = path.join(outDir, 'trailer.mp4');
        if (manifest.music) {
            log('Rendering generated soundtrack\n');
            const audio = await soundtrack(frame);
            if (!audio?.channels.some(c => c.some(v => Math.abs(v) > 1e-5)))
                throw Error('Trailer soundtrack is silent');
            await writeFile(audioPath, pcmWav(audio));
        }
        await frame.evaluate(() => __TRAILER__.seek(0));
        encoder = processTask('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', info.width + 'x' + info.height, '-framerate', String(info.fps), '-i', '-', '-c:v', 'ffv1', '-pix_fmt', 'rgb24', '-threads', '1', nativePath]);
        const rgbHash = createHash('sha256'), samples = [];
        for (let n = 0; n < frames; n++) {
            if (encoder.failure)
                throw encoder.failure;
            const captured = await frame.evaluate(async ({ n, fps, sample }) => { await __TRAILER__.seek(n / fps); const c = document.querySelector<HTMLCanvasElement>('canvas')!, px = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data; let text = ''; for (let j = 0; j < px.length; j += 8192)
                text += String.fromCharCode(...px.subarray(j, j + 8192)); return { rgba: btoa(text), ...(sample ? { state: __TRAILER__.state, png: c.toDataURL('image/png').split(',')[1] } : {}) }; }, { n, fps: info.fps, sample: n % info.fps === 0 || n === frames - 1 });
            const raw = Buffer.from(captured.rgba, 'base64');
            if (raw.length !== info.width * info.height * 4)
                throw Error('Native frame byte mismatch');
            const rgb = Buffer.alloc(info.width * info.height * 3);
            for (let i = 0, j = 0; i < raw.length; i += 4) {
                rgb[j++] = raw[i];
                rgb[j++] = raw[i + 1];
                rgb[j++] = raw[i + 2];
            }
            rgbHash.update(rgb);
            if (!encoder.proc.stdin.write(raw))
                await once(encoder.proc.stdin, 'drain');
            if (captured.state)
                samples.push({ frame: n, seconds: n / info.fps, state: captured.state });
            if (captured.png && [0, Math.floor(frames / 2), frames - 1].includes(n))
                await writeFile(path.join(outDir, 'frame-' + n + '.png'), Buffer.from(captured.png, 'base64'));
            if (n % 120 === 0)
                log('Captured ' + n + ' / ' + frames + ' frames\n');
        }
        encoder.proc.stdin.end();
        await encoder.finish();
        encoder = null;
        if (run.errors.length || run.requests.length)
            throw Error('Capture had browser errors or network requests: ' + JSON.stringify({ errors: run.errors, requests: run.requests }));
        log('Encoding ' + width + 'x' + height + ' with nearest-neighbor scaling\n');
        const args = ['-v', 'error', '-y', '-i', nativePath, ...(manifest.music ? ['-i', audioPath] : []), '-map', '0:v:0', ...(manifest.music ? ['-map', '1:a:0'] : []), '-vf', 'scale=' + width + ':' + height + ':flags=neighbor', '-frames:v', String(frames), '-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf), '-pix_fmt', 'yuv420p', ...(manifest.music ? ['-c:a', 'aac', '-b:a', '192k'] : []), '-t', String(info.duration), '-movflags', '+faststart', videoPath];
        await processTask('ffmpeg', args).finish();
        const probe = JSON.parse((await processTask('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', videoPath]).finish()).toString('utf8')) as {
            streams: {
                codec_type: string;
                width: number;
                height: number;
                nb_read_frames: string;
            }[];
            format: {
                duration: string;
            };
        };
        const v = probe.streams.find(s => s.codec_type === 'video'), a = probe.streams.find(s => s.codec_type === 'audio');
        if (!v || v.width !== width || v.height !== height || Number(v.nb_read_frames) !== frames || Math.abs(Number(probe.format.duration) - info.duration) > .05 || Boolean(a) !== Boolean(manifest.music))
            throw Error('Encoded delivery dimensions, duration, frame count or audio mismatch');
        const report = { schema: 'keel-trailer-scene-render@1', pass: true, bundleSha256: digest(await readFile(path.join(bundleDir, 'bundle.json'))), programSha256: manifest.programSha256, native: { path: nativePath, width: info.width, height: info.height, fps: info.fps, frames, rgbSha256: rgbHash.digest('hex'), sha256: digest(await readFile(nativePath)) }, video: { path: videoPath, width, height, fps: info.fps, frames, duration: Number(probe.format.duration), scale, scaler: 'nearest-neighbor', codec: 'h264', crf, sha256: digest(await readFile(videoPath)) }, audio: manifest.music ? { path: audioPath, sha256: digest(await readFile(audioPath)) } : null, checks: { canonicalShell: run.canonicalShell, completeTokenURI: run.completeTokenURI, noNetwork: true, noBrowserErrors: true }, publication: 'not-published' };
        await writeFile(path.join(outDir, 'render.json'), JSON.stringify(report, null, 2) + '\n');
        await writeFile(path.join(outDir, 'scene-samples.json'), JSON.stringify(samples, null, 2) + '\n');
        return { ...report, reportPath: path.join(outDir, 'render.json') };
    }
    finally {
        if (encoder?.proc.exitCode === null) {
            encoder.proc.kill();
            await encoder.finish().catch(() => { });
        }
        await run.browser.close();
    }
}
