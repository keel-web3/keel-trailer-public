"""KEEL core ordered dither (core/src/dither.ts), integer-pixel transitions."""
import numpy as np
BAYER4=np.array([[0,8,2,10],[12,4,14,6],[3,11,1,9],[15,7,13,5]])
BAYER2=np.array([[0,2],[3,1]])
# Same q*4+b expansion as the KEEL core engine, independent of its JS runtime.
BAYER8=np.array([[BAYER4[y&3,x&3]*4+BAYER2[y>>2,x>>2] for x in range(8)] for y in range(8)])
def threshold(h,w,scale):
    return (BAYER8[(np.arange(h)//scale%8)[:,None],(np.arange(w)//scale%8)[None,:]]+.5)/64
def transition(a,b,p,kind,k,rng):
    if kind=="dither":return np.where((threshold(*b.shape[:2],k)<p)[...,None],b,a)
    if kind=="flash":return (b*(p)+255*(1-p)).astype(np.uint8)
    if kind in ("punch","chroma"):
        # punch: the incoming frame kicks in 9% larger and settles, lit up; chroma adds a red/blue split that closes.
        e=(1-p)**2;h,w=b.shape[:2];z=1+0.09*e
        ys=np.clip(((np.arange(h)-h/2)/z+h/2).astype(int),0,h-1);xs=np.clip(((np.arange(w)-w/2)/z+w/2).astype(int),0,w-1)
        out=b[ys[:,None],xs[None,:]].astype(np.float32)*(1+0.35*e)
        if kind=="chroma":
            d=max(1,int(round(k*14*e)))
            out[:,:,0]=np.roll(out[:,:,0],-d,axis=1);out[:,:,2]=np.roll(out[:,:,2],d,axis=1)
        return np.clip(out,0,255).astype(np.uint8)
    if kind in ("glitch","scanline-tear"):
        out=b.copy();h=b.shape[0]
        for y in range(0,h,k):
            if kind=="glitch":dx=int(rng.integers(-12,13)*(1-p))*k
            else:dx=int(round(10*(1-p)*np.sin(y/13+p*40)))*k
            out[y:y+k]=np.roll(b[y:y+k],dx,axis=1)
        if kind=="glitch":
            out[:,:,0]=np.roll(out[:,:,0],k*int(3*(1-p)),axis=1)
            out[:,:,2]=np.roll(out[:,:,2],-k*int(3*(1-p)),axis=1)
        return out
    return b

def zoom(frame,source,target,p):
    p=p*p*(3-2*p);sx=source["x"]+source["width"]/2;sy=source["y"]+source["height"]/2
    tx=target["x"]+target["width"]/2;ty=target["y"]+target["height"]/2
    scx=1+(target["width"]/source["width"]-1)*p;scy=1+(target["height"]/source["height"]-1)*p
    cx=sx+(tx-sx)*p;cy=sy+(ty-sy)*p;h,w=frame.shape[:2]
    ys=np.clip(np.floor((np.arange(h)-cy)/scy+sy).astype(int),0,h-1)
    xs=np.clip(np.floor((np.arange(w)-cx)/scx+sx).astype(int),0,w-1)
    return frame[ys[:,None],xs[None,:]]
