# KEEL editor package

From a KEEL checkout, with its Python/ffmpeg runtime installed:

    node dist/cli.js export timeline.json --out artifacts/editor --attribution ATTRIBUTION.md
    node dist/cli.js export-validate artifacts/editor

The output directory must be empty. Export runs on the current machine; it never
uses the renderer's Mac offload helper. The same API is exposed as
`trailer-export` / `trailer-export-validate` through MCP. `--targets wide,tall`
selects outputs. `--timecode-frame 108000` starts a 30 fps edit at 01:00:00:00.
Timeline v1 has integer fps; fractional/NTSC/drop-frame export is not supported.

Zip the entire output directory, then unzip anywhere. All source, font,
metadata, pass, audio and interchange paths are relative. `timeline.json` is a
collected KEEL checkpoint; original files are unchanged. `source-checkpoint.json` also retains the unmodified input JSON. Project scripts and
web content are never executed by the export/import process. Include project
license/attribution sidecars using `--attribution` (comma-separated workspace
paths), or `attributionPaths` in a JSON request. Conventional LICENSE/COPYING/
ATTRIBUTION sidecars beside sources and in enclosing workspace folders are
collected automatically. Rights remain with the original
project; collection grants no new license and installs no fonts. Review
`ATTRIBUTION.json` and the copied sidecars in `sources/`.

## After Effects

1. In After Effects choose **File > Scripts > Run Script File** and select the
   reviewed `import-after-effects.jsx` supplied by this repository/package.
2. Choose the package's `manifest.json`. The importer parses JSON as data and
   checks all sequence files, frame ranges, layer order and paths before creating
   compositions in the current project. It adds an undo group; it does not save
   or replace your current project.
3. Save the resulting `.aep` beside the package. Check composition frame rate,
   starting timecode, audio and color settings before rendering.

PNG sequences are the exact, full-canvas RGBA passes. Straight alpha is set
explicitly. Generic cut shots separate base, text and caption passes in that
order; titles retain their original text/style metadata. Each raster pass has
editable timing, position, scale and opacity in AE. Glyphs/pixel-font rendering,
source crops, pair layouts, frame ramps and holds remain baked. Non-cut
transitions and the CRUCIBLE reference are exported as opaque composite shots,
including their original effects/title pixels. The export checks the ordered
pass composite against every existing renderer frame. It does not infer layers
or editable shaders from a WebGL capture. A captured source's alpha was already
flattened by the existing RGB renderer.

## Premiere / Resolve / other editors

Run `python3 relocate.py` in the unzipped package, then import
`timeline-00-local.xml` (FCP **7** xmeml v5, not FCP X `.fcpxml`). Each target has
its own XML template. These contain rendered ProRes 4444 clips on ordered video tracks
and two discrete audio channels per stem, routed to left/right sequence outputs. Clip edits, track order, start timecode
and constant frame rate are representable; KEEL effects/titles are baked.
The portable `timeline-00.xml` uses the sentinel `file:///__KEEL_PACKAGE__/`
because xmeml requires absolute file URLs. The relocation helper binds these
to real files on the editor's machine; do not import the template directly. Regenerate local XML after moving the package. This helper writes new
files and leaves the portable originals intact.

ProRes 4444 carries straight alpha but is lossy. Exact pixel work should use
PNG sequences (set sequence fps to the manifest's fps and alpha to straight).
`timeline-00.otio` is an OTIO timeline with relative ExternalReferences, clips,
gaps and tracks for OTIO-aware tools. OTIO is editorial data, not a universal
editor importer. No EDL is emitted: its limited tracks/effects model cannot carry
this layered package. Native editor text/transitions are deliberately excluded
from XML/OTIO to prevent false editability claims.

Stems start at frame zero and last the complete edit, as 48 kHz stereo float
PCM. Gain, fades, duck envelopes and source placement are baked per stem.
`audio/mix.wav` is their unnormalized sum for reference; do not enable it together
with stems. Delivery loudnorm, reference EQ and AAC processing are excluded so
editors can mix/master again. Frame duration rounds audio up by at most one PCM
sample. Stem peaks can exceed 0 dBFS in float; final mastering is separate.
XML references companion 16-bit PCM copies to honor documented xmeml audio depth
limits. Those copies quantize audio and clip float peaks above 0 dBFS; the
manifest reports `xmlClippedSamples` per stem. AE/OTIO retain float stems.

## Validation and current gaps

`validation.json` records package-level validation: source/file SHA-256, all
sequence frames, RGBA and ordered composite hash, movie frame rate/count/alpha,
audio duration, and interchange media references. Export fails on missing media,
unsafe paths, composite mismatches or existing output contents. A failed export
can leave an incomplete folder; keep it for diagnosis or choose a fresh output.
The validator is read-only. Added `*-local.xml` relink files are intentionally
outside the original manifest inventory.

AE importer tests use a mocked host API; XML/OTIO parse checks and ffprobe are
cloud checks. They are **not** an installed AE/Premiere/Resolve smoke test. The
manifest explicitly marks all three application imports `not-run`. Native app
checks should cover color/gamma, alpha interpretation, stereo mapping, sequence
fps, edit boundaries and audio sync on an existing operator machine. No
lossless editable WebGL/shader/effect interchange is promised.

## Format references checked 2026-10-11

- [Adobe AE supported formats](https://helpx.adobe.com/after-effects/desktop/get-started/supported-file-formats/supported-file-formats.html),
  [image sequence import](https://helpx.adobe.com/after-effects/desktop/import-files/import-still-images/preparing-importing-still-images.html),
  [footage frame-rate/alpha interpretation](https://helpx.adobe.com/after-effects/desktop/work-with-footage-items/import-and-interpret-footage-items/importing-interpreting-footage-items.html),
  [ExtendScript/JSX](https://helpx.adobe.com/after-effects/desktop/automate-in-after-effects/automate-animation/scripts.html).
- [Adobe XML import](https://helpx.adobe.com/premiere/desktop/organize-media/import-files/migrate-from-final-cut-pro-x.html)
  and [FCP 7 export limitations](https://helpx.adobe.com/premiere/desktop/render-and-export/export-files/export-a-project-as-a-final-cut-pro-xml-file.html).
- [Apple xmeml elements](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/FinalCutPro_XML/Elements/Elements.html).
- [OTIO adapters](https://opentimelineio.readthedocs.io/en/latest/tutorials/adapters.html).
- [Blackmagic Resolve Edit](https://www.blackmagicdesign.com/products/davinciresolve/edit),
  professional format interchange. The Resolve 20 manual fetch exceeded the web
  tool's size limit and cloud download was denied (403); no manual-based
  compatibility claim or native Resolve test is recorded.
