import type { CodecApi } from './contracts.js';
import type { SceneData, ScenePlayer, SceneProgram } from './program.js';
export interface SampleData {
    sampleRate: number;
    channels: number[][];
}
export interface SceneContext {
    tick: number;
    frame: number;
    seed: number;
}
export interface NativeScene {
    reset(seed: number): void;
    actions: Record<string, (...args: (number | SceneContext)[]) => void>;
    arities?: Record<string, number>;
    step(dt: number, frame: number): void;
    render(alpha?: number): void;
    prepare?(progress: (value: number, label: string) => void): Promise<void>;
    prepareFrame?(frame: number): Promise<void> | void;
    dispose?(): void;
    snapshot?(): SceneData;
    resourceStats?(): Record<string, unknown>;
    playerLabel?(value: string): HTMLCanvasElement;
}
export interface CaptureApi {
    createCapture(canvas: HTMLCanvasElement): {
        video(options: {
            seconds: number;
            fps: number;
            type: string;
            requireType: boolean;
            scale: number;
            audio?: MediaStream;
            signal?: AbortSignal;
        }): Promise<Blob>;
    };
}
export interface RecipeAudioApi {
    loadMusic(bytes: Uint8Array): unknown;
    render(tone: ToneApi, recipe: unknown, options: {
        preroll: number;
        rate: number;
        overrun: number;
    }): Promise<AudioBuffer>;
}
export interface EngineRuntime {
    start(): Promise<void>;
    get(id: 'keel/codec'): CodecApi;
    get(id: 'keel/capture'): CaptureApi;
    get(id: 'keel/audio'): RecipeAudioApi;
    get<T = unknown>(id: string): T;
}
export interface ToneInstrument {
    toDestination(): ToneInstrument;
    maxPolyphony: number;
    volume: {
        value: number;
    };
    triggerAttackRelease(hz: number, duration: number, time: number, velocity: number): void;
}
export interface ToneApi {
    Synth: unknown;
    PolySynth: new (synth: unknown, options: {
        oscillator: {
            type: string;
        };
        envelope: {
            attack: number;
            decay: number;
            sustain: number;
            release: number;
        };
    }) => ToneInstrument;
    Offline(run: () => void, duration: number, channels: number, rate: number): Promise<{
        get(): AudioBuffer;
    }>;
}
export interface FixedEncodeResult {
    blob: Blob;
    frames: number;
    duration?: number;
    bytes?: number;
}
export interface FixedEncoder {
    addFrame(canvas: HTMLCanvasElement | OffscreenCanvas | ImageBitmap, frame: number): Promise<void>;
    finish(): Promise<FixedEncodeResult>;
    cancel(): Promise<void>;
}
export interface FixedEncoderApi {
    createFixedFrameEncoder(options: {
        width: number;
        height: number;
        fps: number;
        frames: number;
        audio: {
            rate: number;
            channels: Float32Array[];
        } | null;
        signal?: AbortSignal;
    }): Promise<FixedEncoder>;
}
export interface VerifiedContent {
    bytes(id: string): Uint8Array;
    resources?(): {
        id: string;
        role: string;
    }[];
}
export interface SceneFactory {
    supportsWorkerExport?: boolean;
    createTrailerScene(options: {
        canvas: HTMLCanvasElement | OffscreenCanvas;
        engine: EngineRuntime;
        program: SceneProgram;
        content?: VerifiedContent;
        background?: boolean;
    }): Promise<NativeScene>;
}
export interface EncodedMovie {
    video: HTMLVideoElement;
    url: string;
    blob: Blob;
}
export interface PlayerStats {
    resources?: Record<string, unknown>;
    encoderResources?: Record<string, unknown>;
    preparedMs: number;
    frames: number;
    renderP50: number;
    renderP95: number;
    intervalP50: number;
    intervalP95: number;
    handoffError: number;
    exportMode: string;
    encoderThread: string;
    encodedFrames: number;
    encodingMs: number;
}
export interface TrailerPlayerApi {
    player: ScenePlayer;
    play(): Promise<void>;
    pause(): void;
    seek(time: number): Promise<number>;
    readonly duration: number;
    readonly fps: number;
    readonly media: {
        state: string;
        error: string | null;
        progress: number;
        bytes: number;
        type: string | null;
        src: string | null;
    };
    readonly movieReady: Promise<EncodedMovie | null> | null;
    readonly movieBlob: Blob | null;
    readonly stats: PlayerStats;
    readonly audio: {
        enabled: boolean;
        muted: boolean;
        context?: AudioContextState;
        master?: number;
        bufferDuration?: number;
    };
    readonly state: SceneData;
    movieBytes(): Promise<number[] | null>;
    audioSamples(): Promise<SampleData | null>;
}
export interface WorkerFrame {
    frame?: number;
    bitmap: ImageBitmap;
    resources?: Record<string, unknown>;
}
export interface SceneWorker {
    frame(index: number): Promise<WorkerFrame>;
    dispose(): void;
}
export interface SceneOpenOptions {
    bundleDir: string;
    preparedDir?: string;
    readyTimeoutMs?: number;
    liveMP4?: boolean;
}
export interface BrowserOptions {
    playwright?: Pick<typeof import('playwright'), 'chromium'>;
}
export interface RenderOptions {
    bundleDir: string;
    preparedDir?: string;
    outDir: string;
    scale?: number;
    crf?: number;
    readyTimeoutMs?: number;
}
declare global {
    var KEEL_ENGINE: EngineRuntime;
    var KEEL_TRAILER_SCENE: SceneFactory;
    var KEEL_CAPTURE_OFFLINE: FixedEncoderApi | undefined;
    var __KEEL_CONTENT__: VerifiedContent;
    var KEEL_AUDIO: {
        ctx: AudioContext;
        destination: GainNode;
        muted: boolean;
        start(): Promise<boolean>;
    };
    var Tone: ToneApi;
    var __TRAILER__: TrailerPlayerApi;
    var __TRAILER_ERROR__: string | undefined;
    var __TRAILER_PHASES__: {
        engineMs?: number;
        audioMs?: number;
        audioError?: string;
        sceneMs?: number;
        warmupMs?: number;
    };
    var __KEEL_TRAILER_TEST_MODE__: boolean | undefined;
    var __KEEL_TRAILER_CONTROL_INPUT__: {
        isTrusted: boolean;
        target: string;
    } | null;
    var __TRAILER_WORKER_DEBUG__: {
        renderer?: string;
        inFlight?: number;
        error?: string;
        resources?: Record<string, unknown>;
    } | undefined;
    var __KEEL_TRAILER_RENDER_WORKER_SOURCE__: string;
}
