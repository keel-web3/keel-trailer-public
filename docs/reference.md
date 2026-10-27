## Timeline v1

tempo.bpm or beatSeconds gives a constant beat period. firstDownbeat is an
absolute offset in the music. An explicit increasing tempo.beats array gives
absolute music times for beats 0,1,2,…; fractional beats interpolate and the
last interval extrapolates. Explicit beats take precedence over a constant
tempo. A tempo with only audioSource is resolved by detection before rendering.
A bed using tempo.audioSource defaults its source in to that grid's first beat.

Shots are consecutive and start at beat zero. in/out are **source seconds**.
speed is a constant multiplier; speed:0 holds. holdFrame pins a source frame.
ramp is an increasing list of {beat, frame} in **local shot beats**; equal
successive frame values hold, descending frame values reverse. A ramp must
span 0..shot.beats. rampVariants selects a different frame mapping for a target,
useful for native portrait/square web takes.

Visual shot kinds are video, image, pair and card. pair places two sources side
by side or vertically according to the target. The CRUCIBLE reference adds
opening/end through its explicit style profile. Sources can provide native
variants for each target.

Pixel art uses integer scaling and nearest-neighbour raster operations;
oversized art needs an explicit crop or larger target. Generic footage can
contain/cover. Target crops use source pixels; safeArea uses output pixels.
Text uses a supplied font at native fontSize and an integer scale, without
antialiasing, with optional typing and deterministic flicker. Text wraps inside
the safe area or fails when its declared scale cannot fit.

Transitions: cut, dither, scanline-tear, glitch, match-cut, flash, and the art-montage transitions
`datamosh`, `mosaic`, `displace` and `dissolve` (see *Art montages* below).
Durations use local beats; pixelScale sets whole output-pixel blocks. Generic
dither uses the KEEL core BAYER4/BAYER2 expansion. The reference retains v3's
existing material ordering for exact visual parity. Match-cut sourceRect and
targetRect are output-canvas coordinates; rectSelector uses exported web
geometry and requires capture at matching framing. Cropping/scaling a captured
page requires supplying the transformed rectangle explicitly. zoomStartBeat
starts the nearest-neighbour dive inside the outgoing shot.

Audio layers refer to original local audio sources and declare role bed/sfx/
riser, placement in beats, source in/out, gain, fades in seconds and beat-based
duck envelopes. Risers are supplied project audio, with fades/placement;
the package does not synthesize or license a replacement. fadeOutAt can pin a
fade's ending time independently of the mix tail, preserving the v3 envelope.

Targets declare dimensions/aspect, crop, safe area, maxBytes, loudness,
truePeak and posterBeat. Posters come from actual lossless rendered frames.
Preview skips two-pass size targeting and uses a fast draft encode at the
declared resolution; composition still renders all requested frames.

## Art montages (layers, datamosh, loop seam, silent delivery)

The generic profile can build a montage of several moving works instead of one source per shot.
All of it is declared in timeline JSON and rendered by the same deterministic worker.

- `kind: "stage"` shots start from the timeline `background` and are composed only from `layers`.
- `layers[]` place a source into a `rect` (default: the whole frame) with `crop`, `fit` (`cover` or
  `contain`), `blend` (`normal`, `add`, `screen`, `multiply`, `difference`, `lighten`), `opacity`,
  `fadeInBeats`/`fadeOutBeats`, a soft `mask` (`ellipse` or `rect`) with `feather`, a slow push
  (`scaleFrom`/`scaleTo`, `driftX`/`driftY`), `loop`, `invert` and `posterize`. Sources keep their
  orientation: nothing rotates or stretches them.
- `post` adds a radial `bloom` halo, a radial/horizontal `chroma` split and a small `pulse` on the beat.
- Transitions `datamosh` (the previous output is pushed along the incoming clip's block motion while its
  change bleeds in as residual and blocks refresh to the real frame; `blockSize`, `strength`),
  `mosaic` (stepped pixel-block resolve from `blockSize` down to 1) and `displace` (chromatic
  displacement handover; `strength` is the peak pixel offset). All are seeded and deterministic.
- `loop: {seamBeats, transition}` makes a seamless loop: output starts `seamBeats` into the authored
  timeline and its last `seamBeats` hand the authored tail over to the opening, so the final frame leads
  into the first. `seamBeats` must be shorter than the opening shot; a target's `posterBeat` must lie
  after the lead-in.
- Targets may set `silent: true` (no audio stream, no loudness verification) and `crf` (when there is no
  `maxBytes`). `maxBytes` size targeting then spends the whole budget on video.

- `inside: true` slides a placed layer back inside the frame when its rect would push it past an edge, so a piece
  near a corner is never cut by the frame.
- `erase` paints parts of a source black **before** it is cropped or placed, so a caption is removed instead of
  being cropped around (a crop slices through the work). Each entry is `{rect}` (a fixed region of the source)
  or `{staticBright: {above, grow, samples, within}}`, which finds burned-in text and watermarks: pixels that
  stay bright in every sampled frame of the part of the clip the layer plays (`above` 0..1 of full scale,
  `grow` pixels of dilation for anti-aliased edges, `within` a source rect that limits the search). Moving
  artwork is not bright everywhere, so it survives. On a black stage with `screen`/`lighten`/`add`, black is
  transparent. It cannot recover what a caption hid, and it does not work on captions that slide or animate
  (use a rect, or a different crop).
- Sources with `alpha: true` (a GIF, animated WebP, PNG, ProRes 4444 or VP9 with alpha) keep their real
  transparency: layers composite them as cut-outs in any blend, with no black key and no crop. Prefer the original
  transparent file to a flattened video whenever the artist has one.
- `dissolve` is a plain cross-dissolve (shot transitions and loop seams).
- `ending: {kind: "loop", seconds, seamBeats, transition}` makes the video **play once and end on its last shot**,
  and renders that shot's continuation as a second, seamlessly looping video `<name>-<target>-loop.mp4`. The loop
  begins on the frame after the main video's last (fades finished, pushes held), runs `seconds`, and its last
  `seamBeats` blend back into the frames the shot showed that long before the main video ended, so its last frame
  leads into its first. A page plays the main video once, then swaps to the loop, so the montage never replays.
  Needs silent targets and a constant tempo; the final shot must be a `stage` shot without a beat `pulse`, ramps,
  drift or `fadeOutBeats`. Targets may set `loopMaxBytes` (default `maxBytes`). `trailer-verify` measures both
  joins on the lossless renders (`loops[].wrapDelta` and `handoverDelta` against the video's own frame-to-frame
  change). Use `loop` instead when the whole video should repeat.
- `lint: {allow, check}` on a layer states intent for `trailer-lint`.

### Composition lint (`trailer-lint`, `keel-trailer lint TIMELINE`)

Run it before every render; it takes seconds and renders nothing. Each layer of each stage shot is drawn at a few
moments through the renderer's own code (so erase, crop, fit, mask and placement are honoured) and measured:

| Finding | Meaning | Usual fix |
| --- | --- | --- |
| `cutoff` | lit pixels run along an interior edge of the layer's `crop`, and (error) the source continues past it | drop the crop, `erase` the caption instead, or move the crop edge onto dark pixels |
| `hard-edge` | a layer meant to dissolve into the stage (masked, or blended screen/lighten/add) is still lit along the border of its own box | `mask: "ellipse"` with a larger `feather`, raise `blackPoint`, or use a source with real alpha |
| `clipped` | part of the placed piece lies outside the frame and is lit | `inside: true`, or move the rect |
| `upscaled` | drawn more than 1.25x its source pixels (warning) | smaller rect |

Errors fail the check (CLI exit code 1; `strict` also fails on warnings). Mark deliberate choices on the layer
with `lint: {allow: ["hard-edge"]}` (for example a work shown as its own square canvas, or a crop that is the
artwork's own rectangle inside a screenshot) and say why in a comment next to it.

### Recipe: directing a montage so nothing is cut off

1. Generate the timeline from a script (a placement table), not by hand. Keep a provenance file with each
   source's origin and sha256.
2. Place each secondary piece **whole**: a box with the source's own aspect and a fixed area, `fit: "contain"`,
   `mask: "ellipse"` with `feather` about 0.5 (or no mask for an `alpha` source), `inside: true`, and a
   `screen`/`lighten` blend so black drops out. Let pieces overlap the main work instead of tiling around it.
3. Find the best source: an original with transparency, a caption-free master, or a clean crop. Remove burned-in
   captions with `erase`; crop only along dark pixels or the artwork's own rectangle.
4. `trailer-lint`; fix every error. `trailer-stills` at the shot boundaries and look at them, on every target.
5. Render, then `trailer-verify`: byte caps, dimensions, hashes and (with `ending`) both loop joins.
6. For a banner that should not replay, use `ending` and deliver the two files; the page plays the first once
   and swaps to the loop when it ends.

Tests: `test/montage.test.ts`, `test/montage-invariants.py` and `test/layers-invariants.py`.

## Capture adapters

Web requests support url, cinematicFlag (e.g. cinematic=1), width/height/fps,
frames, a UTC epoch, a seed, a bounded readySelector/attribute condition,
frame-scripted click/scroll/mark steps, stateAttributes and rectSelectors.
The clock is installed and **paused before navigation**. It advances only at
frame boundaries; scrolling can ease from fromX/fromY through endFrame.
No project page styles or UI are rewritten.

    {
      "capture": {
        "adapter": "web",
        "url": "http://localhost:3000",
        "cinematicFlag": "cinematic=1",
        "width": 1920, "height": 1080, "fps": 30, "frames": 360,
        "readySelector": "canvas.package-canvas",
        "readyAttribute": "data-scene-status", "readyValue": "ready",
        "stateAttributes": ["data-cinematic", "data-boot-phase"],
        "rectSelectors": ["canvas.package-canvas"]
      },
      "outDir": "captures/opening"
    }

Game Boy pins PyBoy 2.7.0 and 59.7275 fps, blank isolated saves, RGB frames and
48 kHz audio retimed against emulated frame boundaries. Events are press,
release, write and mark at exact frame numbers. Reads name numeric addresses
or standard .sym/.noi symbols, including banks and optional guest-side reads.

Two-ROM capture requires guestRom plus link.host/link.guest:
{bank, readHook, currentByte}. readHook is the address immediately after the
ROM's serial ISR reads SB; currentByte points to its armed outgoing byte.
The adapter exchanges actual bytes and raises the guest serial interrupt,
stepping host then guest each frame, as the project's tested bridge does.
It is ROM-specific, and is not a universal cycle-accurate cable emulation.
No arbitrary workspace Python module is imported by the MCP adapter.

Video/image adapters copy and hash existing local inputs. Their capture output
can be used as an ordinary timeline source.

Add adapters without touching composition via registerCaptureAdapter(name,
adapter, optionsSchema). A registered adapter receives capture/options, the
output directory and worker context, and returns JSON artifacts. Its options
are validated against its own schema; the standard capture schema gains the
adapter name. New emulators can export the same native video/metadata shape.

## Handheld footage, cue sync and KEEL scores

For a phone video of a real device (a handheld, a cart running), three tools turn the raw clip into a cut that
moves with the music:

- **trailer-footage** finds the lit screen in every frame (the brightest square-ish region that never touches the
  frame edge), steadies the shot on it (Gaussian-smoothed track, `derotate` straightens part of the tilt, `zoom`
  hides the borders), keeps the device and the hand sharp (the body outline from the screen in screen units,
  `device: [left, top, right, bottom]`, trimmed to dark pixels at its edge, plus large skin-coloured regions) and
  pushes the room back: a mask-aware blur so the device does not bleed into it, dim, desaturate, tint and vignette.
  The screen is sharpened, given contrast and colour, and its light spills onto the bezel. It writes a lossless
  `footage.mkv`, `track.json` (screen and device per frame), `before-after.png`, and `cues.json`: every screen
  change (a new scene, a white flash) found on a small rectified copy of the screen. Defaults live in
  `python/footage.py` (`DEFAULTS`); pass any of them as `options`. Needs `opencv-python-headless` (requirements.txt).
- **trailer-cue-sync** takes those cues (or any times) and a tempo, and returns one video shot per stretch between
  cues, each with the speed that lands the next cue exactly on a beat (`grid`; quick bursts under `fastBelow`
  seconds on `fastGrid`), with transitions cycled per cue (`fastTransitions` for the quick ones). Speeds outside
  `maxStretch` are reported, never hidden. `cueBeats` is what the score uses.
- **trailer-score** renders an authored arrangement on the KEEL engine's own instruments (keel-engine
  `packages/audio`: the KEYS, BASS and DRUMS samples and the synth kit), offline in Node: tracks of notes in
  beats on sampled voices (`musicbox`, `celesta`, `organ`, `vibes`, `kalimba`, `synth`, `sub`, `kick`, `hat`,
  `open`, `snare`, ...) or synth voices (`pulse`, `saw-pad`, `choir`, `theremin`, `drone`, `bell`, `glass`), with
  gain, pan, filters, drive and reverb sends; and hits on cue beats (`press`, `slam`, `final`, `riser`, `swell`)
  built from the kit in the piece's key (`root`), scaled by `power` and kept inside `tail` seconds so fast presses
  never smear. Writes `music.wav` (bed), `sfx.wav` (hits) and `mix.wav`, levelled and limited together, plus
  every hit time. Notes are authored: write original music; audition before delivery.
  With `loop: true` the arrangement is a loop of `totalBeats`: it renders twice and keeps the second time round,
  so reverb and release tails wrap into the top, and reports the seam (`loop.seamless`, the wrap step against the
  music's own).

Transitions `punch` (the incoming frame kicks in 9% larger and settles, lit up) and `chroma` (punch plus a
red/blue split that closes) join cut, dither, scanline-tear, glitch, match-cut and flash.

```sh
keel-trailer footage --json footage.json    # {mediaPath, outDir, options?}
keel-trailer cue-sync --json sync.json      # {cuesPath:"build/footage/cues.json", sourceId, sourceEnd, bpm, outPath}
keel-trailer score --json score.json        # {arrangementPath, outDir, engineRoot?}  (KEEL_ENGINE_ROOT or ~/dev/keel-engine)
```

## Determinism and verification

The renderer fixes RNG seed, uses a single encoder thread, strips wall-clock
metadata and records toolchain/input hashes. Repeated tiny renders are tested
for identical MP4 and lossless RGB hashes. Exact hashes are scoped to the same
Python/numpy/Pillow, ffmpeg/libx264 versions, architecture and capture bytes.
Recapturing a live website additionally depends on its assets, browser and GPU;
a paused clock does not freeze an external deployment.

Stills replay from frame zero, retaining transition/RNG state, and are tested
against decoded lossless frames. H.264/AAC are lossy delivery formats.

Every logical cut is tested against a 1 ms PCM envelope attack, with a minimum
1.5x jump over the preceding 30..5 ms. Verification separately reports the cut
frame and its quantization offset, and attacks in the delivered AAC at that
frame. Encoded attack tolerance is explicitly one frame plus the requested
logical tolerance; 30 fps cannot represent every fractional beat exactly.

[ffmpeg loudnorm](https://www.ffmpeg.org/ffmpeg-filters.html#loudnorm) uses a measured two-pass EBU R128 filter. AAC delivery is measured
again; its peak ceiling is adjusted when encoding introduces overshoot, while
copying already encoded video. Final verification measures the actual MP4,
rather than assuming the WAV's peak/loudness carries through compression.
Size budgets are decimal bytes. A missing bed/silent track cannot pass an
attack check merely because its declared tempo is valid.

## Visual and code inspection

Use both views of the same artifact:

- **trailer-snapshot** reads an existing image/video or replays a timeline. Give
  exact frame numbers or time requests, and named crops at integer scales.
  It writes PNGs, a contact sheet and an offline frame/region browser. With
  pixelData:true it also writes RGB24 buffers: rowStride, byte count and SHA-256
  make the pixels directly accessible to code. Source files are untouched.
- **trailer-clip** takes a startFrame/endFrame interval (end exclusive) and an
  optional crop/scale. The FFV1/PCM result retains exact pixels and source audio
  samples; a separate H.264/AAC preview and HTML player make it easy to view.
  Odd dimensions pad one pixel on the preview; the lossless clip stays exact.
- **trailer-inspect** takes exported system data. It saves the complete snapshot,
  front/top/side/isometric wireframes, graph views with actual path samples,
  channel grids, topology/statistics and CSV/DOT exports. Its offline viewer
  lets you rotate a mesh, click a vertex/node, hover a grid cell and query the
  underlying values by JSON pointer. Views are diagnostic projections of the
  supplied data, not a substitute for the canonical engine material renderer.

Requests use the same CLI and MCP JSON schemas:

```json
{
  "mediaPath": "trailer.mp4",
  "frames": [226, 451, 704],
  "views": [
    {"id": "full"},
    {"id": "detail", "crop": {"x": 400, "y": 36, "width": 1120, "height": 1008}, "scale": 1}
  ],
  "pixelData": true,
  "outDir": "inspection/frames"
}
```

    node dist/cli.js snapshot --json snapshot-request.json
    node dist/cli.js clip --json clip-request.json
    node dist/cli.js inspect --json inspection-request.json

Inspection snapshot schema: [schemas/inspection.json](schemas/inspection.json).
Its meshes have flattened xyz positions, triangle indices and per-vertex
attribute arrays. Graphs have stable node/edge IDs, positions and optional
polyline points. Grids have width/height and exact row-major channel arrays.
state and metadata retain explicitly exported JSON data, including provenance.
Dangling graph links, invalid indices, incomplete grids, non-finite values and
cycles fail validation. Indexed boundaries are reported without welding
coincident vertices, so they do not establish whether a geometric solid is
watertight. Default large mesh views sample at most 20,000 triangles; raw arrays
and CSV retain every supplied triangle. Select views explicitly for large
systems rather than generating more than 64 default views.

**The code API works in Node and in project browser bundles:**

```ts
import { createInspectionProbe } from '@keel/trailer/probe';
const inspection = createInspectionProbe();
inspection.register('vehicle', 'mesh', () => existingLookMesh);
inspection.register('roads', 'graph', () => existingRoadGraph);
inspection.register('terrain', 'grid', () => existingTerrain);
inspection.register('simulation', 'state', () => ({ tick, seed, position }));
const snapshot = inspection.snapshot({ frame: tick, seconds: tick / fps });
// Persist snapshot as JSON, or expose this explicit browser capture hook:
window.__KEEL_INSPECTION__ = inspection;
```

These adapters copy canonical LookMesh, RoadGraph and Terrain buffers; they
retain normals/attrs/bodies/facade, road polylines/adjacency and grid channels/
units/version. They read existing objects synchronously, so code and visual
views share one frame. No parallel regenerated scene is introduced. Readers
must export data; functions/GPU-private state cannot be recovered from pixels.
To inspect another system, register its mesh/graph/grid/state readers or supply
a snapshot matching the schema. Unregister a reader with the returned function.

For a live web capture, add inspectionFrames:[0,30,60] and optionally
probeGlobal:"__KEEL_INSPECTION__" to trailer-capture. The paused clock records a
validated inspection JSON beside that exact screenshot frame. Existing page
controls and visual design remain intact. The page must expose the probe.

For code queries, supply e.g.
queries:[{pointer:"/meshes/0/positions",start:300,count:30}] to trailer-inspect,
or call queryInspection(snapshot, query). Results paginate large arrays while
the snapshot preserves the complete data. CSV exports include vertex/triangle
IDs and one matrix per grid channel; graph DOT retains IDs and direction.

Frame indices select exact decoded frames. Time requests use the average-FPS
grid and report actual decoded PTS; use frame numbers for variable-rate sources.
Clip extraction currently requires constant frame rate. Media inspection is
RGB24; it does not export alpha/depth/GPU buffers implicitly. The offline
viewer is an inspection artifact, not a replacement project UI or scene editor.

A runnable canonical-engine example is in
[examples/inspection/README.md](examples/inspection/README.md). Private captures,
reports and raw pixels remain ignored artifacts. These tools support
remote:"yuna-mbp" and the same automatic busy-Mac offload/cleanup.

## Busy-Mac offload

Capture/render/stills/inspection operations check the 1-minute load. Render/stills,
snapshots, clips and data inspections automatically use
the user-owned yuna-mbp when load exceeds 40; remote:"yuna-mbp" or
--remote yuna-mbp selects it explicitly. Capture stops with OFFLOAD_REQUIRED:
its browser/ROM runtime must be arranged on the helper machine.

The helper checks free space and runtime availability, transfers only validated
inputs over SSH/rsync into a random private ~/work job, renders there, copies
results back and removes both remote/local job scratch. It never pushes Git
or publishes assets. Paths in returned artifacts, reports and offline viewers are rebased locally.

The Sonoma helper cannot use current Homebrew runtime bottles. The included
scripts/bootstrap-yuna.sh builds a minimal ffmpeg/x264 and installs uv-managed
Python under ~/.local/share/keel-trailer-runtime. Source build scratch is
removed and downloaded source hashes are recorded. This deliberate runtime
installation is retained; all per-render media/checkouts are removed.

## Onchain scene trailers (MCP and SDK)

Use `trailer-onchain` for an executable trailer and `trailer-onchain-render` for
an MP4 export of that same program. Node 22.18+ is required for engine TypeScript.
Set `KEEL_ENGINE_ROOT` and `KEEL_SDK_ROOT` to installed engine/SDK checkouts with
workspace dependencies installed and SDK built. They default to `~/dev/keel-engine`
and `~/dev/keel-sdk`; requests can override them. Playwright Chromium is needed for
browser tests, and ffmpeg/ffprobe for video exports and audio comparisons.

Start with `examples/onchain/project.json` and `scene.ts`. Copy them into the
creator workspace, preserving `adapterPath` or adjusting it. A single MCP call:

```json
{"projectPath":"examples/onchain/project.json","outDir":"artifacts/trailer"}
```

sent to **trailer-onchain** produces:

- `bundle.json`: exact resource hashes, dependency closure and separate scene,
  runtime, asset and compressed byte counts. No deployment is claimed.
- `verified-preview.html`: the real SDK verification shell around the complete
  offline work, plus `preview.html` for direct debugging.
- `resources/`: reusable engine/player modules kept separate from creator assets.
- `prepare-request.json`: a ready-to-call `trailer-onchain-prepare` local proof
  request. Scene/music are native binary; the older `keel-inline-prepare` path
  rejects them and must not be used as a fallback.

Then call **trailer-onchain-test** with
`{"bundleDir":"artifacts/trailer","outDir":"artifacts/trailer-tests"}`.
It verifies file hashes, canonical shell completion, animated frames, deterministic
seek/replay, sound output and no-network playback. It writes `playback-test.json`,
a screenshot and a generated `soundtrack.wav`. A technical failure is reported
as `pass:false`. Publication and selected-chain readback are separate gates.

Call **trailer-onchain-prepare** with `prepare-request.json` for a local playback
fixture only. It requires `localProof:true`, uses the SDK automatic compact
saver and URI81 prepared COPY defaults for both compressed and uncompressed bytes, and rejects public target bindings. The SDK must provide `prepareKeelDensePayload`; the generated prepare request preserves the SDK selected during compilation. It writes
ordered COPY fragments, `preparation.json`, `prepared.html` and `tokenURI.txt`.
The local report always has `uploadPlan:null`, no object writes and fictional
chain 31337 bindings. These files and the local engine copies are never a
public deployment plan.

For public trailers, use the core KEEL MCP workflow automatically:

1. Run `keel-contract-workflow-preflight`, inspect the selected chain and search
   its library. Check SDK deployment/reference manifests and the existing bound
   token graph as well; an empty Studio search does not establish absence.
2. Run `keel-inline-reuse-plan` on exact authenticated references. Preserve the
   registered shell/composer, existing payload carriage and engine/audio objects.
3. Run `keel-revision-plan` for each declared trailer change. Only changed
   trailer resources and scene/music codec data enter the upload plan. Never
   upload the local preview's unchanged dependencies.
4. Run `keel-inline-publication-check` on the complete returned tokenURI. Check
   exact bytes, actual estimated read gas and offline playback before minting
   through the existing core publication path. A public gas ceiling is a cap,
   not measured consumption; report them separately.

Do not deploy a trailer-specific reader, factory or replacement shell, switch
an existing codec, re-encode existing containers or raise the read cap to make
a failing candidate pass. The plugin owns scene, sound and playback proof;
the core SDK/MCP owns publication. This boundary closes the former public
`target:{chainId,store,objectIds,context}` preparation bypass.

The SDK exports the same implementation:

```js
import {compileTrailerProject, testTrailerBundle, renderTrailerBundle} from '@keel/trailer';
const built = await compileTrailerProject(project, {
  workspaceRoot, engineRoot, sdkRoot, outDir
});
const tested = await testTrailerBundle({bundleDir:outDir,outDir:testDir});
const rendered = await renderTrailerBundle({
  bundleDir:outDir, outDir:videoDir, scale:6, crf:12
});
```

For a native 320x180 program, call **trailer-onchain-render** with
`{"bundleDir":"artifacts/trailer","preparedDir":"artifacts/trailer-prepared","outDir":"artifacts/video","scale":6,"crf":12}`.
`preparedDir` is optional; when supplied, export parses and runs the complete
prepared tokenURI through the canonical verification shell. The tool awaits
async scene preparation, blocks network requests and captures every fixed-step
frame. It writes a native FFV1 master, the exact rendered soundtrack WAV,
`trailer.mp4`, sampled scene state and a `render.json` report with source, pixel
and delivery hashes. MP4 scaling uses ffmpeg `flags=neighbor` and an integer
scale (1–12); 320x180 at scale 6 produces 1920x1080. The native master preserves
exact RGB pixels. H.264/AAC delivery is compressed and does not claim lossless
pixel or sample equality. Export does not publish anything. The test command
below also verifies every pixel of a short integer-scaled export.

### Scene adapter and strict codec

Select engine module IDs in `modules`. Dependencies and versions are resolved by
KEEL's registry; missing/incompatible modules fail. `adapterPath` is trusted creator
code, built as a separate asset. Its imports from selected `@keel-engine/*` modules
link to the canonical engine registry instead of bundling duplicate engines.
Export `createTrailerScene({canvas,engine,content})` (async preparation is supported), returning `reset(seed)`,
`step(dt,frame)`, `render(alpha)`, `actions`, an `arities` table, and optional
`snapshot()`. The example is an engine-backed particle test, not REDLINE artwork.

Adapters may return `prepareFrame(frame)`, an asynchronous preparation hook. The
player advances the fixed simulation and applies scene cues before awaiting it,
then draws the complete frame. Use the current camera and accepted actors to
prepare a bounded visible working set; release unused geometry before allocating
new meshes. Yield between small preparation batches. Do not warm every scene or
retain every car and terrain chunk for the full film. The worker and fallback
encoder await the same hook for each output frame, so preparation delays cannot
drop frames or change simulation time. `createScenePlayer` exposes
`seekPrepared(time)` for this path; synchronous `seek(time)` remains available.
The mounted browser API returns a promise from `__TRAILER__.seek(time)`; await
it before reading scene snapshots or capturing pixels.

The authoring program is declarative JSON, compiled through KEEL's existing bit
codec into a strict cue tape: integer musical ticks, delta times, indexed actions,
numeric parameters and bounded linear/smooth tweens. It does not accept arbitrary
JavaScript as scene bytecode. The program is limited to 120 seconds, 8,192 cues,
64 declared actions and eight numeric arguments per action. Invalid versions,
unknown fields, overlapping action tweens and noncanonical bytes are rejected.
The adapter remains executable trusted code; the cue codec is not a sandbox for
uploaded JavaScript. Simulation uses fixed frame steps; audio and animation use
the same playback clock. Pixel/sample equality across different hardware is not
promised. Native canvas resolution uses nearest-neighbor CSS presentation.

Scene v2 adds required `data`, packed by KEEL's existing lossless `dyn()` codec.
Keep shot settings, seeds and palettes here instead of baking them into adapter
JavaScript. Data is bounded to 16 KiB of JSON, 4,096 values, six nesting levels,
256 items per collection and 256 UTF-8 bytes per string. Non-finite numbers,
functions, cycles, non-JSON objects and prototype keys are rejected. Both the
visible scene and live MP4 replay receive the same decoded `program`; adapters
can read `program.data`. Existing scene-v1 bytes remain unchanged and readable.

### Music and conversion tests

Project `music` accepts `{mode:'file',path}`, `{mode:'recipe',recipe}` (existing
KEEL audio recipe), `{mode:'score',score}`, or `{mode:'midi',path}`. Tone and shared
KEEL audio are separate reusable modules. The viewer starts sound on a real gesture.
Recipes must pin a tempo matching the scene. Authored scores and MIDI use explicit
notes, synth envelopes and gain. Scores are packed by the engine codec, with up
to 16 instruments and a bounded voice count.

**trailer-music** packs a `recipe`, `score` or `midiPath` into `music.bin`; MIDI
also produces editable `score.json`. MIDI formats 0/1 with constant integral BPM
are supported. Tempo maps, sustain/controllers, pitch bends and percussion without
an explicit mapping fail instead of silently dropping musical meaning. Patch
selection is an approximation. It is not an automatic mixed-MP3 transcriber.

For a mixed track: obtain/transcribe notes or stems, author patches, then render a
short candidate first. Call **trailer-audio-test** with `referencePath`,
`candidatePath` and `outDir` (clips up to 120 seconds / 32 MB each). It writes
`audio-test.json` and `audition.html`, comparing duration, RMS level, clipping,
envelope timing and waveform similarity. `technicalPass` never certifies melody,
timbre or perceptual equivalence; `auditionRequired` remains true. Agents must
listen/ask the creator to audition the paired files, preserve the original, and
report unsupported conversion features. Never call synth reconstruction lossless.

Local test command:

```sh
KEEL_ENGINE_ROOT=/path/to/keel-engine KEEL_SDK_ROOT=/path/to/keel-sdk \
  node --test test/program.test.ts test/music.test.ts test/onchain.test.ts test/publication.test.ts test/onchain-render.test.ts
```

Use the plugin-enabled MCP server for `KEEL_MCP_ENTRY` when running `test/mcp.test.ts`.
The upstream SDK checkout and the installed MCP loader may be different
checkouts; a server without the plugin loader cannot expose these tools.

### Engine playback becomes a real MP4

Add `"liveMP4":{"scale":6,"autoplay":true}` to the scene project. The player
starts native engine playback after verification and resource preparation. Play
or Sound unlocks listening. The optional shared engine exporter runs a separate
fixed-step native scene in the background and includes the prepared soundtrack.
Playback controls and tab visibility do not cancel or alter export. Once decoded,
the video aligns its clock with playback and replaces the canvas. Save MP4 and
the normal browser Save Video action receive the generated MP4 Blob. No rendered
video is stored onchain.

Run **trailer-onchain-live-test** with `bundleDir`, optional `preparedDir` and
`outDir`. It checks engine motion, full-duration MP4, integer dimensions, continued
playback and a browser download from the video URL. It writes `live-mp4-test.json`,
`handoff.png`, and the downloaded `trailer.mp4`. The canonical SDK artwork sandbox
must permit downloads; its opaque origin and no-network policy are retained.
This changed canonical shell needs its own verified selected-chain revision.

The optional `@keel-engine/capture/offline` module encodes every fixed-step frame
at a 20 Mbps H.264 High 4.2 VBR target with prepared 320 kbps AAC-LC PCM. Export
starts automatically after preparation, including silent autoplay. Sound requires a
trusted gesture for listening; the export does not. Pause, seek and slow rendering
cannot change output timestamps or frame count. Unsupported codecs report an error.
A separate native scene supplies all frames, then the decoded MP4 clock converges
with playback before handoff. The async native path works in secure opaque token
frames whose Blob workers lack WebCodecs. See the engine capture documentation.
A hidden page can delay encoding; it cannot change output media timestamps.

### Preview dependencies and new trailer bytes

`trailer-onchain` records `dependency-boundary.json` and the actual adapter compiler inputs. A local preview may include engine and audio copies, but those are not new upload bytes. Transitive game imports outside the creator workspace are reported as shared source embedded in the adapter, even when the output is named `trailer.adapter`. Resolve those imports through exact published system APIs before publication; do not upload that adapter as a replacement engine. The full assembled tokenURI size is separate from scene/music data and newly stored bytes.

`assertTrailerDataOnlyUpload` supports the strict scene/music-only profile: it rejects engines, adapters, players, audio libraries and video resources, and refuses a tiny tape whose adapter still embeds unlinked game systems. It is a local boundary check, not publication authority; core MCP reuse, module revisions and selected-chain verification remain mandatory. Any required trailer runtime update is a separate reusable module revision.

Run **trailer-onchain-reuse-review** with `bundleDir`, the core decoded graph's
`referencePath`, its `sourceManifestPath`, source-root `path`/`prefix` mappings,
and `outDir`. It matches resource bytes and digests before comparing the actual
compiler sources. Missing scene sources are reported explicitly. Source coverage
does not prove source-version compatibility; equal export names across different
game generations never authorize a bridge. This local review performs no chain
writes, creates no upload plan and does not claim whole-chain absence.

### Selected-chain publication and live input

Resolve transaction gas rules from the current chain block with the core SDK. Sepolia Amsterdam meters execution gas and state creation separately; total upload gas is not the public tokenURI read budget. Require strict `eth_simulateV1` transaction validation and the SDK linked-fork header checks before signing. Preserve the default public read budget and prove the complete returned tokenURI before minting. Size carrier batches to the measured configured RPC envelope while preserving the standard 23 KB carrier bytes and object identities. Old release hosts with a fixed 16M total-gas guard are incompatible with this selected-chain policy.

Exclude a reused game's self-starting bootstrap from a new trailer graph while preserving that game's original fallback graph. The live test requires one trailer canvas and a trusted click on the existing Play control. For Chromium's transformed opaque frames, the test sends native pointer events directly to the frame's input target; it never invokes the playback API to manufacture a passing control test. Check the real generated audio, video handoff and downloaded MP4.

The player exposes Play/Pause, a seek bar, sound, encoding progress and Save MP4.
An adapter may supply `playerLabel()` to render controls with its canonical bitmap
font. The live test verifies trusted Play/Save input and the MP4 handoff.

For Sepolia Amsterdam, retain the SDK planned total transaction gas allowance
when the simulator reports execution-only `maxUsedGas`. Validate the exact
nonzero-fee envelope and linked headers; never shrink total gas to execution
consumption or raise the public read ceiling.

The browser player begins the native preview when scene preparation finishes;
Tone offline synthesis runs concurrently, and Sound resumes the context from a
user gesture before awaiting prepared PCM. Export waits for that complete PCM.
Adapters may provide `prepare(progress)` to initialize resources directly instead
of replaying the whole timeline. They must leave a deterministic reset available.

Canvas-only adapters may export `supportsWorkerExport = true`. The player starts
an OffscreenCanvas renderer using the existing verified module resources and
adapter, then transfers one ImageBitmap at a time to the shared fixed-frame
encoder. Audio, descriptor loaders and the encoder are excluded from the worker.
Adapters which require DOM/media APIs retain the main-thread fallback. Runtime
stats report which path actually ran; failed worker initialization does not
claim a worker result. No additional engine upload is needed for this change.
