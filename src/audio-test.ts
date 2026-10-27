import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { digest, localFile } from './onchain.js';
export function compareAudio(reference: Float32Array, candidate: Float32Array, rate: number = 22050) {
    if (!reference.length || !candidate.length || reference.length > rate * 120 || candidate.length > rate * 120)
        throw RangeError('Audio comparison requires nonempty clips up to 120 seconds');
    const features = (x: ArrayLike<number>) => { let energy = 0, peak = 0, clipped = 0; const envelope = []; const hop = Math.round(rate * .01); for (let i = 0; i < x.length; i += hop) {
        let e = 0;
        for (let j = i; j < Math.min(i + hop, x.length); j++) {
            const v = x[j];
            if (!Number.isFinite(v))
                throw TypeError('Nonfinite audio');
            e += v * v;
            peak = Math.max(peak, Math.abs(v));
            if (Math.abs(v) >= .999)
                clipped++;
        }
        energy += e;
        envelope.push(Math.sqrt(e / Math.min(hop, x.length - i)));
    } return { duration: x.length / rate, rms: Math.sqrt(energy / x.length), peak, clippedFraction: clipped / x.length, envelope }; };
    const a = features(reference), b = features(candidate);
    const similarity = (x: ArrayLike<number>, y: ArrayLike<number>) => { let xx = 0, yy = 0, xy = 0; for (let i = 0; i < Math.min(x.length, y.length); i++) {
        xx += x[i] * x[i];
        yy += y[i] * y[i];
        xy += x[i] * y[i];
    } return xx && yy ? xy / Math.sqrt(xx * yy) : 0; };
    let best = -Infinity, lag = 0;
    for (let shift = -50; shift <= 50; shift++) {
        const c = similarity(a.envelope.slice(Math.max(0, shift)), b.envelope.slice(Math.max(0, -shift)));
        if (c > best + 1e-12 || (Math.abs(c - best) < 1e-12 && Math.abs(shift) < Math.abs(lag))) {
            best = c;
            lag = shift;
        }
    }
    const waveformCorrelation = similarity(reference, candidate), durationErrorMs = Math.abs(a.duration - b.duration) * 1000, rmsDifferenceDb = 20 * Math.log10((b.rms + 1e-12) / (a.rms + 1e-12));
    const checks = { duration: durationErrorMs <= 50, signal: a.rms > 1e-5 && b.rms > 1e-5, clipping: b.clippedFraction < .001, timing: Math.abs(lag) * 10 <= 50 };
    const { envelope: _, ...ref } = a, { envelope: __, ...cand } = b;
    return { schema: 'keel-trailer-audio-test@1', technicalPass: Object.values(checks).every(Boolean), checks, metrics: { durationErrorMs, rmsDifferenceDb, envelopeCosine: similarity(a.envelope, b.envelope), bestEnvelopeCosine: best, envelopeLagMs: lag * 10, waveformCosine: waveformCorrelation }, reference: ref, candidate: cand, perceptualEquivalence: 'not-established', auditionRequired: true, notes: ['Envelope timing does not establish correct notes, timbre, mix or melody. Listen to both files before accepting a conversion.', 'No automatic gain or time alignment was applied to the delivered audio.'] };
}
async function pcm(file: string) { return new Promise<Float32Array>((resolve, reject) => { const proc = spawn(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-v', 'error', '-i', file, '-vn', '-t', '120.01', '-ac', '1', '-ar', '22050', '-f', 'f32le', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] }); const chunks: Buffer[] = []; let count = 0, error = ''; const timer = setTimeout(() => { proc.kill(); reject(Error('Audio decode timeout')); }, 30000); proc.stdout.on('data', b => { count += b.length; if (count > 22050 * 121 * 4) {
    proc.kill();
    reject(Error('Audio decode budget exceeded'));
}
else
    chunks.push(b); }); proc.stderr.on('data', b => error = (error + b).slice(-2000)); proc.on('error', e => { clearTimeout(timer); reject(e); }); proc.on('close', code => { clearTimeout(timer); if (code !== 0)
    return reject(Error(error)); const b = Buffer.concat(chunks), out = new Float32Array(b.length / 4); for (let i = 0; i < out.length; i++)
    out[i] = b.readFloatLE(i * 4); resolve(out); }); }); }
export async function testAudioConversion({ referencePath, candidatePath, outDir }: {
    referencePath: string;
    candidatePath: string;
    outDir: string;
}, { workspaceRoot }: {
    workspaceRoot: string;
}) {
    await mkdir(outDir, { recursive: true });
    const ref = await localFile(workspaceRoot, referencePath), cand = await localFile(workspaceRoot, candidatePath);
    if ((await stat(ref)).size > 32000000 || (await stat(cand)).size > 32000000)
        throw RangeError('Audio comparison file exceeds 32 MB');
    const [a, b] = await Promise.all([pcm(ref), pcm(cand)]);
    const report = compareAudio(a, b);
    const ext = (p: string) => /^\.[a-z0-9]{1,8}$/i.test(path.extname(p)) ? path.extname(p) : '.audio';
    const rp = 'reference' + ext(ref), cp = 'candidate' + ext(cand);
    await copyFile(ref, path.join(outDir, rp));
    await copyFile(cand, path.join(outDir, cp));
    (report.reference as typeof report.reference & {
        sha256: string;
    }).sha256 = digest(await readFile(ref));
    (report.candidate as typeof report.candidate & {
        sha256: string;
    }).sha256 = digest(await readFile(cand));
    await writeFile(path.join(outDir, 'audio-test.json'), JSON.stringify(report, null, 2) + '\n');
    await writeFile(path.join(outDir, 'audition.html'), '<!doctype html><meta charset="utf-8"><title>Music conversion audition</title><h1>Music conversion audition</h1><p>Reference</p><audio controls src="' + rp + '"></audio><p>Reconstruction</p><audio controls src="' + cp + '"></audio><p>Compare melody, rhythm, bass, drums, synth character and transitions. Metrics do not replace listening.</p>');
    return { ...report, reportPath: path.join(outDir, 'audio-test.json'), auditionPath: path.join(outDir, 'audition.html') };
}
