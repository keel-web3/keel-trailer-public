"""A trailer-only music bed played on the Game Boy's own sound hardware: the ROM runs in PyBoy (CGB, sound emulated,
48 kHz) with its music and effects held off, and this sequencer writes the APU registers once a frame, using the
cartridge's own material: its note table (crucible_sound.c notes[], C3..B6), its wave-channel pad (loaded into wave
RAM by sound_init), its Dorian scale and its noise settings (mix 0x45, bubble 0x2b, flash 0x61). Original, ~128 BPM:
a sixteenth is exactly 7 frames, a beat 28 (127.99 BPM), so every hit lands on a frame boundary.

The arrangement follows the trailer's sections, in bars of four beats (build_trailer.py's EDIT): intro drone, a light
groove under the site's opening, a roll and riser while the camera falls into the handheld's screen, the drop on
beat 16 (the tear into the game), full groove under the combines, a breakdown riser before the boss, the drop, the end
stab. Writes OUT.wav and OUT.json (bpm, beat seconds, first downbeat at 0, bar count, the sections).
Usage: python make_bed.py OUT.wav"""
import io, json, sys, wave, importlib.util, os
from pathlib import Path
import numpy as np
from pyboy import PyBoy

# the host ROM (its driver is held silent; only the hardware is played). Pinned to the ROM the owner approved the bed on.
GAME = Path(os.environ.get('BED_GAME', './alchemy'))
ROM = GAME / 'chromatic/build/generative/crucible.gbc'
ENGINE = Path(os.environ.get('KEEL_ENGINE_ROOT', '../keel-engine'))
OUT = Path(sys.argv[1])
FPS = 59.7275; STEP = 7                 # frames per sixteenth
spec = importlib.util.spec_from_file_location('cgb', ENGINE / 'packages/targets/tools/cgb-profile.py')
keel = importlib.util.module_from_spec(spec); spec.loader.exec_module(keel)
sym = keel.RomSymbols(ROM, ROM.with_suffix('.noi'), ROM.parent / 'obj')
MUSIC_LEVEL = sym.pointer('crucible_sound', '_music_scene', '_music_level')
SFX_OFF = sym.pointer('crucible_sound', '_sound_play', '_sfx_off')
SCREEN = sym.pointer('crucible', '_crucible_run', '_screen')

# the cartridge's note table: C3..B6 as GB frequency registers (the wave channel sounds an octave lower)
NOTES = [1046, 1102, 1155, 1205, 1253, 1297, 1339, 1379, 1417, 1452, 1486, 1517, 1547, 1575, 1602, 1627, 1650, 1673, 1694,
         1714, 1732, 1750, 1767, 1783, 1798, 1812, 1825, 1837, 1849, 1860, 1871, 1881, 1890, 1899, 1907, 1915, 1923, 1930,
         1936, 1943, 1949, 1954, 1959, 1964, 1969, 1974, 1978, 1982]
C, D, E, F, G, A, B = 0, 2, 4, 5, 7, 9, 11
# D Dorian: Dm  F  C  G (the natural sixth, B, in G major keeps it warm; the minor third keeps it strange)
CHORDS = [(D, F, A), (F, A, C + 12), (C, E, G), (G, B, D + 12)]
BASS = [D, F, C, G]

pb = PyBoy(str(ROM), window='null', cgb=True, sound_emulated=True, sound_sample_rate=48000, ram_file=io.BytesIO(bytes(131072)), log_level='ERROR')
pb.set_emulation_speed(0); mem = pb.memory
def w(at, v): mem[(1, at) if 0xD000 <= at < 0xE000 else at] = v
def r(at): return mem[(1, at) if 0xD000 <= at < 0xE000 else at]
for _ in range(6000):                     # boot to the title card: sound_init has loaded the pad into wave RAM
    pb.tick()
    if r(SCREEN) == 5: break
for _ in range(240): w(MUSIC_LEVEL, 2); w(SFX_OFF, 1); pb.tick()
w(0xFF24, 0x77); w(0xFF25, 0xFF)          # master volume, every channel to both sides
PAD = [0x9b, 0xcd, 0xef, 0xff, 0xfe, 0xdc, 0xba, 0x98, 0x65, 0x43, 0x21, 0x00, 0x01, 0x23, 0x45, 0x67]   # crucible_sound.c pad[]
w(0xFF1A, 0)
for i, v in enumerate(PAD): w(0xFF30 + i, v)                                                         # the bass's wave, explicitly
for reg in (0xFF12, 0xFF17, 0xFF21): w(reg, 0)
w(0xFF1C, 0)

events = {}
def at(step, fn, *args, d=0): events.setdefault(step * STEP + d, []).append((fn, args))
def hz(n): return NOTES[max(0, min(47, n))]
def kick(heavy=False):
    w(0xFF10, 0x1A if not heavy else 0x1B); w(0xFF11, 0x80); w(0xFF12, 0xF2 if heavy else 0xD1); f = 1792 if not heavy else 1840
    w(0xFF13, f & 255); w(0xFF14, 0x80 | f >> 8)
def stab(n, env=0xA4, duty=2):
    w(0xFF10, 0); w(0xFF11, duty << 6); w(0xFF12, env); f = hz(n); w(0xFF13, f & 255); w(0xFF14, 0x80 | f >> 8)
def lead(n, env=0x82, duty=1):
    w(0xFF16, duty << 6); w(0xFF17, env); f = hz(n); w(0xFF18, f & 255); w(0xFF19, 0x80 | f >> 8)
def noise(nr43, env, length=0):
    w(0xFF20, length); w(0xFF21, env); w(0xFF22, nr43); w(0xFF23, 0x80 | (0x40 if length else 0))
def hat(): noise(0x2B, 0x51, 0x38)
def ohat(): noise(0x10, 0x73)
def snare(): noise(0x51, 0xD2)
def clap(): noise(0x61, 0xF3)             # the flash's noise, louder
def bass(n, level=0x20, length=0):
    w(0xFF1A, 0x80); w(0xFF1C, level); f = hz(n); w(0xFF1B, length); w(0xFF1D, f & 255); w(0xFF1E, 0x80 | (0x40 if length else 0) | f >> 8)
def bass_off(): w(0xFF1C, 0)
def riser(k): noise(max(0x10, 0x77 - k * 7), 0x90 + min(k // 2, 6) * 0x10 & 0xF0 | 0x0)

# ---------------------------------------------------------------- the arrangement (bar k = steps 16k..16k+15)
SECTIONS = {'intro': (0, 1), 'site': (1, 3), 'build': (3, 4), 'groove1': (4, 8), 'groove2': (8, 11), 'groove3': (11, 13),
            'link': (13, 14), 'breakdown': (14, 15), 'drop': (15, 16), 'end': (16, 18), 'tail': (18, 19)}
BARS = 19
def sec(bar): return next(k for k, (a, b) in SECTIONS.items() if a <= bar < b)
for bar in range(BARS):
    s = sec(bar); b0 = bar * 16; ch = bar % 4; root = BASS[ch]; tri = CHORDS[ch]
    if s == 'intro':
        at(b0, bass, D, 0x40)                           # the pad drone, half level, rising into a glitch roll
        for k in (12, 13, 14, 15): at(b0 + k, noise, 0x45 - (k - 12) * 8, 0x81 + (k - 12) * 0x10)
        at(b0 + 15, stab, D + 24, 0xF1, 3)
    elif s == 'site':
        at(b0, kick); at(b0 + 8, kick); at(b0 + 4, snare); at(b0 + 12, snare)   # something on every beat (cuts land there)
        for k in range(2, 16, 4): at(b0 + k, hat)
        at(b0, bass, root, 0x20); at(b0 + 8, bass, root + 12, 0x40)
        for k, n in zip((0, 6, 10), tri): at(b0 + k, lead, n + 24, 0x63, 2)
    elif s == 'build':                                  # the zoom into the screen: a roll and a riser into the drop
        for k in range(0, 12, 4): at(b0 + k, kick)
        for k in range(0, 8, 2): at(b0 + k, snare)
        for k in range(8, 12): at(b0 + k, snare)
        for k in range(12, 16): at(b0 + k, riser, k)
        for k in range(16): at(b0 + k, lead, D + 24 + k, 0x71, 3)
        for k in range(0, 16, 2): at(b0 + k, bass, root + (12 if k % 4 else 0), 0x20, 0xE0)
    elif s in ('groove1', 'groove2', 'groove3', 'link', 'end'):
        last = s == 'end' and bar == SECTIONS['end'][1] - 1
        for k in range(0, 16, 4): at(b0 + k, kick, s == 'link' or (bar == 4 and k == 0))
        if bar == 4: at(b0, clap)                       # the drop: we fall through into the game
        for k in (4, 12): at(b0 + k, clap if s in ('groove3', 'link') else snare)
        for k in range(2, 16, 4): at(b0 + k, ohat if k in (6, 14) and s != 'groove1' else hat)
        if s != 'groove1':
            for k in range(1, 16, 4): at(b0 + k, hat)
        pat = (0, 0, 12, 0, 0, 12, 0, 7) if s != 'groove1' else (0, 0, 12, 0, 0, 0, 12, 0)
        for i, k in enumerate(range(0, 16, 2)): at(b0 + k, bass, root + pat[i], 0x20, 0xD0)
        up = 36 if s in ('link', 'end') else 24
        arp = [tri[0], tri[1], tri[2], tri[1] + 12] if s != 'groove1' else [tri[0], tri[1], tri[2], tri[1]]
        for k in range(16): at(b0 + k, lead, arp[k % 4] + up - (12 if (s == 'groove2' and k >= 8) else 0), 0x81 if k % 4 else 0xA1)
        if bar == SECTIONS[s][1] - 1 and s in ('groove2', 'groove3'):   # a fill into the next section
            for k in (13, 14, 15): at(b0 + k, snare)
        if s == 'groove3' and bar == 12:                                 # the stutter: kicks on sixteenths
            for k in range(8, 16): at(b0 + k, kick)
        if last:
            pass
    elif s == 'breakdown':
        at(b0, bass, D, 0x40)
        for k in range(16):
            at(b0 + k, riser, k)
            if k >= 8 or k % 2 == 0: at(b0 + k, lead, D + 24 + k, 0x91, 3)
        for k in (8, 10, 12, 13, 14, 15): at(b0 + k, kick)
    elif s == 'drop':
        at(b0, clap); at(b0, kick, True); at(b0, bass, D - 0, 0x20)
        for k in (4, 7, 10, 14): at(b0 + k, kick, True)
        at(b0 + 4, clap)
        at(b0 + 8, snare); at(b0 + 12, snare)
        for k in range(0, 16, 2): at(b0 + k + 1, hat)
        for k in (2, 8, 11, 13): at(b0 + k, stab, D + 12 + (3 if k in (11, 13) else 0), 0xC2, 2)
    elif s == 'tail':
        at(b0, kick, True); at(b0, clap); at(b0, bass, D, 0x20)
        at(b0, lead, D + 36, 0xF7, 2); at(b0 + 1, stab, A + 24, 0xF7, 2)
        at(b0 + 12, bass_off)

out = []; total = BARS * 16 * STEP + 120
for f in range(total):
    w(MUSIC_LEVEL, 2); w(SFX_OFF, 1)
    for fn, args in events.get(f, ()): fn(*args)
    pb.tick(); out.append(pb.sound.ndarray.copy())
# PyBoy hands back ~801 samples a frame (not 48000 / 59.7275 = 803.6): re-time the samples so frame f starts at exactly
# f / 59.7275 s, or the bar would drift ~6 ms a bar against the beat grid
raw = np.concatenate(out).astype(np.float64) * 256
cum = np.r_[0, np.cumsum([len(o) for o in out])]; tf = np.arange(len(out) + 1) / FPS
src = np.interp(np.arange(int(tf[-1] * 48000)) / 48000, tf, cum)
snd = np.stack([np.interp(src, np.arange(len(raw)), raw[:, c]) for c in range(2)], 1).round().astype(np.int16)
with wave.open(str(OUT), 'wb') as wv:
    wv.setnchannels(2); wv.setsampwidth(2); wv.setframerate(48000); wv.writeframes(snd.tobytes())
beat = 4 * STEP / FPS
OUT.with_suffix('.json').write_text(json.dumps({'bpm': 60 / beat, 'beat': beat, 'firstDownbeat': 0.0, 'bars': BARS,
                                                'sections': SECTIONS, 'source': 'make_bed.py (the ROM\'s APU in PyBoy)'}, indent=1))
print(f'{OUT}: {len(snd) / 48000:.1f} s, {60 / beat:.2f} BPM')

# the handheld's start-up chime from the site (crucible-site src/lib/sound.ts SFX.boot, played there by WebAudio on the
# same note table): C6 for 5 frames (env 0x81), then B6 for 44 frames (env 0xA3), duty 2, here on the real pulse channel.
# The site plays it only after a click, so the trailer adds it where the start-up mark lands. Writes chime.wav next to OUT.
out = []
for f in range(120):
    w(MUSIC_LEVEL, 2); w(SFX_OFF, 1)
    if f == 2: stab(36, 0x81, 2)
    if f == 7: stab(47, 0xA3, 2)
    pb.tick(); out.append(pb.sound.ndarray.copy())
raw = np.concatenate(out).astype(np.float64) * 256
cum = np.r_[0, np.cumsum([len(o) for o in out])]; tf = np.arange(len(out) + 1) / FPS
src = np.interp(np.arange(int(tf[-1] * 48000)) / 48000, tf, cum)
ch = np.stack([np.interp(src, np.arange(len(raw)), raw[:, c]) for c in range(2)], 1)[int(2 / FPS * 48000):].round().astype(np.int16)
with wave.open(str(OUT.parent / 'chime.wav'), 'wb') as wv:
    wv.setnchannels(2); wv.setsampwidth(2); wv.setframerate(48000); wv.writeframes(ch.tobytes())
pb.stop(save=False)
