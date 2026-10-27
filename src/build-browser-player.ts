import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
export async function buildBrowserPlayer(build: typeof import('esbuild').build) {
    const worker = await build({ entryPoints: [path.join(here, 'render-worker.js')], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022', minify: true, legalComments: 'none' });
    return build({ entryPoints: [path.join(here, 'browser-player.js')], bundle: true, write: false, format: 'iife', globalName: 'KEEL_TRAILER_PLAYER', platform: 'browser', target: 'es2022', minify: true, legalComments: 'inline', define: { __KEEL_TRAILER_RENDER_WORKER_SOURCE__: JSON.stringify(worker.outputFiles[0].text) } });
}
