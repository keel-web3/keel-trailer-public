"""erase, true-alpha sources, `inside` placement and the ending loop's timeline derivation."""
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'python'))
import numpy as np
import montage as M,renderer as R
root=Path(sys.argv[1])
# staticBright removes a fixed caption and keeps the moving picture.
src={"id":"c","kind":"video","path":str(root/'captioned.mp4')};reader=R.Reader(src)
layer={"source":"c","erase":[{"staticBright":{"above":.9,"grow":2,"samples":8}}]}
masks=R.erase_masks(reader,src,layer);assert len(masks)==1 and masks[0][8:22,10:80].mean()>.7,"caption not found"
f=M.erase_regions(reader.frame(5),[],masks);assert f[8:22,10:80].max()<60,"caption not erased"
assert (f[40:100,:].max(2)>60).mean()>.3,"picture was erased too"
rect=M.erase_regions(reader.frame(5),[{"x":0,"y":0,"width":20,"height":20}]);assert rect[:20,:20].max()==0 and rect[40:,:].any()
# A source with alpha composites as a cut-out: the transparent ground contributes nothing even in normal blend.
gif={"id":"g","kind":"video","path":str(root/'sticker.gif'),"alpha":True};g=R.Reader(gif)
a=g.alpha_plane(0);assert a.min()==0 and a.max()==1 and .1<a.mean()<.6
target={"id":"web","width":160,"height":96};t={"fps":12,"seed":7,"tempo":{"bpm":120},"background":"#000000","sources":[gif],"targets":[target],
 "shots":[{"id":"s","kind":"stage","startBeat":0,"beats":4,"layers":[{"source":"g","fit":"contain","rect":{"x":100,"y":20,"width":80,"height":80},"inside":True}]}]}
comp=R.GenericCompositor(t,target);probe={}
patch,x,y,alpha=R.layer_patch(comp,t["shots"][0]["layers"][0],t["shots"][0],0,0,160,96,probe)
assert x+patch.shape[1]<=160 and y+patch.shape[0]<=96 and x>=0 and y>=0,"inside did not keep the piece in the frame"
assert alpha.min()<.05 and alpha.max()>.95,"cut-out alpha lost"
frame=np.full((96,160,3),90,np.uint8);out=R.composite_layers(comp,frame,t["shots"][0],0,0)
assert (out==90).mean()>.4,"transparent ground painted over the background"
# The ending's derived timeline continues the final shot, steady, and returns to the frames before the end.
t2={"name":"x","version":1,"fps":12,"seed":7,"tempo":{"bpm":120},"background":"#000000","sources":[gif],"targets":[dict(target,silent=True,loopMaxBytes=1000)],
 "shots":[{"id":"a","kind":"stage","startBeat":0,"beats":4,"layers":[{"source":"g","in":0,"fadeInBeats":1,"scaleFrom":1,"scaleTo":1.2,"rect":{"x":0,"y":0,"width":160,"height":96}}]}],
 "ending":{"kind":"loop","seconds":3,"seamBeats":2,"transition":{"type":"dissolve","beats":2}}}
d,dt=R.ending_timeline(t2,t2["targets"][0]);layer=d["shots"][0]["layers"][0]
assert abs(layer["in"]-1.0)<1e-9,layer   # shot is 2 s long, seam 1 s: the loop starts at source time 2 and its head at 1
assert "fadeInBeats" not in layer and layer["scaleFrom"]==1.2 and dt["maxBytes"]==1000 and "loopMaxBytes" not in dt
assert d["loop"]["seamBeats"]==2 and abs(d["shots"][0]["beats"]-8)<1e-9
print("ok")
