import { errorMessage } from './contracts.js';
import type { BrowserOptions, RenderOptions } from './runtime-types.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openTrailerBrowser, pcmWav, soundtrack } from './onchain-browser.js';
import { digest } from './onchain.js';
export async function testTrailerBundle({ bundleDir, outDir, preparedDir, readyTimeoutMs = 120000 }: RenderOptions, { playwright }: BrowserOptions = {}) {
    await mkdir(outDir, { recursive: true });
    const checks: Record<string, boolean> = {}, errors: string[] = [], requests = [];
    let audio = null, run, manifest;
    try {
        run = await openTrailerBrowser({ bundleDir, preparedDir, readyTimeoutMs }, { playwright });
        const { page, frame } = run;
        manifest = run.manifest;
        checks.started = true;
        if (run.canonicalShell)
            checks.canonicalShell = true;
        if (run.completeTokenURI)
            checks.completeTokenURI = true;
        const result = await frame.evaluate(async () => { const a = globalThis.__TRAILER__, canvas = document.querySelector<HTMLCanvasElement>('canvas')!, t = Math.min(2, a.duration / 2); await a.seek(t); const first = { state: structuredClone(a.state), pixels: canvas.toDataURL() }; await a.seek(0); const opening = canvas.toDataURL(); await a.seek(t); const again = { state: structuredClone(a.state), pixels: canvas.toDataURL() }; await a.seek(a.duration); return { deterministic: JSON.stringify(first) === JSON.stringify(again), motion: first.pixels !== opening, frame: a.player.frame, duration: a.duration }; });
        checks.seekReplay = result.deterministic;
        checks.motion = result.motion;
        checks.endFrame = Number.isInteger(result.frame) && result.frame > 0;
        if (manifest.music) {
            audio = await soundtrack(frame);
            checks.audio = Boolean(audio?.channels?.some(c => c.some(v => Math.abs(v) > 1e-5)));
            if (audio)
                await writeFile(path.join(outDir, 'soundtrack.wav'), pcmWav(audio));
        }
        checks.noNetwork = run.requests.length === 0;
        checks.runtimeErrors = run.errors.length === 0;
        await page.screenshot({ path: path.join(outDir, 'preview.png') });
    }
    catch (error) {
        checks.execution = false;
        errors.push(errorMessage(error));
    }
    finally {
        if (run) {
            errors.push(...run.errors);
            requests.push(...run.requests);
            await run.browser.close();
        }
    }
    const report = { schema: 'keel-trailer-playback-test@1', pass: Object.values(checks).every(Boolean), checks, errors, requests, programSha256: manifest?.programSha256 ?? null, prepared: preparedDir ? path.resolve(preparedDir) : null, bundleSha256: digest(await readFile(path.join(bundleDir, 'bundle.json'))), audio: audio ? { sampleRate: audio.sampleRate, channels: audio.channels.length, samples: audio.channels[0].length } : null, publication: 'not-published' };
    await writeFile(path.join(outDir, 'playback-test.json'), JSON.stringify(report, null, 2) + '\n');
    return { ...report, reportPath: path.join(outDir, 'playback-test.json'), previewPath: path.join(outDir, 'preview.png'), ...(audio ? { audioPath: path.join(outDir, 'soundtrack.wav') } : {}) };
}
