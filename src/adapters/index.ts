import type { CaptureAdapter, CaptureContext, CaptureRequest, JsonSchema } from '../contracts.js';
// Additional adapters implement (capture, outDir, context) -> structured artifacts.
import { assertSchema, CAPTURE_SCHEMA } from '../schema.js';
import { fileCapture } from './files.js';
import { webCapture } from './web.js';
const optionsSchemas = new Map<string, JsonSchema>();
const adapters = new Map<string, CaptureAdapter>([['web', webCapture], ['video', fileCapture], ['image', fileCapture]]);
export function registerCaptureAdapter(name: string, adapter: CaptureAdapter, optionsSchema: JsonSchema = { type: 'object', additionalProperties: false }) {
    if (!/^[a-z][a-z0-9-]*$/.test(name) || typeof adapter !== 'function')
        throw Error('Invalid adapter');
    if (adapters.has(name))
        throw Error('Adapter already registered: ' + name);
    adapters.set(name, adapter);
    optionsSchemas.set(name, optionsSchema);
    CAPTURE_SCHEMA.properties.adapter.enum!.push(name);
}
export async function captureWithAdapter(c: CaptureRequest, outDir: string, context: CaptureContext) {
    if (c.adapter === 'gameboy')
        return context.worker('gameboy', { capture: c, outDir });
    const adapter = adapters.get(c.adapter);
    if (!adapter)
        throw Error('Unknown capture adapter');
    if (optionsSchemas.has(c.adapter))
        assertSchema(c.options ?? {}, optionsSchemas.get(c.adapter)!);
    return adapter(c, outDir, context);
}
