"""Game footage for the trailer: the real ROM in headless PyBoy (CGB, sound emulated at 48 kHz, isolated blank saves).
Every clip is lossless video at the Game Boy's own rate (160x144, 59.7275 fps, FFV1) plus its own audio (WAV), and a
marks file (frame numbers of the moments the editor cuts on). Nothing is upscaled here.

Clips (--clips picks some):
  title    power-on: the clock ask (WHAT TIME IS IT?), the title card
  reveals  free play: a run of combinations, new objects turning into colour on the reveal; a known mix; then the
           filter grid (SELECT) as its own clip 'filter'
  rooms    66+ discoveries made off camera, then the living rooms: browsing as the room changes colour
  combines full combines in the living rooms (the cursor, A A, the merge and fusion, the turn, the flash, the reveal)
  talk     a story run: a visitor steps in (the telegraph, the pan up, the face typing)
  fight    a story run: a champion comes (!! IT COMES !!), the pan down, the fight
  link     two Game Boys on a cable (linkbridge): the link room, FIGHT rules, a bout side by side (host and guest clips)
Usage: python capture_game.py OUTDIR [--clips title,reveals,...] [--rom ROM] [--engine ENGINE] [--catalogue DIR]"""
import argparse, io, json, importlib.util, subprocess, sys, wave, os
from pathlib import Path
import numpy as np
from pyboy import PyBoy

GAME = Path(os.environ.get('CRUCIBLE_GAME', './alchemy'))   # the game tree (ROM, symbols, catalogue)
p = argparse.ArgumentParser(); p.add_argument('out', type=Path)
p.add_argument('--clips', default='title,reveals,rooms,combines,talk,fight,link')
p.add_argument('--rom', type=Path, default=GAME / 'chromatic/build/generative/crucible.gbc')
p.add_argument('--engine', type=Path, default=Path(os.environ.get('KEEL_ENGINE_ROOT', '../keel-engine')))
p.add_argument('--catalogue', type=Path, default=GAME / 'build/gbc-catalogue')
p.add_argument('--bench', type=Path, default=GAME / 'tools/bench', help='linkbridge.py lives here')
a = p.parse_args(); a.out.mkdir(parents=True, exist_ok=True)
spec = importlib.util.spec_from_file_location('cgb', a.engine / 'packages/targets/tools/cgb-profile.py')
keel = importlib.util.module_from_spec(spec); spec.loader.exec_module(keel)
sym = keel.RomSymbols(a.rom, a.rom.with_suffix('.noi'), a.rom.parent / 'obj'); S = sym.symbols
SCREEN = sym.pointer('crucible', '_crucible_run', '_screen'); CORE = S['_core']
BENCH, MERGE, REVEAL, BOOK, RECORDS, MENU, FILTER, TALK, FIGHT, LINKEND = range(10)
NAMES = 'BENCH MERGE REVEAL BOOK RECORDS MENU FILTER TALK FIGHT LINKEND'.split()
FPS = 59.7275
cat = json.loads((a.catalogue / 'concepts.json').read_text()); recipes = json.loads((a.catalogue / 'recipes.json').read_text())
idx = {c['concept']: c['id'] for c in cat}; ORDER = ['element', 'matter', 'weather', 'energy', 'life', 'craft', 'place']
catof = {c['id']: ORDER.index(c['category']) for c in cat}; NAME = {c['id']: c['concept'] for c in cat}
RECIPES = [(idx[x], idx[y], idx[r]) for x, y, r in recipes]


class Mem:
    """WRAM 0xD000..0xDFFF always read in bank 1 (the cartridge's state lives there)"""
    def __init__(self, m): self.m = m
    def _k(self, k): return (1, k) if isinstance(k, int) and 0xD000 <= k < 0xE000 else k
    def __getitem__(self, k): return self.m[self._k(k)]
    def __setitem__(self, k, v): self.m[self._k(k)] = v


class Clip:
    """one lossless video + WAV pair; frames and sound written together so they stay in sync"""
    def __init__(self, name):
        self.name = name; self.frames = 0; self.audio = []; self.marks = {}
        self.ff = subprocess.Popen(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '160x144',
                                    '-r', str(FPS), '-i', '-', '-c:v', 'ffv1', str(a.out / f'{name}.mkv')], stdin=subprocess.PIPE)
    def add(self, pb, sound=True):
        self.ff.stdin.write(np.ascontiguousarray(pb.screen.ndarray[:, :, :3]).tobytes()); self.frames += 1
        if sound: self.audio.append(pb.sound.ndarray.copy())
    def mark(self, name): self.marks.setdefault(name, []).append(self.frames); print(f'  {self.name}: {name} @ {self.frames}', flush=True)
    def close(self):
        self.ff.stdin.close(); self.ff.wait()
        if self.audio:
            raw = np.concatenate(self.audio).astype(np.float64) * 256   # re-timed: frame f starts at f / 59.7275 s
            cum = np.r_[0, np.cumsum([len(o) for o in self.audio])]; tf = np.arange(len(self.audio) + 1) / FPS
            src = np.interp(np.arange(int(tf[-1] * 48000)) / 48000, tf, cum)
            snd = np.stack([np.interp(src, np.arange(len(raw)), raw[:, c]) for c in range(2)], 1).round().astype(np.int16)
            with wave.open(str(a.out / f'{self.name}.wav'), 'wb') as w:
                w.setnchannels(2); w.setsampwidth(2); w.setframerate(48000); w.writeframes(snd.tobytes())
        (a.out / f'{self.name}.json').write_text(json.dumps({'fps': FPS, 'frames': self.frames, 'marks': self.marks}, indent=1))
        print(f'clip {self.name}: {self.frames} frames ({self.frames / FPS:.1f} s)', flush=True)


class Game:
    def __init__(self, ram=None):
        self.pb = PyBoy(str(a.rom), window='null', cgb=True, sound_emulated=True, sound_sample_rate=48000,
                        ram_file=io.BytesIO(ram or bytes(131072)), log_level='ERROR')
        self.pb.set_emulation_speed(0); self.m = Mem(self.pb.memory); self.clip = None
    def step(self, n=1):
        for _ in range(n):
            self.pb.tick()
            if self.clip: self.clip.add(self.pb)
    def pulse(self, b, after=6, hold=4): self.pb.button_press(b); self.step(hold); self.pb.button_release(b); self.step(after)
    def until(self, pred, limit=3000):
        for _ in range(limit):
            if pred(): return True
            self.step(1)
        return pred()
    def record(self, name): self.clip = Clip(name); return self.clip
    def cut(self):
        if self.clip: self.clip.close(); self.clip = None
    @property
    def screen(self): return self.m[SCREEN]
    def w16(self, at): return self.m[at] | self.m[at + 1] << 8
    def focus(self): return self.w16(CORE + 0x1fc)
    def slot_a(self): return self.w16(CORE + 0x1fe)
    def scy(self): return self.m[0xFF42]
    def boot(self, wait=240):
        self.until(lambda: self.screen == MENU, 6000); self.step(wait); self.step(150)   # the title card asks nothing
    def free_play(self):
        self.pulse('a'); self.step(60); self.pulse('down'); self.step(30); self.pulse('a'); self.step(30)
        for _ in range(12):   # a fresh cartridge's first game start: the date and time, then the birthday (A keeps them); the sign loader
            if self.screen == BENCH: break
            self.pulse('a'); self.step(40)
        return self.until(lambda: self.screen == BENCH, 3000)
    def story(self):
        self.pulse('a'); self.step(60); self.pulse('a'); self.step(60); self.pulse('a'); self.step(60)
        for k in range(300):
            if self.screen == BENCH: return True
            self.pulse('start' if k % 5 == 4 else 'a', 40)
        return False
    def settle(self, limit=400):
        for _ in range(limit):
            s = self.screen
            if s == BENCH and self.scy() == 0: return 'bench'
            if s == MENU: return 'menu'
            if s in (REVEAL, TALK, FIGHT, LINKEND): self.pulse('a', 30)
            else: self.step(10)
        return NAMES[self.screen]
    # the shelf (sorted by category, then id) and walking it
    def right(self):
        was = self.focus(); self.pulse('right', 2); self.until(lambda: self.focus() != was, 120); return self.focus()
    def goto(self, t, n, dwell=0):
        for _ in range(n + 2):
            if self.focus() == t: return True
            self.right(); self.step(dwell)
        return self.focus() == t
    def mix(self, owned, prefer=None, dwell=0, linger=150):
        """make something new from what is owned; prefer a result whose category is not in `prefer` (colour variety)"""
        todo = [(x, y, r) for x, y, r in RECIPES if x in owned and y in owned and r not in owned]
        if not todo: return None
        todo.sort(key=lambda t: (prefer is not None and catof[t[2]] in prefer, t[2]))
        x, y, r = todo[0]
        if self.slot_a() != 0xffff: self.pulse('b', 20)
        if not self.goto(x, len(owned), dwell): return 'lost'
        self.pulse('a', 20 + dwell)
        if x == y: self.pulse('a')
        else:
            if not self.goto(y, len(owned), dwell): self.pulse('b', 30); return 'lost'
            self.pulse('a')
        if not self.until(lambda: self.screen != BENCH, 240): self.pulse('b', 30); return 'stuck'
        if self.clip: self.clip.mark('merge')
        self.until(lambda: self.screen in (REVEAL, BENCH, TALK, MENU), 4000)
        if self.clip and self.screen == REVEAL: self.clip.mark('reveal')
        self.step(linger)
        return r
    def stop(self): self.cut(); self.pb.stop(save=False)


def clip_title():
    g = Game(); c = g.record('title')
    g.until(lambda: g.screen == MENU, 6000); c.mark('ask'); g.step(330)
    g.pulse('up', 30); g.pulse('up', 60); c.mark('answer'); g.pulse('a'); g.step(30); c.mark('title'); g.step(420)
    g.stop()


def clip_reveals():
    g = Game(); g.boot(); g.free_play(); g.step(300)
    owned = {0, 1, 2, 3}; shown = set()
    c = g.record('reveals')
    for n in range(12):
        c.mark('mix')
        r = g.mix(owned, shown, dwell=8, linger=200)
        if not isinstance(r, int): continue
        owned.add(r); shown.add(catof[r]); g.settle(); g.step(30)
    # a known combination again: the bench glitches it away
    x, y, r = next((x, y, r) for x, y, r in RECIPES if x in owned and y in owned and r in owned and x != y)
    c.mark('known'); g.goto(x, len(owned), 8); g.pulse('a', 30); g.goto(y, len(owned), 8); g.pulse('a', 4); c.mark('known-mix'); g.step(240)
    g.cut()
    # the filter grid
    g.settle(); c = g.record('filter'); g.step(30)
    c.mark('open'); g.pulse('select', 60); g.until(lambda: g.screen == FILTER, 300); g.step(40)
    for b in ('down', 'down', 'down', 'right', 'down', 'down', 'up', 'left'): g.pulse(b, 24)
    c.mark('pick'); g.pulse('a', 30); g.until(lambda: g.screen == BENCH, 300); g.step(150)
    c.mark('clear'); g.pulse('b', 90)
    g.cut()
    g.stop()


def clip_rooms():
    """66+ discoveries made off camera (the rooms unlock at 64), then the living rooms changing colour"""
    g = Game(); g.boot(); g.free_play(); g.step(300)
    owned = {0, 1, 2, 3}; shown = set()
    for n in range(300):
        if len(owned) >= 72: break
        r = g.mix(owned, shown, linger=30)
        if r is None: break
        if isinstance(r, int): owned.add(r); shown.add(catof[r])
        if g.settle() == 'menu': g.free_play()
        g.step(20)
        if n % 10 == 0: print(f'  owned {len(owned)}', flush=True)
    g.settle(); g.step(300); c = g.record('rooms')
    for k in range(40):
        if k % 8 == 0: c.mark('turn')
        g.pulse('down' if k % 8 == 7 else 'right', 2); g.step(36)
    for k in range(3):
        c.mark('mix'); r = g.mix(owned, None, dwell=6, linger=200)
        if isinstance(r, int): owned.add(r)
        g.settle(); g.step(40)
    g.stop()


def clip_combines():
    """full combines for the montage, in the living rooms (72+ discoveries made off camera): the cursor walks to two
    things, A, A, the merge (they slide together and fuse), the result turns into its colours, the flash, the reveal.
    Results are picked across categories (weather, life, energy, place, craft...), always from two different things.
    Marks per combine: walk (the cursor starts), pick (the first A), merge (the screen leaves the bench), flash (the
    white frame before the reveal), reveal; 'results' lists what was made."""
    g = Game(); g.boot(); g.free_play(); g.step(300)
    owned = {0, 1, 2, 3}; shown = set()
    for n in range(300):
        if len(owned) >= 72: break
        r = g.mix(owned, shown, linger=30)
        if r is None: break
        if isinstance(r, int): owned.add(r); shown.add(catof[r])
        if g.settle() == 'menu': g.free_play()
        g.step(20)
    g.settle(); g.step(200)
    want = ['weather', 'life', 'energy', 'place', 'craft', 'weather', 'life', 'matter', 'energy', 'place']
    c = g.record('combines'); results = []
    shelf = lambda: sorted(owned, key=lambda i: (catof[i], i))
    for cat_name in want:
        if g.settle() != 'bench': break
        g.step(10)
        if g.m[S['_flow_force']] or g.m[S['_flow_hint']]: g.step(30)
        todo = [(x, y, r) for x, y, r in RECIPES if x in owned and y in owned and r not in owned and x != y and ORDER[catof[r]] == cat_name]
        if not todo: todo = [(x, y, r) for x, y, r in RECIPES if x in owned and y in owned and r not in owned and x != y]
        if not todo: break
        sh = shelf(); pos = lambda i: sh.index(i)
        todo.sort(key=lambda t: (pos(t[0]) - pos(g.focus())) % len(sh) + (pos(t[1]) - pos(t[0])) % len(sh))
        x, y, r = todo[0]
        if g.slot_a() != 0xffff: g.pulse('b', 20)
        c.mark('walk')
        if not g.goto(x, len(owned), 6): continue
        c.mark('pick'); g.pulse('a', 24)
        if not g.goto(y, len(owned), 6): g.pulse('b', 30); continue
        g.pulse('a', 0)
        if not g.until(lambda: g.screen != BENCH, 240): g.pulse('b', 30); continue
        c.mark('merge')
        last = None
        for _ in range(4000):
            if g.screen in (REVEAL, BENCH, TALK, MENU): break
            fr = g.pb.screen.ndarray[:, :, :3]
            if fr.mean() > 245 and last is None: last = c.frames; c.mark('flash')
            g.step(1)
        if g.screen == REVEAL: c.mark('reveal'); results.append({'made': NAME[r], 'category': ORDER[catof[r]], 'from': [NAME[x], NAME[y]]})
        else: c.marks.setdefault('flash', []).append(c.frames); c.mark('reveal'); results.append({'made': NAME[r], 'category': ORDER[catof[r]], 'from': [NAME[x], NAME[y]], 'note': 'no reveal'})
        g.step(240); owned.add(r); g.settle(); g.step(30)
    c.marks['results'] = results
    g.stop()


def encounter_clip(name, kind, arg):
    g = Game(); g.boot(); ok = g.story()
    if not ok: print('never reached the story bench'); g.stop(); return
    g.step(600)
    c = g.record(name); g.step(60)
    c.mark('telegraph'); g.m[S['_flow_arg']] = arg; g.m[S['_flow_force']] = kind
    g.until(lambda: g.scy() != 0, 400); c.mark('pan')
    g.until(lambda: g.screen in (TALK, FIGHT), 600); c.mark('scene')
    if g.screen == FIGHT:
        g.step(240)
        for i in range(8):
            if g.screen != FIGHT: break
            c.mark('turn'); g.pulse('right' if i % 2 else 'a', 8); g.step(150)
    else:
        g.step(200)
        for i in range(10):
            if g.screen != TALK: break
            c.mark('line'); g.pulse('a', 4); g.step(150)
    c.mark('end'); g.step(120)
    g.stop()


def clip_talk(): encounter_clip('talk', 1, 0)
def clip_fight(): encounter_clip('fight', 2, 0x81)


def clip_link():
    """two Game Boys on linkbridge.py's cable (the bridge's own Side/Cable; PyBoy is wrapped so the host's sound is on):
    the link room, FIGHT rules, a bout side by side. Follows capture-link.py (lobby: HOST/JOIN then the save to bring)."""
    sys.path.insert(0, str(a.bench))
    import linkbridge
    real = linkbridge.PyBoy
    linkbridge.PyBoy = lambda *x, **k: real(*x, **{**k, 'sound_emulated': True, 'sound_sample_rate': 48000})
    hooks = linkbridge.link_hooks(sym)
    H, G = linkbridge.Side(a.rom, 'host', hooks), linkbridge.Side(a.rom, 'guest', hooks); c = linkbridge.Cable(H, G)
    clips = [None]
    step0 = c.step
    def step(n=1):
        for _ in range(n):
            step0(1)
            if clips[0]: clips[0][0].add(H.pb); clips[0][1].add(G.pb, sound=False)
            else: H.pb.sound.ndarray; G.pb.sound.ndarray
    c.step = step
    scr = lambda s: s.m[SCREEN]; gv = lambda s, n: s.m[S[n]]
    FR = S['_fr'] & 0xFFFF if '_fr' in S else None
    def until(pred, limit=3000):
        for _ in range(limit):
            if pred(): return True
            c.step(1)
        return pred()
    until(lambda: scr(H) == MENU and scr(G) == MENU, 6000); c.step(240)
    for s in (H, G): c.press(s, 'a')
    c.step(120)
    for s in (H, G): c.press(s, 'a', 30); c.press(s, 'down', 10); c.press(s, 'a', 30)   # free play: a few things each
    until(lambda: scr(H) == BENCH and scr(G) == BENCH, 1500); c.step(300)
    for s in (H, G):
        have = {0, 1, 2, 3}
        for _ in range(4 if s is H else 3):
            x, y, r = sorted((x, y, r) for x, y, r in RECIPES if x in have and y in have and r not in have)[0]
            def go(t):
                for _ in range(len(have) + 2):
                    if s.m[CORE + 0x1fc] | s.m[CORE + 0x1fd] << 8 == t: return
                    c.press(s, 'right', 30)
            go(x); c.press(s, 'a', 20)
            if x != y: go(y)
            c.press(s, 'a'); until(lambda: scr(s) in (MERGE, REVEAL), 300); until(lambda: scr(s) in (REVEAL, BENCH), 4000); c.step(60)
            for _ in range(40):
                if scr(s) == BENCH and s.m[0xFF42] == 0: break
                c.press(s, 'a', 30) if scr(s) in (REVEAL, TALK) else c.step(10)
            have.add(r)
    for s in (H, G):
        c.press(s, 'start', 30); until(lambda: scr(s) == MENU, 300)
        for b in ('down', 'down', 'right'): c.press(s, b, 10)
        c.press(s, 'a', 120)
    hc, gc = Clip('link-host'), Clip('link-guest'); clips[0] = (hc, gc)
    for s in (H, G): c.press(s, 'a', 30)                                              # PLAY
    for s in (H, G): c.press(s, 'down', 14); c.press(s, 'down', 14); c.press(s, 'a', 30)   # LINK
    c.press(G, 'down', 10); c.press(H, 'a', 30); c.press(G, 'a', 30)                  # HOST / JOIN
    c.press(H, 'a', 30); c.press(G, 'a', 30); hc.mark('lobby')                        # the save to bring: FREE PLAY
    until(lambda: gv(H, '_link_linked') and gv(G, '_link_linked'), 600); hc.mark('linked'); c.step(200)
    while gv(H, '_link_mode') != 2: c.press(H, 'a', 30)
    for _ in range(4): c.press(H, 'down', 10)
    c.step(90); hc.mark('go'); c.press(H, 'a', 30)
    until(lambda: scr(H) == FIGHT and scr(G) == FIGHT, 900); hc.mark('bout'); c.step(120)
    for t in range(10):
        if FR is not None and not until(lambda: (gv(H, '_fight_ui') == 1 and gv(G, '_fight_ui') == 1) or scr(H) != FIGHT, 3000): break
        if scr(H) != FIGHT or scr(G) != FIGHT: break
        t0 = H.m[FR + 324] if FR is not None else 0
        for k in range(t % 3): c.press(H, 'right', 14)
        for k in range((t + 1) % 3): c.press(G, 'right', 14)
        hc.mark('lock'); c.press(H, 'a', 12); c.press(G, 'a', 12)
        until(lambda: (FR is not None and H.m[FR + 324] != t0) or scr(H) != FIGHT, 2400); hc.mark('clash'); c.step(150)
        for s_ in (H, G):
            if scr(s_) == FIGHT and '_fight_ui' in S and gv(s_, '_fight_ui') in (3, 4): c.press(s_, 'a', 10)
        c.step(30)
    until(lambda: scr(H) == LINKEND and scr(G) == LINKEND, 1500); hc.mark('end'); c.step(240)
    hc.close(); gc.close()
    for s in (H, G): s.pb.stop(save=False)


for name in a.clips.split(','):
    print('==', name, flush=True); globals()['clip_' + name]()
