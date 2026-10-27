import { errorMessage } from './contracts.js';
import type { BrowserOptions, RenderOptions } from './runtime-types.js';
import type { BrowserTestReport } from './verification-types.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { clickTrailerControl, openTrailerBrowser } from './onchain-browser.js';
import { digest } from './onchain.js';
export async function testTrailerLiveMP4({ bundleDir, preparedDir, outDir, readyTimeoutMs = 120000 }: RenderOptions, { playwright }: BrowserOptions = {}) {
    await mkdir(outDir, { recursive: true });
    let run;
    const checks: Record<string, boolean> = {}, errors: string[] = [], report: BrowserTestReport = { schema: 'keel-trailer-live-mp4-test@1', checks, errors, publication: 'not-published' };
    try {
        run = await openTrailerBrowser({ bundleDir, preparedDir, readyTimeoutMs, liveMP4: true }, { playwright });
        if (!run.manifest.liveMP4)
            throw Error('Project must enable liveMP4');
        const { frame, page } = run;
        const before = await frame.evaluate(() => ({ media: __TRAILER__.media, pixels: document.querySelector<HTMLCanvasElement>('canvas')!.toDataURL() }));
        await frame.waitForFunction(p => document.querySelector<HTMLCanvasElement>('canvas')!.toDataURL() !== p, before.pixels, { timeout: 10000 });
        checks.engineFirst = ['engine', 'encoding'].includes(before.media.state);
        checks.automaticEncoding = before.media.state === 'encoding';
        checks.immediateMotion = true;
        checks.oneTrailerCanvas = await frame.locator('canvas').count() === 1;
        checks.noLegacyGameBootstrap = await frame.evaluate(() => !Reflect.get(globalThis, 'REDLINE_GAME'));
        report.controlInput = await clickTrailerControl(frame);
        checks.trustedSoundGesture = report.controlInput?.isTrusted === true;
        await frame.waitForFunction(() => document.querySelector<HTMLButtonElement>('button')!.textContent === 'Pause' || globalThis.__TRAILER_ERROR__, null, { timeout: 120000 });
        checks.soundControlStarted = await frame.evaluate(() => document.querySelector<HTMLButtonElement>('button')!.textContent === 'Pause' && !globalThis.__TRAILER_ERROR__);
        const duration = await frame.evaluate(() => __TRAILER__.duration);
        await frame.waitForFunction(() => __TRAILER__.media.state === 'mp4' || __TRAILER__.media.error, null, { timeout: readyTimeoutMs + duration * 1000 + 30000 });
        const result = await frame.evaluate(() => { const v = document.querySelector('video'); return { media: __TRAILER__.media, video: v ? { width: v.videoWidth, height: v.videoHeight, duration: v.duration, currentTime: v.currentTime, paused: v.paused } : null }; });
        if (result.media.error)
            throw Error(result.media.error);
        report.media = result;
        checks.mp4 = Boolean(result.media.type?.startsWith('video/mp4'));
        checks.replacedCanvas = await frame.evaluate(() => !document.querySelector<HTMLCanvasElement>('canvas')!);
        checks.duration = Math.abs(result.video!.duration - duration) < .6;
        checks.integerScaling = result.video!.width === run.manifest.dimensions.width * run.manifest.liveMP4.scale && result.video!.height === run.manifest.dimensions.height * run.manifest.liveMP4.scale;
        checks.playing = !result.video!.paused;
        report.performance = await frame.evaluate(() => __TRAILER__.stats ?? null);
        if (report.performance) {
            checks.fixedFrames = report.performance.encodedFrames === Math.ceil(duration * run.manifest.dimensions.fps);
            checks.handoff = report.performance.handoffError < .08;
        }
        const pending = page.waitForEvent('download');
        if (await frame.locator('[data-trailer-save]').count()) {
            report.saveControl = await clickTrailerControl(frame, '[data-trailer-save]');
            checks.trustedSaveGesture = report.saveControl?.isTrusted === true;
        }
        else
            await frame.evaluate(() => { const a = document.createElement('a'); a.href = document.querySelector<HTMLVideoElement>('video')!.src; a.download = 'trailer.mp4'; a.click(); });
        const download = await pending;
        const videoPath = path.join(outDir, 'trailer.mp4');
        await download.saveAs(videoPath);
        checks.savable = !(await download.failure());
        report.video = { path: videoPath, sha256: digest(await readFile(videoPath)), bytes: result.media.bytes };
        checks.noNetwork = run.requests.length === 0;
        checks.noRuntimeErrors = run.errors.length === 0;
        errors.push(...run.errors);
        report.requests = run.requests;
        await page.screenshot({ path: path.join(outDir, 'handoff.png') });
    }
    catch (error) {
        checks.execution = false;
        errors.push(errorMessage(error));
        if (run)
            report.lastState = await run.frame.evaluate(() => ({ media: __TRAILER__?.media, button: document.querySelector<HTMLButtonElement>('button')!?.textContent, error: globalThis.__TRAILER_ERROR__ })).catch(() => null);
    }
    finally {
        await run?.browser.close();
    }
    report.bundleSha256 = digest(await readFile(path.join(bundleDir, 'bundle.json')));
    report.pass = Object.values(checks).every(Boolean);
    report.reportPath = path.join(outDir, 'live-mp4-test.json');
    await writeFile(report.reportPath, JSON.stringify(report, null, 2) + '\n');
    return report;
}
