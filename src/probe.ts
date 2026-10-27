export interface GraphInput {
    nodes: readonly {
        id: string | number;
        label?: string;
        position?: ArrayLike<number>;
        x?: number;
        y?: number;
        z?: number;
        data?: unknown;
    }[];
    edges: readonly {
        id?: string | number;
        from?: string | number;
        a?: string | number;
        to?: string | number;
        b?: string | number;
        directed?: boolean;
        oneWay?: boolean;
        points?: readonly ArrayLike<number>[];
        path?: {
            x: ArrayLike<number>;
            z: ArrayLike<number>;
        };
        data?: unknown;
    }[];
    bounds?: unknown;
    at?: unknown;
}
export interface GridInput {
    width: number;
    depth?: number;
    rows?: number;
    height?: number | ArrayLike<number>;
    channels?: Record<string, ArrayLike<number>>;
    type?: ArrayLike<number>;
    flags?: ArrayLike<number>;
    dir?: ArrayLike<number>;
    water?: ArrayLike<number>;
    deck?: ArrayLike<number>;
    tileSize?: number;
    stepHeight?: number;
    chunk?: unknown;
    version?: unknown;
    id?: unknown;
}
export interface InspectionMesh {
    id: string;
    positions: number[];
    indices: number[];
    attributes?: Record<string, number[]>;
    metadata?: Record<string, unknown>;
}
export interface InspectionNode {
    id: string;
    label?: string;
    position?: number[];
    data?: Record<string, unknown>;
}
export interface InspectionEdge {
    id: string;
    from: string;
    to: string;
    directed?: boolean;
    points?: number[][];
    data?: Record<string, unknown>;
}
export interface InspectionGraph {
    id: string;
    nodes: InspectionNode[];
    edges: InspectionEdge[];
    metadata?: Record<string, unknown>;
}
export interface InspectionGrid {
    id: string;
    width: number;
    height: number;
    channels: Record<string, number[]>;
    metadata?: Record<string, unknown>;
}
export interface InspectionSnapshot {
    version: 1;
    schema: 'keel-inspection@1';
    frame?: number;
    seconds?: number;
    meshes?: InspectionMesh[];
    graphs?: InspectionGraph[];
    grids?: InspectionGrid[];
    state?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
}
export type ProbeKind = 'mesh' | 'graph' | 'grid' | 'state';
export interface MeshInput {
    positions: ArrayLike<number>;
    indices: ArrayLike<number>;
    normals?: ArrayLike<number>;
    attrs?: ArrayLike<number>;
    bodies?: ArrayLike<number>;
    facade?: ArrayLike<number>;
    attributes?: Record<string, ArrayLike<number>>;
}
export interface InspectionProbe {
    register(id: string, kind: ProbeKind, read: () => unknown): () => boolean;
    snapshot(options?: {
        frame?: number;
        seconds?: number;
        metadata?: Record<string, unknown>;
    }): InspectionSnapshot;
}
type Json = null | string | number | boolean | Json[] | {
    [key: string]: Json;
};
function plain(value: unknown, seen = new Set<object>()): Json {
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
        return value;
    if (typeof value === 'number') {
        if (!Number.isFinite(value))
            throw Error('Inspection data must be finite');
        return value;
    }
    if (ArrayBuffer.isView(value) && !(value instanceof DataView))
        return Array.from(value as unknown as ArrayLike<unknown>, v => plain(v));
    if (typeof value !== 'object')
        throw Error('Inspection values must be JSON data or typed arrays; expose numeric state, not functions');
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        throw Error('Expose plain JSON data; convert Maps, Sets and class instances explicitly');
    if (seen.has(value))
        throw Error('Inspection data contains a cycle');
    seen.add(value);
    let result: Json;
    if (Array.isArray(value))
        result = value.map(v => plain(v, seen));
    else {
        const object: Record<string, Json> = {};
        for (const [key, d] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
            if (!d.enumerable)
                continue;
            if (!('value' in d))
                throw Error('Expose plain data instead of getters: ' + key);
            Object.defineProperty(object, key, { value: plain(d.value, seen), enumerable: true, writable: true, configurable: true });
        }
        result = object;
    }
    seen.delete(value);
    return result;
}
function numbers(value: ArrayLike<number>): number[] { const result = Array.from(value); for (const n of result)
    if (typeof n !== 'number' || !Number.isFinite(n))
        throw Error('Inspection data must be finite'); return result; }
export function meshSnapshot(id: string, mesh: MeshInput, metadata: Record<string, unknown> = {}): InspectionMesh {
    const attributes: Record<string, number[]> = {};
    for (const key of ['normals', 'attrs', 'bodies', 'facade'] as const) {
        const v = mesh[key];
        if (v !== undefined)
            attributes[key] = numbers(v);
    }
    for (const [key, value] of Object.entries(mesh.attributes ?? {}))
        attributes[key] = numbers(value);
    return { id, positions: numbers(mesh.positions), indices: numbers(mesh.indices), attributes, metadata: plain(metadata) as Record<string, unknown> };
}
export function graphSnapshot(id: string, graph: GraphInput, metadata: Record<string, unknown> = {}): InspectionGraph {
    const nodes = graph.nodes.map(n => ({ id: String(n.id), ...(n.label ? { label: n.label } : {}), ...(n.position ? { position: numbers(n.position) } : n.x !== undefined ? { position: [n.x, n.y ?? 0, n.z ?? 0] } : {}), data: plain(n.data ?? n) as Record<string, unknown> }));
    const edges = graph.edges.map((e, i) => ({ id: String(e.id ?? i), from: String(e.from ?? e.a), to: String(e.to ?? e.b), directed: e.directed ?? e.oneWay ?? false, ...(e.points ? { points: e.points.map(numbers) } : e.path?.x ? { points: Array.from(e.path.x, (x, j) => [x, 0, e.path!.z[j]]) } : {}), data: plain(e.data ?? e) as Record<string, unknown> }));
    return { id, nodes, edges, metadata: plain({ ...('bounds' in graph ? { bounds: graph.bounds } : {}), ...('at' in graph ? { adjacency: graph.at } : {}), ...metadata }) as Record<string, unknown> };
}
export function gridSnapshot(id: string, grid: GridInput, metadata: Record<string, unknown> = {}): InspectionGrid {
    const channels: Record<string, number[]> = {};
    for (const [key, v] of Object.entries(grid.channels ?? {}))
        channels[key] = numbers(v);
    if (!grid.channels)
        for (const key of ['height', 'type', 'flags', 'dir', 'water', 'deck'] as const) {
            const v = grid[key];
            if (ArrayBuffer.isView(v) || Array.isArray(v))
                channels[key] = numbers(v as ArrayLike<number>);
        }
    const info: Record<string, unknown> = {};
    for (const key of ['tileSize', 'stepHeight', 'chunk', 'version', 'id'] as const)
        if (grid[key] !== undefined)
            info[key] = grid[key];
    const height = grid.depth ?? grid.rows ?? (typeof grid.height === 'number' ? grid.height : undefined);
    if (height === undefined)
        throw Error('Grid requires depth, rows or a numeric height');
    return { id, width: grid.width, height, channels, metadata: plain({ ...info, ...metadata }) as Record<string, unknown> };
}
export function createInspectionProbe(): InspectionProbe {
    const readers = new Map<string, {
        kind: ProbeKind;
        read: () => unknown;
    }>();
    return Object.freeze({
        register(id: string, kind: ProbeKind, read: () => unknown) { if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || !['mesh', 'graph', 'grid', 'state'].includes(kind) || typeof read !== 'function')
            throw Error('Register an id, mesh/graph/grid/state kind and reader function'); if (readers.has(id))
            throw Error('Duplicate inspection reader: ' + id); readers.set(id, { kind, read }); return () => readers.delete(id); },
        snapshot({ frame, seconds, metadata = {} }: {
            frame?: number;
            seconds?: number;
            metadata?: Record<string, unknown>;
        } = {}) {
            const result: InspectionSnapshot & {
                meshes: InspectionMesh[];
                graphs: InspectionGraph[];
                grids: InspectionGrid[];
                state: Record<string, unknown>;
            } = { version: 1, schema: 'keel-inspection@1', meshes: [], graphs: [], grids: [], state: {}, metadata: plain(metadata) as Record<string, unknown>, ...(frame !== undefined ? { frame } : {}), ...(seconds !== undefined ? { seconds } : {}) };
            for (const [id, { kind, read }] of readers) {
                const v = read();
                if (v !== null && typeof v === 'object' && 'then' in v)
                    throw Error('Inspection readers must synchronously read the same frame');
                if (kind === 'mesh')
                    result.meshes.push(meshSnapshot(id, v as MeshInput));
                else if (kind === 'graph')
                    result.graphs.push(graphSnapshot(id, v as GraphInput));
                else if (kind === 'grid')
                    result.grids.push(gridSnapshot(id, v as GridInput));
                else
                    Object.defineProperty(result.state, id, { value: plain(v), enumerable: true });
            }
            return result;
        }
    });
}
declare global {
    interface Window {
        __KEEL_INSPECTION__?: InspectionProbe;
    }
}
