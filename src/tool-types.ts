// Generated from schemas/tools.json by scripts/tool-types.ts. Do not edit by hand.
import type { CaptureRequest } from './contracts.js';
import type { SynthScore } from './music.js';
import type { TrailerProject } from './onchain.js';
import type { InspectionSnapshot } from './probe.js';
import type { Arrangement } from './score-render.js';
import type { Timeline } from './timeline.js';
export interface ToolInputMap {
    "trailer-snapshot": {
        "mediaPath"?: string;
        "timelinePath"?: string;
        "timeline"?: Timeline;
        "target"?: string;
        "times"?: (number)[];
        "frames"?: (number)[];
        "views"?: ({
            "id": string;
            "crop"?: {
                "x": number;
                "y": number;
                "width": number;
                "height": number;
            };
            "scale"?: number;
        })[];
        "pixelData"?: boolean;
        "outDir": string;
        "remote"?: "yuna-mbp";
    };
    "trailer-clip": {
        "mediaPath": string;
        "startFrame": number;
        "endFrame": number;
        "crop"?: {
            "x": number;
            "y": number;
            "width": number;
            "height": number;
        };
        "scale"?: number;
        "includeAudio"?: boolean;
        "outDir": string;
        "remote"?: "yuna-mbp";
    };
    "trailer-inspect": {
        "snapshot"?: InspectionSnapshot;
        "snapshotPath"?: string;
        "outDir": string;
        "remote"?: "yuna-mbp";
        "width"?: number;
        "height"?: number;
        "views"?: ({
            "id": string;
            "kind": "mesh" | "graph" | "grid";
            "objectId": string;
            "projection"?: "front" | "top" | "side" | "iso";
            "channel"?: string;
        })[];
        "queries"?: ({
            "pointer": string;
            "start"?: number;
            "count"?: number;
        })[];
    };
    "trailer-onchain-reuse-review": {
        "bundleDir": string;
        "referencePath": string;
        "sourceManifestPath": string;
        "sourceRoots": ({
            "path": string;
            "prefix": string;
        })[];
        "outDir": string;
    };
    "trailer-onchain": {
        "project"?: TrailerProject;
        "projectPath"?: string;
        "engineRoot"?: string;
        "sdkRoot"?: string;
        "outDir": string;
    };
    "trailer-onchain-prepare": {
        "bundleDir": string;
        "outDir": string;
        "sdkRoot"?: string;
        "localProof": true;
        "metadata"?: Record<string, unknown>;
        "imagePath"?: string;
    };
    "trailer-onchain-render": {
        "bundleDir": string;
        "preparedDir"?: string;
        "outDir": string;
        "scale"?: number;
        "crf"?: number;
        "readyTimeoutMs"?: number;
    };
    "trailer-onchain-live-test": {
        "bundleDir": string;
        "preparedDir"?: string;
        "outDir": string;
        "readyTimeoutMs"?: number;
    };
    "trailer-onchain-test": {
        "bundleDir": string;
        "preparedDir"?: string;
        "outDir": string;
        "readyTimeoutMs"?: number;
    };
    "trailer-music": {
        "midiPath"?: string;
        "score"?: SynthScore;
        "recipe"?: Record<string, unknown>;
        "engineRoot"?: string;
        "outDir": string;
    };
    "trailer-audio-test": {
        "referencePath": string;
        "candidatePath": string;
        "outDir": string;
    };
    "trailer-plan": {
        "brief": string;
        "sources": ({
            "id": string;
            "kind": "web" | "gameboy" | "video" | "image" | "audio";
            "path": string;
            "metadataPath"?: string;
            "fps"?: number;
            "pixelArt"?: boolean;
            "alpha"?: boolean;
            "sha256"?: string;
            "variants"?: ({
                "target": string;
                "path": string;
                "metadataPath"?: string;
            })[];
        })[];
        "bpm"?: number;
        "durationBeats"?: number;
        "targets"?: ({
            "id": string;
            "width": number;
            "height": number;
            "safeArea"?: {
                "x": number;
                "y": number;
                "width": number;
                "height": number;
            };
            "crop"?: {
                "x": number;
                "y": number;
                "width": number;
                "height": number;
            };
            "maxBytes"?: number;
            "loudness"?: number;
            "truePeak"?: number;
            "posterBeat"?: number;
            "silent"?: boolean;
            "crf"?: number;
            "loopMaxBytes"?: number;
        })[];
        "font"?: string;
    };
    "trailer-capture": {
        "capture": CaptureRequest;
        "outDir": string;
    };
    "trailer-beats": {
        "audioPath": string;
        "bpm"?: number;
        "beatSeconds"?: number;
        "firstDownbeat"?: number;
        "beats"?: (number)[];
        "outPath"?: string;
    };
    "trailer-export": {
        "timeline"?: Timeline;
        "timelinePath"?: string;
        "outDir": string;
        "targets"?: (string)[];
        "startTimecodeFrame"?: number;
        "attributionPaths"?: (string)[];
    };
    "trailer-export-validate": {
        "packageDir": string;
    };
    "trailer-render": {
        "timeline"?: Timeline;
        "timelinePath"?: string;
        "outDir": string;
        "preview"?: boolean;
        "targets"?: (string)[];
        "remote"?: "yuna-mbp";
    };
    "trailer-verify": {
        "timeline"?: Timeline;
        "timelinePath"?: string;
        "renderDir": string;
        "attackToleranceMs"?: number;
        "loudnessTolerance"?: number;
    };
    "trailer-stills": {
        "timeline"?: Timeline;
        "timelinePath"?: string;
        "outDir": string;
        "times": (number)[];
        "targets"?: (string)[];
        "remote"?: "yuna-mbp";
    };
    "trailer-lint": {
        "timeline"?: Timeline;
        "timelinePath"?: string;
        "targets"?: (string)[];
        "samplesPerShot"?: number;
        "strict"?: boolean;
    };
    "trailer-footage": {
        "mediaPath": string;
        "outDir": string;
        "options"?: Record<string, unknown>;
    };
    "trailer-cue-sync": {
        "cues"?: ((number) | (Record<string, unknown>))[];
        "cuesPath"?: string;
        "sourceId": string;
        "sourceStart"?: number;
        "sourceEnd": number;
        "bpm": number;
        "grid"?: number;
        "fastGrid"?: number;
        "fastBelow"?: number;
        "maxStretch"?: number;
        "startBeat"?: number;
        "transitions"?: ("cut" | "dither" | "scanline-tear" | "glitch" | "flash" | "punch" | "chroma")[];
        "fastTransitions"?: ("cut" | "dither" | "scanline-tear" | "glitch" | "flash" | "punch" | "chroma")[];
        "transitionBeats"?: number;
        "minCueGap"?: number;
        "outPath"?: string;
    };
    "trailer-score": {
        "arrangement"?: Arrangement;
        "arrangementPath"?: string;
        "engineRoot"?: string;
        "outDir": string;
    };
}
export type TrailerToolName = keyof ToolInputMap;
export type ToolRequest = {
    [N in TrailerToolName]: {
        name: N;
        input: ToolInputMap[N];
    };
}[TrailerToolName];
