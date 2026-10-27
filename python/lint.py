"""Static composition lint: finds the mistakes that make a montage look cut off or pasted on, before any render.

For every stage-shot layer, at a few moments in its shot, the layer is rendered through the same code the renderer
uses (so erase, crop, fit, mask and placement are all honoured) and four things are measured:

  cutoff     lit pixels run along an interior edge of the layer's `crop`, and the source continues past it: the crop
             slices through the work (a vertical slice of a diagonal subject, a caption box through a face).
  hard-edge  a layer meant to dissolve into the stage (masked, or blended screen/lighten/add) is still lit along the
             border of its own box, so a visible rectangle or a straight cut shows.
  clipped    part of the placed piece lies outside the frame and is lit, so the frame edge cuts it off.
  upscaled   the piece is drawn more than 1.25x larger than the source pixels it comes from (soft, a warning).

Deterministic and read-only: no frames are written and nothing is encoded.
"""
import numpy as np
from common import edit_time
from renderer import GenericCompositor,layer_patch

LIT=.15          # a pixel counts as lit above 15% of full scale
EDGE_COUNT=3     # ...and it takes a few of them in a row to matter, not one noisy pixel
BLENDS_THAT_DISSOLVE={"screen","lighten","add"}

def _value(img):return img.max(2).astype(np.float32)/255

def _strip(frame,x,y,w,h,side,depth=2,outside=False):
    """Pixels `depth` deep along one side of the rect (x,y,w,h), inside it or just outside it."""
    H,W=frame.shape[:2]
    if side=="left":x0,x1,y0,y1=(x-depth,x,y,y+h) if outside else (x,x+depth,y,y+h)
    elif side=="right":x0,x1,y0,y1=(x+w,x+w+depth,y,y+h) if outside else (x+w-depth,x+w,y,y+h)
    elif side=="top":x0,x1,y0,y1=(x,x+w,y-depth,y) if outside else (x,x+w,y,y+depth)
    else:x0,x1,y0,y1=(x,x+w,y+h,y+h+depth) if outside else (x,x+w,y+h-depth,y+h)
    return frame[max(0,y0):min(H,y1),max(0,x0):min(W,x1)]

def _lit_stats(strip):
    if not strip.size:return 0,0.
    v=_value(strip);lit=v>LIT;return int(lit.sum()),float(v.max())

def _crop_findings(source,crop):
    out=[]
    if not crop:return out
    sh,sw=source.shape[:2];x,y,w,h=[int(crop[k]) for k in ("x","y","width","height")]
    for side,interior in (("left",x>0),("right",x+w<sw),("top",y>0),("bottom",y+h<sh)):
        if not interior:continue
        n,peak=_lit_stats(_strip(source,x,y,w,h,side))
        if n<EDGE_COUNT:continue
        m,_=_lit_stats(_strip(source,x,y,w,h,side,outside=True))
        out.append({"side":side,"litPixels":n,"peak":round(peak,3),"continuesPastCrop":m>=EDGE_COUNT})
    return out

def _ring(alpha,patch):
    v=_value(patch)*alpha;ph,pw=v.shape
    ring=np.concatenate([v[0,:],v[-1,:],v[:,0],v[:,-1]]) if ph>1 and pw>1 else v.ravel()
    return int((ring>.08).sum()),float(ring.max())

def _hidden_fraction(patch,alpha,x,y,W,H):
    ph,pw=patch.shape[:2];energy=_value(patch)*alpha;total=float(energy.sum())
    if total<=0:return 0.,[]
    x0,x1,y0,y1=max(0,x),min(W,x+pw),max(0,y),min(H,y+ph)
    if x1<=x0 or y1<=y0:return 1.,["all"]
    visible=float(energy[y0-y:y1-y,x0-x:x1-x].sum());sides=[s for s,hit in (("left",x<0),("right",x+pw>W),("top",y<0),("bottom",y+ph>H)) if hit]
    return 1-visible/total,sides

FIX={
 "cutoff":"Use the whole source (drop `crop`) and remove captions with `erase` (`staticBright` finds burned-in text; `rect` paints a region), or move the crop edge onto dark pixels.",
 "hard-edge":"Give the layer `mask: \"ellipse\"` with a larger `feather`, blend it screen/lighten on black, or raise `blackPoint` so the source ground is pure black.",
 "clipped":"Set `inside: true` on the layer, or move its rect so the whole piece sits inside the frame.",
 "upscaled":"Make the rect smaller, or accept some softness; a satellite rarely needs to be larger than its source.",
}

def lint(t,targets=None,samples=3,strict=False):
    findings=[];checked=0
    for target in t["targets"]:
        if targets and target["id"] not in targets:continue
        comp=GenericCompositor(t,target);W,H=target["width"],target["height"];tempo=t["tempo"]
        for shot in comp.shots:
            for index,layer in enumerate(shot.get("layers",[])):
                allow=set(layer.get("lint",{}).get("allow",[]));extra=set(layer.get("lint",{}).get("check",[]))
                dissolving=bool(layer.get("mask")) or layer.get("blend","normal") in BLENDS_THAT_DISSOLVE
                for k in range(samples):
                    b=shot["beats"]*(k+.5)/samples;seconds=edit_time(tempo,shot["startBeat"]+b)-edit_time(tempo,shot["startBeat"])
                    probe={};patch,x,y,alpha=layer_patch(comp,layer,shot,b,seconds,W,H,probe);checked+=1
                    where={"target":target["id"],"shot":shot["id"],"layer":index,"source":layer["source"],"beat":round(b,3)}
                    def add(kind,severity,detail,**measured):
                        if kind in allow:return
                        findings.append({"kind":kind,"severity":severity,**where,"detail":detail,"measured":measured,"fix":FIX[kind]})
                    for c in _crop_findings(probe["source"],layer.get("crop")):
                        add("cutoff","error" if c["continuesPastCrop"] else "warn",
                            f'crop {c["side"]} edge is lit ({c["litPixels"]} px, peak {c["peak"]})'+(" and the source continues past it: the work is cut off" if c["continuesPastCrop"] else ""),**c)
                    if dissolving or "hard-edge" in extra:
                        n,peak=_ring(alpha,patch)
                        if n>=EDGE_COUNT and peak>.12:add("hard-edge","error",f"{n} border pixels are lit (peak {peak:.2f}); a straight edge shows",litPixels=n,peak=round(peak,3))
                    hidden,sides=_hidden_fraction(patch,alpha,x,y,W,H)
                    if hidden>.01:add("clipped","error",f"{hidden*100:.1f}% of the piece is outside the frame ({', '.join(sides)})",hiddenFraction=round(hidden,4),sides=sides)
                    ww,wh=probe.get("window",(patch.shape[1],patch.shape[0]));factor=patch.shape[1]/max(1,ww)
                    if factor>1.25:add("upscaled","warn",f"drawn {factor:.2f}x its source pixels",factor=round(factor,3))
    # One finding per (kind, shot, layer, target): keep the worst sample, count the rest.
    merged={}
    for f in findings:
        key=(f["kind"],f["target"],f["shot"],f["layer"]);rank=(f["severity"]=="error",sum(v for v in f["measured"].values() if isinstance(v,(int,float)) and not isinstance(v,bool)))
        if key not in merged:merged[key]={**f,"samples":1,"_rank":rank}
        else:
            merged[key]["samples"]+=1
            if rank>merged[key]["_rank"]:merged[key]={**f,"samples":merged[key]["samples"],"_rank":rank}
    rows=sorted(({k:v for k,v in f.items() if k!="_rank"} for f in merged.values()),key=lambda f:(f["severity"]!="error",f["shot"],f["layer"]))
    errors=[f for f in rows if f["severity"]=="error"];warns=[f for f in rows if f["severity"]=="warn"]
    return {"version":1,"checkedLayerSamples":checked,"findings":rows,"errors":len(errors),"warnings":len(warns),
            "passed":not errors and not (strict and warns),
            "summary":{kind:sum(1 for f in rows if f["kind"]==kind) for kind in FIX}}
