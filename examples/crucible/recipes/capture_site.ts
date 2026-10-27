// Records the public site's package tour (https://crucible.onkeel.io) frame by frame with Playwright's fake clock,
// so the camera moves are perfectly smooth at FPS regardless of how slow each screenshot is.
// Usage: node capture_site.ts OUTDIR WIDTH HEIGHT   -> OUTDIR/site-WxH.mkv (lossless) + site-WxH.json (marks)
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
// @playwright/test is resolved from the site checkout (or PLAYWRIGHT_FROM: any package.json next to a node_modules with it)
const require = createRequire(process.env.PLAYWRIGHT_FROM ?? import.meta.url);
const { chromium } = require('playwright');
const [out, W = '1920', H = '1080'] = process.argv.slice(2);
const URL = (process.env.SITE_URL ?? 'https://crucible.onkeel.io') + (process.env.SITE_QUERY ?? '');
const FPS = 30, DT = 1000 / FPS;
mkdirSync(out, { recursive: true });
// PART: 'all' (default), 'tour' (chapters 01-07), 'manual' (the booklet only; its own file, -manual) or 'opening' (the
// trailer's opening, -opening: one continuous move from the closed box to the cartridge in the handheld and the power,
// then Play: the camera flies down onto the handheld, whose screen ends axis-aligned at a whole multiple of 160x144
// (7x = 1120x1008 at 1920x1080, centred), the site's own emulator booting in it. The page chrome is hidden for it.)
// SITE_QUERY (e.g. '?cinematic=1') is appended to the URL.
const PART = process.env.PART ?? 'all';
// PART=cinematic: the site's own ?cinematic=1 take (package-experience.tsx): 1.2 s on the closed box, a 7 s glide (the
// lid, the cartridge out and into the handheld, the power light), Play, the camera into the screen, the start-up screen
// (lib/boot.ts: the KEEL mark scrolls down, the chime, the dither into the game). Recorded until <html
// data-cinematic=done> and data-boot-phase=done, plus CINE_TAIL seconds; every change of either is a mark. Its own
// file, -opening (the trailer's opening).
const tag = `site-${W}x${H}${PART === 'manual' ? '-manual' : PART === 'opening' || PART === 'cinematic' ? '-opening' : ''}`;
// No ffmpeg on the machine (e.g. a helper Mac): numbered PNGs in OUTDIR/<tag>/ instead of the .mkv
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
if (!hasFfmpeg) mkdirSync(`${out}/${tag}`, { recursive: true });
let pngIndex = 0;
const ff = !hasFfmpeg ? { stdin: { write: b => writeFileSync(`${out}/${tag}/${String(pngIndex++).padStart(5, '0')}.png`, b), end() {} }, on: (_, r) => r() } : spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-',
  '-c:v', 'ffv1', '-pix_fmt', 'rgb24', `${out}/${tag}.mkv`], { stdio: ['pipe', 'inherit', 'inherit'] });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: +W, height: +H }, deviceScaleFactor: 1, reducedMotion: 'no-preference' });
await page.clock.install({ time: new Date('2026-10-04T03:33:00') });
// paused: page time moves only by runFor, a frame at a time, however long each screenshot takes (installed clocks
// otherwise keep flowing at real speed)
await page.clock.pauseAt(new Date('2026-10-04T03:33:01'));
await page.goto(URL + (PART === 'cinematic' && !URL.includes('cinematic') ? (URL.includes('?') ? '&' : '?') + 'cinematic=1' : ''), { waitUntil: 'domcontentloaded', timeout: 90000 });
for (let i = 0; i < 300; i++) {   // let the room build under the fake clock
  await page.clock.runFor(100);
  if (await page.evaluate(() => document.querySelector('canvas.package-canvas')?.dataset.sceneStatus === 'ready')) break;
  await page.waitForTimeout(50);
}
// the cinematic take on a desktop viewport: Play's view is not pinned there, so the page's next section (the rooms)
// shows in a 56 px strip above it; pin the playing view to the whole viewport and hide the rooms for the take
if (PART === 'cinematic') await page.addStyleTag({ content: '.cinematic .package-experience.is-playing{position:fixed!important;inset:0!important;height:100vh!important;z-index:50}.cinematic .room{visibility:hidden!important}' });
if (PART !== 'cinematic') await page.addStyleTag({ content: PART === 'opening'
  ? '.site-header,.hero-bottom,.shell-swatches,.skip-link,.tour-rail,.stage-dialogue,.player-content,.scene-caption{display:none!important}.is-playing .scene-wrap{flex:1 1 auto!important}'
  : '.hero-bottom,.shell-swatches,.skip-link,.site-header nav{display:none!important}' });
if (PART !== 'cinematic') await page.clock.runFor(1500);
// scroll position of chapter k (the page's own formula, package-experience.tsx tourTop)
const stops = await page.evaluate(() => {
  const node = document.querySelector('.scene-journey'), sticky = node.querySelector('.scene-sticky').getBoundingClientRect(), rect = node.getBoundingClientRect();
  return [0, 1, 2, 3, 4, 5, 6].map(k => scrollY + rect.top + (rect.height - sticky.height) * k / 6);
});
const marks = []; let frame = 0;
async function shot() {
  ff.stdin.write(await page.screenshot({ type: 'png', timeout: 180000 }));
  await page.clock.runFor(DT); frame++;
}
const ease = t => t * t * (3 - 2 * t);
async function scrollTo(y) { await page.evaluate(y => window.scrollTo({ top: Math.round(y), behavior: 'instant' }), y); }
async function glide(from, to, sec) { const n = Math.round(sec * FPS); for (let i = 1; i <= n; i++) { await scrollTo(from + (to - from) * ease(i / n)); await shot(); } }
async function hold(sec) { for (let i = 0, n = Math.round(sec * FPS); i < n; i++) await shot(); }
const save = () => writeFileSync(`${out}/${tag}.json`, JSON.stringify({ url: URL, fps: FPS, width: +W, height: +H, frames: frame, marks }, null, 1));
const mark = name => { marks.push({ name, frame, t: +(frame / FPS).toFixed(3) }); console.log(name, frame); save(); };
if (PART === 'cinematic') {
  let last = '', done = 0;
  for (let i = 0; i < 40 * FPS; i++) {
    const st = await page.evaluate(() => `${document.documentElement.dataset.cinematic}|${document.documentElement.dataset.bootPhase}`);
    if (st !== last) { last = st; mark('state:' + st); }
    if (st === 'done|done' && ++done > (+(process.env.CINE_TAIL ?? 1.5)) * FPS) break;
    await shot();
  }
  const geo = await page.evaluate(() => { const c = document.querySelector('canvas.package-canvas'); const r = c.getBoundingClientRect();
    return { canvas: { x: r.x, y: r.y, width: r.width, height: r.height, renderWidth: c.width, renderHeight: c.height } }; });
  const avail = Math.min((geo.canvas.width - 24) / 160, (geo.canvas.height - 70) / 144), k = avail >= 2 ? Math.floor(avail) : Math.floor(avail * 2) / 2;
  geo.screen = { scale: k, width: 160 * k, height: 144 * k, x: geo.canvas.x + (geo.canvas.width - 160 * k) / 2, y: geo.canvas.y + (geo.canvas.height - 144 * k) / 2 };
  marks.push({ name: 'geometry', frame, ...geo }); console.log(JSON.stringify(geo));
}
else {
await scrollTo(stops[0]); await page.clock.runFor(800);
if (PART === 'opening') {
  const T = (k, v) => +(process.env[k] ?? v);
  mark('box'); await hold(T('HOLD_BOX', .4));
  mark('glide'); await glide(stops[0], stops[3], T('GLIDE', 4.0));          // the lid, the cartridge out and in, the power
  mark('power'); await hold(T('HOLD_POWER', .9));
  mark('play'); await page.evaluate(() => document.getElementById('package-play')?.click());
  await hold(T('PLAY', 4.5));                                               // the fly-down and the boot
  const geo = await page.evaluate(() => { const c = document.querySelector('canvas.package-canvas'); const r = c.getBoundingClientRect();
    return { canvas: { x: r.x, y: r.y, width: r.width, height: r.height, renderWidth: c.width, renderHeight: c.height } }; });
  const avail = Math.min((geo.canvas.width - 24) / 160, (geo.canvas.height - 70) / 144), k = avail >= 2 ? Math.floor(avail) : Math.floor(avail * 2) / 2;
  // play framing (package-geometry.ts handheldCamera/playCamera): the screen is centred in the canvas at k x 160x144
  geo.screen = { scale: k, width: 160 * k, height: 144 * k, x: geo.canvas.x + (geo.canvas.width - 160 * k) / 2, y: geo.canvas.y + (geo.canvas.height - 144 * k) / 2 };
  marks.push({ name: 'geometry', frame, ...geo }); console.log(JSON.stringify(geo));
}
else {
if (PART !== 'manual') {
mark('box'); await glide(stops[0], stops[0] + (stops[1] - stops[0]) * .4, 2.5);   // creep in; the lid stays shut (< 1/12)
mark('open'); await glide(stops[0] + (stops[1] - stops[0]) * .4, stops[1], 2.2); await hold(1.2);
mark('cartridge'); await glide(stops[1], stops[2], 2.2); await hold(1.0);
mark('power'); await glide(stops[2], stops[3], 2.2); await hold(2.0);
mark('play'); await glide(stops[3], stops[4], 2.0); await hold(1.2);
mark('back'); await glide(stops[4], stops[5], 2.0); await hold(1.0);
mark('combine'); await glide(stops[5], stops[6], 2.0); await hold(2.0);
}
if (PART !== 'tour') {
if (PART === 'manual') { await scrollTo(stops[1]); await page.clock.runFor(3000); }
mark('manual');
await page.evaluate(() => { history.pushState(null, '', '#manual'); window.dispatchEvent(new HashChangeEvent('hashchange')); });
await hold(3.0);
for (let k = 0; k < 4; k++) {
  mark('page' + (k + 1));
  await page.evaluate(() => document.querySelector('.manual-hud button[aria-label="Next page"]')?.click());
  await hold(1.6);
}
}
}
}
mark('end');
ff.stdin.end(); await new Promise(r => ff.on('close', r));
save();
await browser.close();
console.log('frames', frame);
