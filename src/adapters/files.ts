import type { CaptureRequest } from '../contracts.js';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
export async function fileCapture(c: CaptureRequest, outDir: string) {
    if (!c.path)
        throw Error('File capture requires path');
    await mkdir(outDir, { recursive: true });
    const dest = path.join(outDir, c.adapter + path.extname(c.path!));
    if (path.resolve(c.path) !== path.resolve(dest))
        await copyFile(c.path!, dest);
    const result = { adapter: c.adapter, path: dest, bytes: (await stat(dest)).size, sha256: createHash('sha256').update(await readFile(dest)).digest('hex') };
    await writeFile(path.join(outDir, 'capture.json'), JSON.stringify(result, null, 2) + '\n');
    return result;
}
