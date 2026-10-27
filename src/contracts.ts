export type JsonValue = null | boolean | number | string | JsonValue[] | {
    [key: string]: JsonValue;
};
export type JsonObject = Record<string, unknown>;
/** JSON Schema vocabulary implemented by the runtime validator. */
export interface JsonSchema {
    type?: string;
    const?: unknown;
    enum?: unknown[];
    properties?: Record<string, JsonSchema>;
    required?: string[];
    additionalProperties?: boolean;
    items?: JsonSchema;
    minItems?: number;
    maxItems?: number;
    minimum?: number;
    maximum?: number;
    exclusiveMinimum?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    anyOf?: JsonSchema[];
    $schema?: string;
    $id?: string;
    title?: string;
}
export interface ObjectSchema extends JsonSchema {
    type: 'object';
    properties: Record<string, JsonSchema>;
    required: string[];
    additionalProperties: boolean;
}
export interface SchemaIssue {
    path: string;
    message: string;
}
export interface WorkerOptions {
    python?: string;
    log?: (message: string) => void;
    signal?: AbortSignal;
}
export interface ToolOptions extends WorkerOptions {
    workspaceRoot?: string;
    checkMachineLoad?: boolean;
    allowOffload?: boolean;
}
export type CaptureRequest = {
    "adapter": string;
    "options"?: Record<string, unknown>;
    "path"?: string;
    "url"?: string;
    "cinematicFlag"?: string;
    "width"?: number;
    "height"?: number;
    "fps"?: number;
    "frames"?: number;
    "epoch"?: string;
    "readySelector"?: string;
    "readyAttribute"?: string;
    "readyValue"?: string;
    "readyFrames"?: number;
    "seed"?: number;
    "rectSelectors"?: (string)[];
    "stateAttributes"?: (string)[];
    "inspectionFrames"?: (number)[];
    "probeGlobal"?: string;
    "steps"?: ({
        "frame": number;
        "action": "click" | "scroll" | "mark";
        "selector"?: string;
        "x"?: number;
        "y"?: number;
        "name"?: string;
        "endFrame"?: number;
        "fromX"?: number;
        "fromY"?: number;
    })[];
    "rom"?: string;
    "guestRom"?: string;
    "symbolsPath"?: string;
    "reads"?: ({
        "name": string;
        "address"?: number;
        "bank"?: number;
        "symbol"?: string;
        "side"?: "host" | "guest";
    })[];
    "events"?: ({
        "frame": number;
        "side"?: "host" | "guest";
        "action": "press" | "release" | "write" | "mark";
        "button"?: "a" | "b" | "start" | "select" | "up" | "down" | "left" | "right";
        "address"?: number;
        "bank"?: number;
        "value"?: number;
        "name"?: string;
    })[];
    "link"?: {
        "host": {
            "bank": number;
            "readHook": number;
            "currentByte": number;
        };
        "guest": {
            "bank": number;
            "readHook": number;
            "currentByte": number;
        };
    };
    "cgb"?: boolean;
    "warmupFrames"?: number;
};
export interface CaptureResult extends JsonObject {
    adapter?: string;
    path?: string;
    metadataPath?: string;
    sha256?: string;
    bytes?: number;
    frames?: number;
}
export interface CaptureContext {
    worker: (operation: string, input: unknown) => Promise<JsonObject>;
}
export type CaptureAdapter = (capture: CaptureRequest, outDir: string, context: CaptureContext) => Promise<CaptureResult>;
export interface McpContext {
    workspace: {
        root: string;
    };
}
export interface McpPlugin {
    apiVersion: 1;
    id: string;
    version: string;
    instructions: string;
    tools: {
        descriptor: {
            name: string;
            description: string;
            inputSchema: JsonSchema;
        };
        run(context: McpContext, input: unknown): Promise<unknown>;
    }[];
}
/** Structural subset of the canonical keel/codec API; no runtime codec is copied. */
export interface CodecType<V = unknown> {
    readonly kind: 'uint' | 'int' | 'bool' | 'fixed' | 'float' | 'enum' | 'varuint' | 'varint' | 'string' | 'ref' | 'bytes' | 'hex' | 'biguint' | 'array' | 'optional' | 'nullable' | 'default' | 'struct' | 'tuple' | 'union' | 'alt' | 'map' | 'delta' | 'runs' | 'planes' | 'dyn' | 'num' | 'const' | 'named' | 'rec' | 'self' | 'lz' | 'grow';
    readonly __value?: V;
}
export interface CodecApi {
    named(name: string, schema: CodecType): CodecType;
    struct(fields: Record<string, CodecType>): CodecType;
    uint(bits: number): CodecType<number>;
    varuint(): CodecType<number>;
    array(item: CodecType, options: {
        max: number;
    }): CodecType;
    enumOf(values: readonly (string | number | boolean)[]): CodecType;
    string(options: {
        max: number;
    }): CodecType;
    num(): CodecType<number>;
    union(tag: string, variants: Record<string, CodecType>): CodecType;
    dyn?(): CodecType;
    encode(schema: CodecType, value: unknown): Uint8Array;
    decode(schema: CodecType, bytes: Uint8Array): unknown;
}
export const errorCode = (error: unknown): string | undefined => error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
export const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
export type WorkerFunction = <T extends JsonObject = JsonObject>(operation: string, input: unknown) => Promise<T>;
export interface WorkerReport extends JsonObject {
    snapshotPath?: string;
    snapshotSha256?: string;
    queries?: unknown[];
    viewer?: string;
    path?: string;
    previewPath?: string;
    stills?: {
        path: string;
        [key: string]: unknown;
    }[];
}
export interface InspectInput {
    snapshot: import('./probe.js').InspectionSnapshot;
    outDir: string;
    queries?: {
        pointer: string;
        start?: number;
        count?: number;
    }[];
}
export interface SnapshotInput extends JsonObject {
    outDir: string;
}
export interface ClipInput extends JsonObject {
    outDir: string;
}
export interface OffloadInput extends JsonObject {
    timeline?: import('./timeline.js').Timeline;
    mediaPath?: string;
    outDir: string;
    remote?: string;
}
export interface EngineModule {
    packageName: string;
    manifest: {
        id: string;
        version: string;
        needs: string[];
        provides: string[];
    };
}
export interface EngineToolkit {
    root: string;
    codec: CodecApi;
    readWorkspace(root: string): Promise<EngineModule[]>;
    bundleModule(module: EngineModule, workspace: EngineModule[]): Promise<{
        code: string;
        manifest: EngineModule['manifest'];
    }>;
    splitRef(ref: string): {
        name: string;
        range: string;
    };
    satisfies(range: string, desired: string): boolean;
    createEngine(): {
        define(manifest: EngineModule['manifest'], factory: () => unknown): void;
        resolve(): {
            ok: boolean;
            problems?: unknown;
            order: string[];
        };
    };
    build: typeof import('esbuild').build;
    transform: typeof import('esbuild').transform;
}
