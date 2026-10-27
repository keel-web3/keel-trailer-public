# Generated editor example

Generate the synthetic images, audio, font-backed timeline and attribution locally:

```sh
python3 examples/editor/make-sample.py artifacts/editor-input
node dist/cli.js export artifacts/editor-input/timeline.json --out artifacts/editor-sample --timecode-frame 43200 --attribution artifacts/editor-input/ATTRIBUTION.md
node dist/cli.js export-validate artifacts/editor-sample
```

No collected production media or editor archive is distributed. The sample uses the generated test font. See [editor import](../../docs/editor-import.md) for application-validation limits.
