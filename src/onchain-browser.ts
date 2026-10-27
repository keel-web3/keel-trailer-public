import { errorMessage } from './contracts.js';
import type { BrowserOptions, SampleData, SceneOpenOptions } from './runtime-types.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest, localFile, verifyTrailerBundle } from './onchain.js';
export async function openTrailerBrowser({ bundleDir, preparedDir, readyTimeoutMs = 120000, liveMP4 = false }: SceneOpenOptions, { playwright }: BrowserOptions = {}) {
    const manifest = await verifyTrailerBundle(bundleDir), selected = manifest.previews?.find(p => p.path === 'verified-preview.html') ?? manifest.previews?.find(p => p.path === 'preview.html');
    if (!selected)
        throw Error('Bundle has no committed preview');
    const preview = await localFile(bundleDir, selected.path);
    if (digest(await readFile(preview)) !== selected.sha256)
        throw Error('Preview digest mismatch');
    let url = pathToFileURL(preview).href, temporary = null;
    if (preparedDir) {
        const prep = JSON.parse(await readFile(await localFile(preparedDir, 'preparation.json'), 'utf8'));
        if (prep.bundleSha256 !== digest(await readFile(path.join(bundleDir, 'bundle.json'))))
            throw Error('Prepared document belongs to another bundle');
        const tokenURI = await readFile(await localFile(preparedDir, 'tokenURI.txt'), 'utf8');
        if (digest(Buffer.from(tokenURI)) !== prep.tokenURIHash)
            throw Error('Prepared tokenURI digest mismatch');
        const meta = JSON.parse(await (await fetch(new URL(tokenURI).href)).text()), html = await (await fetch(new URL(meta.animation_url).href)).text();
        if (digest(Buffer.from(html)) !== prep.htmlHash)
            throw Error('Standard tokenURI parsing changed HTML');
        if (liveMP4) {
            temporary = await mkdtemp(path.join(os.tmpdir(), 'keel-token-export-'));
            await writeFile(path.join(temporary, 'token.html'), html);
            url = pathToFileURL(path.join(temporary, 'token.html')).href;
        }
        else
            url = meta.animation_url;
    }
    const { chromium } = playwright ?? await import('playwright');
    let browser;
    try {
        browser = await chromium.launch(process.platform === 'darwin' ? { headless: true, channel: liveMP4 ? 'chrome' : 'chromium', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] } : { headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    }
    catch (e) {
        if (temporary)
            await rm(temporary, { recursive: true, force: true });
        throw e;
    }
    if (temporary) {
        const close = browser.close.bind(browser);
        browser.close = async () => { try {
            await close();
        }
        finally {
            await rm(temporary, { recursive: true, force: true });
        } };
    }
    const errors: string[] = [], requests: string[] = [];
    try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        if (!liveMP4)
            await page.addInitScript(() => { globalThis.__KEEL_TRAILER_TEST_MODE__ = true; });
        page.on('pageerror', e => errors.push(errorMessage(e)));
        await page.route('**/*', route => { const u = route.request().url(); if (/^https?:/i.test(u)) {
            requests.push(u);
            return route.abort();
        } return route.continue(); });
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: readyTimeoutMs });
        let frame;
        const until = Date.now() + readyTimeoutMs;
        while (Date.now() < until && !frame) {
            for (const f of page.frames()) {
                const state = await f.evaluate(() => ({ ready: Boolean(globalThis.__TRAILER__), error: globalThis.__TRAILER_ERROR__ ?? (document.body?.dataset.verification === 'failed' ? document.body.innerText.split('\n')[0] : null) })).catch(() => ({ ready: false, error: null }));
                if (state.error)
                    throw Error(state.error);
                if (state.ready) {
                    frame = f;
                    break;
                }
            }
            if (!frame)
                await new Promise(r => setTimeout(r, 100));
        }
        if (!frame)
            throw Error('Trailer scene preparation timed out');
        if (selected.path === 'verified-preview.html')
            await page.waitForFunction(() => document.body.dataset.verification === 'verified', null, { timeout: 10000 });
        return { browser, page, frame, manifest, errors, requests, canonicalShell: selected.path === 'verified-preview.html', completeTokenURI: Boolean(preparedDir) };
    }
    catch (error) {
        await browser.close();
        throw error;
    }
}
// Chromium's main-page input routing misses transformed opaque child frames.
// Send a real, trusted pointer event to that frame's input target; the normal
// button handler still owns audio startup and playback.
export async function clickTrailerControl(frame: import('playwright').Frame, selector?: string) {
    const button = selector ? frame.locator(selector) : await frame.locator('[data-trailer-play]').count() ? frame.locator('[data-trailer-play]') : frame.locator('button').first();
    await button.waitFor({ state: 'visible' });
    await frame.waitForFunction(() => { const button = document.querySelector<HTMLButtonElement>('[data-trailer-play]') ?? document.querySelector<HTMLButtonElement>('button'); return Boolean(button && !button.disabled); });
    await button.evaluate(b => { globalThis.__KEEL_TRAILER_CONTROL_INPUT__ = null; b.addEventListener('click', e => { globalThis.__KEEL_TRAILER_CONTROL_INPUT__ = { isTrusted: e.isTrusted, target: (e.target as HTMLElement).tagName }; }, { capture: true, once: true }); });
    let session;
    try {
        session = await frame.page().context().newCDPSession(frame);
    }
    catch { }
    if (session) {
        try {
            const point = await button.evaluate(b => { const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
            await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
            await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
            await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
        }
        finally {
            await session.detach();
        }
    }
    else
        await button.click();
    return frame.evaluate(() => globalThis.__KEEL_TRAILER_CONTROL_INPUT__);
}
export async function soundtrack(frame: import('playwright').Frame) {
    await clickTrailerControl(frame);
    await frame.waitForFunction(() => globalThis.__TRAILER_ERROR__ || document.querySelector<HTMLButtonElement>('button')!.textContent === 'Pause', null, { timeout: 120000 });
    const error = await frame.evaluate(() => globalThis.__TRAILER_ERROR__);
    if (error)
        throw Error(error);
    await frame.evaluate(() => __TRAILER__.pause());
    return frame.evaluate(() => __TRAILER__.audioSamples());
}
export function pcmWav({ sampleRate, channels }: SampleData) {
    const n = channels[0].length, count = channels.length, b = Buffer.alloc(44 + n * count * 2);
    b.write('RIFF');
    b.writeUInt32LE(b.length - 8, 4);
    b.write('WAVEfmt ', 8);
    b.writeUInt32LE(16, 16);
    b.writeUInt16LE(1, 20);
    b.writeUInt16LE(count, 22);
    b.writeUInt32LE(sampleRate, 24);
    b.writeUInt32LE(sampleRate * count * 2, 28);
    b.writeUInt16LE(count * 2, 32);
    b.writeUInt16LE(16, 34);
    b.write('data', 36);
    b.writeUInt32LE(b.length - 44, 40);
    for (let i = 0; i < n; i++)
        for (let c = 0; c < count; c++)
            b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, channels[c][i])) * 32767), 44 + (i * count + c) * 2);
    return b;
}
