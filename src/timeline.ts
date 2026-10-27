export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}
export interface Tempo {
    bpm?: number;
    beatSeconds?: number;
    firstDownbeat?: number;
    beats?: number[];
    audioSource?: string;
    mode?: 'declared' | 'detected';
    onsets?: number[];
}
export interface Source {
    id: string;
    kind: 'web' | 'gameboy' | 'video' | 'image' | 'audio';
    path: string;
    metadataPath?: string;
    fps?: number;
    pixelArt?: boolean;
    alpha?: boolean;
    sha256?: string;
    variants?: {
        target: string;
        path: string;
        metadataPath?: string;
    }[];
}
export interface TextCard {
    lines: string[];
    font: string;
    fontSize?: number;
    scale?: number;
    color?: string;
    background?: string;
    typingCps?: number;
    flicker?: boolean;
    x?: number;
    y?: number;
}
export interface Shot {
    id: string;
    startBeat: number;
    beats: number;
    kind: 'video' | 'image' | 'pair' | 'card' | 'opening' | 'end' | 'stage';
    layers?: Layer[];
    post?: {
        bloom?: {
            radius: number;
            gain: number;
            threshold?: number;
        };
        chroma?: {
            pixels: number;
            radial?: boolean;
        };
        pulse?: {
            periodBeats: number;
            amount: number;
        };
    };
    source?: string;
    secondSource?: string;
    in?: number;
    out?: number;
    speed?: number;
    ramp?: {
        beat: number;
        frame: number;
    }[];
    rampVariants?: {
        target: string;
        ramp: {
            beat: number;
            frame: number;
        }[];
    }[];
    holdFrame?: number;
    transition?: {
        type: 'cut' | 'dither' | 'scanline-tear' | 'glitch' | 'match-cut' | 'flash' | 'datamosh' | 'mosaic' | 'displace' | 'dissolve' | 'punch' | 'chroma';
        blockSize?: number;
        strength?: number;
        seed?: number;
        beats?: number;
        pixelScale?: number;
        sourceRect?: Rect;
        targetRect?: Rect;
        rectSelector?: string;
        zoomStartBeat?: number;
        referenceEffect?: string;
    };
    text?: TextCard;
    caption?: TextCard;
    fit?: 'contain' | 'cover' | 'integer';
    pixelScale?: number;
    crop?: Rect;
    energy?: boolean;
    stutter?: boolean;
    shake?: boolean;
}
export type LintKind = 'cutoff' | 'hard-edge' | 'clipped' | 'upscaled';
export interface EraseEntry {
    rect?: Rect;
    staticBright?: {
        above?: number;
        grow?: number;
        samples?: number;
        within?: Rect;
    };
}
export interface Layer {
    ramp?: {
        beat: number;
        frame: number;
    }[];
    source: string;
    in?: number;
    out?: number;
    speed?: number;
    holdFrame?: number;
    loop?: boolean;
    crop?: Rect;
    fit?: 'contain' | 'cover';
    rect?: Rect;
    rectVariants?: {
        target: string;
        rect: Rect;
    }[];
    blend?: 'normal' | 'add' | 'screen' | 'multiply' | 'difference' | 'lighten';
    opacity?: number;
    fadeInBeats?: number;
    fadeOutBeats?: number;
    mask?: 'rect' | 'ellipse';
    feather?: number;
    scaleFrom?: number;
    scaleTo?: number;
    driftX?: number;
    driftY?: number;
    invert?: boolean;
    posterize?: number;
    blackPoint?: number;
    erase?: EraseEntry[];
    inside?: boolean;
    lint?: {
        check?: LintKind[];
        allow?: LintKind[];
    };
}
export interface Ending {
    kind: 'loop';
    seconds: number;
    seamBeats: number;
    transition: NonNullable<Shot['transition']>;
}
export interface LintFinding {
    kind: LintKind;
    severity: 'error' | 'warn';
    target: string;
    shot: string;
    layer: number;
    source: string;
    beat: number;
    detail: string;
    measured: Record<string, unknown>;
    fix: string;
    samples: number;
}
export interface LintResult {
    version: 1;
    checkedLayerSamples: number;
    findings: LintFinding[];
    errors: number;
    warnings: number;
    passed: boolean;
    summary: Record<LintKind, number>;
}
export interface AudioLayer {
    id: string;
    source: string;
    role: 'bed' | 'sfx' | 'riser';
    startBeat: number;
    beats?: number;
    in?: number;
    out?: number;
    gain?: number;
    fadeIn?: number;
    fadeOut?: number;
    fadeOutAt?: number;
    duck?: {
        startBeat: number;
        beats: number;
        gain: number;
        attack?: number;
        release?: number;
    }[];
}
export interface Target {
    id: string;
    width: number;
    height: number;
    safeArea?: Rect;
    crop?: Rect;
    maxBytes?: number;
    loopMaxBytes?: number;
    silent?: boolean;
    crf?: number;
    loudness?: number;
    truePeak?: number;
    posterBeat?: number;
}
export interface Timeline {
    version: 1;
    name: string;
    fps: number;
    seed?: number;
    tempo: Tempo;
    sources: Source[];
    shots: Shot[];
    audio?: AudioLayer[];
    targets: Target[];
    background?: string;
    brief?: string;
    loop?: {
        seamBeats: number;
        transition: NonNullable<Shot['transition']>;
    };
    ending?: Ending;
    reference?: {
        profile: 'crucible-v3';
        capturesRoot: string;
        font: string;
        title: string;
        subtitle: string;
        url: string;
        handle: string;
    };
}
export interface EditorExportRequest {
    timeline?: Timeline;
    timelinePath?: string;
    outDir: string;
    targets?: string[];
    startTimecodeFrame?: number;
    attributionPaths?: string[];
}
export interface EditorPackageValidation {
    passed: true;
    filesChecked: number;
    sequenceFramesChecked: number;
    durationFrames: number;
    checks: string[];
    applicationValidation: {
        afterEffects: 'not-run';
        premiere: 'not-run';
        resolve: 'not-run';
    };
}
export interface EditorExportResult {
    packageDir: string;
    manifest: string;
    validation: EditorPackageValidation;
    compositions: number;
    durationFrames: number;
}
