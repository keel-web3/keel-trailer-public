import type { CodecApi } from './contracts.js';
import type { ToneApi } from './runtime-types.js';
export interface SynthInstrument {
    wave: 'sine' | 'triangle' | 'sawtooth' | 'square';
    attack: number;
    decay: number;
    sustain: number;
    release: number;
    gain: number;
}
export interface SynthScore {
    version: 1;
    bpm: number;
    ppq: number;
    duration: number;
    instruments: SynthInstrument[];
    notes: {
        tick: number;
        duration: number;
        pitch: number;
        velocity: number;
        instrument: number;
    }[];
}
// Portable authored scores share the KEEL codec with generated engine recipes.
const waves = ['sine', 'triangle', 'sawtooth', 'square'];
const exact = (x: unknown, keys: string[]) => { if (!x || typeof x !== 'object' || Array.isArray(x) || Object.keys(x).some(k => !keys.includes(k)))
    throw TypeError('Unknown music field'); };
const int = (v: number, a: number, b: number) => { if (!Number.isSafeInteger(v) || v < a || v > b)
    throw RangeError('Music integer out of range'); };
export function assertScore(input: unknown) {
    const s = input as SynthScore;
    exact(s, ['version', 'bpm', 'ppq', 'duration', 'instruments', 'notes']);
    if (s.version !== 1)
        throw TypeError('Unknown score version');
    int(s.bpm, 20, 300);
    int(s.ppq, 1, 960);
    int(s.duration, 1, 576000);
    if (s.duration * 60 / s.bpm / s.ppq > 120)
        throw RangeError('Music exceeds 120 seconds');
    if (!Array.isArray(s.instruments) || !s.instruments.length || s.instruments.length > 16)
        throw RangeError('Invalid instruments');
    for (const i of s.instruments) {
        exact(i, ['wave', 'attack', 'decay', 'sustain', 'release', 'gain']);
        if (!waves.includes(i.wave))
            throw TypeError('Unsupported waveform');
        for (const k of (['attack', 'decay', 'sustain', 'release', 'gain'] as const))
            int(i[k], 0, 1000);
    }
    if (!Array.isArray(s.notes) || s.notes.length > 16384)
        throw RangeError('Invalid note count');
    let last = -1;
    const edges = [];
    for (const n of s.notes) {
        exact(n, ['tick', 'duration', 'pitch', 'velocity', 'instrument']);
        int(n.tick, 0, s.duration - 1);
        int(n.duration, 1, s.duration - n.tick);
        int(n.pitch, 0, 127);
        int(n.velocity, 1, 127);
        int(n.instrument, 0, s.instruments.length - 1);
        if (n.tick < last)
            throw TypeError('Notes must be ordered');
        last = n.tick;
        edges.push([n.tick, 1], [n.tick + n.duration + s.instruments[n.instrument].release / 1000 * s.bpm * s.ppq / 60, -1]);
    }
    edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let voices = 0;
    for (const [, d] of edges) {
        voices += d;
        if (voices > 64)
            throw RangeError('Score exceeds 64 simultaneous voices including tails');
    }
    return s;
}
export function createScoreCodec(c: CodecApi) {
    const { named, struct, uint, varuint, array, enumOf, encode, decode } = c;
    const schema = named('keel/trailer/score-v1', struct({ version: uint(3), bpm: uint(9), ppq: uint(10), duration: varuint(), instruments: array(struct({ wave: enumOf(waves), attack: uint(10), decay: uint(10), sustain: uint(10), release: uint(10), gain: uint(10) }), { max: 16 }), notes: array(struct({ tick: varuint(), duration: varuint(), pitch: uint(7), velocity: uint(7), instrument: uint(4) }), { max: 16384 }) }));
    const enc = (s: SynthScore) => encode(schema, { ...assertScore(s), notes: s.notes.map((n, i) => ({ ...n, tick: n.tick - (i ? s.notes[i - 1].tick : 0) })) });
    return { schema, encode: enc, decode(bytes: Uint8Array) { if (!(bytes instanceof Uint8Array) || bytes.length > 262144)
            throw RangeError('Invalid score byte length'); const header = encode(schema, { version: 1, bpm: 60, ppq: 1, duration: 1, instruments: [], notes: [] }).subarray(0, 5); if (header.some((b, i) => bytes[i] !== b))
            throw TypeError('Unknown score schema header'); const raw = decode(schema, bytes) as SynthScore; let tick = 0; const s = assertScore({ ...raw, notes: raw.notes.map(n => ({ ...n, tick: tick += n.tick })) }); const again = enc(s); if (again.length !== bytes.length || again.some((b, i) => b !== bytes[i]))
            throw TypeError('Noncanonical score'); return s; } };
}
export async function renderScore(Tone: ToneApi, score: SynthScore, { sampleRate = 22050 }: {
    sampleRate?: number;
} = {}) {
    const s = assertScore(score), unit = 60 / s.bpm / s.ppq, duration = s.duration * unit;
    const buffer = await Tone.Offline(() => {
        const instruments = s.instruments.map(i => new Tone.PolySynth(Tone.Synth, { oscillator: { type: i.wave }, envelope: { attack: i.attack / 1000, decay: i.decay / 1000, sustain: i.sustain / 1000, release: i.release / 1000 } }).toDestination());
        for (let i = 0; i < instruments.length; i++) {
            instruments[i].maxPolyphony = 64;
            instruments[i].volume.value = s.instruments[i].gain ? 20 * Math.log10(s.instruments[i].gain / 1000) : -100;
        }
        for (const n of s.notes)
            instruments[n.instrument].triggerAttackRelease(440 * 2 ** ((n.pitch - 69) / 12), n.duration * unit, n.tick * unit, n.velocity / 127);
    }, duration, 2, sampleRate);
    return buffer.get?.() ?? buffer;
}
// Standard MIDI formats 0/1, constant tempo. Pitch bends, sustain, percussion,
// tempo changes and unsupported controllers fail instead of silently changing music.
export function importMidi(bytes: Uint8Array, { wave = 'sawtooth', gain = 180 }: {
    wave?: SynthInstrument['wave'];
    gain?: number;
} = {}) {
    if (!(bytes instanceof Uint8Array) || bytes.length > 1048576)
        throw RangeError('MIDI exceeds 1 MiB');
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let p = 0;
    const need = (n: number) => { if (p + n > bytes.length)
        throw TypeError('Truncated MIDI'); };
    const u8 = () => { need(1); return bytes[p++]; };
    const u16 = () => { need(2); const x = v.getUint16(p); p += 2; return x; };
    const u32 = () => { need(4); const x = v.getUint32(p); p += 4; return x; };
    const tag = () => String.fromCharCode(u8(), u8(), u8(), u8());
    const vlq = () => { let x = 0; for (let i = 0; i < 4; i++) {
        const b = u8();
        x = x * 128 + (b & 127);
        if (!(b & 128))
            return x;
    } throw TypeError('Invalid MIDI VLQ'); };
    if (tag() !== 'MThd' || u32() !== 6)
        throw TypeError('Expected MIDI header');
    const format = u16(), count = u16(), ppq = u16();
    if (format > 1 || count < 1 || count > 64 || (format === 0 && count !== 1) || !ppq || (ppq & 32768) || ppq > 960)
        throw TypeError('Unsupported MIDI format or PPQ');
    const notes = [], channels = new Map(), tempos = [];
    let duration = 0;
    for (let track = 0; track < count; track++) {
        if (tag() !== 'MTrk')
            throw TypeError('Expected MIDI track');
        const length = u32(), end = p + length;
        need(length);
        let tick = 0, running = 0;
        const active = new Map();
        while (p < end) {
            tick += vlq();
            if (tick > 576000)
                throw RangeError('MIDI tick budget exceeded');
            let status = u8();
            if (status < 128) {
                if (!running)
                    throw TypeError('Missing MIDI running status');
                p--;
                status = running;
            }
            else if (status < 240)
                running = status;
            if (status === 255) {
                running = 0;
                const type = u8(), len = vlq();
                need(len);
                if (type === 81) {
                    if (len !== 3)
                        throw TypeError('Invalid MIDI tempo');
                    tempos.push({ tick, value: bytes[p] * 65536 + bytes[p + 1] * 256 + bytes[p + 2] });
                }
                p += len;
                if (type === 47) {
                    if (len || p !== end)
                        throw TypeError('Invalid MIDI end');
                    break;
                }
                continue;
            }
            if (status >= 240)
                throw TypeError('MIDI system messages unsupported');
            const kind = status >> 4, ch = status & 15, a = u8();
            if (a >= 128)
                throw TypeError('Invalid MIDI data');
            const b = (kind === 12 || kind === 13) ? 0 : u8();
            if (b >= 128)
                throw TypeError('Invalid MIDI data');
            if (kind === 9 || kind === 8) {
                if (ch === 9)
                    throw TypeError('Percussion requires an explicit drum/sample mapping');
                const key = ch + ':' + a;
                if (kind === 9 && b) {
                    if (active.has(key))
                        throw TypeError('Overlapping same-pitch MIDI notes');
                    if (!channels.has(ch))
                        channels.set(ch, channels.size);
                    active.set(key, { tick, pitch: a, velocity: b, instrument: channels.get(ch) });
                }
                else {
                    const n = active.get(key);
                    if (!n)
                        throw TypeError('Unmatched MIDI note off');
                    if (tick > n.tick)
                        notes.push({ ...n, duration: tick - n.tick });
                    active.delete(key);
                }
            }
            else if (kind === 12) { /* GM patch is deliberately replaced by the explicitly selected waveform. */ }
            else
                throw TypeError('MIDI controller, pitch bend or aftertouch requires an authored conversion');
            if (notes.length > 16384)
                throw RangeError('MIDI note budget exceeded');
        }
        if (p !== end || active.size)
            throw TypeError('Invalid MIDI track or unclosed notes');
        duration = Math.max(duration, tick);
    }
    if (p !== bytes.length)
        throw TypeError('Trailing MIDI data');
    const tempo = tempos[0]?.value ?? 500000;
    if (!tempo || tempos.some(t => t.value !== tempo) || (tempos.length && Math.min(...tempos.map(t => t.tick)) !== 0))
        throw TypeError('Tempo changes need an explicit tempo-map conversion');
    const bpm = 60000000 / tempo;
    if (!Number.isInteger(bpm))
        throw TypeError('MIDI BPM must be integral for scene-v1');
    notes.sort((a, b) => a.tick - b.tick || a.instrument - b.instrument || a.pitch - b.pitch);
    return { score: assertScore({ version: 1, bpm, ppq, duration, instruments: [...channels].map(() => ({ wave, attack: 5, decay: 100, sustain: 600, release: 150, gain })), notes }), warnings: ['Synth patches are an authored approximation of the MIDI instruments. Audition against the reference.'] };
}
