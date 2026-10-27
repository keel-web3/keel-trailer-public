"""The game's own music, recorded clean from the ROM (PyBoy, sound emulated, 48 kHz): the four mood scores of
crucible_music_data.h (0 workshop, 1 welcome, 2 reflection, 3 conversation; alchemy/src/music-scores.ts), each
played by the real sound driver (crucible_sound.c) on an idle free-play bench, with the score's pending mood held
in RAM (keel_music_t.pending) so the driver switches to it at the next phrase. Also records the cartridge's effects
alone (music level held at OFF): the mix, the fusion drone, the flash and a discovery fanfare, for hits and risers
(OUT/sfx.wav + the frame marks in OUT/sfx.json). Writes OUT/music-<mood>-<feel>.wav and OUT/music.json (loudness and brightness per mood).
Each mood is recorded in both feels: music-<mood>-bench.wav, music-<mood>-calm.wav.
Usage: python capture_music.py OUT [--seconds 80]"""
import argparse, io, json, importlib.util, wave, os
from pathlib import Path
import numpy as np
from pyboy import PyBoy

GAME = Path(os.environ.get('CRUCIBLE_GAME', './alchemy'))   # the game tree (ROM, symbols, catalogue)
p = argparse.ArgumentParser(); p.add_argument('out', type=Path); p.add_argument('--seconds', type=float, default=80)
p.add_argument('--rom', type=Path, default=GAME / 'chromatic/build/generative/crucible.gbc')
p.add_argument('--engine', type=Path, default=Path(os.environ.get('KEEL_ENGINE_ROOT', '../keel-engine')))
a = p.parse_args(); a.out.mkdir(parents=True, exist_ok=True)
spec = importlib.util.spec_from_file_location('cgb', a.engine / 'packages/targets/tools/cgb-profile.py')
keel = importlib.util.module_from_spec(spec); spec.loader.exec_module(keel)
sym = keel.RomSymbols(a.rom, a.rom.with_suffix('.noi'), a.rom.parent / 'obj'); S = sym.symbols
SCREEN = sym.pointer('crucible', '_crucible_run', '_screen')
try: SCORE = sym.pointer('crucible_sound', '_music_scene', '_score'); PENDING = SCORE + 5
except ValueError: SCORE = None   # a newer driver without the old four mood scores: only the effects are recorded   # keel_music_t: u16 seed, mood_offset; u8 active, pending
MUSIC_LEVEL = sym.pointer('crucible_sound', '_music_scene', '_music_level')   # 2 = music off (effects still play)
MOODS = ['workshop', 'welcome', 'reflection', 'conversation']
MOOD = sym.pointer('crucible_sound', '_music_scene', '_mood') if SCORE else None; STEP_LEN = sym.pointer('crucible_sound', '_music_scene', '_step_len') if SCORE else None
# tempo/feel: 'bench' is the driver's bench (18 frames a step, full envelopes, furnace crackle); 'calm' is its quiet
# screens (book, menus: 24 frames a step, soft envelopes, no crackle)
BENCH, MENU = 0, 5
FPS = 59.7275


def wav(path, snd):
    with wave.open(str(path), 'wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(48000); w.writeframes(snd.astype(np.int16).tobytes())


def retime(out):
    """PyBoy hands back ~801 samples a frame, not 48000 / 59.7275: re-time so frame f starts at exactly f / 59.7275 s"""
    raw = np.concatenate(out).astype(np.float64) * 256
    cum = np.r_[0, np.cumsum([len(o) for o in out])]; tf = np.arange(len(out) + 1) / FPS
    src = np.interp(np.arange(int(tf[-1] * 48000)) / 48000, tf, cum)
    return np.stack([np.interp(src, np.arange(len(raw)), raw[:, c]) for c in range(2)], 1)


def game():
    pb = PyBoy(str(a.rom), window='null', cgb=True, sound_emulated=True, sound_sample_rate=48000, ram_file=io.BytesIO(bytes(131072)), log_level='ERROR')
    pb.set_emulation_speed(0); return pb


def rd(pb, at): return pb.memory[(1, at) if 0xD000 <= at < 0xE000 else at]
def wr(pb, at, v): pb.memory[(1, at) if 0xD000 <= at < 0xE000 else at] = v


def to_bench(pb):
    step = lambda n: [pb.tick() for _ in range(n)]
    def pulse(b, after=6): pb.button_press(b); step(4); pb.button_release(b); step(after)
    for _ in range(6000):
        if rd(pb, SCREEN) == MENU: break
        pb.tick()
    step(240); pulse('a'); step(150); pulse('a'); step(60); pulse('down'); step(30); pulse('a')
    for _ in range(3000):
        if rd(pb, SCREEN) == BENCH: break
        pb.tick()
    step(200)
    return step, pulse


report = {}
for k, name in ([(k, n + '-' + feel) for feel in ('bench', 'calm') for k, n in enumerate(MOODS)] if SCORE else []):
    pb = game(); step, pulse = to_bench(pb)
    out = []
    for f in range(int((a.seconds + 6) * FPS)):
        wr(pb, PENDING, k)
        if name.endswith('calm'): wr(pb, MOOD, 2); wr(pb, STEP_LEN, 24)
        pb.tick(); out.append(pb.sound.ndarray.copy())
    snd = retime(out)
    snd = snd[int(6 * 48000):]   # drop the first phrase (the switch lands at a phrase boundary)
    mono = snd.mean(axis=1); spec_ = np.abs(np.fft.rfft(mono[:48000 * 30])); fr = np.fft.rfftfreq(len(mono[:48000 * 30]), 1 / 48000)
    report[name] = {'rmsDb': round(20 * np.log10(np.sqrt((mono ** 2).mean()) / 32768 + 1e-9), 1),
                    'centroidHz': round(float((spec_ * fr).sum() / spec_.sum()), 0), 'seconds': round(len(mono) / 48000, 1)}
    wav(a.out / f'music-{name}.wav', snd); pb.stop(save=False); print(name, report[name], flush=True)

# the effects alone: three first discoveries with the music held off
pb = game(); step, pulse = to_bench(pb); out, marks = [], []
def tick(n):
    for _ in range(n): wr(pb, MUSIC_LEVEL, 2); pb.tick(); out.append(pb.sound.ndarray.copy())
def press(b, after=20): pb.button_press(b); tick(4); pb.button_release(b); tick(after)
focus = lambda: rd(pb, S['_core'] + 0x1fc)
tick(60)
for x, y in ((2, 1), (0, 3), (2, 0)):   # FIRE+WATER, EARTH+AIR, FIRE+EARTH (ids from the catalogue)
    for t in (x, y):
        for _ in range(8):
            if focus() == t: break
            press('right', 30)
        press('a', 30)
    marks.append({'mix': len(out)})
    for _ in range(4000):
        tick(1)
        if rd(pb, SCREEN) == 2: marks[-1]['reveal'] = len(out); break
    tick(240); press('a', 120)
snd = retime(out); wav(a.out / 'sfx.wav', snd); pb.stop(save=False)
(a.out / 'sfx.json').write_text(json.dumps({'fps': FPS, 'marks': marks}, indent=1)); print('sfx', marks)
(a.out / 'music.json').write_text(json.dumps(report, indent=1))
