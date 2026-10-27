export interface Note {
    beat: number;
    beats: number;
    pitch?: number;
    vel?: number;
    pan?: number;
}
export interface VoiceOptions {
    attack?: number;
    release?: number;
    cut?: boolean;
    cutoff?: number;
    duty?: number;
}
export interface Track extends VoiceOptions {
    id?: string;
    voice: string;
    notes: Note[];
    gain?: number;
    pan?: number;
    offset?: number;
    highpass?: number;
    lowpass?: number;
    drive?: number;
    duck?: {
        beats: number[];
        release?: number;
        depth?: number;
    };
    reverb?: number;
}
export interface Hit {
    kind: 'press' | 'slam' | 'final' | 'riser' | 'swell';
    beat: number;
    beats?: number;
    root?: number;
    power?: number;
    gain?: number;
    pan?: number;
    tail?: number;
}
export interface SoundDesign {
    seed: number;
    bright: number;
    bell: number;
    bits: number;
    hold: number;
    top: number;
    kickHz: number;
    kickDecay: number;
    punch: number;
    snareBody: number;
    snareTone: number;
    snareDecay: number;
    hatTone: number;
}
export interface Arrangement {
    version: 1;
    bpm: number;
    totalBeats: number;
    tracks: Track[];
    hits?: Hit[];
    loop?: boolean;
    tailSeconds?: number;
    seed?: number;
    bright?: number;
    kickHz?: number;
    root?: number;
    design?: Partial<SoundDesign>;
    reverb?: {
        size?: number;
        damp?: number;
        width?: number;
    };
    musicRms?: number;
    sfxGain?: number;
}
export type Stereo = [
    Float32Array,
    Float32Array
];
export interface ArrangementReport {
    tracks: {
        id: string;
        voice: string;
        notes: number;
    }[];
    hits: {
        beat: number;
        seconds: number;
        kind: Hit['kind'];
        power: number;
        parts: string[];
    }[];
    loop?: unknown;
}
// Offline arrangement renderer on the KEEL engine's own instruments (packages/audio: KEYS, BASS, DRUMS and the
// synth kit). An arrangement is authored notes in beats plus cue hits (a press, a cut) rendered as sound effects in
// the piece's key, so the effects belong to the music. Pure Node: no Web Audio, no Tone, nothing fetched.
// Writes music.wav, sfx.wav and mix.wav (48 kHz stereo float) and arrangement-render.json with every hit's time.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
export const SYNTH_VOICES = ['pulse', 'saw-pad', 'choir', 'theremin', 'drone', 'bell', 'glass'];
export const HIT_KINDS = ['press', 'slam', 'final', 'riser', 'swell'];
const TAU = Math.PI * 2;
const hz = (m: number) => 440 * 2 ** ((m - 69) / 12);
export function assertArrangement(a: Arrangement) {
    const bad = (m: string) => { throw TypeError('Arrangement: ' + m); };
    if (!a || a.version !== 1)
        bad('version must be 1');
    if (!(a.bpm > 20 && a.bpm < 400))
        bad('bpm');
    if (!(a.totalBeats > 0 && a.totalBeats * 60 / a.bpm <= 600))
        bad('totalBeats (max 10 minutes)');
    if (!Array.isArray(a.tracks) || a.tracks.length > 48)
        bad('tracks');
    for (const t of a.tracks) {
        if (typeof t.voice !== 'string')
            bad('track voice');
        if (!Array.isArray(t.notes) || t.notes.length > 20000)
            bad('track notes');
        for (const n of t.notes)
            if (!(n.beat >= 0 && n.beat < a.totalBeats + 64 && n.beats > 0 && Number.isFinite(n.pitch ?? 60)))
                bad('note ' + JSON.stringify(n));
    }
    for (const h of a.hits ?? [])
        if (!HIT_KINDS.includes(h.kind) || !(h.beat >= 0))
            bad('hit ' + JSON.stringify(h));
    return a;
}
function rng(seed: number) { let s = (seed >>> 0) || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296) * 2 - 1; }; }
// Freeverb: eight combs and four allpasses a channel, the right a little detuned.
function reverb(L: Float32Array, R: Float32Array, rate: number, { size = 0.82, damp = 0.35, width = 1 }: {
    size?: number;
    damp?: number;
    width?: number;
} = {}) {
    const k = rate / 44100, combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617], aps = [556, 441, 341, 225];
    const run = (x: Float32Array, spread: number) => {
        const out = new Float32Array(x.length);
        for (const c of combs) {
            const n = Math.round((c + spread) * k), buf = new Float32Array(n);
            let i = 0, store = 0;
            for (let j = 0; j < x.length; j++) {
                const y = buf[i];
                store = y * (1 - damp) + store * damp;
                buf[i] = x[j] * 0.015 + store * size;
                out[j] += y;
                if (++i >= n)
                    i = 0;
            }
        }
        for (const a of aps) {
            const n = Math.round((a + spread) * k), buf = new Float32Array(n);
            let i = 0;
            for (let j = 0; j < x.length; j++) {
                const b = buf[i], y = -out[j] + b;
                buf[i] = out[j] + b * 0.5;
                out[j] = y;
                if (++i >= n)
                    i = 0;
            }
        }
        return out;
    };
    const wl = run(L, 0), wr = run(R, 23);
    if (width < 1) {
        for (let j = 0; j < wl.length; j++) {
            const m = (wl[j] + wr[j]) / 2;
            wl[j] = m + (wl[j] - m) * width;
            wr[j] = m + (wr[j] - m) * width;
        }
    }
    return [wl, wr];
}
function onePole(x: Float32Array, f: number, rate: number, high: boolean = false) { const a = Math.exp(-TAU * f / rate); let y = 0; for (let i = 0; i < x.length; i++) {
    y = (1 - a) * x[i] + a * y;
    if (high)
        x[i] = x[i] - y;
    else
        x[i] = y;
} return x; }
export async function loadKit(engineRoot: string) {
    const base = new URL('packages/audio/src/', pathToFileURL(path.resolve(engineRoot) + '/'));
    const [samples, synth] = await Promise.all([import(new URL('samples.ts', base).href), import(new URL('synth.ts', base).href)]);
    return { samples, synth };
}
// A loop (arrangement.loop: true) renders its notes twice and keeps the second time round, so every tail -- the
// reverb, a pad's release, the drone -- has already wrapped in from the first: the files start where they end.
function doubled(a: Arrangement) {
    const T = a.totalBeats, twice = <V extends {
        beat: number;
    }>(xs: V[]) => [...xs, ...xs.map(n => ({ ...n, beat: n.beat + T }))];
    return { ...a, totalBeats: 2 * T, tailSeconds: 0, tracks: a.tracks.map(t => ({ ...t, notes: twice(t.notes) })), hits: twice(a.hits ?? []) };
}
export async function renderArrangement(arrangement: Arrangement, { engineRoot, outDir, rate = 48000 }: {
    engineRoot: string;
    outDir: string;
    rate?: number;
}) {
    const loop = !!assertArrangement(arrangement).loop, a = loop ? doubled(arrangement) : arrangement, { samples: S, synth: Y } = await loadKit(engineRoot);
    const beat = 60 / a.bpm, sec = (b: number) => b * beat, N = Math.ceil((a.totalBeats * beat + (a.tailSeconds ?? 4)) * rate);
    const design = { seed: a.seed ?? 13, bright: a.bright ?? 0.5, bell: 4.2, bits: 16, hold: 1, top: 18000, kickHz: a.kickHz ?? 46, kickDecay: 0.42, punch: 0.7, snareBody: 180, snareTone: 2600, snareDecay: 0.16, hatTone: 1.05, ...(a.design ?? {}) };
    const R = rng(design.seed);
    const cache = new Map<string, Float32Array>();
    const norm = (x: Float32Array, p: number = 0.8) => { let m = 0; for (const v of x)
        m = Math.max(m, Math.abs(v)); if (m > 0)
        for (let i = 0; i < x.length; i++)
            x[i] *= p / m; return x; };
    const buf = (s: number) => new Float32Array(Math.max(1, Math.round(s * rate)));
    // One note of a voice: a Float32Array starting at the attack, its length the note plus its release.
    function note(voice: string, pitch: number, vel: number, dur: number, opt: VoiceOptions) {
        const key = voice + '|' + pitch + '|' + Math.round(vel * 8) + '|' + (S.KEYS[voice] || S.BASS[voice] || voice in S.DRUMS ? '' : Math.round(dur * 100));
        if (cache.has(key))
            return cache.get(key)!;
        let x: Float32Array;
        const f = hz(pitch);
        if (S.KEYS[voice])
            x = norm(S.KEYS[voice](f, vel, design, rate));
        else if (S.BASS[voice])
            x = norm(S.BASS[voice](f, vel, design, rate), 0.9);
        else if (voice in S.DRUMS)
            x = norm(voice === 'open' ? S.DRUMS.hat(design, rate, true) : S.DRUMS[voice](design, rate), 0.9);
        else if (voice === 'open')
            x = norm(S.DRUMS.hat(design, rate, true), 0.9);
        else if (voice === 'pulse') {
            const rel = 0.08;
            x = buf(dur + rel);
            Y.osc(x, rate, 0, dur + rel, () => f, (t: number) => Math.min(1, t / 0.004) * (t < dur ? 1 - 0.25 * Math.min(1, t / 0.4) : Math.max(0, 1 - (t - dur) / rel) * 0.75) * 0.5, 'pulse', 0, opt.duty ?? 0.25);
            x = Y.crush(x, 6, 2);
        }
        else if (voice === 'saw-pad') {
            const at = opt.attack ?? 0.6, rel = opt.release ?? 1.4;
            x = buf(dur + rel);
            for (const d of [-0.11, 0, 0.13])
                Y.osc(x, rate, 0, dur + rel, (t: number) => f * 2 ** (d / 12) * (1 + 0.002 * Math.sin(TAU * 5.1 * t)), (t: number) => Math.min(1, t / at) * (t < dur ? 1 : Math.max(0, 1 - (t - dur) / rel)) * 0.3, 'saw', R() * 0.5 + 0.5);
            Y.sweep(x, () => Math.min(9000, f * (opt.cutoff ?? 5)), 0.8, rate, 'low');
        }
        else if (voice === 'choir') {
            const at = opt.attack ?? 0.5, rel = opt.release ?? 1.6;
            x = buf(dur + rel);
            for (const d of [-0.08, 0, 0.07, 12.02])
                Y.osc(x, rate, 0, dur + rel, (t: number) => f * 2 ** (d / 12) * (1 + 0.004 * Math.sin(TAU * (5.2 + d) * t)), (t: number) => Math.min(1, t / at) * (t < dur ? 1 : Math.max(0, 1 - (t - dur) / rel)) * (d > 11 ? 0.12 : 0.28), 'saw', R() * 0.5 + 0.5);
            x = Y.formants(x, rate, () => [330, 760, 2450], 9, [1, 0.55, 0.12]);
            norm(x, 0.6);
        }
        else if (voice === 'theremin') {
            const rel = 0.5;
            x = buf(dur + rel);
            Y.osc(x, rate, 0, dur + rel, (t: number) => f * (1 + 0.012 * Math.sin(TAU * 5.6 * t) * Math.min(1, t / 0.35)), (t: number) => Math.min(1, t / 0.12) * (t < dur ? 1 : Math.max(0, 1 - (t - dur) / rel)) * 0.55, 'sine');
            Y.osc(x, rate, 0, dur + rel, (t: number) => f * 2, (t: number) => Math.min(1, t / 0.12) * (t < dur ? 1 : Math.max(0, 1 - (t - dur) / rel)) * 0.08, 'sine');
        }
        else if (voice === 'drone') {
            const at = opt.attack ?? 1.5, rel = opt.release ?? 2.5;
            x = buf(dur + rel);
            const env = (t: number) => Math.min(1, t / at) * (t < dur ? 1 : Math.max(0, 1 - (t - dur) / rel));
            Y.osc(x, rate, 0, dur + rel, () => f, (t: number) => env(t) * 0.6, 'sine');
            Y.osc(x, rate, 0, dur + rel, () => f * 1.003, (t: number) => env(t) * 0.25, 'tri');
            const n = buf(dur + rel);
            Y.burst(n, rate, R, 0, (t: number) => env(t), 0.25);
            Y.sweep(n, (t: number) => f * 4 + f * 2 * Math.sin(TAU * 0.13 * t), 6, rate, 'band');
            for (let i = 0; i < x.length; i++)
                x[i] += n[i];
        }
        else if (voice === 'bell') {
            x = Y.partials(buf(6), rate, [[f, 1, 3.2], [f * 2.76, 0.45, 1.6], [f * 5.4, 0.28, 0.7], [f * 8.93, 0.12, 0.3, 0, 0.001], [f * 0.5, 0.3, 4]], vel);
            norm(x, 0.8);
        }
        else if (voice === 'glass') {
            x = Y.partials(buf(3), rate, [[f, 1, 1.6], [f * 2.0, 0.3, 0.9], [f * 3.01, 0.18, 0.5], [f * 4.95, 0.1, 0.25, 0, 0.001]], vel);
            norm(x, 0.6);
        }
        else
            throw TypeError('Unknown voice ' + voice);
        // Sampled instruments ring their own way; cut them at the note's end with a short release so riffs stay tight.
        if ((S.KEYS[voice] || S.BASS[voice]) && opt.cut !== false) {
            const end = Math.round((dur + (opt.release ?? 0.12)) * rate), fade = Math.round((opt.release ?? 0.12) * rate);
            if (end < x.length) {
                const y = x.slice(0, end);
                for (let i = 0; i < fade; i++)
                    y[end - 1 - i] *= i / fade;
                x = y;
            }
        }
        cache.set(key, x);
        return x;
    }
    const stem = (): Stereo => [new Float32Array(N), new Float32Array(N)];
    function place(st: Stereo, x: Float32Array, t: number, gain: number, pan: number) {
        const i0 = Math.round(t * rate), gl = gain * Math.cos((pan + 1) * Math.PI / 4), gr = gain * Math.sin((pan + 1) * Math.PI / 4);
        for (let i = 0; i < x.length && i0 + i < N; i++) {
            if (i0 + i < 0)
                continue;
            st[0][i0 + i] += x[i] * gl;
            st[1][i0 + i] += x[i] * gr;
        }
    }
    function mixInto(dst: Stereo, src: Stereo, gain: number = 1) { for (let c = 0; c < 2; c++)
        for (let i = 0; i < N; i++)
            dst[c][i] += src[c][i] * gain; }
    const music = stem(), wet = stem(), report: ArrangementReport = { tracks: [], hits: [] };
    for (const t of a.tracks) {
        const st = stem();
        let count = 0;
        for (const n of t.notes) {
            const dur = sec(n.beats);
            const x = note(t.voice, n.pitch ?? 60, n.vel ?? 0.8, dur, t);
            place(st, x, sec(n.beat) + (t.offset ?? 0), (n.vel ?? 0.8) * (t.gain ?? 1), n.pan ?? t.pan ?? 0);
            count++;
        }
        if (t.highpass)
            for (const c of st)
                onePole(c, t.highpass, rate, true);
        if (t.lowpass)
            for (const c of st)
                onePole(c, t.lowpass, rate);
        if (t.drive)
            for (const c of st)
                for (let i = 0; i < N; i++)
                    c[i] = Math.tanh(c[i] * t.drive) / Math.tanh(t.drive);
        if (t.duck) { // pump under the kick: dips at each listed beat
            const g = new Float32Array(N).fill(1);
            for (const b of t.duck.beats) {
                const i0 = Math.round(sec(b) * rate), len = Math.round((t.duck.release ?? 0.18) * rate);
                for (let i = 0; i < len && i0 + i < N; i++) {
                    const v = 1 - (t.duck.depth ?? 0.5) * (1 - i / len);
                    if (v < g[i0 + i])
                        g[i0 + i] = v;
                }
            }
            for (const c of st)
                for (let i = 0; i < N; i++)
                    c[i] *= g[i];
        }
        mixInto(music, st);
        if (t.reverb)
            mixInto(wet, st, t.reverb);
        report.tracks.push({ id: t.id ?? t.voice, voice: t.voice, notes: count });
    }
    // Hits: cue sounds built from the kit, in the arrangement's key (root midi), scaled by power 0..1.
    const sfx = stem(), sfxWet = stem(), root = a.root ?? 54;
    for (const h of a.hits ?? []) {
        const p = Math.max(0, Math.min(1.5, h.power ?? 0.5)), t = sec(h.beat), r = h.root ?? root, gain = h.gain ?? 1;
        const parts = [];
        const room = h.kind === 'final' ? Infinity : Math.max(0.25, h.tail ?? Infinity); // a hit rings no longer than the gap to the next
        const lay = (x: Float32Array, dt: number, g: number, pan: number = 0, verb: number = 0.3) => { place(sfx, x, t + dt, g * gain, pan); if (verb)
            place(sfxWet, x, t + dt, g * gain * verb, pan); };
        if (h.kind === 'press' || h.kind === 'slam' || h.kind === 'final') {
            // the breath in: filtered noise rising into the beat
            const pre = h.kind === 'final' ? 1.4 : 0.22 + 0.18 * p, nb = buf(pre);
            Y.burst(nb, rate, R, 0, (tt: number) => (tt / pre) ** 2, 0.9);
            Y.sweep(nb, (tt: number) => 300 + 5200 * (tt / pre) ** 2, 1.6, rate, 'band');
            lay(nb, -pre, 0.35 + 0.25 * p, 0, 0.4);
            parts.push('swell');
            // the boom: a skin falling into the sub, deeper and longer as the cues come harder
            const deep = hz(r - 24 - Math.round(p * 5)), dec = Math.min(0.25 + 0.9 * p, room * 0.45), boom = buf(Math.min(1.2 + 2.5 * p, room + 0.6));
            Y.thump(boom, rate, 0, deep * 4, deep, dec, 1, 0.04);
            if (p > 0.6)
                Y.thump(boom, rate, 0, deep * 2.5, deep / 2, Math.min(0.6 + 0.8 * p, room * 0.6), 0.6, 0.08);
            {
                const f = Math.round(Math.min(0.15, boom.length / rate / 3) * rate);
                for (let i = 0; i < f; i++)
                    boom[boom.length - 1 - i] *= i / f;
            }
            for (let i = 0; i < boom.length; i++)
                boom[i] = Math.tanh(boom[i] * (1.2 + p * 1.8));
            lay(boom, 0, 0.55 + 0.35 * p, 0, 0.15);
            parts.push('boom');
            // the strike: a bell chord on the root (fifth and octave), its octave-down twin when it hits hard
            for (const [iv, g, pan] of [[0, 1, -0.2], [7, 0.7, 0.25], [12, 0.6, 0.05], [p > 0.7 ? -12 : null, 0.7, 0]] as [
                number | null,
                number,
                number
            ][]) {
                if (iv === null)
                    continue;
                const x = note('bell', r + 12 + iv, 0.9, 1, {});
                lay(x, 0, 0.18 * g * (0.6 + 0.6 * p), pan, 0.6);
            }
            parts.push('bell');
            // the air: a short noise whoosh across the stereo field
            const wb = buf(0.55 + 0.4 * p);
            Y.burst(wb, rate, R, 0, (tt: number) => Math.exp(-tt / (0.12 + 0.15 * p)), 0.8);
            Y.sweep(wb, (tt: number) => 5000 * Math.exp(-tt * 3) + 400, 1.2, rate, 'band');
            lay(wb, 0, 0.25 + 0.2 * p, h.pan ?? (R() * 0.6), 0.5);
            if (p > 0.55) {
                const cl = Math.min(0.5 + 0.8 * p, room);
                const c = note('choir', r + 12, 0.9, cl, { attack: 0.02, release: Math.min(1.2, room) });
                lay(c, 0, 0.22 * p, 0, 0.8);
                const c5 = note('choir', r + 19, 0.9, cl, { attack: 0.02, release: Math.min(1.2, room) });
                lay(c5, 0, 0.16 * p, 0.2, 0.8);
                parts.push('choir');
            }
            if (h.kind === 'slam' || h.kind === 'final') {
                const L = h.kind === 'final' ? 1 : Math.min(1, room / 1.5), g = Y.partials(buf(7 * L), rate, [[hz(r - 12), 1, 4 * L], [hz(r - 12) * 2.41, 0.6, 2.2 * L], [hz(r - 12) * 3.87, 0.4, 1.4 * L], [hz(r - 12) * 5.93, 0.25, 0.8 * L]], 1);
                norm(g, 0.8);
                lay(g, 0, h.kind === 'final' ? 0.55 : 0.22, 0, h.kind === 'final' ? 0.7 : 0.35);
                parts.push('gong');
            }
        }
        if (h.kind === 'riser' || h.kind === 'swell') {
            const len = sec(h.beats ?? 4), x = buf(len);
            Y.burst(x, rate, R, 0, (tt: number) => (tt / len) ** 1.6, 1);
            Y.sweep(x, (tt: number) => 200 + (h.kind === 'riser' ? 7000 : 2500) * (tt / len) ** 2, 2.5, rate, 'band');
            if (h.kind === 'riser')
                Y.osc(x, rate, 0, len, (tt: number) => hz(r) * 2 ** (2 * tt / len), (tt: number) => (tt / len) ** 2 * 0.3, 'saw');
            place(sfx, x, t, 0.5 * p * gain, 0);
            place(sfxWet, x, t, 0.4 * p * gain, 0);
            parts.push(h.kind);
        }
        report.hits.push({ beat: h.beat, seconds: +t.toFixed(5), kind: h.kind, power: p, parts });
    }
    const verb = a.reverb ?? { size: 0.84, damp: 0.32 };
    const [ml, mr] = reverb(wet[0], wet[1], rate, verb), [sl, sr] = reverb(sfxWet[0], sfxWet[1], rate, { ...verb, size: Math.min(0.9, (verb.size ?? 0.84) + 0.04) });
    for (let i = 0; i < N; i++) {
        music[0][i] += ml[i];
        music[1][i] += mr[i];
        sfx[0][i] += sl[i];
        sfx[1][i] += sr[i];
    }
    const rms = (st: Stereo) => { let e = 0; for (const c of st)
        for (const v of c)
            e += v * v; return Math.sqrt(e / (2 * N)) || 1e-9; };
    const scale = (st: Stereo, g: number) => { for (const c of st)
        for (let i = 0; i < N; i++)
            c[i] *= g; };
    // the music bed at a fixed level; the hits sit sfxGain (default +2 dB) over it by RMS
    scale(music, (a.musicRms ?? 0.11) / rms(music));
    scale(sfx, (a.musicRms ?? 0.11) * (a.sfxGain ?? 1.25) / rms(sfx));
    const mix = stem();
    for (let c = 0; c < 2; c++)
        for (let i = 0; i < N; i++)
            mix[c][i] = music[c][i] + sfx[c][i];
    // lookahead peak limiter (5 ms ahead, 150 ms release) to -1 dBFS; the same gain on the stems so they stay a pair
    const ceil = 0.89, ahead = Math.round(0.005 * rate), rel = Math.exp(-1 / (0.15 * rate)), need = new Float32Array(N);
    for (let i = 0; i < N; i++) {
        const v = Math.max(Math.abs(mix[0][i]), Math.abs(mix[1][i]));
        need[i] = v > ceil ? ceil / v : 1;
    }
    const g = new Float32Array(N);
    let cur = 1;
    const q = []; // sliding minimum over the lookahead window
    for (let i = N - 1 + ahead; i >= 0; i--) {
        const j = i - ahead;
        const v = i < N ? need[i] : 1;
        while (q.length && q[q.length - 1][1] >= v)
            q.pop();
        q.push([i, v]);
        while (q[0][0] > i + ahead)
            q.shift();
        if (j >= 0 && j < N)
            g[j] = q[0][1];
    }
    for (let i = 0; i < N; i++) {
        cur = g[i] < cur ? g[i] : Math.min(g[i], 1 - (1 - cur) * rel);
        g[i] = cur;
    }
    for (const st of [mix, music, sfx])
        for (const c of st)
            for (let i = 0; i < N; i++)
                c[i] *= g[i];
    let stems: [
        string,
        Stereo
    ][] = [['music', music], ['sfx', sfx], ['mix', mix]], totalBeats = a.totalBeats;
    if (loop) {
        totalBeats = arrangement.totalBeats;
        const from = Math.round(sec(totalBeats) * rate), to = Math.round(sec(2 * totalBeats) * rate);
        stems = stems.map(([k, st]) => [k, st.map(c => c.slice(from, to)) as Stereo]);
        report.hits = report.hits.filter(h => h.beat >= totalBeats).map(h => ({ ...h, beat: h.beat - totalBeats, seconds: +(h.seconds - sec(totalBeats)).toFixed(5) }));
        const { measureLoop } = await import(new URL('packages/audio/src/wav.ts', pathToFileURL(path.resolve(engineRoot) + '/')).href);
        report.loop = measureLoop(stems[2][1], rate);
    }
    await mkdir(outDir, { recursive: true });
    const files = {music: path.join(outDir, 'music.wav'), sfx: path.join(outDir, 'sfx.wav'), mix: path.join(outDir, 'mix.wav')};
    for (const [name, st] of stems) {
        if (!(name in files)) throw Error('Unknown score stem: ' + name);
        await writeFile(files[name as keyof typeof files], wav(st, rate));
    }
    const out = { ...files, rate, seconds: stems[2][1][0].length / rate, bpm: a.bpm, beatSeconds: beat, totalBeats, ...report };
    await writeFile(path.join(outDir, 'arrangement-render.json'), JSON.stringify(out, null, 1) + '\n');
    return out;
}
function wav([L, R]: Stereo, rate: number) {
    const n = L.length, b = Buffer.alloc(44 + n * 8);
    b.write('RIFF', 0);
    b.writeUInt32LE(36 + n * 8, 4);
    b.write('WAVE', 8);
    b.write('fmt ', 12);
    b.writeUInt32LE(16, 16);
    b.writeUInt16LE(3, 20);
    b.writeUInt16LE(2, 22);
    b.writeUInt32LE(rate, 24);
    b.writeUInt32LE(rate * 8, 28);
    b.writeUInt16LE(8, 32);
    b.writeUInt16LE(32, 34);
    b.write('data', 36);
    b.writeUInt32LE(n * 8, 40);
    for (let i = 0; i < n; i++) {
        b.writeFloatLE(L[i], 44 + i * 8);
        b.writeFloatLE(R[i], 48 + i * 8);
    }
    return b;
}
