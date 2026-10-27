import type { Shot } from './timeline.js';
export interface CueSyncInput {
    cues: (number | {
        seconds: number;
    })[];
    sourceId: string;
    sourceStart?: number;
    sourceEnd: number;
    bpm: number;
    grid?: number;
    fastGrid?: number;
    fastBelow?: number;
    maxStretch?: number;
    startBeat?: number;
    transitions?: NonNullable<Shot['transition']>['type'][];
    fastTransitions?: NonNullable<Shot['transition']>['type'][];
    transitionBeats?: number;
    minCueGap?: number;
}
// Put real-world cues (button presses, scene changes found by trailer-footage) on the music's grid. Each stretch of
// footage between two cues becomes one video shot whose speed lands the next cue exactly on a beat; the cue is the
// shot's first frame, so the transition and the hit fall on the same frame. Long gaps snap to `grid` beats, quick
// bursts to `fastGrid`, and no stretch changes speed by more than maxStretch unless the grid makes it unavoidable.
export function syncCues({ cues, sourceId, sourceStart = 0, sourceEnd, bpm, grid = 1, fastGrid = 0.5, fastBelow = 1.2, maxStretch = 0.12, startBeat = 0, transitions = ['flash'], fastTransitions, transitionBeats = 0.5, minCueGap = 0.15 }: CueSyncInput) {
    if (!Array.isArray(cues) || !cues.length)
        throw Error('syncCues needs cues');
    if (!(bpm > 0))
        throw Error('syncCues needs bpm');
    if (!(sourceEnd > sourceStart))
        throw Error('syncCues needs sourceEnd after sourceStart');
    const beat = 60 / bpm, times = [...new Set(cues.map(c => typeof c === 'number' ? c : c.seconds))].filter(t => t > sourceStart && t < sourceEnd).sort((a, b) => a - b);
    const kept: number[] = [];
    for (const t of times)
        if (!kept.length || t - kept.at(-1)! >= minCueGap)
            kept.push(t);
    const points = [sourceStart, ...kept, sourceEnd], beats = [startBeat];
    const warnings = [];
    for (let i = 1; i < points.length; i++) {
        const src = points[i] - points[i - 1], g = src < fastBelow ? fastGrid : grid, want = src / beat;
        let b = Math.max(g, Math.round(want / g) * g);
        // try the neighbouring grid steps if the rounded one stretches too far
        for (const alt of [b, b - g, b + g])
            if (alt >= g && Math.abs(src / (alt * beat) - 1) <= maxStretch) {
                b = alt;
                break;
            }
        const speed = src / (b * beat);
        if (Math.abs(speed - 1) > maxStretch)
            warnings.push(`cue ${i}: speed ${speed.toFixed(3)} (grid ${g})`);
        beats.push(beats.at(-1)! + b);
    }
    const fast = fastTransitions ?? transitions;
    const shots = [];
    for (let i = 0; i < points.length - 1; i++) {
        const src = points[i + 1] - points[i], len = beats[i + 1] - beats[i], quick = i > 0 && points[i] - points[i - 1] < fastBelow; // pressed hard on the last one
        const pool = quick ? fast : transitions, shot: Shot = { id: `cue-${String(i).padStart(2, '0')}`, kind: 'video', source: sourceId, startBeat: beats[i], beats: len, in: +points[i].toFixed(6), speed: +(src / (len * beat)).toFixed(6), fit: 'cover' };
        if (i > 0)
            shot.transition = { type: pool[(i - 1) % pool.length], beats: Math.min(transitionBeats, len / 2) };
        shots.push(shot);
    }
    const cueBeats = beats.slice(1, -1).map((b, i) => ({ beat: b, seconds: +(b * beat).toFixed(6), source: kept[i], gap: +(kept[i] - points[i]).toFixed(4), index: i }));
    return { tempo: { bpm }, beatSeconds: beat, shots, cueBeats, endBeat: beats.at(-1)!, warnings };
}
