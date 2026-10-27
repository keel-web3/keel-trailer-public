import type { JsonSchema, ObjectSchema } from './contracts.js';
const str = { type: 'string', minLength: 1, maxLength: 4096 };
const obj = (properties: Record<string, JsonSchema>, required: string[] = []): ObjectSchema => ({ type: 'object', properties, required, additionalProperties: false });
const data = { type: 'object' };
export const ONCHAIN_TOOL_SCHEMAS = {
    'trailer-onchain-reuse-review': obj({ bundleDir: str, referencePath: str, sourceManifestPath: str, sourceRoots: { type: 'array', minItems: 1, maxItems: 16, items: obj({ path: str, prefix: str }, ['path', 'prefix']) }, outDir: str }, ['bundleDir', 'referencePath', 'sourceManifestPath', 'sourceRoots', 'outDir']),
    'trailer-onchain': obj({ project: data, projectPath: str, engineRoot: str, sdkRoot: str, outDir: str }, ['outDir']),
    'trailer-onchain-prepare': obj({ bundleDir: str, outDir: str, sdkRoot: str, localProof: { type: 'boolean', const: true }, metadata: data, imagePath: str }, ['bundleDir', 'outDir', 'localProof']),
    'trailer-onchain-render': obj({ bundleDir: str, preparedDir: str, outDir: str, scale: { type: 'integer', minimum: 1, maximum: 12 }, crf: { type: 'integer', minimum: 0, maximum: 28 }, readyTimeoutMs: { type: 'integer', minimum: 1000, maximum: 300000 } }, ['bundleDir', 'outDir']),
    'trailer-onchain-live-test': obj({ bundleDir: str, preparedDir: str, outDir: str, readyTimeoutMs: { type: 'integer', minimum: 1000, maximum: 300000 } }, ['bundleDir', 'outDir']),
    'trailer-onchain-test': obj({ bundleDir: str, preparedDir: str, outDir: str, readyTimeoutMs: { type: 'integer', minimum: 1000, maximum: 300000 } }, ['bundleDir', 'outDir']),
    'trailer-music': obj({ midiPath: str, score: data, recipe: data, engineRoot: str, outDir: str }, ['outDir']),
    'trailer-audio-test': obj({ referencePath: str, candidatePath: str, outDir: str }, ['referencePath', 'candidatePath', 'outDir'])
};
