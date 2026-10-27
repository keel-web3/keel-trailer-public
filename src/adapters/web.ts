import type { CaptureRequest } from '../contracts.js';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { assertInspection } from '../inspection.js';
export async function webCapture(c: CaptureRequest, outDir: string) {
    let chromium;
    try {
        ({ chromium } = await import('playwright'));
    }
    catch {
        throw Error('Web capture needs playwright and its Chromium browser: pnpm --filter @keel/trailer exec playwright install chromium');
    }
    await mkdir(outDir, { recursive: true });
    const fps = c.fps ?? 30, width = c.width ?? 1920, height = c.height ?? 1080, frames = c.frames ?? 600;
    const epoch = c.epoch ?? '2026-10-04T03:33:00.000Z';
    if (!Number.isFinite(Date.parse(epoch)))
        throw Error('epoch must be an ISO date');
    const url = new URL(c.url!);
    if (c.cinematicFlag) {
        const [key, value = '1'] = c.cinematicFlag.replace(/^[?&]/, '').split('=');
        url.searchParams.set(key, value);
    }
    const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars'] });
    const video = outDir + '/web.mkv', stderr: Buffer[] = [];
    let ff: import('node:child_process').ChildProcessByStdio<import('node:stream').Writable, null, import('node:stream').Readable> | undefined;
    let exited: Promise<unknown> | undefined;
    try {
        const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'UTC', reducedMotion: 'no-preference' });
        await page.clock.install({ time: new Date(epoch) });
        await page.clock.pauseAt(new Date(Date.parse(epoch) + 1000));
        await page.addInitScript(seed => { let x = seed || 7; Math.random = () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; }; }, c.seed ?? 7);
        await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 90000 });
        let ready = !c.readySelector;
        for (let i = 0; i < (c.readyFrames ?? 300) && !ready; i++) {
            ready = await page.locator(c.readySelector!).count() > 0;
            if (ready && c.readyAttribute)
                ready = await page.locator(c.readySelector!).getAttribute(c.readyAttribute) === c.readyValue;
            if (!ready)
                await page.clock.runFor(100);
        }
        if (!ready)
            throw Error('Web readiness condition did not arrive under the deterministic clock');
        await page.evaluate(() => document.fonts.ready);
        ff = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-', '-c:v', 'ffv1', '-pix_fmt', 'rgb24', '-threads', '1', '-fflags', '+bitexact', '-flags:v', '+bitexact', video], { stdio: ['pipe', 'ignore', 'pipe'] });
        exited = new Promise((resolve, reject) => { ff!.once('error', reject); ff!.once('close', resolve); });
        ff.stderr.on('data', d => stderr.push(d));
        // Keep process/pipe failures visible even while taking screenshots.
        let pipeError;
        ff.stdin.on('error', e => { pipeError = e; });
        const marks = [], rects = [], inspectionFiles = [];
        let last = '';
        for (let f = 0; f < frames; f++) {
            for (const step of c.steps ?? []) {
                if (step.frame === f) {
                    if (step.action === 'click')
                        await page.locator(step.selector!).evaluate(el => (el as HTMLElement).click());
                    if (step.action === 'mark')
                        marks.push({ name: step.name, frame: f });
                }
                if (step.action === 'scroll' && f >= step.frame && f <= (step.endFrame ?? step.frame)) {
                    let p = (f - step.frame) / Math.max(1, (step.endFrame ?? step.frame) - step.frame);
                    p = p * p * (3 - 2 * p);
                    const x = (step.fromX ?? 0) + ((step.x ?? 0) - (step.fromX ?? 0)) * p;
                    const y = (step.fromY ?? 0) + ((step.y ?? 0) - (step.fromY ?? 0)) * p;
                    await page.evaluate(({ x, y }) => scrollTo({ left: Math.round(x), top: Math.round(y), behavior: 'instant' }), { x, y });
                }
            }
            const state = await page.evaluate(attrs => attrs.map(a => document.documentElement.getAttribute(a)).join('|'), c.stateAttributes ?? []);
            if (state !== last) {
                marks.push({ name: 'state:' + state, frame: f });
                last = state;
            }
            if (c.rectSelectors?.length)
                rects.push({ frame: f, elements: await page.evaluate(selectors => {
                        const out: Record<string, {
                            x: number;
                            y: number;
                            width: number;
                            height: number;
                        }> = {};
                        for (const selector of selectors) {
                            const el = document.querySelector(selector);
                            if (el) {
                                const r = el.getBoundingClientRect();
                                out[selector] = { x: r.x, y: r.y, width: r.width, height: r.height };
                            }
                        }
                        return out;
                    }, c.rectSelectors) });
            if (c.inspectionFrames?.includes(f)) {
                const snapshot = await page.evaluate(({ name, frame, seconds }) => {
                    const probe = Reflect.get(globalThis, name) as import('../probe.js').InspectionProbe | undefined;
                    if (!probe || typeof probe.snapshot !== 'function')
                        throw Error('Page has no inspection probe: ' + name);
                    return probe.snapshot({ frame, seconds });
                }, { name: c.probeGlobal ?? '__KEEL_INSPECTION__', frame: f, seconds: f / fps });
                assertInspection(snapshot);
                const p = outDir + '/inspection-' + String(f).padStart(8, '0') + '.json';
                await writeFile(p, JSON.stringify(snapshot, null, 2) + '\n');
                inspectionFiles.push({ frame: f, path: p });
            }
            if (pipeError)
                throw pipeError;
            const png = await page.screenshot({ type: 'png', timeout: 180000, animations: 'allow' });
            if (!ff.stdin.write(png))
                await once(ff.stdin, 'drain');
            await page.clock.runFor(Math.round((f + 1) * 1000 / fps) - Math.round(f * 1000 / fps));
        }
        ff.stdin.end();
        const code = await exited;
        if (code !== 0)
            throw Error('ffmpeg web capture failed: ' + Buffer.concat(stderr).toString().slice(-2000));
        const result = { adapter: 'web', path: video, fps, width, height, frames, url: url.href, epoch, marks, rects, inspectionFiles,
            sha256: createHash('sha256').update(await readFile(video)).digest('hex'),
            determinism: 'Paused fake clock and seeded Math.random; recapture also depends on pinned browser, GPU renderer and page assets.' };
        const metadataPath = outDir + '/web.json';
        await writeFile(metadataPath, JSON.stringify(result, null, 2) + '\n');
        return { ...result, metadataPath };
    }
    finally {
        if (ff && ff.exitCode === null) {
            ff.kill();
            await exited?.catch(() => { });
        }
        await browser.close();
    }
}
