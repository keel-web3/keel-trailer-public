type PackedScene = Omit<SceneProgram, 'cues'> & {
    cues: (SceneCue & {
        op: string;
    })[];
};
import type { CodecApi } from './contracts.js';
export type SceneCue = {
    tick: number;
    action: number;
    args: number[];
} & ({
    to?: undefined;
    duration?: never;
    ease?: never;
} | {
    to: number[];
    duration: number;
    ease: 'linear' | 'smooth';
});
export type SceneData = null | boolean | number | string | SceneData[] | {
    [key: string]: SceneData;
};
export type SceneProgram = {
    seed: number;
    width: number;
    height: number;
    fps: number;
    bpm: number;
    ppq: number;
    duration: number;
    actions: {
        name: string;
        arity: number;
    }[];
    cues: SceneCue[];
} & ({
    version: 1;
} | {
    version: 2;
    data: SceneData;
});
export interface SceneHost {
    reset(seed: number): void;
    call(name: string, args: number[], context: {
        tick: number;
        frame: number;
        seed: number;
    }): void;
    step(dt: number, frame: number): void;
    prepare?(frame: number): void | Promise<void>;
    render?(alpha: number): void;
}
export interface ScenePlayer {
    readonly duration: number;
    readonly frame: number;
    seek(seconds: number): {
        frame: number;
        tick: number;
        seconds: number;
    };
    seekPrepared(seconds: number): Promise<{
        frame: number;
        tick: number;
        seconds: number;
    }>;
    reset(): void;
}
// Browser-safe bounded cue tape. Uses the existing KEEL bit codec, not JS eval.
export const PROGRAM_LIMITS = Object.freeze({ bytes: 262144, cues: 8192, actions: 64, args: 8, seconds: 120, dataBytes: 16384 });
const own = (x: unknown, keys: string[], where: string) => { if (!x || typeof x !== 'object' || Array.isArray(x) || Object.keys(x).some(k => !keys.includes(k)))
    throw TypeError('Invalid ' + where + ' fields'); };
const integer = (v: number, lo: number, hi: number, label: string) => { if (!Number.isSafeInteger(v) || v < lo || v > hi)
    throw RangeError(label + ' outside ' + lo + '..' + hi); };
const numbers = (a: unknown) => { if (!Array.isArray(a) || a.length > 8 || a.some(v => !Number.isFinite(v) || Math.abs(v) > 1e9))
    throw TypeError('Invalid numeric arguments'); };
// Scene configuration is data, not hidden executable code in the adapter.
// dyn() is the existing lossless KEEL codec; these bounds constrain its inputs.
export function assertSceneData(input: unknown) {
    const value = input as SceneData;
    let nodes = 0;
    const active = new Set();
    function visit(v: unknown, depth: number) {
        if (++nodes > 4096 || depth > 6)
            throw RangeError('Scene data nesting or node budget exceeded');
        if (v === null || typeof v === 'boolean')
            return;
        if (typeof v === 'number') {
            if (!Number.isFinite(v) || Math.abs(v) > 1e9)
                throw TypeError('Invalid scene data number');
            return;
        }
        if (typeof v === 'string') {
            if (new TextEncoder().encode(v).length > 256)
                throw RangeError('Scene data string too long');
            return;
        }
        if (typeof v !== 'object' || active.has(v))
            throw TypeError('Scene data must be acyclic JSON values');
        if (!Array.isArray(v) && ![Object.prototype, null].includes(Object.getPrototypeOf(v)))
            throw TypeError('Scene data must be plain JSON values');
        active.add(v);
        const entries = Array.isArray(v) ? v : Object.entries(v);
        if (entries.length > 256)
            throw RangeError('Scene data collection too large');
        for (const e of entries) {
            if (Array.isArray(v))
                visit(e, depth + 1);
            else {
                const [k, x] = e;
                if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(k) || ['constructor', 'prototype', '__proto__'].includes(k))
                    throw TypeError('Invalid scene data key');
                visit(x, depth + 1);
            }
        }
        active.delete(v);
    }
    visit(value, 0);
    if (new TextEncoder().encode(JSON.stringify(value)).length > PROGRAM_LIMITS.dataBytes)
        throw RangeError('Scene data byte budget exceeded');
    return value;
}
export function assertProgram(input: unknown) {
    const p = input as SceneProgram;
    own(p, ['version', 'seed', 'width', 'height', 'fps', 'bpm', 'ppq', 'duration', 'actions', 'cues', ...(p?.version === 2 ? ['data'] : [])], 'program');
    if (![1, 2].includes(p.version))
        throw TypeError('Unsupported scene program version');
    if (p.version === 2) {
        if (!Object.hasOwn(p, 'data'))
            throw TypeError('Scene v2 requires configuration data');
        assertSceneData(p.data);
    }
    for (const [k, lo, hi] of [['seed', 0, 4294967295], ['width', 1, 4096], ['height', 1, 4096], ['fps', 1, 120], ['bpm', 20, 300], ['ppq', 1, 960], ['duration', 1, 576000]] as const)
        integer(p[k], lo, hi, k);
    if (p.duration * 60 / (p.bpm * p.ppq) > PROGRAM_LIMITS.seconds)
        throw RangeError('Scene duration exceeds 120 seconds');
    if (!Array.isArray(p.actions) || !p.actions.length || p.actions.length > 64)
        throw RangeError('Invalid action table');
    const names = new Set();
    for (const a of p.actions) {
        own(a, ['name', 'arity'], 'action');
        if (typeof a.name !== 'string' || !/^[a-z][a-zA-Z0-9_]{0,47}$/.test(a.name) || ['constructor', 'prototype', '__proto__'].includes(a.name) || names.has(a.name))
            throw TypeError('Invalid or duplicate action name');
        names.add(a.name);
        integer(a.arity, 0, 8, 'arity');
    }
    if (!Array.isArray(p.cues) || p.cues.length > 8192)
        throw RangeError('Invalid cue count');
    let previous = -1;
    const active = new Map();
    for (const c of p.cues) {
        own(c, ['tick', 'action', 'args', 'to', 'duration', 'ease'], 'cue');
        integer(c.tick, 0, p.duration - 1, 'tick');
        if (c.tick < previous)
            throw TypeError('Cues must be in tick order');
        previous = c.tick;
        integer(c.action, 0, p.actions.length - 1, 'action');
        numbers(c.args);
        if (c.args.length !== p.actions[c.action].arity)
            throw TypeError('Action arity mismatch');
        if (c.tick < (active.get(c.action) ?? -1))
            throw TypeError('Overlapping action tween');
        if (c.to !== undefined) {
            numbers(c.to);
            if (c.to.length !== c.args.length)
                throw TypeError('Tween arity mismatch');
            integer(c.duration, 1, p.duration - c.tick, 'tween duration');
            if (!['linear', 'smooth'].includes(c.ease))
                throw TypeError('Unknown easing');
            active.set(c.action, c.tick + c.duration);
        }
        else if (c.duration !== undefined || c.ease !== undefined)
            throw TypeError('Tween requires to values');
    }
    return p;
}
export function createSceneCodec(c: CodecApi) {
    const { named, struct, uint, varuint, array, string, num, union, enumOf, encode, decode, dyn } = c;
    const values = array(num(), { max: 8 }), base = { tick: varuint(), action: uint(6), args: values };
    const fields = { version: uint(3), seed: uint(32), width: uint(13), height: uint(13), fps: uint(7), bpm: uint(9), ppq: uint(10), duration: varuint(), actions: array(struct({ name: string({ max: 48 }), arity: uint(4) }), { max: 64 }), cues: array(union('op', { call: struct(base), tween: struct({ ...base, to: values, duration: varuint(), ease: enumOf(['linear', 'smooth']) }) }), { max: 8192 }) };
    const schema = named('keel/trailer/scene-v1', struct(fields));
    const schema2 = typeof dyn === 'function' ? named('keel/trailer/scene-v2', struct({ ...fields, data: dyn() })) : null;
    const pack = (p: SceneProgram) => ({ ...p, cues: p.cues.map((x, i) => ({ ...x, tick: x.tick - (i ? p.cues[i - 1].tick : 0), op: x.to ? 'tween' : 'call' })) });
    const unpack = (x: PackedScene) => { let tick = 0; return { ...x, cues: x.cues.map(({ op, ...cue }) => ({ ...cue, tick: tick += cue.tick })) }; };
    const enc = (p: SceneProgram) => { assertProgram(p); const s = p.version === 1 ? schema : schema2; if (!s)
        throw TypeError('Selected KEEL codec does not support scene v2 data'); return encode(s, pack(p)); };
    const seed = { seed: 0, width: 1, height: 1, fps: 1, bpm: 60, ppq: 1, duration: 1, actions: [{ name: 'a', arity: 0 }], cues: [] };
    const headers = [{ schema, version: 1, bytes: enc({ ...seed, version: 1 }).subarray(0, 5) }, ...(schema2 ? [{ schema: schema2, version: 2, bytes: enc({ ...seed, version: 2, data: null }).subarray(0, 5) }] : [])];
    return { schema, schema2, encode: enc, decode(bytes: Uint8Array) { if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > PROGRAM_LIMITS.bytes)
            throw RangeError('Invalid scene byte length'); const layout = headers.find(h => !h.bytes.some((b, i) => bytes[i] !== b)); if (!layout)
            throw TypeError('Unknown scene schema header'); const p = assertProgram(unpack(decode(layout.schema, bytes) as PackedScene)); if (p.version !== layout.version)
            throw TypeError('Scene schema/version mismatch'); const canonical = enc(p); if (canonical.length !== bytes.length || canonical.some((b, i) => b !== bytes[i]))
            throw TypeError('Noncanonical or trailing scene bytes'); return p; } };
}
export function createScenePlayer(program: SceneProgram, host: SceneHost): ScenePlayer {
    const p = structuredClone(assertProgram(program)), seconds = p.duration * 60 / (p.bpm * p.ppq), lastFrame = Math.ceil(seconds * p.fps);
    let frame = -1, index = 0, active: Extract<SceneCue, {
        to: number[];
    }>[] = [], revision = 0;
    const tickOf = (f: number) => f * p.bpm * p.ppq / (60 * p.fps);
    function reset() { revision++; host.reset(p.seed); frame = -1; index = 0; active = []; }
    function call(c: SceneCue, args: number[]) { host.call(p.actions[c.action].name, args, { tick: c.tick, frame, seed: p.seed }); }
    function step() {
        frame++;
        const tick = tickOf(frame);
        // Finish previous interpolation before calls on the same boundary.
        active = active.filter(c => { const t = Math.min(1, (tick - c.tick) / c.duration), e = c.ease === 'smooth' ? t * t * (3 - 2 * t) : t; call(c, c.args.map((v, i) => v + (c.to[i] - v) * e)); return t < 1; });
        while (index < p.cues.length && p.cues[index].tick <= tick) {
            const c = p.cues[index++];
            if (c.to) {
                const t = Math.min(1, (tick - c.tick) / c.duration), e = c.ease === 'smooth' ? t * t * (3 - 2 * t) : t;
                call(c, c.args.map((v, i) => v + (c.to[i] - v) * e));
                if (t < 1)
                    active.push(c);
            }
            else
                call(c, c.args);
        }
        if (frame > 0)
            host.step(1 / p.fps, frame);
    }
    function advance(time: number) { if (!Number.isFinite(time) || time < 0 || time > seconds)
        throw RangeError('Invalid seek time'); const target = time === seconds ? lastFrame : Math.min(lastFrame, Math.floor(time * p.fps + 1e-8)); if (target < frame)
        reset(); while (frame < target)
        step(); return { frame, tick: tickOf(frame), seconds: frame / p.fps }; }
    reset();
    return { duration: seconds, get frame() { return frame; }, seek(time) { revision++; const result = advance(time); host.render?.((time * p.fps) - result.frame); return result; }, async seekPrepared(time) { const result = advance(time), ticket = ++revision; await host.prepare?.(result.frame); if (ticket === revision)
            host.render?.((time * p.fps) - result.frame); return result; }, reset };
}
