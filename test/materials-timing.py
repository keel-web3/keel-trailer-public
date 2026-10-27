"""Pixel invariants and shared timing behavior, independent of codec hashes."""
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'python'))
import numpy as np
from materials import transition,zoom,BAYER8
from common import source_frame,local_beat
# The canonical ordered matrix contains each threshold exactly once.
assert sorted(BAYER8.flat)==list(range(64))
a=np.zeros((16,16,3),np.uint8);b=np.full_like(a,128)
def fx(kind,p,seed=7):return transition(a,b,p,kind,2,np.random.default_rng(seed))
assert np.array_equal(fx('dither',0),a)
assert np.array_equal(fx('dither',1),b)
mid=fx('dither',.5)
assert (mid[:,:,0]==128).sum()==128
assert all(np.unique(mid[y:y+2,x:x+2]).size==1 for y in range(0,16,2) for x in range(0,16,2))
assert np.all(fx('flash',0)==255) and np.array_equal(fx('flash',1),b)
pattern=np.arange(16*16*3,dtype=np.uint8).reshape(16,16,3)
for kind in ('glitch','scanline-tear'):
    first=transition(a,pattern,.5,kind,2,np.random.default_rng(7))
    repeat=transition(a,pattern,.5,kind,2,np.random.default_rng(7))
    assert np.array_equal(first,repeat) and not np.array_equal(first,pattern)
# Rectangle corners land at declared coordinates on both axes, with nearest sampling.
source={'x':2,'y':4,'width':4,'height':2};target={'x':4,'y':2,'width':8,'height':8}
assert np.array_equal(zoom(pattern,source,target,0),pattern)
z=zoom(pattern,source,target,1)
assert np.array_equal(z[2,4],pattern[4,2])
assert np.array_equal(z[9,11],pattern[5,5])
# Match JavaScript half-up ramp rounding, including reversed ramps.
assert source_frame({'ramp':[{'beat':0,'frame':0},{'beat':2,'frame':1}]},1,.5,30)==1
assert source_frame({'ramp':[{'beat':0,'frame':1},{'beat':2,'frame':0}]},1,.5,30)==1
assert abs(local_beat({'beats':[2,2.5,3.2]},1,.35)-.5)<1e-12
print('pixel and timing invariants passed')
