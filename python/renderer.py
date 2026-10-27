"""Generic raster compositor and shared reproducible ffmpeg render orchestration."""
import copy,hashlib,json,math,subprocess,sys
from pathlib import Path
import numpy as np
from PIL import Image,ImageDraw,ImageFont
from common import *
from materials import transition,zoom
import montage as M

class Reader:
    """Frames of one source. With `alpha: true` (GIF, WebP, ProRes 4444, VP9 with alpha, PNG) the source keeps its own
    transparency: `frame()` still returns RGB, premultiplied over black so every older code path sees a black ground (layers ask for `straight=True`),
    and `alpha_plane()` returns the real 0..1 alpha for layers, which then composite as true cut-outs."""
    def __init__(self,source,target=None):
        variant=next((v for v in source.get("variants",[]) if v["target"]==target),None)
        self.path=Path(variant["path"] if variant else source["path"]);self.image=None;self.cache=None
        self.alpha=bool(source.get("alpha"));self.channels=4 if self.alpha else 3;self.pix="rgba" if self.alpha else "rgb24"
        if source["kind"]=="image":
            self.image=np.array(Image.open(self.path).convert("RGBA" if self.alpha else "RGB"));self.fps=source.get("fps",30);return
        info=probe(self.path);stream=next(s for s in info["streams"] if s["codec_type"]=="video")
        self.w=stream["width"];self.h=stream["height"]
        a,b=stream["avg_frame_rate"].split("/");self.fps=source.get("fps",float(a)/float(b))
        self.count=int(float(stream.get("duration") or info["format"]["duration"])*self.fps+.5)
    def _raw(self,index):
        if self.image is not None:return self.image.copy()
        index=max(0,min(self.count-1,index));start=index//16*16
        if self.cache is None or self.cache[0]!=start:
            raw=run(["ffmpeg","-v","error","-threads","1","-ss",f"{start/self.fps:.9f}","-i",str(self.path),
                     "-frames:v","16","-fps_mode","passthrough","-f","rawvideo","-pix_fmt",self.pix,"-"]).stdout
            frames=np.frombuffer(raw,np.uint8).reshape(-1,self.h,self.w,self.channels)
            if not len(frames):raise ValueError(f"No frames at {index}: {self.path}")
            self.cache=(start,frames)
        return self.cache[1][min(index-start,len(self.cache[1])-1)].copy()
    def frame(self,index,straight=False):
        f=self._raw(index)
        if self.channels==3:return f
        if straight:return f[...,:3]
        a=f[...,3:4].astype(np.float32)/255;return np.clip(f[...,:3].astype(np.float32)*a+.5,0,255).astype(np.uint8)
    def alpha_plane(self,index):
        return self._raw(index)[...,3].astype(np.float32)/255 if self.alpha else None

def hex_color(v):return tuple(bytes.fromhex(v.lstrip("#")))

def fit_frame(frame,target,shot,source):
    W,H=target["width"],target["height"];r=shot.get("crop",target.get("crop"))
    if r:
        x,y,w,h=[int(r[k]) for k in ("x","y","width","height")];frame=frame[y:y+h,x:x+w]
        if not frame.size:raise ValueError("Crop does not intersect source")
    h,w=frame.shape[:2];mode=shot.get("fit","integer" if source.get("pixelArt") else "contain")
    safe=target.get("safeArea",{"x":0,"y":0,"width":W,"height":H});availw=int(safe["width"]);availh=int(safe["height"])
    if mode=="integer":
        k=shot.get("pixelScale",int(min(availw/w,availh/h)))
        if k<1 or k*w>availw or k*h>availh:raise ValueError("Pixel art does not fit at integer scale; increase target or crop explicitly")
        nw,nh=w*k,h*k
    else:
        scale=min(availw/w,availh/h) if mode=="contain" else max(availw/w,availh/h)
        nw,nh=max(1,round(w*scale)),max(1,round(h*scale))
    resized=np.array(Image.fromarray(frame).resize((nw,nh),Image.Resampling.NEAREST if source.get("pixelArt") or mode=="integer" else Image.Resampling.LANCZOS))
    canvas=np.zeros((H,W,3),np.uint8);x=int(safe["x"]+(availw-nw)//2);y=int(safe["y"]+(availh-nh)//2)
    x0=max(int(safe["x"]),x);y0=max(int(safe["y"]),y);x1=min(W,int(safe["x"]+availw),x+nw);y1=min(H,int(safe["y"]+availh),y+nh)
    canvas[y0:y1,x0:x1]=resized[y0-y:y1-y,x0-x:x1-x]
    return canvas

def draw_text(canvas,card,seconds,safe):
    k=card.get("scale",1);size=card.get("fontSize",8);font=ImageFont.truetype(card["font"],size)
    im=Image.fromarray(canvas);lines=[];line_height=size+4
    for original in card["lines"]:
        words=original.split(" ");row=""
        for word in words:
            proposed=(row+" "+word).strip()
            if (math.ceil(font.getlength(proposed))+2)*k>safe["width"]:
                if not row:raise ValueError("Text does not fit safe area at declared integer scale")
                lines.append(row);row=word
            else:row=proposed
        lines.append(row)
    total_height=len(lines)*line_height*k
    y=int(card.get("y",safe["y"]+(safe["height"]-total_height)/2))
    if y<safe["y"] or y+total_height>safe["y"]+safe["height"]:raise ValueError("Text extends outside safe area")
    limit=int(seconds*card["typingCps"]) if card.get("typingCps") else None
    if card.get("flicker") and int(seconds*12)%7==0:return canvas
    for line in lines:
        rendered=line if limit is None else line[:max(0,limit)]
        if limit is not None:limit-=len(line)
        width=int(math.ceil(font.getlength(line)))+2;height=line_height
        mask=Image.new("1",(max(1,width),height));d=ImageDraw.Draw(mask);d.fontmode="1";d.text((0,0),rendered,font=font,fill=1)
        mask=mask.resize((width*k,height*k),Image.Resampling.NEAREST)
        x=int(card.get("x",safe["x"]+(safe["width"]-width*k)/2))
        if x<safe["x"] or x+width*k>safe["x"]+safe["width"]:raise ValueError("Text extends outside safe area")
        im.paste(hex_color(card.get("color","#ffffff")),(x,y),mask);y+=line_height*k
    return np.array(im)

def lerp(a,b,u):return a+(b-a)*u

_static={}
def erase_masks(reader,source,layer):
    """Static-bright masks (burned-in text) for a layer's `erase` entries, computed once per source and parameters
    from frames spread over the whole clip, so the same pixels are removed on every frame."""
    out=[]
    for e in layer.get("erase",[]):
        spec=e.get("staticBright")
        if not spec:continue
        count=getattr(reader,"count",1) or 1
        # Only the part of the clip the layer actually plays: a caption that is on screen for part of the clip is
        # still static over that part.
        lo=0 if layer.get("loop") or "in" not in layer else min(count-1,int(layer["in"]*reader.fps))
        hi=count if layer.get("loop") or "out" not in layer else max(lo+1,min(count,int(layer["out"]*reader.fps)))
        key=(source["path"],json.dumps(spec,sort_keys=True),lo,hi)
        if key not in _static:
            n=max(1,min(int(spec.get("samples",24)),hi-lo))
            picks=sorted({lo+int(round(i*(hi-lo-1)/max(1,n-1))) for i in range(n)}) if n>1 else [lo]
            frames=[reader.frame(i) for i in picks]
            _static[key]=M.static_bright_mask(frames,spec.get("above",.78),spec.get("grow",6),spec.get("within"))
        out.append(_static[key])
    return out

def layer_patch(comp,layer,shot,b,seconds,W,H,probe=None):
    """Render one visual layer to (patch, x, y, alpha). The source is cropped, pushed in, fitted into
    its rect and masked; nothing here changes the source's orientation. `probe`, when given, records the
    uncropped source frame and the window used, for the lint."""
    reader=comp.reader(layer["source"]);index=source_frame(layer,b,seconds,reader.fps)
    if layer.get("loop") and getattr(reader,"count",None):index%=reader.count
    frame=reader.frame(index,straight=True);crop=layer.get("crop");src_alpha=reader.alpha_plane(index)
    if layer.get("erase"):
        frame=M.erase_regions(frame,[e["rect"] for e in layer["erase"] if "rect" in e],erase_masks(reader,comp.sources[layer["source"]],layer))
    if probe is not None:probe["source"]=frame
    if crop:
        x,y,w,h=[int(crop[k]) for k in ("x","y","width","height")];frame=frame[y:y+h,x:x+w]
        if src_alpha is not None:src_alpha=src_alpha[y:y+h,x:x+w]
        if not frame.size:raise ValueError("Layer crop does not intersect source")
    fh,fw=frame.shape[:2];u=min(1.,max(0.,b/shot["beats"]))
    k=max(1.,lerp(layer.get("scaleFrom",1.),layer.get("scaleTo",layer.get("scaleFrom",1.)),u))
    ww,wh=fw/k,fh/k;cx=fw/2+layer.get("driftX",0)*fw*(u-.5);cy=fh/2+layer.get("driftY",0)*fh*(u-.5)
    cx=min(max(cx,ww/2),fw-ww/2);cy=min(max(cy,wh/2),fh-wh/2)
    rect=next((v["rect"] for v in layer.get("rectVariants",[]) if v["target"]==comp.target["id"]),layer.get("rect",{"x":0,"y":0,"width":W,"height":H}))
    rw,rh=int(rect["width"]),int(rect["height"])
    if layer.get("fit","cover")=="cover":
        ratio=rw/rh
        if ww/wh>ratio:ww=wh*ratio
        else:wh=ww/ratio
        pw,ph=rw,rh
    else:
        scale=min(rw/ww,rh/wh);pw,ph=max(1,round(ww*scale)),max(1,round(wh*scale))
    x0=int(round(cx-ww/2));y0=int(round(cy-wh/2));x1=max(x0+1,int(round(cx+ww/2)));y1=max(y0+1,int(round(cy+wh/2)))
    window=frame[max(0,y0):y1,max(0,x0):x1]
    patch=np.array(Image.fromarray(window).resize((pw,ph),Image.Resampling.LANCZOS))
    cutout=None
    if src_alpha is not None:cutout=np.clip(np.array(Image.fromarray((src_alpha[max(0,y0):y1,max(0,x0):x1]*255+.5).astype(np.uint8)).resize((pw,ph),Image.Resampling.LANCZOS)).astype(np.float32)/255,0,1)
    if probe is not None:probe["window"]=(window.shape[1],window.shape[0])
    if layer.get("blackPoint"):
        bp=layer["blackPoint"]*255;patch=np.clip((patch.astype(np.float32)-bp)*(255/(255-bp))+.5,0,255).astype(np.uint8)
    if layer.get("invert"):patch=255-patch
    if layer.get("posterize"):
        n=layer["posterize"];patch=(np.floor(patch.astype(np.float32)/256*n)*(255/(n-1))).astype(np.uint8)
    alpha=np.ones((ph,pw),np.float32) if cutout is None else cutout
    if layer.get("mask"):alpha=alpha*M.soft_mask(ph,pw,layer["mask"],layer.get("feather",.35))
    opacity=layer.get("opacity",1.)
    if layer.get("fadeInBeats"):opacity*=min(1.,b/layer["fadeInBeats"])
    if layer.get("fadeOutBeats"):opacity*=min(1.,(shot["beats"]-b)/layer["fadeOutBeats"])
    x=int(rect["x"]+(rw-pw)//2);y=int(rect["y"]+(rh-ph)//2)
    # `inside` keeps the whole piece in the frame: a satellite placed near an edge slides in instead of being cut.
    if layer.get("inside"):x=max(0,min(x,W-pw));y=max(0,min(y,H-ph))
    return patch,x,y,alpha*opacity

def composite_layers(comp,frame,shot,b,seconds):
    H,W=frame.shape[:2]
    for layer in shot.get("layers",[]):
        patch,x,y,alpha=layer_patch(comp,layer,shot,b,seconds,W,H)
        ph,pw=patch.shape[:2];X0,Y0=max(0,x),max(0,y);X1,Y1=min(W,x+pw),min(H,y+ph)
        if X1<=X0 or Y1<=Y0:continue
        sub=(slice(Y0-y,Y1-y),slice(X0-x,X1-x))
        frame[Y0:Y1,X0:X1]=M.blend(frame[Y0:Y1,X0:X1],patch[sub],alpha[sub],layer.get("blend","normal"))
    return frame

def apply_post(frame,post,global_beat):
    if post.get("bloom"):
        b=post["bloom"];frame=M.bloom(frame,b["radius"],b["gain"],b.get("threshold",.35))
    if post.get("pulse"):
        p=post["pulse"];frame=M.zoom_about_center(frame,1+p["amount"]*(.5-.5*math.cos(2*math.pi*global_beat/p["periodBeats"])))
    if post.get("chroma"):frame=M.chroma(frame,post["chroma"]["pixels"],post["chroma"].get("radial",True))
    return frame

def cross_transition(a_static,prev_out,prev_in,cur,p,tr,seed):
    kind=tr["type"];seed=tr.get("seed",seed)
    if kind=="datamosh":return M.datamosh_step(prev_out,prev_in,cur,p,tr.get("blockSize",16),tr.get("strength",1.),seed)
    if kind=="dissolve":return M.blend(a_static,cur,np.full(cur.shape[:2],M.ease(p),np.float32))
    if kind=="mosaic":return M.mosaic_mix(a_static,cur,p,tr.get("blockSize",64),seed)
    if kind=="displace":return M.displace_mix(a_static,cur,p,tr.get("strength",24),seed)
    raise ValueError("Unsupported cross transition "+kind)
CROSS={"datamosh","mosaic","displace","dissolve"}

class GenericCompositor:
    def __init__(self,t,target):
        self.t=t;self.target=target;self.shots=[]
        for shot in t["shots"]:
            s=dict(shot);variant=next((v for v in s.get("rampVariants",[]) if v["target"]==target["id"]),None)
            if variant:s["ramp"]=variant["ramp"]
            self.shots.append(s)
        self.sources={s["id"]:s for s in t["sources"]};self.readers={};self.prev=None;self.frozen=None;self.shot=None;self.incoming=None
        self.rng=np.random.default_rng(t.get("seed",7))
    def reader(self,id):
        if id not in self.readers:self.readers[id]=Reader(self.sources[id],self.target["id"])
        return self.readers[id]
    def draw(self,tt):
        tempo=self.t["tempo"];s=next((s for s in self.shots if edit_time(tempo,s["startBeat"])<=tt<edit_time(tempo,s["startBeat"]+s["beats"])),self.shots[-1])
        seconds=tt-edit_time(tempo,s["startBeat"]);b=local_beat(tempo,s["startBeat"],seconds);W,H=self.target["width"],self.target["height"]
        if self.shot is not s:self.frozen=self.prev;self.shot=s;self.incoming=None;self.readers.clear()
        if s["kind"]=="stage":
            frame=np.empty((H,W,3),np.uint8);frame[:]=hex_color(self.t.get("background","#000000"))
        elif s["kind"]=="card":
            frame=np.empty((H,W,3),np.uint8);frame[:]=hex_color(s["text"].get("background",self.t.get("background","#000000")))
        elif s["kind"]=="pair":
            landscape=W>=H
            parts=[]
            for id in (s["source"],s["secondSource"]):
                r=self.reader(id);f=r.frame(source_frame(s,b,seconds,r.fps));sub=dict(self.target,width=W//2 if landscape else W,height=H if landscape else H//2);sub.pop("safeArea",None)
                parts.append(fit_frame(f,sub,s,self.sources[id]))
            frame=np.concatenate(parts,axis=1 if landscape else 0)
        else:
            r=self.reader(s["source"]);frame=fit_frame(r.frame(source_frame(s,b,seconds,r.fps)),self.target,s,self.sources[s["source"]])
        if s.get("layers"):frame=composite_layers(self,frame,s,b,seconds)
        if s.get("post"):frame=apply_post(frame,s["post"],s["startBeat"]+b)
        safe=self.target.get("safeArea",{"x":0,"y":0,"width":W,"height":H})
        if s.get("text"):frame=draw_text(frame,s["text"],seconds,safe)
        if s.get("caption"):frame=draw_text(frame,s["caption"],seconds,safe)
        tr=s.get("transition",{});kind=tr.get("type","cut");composed=frame
        if kind=="match-cut":
            source=tr.get("sourceRect")
            if source is None:
                meta=json.loads(Path(self.sources[s["source"]]["metadataPath"]).read_text())
                frames=meta.get("rects",[]);rows=[x for x in frames if tr["rectSelector"] in x.get("elements",{})]
                if not rows:raise ValueError("No exported element rect for match cut")
                source=rows[-1]["elements"][tr["rectSelector"]]
            start=tr.get("zoomStartBeat",max(0,s["beats"]-tr.get("beats",1)))
            p=np.clip((b-start)/(s["beats"]-start),0,1)
            frame=zoom(frame,source,tr["targetRect"],p)
        elif kind!="cut" and self.frozen is not None:
            dur=edit_time(tempo,s["startBeat"]+tr.get("beats",.25))-edit_time(tempo,s["startBeat"])
            if seconds<dur:
                p=seconds/max(dur,1e-9)
                if kind in CROSS:frame=cross_transition(self.frozen,self.prev,self.incoming,composed,p,tr,self.t.get("seed",7))
                else:frame=transition(self.frozen,composed,p,kind,tr.get("pixelScale",1),self.rng)
        self.incoming=composed;self.prev=frame;return frame

class ReferenceCompositor:
    def __init__(self,t,target):
        import crucible_v3 as ref
        ref.configure(t,target['id']);self.ref=ref;self.layout=ref.LAYOUT[target["id"]]
        if (target["width"],target["height"])!=(self.layout["W"],self.layout["H"]):raise ValueError("Reference targets retain original dimensions")
        self.rng=np.random.default_rng(t.get("seed",7))
    def draw(self,tt):return self.ref.render(self.layout,tt,self.rng)

class LoopCompositor:
    """Output starts `lead` seconds into the authored timeline. Its last `lead` seconds hand the authored
    tail over to the opening (the seam target) with the declared transition, so the final frame is the
    frame that precedes the first and the video can loop without a visible join."""
    def __init__(self,t,target):
        self.t=t;self.main=GenericCompositor(t,target);self.head=GenericCompositor(t,target)
        tempo=t["tempo"];end=t["shots"][-1];self.lead=edit_time(tempo,t["loop"]["seamBeats"])
        self.total=edit_time(tempo,end["startBeat"]+end["beats"])-self.lead
        tr=t["loop"]["transition"];self.tr=tr;self.dur=edit_time(tempo,tr.get("beats",t["loop"]["seamBeats"]))
        self.prev=None;self.head_prev=None
    def draw(self,tt):
        tail=self.main.draw(tt+self.lead);start=self.total-self.lead
        if tt<start-1e-9:return tail
        h=tt-start;head=self.head.draw(h);p=min(1.,h/max(self.dur,1e-9))
        if p>=1:out=head
        elif self.tr["type"] in CROSS:out=cross_transition(tail,self.prev if self.prev is not None else tail,self.head_prev,head,p,self.tr,self.t.get("seed",7))
        else:out=transition(tail,head,p,self.tr["type"],self.tr.get("pixelScale",1),self.main.rng)
        self.prev=out;self.head_prev=head;return out

def output_seconds(t):
    end=t["shots"][-1];total=edit_time(t["tempo"],end["startBeat"]+end["beats"])
    return total-edit_time(t["tempo"],t["loop"]["seamBeats"]) if t.get("loop") else total

def compositor(t,target):
    if t.get("reference"):return ReferenceCompositor(t,target)
    return LoopCompositor(t,target) if t.get("loop") else GenericCompositor(t,target)

def ending_timeline(t,target):
    """The timeline and target for the ending loop. The final shot keeps playing from the frame after the main
    video's last one, in a steady state (fades done, pushes held), and its last `seamBeats` blend back into the
    frames it showed `seamBeats` before the main video ended, so the loop's last frame leads into its first and its
    first frame continues the main video's last. Needs a constant tempo (checked by the schema)."""
    e=t["ending"];tempo=t["tempo"];end=t["shots"][-1]
    bs=beat_time(tempo,1)-beat_time(tempo,0);D=end["beats"]*bs;seam=e["seamBeats"]*bs
    shot=copy.deepcopy(end);shot.update(startBeat=0,beats=(e["seconds"]+seam)/bs);shot.pop("transition",None)
    for layer in shot["layers"]:
        layer.pop("fadeInBeats",None)
        if "scaleTo" in layer:layer["scaleFrom"]=layer["scaleTo"]
        if "holdFrame" not in layer:layer["in"]=layer.get("in",0)+(D-seam)*layer.get("speed",1)
    t2={k:v for k,v in t.items() if k not in ("ending","audio")};t2.update(name=t["name"]+"-loop",shots=[shot],loop={"seamBeats":e["seamBeats"],"transition":e["transition"]})
    cap=target.get("loopMaxBytes",target.get("maxBytes"))
    target2={k:v for k,v in target.items() if k not in ("loopMaxBytes","maxBytes","posterBeat")}
    if cap:target2["maxBytes"]=cap
    t2["targets"]=[target2]
    return t2,target2

def small_frames(path,w,h,div=4):
    sw,sh=max(2,w//div),max(2,h//div)
    raw=run(["ffmpeg","-v","error","-i",str(path),"-vf",f"scale={sw}:{sh}:flags=area","-f","rawvideo","-pix_fmt","rgb24","-"]).stdout
    return np.frombuffer(raw,np.uint8).reshape(-1,sh,sw,3)

def mean_abs(a,b):return float(np.abs(a.astype(np.float32)-b.astype(np.float32)).mean())

def seam_report(main_path,loop_path,target):
    """How continuous the ending loop is, measured on the lossless renders: the wrap (loop's last frame to its first)
    and the hand-over (main video's last frame to the loop's first) against the video's own frame-to-frame change."""
    lo=small_frames(loop_path,target["width"],target["height"]);mi=small_frames(main_path,target["width"],target["height"])
    steps=sorted(mean_abs(lo[i],lo[i+1]) for i in range(len(lo)-1)) or [0.];median=steps[len(steps)//2]
    main_steps=sorted(mean_abs(mi[i],mi[i+1]) for i in range(max(0,len(mi)-25),len(mi)-1)) or [0.]
    wrap=mean_abs(lo[-1],lo[0]);hand=mean_abs(mi[-1],lo[0])
    wrap_limit=max(3*median,2.);hand_limit=max(3*max(median,main_steps[len(main_steps)//2]),2.)
    return {"frames":len(lo),"medianStep":round(median,4),"wrapDelta":round(wrap,4),"wrapLimit":round(wrap_limit,4),"wrapPassed":wrap<=wrap_limit,
            "handoverDelta":round(hand,4),"handoverLimit":round(hand_limit,4),"handoverPassed":hand<=hand_limit}

def render_video(t,target,video):
    comp=compositor(t,target);fps=t["fps"];total=output_seconds(t)
    # Preserve original v3 floor duration; generic timelines cover their final boundary.
    frames=int(total*fps) if t.get("reference") else int(math.ceil(total*fps-1e-9))
    proc=subprocess.Popen(["ffmpeg","-v","error","-y","-f","rawvideo","-pix_fmt","rgb24","-s",f'{target["width"]}x{target["height"]}',
                           "-r",str(fps),"-i","-","-c:v","ffv1","-threads","1","-fflags","+bitexact","-flags:v","+bitexact",str(video)],stdin=subprocess.PIPE)
    digest=hashlib.sha256()
    try:
        for i in range(frames):
            data=np.ascontiguousarray(comp.draw(i/fps)).tobytes();digest.update(data);proc.stdin.write(data)
            if i%150==0:print(f'{target["id"]}: {i}/{frames}',file=sys.stderr,flush=True)
        proc.stdin.close()
        if proc.wait():raise RuntimeError("ffmpeg lossless encoder failed")
    finally:
        if proc.poll() is None:proc.kill();proc.wait()
    return {"frames":frames,"rgbSha256":digest.hexdigest()}

def mux(t,target,video,audio,final,preview):
    fps=t["fps"];duration=float(probe(video)["format"]["duration"]);silent=target.get("silent",False)
    common=["-c:v","libx264","-threads","1","-tune","animation","-pix_fmt","yuv420p","-profile:v","high","-movflags","+faststart",
            "-r",str(fps),"-map_metadata","-1","-fflags","+bitexact","-flags:v","+bitexact"]
    aud=["-an"] if silent else ["-c:a","aac","-b:a","160k","-ar","48000","-flags:a","+bitexact"]
    inputs=["-i",str(video)] if silent else ["-i",str(video),"-i",str(audio)]
    tail=[] if silent else ["-shortest"]
    if preview or not target.get("maxBytes"):
        crf=str(30 if preview else target.get("crf",18))
        run(["ffmpeg","-v","error","-y",*inputs,*common,"-preset","veryfast" if preview else "slow","-crf",crf,*aud,*tail,str(final)])
    else:
        kbps=int(target["maxBytes"]*8*.95/duration/1000-(0 if silent else 160))
        if kbps<64:raise ValueError("Size cap cannot fit audio and video")
        log=str(final.with_suffix(".pass"))
        for attempt in range(3):
            run(["ffmpeg","-v","error","-y","-i",str(video),*common,"-preset","slow","-b:v",str(kbps)+"k","-pass","1","-passlogfile",log,"-an","-f","mp4","/dev/null"])
            run(["ffmpeg","-v","error","-y",*inputs,*common,"-preset","slow","-b:v",str(kbps)+"k","-pass","2","-passlogfile",log,*aud,*tail,str(final)])
            if final.stat().st_size<=target["maxBytes"]:break
            kbps=int(kbps*target["maxBytes"]/final.stat().st_size*.97)
        if final.stat().st_size>target["maxBytes"]:raise ValueError("Encoded file exceeds size cap")
        for path in final.parent.glob(final.stem+".pass*"):path.unlink()

def ensure_delivery_audio(t,target,raw,audio,final):
    """Measure AAC delivery, then lower normalization ceiling for codec overshoot."""
    ceiling=target.get("truePeak",-1.5);eq="lowpass=f=9000,highpass=f=35" if t.get("reference") else ""
    measured=loudness(final);margin=0.;adjustments=[]
    for attempt in range(3):
        if measured["truePeakDBTP"] is None or measured["truePeakDBTP"]<=ceiling:break
        margin+=measured["truePeakDBTP"]-ceiling+.2
        normalize(raw,audio,target.get("loudness",-14),max(-9,ceiling-margin),eq)
        temp=final.with_name(final.stem+"-audio-adjust.mp4")
        run(["ffmpeg","-v","error","-y","-i",str(final),"-i",str(audio),"-map","0:v:0","-map","1:a:0","-c:v","copy","-c:a","aac","-b:a","160k","-ar","48000","-threads","1",
             "-map_metadata","-1","-fflags","+bitexact","-flags:a","+bitexact","-movflags","+faststart","-shortest",str(temp)])
        temp.replace(final);measured=loudness(final);adjustments.append({"normalizationCeilingDBTP":max(-9,ceiling-margin),**measured})
    return {"delivery":measured,"adjustments":adjustments}

def stills(t,out,times,targets=None):
    out=Path(out);out.mkdir(parents=True,exist_ok=True);items=[]
    for target in t["targets"]:
        if targets and target["id"] not in targets:continue
        comp=compositor(t,target);wanted={int(math.floor(ts*t["fps"])):ts for ts in times};fps=t["fps"]
        for i in range(max(wanted)+1):
            frame=comp.draw(i/fps)
            if i in wanted:
                path=out/f'still-{target["id"]}-{wanted[i]:08.3f}.png';Image.fromarray(frame).save(path)
                items.append({"target":target["id"],"requestedSeconds":wanted[i],"frame":i,"seconds":i/fps,"path":str(path),"sha256":sha(path)})
    sheet=contact_sheet([x["path"] for x in items],out/"stills-sheet.png")
    return {"stills":items,"sheet":str(sheet),"method":"Replay from frame zero, preserving transition state and RNG"}

def export_frame(video,seconds,out):
    # Decode pixels through ffmpeg; Pillow owns PNG writing, including on minimal runtimes.
    info=probe(video);v=next(s for s in info["streams"] if s["codec_type"]=="video")
    raw=run(["ffmpeg","-v","error","-threads","1","-ss",f"{seconds:.9f}","-i",str(video),
             "-frames:v","1","-f","rawvideo","-pix_fmt","rgb24","-"]).stdout
    expected=v["height"]*v["width"]*3
    if len(raw)!=expected:raise ValueError(f"Expected one frame at {seconds}: {video}")
    Image.fromarray(np.frombuffer(raw,np.uint8).reshape(v["height"],v["width"],3)).save(out)

def contact_sheet(paths,out):
    tiles=[]
    for path in paths:
        im=Image.open(path).convert("RGB");im.thumbnail((320,240),Image.Resampling.NEAREST)
        tile=Image.new("RGB",(340,270));tile.paste(im,((340-im.width)//2,0))
        ImageDraw.Draw(tile).text((8,245),Path(path).name,fill="white");tiles.append(tile)
    cols=min(4,max(1,len(tiles)));sheet=Image.new("RGB",(cols*340,math.ceil(len(tiles)/cols)*270))
    for i,tile in enumerate(tiles):sheet.paste(tile,((i%cols)*340,(i//cols)*270))
    sheet.save(out);return out

def render(t,out,preview=False,targets=None):
    out=Path(out);out.mkdir(parents=True,exist_ok=True);work=out/"work";work.mkdir(exist_ok=True)
    raw=audio_mix(t,work/"mix-raw.wav") if any(not x.get("silent") for x in t["targets"] if not targets or x["id"] in targets) else None;items=[];loops=[]
    for target in t["targets"]:
        if targets and target["id"] not in targets:continue
        silent=target.get("silent",False);audio=None if silent else work/f'mix-{target["id"]}.wav'
        if not silent:normalize(raw,audio,target.get("loudness",-14),target.get("truePeak",-1.5),"lowpass=f=9000,highpass=f=35" if t.get("reference") else "")
        video=work/f'video-{target["id"]}.mkv';pixels=render_video(t,target,video)
        final=out/f'{t["name"]}-{target["id"]}.mp4';mux(t,target,video,audio,final,preview)
        audio_result=None if silent else ensure_delivery_audio(t,target,raw,audio,final)
        frames=pixels["frames"]
        # Poster comes from exact rendered output frame, not an independently seeded draw.
        poster=out/f'poster-{target["id"]}.png';lead=edit_time(t["tempo"],t["loop"]["seamBeats"]) if t.get("loop") else 0
        time=edit_time(t["tempo"],target.get("posterBeat",t["shots"][-1]["startBeat"]))-lead
        export_frame(video,max(0,min(time,(frames-1)/t["fps"])),poster)
        items.append({"target":target["id"],"path":str(final),"bytes":final.stat().st_size,"sha256":sha(final),"losslessPath":str(video),"poster":str(poster),"audio":audio_result,**pixels})
        if t.get("ending"):
            t2,target2=ending_timeline(t,target);loop_video=work/f'video-{target["id"]}-loop.mkv';loop_pixels=render_video(t2,target2,loop_video)
            loop_final=out/f'{t["name"]}-{target["id"]}-loop.mp4';mux(t2,target2,loop_video,None,loop_final,preview)
            loops.append({"target":target["id"],"path":str(loop_final),"bytes":loop_final.stat().st_size,"sha256":sha(loop_final),"losslessPath":str(loop_video),"seconds":t["ending"]["seconds"],**loop_pixels})
    manifest={"version":1,"preview":preview,"outputs":items,**({"loops":loops} if loops else {}),"inputs":[{"id":s["id"],"sha256":sha(s["path"])} for s in t["sources"]],
              "timelineSha256":hashlib.sha256(json.dumps(t,sort_keys=True,separators=(",",":")).encode()).hexdigest(),
              "ffmpeg":run(["ffmpeg","-version"]).stdout.decode().splitlines()[0],
              "determinism":"Single-threaded encodes, fixed seed, no wall-clock metadata. Hash equality is scoped to pinned toolchain and captures."}
    (out/"render.json").write_text(json.dumps(manifest,indent=2)+"\n")
    manifest["verification"]=verify(t,out)
    (out/"render.json").write_text(json.dumps(manifest,indent=2)+"\n")
    return manifest

def verify(t,out,tolerance=15,loudnessTolerance=.5):
    out=Path(out);manifest=json.loads((out/"render.json").read_text())
    lead=edit_time(t["tempo"],t["loop"]["seamBeats"]) if t.get("loop") else 0
    cuts=[c-lead for c in (edit_time(t["tempo"],s["startBeat"]) for s in t["shots"][1:]) if c-lead>0]
    bed=next((s for s in t["sources"] if s["id"]==t["tempo"].get("audioSource")),None)
    bed_layer=next((l for l in t.get("audio",[]) if l["source"]==t["tempo"].get("audioSource") and l["role"]=="bed"),None)
    offset=(bed_layer.get("in",beat_time(t["tempo"],0)) if bed_layer else beat_time(t["tempo"],0))+lead
    needs_audio=any(not x.get("silent") for x in t["targets"] if any(i["target"]==x["id"] for i in manifest["outputs"]))
    if bed:beat=attack_report(bed["path"],cuts,offset,tolerance)
    elif needs_audio:beat={"passed":False,"reason":"No declared tempo.audioSource to measure attacks"}
    else:beat={"passed":True,"skipped":"All verified targets are silent web deliveries; there is no audio to align."}
    rows=[];pics=[];framecuts=[math.ceil(c*t["fps"]-1e-9)/t["fps"] for c in cuts]
    encoded=attack_report(bed["path"],framecuts,offset,tolerance+1000/t["fps"]) if bed else None
    for item in manifest["outputs"]:
        target=next(x for x in t["targets"] if x["id"]==item["target"]);path=Path(item["path"]);silent=target.get("silent",False)
        budget=target.get("maxBytes")
        info=probe(path);v=next(x for x in info["streams"] if x["codec_type"]=="video");dimensions=v["width"]==target["width"] and v["height"]==target["height"]
        has_audio=any(x["codec_type"]=="audio" for x in info["streams"])
        if silent:
            loud={"integratedLUFS":None,"truePeakDBTP":None,"rangeLU":None};okI=okTP=not has_audio;delivered=None
        else:
            loud=loudness(path)
            okI=loud["integratedLUFS"] is not None and abs(loud["integratedLUFS"]-target.get("loudness",-14))<=loudnessTolerance
            # AAC can introduce small true-peak overshoot, measured on delivery bytes.
            okTP=loud["truePeakDBTP"] is not None and loud["truePeakDBTP"]<=target.get("truePeak",-1.5)+.1
            delivered=attack_report(path,framecuts,0,tolerance+1000/t["fps"]) if bed else None
        dur=float(info["format"]["duration"])
        times=[cuts[0] if cuts else 0,cuts[len(cuts)//2] if cuts else 0,max(0,dur-1)]
        for k,ts in enumerate(times):
            img=out/f'verify-{target["id"]}-{k}.png'
            export_frame(path,min(ts,max(0,dur-1/t["fps"])),img);pics.append(str(img))
        intact=sha(path)==item["sha256"]
        rows.append({"target":item["target"],"path":str(path),**loud,"silent":silent,"hasAudioStream":has_audio,"loudnessPassed":okI,"truePeakPassed":okTP,"bytes":path.stat().st_size,
                     "deliveredAttackAlignment":delivered,"maxBytes":budget,"sizePassed":budget is None or path.stat().st_size<=budget,"hashPassed":intact,"dimensionsPassed":dimensions,
                     "duration":dur,"passed":okI and okTP and dimensions and intact and (delivered is None or delivered["passed"]) and (budget is None or path.stat().st_size<=budget)})
    loop_rows=[]
    for item in manifest.get("loops",[]):
        target=next(x for x in t["targets"] if x["id"]==item["target"]);path=Path(item["path"]);info=probe(path);v=next(x for x in info["streams"] if x["codec_type"]=="video")
        main=next(i for i in manifest["outputs"] if i["target"]==item["target"]);cap=target.get("loopMaxBytes",target.get("maxBytes"))
        seam=seam_report(main["losslessPath"],item["losslessPath"],target)
        row={"target":item["target"],"path":str(path),"bytes":path.stat().st_size,"maxBytes":cap,"sizePassed":cap is None or path.stat().st_size<=cap,
             "hashPassed":sha(path)==item["sha256"],"dimensionsPassed":v["width"]==target["width"] and v["height"]==target["height"],
             "hasAudioStream":any(x["codec_type"]=="audio" for x in info["streams"]),"duration":float(info["format"]["duration"]),**seam}
        row["passed"]=row["sizePassed"] and row["hashPassed"] and row["dimensionsPassed"] and not row["hasAudioStream"] and seam["wrapPassed"] and seam["handoverPassed"]
        loop_rows.append(row)
    result={"version":1,"beatAlignment":beat,"quantizedFrameAlignment":encoded,
            "encodedAttackToleranceMs":tolerance+1000/t["fps"],"frameQuantization":[{"cut":c,"frame":math.ceil(c*t["fps"]-1e-9),"deltaMs":round((q-c)*1000,3)} for c,q in zip(cuts,framecuts)],
            "outputs":rows,"stillsSheet":str(contact_sheet(pics,out/"verification-sheet.png")),
            **({"loops":loop_rows} if loop_rows else {}),
            "passed":beat["passed"] and all(r["passed"] for r in rows) and all(r["passed"] for r in loop_rows),"preview":manifest["preview"]}
    (out/"verification.json").write_text(json.dumps(result,indent=2)+"\n");return result
