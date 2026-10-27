"""Layer compositing, post effects and block-based transitions for art montages.

Everything here is deterministic numpy: no wall clock, no unseeded randomness.
"""
import numpy as np
from PIL import Image,ImageFilter

def _f(a):return a.astype(np.float32)
def _u8(a):return np.clip(a+.5,0,255).astype(np.uint8)

def blend(dst,src,alpha,mode="normal"):
    """Composite src over dst (both HxWx3 uint8) through a per-pixel alpha in 0..1."""
    a=alpha[...,None] if alpha.ndim==2 else alpha;d=_f(dst);s=_f(src)
    if mode=="normal":out=d*(1-a)+s*a
    elif mode=="add":out=d+s*a
    elif mode=="screen":out=255-(255-d)*(255-s*a)/255
    elif mode=="multiply":out=d*(1-a+a*s/255)
    elif mode=="difference":out=d*(1-a)+np.abs(d-s)*a
    elif mode=="lighten":out=d*(1-a)+np.maximum(d,s)*a
    else:raise ValueError("Unknown blend mode "+mode)
    return _u8(out)

_masks={}
def soft_mask(h,w,kind,feather):
    """Alpha mask 0..1. 'ellipse' falls off radially; 'rect' feathers the edges."""
    key=(h,w,kind,round(feather,4))
    if key in _masks:return _masks[key]
    if kind=="ellipse":
        y=(np.arange(h)[:,None]+.5)/h*2-1;x=(np.arange(w)[None,:]+.5)/w*2-1
        r=np.sqrt(x*x+y*y);edge=max(1e-3,feather);m=np.clip((1-r)/edge,0,1)
    else:
        y=np.minimum(np.arange(h)+.5,h-np.arange(h)-.5)/max(1,h/2);x=np.minimum(np.arange(w)+.5,w-np.arange(w)-.5)/max(1,w/2)
        edge=max(1e-3,feather);m=np.clip(np.minimum(y[:,None],x[None,:])/edge,0,1)
    m=m*m*(3-2*m);m=m.astype(np.float32);_masks[key]=m;return m

def static_bright_mask(frames,above,grow=0,within=None):
    """Pixels that are bright in EVERY sampled frame: burned-in captions, watermarks, logos. Moving content
    is not bright everywhere, so it survives. `grow` dilates the mask by that many pixels (anti-aliased
    text edges); `within` ({x,y,width,height}) limits it so static bright parts of the work itself are kept."""
    keep=None
    for f in frames:
        m=f.min(2)>=above*255
        keep=m if keep is None else keep&m
    if within:
        x,y,w,h=[int(within[k]) for k in ("x","y","width","height")];box=np.zeros_like(keep);box[max(0,y):y+h,max(0,x):x+w]=True;keep&=box
    if grow>0 and keep.any():
        size=int(grow)*2+1;keep=np.array(Image.fromarray((keep*255).astype(np.uint8)).filter(ImageFilter.MaxFilter(size)))>127
    return keep

def erase_regions(frame,rects=(),masks=()):
    """Paint rects and masks black in a copy of the frame. On a black stage with screen/lighten/add blends
    black is transparent, so an erased caption simply is not there."""
    out=frame.copy()
    for r in rects:
        x,y,w,h=[int(r[k]) for k in ("x","y","width","height")];out[max(0,y):max(0,y+h),max(0,x):max(0,x+w)]=0
    for m in masks:out[m]=0
    return out

def bloom(frame,radius,gain,threshold=.35):
    """Additive halo from the bright parts of the frame (her radial bloom clusters)."""
    h,w=frame.shape[:2];small=Image.fromarray(frame).resize((max(2,w//4),max(2,h//4)),Image.Resampling.BILINEAR)
    s=_f(np.array(small))/255;lum=s.max(2,keepdims=True);gate=np.clip((lum-threshold)/max(1e-3,1-threshold),0,1)
    glow=Image.fromarray(_u8(s*gate*255)).filter(ImageFilter.GaussianBlur(max(.5,radius/4)))
    glow=np.array(glow.resize((w,h),Image.Resampling.BILINEAR))
    return _u8(_f(frame)+_f(glow)*gain)

def chroma(frame,pixels,radial=True):
    """Red/blue split. Radial scales the channels about the centre (lens-like fringe)."""
    if pixels<=0:return frame
    h,w=frame.shape[:2];out=frame.copy()
    if radial:
        for ch,k in ((0,1+pixels/w),(2,1-pixels/w)):
            im=Image.fromarray(frame[...,ch]);cx,cy=w/2,h/2
            out[...,ch]=np.array(im.transform((w,h),Image.Transform.AFFINE,(1/k,0,cx-cx/k,0,1/k,cy-cy/k),Image.Resampling.BILINEAR))
    else:
        s=int(round(pixels));out[...,0]=np.roll(frame[...,0],s,axis=1);out[...,2]=np.roll(frame[...,2],-s,axis=1)
    return out

def zoom_about_center(frame,k):
    if abs(k-1)<1e-4:return frame
    h,w=frame.shape[:2];cx,cy=w/2,h/2
    return np.array(Image.fromarray(frame).transform((w,h),Image.Transform.AFFINE,(1/k,0,cx-cx/k,0,1/k,cy-cy/k),Image.Resampling.BILINEAR))

def ease(p):p=min(1.,max(0.,p));return p*p*(3-2*p)

_noise={}
def block_noise(h,w,bs,seed):
    key=(h,w,bs,seed)
    if key not in _noise:
        rng=np.random.default_rng(seed);_noise[key]=rng.random((-(-h//bs),-(-w//bs))).astype(np.float32)
    return _noise[key]

def mosaic_mix(a,b,p,max_block,seed=7):
    """Stepped pixel-block resolve: blocks shrink from max_block to 1 while a hands over to b per block."""
    p=min(1.,max(0.,p))
    if p<=0:return a
    if p>=1:return b
    h,w=a.shape[:2];size=max(1,int(round(max_block*(1-p)**1.6)))
    # Quantise to a ladder so blocks step, not slide.
    size=1<<int(np.floor(np.log2(size)))
    def pool(f):
        if size==1:return f
        ph=-(-h//size)*size;pw=-(-w//size)*size
        pad=np.pad(f,((0,ph-h),(0,pw-w),(0,0)),mode="edge");m=_f(pad).reshape(ph//size,size,pw//size,size,3).mean((1,3))
        return _u8(np.repeat(np.repeat(m,size,0),size,1)[:h,:w])
    pa,pb=pool(a),pool(b);noise=block_noise(h,w,size,seed+size)
    mask=np.repeat(np.repeat(noise<ease(p),size,0),size,1)[:h,:w]
    return np.where(mask[...,None],pb,pa)

def displace_mix(a,b,p,strength,seed=7):
    """Chromatic displacement handover: channels pull apart radially and through a slow ripple, then settle on b."""
    p=min(1.,max(0.,p))
    if p<=0:return a
    if p>=1:return b
    h,w=a.shape[:2];peak=np.sin(np.pi*p)*strength
    ys=np.arange(h)[:,None];ripple=np.sin(ys/h*np.pi*5+p*9)*peak*.5
    def warp(f,sign):
        out=np.empty_like(f);xs=np.arange(w)[None,:]
        for ch,k in ((0,1.),(1,0.),(2,-1.)):
            sh=(ripple*(1+.4*k)+k*sign*peak).astype(np.float32);idx=np.clip((xs+sh).round().astype(int),0,w-1)
            out[...,ch]=np.take_along_axis(f[...,ch],idx,axis=1)
        return out
    t=ease(p);wa=warp(a,1);wb=warp(b,-1)
    return _u8(_f(wa)*(1-t)+_f(wb)*t)

def block_motion(prev,cur,bs=16,search=3,scale=4):
    """Per-block integer motion (dx,dy) in pixels from prev to cur, via SAD on a downsampled luma."""
    h,w=cur.shape[:2]
    def luma(f):
        g=_f(f).mean(2);g=g[:h//scale*scale,:w//scale*scale].reshape(h//scale,scale,w//scale,scale).mean((1,3));return g
    gp,gc=luma(prev),luma(cur);bh=bs//scale;gh,gw=gc.shape;by=gh//bh;bx=gw//bh
    best=np.full((by,bx),np.inf,np.float32);mv=np.zeros((by,bx,2),np.int32)
    gc_blocks=gc[:by*bh,:bx*bh].reshape(by,bh,bx,bh)
    for dy in range(-search,search+1):
        for dx in range(-search,search+1):
            shifted=np.roll(np.roll(gp,dy,axis=0),dx,axis=1)[:by*bh,:bx*bh].reshape(by,bh,bx,bh)
            sad=np.abs(shifted-gc_blocks).sum((1,3))+.5*(abs(dx)+abs(dy))
            better=sad<best;best=np.where(better,sad,best);mv[better]=(dx*scale,dy*scale)
    return mv

def datamosh_step(mosh,prev_in,cur,p,bs=16,strength=1.,seed=7):
    """One P-frame-without-I-frame step: the previous output is pushed along the incoming clip's motion,
    the incoming clip's change bleeds in as residual, and blocks refresh to the real frame as p grows."""
    h,w=cur.shape[:2]
    if p>=1:return cur
    mv=block_motion(prev_in,cur,bs) if prev_in is not None else np.zeros((h//bs,w//bs,2),np.int32)
    by,bx=mv.shape[:2]
    pix=np.repeat(np.repeat(mv,bs,0),bs,1)
    yy=np.clip(np.arange(by*bs)[:,None]-pix[...,1],0,h-1);xx=np.clip(np.arange(bx*bs)[None,:]-pix[...,0],0,w-1)
    moved=mosh.copy();moved[:by*bs,:bx*bs]=mosh[yy,xx]
    resid=(_f(cur)-_f(prev_in if prev_in is not None else cur))*(.9*strength)
    out=_u8(_f(moved)+resid)
    refresh=block_noise(h,w,bs,seed)<(ease(p)**2.2)
    mask=np.repeat(np.repeat(refresh,bs,0),bs,1)[:h,:w]
    return np.where(mask[...,None],cur,out)
