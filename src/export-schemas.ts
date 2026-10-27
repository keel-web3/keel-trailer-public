import { mkdir, writeFile } from 'node:fs/promises';
import { INSPECTION_SCHEMA } from './inspection-schema.js';
import { CAPTURE_SCHEMA, TIMELINE_SCHEMA, TOOL_SCHEMAS } from './schema.js';
const out = new URL('../schemas/', import.meta.url);
await mkdir(out, { recursive: true });
for (const [name, data] of Object.entries({ inspection: INSPECTION_SCHEMA, 'timeline-v1': TIMELINE_SCHEMA, capture: CAPTURE_SCHEMA, tools: TOOL_SCHEMAS }))
    await writeFile(new URL(name + '.json', out), JSON.stringify(data, null, 2) + '\n');
