import type { JsonSchema, ObjectSchema } from './contracts.js';
const str = { type: 'string', minLength: 1, maxLength: 4096 };
const id = { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,80}$' };
const number = { type: 'number' }, uint = { type: 'integer', minimum: 0 }, positive = { type: 'integer', minimum: 1 };
const object = (properties: Record<string, JsonSchema>, required: string[] = []): ObjectSchema => ({ type: 'object', properties, required, additionalProperties: false });
const list = (items: JsonSchema, minItems = 0, maxItems = 2000000) => ({ type: 'array', items, minItems, maxItems });
const rect = object({ x: uint, y: uint, width: positive, height: positive }, ['x', 'y', 'width', 'height']);
const mesh = object({ id, positions: list(number, 3), indices: list(uint), attributes: { type: 'object', additionalProperties: true }, metadata: { type: 'object', additionalProperties: true } }, ['id', 'positions', 'indices']);
const node = object({ id: str, label: str, position: list(number, 2, 3), data: { type: 'object', additionalProperties: true } }, ['id']);
const edge = object({ id: str, from: str, to: str, directed: { type: 'boolean' }, points: list(list(number, 2, 3)), data: { type: 'object', additionalProperties: true } }, ['id', 'from', 'to']);
const graph = object({ id, nodes: list(node), edges: list(edge), metadata: { type: 'object', additionalProperties: true } }, ['id', 'nodes', 'edges']);
const grid = object({ id, width: positive, height: positive, channels: { type: 'object', additionalProperties: true }, metadata: { type: 'object', additionalProperties: true } }, ['id', 'width', 'height', 'channels']);
export const INSPECTION_SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'KEEL inspection snapshot',
    ...object({ version: { const: 1 }, schema: { const: 'keel-inspection@1' }, frame: uint, seconds: { type: 'number', minimum: 0 },
        meshes: list(mesh, 0, 1000), graphs: list(graph, 0, 1000), grids: list(grid, 0, 1000), state: { type: 'object', additionalProperties: true }, metadata: { type: 'object', additionalProperties: true } }, ['version', 'schema'])
};
const view = object({ id, crop: rect, scale: { type: 'integer', minimum: 1, maximum: 32 } }, ['id']);
const remote = { enum: ['yuna-mbp'] };
const sizes = { width: { type: 'integer', minimum: 128, maximum: 2048 }, height: { type: 'integer', minimum: 128, maximum: 2048 } };
export const INSPECTION_TOOL_SCHEMAS = {
    'trailer-snapshot': object({ mediaPath: str, timelinePath: str, timeline: { type: 'object', additionalProperties: true }, target: str,
        times: list({ type: 'number', minimum: 0 }, 1, 120), frames: list(uint, 1, 120), views: list(view, 1, 24), pixelData: { type: 'boolean' }, outDir: str, remote }, ['outDir']),
    'trailer-clip': object({ mediaPath: str, startFrame: uint, endFrame: positive, crop: rect, scale: { type: 'integer', minimum: 1, maximum: 32 }, includeAudio: { type: 'boolean' }, outDir: str, remote }, ['mediaPath', 'startFrame', 'endFrame', 'outDir']),
    'trailer-inspect': object({ snapshot: INSPECTION_SCHEMA, snapshotPath: str, outDir: str, remote, ...sizes,
        views: list(object({ id, kind: { enum: ['mesh', 'graph', 'grid'] }, objectId: id, projection: { enum: ['front', 'top', 'side', 'iso'] }, channel: str }, ['id', 'kind', 'objectId']), 0, 64),
        queries: list(object({ pointer: { type: 'string', maxLength: 4096 }, start: uint, count: { type: 'integer', minimum: 1, maximum: 10000 } }, ['pointer']), 0, 100) }, ['outDir'])
};
