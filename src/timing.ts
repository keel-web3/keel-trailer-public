import type { Shot, Tempo } from './timeline.js';
export function beatToSeconds(tempo: Tempo, beat: number) {
    if (!Number.isFinite(beat) || beat < 0)
        throw Error('beat must be nonnegative');
    if (tempo.beats) {
        const a = tempo.beats, i = Math.floor(beat), f = beat - i;
        if (i >= a.length - 1)
            return a.at(-1)! + (beat - (a.length - 1)) * (a.at(-1)! - a.at(-2)!);
        return a[i] + f * (a[i + 1] - a[i]);
    }
    const period = tempo.beatSeconds ?? 60 / tempo.bpm!;
    if (!(period > 0 && Number.isFinite(period)))
        throw Error('tempo has not been resolved');
    return (tempo.firstDownbeat ?? 0) + beat * period;
}
export function editSeconds(tempo: Tempo, beat: number) { return beatToSeconds(tempo, beat) - beatToSeconds(tempo, 0); }
export function boundaryFrame(seconds: number, fps: number) { return Math.ceil(seconds * fps - 1e-9); }
export function sourceFrame(shot: Shot, localBeat: number, localSeconds: number, sourceFps: number = 30) {
    if (shot.holdFrame !== undefined)
        return shot.holdFrame;
    const keys = shot.ramp;
    if (keys) {
        let i = 0;
        while (i < keys.length - 2 && localBeat > keys[i + 1].beat)
            i++;
        const a = keys[i], b = keys[i + 1], p = Math.max(0, Math.min(1, (localBeat - a.beat) / (b.beat - a.beat)));
        return Math.round(a.frame + (b.frame - a.frame) * p);
    }
    let time = (shot.in ?? 0) + localSeconds * (shot.speed ?? 1);
    if (shot.out !== undefined)
        time = Math.min(time, shot.out - 1 / sourceFps);
    return Math.max(0, Math.floor(time * sourceFps + 1e-9));
}
