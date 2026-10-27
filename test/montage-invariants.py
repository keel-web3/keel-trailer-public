"""Pixel invariants for layer blending, post effects and block-based transitions."""
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'python'))
import numpy as np
import montage as M
rng=np.random.default_rng(1)
a=rng.integers(0,255,(64,96,3),dtype=np.uint8);b=rng.integers(0,255,(64,96,3),dtype=np.uint8)
one=np.ones((64,96),np.float32);zero=np.zeros((64,96),np.float32)
# Blend modes keep their algebra and never leave 0..255.
assert np.array_equal(M.blend(a,b,zero,'add'),a) and np.array_equal(M.blend(a,b,one,'normal'),b)
assert np.all(M.blend(a,b,one,'add')>=np.maximum(a,b)-1) and M.blend(a,b,one,'add').max()<=255
assert np.all(M.blend(a,b,one,'screen').astype(int)>=np.maximum(a,b).astype(int)-1)
assert np.all(M.blend(a,b,one,'multiply').astype(int)<=np.minimum(a,b).astype(int)+1)
assert np.array_equal(M.blend(a,b,one,'difference'),M.blend(b,a,one,'difference'))
assert np.array_equal(M.blend(a,b,one,'lighten'),np.maximum(a,b))
black=np.zeros_like(a)
assert np.array_equal(M.blend(black,b,one,'screen'),b) and np.array_equal(M.blend(black,b,one,'add'),b)
# Masks are bounded, soft and centred.
for kind in ('ellipse','rect'):
    m=M.soft_mask(40,60,kind,.4);assert m.min()>=0 and m.max()<=1 and m[20,30]==1 and m[0,0]<.05
# Bloom adds light around bright pixels and never darkens.
dark=np.zeros((64,96,3),np.uint8);dark[24:40,40:56]=255;glow=M.bloom(dark,6,1.2,.2)
assert glow[32,60].sum()>0 and np.all(glow>=dark) and glow[32,48].min()==255
# Mosaic and displace: exact endpoints, determinism, genuine block steps.
for fn,args in ((M.mosaic_mix,(32,)),(M.displace_mix,(20,))):
    assert np.array_equal(fn(a,b,0,*args),a) and np.array_equal(fn(a,b,1,*args),b)
    x=fn(a,b,.5,*args);assert np.array_equal(x,fn(a,b,.5,*args)) and not np.array_equal(x,a) and not np.array_equal(x,b)
mid=M.mosaic_mix(a,b,.5,32,seed=3);size=1<<int(np.floor(np.log2(max(1,round(32*(1-.5)**1.6)))))
assert all(np.unique(mid[y:y+size,x:x+size].reshape(-1,3),axis=0).shape[0]==1 for y in range(0,64-size+1,size) for x in range(0,96-size+1,size))
assert not np.array_equal(M.mosaic_mix(a,b,.5,32,seed=3),M.mosaic_mix(a,b,.5,32,seed=4))
# Block motion recovers a known whole-pixel translation, and datamosh pushes the old frame along it.
base=rng.integers(0,255,(96,160,3),dtype=np.uint8);moved=np.roll(base,8,axis=1)
mv=M.block_motion(base,moved,16);interior=mv[1:-1,2:-2]
assert (interior[...,0]==8).mean()>.9 and (interior[...,1]==0).mean()>.9,interior
old=rng.integers(0,255,(96,160,3),dtype=np.uint8)
smear=M.datamosh_step(old,base,moved,0.,16,0.,7)
assert np.array_equal(smear[16:80,48:112],np.roll(old,8,axis=1)[16:80,48:112]) or (smear[16:80,48:112]==np.roll(old,8,axis=1)[16:80,48:112]).mean()>.9
assert np.array_equal(M.datamosh_step(old,base,moved,1.,16,1.,7),moved)
r1=M.datamosh_step(old,base,moved,.5,16,1.,7);assert np.array_equal(r1,M.datamosh_step(old,base,moved,.5,16,1.,7))
print('ok')
