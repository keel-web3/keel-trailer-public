# KEEL visual + code inspection example

Export actual canonical engine objects without modifying the engine or its UI:

    node --experimental-strip-types examples/inspection/capture-engine.ts \
      /absolute/path/to/keel-engine artifacts/inspection-example

Then call trailer-inspect (or the CLI with --json):

```json
{
  "snapshotPath": "artifacts/inspection-example/snapshot.json",
  "outDir": "artifacts/inspection-example/report",
  "queries": [
    {"pointer": "/meshes/0/positions", "start": 0, "count": 12},
    {"pointer": "/grids/0/channels/height", "start": 0, "count": 8}
  ]
}
```

The script uses canonical lookMesh, roadGraph/pathThrough and createTerrain.
It exports their actual buffers and source-file hashes. The report saves the
full JSON, four mesh views, curved road graph and six native terrain channels,
alongside CSV/DOT and a self-contained index.html inspector. The mesh example
has 128 vertices and 180 indexed triangles; duplicated seams and capsule poles
remain visible in the raw topology report.

For existing video, trailer-snapshot accepts named crop views and exact frame
numbers. The local CRUCIBLE example saved frames 226, 451, 704 and 901 with full
and screen-region views in artifacts/inspection-example/crucible-views.
No internal mesh/state is inferred from the video; supply a same-frame probe
snapshot to inspect that separately.
