import type { JsonSchema, ObjectSchema, SchemaIssue } from './contracts.js';
import type { Timeline } from './timeline.js';
import { INSPECTION_TOOL_SCHEMAS } from './inspection-schema.js';
import { ONCHAIN_TOOL_SCHEMAS } from './onchain-schema.js';
// Deliberately small JSON Schema vocabulary: also validated without a dependency.
const str = { type: 'string', minLength: 1, maxLength: 4096 };
const num = { type: 'number' };
const pos = { type: 'number', exclusiveMinimum: 0 };
const nonneg = { type: 'number', minimum: 0 };
const uint = { type: 'integer', minimum: 0 };
const integer = { type: 'integer', minimum: 1 };
const bool = { type: 'boolean' };
const array = (items: JsonSchema, minItems = 0) => ({ type: 'array', items, minItems, maxItems: 10000 });
const obj = (properties: Record<string, JsonSchema>, required: string[] = []): ObjectSchema => ({ type: 'object', properties, required, additionalProperties: false });
const rect = obj({ x: num, y: num, width: pos, height: pos }, ['x', 'y', 'width', 'height']);
const color = { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' };
const point = obj({ beat: nonneg, frame: uint }, ['beat', 'frame']);
const target = obj({
    id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,80}$' }, width: integer, height: integer,
    safeArea: rect, crop: rect, maxBytes: integer, loudness: { type: 'number', minimum: -70, maximum: -5 },
    truePeak: { type: 'number', minimum: -9, maximum: 0 }, posterBeat: nonneg,
    // Web delivery: no audio stream at all (autoplay-muted media), and an explicit x264 CRF when no byte cap applies.
    silent: bool, crf: { type: 'integer', minimum: 10, maximum: 40 },
    // Byte cap for the ending loop video (defaults to maxBytes).
    loopMaxBytes: integer
}, ['id', 'width', 'height']);
const source = obj({
    id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,80}$' }, kind: { enum: ['web', 'gameboy', 'video', 'image', 'audio'] },
    path: str, metadataPath: str, fps: pos, pixelArt: bool,
    // The source carries real transparency (GIF, WebP, PNG, VP9/ProRes alpha). Layers then composite it as a cut-out, with no black key.
    alpha: bool, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    variants: array(obj({ target: str, path: str, metadataPath: str }, ['target', 'path']))
}, ['id', 'kind', 'path']);
const transition = obj({
    type: { enum: ['cut', 'dither', 'scanline-tear', 'glitch', 'match-cut', 'flash', 'datamosh', 'mosaic', 'displace', 'dissolve', 'punch', 'chroma'] }, beats: nonneg,
    pixelScale: integer, sourceRect: rect, targetRect: rect, rectSelector: str, zoomStartBeat: nonneg,
    // datamosh: block size and residual strength; mosaic: largest block; displace: peak channel offset in pixels.
    blockSize: integer, strength: nonneg, seed: uint,
    // The CRUCIBLE reference preserves its original drop/head durations.
    referenceEffect: { enum: ['cut', 'drop', 'glitch-in', 'tear', 'dither-in'] }
}, ['type']);
const text = obj({
    lines: array(str, 1), font: str, fontSize: integer, scale: integer, color: color, background: color,
    typingCps: pos, flicker: bool, x: num, y: num
}, ['lines', 'font']);
// Paint part of a source black before it is cropped: a fixed rect, or every pixel that is bright in all sampled frames
// (burned-in captions and watermarks; moving artwork is not bright everywhere, so it stays). On a black stage with
// screen/lighten/add blends, black is transparent. Exactly one of rect / staticBright per entry.
const erase = obj({
    rect,
    staticBright: obj({ above: { type: 'number', minimum: .3, maximum: 1 }, grow: { type: 'integer', minimum: 0, maximum: 64 }, samples: { type: 'integer', minimum: 1, maximum: 240 }, within: rect })
});
const blendMode = { enum: ['normal', 'add', 'screen', 'multiply', 'difference', 'lighten'] };
const visualLayer = obj({
    source: str, in: nonneg, out: nonneg, speed: nonneg, holdFrame: uint, ramp: array(point, 2), loop: bool,
    crop: rect, fit: { enum: ['contain', 'cover'] }, rect, blend: blendMode, opacity: { type: 'number', minimum: 0, maximum: 1 },
    fadeInBeats: nonneg, fadeOutBeats: nonneg, mask: { enum: ['rect', 'ellipse'] }, feather: { type: 'number', minimum: 0, maximum: 1 },
    // Slow push through the source (1 = full crop) and drift as a fraction of the source.
    scaleFrom: pos, scaleTo: pos, driftX: num, driftY: num, invert: bool, posterize: { type: 'integer', minimum: 2, maximum: 32 },
    // Levels: values at or below blackPoint (0..0.5 of full scale) become pure black, so grounds that are not quite black can sit on the stage.
    blackPoint: { type: 'number', minimum: 0, maximum: .5 },
    erase: array(erase),
    // Slide the placed piece back inside the frame if its rect would push it past an edge, so nothing is cut off.
    inside: bool,
    // Declares what the lint should check (see trailer-lint): hard-edge is checked by default for masked and screen/lighten/add layers.
    lint: obj({ check: array({ enum: ['cutoff', 'hard-edge', 'clipped', 'upscaled'] }), allow: array({ enum: ['cutoff', 'hard-edge', 'clipped', 'upscaled'] }) }),
    // Per-target placement, like rampVariants: one timeline can compose desktop and mobile frames differently.
    rectVariants: array(obj({ target: str, rect }, ['target', 'rect']))
}, ['source']);
const post = obj({
    bloom: obj({ radius: pos, gain: nonneg, threshold: { type: 'number', minimum: 0, maximum: 1 } }, ['radius', 'gain']),
    chroma: obj({ pixels: nonneg, radial: bool }, ['pixels']),
    pulse: obj({ periodBeats: pos, amount: { type: 'number', minimum: 0, maximum: .1 } }, ['periodBeats', 'amount'])
});
const shot = obj({
    id: str, startBeat: nonneg, beats: pos, kind: { enum: ['video', 'image', 'pair', 'card', 'opening', 'end', 'stage'] },
    source: str, secondSource: str, in: nonneg, out: nonneg, speed: nonneg, ramp: array(point, 2), rampVariants: array(obj({ target: str, ramp: array(point, 2) }, ['target', 'ramp'])),
    holdFrame: uint, transition, text, caption: text, layers: array(visualLayer), post,
    fit: { enum: ['contain', 'cover', 'integer'] }, pixelScale: integer, crop: rect,
    energy: bool, stutter: bool, shake: bool
}, ['id', 'startBeat', 'beats', 'kind']);
const layer = obj({
    id: str, source: str, role: { enum: ['bed', 'sfx', 'riser'] }, startBeat: nonneg, beats: pos,
    in: nonneg, out: nonneg, gain: nonneg, fadeIn: nonneg, fadeOut: nonneg, fadeOutAt: nonneg,
    duck: array(obj({ startBeat: nonneg, beats: pos, gain: nonneg, attack: nonneg, release: nonneg }, ['startBeat', 'beats', 'gain']))
}, ['id', 'source', 'role', 'startBeat']);
const tempo = obj({
    bpm: pos, beatSeconds: pos, firstDownbeat: nonneg, beats: array(nonneg, 2),
    audioSource: str, mode: { enum: ['declared', 'detected'] }, onsets: array(nonneg)
});
// The final seamBeats are authored tail that is cross-handed into the opening, and the
// output starts at the opening's seamBeats mark, so the last frame flows into the first.
const loop = obj({ seamBeats: pos, transition }, ['seamBeats', 'transition']);
// The main video plays once and ends on its last shot, which then keeps going as a second, seamlessly looping video
// (`<name>-<target>-loop.mp4`): a page plays the main video once and swaps to the loop, so the montage does not replay.
// `seconds` is the loop's length; its last `seamBeats` blend back into the frames the shot showed that long before the
// main video ended. Needs silent targets and a constant tempo.
const ending = obj({ kind: { const: 'loop' }, seconds: pos, seamBeats: pos, transition }, ['kind', 'seconds', 'seamBeats', 'transition']);
const reference = obj({
    profile: { enum: ['crucible-v3'] }, capturesRoot: str, font: str,
    title: str, subtitle: str, url: str, handle: str
}, ['profile', 'capturesRoot', 'font', 'title', 'subtitle', 'url', 'handle']);
export const TIMELINE_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://raw.githubusercontent.com/keel-web3/keel-trailer-public/main/schemas/timeline-v1.json',
    title: 'KEEL Trailer timeline v1',
    ...obj({
        version: { const: 1 }, name: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,80}$' }, fps: integer, seed: uint, tempo,
        sources: array(source, 1), shots: array(shot, 1), audio: array(layer),
        targets: array(target, 1), background: color, reference, loop, ending, brief: str
    }, ['version', 'name', 'fps', 'tempo', 'sources', 'shots', 'targets'])
};
const button = { enum: ['a', 'b', 'start', 'select', 'up', 'down', 'left', 'right'] };
const event = obj({
    frame: uint, side: { enum: ['host', 'guest'] }, action: { enum: ['press', 'release', 'write', 'mark'] },
    button, address: uint, bank: uint, value: uint, name: str
}, ['frame', 'action']);
const hook = obj({ bank: uint, readHook: uint, currentByte: uint }, ['bank', 'readHook', 'currentByte']);
export const CAPTURE_SCHEMA = obj({
    adapter: { enum: ['web', 'gameboy', 'video', 'image'] }, options: { type: 'object', additionalProperties: true },
    path: str, url: str, cinematicFlag: str, width: integer, height: integer, fps: pos, frames: integer,
    epoch: str, readySelector: str, readyAttribute: str, readyValue: str, readyFrames: uint, seed: uint,
    rectSelectors: array(str), stateAttributes: array(str), inspectionFrames: array(uint), probeGlobal: str,
    steps: array(obj({ frame: uint, action: { enum: ['click', 'scroll', 'mark'] }, selector: str, x: num, y: num, name: str, endFrame: uint, fromX: num, fromY: num }, ['frame', 'action'])),
    rom: str, guestRom: str, symbolsPath: str, reads: array(obj({ name: str, address: uint, bank: uint, symbol: str, side: { enum: ['host', 'guest'] } }, ['name'])),
    events: array(event), link: obj({ host: hook, guest: hook }, ['host', 'guest']),
    cgb: bool, warmupFrames: uint
}, ['adapter']);
const timelineInput = obj({ timeline: TIMELINE_SCHEMA, timelinePath: str });
export const TOOL_SCHEMAS = {
    ...INSPECTION_TOOL_SCHEMAS,
    ...ONCHAIN_TOOL_SCHEMAS,
    'trailer-plan': obj({ brief: str, sources: array(source, 1), bpm: pos, durationBeats: pos, targets: array(target, 1), font: str }, ['brief', 'sources']),
    'trailer-capture': obj({ capture: CAPTURE_SCHEMA, outDir: str }, ['capture', 'outDir']),
    'trailer-beats': obj({ audioPath: str, bpm: pos, beatSeconds: pos, firstDownbeat: nonneg, beats: array(nonneg, 2), outPath: str }, ['audioPath']),
    'trailer-export': obj({ ...timelineInput.properties, outDir: str, targets: array(str, 1), startTimecodeFrame: uint, attributionPaths: array(str) }, ['outDir']),
    'trailer-export-validate': obj({ packageDir: str }, ['packageDir']),
    'trailer-render': obj({ ...timelineInput.properties, outDir: str, preview: bool, targets: array(str, 1), remote: { enum: ['yuna-mbp'] } }, ['outDir']),
    'trailer-verify': obj({ ...timelineInput.properties, renderDir: str, attackToleranceMs: pos, loudnessTolerance: pos }, ['renderDir']),
    'trailer-stills': obj({ ...timelineInput.properties, outDir: str, times: array(nonneg, 1), targets: array(str, 1), remote: { enum: ['yuna-mbp'] } }, ['outDir', 'times']),
    // Static check of the composition (no render): cut-off crops, hard rectangular edges, pieces clipped by the frame, upscaling.
    'trailer-lint': obj({ ...timelineInput.properties, targets: array(str, 1), samplesPerShot: { type: 'integer', minimum: 1, maximum: 12 }, strict: bool }),
    // Real-device footage: steady it on the lit screen, push the room back, lift the screen, report the presses.
    'trailer-footage': obj({ mediaPath: str, outDir: str, options: { type: 'object' } }, ['mediaPath', 'outDir']),
    // Land cues (presses, scene changes) on the beat grid: one video shot per stretch, speed set so each cue is a beat.
    'trailer-cue-sync': obj({ cues: array({ anyOf: [nonneg, { type: 'object' }] }, 1), cuesPath: str, sourceId: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,80}$' }, sourceStart: nonneg, sourceEnd: pos, bpm: pos, grid: pos, fastGrid: pos, fastBelow: pos, maxStretch: pos, startBeat: nonneg,
        transitions: array({ enum: ['cut', 'dither', 'scanline-tear', 'glitch', 'flash', 'punch', 'chroma'] }, 1), fastTransitions: array({ enum: ['cut', 'dither', 'scanline-tear', 'glitch', 'flash', 'punch', 'chroma'] }, 1), transitionBeats: nonneg, minCueGap: nonneg, outPath: str }, ['sourceId', 'sourceEnd', 'bpm']),
    // Authored arrangement + cue hits rendered on the KEEL engine's instruments (keel-engine packages/audio).
    'trailer-score': obj({ arrangement: { type: 'object' }, arrangementPath: str, engineRoot: str, outDir: str }, ['outDir']),
};
export function schemaIssues(value: unknown, schema: JsonSchema, at: string = '$', issues: SchemaIssue[] = []) {
    if (schema.const !== undefined && value !== schema.const)
        issues.push({ path: at, message: 'wrong constant' });
    if (schema.enum && !schema.enum.includes(value))
        issues.push({ path: at, message: 'unsupported value' });
    const type = schema.type;
    const good = type === undefined || (type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
        : type === 'array' ? Array.isArray(value)
            : type === 'integer' ? Number.isSafeInteger(value)
                : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
                    : typeof value === type);
    if (!good) {
        issues.push({ path: at, message: 'expected ' + type });
        return issues;
    }
    if (type === 'object') {
        const object = value as Record<string, unknown>;
        for (const k of schema.required ?? [])
            if (!(k in object))
                issues.push({ path: at + '.' + k, message: 'required' });
        for (const [k, v] of Object.entries(object)) {
            if (schema.properties?.[k])
                schemaIssues(v, schema.properties[k], at + '.' + k, issues);
            else if (schema.additionalProperties === false)
                issues.push({ path: at + '.' + k, message: 'unknown field' });
        }
    }
    if (type === 'array') {
        const values = value as unknown[];
        if (values.length < (schema.minItems ?? 0) || values.length > (schema.maxItems ?? Infinity))
            issues.push({ path: at, message: 'array length out of range' });
        values.forEach((v, i) => schemaIssues(v, schema.items ?? {}, at + '[' + i + ']', issues));
    }
    if (typeof value === 'number' && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity) || (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum)))
        issues.push({ path: at, message: 'number out of range' });
    if (typeof value === 'string' && (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity) || (schema.pattern && !new RegExp(schema.pattern).test(value))))
        issues.push({ path: at, message: 'invalid string' });
    return issues;
}
export function assertSchema(value: unknown, schema: JsonSchema) {
    const issues = schemaIssues(value, schema);
    if (issues.length)
        throw Object.assign(new Error(JSON.stringify({ code: 'INVALID_SCHEMA', issues })), { issues });
    return value;
}
export function validateTimeline(input: unknown) {
    const t = input as Timeline;
    const issues = schemaIssues(t, TIMELINE_SCHEMA);
    if (issues.length)
        return { valid: false, issues };
    const err = (path: string, message: string) => issues.push({ path, message });
    const unique = (entries: {
        id: string;
    }[], path: string) => { const ids = new Set(); entries.forEach((x, i) => { if (ids.has(x.id))
        err(path + '[' + i + '].id', 'duplicate'); ids.add(x.id); }); return ids; };
    const ids = unique(t.sources, '$.sources');
    unique(t.shots, '$.shots');
    unique(t.targets, '$.targets');
    unique(t.audio ?? [], '$.audio');
    const tm = t.tempo;
    if (!tm.bpm && !tm.beatSeconds && !tm.beats && !tm.audioSource)
        err('$.tempo', 'provide bpm, beatSeconds, explicit beats, or audioSource');
    if (tm.bpm && tm.beatSeconds && Math.abs(60 / tm.bpm - tm.beatSeconds) > 1e-9)
        err('$.tempo', 'bpm and beatSeconds disagree');
    if (tm.onsets && tm.onsets.some((x, i) => i && x < tm.onsets![i - 1]))
        err('$.tempo.onsets', 'must be sorted');
    if (tm.beats && tm.beats.some((x, i) => i && x <= tm.beats![i - 1]))
        err('$.tempo.beats', 'must strictly increase');
    if (tm.audioSource && !t.sources.some(x => x.id === tm.audioSource && x.kind === 'audio'))
        err('$.tempo.audioSource', 'must refer to audio');
    let end = 0;
    t.shots.forEach((s, i) => {
        const at = '$.shots[' + i + ']';
        if (Math.abs(s.startBeat - end) > 1e-8)
            err(at + '.startBeat', 'shots must cover the timeline consecutively without gaps or overlap');
        end = s.startBeat + s.beats;
        if (s.kind === 'card' && !s.text)
            err(at + '.text', 'card requires text');
        if (s.kind === 'stage' && !s.layers?.length)
            err(at + '.layers', 'stage requires at least one layer');
        if (s.kind === 'stage' && s.source)
            err(at + '.source', 'stage composes layers only');
        if (!['card', 'stage'].includes(s.kind) && (!s.source || !ids.has(s.source)))
            err(at + '.source', 'unknown source');
        for (const [j, l] of (s.layers ?? []).entries()) {
            const lat = at + '.layers[' + j + ']';
            if (!ids.has(l.source) || t.sources.find(x => x.id === l.source)?.kind === 'audio')
                err(lat + '.source', 'must refer to a visual source');
            if (l.in !== undefined && l.out !== undefined && l.out <= l.in)
                err(lat + '.out', 'must exceed in');
            if (l.ramp && (l.ramp[0].beat !== 0 || l.ramp.at(-1)!.beat !== s.beats || l.ramp.some((p, k) => k && p.beat <= l.ramp![k - 1].beat)))
                err(lat + '.ramp', 'ramp must span 0..beats in increasing beat order');
            if ((l.fadeInBeats ?? 0) + (l.fadeOutBeats ?? 0) > s.beats)
                err(lat, 'layer fades exceed shot');
            for (const v of l.rectVariants ?? [])
                if (!t.targets.some(x => x.id === v.target))
                    err(lat + '.rectVariants', 'unknown target');
            for (const [k, e] of (l.erase ?? []).entries())
                if (Number(!!e.rect) + Number(!!e.staticBright) !== 1)
                    err(lat + '.erase[' + k + ']', 'provide exactly one of rect or staticBright');
        }
        if (s.kind === 'stage' && s.transition?.type === 'match-cut')
            err(at + '.transition', 'match-cut needs a single source shot');
        if (s.source && t.sources.find(x => x.id === s.source)?.kind === 'audio')
            err(at + '.source', 'visual shot cannot use audio');
        if (s.kind === 'pair' && (!s.secondSource || !ids.has(s.secondSource)))
            err(at + '.secondSource', 'pair requires second source');
        if (['opening', 'end'].includes(s.kind) && !t.reference)
            err(at + '.kind', 'requires crucible-v3 profile');
        if (!t.reference && (['energy', 'stutter', 'shake'] as const).some(k => s[k]))
            err(at, 'energy/stutter/shake belong to the reference profile; use declared transitions or ramps in generic edits');
        if (s.in !== undefined && s.out !== undefined && s.out <= s.in)
            err(at + '.out', 'must exceed in');
        for (const v of s.rampVariants ?? []) {
            if (!t.targets.some(t => t.id === v.target))
                err(at + '.rampVariants', 'unknown target');
            if (v.ramp[0].beat !== 0 || v.ramp.at(-1)!.beat !== s.beats || v.ramp.some((p, j) => j && p.beat <= v.ramp[j - 1].beat))
                err(at + '.rampVariants', 'ramp must span 0..beats in increasing order');
        }
        if (s.ramp && (s.ramp[0].beat !== 0 || s.ramp.at(-1)!.beat !== s.beats || s.ramp.some((p, j) => j && p.beat <= s.ramp![j - 1].beat)))
            err(at + '.ramp', 'ramp must span 0..beats in increasing beat order');
        if (s.transition?.type === 'match-cut' && !(s.transition.sourceRect || s.transition.rectSelector))
            err(at + '.transition', 'match-cut requires sourceRect or rectSelector');
        if (s.transition?.type === 'match-cut' && !s.transition.targetRect)
            err(at + '.transition.targetRect', 'required');
        if ((s.transition?.beats ?? 0) > s.beats)
            err(at + '.transition.beats', 'transition exceeds shot');
        if (s.transition?.zoomStartBeat !== undefined && s.transition.zoomStartBeat >= s.beats)
            err(at + '.transition.zoomStartBeat', 'must precede shot end');
    });
    for (const [i, l] of (t.audio ?? []).entries()) {
        if (!t.sources.some(x => x.id === l.source && x.kind === 'audio'))
            err('$.audio[' + i + '].source', 'must refer to audio');
        if (l.startBeat >= end)
            err('$.audio[' + i + '].startBeat', 'outside timeline');
        if (l.in !== undefined && l.out !== undefined && l.out <= l.in)
            err('$.audio[' + i + '].out', 'must exceed in');
    }
    if (t.loop) {
        if (t.reference)
            err('$.loop', 'loop belongs to the generic profile');
        if (t.loop.seamBeats >= end)
            err('$.loop.seamBeats', 'must be shorter than the timeline');
        if (t.shots[0] && t.loop.seamBeats >= t.shots[0].beats)
            err('$.loop.seamBeats', 'must be shorter than the opening shot, which is the seam target');
        if (t.loop.transition.type === 'match-cut')
            err('$.loop.transition.type', 'match-cut cannot bridge a loop seam');
        if ((t.loop.transition.beats ?? t.loop.seamBeats) > t.loop.seamBeats)
            err('$.loop.transition.beats', 'exceeds seam');
    }
    if (t.ending) {
        const at = '$.ending', last = t.shots.at(-1)!, beatSeconds = tm.beatSeconds ?? (tm.bpm ? 60 / tm.bpm : undefined);
        if (t.reference)
            err(at, 'ending belongs to the generic profile');
        if (t.loop)
            err(at, 'use either loop (the whole video loops) or ending (play once, then loop the last shot), not both');
        if (beatSeconds === undefined || tm.beats)
            err('$.tempo', 'ending needs a constant tempo (bpm or beatSeconds)');
        if (last.kind !== 'stage')
            err('$.shots[' + (t.shots.length - 1) + '].kind', 'the ending loop continues the final shot, which must be a stage shot');
        if (t.ending.seamBeats > last.beats)
            err(at + '.seamBeats', 'must not exceed the final shot, whose last frames the seam returns to');
        if (beatSeconds !== undefined && t.ending.seamBeats * beatSeconds >= t.ending.seconds)
            err(at + '.seconds', 'must be longer than the seam');
        if (t.ending.transition.type === 'match-cut')
            err(at + '.transition.type', 'match-cut cannot bridge a loop seam');
        if ((t.ending.transition.beats ?? t.ending.seamBeats) > t.ending.seamBeats)
            err(at + '.transition.beats', 'exceeds seam');
        if (last.post?.pulse)
            err('$.shots[' + (t.shots.length - 1) + '].post.pulse', 'a beat pulse breaks the loop seam; remove it from the final shot');
        for (const [j, l] of (last.layers ?? []).entries()) {
            const lat = '$.shots[' + (t.shots.length - 1) + '].layers[' + j + ']';
            if (l.ramp)
                err(lat + '.ramp', 'ramps do not continue into a loop');
            if (l.fadeOutBeats)
                err(lat + '.fadeOutBeats', 'a fade out ends the piece; the loop must stay steady');
            if (l.driftX || l.driftY)
                err(lat, 'drift does not hold steady in a loop');
        }
        for (const [i, o] of t.targets.entries())
            if (!o.silent)
                err('$.targets[' + i + '].silent', 'the ending loop is a silent web delivery');
    }
    for (const [i, o] of t.targets.entries()) {
        if (o.width % 2 || o.height % 2)
            err('$.targets[' + i + ']', 'H.264 dimensions must be even');
        const r = o.safeArea;
        if (r && (r.x < 0 || r.y < 0 || r.x + r.width > o.width || r.y + r.height > o.height))
            err('$.targets[' + i + '].safeArea', 'outside output');
        if (o.posterBeat !== undefined && o.posterBeat >= end)
            err('$.targets[' + i + '].posterBeat', 'outside timeline');
        if (o.posterBeat !== undefined && t.loop && o.posterBeat < t.loop.seamBeats)
            err('$.targets[' + i + '].posterBeat', 'falls in the loop lead-in that is not part of the output');
    }
    return { valid: issues.length === 0, issues };
}
export function assertTimeline(input: unknown) {
    const t = input as Timeline;
    const r = validateTimeline(t);
    if (!r.valid)
        throw Object.assign(new Error(JSON.stringify({ code: 'INVALID_TIMELINE', issues: r.issues })), { issues: r.issues });
    return t;
}
