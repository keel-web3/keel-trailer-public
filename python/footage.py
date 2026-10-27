"""Handheld-device footage cleanup: find the lit screen in every frame, steady the shot on it, keep the device and
the hand sharp, push the room behind them back (blurred, dimmed, tinted), lift the screen, and report every
moment the screen changes (button presses) as cues. Phone footage of a real device, not pixel art: the output is
a lossless master the generic compositor can cut as a normal video source."""
import json,math,subprocess,sys
from pathlib import Path
import numpy as np
try:
    import cv2
except ImportError as e:  # opencv-python-headless is in requirements.txt
    raise RuntimeError("trailer-footage needs opencv-python-headless in the trailer Python runtime") from e
from common import probe,run

UNIT=np.float32([[0,0],[1,0],[1,1],[0,1]])
DEFAULTS={
    "device":[-0.30,-0.31,1.30,2.80],        # the body around the screen, in screen widths/heights: left, top, right, bottom
    "stabilize":{"seconds":0.9,"derotate":0.45,"zoom":1.07,"center":True},
    "background":{"blur":26,"dim":0.55,"desaturate":0.3,"tint":"#3a1a5e","tintAmount":0.3,"vignette":0.45},
    "screen":{"contrast":1.12,"saturation":1.22,"sharpen":0.6,"glow":0.22},
    "grade":{"contrast":1.08,"saturation":1.06,"lift":-6},
    "skin":True,
    "cues":{"minGap":0.18,"change":40.0,"flash":0.30,"skipStart":0.5},
}
cv2.setNumThreads(4)

def merged(user):
    out={}
    for k,v in DEFAULTS.items():
        u=(user or {}).get(k)
        out[k]={**v,**u} if isinstance(v,dict) and isinstance(u,dict) else (v if u is None else u)
    return out

def frames(path,w,h):
    proc=subprocess.Popen(["ffmpeg","-v","error","-i",str(path),"-map","0:v:0","-f","rawvideo","-pix_fmt","bgr24","-"],stdout=subprocess.PIPE)
    size=w*h*3
    try:
        while True:
            data=proc.stdout.read(size)
            if len(data)<size:break
            yield np.frombuffer(data,np.uint8).reshape(h,w,3)
    finally:
        proc.stdout.close();proc.wait()

def geometry(path):
    """Display size after the phone's rotation flag, and the frame rate."""
    info=probe(path);s=next(x for x in info["streams"] if x["codec_type"]=="video")
    w,h=s["width"],s["height"];rot=0
    for side in s.get("side_data_list",[]):rot=int(side.get("rotation",rot) or 0)
    rot=int(s.get("tags",{}).get("rotate",rot))
    if abs(rot)%180==90:w,h=h,w
    a,b=s["avg_frame_rate"].split("/");return w,h,float(a)/float(b),float(info["format"]["duration"])

def order(q):
    c=q.mean(0);q=q[np.argsort(np.arctan2(q[:,1]-c[1],q[:,0]-c[0]))]
    return np.roll(q,-int(np.argmin(q.sum(1))),0)

def screen_quad(small,scale,prev_area):
    """The lit screen: the largest bright, square-ish region that is not the room (it never touches the frame edge)."""
    g=cv2.GaussianBlur(cv2.cvtColor(small,cv2.COLOR_BGR2GRAY),(0,0),1.5)
    _,m=cv2.threshold(g,0,255,cv2.THRESH_BINARY+cv2.THRESH_OTSU)
    m=cv2.morphologyEx(m,cv2.MORPH_CLOSE,np.ones((21,21),np.uint8))
    n,lab,st,_=cv2.connectedComponentsWithStats(m);H,W=m.shape;best=None;bestScore=0
    for i in range(1,n):
        x,y,w,h,a=st[i]
        if x<=1 or y<=1 or x+w>=W-1 or y+h>=H-1 or a<W*H*0.03:continue
        fill=a/(w*h);aspect=min(w,h)/max(w,h)
        if fill<0.45 or aspect<0.55:continue
        score=a*fill*(1 if prev_area is None else math.exp(-abs(math.log(a/prev_area))*3))
        if score>bestScore:best,bestScore=i,score
    if best is None:return None,None
    cs,_=cv2.findContours((lab==best).astype(np.uint8),cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_NONE)
    hull=cv2.convexHull(max(cs,key=cv2.contourArea))
    for eps in np.linspace(0.01,0.12,45):
        ap=cv2.approxPolyDP(hull,eps*cv2.arcLength(hull,True),True)
        if len(ap)==4:return order(ap.reshape(4,2).astype(np.float32))*scale,float(st[best,4])
    return None,None

def smooth_track(q,valid,sigma):
    """Fill missing quads, then a Gaussian low-pass of every corner coordinate (edges held)."""
    n=len(q);t=np.arange(n);out=q.copy()
    idx=np.flatnonzero(valid)
    if not len(idx):raise ValueError("The screen was not found in any frame")
    for c in range(8):
        flat=q.reshape(n,8)[:,c];out.reshape(n,8)[:,c]=np.interp(t,idx,flat[idx])
    if sigma<=0:return out,out
    r=int(sigma*3)+1;k=np.exp(-0.5*(np.arange(-r,r+1)/sigma)**2);k/=k.sum()
    flat=out.reshape(n,8);pad=np.concatenate([np.repeat(flat[:1],r,0),flat,np.repeat(flat[-1:],r,0)])
    sm=np.stack([np.convolve(pad[:,c],k,"valid") for c in range(8)],1)
    return out,sm.reshape(n,4,2).astype(np.float32)

def angle_of(q):d=q[1]-q[0];return math.atan2(d[1],d[0])

def steady_transform(raw,smooth,W,H,cfg):
    """A similarity that moves the raw screen onto its steadied, partly de-rotated, re-centred place, zoomed past the borders."""
    c=smooth.mean(0);ang=angle_of(smooth)*cfg["derotate"]
    R=cv2.getRotationMatrix2D((float(c[0]),float(c[1])),math.degrees(ang),1.0)
    target=cv2.transform(smooth[None],R)[0]
    if cfg.get("center"):target+=np.float32([W/2-c[0],0])*0.6
    z=cfg["zoom"];target=(target-np.float32([W/2,H/2]))*z+np.float32([W/2,H/2])
    M,_=cv2.estimateAffinePartial2D(raw,target,method=cv2.LMEDS)
    return M,target

def hex_bgr(v):v=v.lstrip("#");return np.float32([int(v[4:6],16),int(v[2:4],16),int(v[0:2],16)])

def device_polygon(quad,box):
    l,t,r,b=box
    Hm=cv2.getPerspectiveTransform(UNIT,quad.astype(np.float32))
    return cv2.perspectiveTransform(np.float32([[l,t],[r,t],[r,b],[l,b]])[None],Hm)[0]

def matte(frame,quad,cfg,s=2):
    """Device and hand, worked at 1/s scale: the body outline from the screen, kept to dark pixels at its edge
    (the body is dark against the lit room), plus large skin-coloured regions (the hand). Feathered, full size."""
    H,W=frame.shape[:2];small=cv2.resize(frame,(W//s,H//s),interpolation=cv2.INTER_AREA);h,w=small.shape[:2]
    poly=device_polygon(quad,cfg["device"])
    m=np.zeros((h,w),np.uint8);cv2.fillPoly(m,[np.round(poly/s).astype(np.int32)],255,cv2.LINE_AA)
    k=lambda n:cv2.getStructuringElement(cv2.MORPH_RECT,(n,n))
    band=cv2.dilate(m,k(31))-cv2.erode(m,k(31))
    lum=cv2.GaussianBlur(cv2.cvtColor(small,cv2.COLOR_BGR2GRAY),(0,0),1)
    dark=(lum<95).astype(np.uint8)*255
    grown=cv2.dilate(m,k(15))
    m=np.where(band>0,np.minimum(grown,dark),m).astype(np.uint8)
    if cfg["skin"]:
        hsv=cv2.cvtColor(small,cv2.COLOR_BGR2HSV);hh,ss,vv=hsv[...,0],hsv[...,1],hsv[...,2]
        skin=(((hh<=22)|(hh>=165))&(ss>=35)&(ss<=200)&(vv>=70)).astype(np.uint8)*255
        skin=cv2.morphologyEx(skin,cv2.MORPH_OPEN,k(4))
        n,lab,st,_=cv2.connectedComponentsWithStats(skin)
        big=np.flatnonzero(st[:,4]>h*w*0.004);big=big[big>0]
        if len(big):m=np.maximum(m,cv2.morphologyEx(np.isin(lab,big).astype(np.uint8)*255,cv2.MORPH_CLOSE,k(13)))
    m=cv2.morphologyEx(m,cv2.MORPH_CLOSE,k(8))
    a=cv2.resize(cv2.GaussianBlur(m,(0,0),1.6),(W,H),interpolation=cv2.INTER_LINEAR).astype(np.float32)/255.0
    return a,poly

def background(frame,alpha,cfg,vignette):
    """The room, pushed back: blurred without the device's dark bleeding in, dimmed, desaturated, tinted, vignetted."""
    H,W=frame.shape[:2];s=4;small=cv2.resize(frame,(W//s,H//s),interpolation=cv2.INTER_AREA).astype(np.float32)
    keep=cv2.resize(1-alpha,(W//s,H//s),interpolation=cv2.INTER_AREA)[...,None]
    sig=cfg["blur"]/s
    num=cv2.GaussianBlur(small*keep,(0,0),sig);den=cv2.GaussianBlur(keep,(0,0),sig)[...,None]
    wide=cv2.GaussianBlur(small,(0,0),sig*2.5)
    b=np.where(den>0.04,num/np.maximum(den,1e-4),wide)
    b=cv2.resize(b,(W,H),interpolation=cv2.INTER_CUBIC)
    d=cfg["desaturate"];D=np.eye(3,dtype=np.float32)*(1-d)+d/3                       # toward grey
    t=cfg["tintAmount"];T=np.diag(1-t+hex_bgr(cfg["tint"])/255*t*2.2).astype(np.float32)  # toward the tint
    b=cv2.transform(b,(T@D)*cfg["dim"])
    return b*vignette[...,None]

def screen_pop(img,quad,cfg):
    """The screen, lifted: sharper, a touch more contrast and colour, and its light spilling onto the bezel."""
    H,W=img.shape[:2];qi=np.round(quad).astype(np.int32);x,y,w,h=cv2.boundingRect(qi);pad=90
    x0,y0=max(0,x-pad),max(0,y-pad);x1,y1=min(W,x+w+pad),min(H,y+h+pad)
    roi=np.ascontiguousarray(img[y0:y1,x0:x1],np.float32)
    m=np.zeros(roi.shape[:2],np.uint8);cv2.fillPoly(m,[qi-np.int32([x0,y0])],255,cv2.LINE_AA)
    mk=(cv2.GaussianBlur(m,(0,0),1.2).astype(np.float32)/255)[...,None]
    blur=cv2.GaussianBlur(roi,(0,0),2.0)
    f=roi*(1+cfg["sharpen"])-blur*cfg["sharpen"]
    inside=mk[...,0]>0.5;mean=roi[inside].mean(0) if inside.any() else roi.reshape(-1,3).mean(0)
    f=(f-mean)*cfg["contrast"]+mean
    g=f.mean(2,keepdims=True);f=g+(f-g)*cfg["saturation"]
    out=roi*(1-mk)+np.clip(f,0,255)*mk
    if cfg["glow"]:
        lit=cv2.resize(np.clip(out*mk-90,0,None),None,fx=0.25,fy=0.25,interpolation=cv2.INTER_AREA)
        glow=cv2.resize(cv2.GaussianBlur(lit,(0,0),4.5)+cv2.GaussianBlur(lit,(0,0),11)*0.6,(out.shape[1],out.shape[0]),interpolation=cv2.INTER_LINEAR)
        out=255-(255-out)*(1-np.clip(glow*cfg["glow"]/255,0,1))   # screen-blend: light only adds
    img[y0:y1,x0:x1]=out;return img

def grade(img,cfg):
    """Contrast about mid-grey, a lift, saturation: one affine colour transform."""
    S=cfg["saturation"];c=cfg["contrast"];M=(np.eye(3)*S+(1-S)/3)*c
    return cv2.transform(img,np.hstack([M,np.full((3,1),128*(1-c)+cfg["lift"])]).astype(np.float32))

def rectified(frame,quad,size=(80,72)):
    M=cv2.getPerspectiveTransform(quad.astype(np.float32),np.float32([[0,0],[size[0],0],[size[0],size[1]],[0,size[1]]]))
    return cv2.cvtColor(cv2.warpPerspective(frame,M,size,flags=cv2.INTER_AREA),cv2.COLOR_BGR2GRAY).astype(np.float32)

def detect_cues(diff,bright,fps,cfg):
    """Screen changes: a frame whose rectified screen differs sharply from the last (a new scene), or a white flash.
    One cue per burst, at its first changed frame; bursts closer than minGap are one cue."""
    n=len(diff);base=float(np.median(bright));flash=bright>base+(255-base)*cfg["flash"]
    hot=diff>cfg["change"];hot[:int(cfg.get("skipStart",0)*fps)+1]=False   # a flash alone (a white scene) is not a press
    cues=[];i=0
    while i<n:
        if not hot[i]:i+=1;continue
        j=i
        while j+1<n and hot[j+1]:j+=1
        cue={"frame":i,"seconds":round(i/fps,4),"peakFrame":int(i+np.argmax(diff[i:j+1])),"strength":round(float(diff[i:j+1].max()),2),"flash":bool(flash[i:j+1].any())}
        if cues and cue["seconds"]-cues[-1]["seconds"]<cfg["minGap"]:   # one press: keep its first frame, its strongest change
            last=cues[-1]
            if cue["strength"]>last["strength"]:last.update(strength=cue["strength"],peakFrame=cue["peakFrame"])
            last["flash"]=last["flash"] or cue["flash"]
        else:cues.append(cue)
        i=j+1
    return cues

def cues_from_signal(path,options=None):
    """Re-detect cues from a saved cues.json signal with other thresholds, without re-reading the video."""
    d=json.loads(Path(path).read_text());s=d["signal"]
    return detect_cues(np.float32([x["diff"] for x in s]),np.float32([x["bright"] for x in s]),d["fps"],{**DEFAULTS["cues"],**(options or {})})

def footage(x):
    src=Path(x["mediaPath"]);out=Path(x["outDir"]);out.mkdir(parents=True,exist_ok=True);cfg=merged(x.get("options"))
    W,H,fps,duration=geometry(src);s=2
    # Pass 1: the screen in every frame, and what is on it (a small rectified copy, compared frame to frame).
    quads=[];valid=[];prev=None;diff=[];bright=[];prevt=None;last=None
    for f in frames(src,W,H):
        small=cv2.resize(f,(W//s,H//s),interpolation=cv2.INTER_AREA);q,a=screen_quad(small,s,prev)
        if q is not None:prev=a if prev is None else prev*0.9+a*0.1;last=q
        quads.append(q if q is not None else np.zeros((4,2),np.float32));valid.append(q is not None)
        if last is None:diff.append(0.0);bright.append(0.0);continue
        r=rectified(small,last/s);bright.append(float(r.mean()));diff.append(float(np.abs(r-prevt).mean()) if prevt is not None else 0.0);prevt=r
    n=len(quads);valid=np.array(valid);q=np.array(quads,np.float32);diff=np.array(diff,np.float32);bright=np.array(bright,np.float32)
    raw,sm=smooth_track(q,valid,cfg["stabilize"]["seconds"]*fps)
    cues=detect_cues(diff,bright,fps,cfg["cues"])
    # Pass 2: steady, matte, background, screen, grade.
    yy,xx=np.mgrid[0:H,0:W].astype(np.float32);rr=np.hypot((xx-W/2)/(W/2),(yy-H/2)/(H/2))
    vignette=np.clip(1-cfg["background"]["vignette"]*np.clip(rr-0.35,0,None)**1.6,0.15,1).astype(np.float32);del yy,xx,rr
    master=out/"footage.mkv"
    enc=subprocess.Popen(["ffmpeg","-v","error","-y","-f","rawvideo","-pix_fmt","bgr24","-s",f"{W}x{H}","-r",f"{fps:.6f}","-i","-",
                          "-c:v","ffv1","-level","3","-threads","4","-slices","8",str(master)],stdin=subprocess.PIPE)
    track=[];sheet=[]
    probes={int(n*k/6) for k in range(1,6)}
    try:
        for i,f in enumerate(frames(src,W,H)):
            if i>=n:break
            M,target=steady_transform(raw[i],sm[i],W,H,cfg["stabilize"])
            st=cv2.warpAffine(f,M,(W,H),flags=cv2.INTER_CUBIC,borderMode=cv2.BORDER_REFLECT)
            quad=cv2.transform(raw[i][None],M)[0]
            alpha,poly=matte(st,quad,cfg)
            fg=st.astype(np.float32);bg=background(st,alpha,cfg["background"],vignette)
            img=fg*alpha[...,None]+bg*(1-alpha[...,None])
            img=screen_pop(img,quad,cfg["screen"]);img=grade(img,cfg["grade"])
            o=np.clip(img,0,255).astype(np.uint8);enc.stdin.write(o.tobytes())
            track.append({"frame":i,"found":bool(valid[i]),"screen":np.round(quad,2).tolist(),"device":np.round(poly,1).tolist()})
            if i in probes:sheet.append(np.hstack([cv2.resize(f,(270,480)),cv2.resize(o,(270,480))]))
            if i%150==0:print(f"footage {i}/{n}",file=sys.stderr,flush=True)
        enc.stdin.close()
        if enc.wait():raise RuntimeError("ffmpeg lossless encoder failed")
    finally:
        if enc.poll() is None:enc.kill();enc.wait()
    if sheet:cv2.imwrite(str(out/"before-after.png"),np.vstack([np.hstack(sheet[:3]),np.hstack(sheet[3:6] if len(sheet)>=6 else sheet[:3])]) if len(sheet)>=6 else np.hstack(sheet))
    (out/"track.json").write_text(json.dumps({"fps":fps,"width":W,"height":H,"frames":track},separators=(",",":")))
    signal=[{"frame":i,"diff":round(float(diff[i]),3),"bright":round(float(bright[i]),2)} for i in range(n)]
    (out/"cues.json").write_text(json.dumps({"fps":fps,"cues":cues,"signal":signal},indent=1))
    found=int(valid.sum())
    return {"master":str(master),"fps":fps,"width":W,"height":H,"frames":n,"duration":duration,"screenFound":found,
            "screenMissing":n-found,"cues":cues,"cuesPath":str(out/"cues.json"),"trackPath":str(out/"track.json"),
            "sheet":str(out/"before-after.png"),"options":cfg}
