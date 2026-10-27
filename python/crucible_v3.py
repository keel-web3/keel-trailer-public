"""Reference compositor ported from the approved v3 prototype. No edit decisions live here."""
import json,math,subprocess
from pathlib import Path
import numpy as np
from PIL import Image,ImageDraw,ImageFont
# ---------------------------------------------------------------- palette (the site's and the logo's)
INK = np.array([34, 10, 46], np.uint8); PLUM = np.array([74, 24, 92], np.uint8); PINK = np.array([246, 166, 226], np.uint8)
PAPER = np.array([253, 240, 250], np.uint8); CYAN = np.array([60, 210, 246], np.uint8); MAGENTA = np.array([214, 56, 200], np.uint8)
BLUE = np.array([52, 92, 230], np.uint8)
BAYER8 = (np.array([[0, 32, 8, 40, 2, 34, 10, 42], [48, 16, 56, 24, 50, 18, 58, 26], [12, 44, 4, 36, 14, 46, 6, 38],
                    [60, 28, 52, 20, 62, 30, 54, 22], [3, 35, 11, 43, 1, 33, 9, 41], [51, 19, 59, 27, 49, 17, 57, 25],
                    [15, 47, 7, 39, 13, 45, 5, 37], [63, 31, 55, 23, 61, 29, 53, 21]]) + .5) / 64


def bayer(h, w, px, ox=0, oy=0):
    """the 8x8 ordered-dither threshold map at a block size of px screen pixels"""
    ys = ((np.arange(h) + oy) // px) % 8; xs = ((np.arange(w) + ox) // px) % 8
    return BAYER8[ys[:, None], xs[None, :]]


# ---------------------------------------------------------------- footage readers
def marks(name): return json.loads((a.cap / f'game/{name}.json').read_text())['marks']


def read_frames(path, w, h, start, count, rate):
    """count frames from frame index `start` (FFV1 is intra-only, so the seek is exact) as uint8 arrays"""
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-threads', '1', '-ss', f'{(start + .25) / rate:.6f}', '-i', str(path), '-frames:v', str(count),
                          '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, h, w, 3)


SITE = {}; SITEMARK = {}
def site_source(name):
    """(video, frame) of a tour mark: the tour capture, else the booklet's own capture (PART=manual)"""
    if name in SITEMARK: return a.cap / 'site/site-1920x1080.mkv', SITEMARK[name]
    m = json.loads((a.cap / 'site/site-1920x1080-manual.json').read_text())
    return a.cap / 'site/site-1920x1080-manual.mkv', {x['name']: x['frame'] for x in m['marks']}[name]
cache = {}


def source_map(s):
    dur=s['end']-s['start']; sp=s.get('speed',1)
    if 'ramp' in s:
        ks=[p['beat']*BEAT for p in s['ramp']];fs=[p['frame'] for p in s['ramp']]
        f0=min(fs);rel=[f-f0 for f in fs]
        return int(f0),lambda loc:int(round(np.interp(loc,ks,rel))),int(max(rel))+2
    f0=int(round(s.get('in',0)*GBFPS))
    return f0,lambda loc:int(loc*GBFPS*sp),int(dur*GBFPS*sp)+4


CUR = {'L': None}


def opening_meta():
    """the opening capture for the current aspect (site-WxH-opening.*), else the 16:9 one"""
    L = CUR['L']
    for w, h in ((L['W'], L['H']), (1920, 1080)):
        j = a.cap / f'site/site-{w}x{h}-opening.json'
        if j.exists():
            o = json.loads(j.read_text()); o['video'] = j.with_suffix('.mkv'); return o
    raise SystemExit('no opening capture: run PART=opening node capture_site.ts CAPTURES/site W H')


def draw_opening(L, s, local, tt):
    """the site's opening; over the match beats its screen is moved and scaled (nearest neighbour, about the screen)
    onto exactly the rectangle the game frame will occupy, so the cut into the game is pixel for pixel"""
    fr, fn = segment(s); f = fr[max(0, min(len(fr) - 1, fn(local)))]; o = opening_meta()
    geo = refined_geo(L, s, fr, fn)
    W, H = L['W'], L['H']
    if f.shape[:2] != (H, W):                         # a 16:9 capture standing in: centre it
        canvas = dither_bg(L, tt); y0 = max(0, (f.shape[0] - H) // 2); x0 = max(0, (f.shape[1] - W) // 2)
        crop = f[y0:y0 + H, x0:x0 + W]; canvas[(H - crop.shape[0]) // 2:(H - crop.shape[0]) // 2 + crop.shape[0], (W - crop.shape[1]) // 2:(W - crop.shape[1]) // 2 + crop.shape[1]] = crop
        f = canvas; geo = dict(geo, x=geo['x'] - x0 + (W - crop.shape[1]) // 2, y=geo['y'] - y0 + (H - crop.shape[0]) // 2)
    b0, b1 = s['match']; p = np.clip((local / BEAT - b0) / (b1 - b0), 0, 1); p = p * p * (3 - 2 * p)
    gx, gy = game_rect(L)
    sc = 1 + (L['gk'] / geo['scale'] - 1) * p
    sx, sy = geo['x'] + geo['width'] / 2, geo['y'] + geo['height'] / 2           # the site screen's centre
    tx, ty = sx + (gx + 80 * L['gk'] - sx) * p, sy + (gy + 72 * L['gk'] - sy) * p  # moving to the game frame's centre
    if p == 0: return f.copy()
    ys = np.clip(np.floor((np.arange(H) - ty) / sc + sy).astype(int), 0, f.shape[0] - 1)
    xs = np.clip(np.floor((np.arange(W) - tx) / sc + sx).astype(int), 0, f.shape[1] - 1)
    return f[ys[:, None], xs[None, :]]


GEO = {}


def refined_geo(L, s, fr, fn):
    """the site screen's rectangle in the take's last frame, found to the pixel: the next shot's game frame (the same
    clock ask the site's emulator shows) is matched against it at every whole scale 3..8 by FFT cross-correlation (the
    play framing differs by shape: centred at 6-7x when only the screen fits, the whole device at 4x on a phone)"""
    key = (L['W'], L['H'])
    if key in GEO: return GEO[key]
    o = opening_meta(); geo = dict(next(m for m in o['marks'] if m['name'] == 'geometry')['screen'])
    nxt = EDIT[EDIT.index(s) + 1]
    if nxt['kind'] == 'game' and fr.shape[1:3] == (L['H'], L['W']):
        site = fr[max(0, min(len(fr) - 1, fn(s['end'] - s['start'] - 1e-3)))].astype(np.float32).sum(2)
        f0, gfn, n = source_map(nxt); g = read_frames(a.cap / f"game/{nxt['clip']}.mkv", 160, 144, f0, 1, GBFPS)[0].astype(np.float32).sum(2)
        S = site - site.mean(); FS = np.fft.rfft2(S); best = None
        for k in range(3, 9):
            T = np.repeat(np.repeat(g, k, 0), k, 1)[72 * k:, 8 * k:152 * k]        # the lower half (text), not the sprites
            if T.shape[0] >= S.shape[0] or T.shape[1] >= S.shape[1]: continue
            Tm = T - T.mean(); pad = np.zeros_like(S); pad[:T.shape[0], :T.shape[1]] = Tm
            corr = np.fft.irfft2(FS * np.conj(np.fft.rfft2(pad)), s=S.shape)
            y, x = np.unravel_index(np.argmax(corr), corr.shape)
            win = site[y:y + T.shape[0], x:x + T.shape[1]]
            if win.shape != T.shape: continue
            err = float(np.abs(win - T).mean())
            if best is None or err < best[0]: best = (err, k, x - 8 * k, y - 72 * k)
        if best:
            geo.update(scale=best[1], width=160 * best[1], height=144 * best[1], x=int(best[2]), y=int(best[3]))
            print(f'  opening {key}: screen found at {best[1]}x, ({geo["x"]}, {geo["y"]}), match error {best[0]:.1f}')
    GEO[key] = geo; return geo


def game_rect(L):
    """top-left of the game frame in draw_game"""
    k = L['gk']; return L['W'] // 2 - 80 * k, game_cy(L) - 72 * k


def game_cy(L): return L['H'] // 2


def segment(s):
    """the shot's source frames (game: at 59.73 fps; site: at the capture's 30 fps)"""
    key = id(s)
    if key in cache: return cache[key]
    dur = s['end'] - s['start']
    if s['kind'] in ('game', 'pair'):
        f0, fn, n = source_map(s); clip = s.get('clip', 'link-host')
        fr = read_frames(a.cap / f'game/{clip}.mkv', 160, 144, f0, n, GBFPS)
        if s['kind'] == 'pair': fr = (fr, read_frames(a.cap / 'game/link-guest.mkv', 160, 144, f0, n, GBFPS))
        fr = (fr, fn)
    elif s['kind'] == 'opening':
        o = opening_meta(); mk = {m['name']: m['frame'] for m in o['marks']}
        ks=[p['beat']*BEAT for p in s['ramp']]; fs=[p['frame'] for p in s['ramp']]
        fr = (read_frames(o['video'], o['width'], o['height'], 0, max(fs) + 1, o['fps']), lambda loc: int(round(np.interp(loc, ks, fs))))
    elif s['kind'] == 'site':
        sp = s.get('speed', 1.0); video, f0 = s['_video'], int(round(s.get('in',0)*SITE['fps'])); n = int(dur * SITE['fps'] * sp) + 2
        fr = read_frames(video, 1920, 1080, f0, n, SITE['fps'])
    else: fr = None
    cache.clear(); cache[key] = fr; return fr


# ---------------------------------------------------------------- the pixel font
FONT = None


def text_mask(line):
    w = int(math.ceil(FONT.getlength(line))) + 2; im = Image.new('L', (max(w, 1), 10)); d = ImageDraw.Draw(im); d.fontmode = '1'
    d.text((0, 0), line, font=FONT, fill=255); return np.array(im) > 127


def up(mask, k): return np.repeat(np.repeat(mask, k, 0), k, 1)


def blit_text(img, line, x, y, k, color=PAPER, shadow=INK, chroma=False, upto=None):
    """draw a line at integer scale k; (x, y) top-left in screen pixels; upto = letters typed so far"""
    if upto is not None: line = line[:max(0, upto)]
    if not line: return 0
    m = up(text_mask(line), k); h, w = m.shape; H, W = img.shape[:2]
    def put(mm, dx, dy, c):
        y0, x0 = y + dy, x + dx; ys, xs = max(0, y0), max(0, x0); ye, xe = min(H, y0 + h), min(W, x0 + w)
        if ye <= ys or xe <= xs: return
        sub = mm[ys - y0:ye - y0, xs - x0:xe - x0]; img[ys:ye, xs:xe][sub] = c
    if shadow is not None: put(m, k, k, shadow)
    if chroma: put(m, -k, 0, CYAN); put(m, k, 0, MAGENTA)
    put(m, 0, 0, color); return w


def text_width(line, k): return (int(math.ceil(FONT.getlength(line))) + 2) * k


def wrap(line, k, width):
    words = line.split(); out = ['']
    for wd in words:
        trial = (out[-1] + ' ' + wd).strip()
        if text_width(trial, k) <= width or not out[-1]: out[-1] = trial
        else: out.append(wd)
    return out


# ---------------------------------------------------------------- layout per aspect
LAYOUT = {
    '16x9': dict(W=1920, H=1080, gk=7, card_k=8, cap_k=5, pair_k=5, site=(0, 0, 1920, 1080), endgk=5),
    '9x16': dict(W=1080, H=1920, gk=6, card_k=6, cap_k=5, pair_k=6, site=(420, 0, 1080, 1080), endgk=6),
    '1x1':  dict(W=1080, H=1080, gk=6, card_k=6, cap_k=4, pair_k=3, site=(420, 0, 1080, 1080), endgk=4),
}


BG_CACHE = {}


def dither_bg(L, tt, a_col=INK, b_col=PLUM, px=None, drift=True):
    """dark plum field: an ordered-dither glow behind the screen, in whole blocks; it drifts a block at a time"""
    W, H = L['W'], L['H']; px = px or L['gk']
    oy = (int(tt * 2) % 8) * px if drift else 0
    key = (W, H, px, oy, tuple(a_col), tuple(b_col))
    if key not in BG_CACHE: BG_CACHE[key] = _dither_bg(W, H, px, oy, a_col, b_col)
    return BG_CACHE[key].copy()


def _dither_bg(W, H, px, oy, a_col, b_col):
    th = bayer(H, W, px, 0, oy)
    yy = (np.arange(H)[:, None] // px * px) / H; xx = (np.arange(W)[None, :] // px * px) / W
    r = np.sqrt(((xx - .5) * W / H) ** 2 + (yy - .5) ** 2)
    glow = np.clip(1.0 - r * 1.6, 0, 1) * .55 + .08
    img = np.where((th < glow)[..., None], b_col, a_col).astype(np.uint8)
    fleck = (th < np.clip(.35 - r, 0, 1) * .25)
    img[fleck] = PINK; return img


def lcd(frame, k):
    """the Game Boy frame at integer scale k with an LCD grid (a darker last row and column in every pixel)"""
    big = np.repeat(np.repeat(frame, k, 0), k, 1).astype(np.uint16)
    row = np.ones(k, np.float32); row[-1] = .80; col = np.ones(k, np.float32); col[-1] = .90
    g = (np.tile(row, frame.shape[0])[:, None] * np.tile(col, frame.shape[1])[None, :] * 256).astype(np.uint16)
    return (big * g[..., None] >> 8).astype(np.uint8)


def place_screen(img, frame, k, cx, cy, bezel=True):
    s = lcd(frame, k); h, w = s.shape[:2]; x, y = cx - w // 2, cy - h // 2
    if bezel:
        b = k * 2; img[y - b:y + h + b, x - b:x + w + b] = INK; img[y - k:y + h + k, x - k:x + w + k] = PLUM
        img[y + h + b:y + h + b + k, x:x + w + b] = MAGENTA   # a hard drop edge, one pixel
    img[y:y + h, x:x + w] = s; return x, y, w, h


# ---------------------------------------------------------------- glitch vocabulary (integer pixels only)
def tear(img, rng, k, amount):
    H, W = img.shape[:2]; out = img.copy()
    for _ in range(int(3 + amount * 10)):
        h = int(rng.integers(1, 8)) * k * 2; y = int(rng.integers(0, max(1, H - h))) // k * k
        dx = int(rng.integers(-12, 13)) * k * max(1, int(amount * 3)); out[y:y + h] = np.roll(out[y:y + h], dx, axis=1)
    return out


def rgb_split(img, k, d=1):
    out = img.copy(); out[..., 0] = np.roll(img[..., 0], d * k, 1); out[..., 2] = np.roll(img[..., 2], -d * k, 1); return out


def scan_tear(img, tt, k, amp):
    H = img.shape[0]; out = img.copy(); ys = np.arange(0, H, k)
    shifts = (np.round(amp * np.sin(ys / (H / 7) + tt * 25) * (np.sin(ys / 13 + tt * 40) > .3)) * k).astype(int)
    for y, s in zip(ys, shifts):
        if s: out[y:y + k] = np.roll(img[y:y + k], s, axis=1)
    return out


def dither_mix(A, B, prog, px):
    th = bayer(A.shape[0], A.shape[1], px); return np.where((th < prog)[..., None], B, A)


# ---------------------------------------------------------------- shot drawing
def gb_frame(s, local):
    fr, fn = segment(s)
    if s.get('stutter'): local = local % (BEAT / 4)          # retrigger the first sixteenth: a stutter on the grid
    n = len(fr[0] if isinstance(fr, tuple) else fr); i = max(0, min(n - 1, fn(local)))
    return (fr[0][i], fr[1][i]) if isinstance(fr, tuple) else fr[i]


def draw_caption(img, L, line, local, k, y=None, plate=True):
    W, H = L['W'], L['H']; lines = wrap(line, k, W - 8 * k * 2); lh = 12 * k
    y = y if y is not None else (H - len(lines) * lh - 10 * k)
    typed = int(local * 34)
    if plate:
        top = y - 3 * k; bot = y + len(lines) * lh + k
        band = img[top:bot]; th = bayer(bot - top, W, k)
        img[top:bot] = np.where((th < .72)[..., None], INK, band)
    used = 0
    for i, ln in enumerate(lines):
        x = (W - text_width(ln, k)) // 2; blit_text(img, ln, x, y + i * lh, k, upto=typed - used); used += len(ln)


def draw_site(L, s, local):
    fr = segment(s); f = fr[min(len(fr) - 1, int(local * SITE['fps'] * s.get('speed', 1.0)))]
    x0, y0, w, h = L['site']; crop = f[y0:y0 + h, x0:x0 + w]
    if (w, h) == (L['W'], L['H']): img = crop.copy()
    else:
        img = dither_bg(L, local); yy = (L['H'] - h) // 2; img[yy:yy + h, :] = crop
    return img


def draw_game(L, s, local, tt):
    img = dither_bg(L, tt); k = L['gk']; W, H = L['W'], L['H']
    f = gb_frame(s, local)
    cy = game_cy(L)
    if s.get('shake') and local < .5: cy += int(np.sin(local * 60) * 3) * k
    place_screen(img, f, k, W // 2, cy); return img


def draw_pair(L, s, local, tt):
    img = dither_bg(L, tt); k = L['pair_k']; W, H = L['W'], L['H']; h0, g0 = gb_frame(s, local)
    gw, gh = 160 * k, 144 * k
    if W > H or L['W'] == L['H']:
        gap = (W - 2 * gw) // 3; cy = H // 2 + (6 * k if W > H else 0)
        place_screen(img, h0, k, gap + gw // 2, cy); place_screen(img, g0, k, W - gap - gw // 2, cy)
        cab_y = cy; x1, x2 = gap + gw + 2 * k, W - gap - gw - 2 * k
    else:
        gap = (H - 2 * gh) // 3; place_screen(img, h0, k, W // 2, gap + gh // 2); place_screen(img, g0, k, W // 2, H - gap - gh // 2)
        cab_y = None
    # the cable: a dashed line with a spark running along it, in whole pixels
    if cab_y is not None:
        y = cab_y - k; span = np.arange(x1, x2)
        dash = ((span // (k * 2)) % 2 == 0); img[y:y + k, span[dash]] = PINK
        sx = x1 + int(((local * 1.4) % 1) * (x2 - x1)) // k * k; img[y - k:y + 2 * k, sx:sx + 3 * k] = CYAN
    else:
        x = W // 2 - k // 2; ys = np.arange(gap + gh + 2 * k, H - gap - gh - 2 * k); dash = ((ys // (k * 2)) % 2 == 0)
        img[ys[dash], x:x + k] = PINK
        if len(ys): sy = ys[0] + int(((local * 1.4) % 1) * len(ys)) // k * k; img[sy:sy + 3 * k, x - k:x + 2 * k] = CYAN
    return img


def draw_card(L, lines, local, tt, k, flicker=True):
    img = dither_bg(L, tt, a_col=INK, b_col=np.array([44, 14, 58], np.uint8), px=k)
    W, H = L['W'], L['H']; rows = [r for ln in lines for r in wrap(ln, k, W - 12 * k)]; lh = 13 * k
    y = (H - len(rows) * lh) // 2; typed = int(local * 40); used = 0
    for i, r in enumerate(rows):
        x = (W - text_width(r, k)) // 2; blit_text(img, r, x, y + i * lh, k, chroma=True, upto=typed - used); used += len(r)
        if 0 <= typed - used + len(r) < len(r) and (int(local * 6) % 2 == 0):   # the cursor while typing
            cx = x + text_width(r[:max(0, typed - used + len(r))], k) - 2 * k; img[y + i * lh:y + i * lh + 8 * k, cx:cx + 5 * k] = PAPER
    return img


TITLE_FRAME = None


def draw_end(L, local, tt):
    """the end card: the cartridge's own title screen and the lines"""
    global TITLE_FRAME
    img = dither_bg(L, tt); W, H = L['W'], L['H']; k = L['endgk']
    if TITLE_FRAME is None:
        f0 = marks('title')['title'][0] + 60; TITLE_FRAME = read_frames(a.cap / 'game/title.mkv', 160, 144, f0, 400, GBFPS)
    f = TITLE_FRAME[min(len(TITLE_FRAME) - 1, int(local * GBFPS * .5))]
    big = REF['title']; lines = [REF['subtitle'], 'PLAY FREE AT', REF['url'], REF['handle']]
    if W > H:
        gx = 120 + 160 * k // 2 + 2 * k; place_screen(img, f, k, gx, H // 2)
        tx = 120 + 160 * k + 110; bk = 10; sk = 5; y = 300
        avail = W - tx - 60
        while text_width(big, bk) > avail: bk -= 1
        blit_text(img, big, tx, y, bk, chroma=True, upto=int(local * 24)); y += 14 * bk
        for i, ln in enumerate(lines):
            if local > .6 + i * .35:
                col = CYAN if 'ONKEEL' in ln else PAPER
                blit_text(img, ln, tx, y, sk, color=col, upto=int((local - .6 - i * .35) * 40)); y += (13 if i != 0 else 18) * sk
    else:
        bk = 9 if W == H else 10
        while text_width(big, bk) > W - 80: bk -= 1
        gy = (H * 0.30) if W < H else 330
        place_screen(img, f, k, W // 2, int(gy))
        y = int(gy) + 72 * k + 40 if W < H else int(gy) + 72 * k + 28
        blit_text(img, big, (W - text_width(big, bk)) // 2, y, bk, chroma=True, upto=int(local * 24)); y += 13 * bk
        sk = 5 if W < H else 4
        for i, ln in enumerate(lines):
            if local > .6 + i * .35:
                col = CYAN if 'ONKEEL' in ln else PAPER
                blit_text(img, ln, (W - text_width(ln, sk)) // 2, y, sk, color=col, upto=int((local - .6 - i * .35) * 40)); y += (12 if i != 0 else 16) * sk
    return img


def render(L, tt, rng):
    s = next(x for x in EDIT if x['start'] <= tt < x['end']) if tt < EDIT[-1]['end'] else EDIT[-1]
    local = tt - s['start']; k = L['gk']; CUR['L'] = L
    if PREV['shot'] is not s: PREV['shot'] = s; PREV['frozen'] = PREV['last']   # the outgoing shot's last frame
    if s['kind'] == 'cold':
        img = draw_card(L, s['lines'], max(0, local - BEAT * 1.5), tt, L['card_k'])
        if local < BEAT * 1.5 or rng.random() < .12: img = (img * .25).astype(np.uint8)    # a dead screen that flickers on
        if local > s['end'] - .3: img = tear(rgb_split(img, k, 2), rng, k, 1.0)
    elif s['kind'] == 'game': img = draw_game(L, s, local, tt)
    elif s['kind'] == 'pair': img = draw_pair(L, s, local, tt)
    elif s['kind'] == 'site': img = draw_site(L, s, local)
    elif s['kind'] == 'opening': img = draw_opening(L, s, local, tt)
    elif s['kind'] == 'card': img = draw_card(L, s['lines'], local, tt, L['card_k'])
    elif s['kind'] == 'end': img = draw_end(L, local, tt)
    if s.get('caption'):
        ck = L['cap_k']; cap_y = None
        if s['kind'] == 'site' and L['W'] < L['H']: cap_y = (L['H'] + 1080) // 2 + 60
        elif s['kind'] == 'site' and L['W'] == L['H']: cap_y = 1080 - 150
        elif s['kind'] == 'pair' and L['W'] > L['H']: cap_y = 60
        elif s['kind'] == 'pair': cap_y = 40 if L['W'] == L['H'] else L['H'] // 2 - 4 * ck
        draw_caption(L=L, img=img, line=s['caption'], local=local - .15, k=ck, y=cap_y, plate=s['kind'] == 'site')
    if L['W'] < L['H'] and s['kind'] in ('game',):   # the phone cut: the name under the screen
        wk = 7; nm = REF['title']; blit_text(img, nm, (L['W'] - text_width(nm, wk)) // 2, L['H'] - 330, wk, chroma=True)
        u = REF['url']; blit_text(img, u, (L['W'] - text_width(u, 4)) // 2, L['H'] - 330 + 13 * wk, 4, color=CYAN)
    # transitions at the head of the shot
    fx = s.get('fx'); n = local * FPS
    if fx == 'drop' and n < 10:                       # we fall through: the matched screen dissolves in ordered dither, torn
        if PREV['frozen'] is not None and n < 6: img = dither_mix(PREV['frozen'], img, (n + 1) / 7, k)
        img = tear(rgb_split(img, k, 3 if n < 3 else 1), rng, k, 2.0 - n * .18)
    elif fx == 'glitch-in' and n < 5: img = tear(rgb_split(img, k, 2 if n < 2 else 1), rng, k, 1.2 - n * .2)
    elif fx == 'tear' and n < 6: img = scan_tear(img, tt, k, 10 - n * 1.5)
    elif fx == 'dither-in' and n < 9 and PREV['frozen'] is not None: img = dither_mix(PREV['frozen'], img, (n + 1) / 10, k)
    elif fx == 'cut' and n < 1 and s['b'] <= 1: img = rgb_split(img, k, 1)
    # beat triggers inside the energetic shots: a one-pixel colour split on every beat, a tear on every downbeat
    if s.get('energy') and n >= 2:
        beat_t = (tt + 1e-6) / BEAT; ph = (beat_t % 1) * BEAT
        if ph < 1.5 / FPS:
            img = scan_tear(rgb_split(img, k, 1), tt, k, 4) if round(beat_t - beat_t % 1) % 4 == 0 else rgb_split(img, k, 1)
    if s is EDIT[-1] and tt > s['end'] - .5: img = (img * max(0, (s['end'] - tt) / .5)).astype(np.uint8)   # the last half second to black
    if tt >= EDIT[-1]['end']: img = np.zeros_like(img)
    PREV['last'] = img
    return img


PREV = {'shot': None, 'last': None, 'frozen': None}


def configure(timeline,target=None):
    global a,EDIT,BEAT,FPS,GBFPS,FONT,SITE,SITEMARK,REF,TITLE_FRAME
    from types import SimpleNamespace
    REF=timeline['reference'];a=SimpleNamespace(cap=Path(REF['capturesRoot']),font=Path(REF['font']))
    BEAT=timeline['tempo'].get('beatSeconds',60/timeline['tempo']['bpm']);FPS=timeline['fps'];GBFPS=59.7275
    FONT=ImageFont.truetype(str(a.font),8)
    SITE=json.loads((a.cap/'site/site-1920x1080.json').read_text());SITEMARK={m['name']:m['frame'] for m in SITE['marks']}
    EDIT=[]
    for shot in timeline['shots']:
        s=dict(shot)
        variant=next((v for v in shot.get('rampVariants',[]) if v['target']==target),None)
        if variant:s['ramp']=variant['ramp']
        s['b']=s['beats'];s['start']=s['startBeat']*BEAT;s['end']=(s['startBeat']+s['beats'])*BEAT
        s['kind']={'video':'game' if shot.get('source') not in ('tour','manual') else 'site'}.get(shot['kind'],shot['kind'])
        s['clip']=shot.get('source','link-host')
        s['fx']=shot.get('transition',{}).get('referenceEffect','cut')
        if s['kind']=='opening':s['match']=(shot['transition']['zoomStartBeat'],shot['beats'])
        if s['kind']=='card':s['lines']=shot['text']['lines']
        if 'caption' in s:s['caption']=s['caption']['lines'][0]
        if s['kind']=='site':s['_video']=Path(next(x['path'] for x in timeline['sources'] if x['id']==shot['source']))
        EDIT.append(s)
    TITLE_FRAME=None;cache.clear();GEO.clear();BG_CACHE.clear();PREV.update(shot=None,last=None,frozen=None)
