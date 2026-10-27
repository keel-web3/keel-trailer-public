"""Independent parser check; optional OTIO + maintained FCP adapter runtime."""
import json, sys
from pathlib import Path
import opentimelineio as otio
root=Path(sys.argv[1]);m=json.loads((root/'manifest.json').read_text());rows=[]
for c in m['compositions']:
    for suffix,adapter in [('otio','otio_json'),('xml','fcp_xml')]:
        t=otio.adapters.read_from_file(str(root/c[suffix]),adapter_name=adapter)
        assert t.duration().rescaled_to(m['fps']).value==m['durationFrames']
        assert t.global_start_time.value==m['startTimecodeFrame']
        actual=[]
        for track in t.tracks:
            for clip in track:
                if not isinstance(clip,otio.schema.Clip):continue
                r=clip.range_in_parent();url=clip.media_reference.target_url
                if suffix=='xml':url=url.removeprefix('file:///__KEEL_PACKAGE__/')
                actual.append((url,int(r.start_time.value),int(r.end_time_exclusive().value)))
        expected=[(l['movie'],l['startFrame'],l['endFrame']) for l in c['layers']]
        expected += [(l['xmlPath'] if suffix=='xml' else l['path'],0,m['durationFrames']) for l in m['audio'] for _ in range(2 if suffix=='xml' else 1)]
        assert sorted(actual)==sorted(expected),(actual,expected)
        rows.append({'target':c['id'],'format':suffix,'durationFrames':m['durationFrames'],'clips':len(actual),'passed':True})
print(json.dumps({'otioVersion':otio.__version__,'checks':rows},indent=2))
