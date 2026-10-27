# KEEL Trailer

**KEEL + After Effects, for agents.** A TypeScript package and optional KEEL MCP plugin for deterministic beat-based trailers, capture, visual inspection and editable scene programs.

This repository contains source and two tiny original synthetic test clips. Production recordings, client work, review archives, ROMs and private repository history are excluded. Source and generated fixtures are MIT licensed.

## Quickstart

Requires Node **22.18+**, pnpm, ffmpeg/ffprobe (libx264, FFV1 and loudnorm), and Python **3.11–3.13** for prebuilt worker dependencies. Browser capture also needs Chromium. KEEL scene/audio tools require an accessible KEEL engine checkout; selected SDK integrations require its built SDK. Basic file rendering and inspection do not require those checkouts.

```sh
git clone https://github.com/keel-web3/keel-trailer-public.git
cd keel-trailer-public
pnpm install --frozen-lockfile
pnpm build
python3.13 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
pnpm exec playwright install chromium
node dist/cli.js validate examples/basic/timeline.json
node dist/cli.js render examples/basic/timeline.json --out artifacts/demo --preview
node dist/cli.js render examples/basic/timeline.json --out artifacts/stills --stills 0,2,3.5
```

The package finds `.venv/bin/python` automatically; `TRAILER_PYTHON` overrides it. All commands return JSON. A pinned toolchain and identical inputs are required for identical hashes. Regenerate the included procedural clips with `pnpm fixtures`.

## Install the MCP plugin

Use the existing KEEL engine plugin installer and SDK MCP server:

```sh
node /absolute/path/to/keel-engine/tools/plugins.mjs install "$PWD"
keel-mcp --workspace /absolute/path/to/creator/project --self-test
```

Restart the MCP client after registration. Manifest: [`keel.plugin.json`](keel.plugin.json); compiled entry: `dist/mcp.js`. This remains a separate package and introduces no mandatory trailer dependency into the engine or SDK. The React integration remains its separate `keel/react` plugin.

An isolated invocation is:

```sh
keel-mcp --no-plugins --plugin /absolute/path/to/keel-trailer-public/dist/mcp.js --workspace /absolute/path/to/creator/project
```

## Agent workflow and schemas

1. `trailer-plan`: supply a brief, project-owned sources and tempo; edit the returned timeline.
2. `trailer-capture`: capture deterministic web/emulator footage or import local video/images.
3. `trailer-beats`: detect attacks and beats, or declare the exact grid.
4. `trailer-lint`, then `trailer-render` with `preview:true`.
5. `trailer-snapshot` / `trailer-stills`: examine frames and crops; `trailer-inspect`: examine exported system data.
6. `trailer-verify`: review cut/attack alignment, measured loudness/true peak, hashes, dimensions and size budgets. Render final targets and inspect them.

Exact machine-readable requests: [`schemas/tools.json`](schemas/tools.json), [`timeline-v1.json`](schemas/timeline-v1.json), [`capture.json`](schemas/capture.json), [`inspection.json`](schemas/inspection.json). Runtime validation rejects unknown fields. TypeScript interfaces live in `src/`, and builds emit declarations in `dist/`.

| Tools | Purpose |
| --- | --- |
| `trailer-plan`, `trailer-capture`, `trailer-beats` | Scaffold, capture adapters, beat analysis |
| `trailer-render`, `trailer-verify`, `trailer-stills`, `trailer-lint` | Composition, verification, contact sheets and framing checks |
| `trailer-snapshot`, `trailer-clip`, `trailer-inspect` | Exact frames/regions, video intervals, meshes/graphs/grids and JSON queries |
| `trailer-footage`, `trailer-cue-sync`, `trailer-score` | Handheld screen tracking, cue retiming and authored KEEL audio arrangements |
| `trailer-export`, `trailer-export-validate` | Collected AE/XML/OTIO interchange |
| `trailer-onchain`, `trailer-onchain-reuse-review`, `trailer-onchain-prepare` | Typed scene bundles, reuse review and explicitly local publication proof |
| `trailer-onchain-test`, `trailer-onchain-render`, `trailer-onchain-live-test` | Browser playback and offline/live MP4 checks |
| `trailer-music`, `trailer-audio-test` | Original score/recipe packing and audio comparison |

Media paths stay within the selected workspace. File timelines resolve source paths relative to their file; inline timelines resolve relative to the workspace. Output paths resolve relative to the workspace. No tool downloads third-party music or assets, uploads, signs or publishes.

## TypeScript API

```ts
import {runTrailerTool, createInspectionProbe, type Timeline, type ToolInputMap} from '@keel/trailer';

const request: ToolInputMap['trailer-plan'] = {
  brief: 'Four beats of original gameplay', durationBeats: 4,
  sources: [{id: 'game', kind: 'video', path: 'captures/game.mp4'}]
};
const result = await runTrailerTool('trailer-plan', request, {workspaceRoot: process.cwd()});

const probe = createInspectionProbe();
probe.register('world', 'state', () => ({tick: 120, seed: 7}));
const snapshot = probe.snapshot({frame: 120, seconds: 2});
```

Typed subpaths include `/timeline`, `/program`, `/music`, `/probe`, `/schema`, `/onchain`, `/mcp`. Capture adapters register their own JSON Schema and implementation. The runtime remains strict TypeScript; Python stays isolated for PyBoy, image/audio processing and ffmpeg orchestration. Adobe's importer stays ExtendScript JSX.

## Examples and limits

- [`examples/basic/timeline.json`](examples/basic/timeline.json): runnable silent edit using the two generated clips, with dither and integer scaling.
- [`examples/inspection`](examples/inspection): export canonical KEEL meshes, road graphs, terrain grids and state; inspect both projections and underlying JSON/CSV/DOT.
- [`examples/onchain`](examples/onchain): scene program, TypeScript adapter and original authored score.
- [`examples/crucible`](examples/crucible): CRUCIBLE v3 timeline and capture recipes. Supply your own authorized project checkout, captures, ROM and font; recordings are excluded.
- [`docs/reference.md`](docs/reference.md): timing, transitions, safe areas, capture adapters, inspection, scene/audio contracts and offload details.
- [`docs/editor-import.md`](docs/editor-import.md): editor interchange and native application validation gaps.

On-chain preparation is **local proof only**. It does not establish selected-chain reuse, gas, publication, wallet approval or live read-back. Current core SDK guards may reject retired prototype formats; do not bypass them. Audio conversion is not lossless or perceptual-equivalence proof. Audition authored music before delivery. Native Adobe/Resolve import and real hardware playback require independent checks. Link capture uses ROM-specific hooks, not universal cycle-accurate cable emulation. Automatic beat detection is heuristic; verification reports unaligned cuts.

## Development

```sh
pnpm typecheck
pnpm test
pnpm schema
pnpm types:generate
```

Tests cover schemas, timing, authored codecs, adapters, exact stills and a tiny repeated all-target render. ROM and KEEL engine/SDK integration checks skip unless their explicit environment inputs are present (`TRAILER_TEST_ROM`, `KEEL_ENGINE_ROOT`, `KEEL_SDK_ROOT`, `KEEL_MCP_ENTRY`). Synthetic fixtures and the test font have reproducible generators; font regeneration alone needs `fonttools`.

Before heavy work, check machine load and disk space. Above a load of about 40, use the configured offload host; the render helper supports `remote:"yuna-mbp"`. Remote jobs need their own dependencies and enough free disk, and must clean their staging directories.
