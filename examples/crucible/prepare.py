"""Materialize authorized v3 captures and compile marks to an editable timeline.
python prepare.py --captures PATH --project SITE_PATH --out WORKSPACE/artifacts/crucible
All originals stay untouched. Generated assets/renders are ignored by Git.
"""
import argparse,ast,hashlib,json,shutil,subprocess,sys
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/"python"))
from common import load_audio,SR,sha
p=argparse.ArgumentParser();p.add_argument("--captures",type=Path,required=True);p.add_argument("--project",type=Path,required=True);p.add_argument("--out",type=Path,required=True)
a=p.parse_args();out=a.out.resolve();cap=out/"captures";cap.mkdir(parents=True,exist_ok=True)
needed=["title","combines","talk","rooms","filter","link-host","link-guest","fight"]
manifest=[]
for name in needed:
    for ext in ("mkv","json"):
        src=a.captures/"game"/f'{name}.{ext}';dest=cap/"game"/src.name;dest.parent.mkdir(exist_ok=True)
        (shutil.copyfile(src,dest) if src.resolve()!=dest.resolve() else None);manifest.append({"logicalPath":"game/"+src.name,"sha256":sha(dest),"bytes":dest.stat().st_size})
for name in ("site-1920x1080","site-1920x1080-manual","site-1920x1080-opening","site-1080x1920-opening","site-1080x1080-opening"):
    for ext in ("mkv","json"):
        src=a.captures/"site"/f'{name}.{ext}'
        # The reference's original cinematic take was moved by a newer capture session.
        if not src.exists():src=a.captures/"site-old"/f'{name}.{ext}'
        if not src.exists() and name.endswith("-manual"):continue
        dest=cap/"site"/src.name;dest.parent.mkdir(exist_ok=True);(shutil.copyfile(src,dest) if src.resolve()!=dest.resolve() else None)
        manifest.append({"logicalPath":"site/"+src.name,"sha256":sha(dest),"bytes":dest.stat().st_size})
for name in ("bed-128.wav","bed-128.json","sfx.wav","sfx.json","chime.wav"):
    src=a.captures/"music"/name;dest=cap/"music"/name;dest.parent.mkdir(exist_ok=True);(shutil.copyfile(src,dest) if src.resolve()!=dest.resolve() else None)
    manifest.append({"logicalPath":"music/"+src.name,"sha256":sha(dest),"bytes":dest.stat().st_size})
font=out/"crucible-pixel.ttf";shutil.copyfile(a.project/"public/fonts/crucible-pixel.ttf",font)
original=json.loads((Path(__file__).parent/"edit-v3.json").read_text())
period=28/59.7275;total=sum(s["b"] for s in original)*period
sources=[]
for name in needed:
    path=cap/"game"/f'{name}.mkv'
    sources.append({"id":name,"kind":"gameboy","path":str(path.relative_to(out)),"metadataPath":str(path.with_suffix(".json").relative_to(out)),"fps":59.7275,"pixelArt":True,"sha256":sha(path)})
for id,name in (("tour","site-1920x1080"),("manual","site-1920x1080-manual"),("opening","site-1920x1080-opening")):
    path=cap/"site"/f'{name}.mkv'
    if not path.exists():continue
    s={"id":id,"kind":"web","path":str(path.relative_to(out)),"metadataPath":str(path.with_suffix(".json").relative_to(out)),"fps":30,"sha256":sha(path)}
    if id=="opening":s["variants"]=[{"target":target,"path":f'captures/site/site-{w}x{h}-opening.mkv',"metadataPath":f'captures/site/site-{w}x{h}-opening.json'} for target,w,h in (("9x16",1080,1920),("1x1",1080,1080))]
    sources.append(s)
sources.append({"id":"bed","kind":"audio","path":"captures/music/bed-128.wav","sha256":sha(cap/"music/bed-128.wav")})
# Extract the same effects-only PCM windows as v3, losslessly (no third-party sounds).
snd=load_audio(cap/"music/sfx.wav");sm=json.loads((cap/"music/sfx.json").read_text())["marks"]
def f2s(f):return int(f/59.7275*SR)
def cut(a,b,dur,thr=.02):
    seg=snd[f2s(a):f2s(b)+int(dur*SR)];env=np.abs(seg[:f2s(b)-f2s(a)]).max(1)
    onset=int(np.argmax(env>thr)) if (env>thr).any() else 0
    return seg[onset:onset+int(dur*SR)]
bank={"mix":cut(sm[0]["mix"]-25,sm[0]["mix"],.35,.06),"flash":cut(sm[0]["reveal"]-30,sm[0]["reveal"]+30,.45),
      "fanfare":cut(sm[1]["reveal"]-2,sm[1]["reveal"]+60,1.4)}
bank["glitch"]=bank["flash"][:int(.12*SR)];bank["chime"]=load_audio(cap/"music/chime.wav")
import wave
for name,clip in bank.items():
    dest=out/f'{name}.wav'
    with wave.open(str(dest),"wb") as w:w.setnchannels(2);w.setsampwidth(2);w.setframerate(SR);w.writeframes(np.clip(clip*32768,-32768,32767).astype(np.int16).tobytes())
    sources.append({"id":name,"kind":"audio","path":dest.name,"sha256":sha(dest)})
def marks(name):return json.loads((cap/"game"/f'{name}.json').read_text())["marks"]
site=json.loads((cap/"site/site-1920x1080.json").read_text());tour={m["name"]:m["frame"] for m in site["marks"]}
manual_path=cap/"site/site-1920x1080-manual.json"
man={m["name"]:m["frame"] for m in json.loads(manual_path.read_text())["marks"]} if manual_path.exists() else {}
opening=json.loads((cap/"site/site-1920x1080-opening.json").read_text());om={m["name"]:m["frame"] for m in opening["marks"]}
resolve=lambda name:om[name] if name in om else next(v for k,v in om.items() if k.startswith(name.split("|")[0]+"|"))
shots=[];layers=[{"id":"bed","source":"bed","role":"bed","startBeat":0,"gain":1,"fadeIn":.05,"fadeOut":1.2,"fadeOutAt":total+.1}];start=0
for i,s in enumerate(original):
    kind=s["kind"];source=s.get("clip","link-host")
    shot={"id":f'shot-{i+1:02}',"startBeat":start,"beats":s["b"],"kind":{"game":"video","site":"video"}.get(kind,kind)}
    fx=s.get("fx","cut");shot["transition"]={"type":{"drop":"dither","tear":"scanline-tear","glitch-in":"glitch","dither-in":"dither"}.get(fx,"cut"),"referenceEffect":fx}
    if kind=="opening":
        shot["source"]="opening";shot["ramp"]=[{"beat":b,"frame":resolve(name)+off} for b,name,off in s["keys"]]
        shot["rampVariants"]=[]
        for target,w,h in (("16x9",1920,1080),("9x16",1080,1920),("1x1",1080,1080)):
            meta=json.loads((cap/"site"/f"site-{w}x{h}-opening.json").read_text())
            vm={m["name"]:m["frame"] for m in meta["marks"]}
            def resolve_variant(name):return vm[name] if name in vm else next(v for k,v in vm.items() if k.startswith(name.split("|")[0]+"|"))
            shot["rampVariants"].append({"target":target,"ramp":[{"beat":b,"frame":resolve_variant(name)+off} for b,name,off in s["keys"]]})
        shot["transition"].update(type="match-cut",sourceRect={"x":480,"y":131,"width":960,"height":864},
                                  targetRect={"x":400,"y":36,"width":1120,"height":1008},zoomStartBeat=s["match"][0])
    elif kind=="card":shot["text"]={"lines":s["lines"],"font":"crucible-pixel.ttf","fontSize":8,"scale":8,"typingCps":40}
    elif kind=="site":
        shot["source"]="tour" if s["at"] in tour else "manual";f=(tour if s["at"] in tour else man)[s["at"]]
        shot["in"]=(f+int(s.get("skip",0)*30))/30
    elif kind=="end":shot["source"]="title"
    else:
        shot["source"]=source
        if kind=="pair":shot["source"]="link-host";shot["secondSource"]="link-guest";source="link-host"
        if s.get("keys"):shot["ramp"]=[{"beat":b,"frame":marks(source)[mark][idx]+offset} for b,mark,idx,offset in s["keys"]]
        else:
            mark,idx,offset=s["at"];frame=max(0,marks(source)[mark][idx]+int(round(offset*59.7275)));shot["in"]=frame/59.7275
    for key in ("speed","energy","stutter","shake"):
        if key in s:shot[key]=s[key]
    if s.get("caption"):shot["caption"]={"lines":[s["caption"]],"font":"crucible-pixel.ttf","fontSize":8,"scale":5,"typingCps":34}
    shots.append(shot)
    for j,(b,name,gain) in enumerate(s.get("sfx",[])):
        layers.append({"id":f'fx-{i}-{j}',"source":name,"role":"sfx","startBeat":start+b,"gain":gain})
    if fx=="glitch-in" and not s.get("sfx"):layers.append({"id":f'fx-auto-{i}',"source":"glitch","role":"sfx","startBeat":start,"gain":.5})
    start+=s["b"]
t={"version":1,"name":"CRUCIBLE-trailer","fps":30,"seed":7,"tempo":{"beatSeconds":period,"bpm":60/period,"firstDownbeat":0,"audioSource":"bed","mode":"declared"},
   "sources":sources,"shots":shots,"audio":layers,
   "targets":[{"id":id,"width":w,"height":h,"maxBytes":14500000,"loudness":-14,"truePeak":-1.5,"posterBeat":64+3/period} for id,w,h in (("16x9",1920,1080),("9x16",1080,1920),("1x1",1080,1080))],
   "reference":{"profile":"crucible-v3","capturesRoot":"captures","font":"crucible-pixel.ttf","title":"CRUCIBLE.EXE","subtitle":"8 MiB · GAME BOY COLOR","url":"CRUCIBLE.ONKEEL.IO","handle":"@R4VONUS"}}
(out/"timeline.json").write_text(json.dumps(t,indent=2)+"\n")
(out/"capture-manifest.json").write_text(json.dumps({"files":manifest,"fontSha256":sha(font),"prototypeEditSha256":sha(Path(__file__).parent/"edit-v3.json")},indent=2)+"\n")
print(json.dumps({"timeline":str(out/"timeline.json"),"captures":str(cap),"beats":start,"duration":total}))
