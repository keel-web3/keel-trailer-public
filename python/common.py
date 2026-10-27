"""Deterministic timing, decoding, onset analysis and audio measurements."""
import hashlib, json, math, subprocess, wave
from pathlib import Path
import numpy as np
SR = 48000

def run(args, **kwargs):
    try:return subprocess.run(args, check=True, capture_output=True, **kwargs)
    except subprocess.CalledProcessError as e:
        detail=e.stderr.decode(errors="replace") if isinstance(e.stderr,bytes) else str(e.stderr)
        raise RuntimeError(f"{args[0]} failed ({e.returncode}): {detail[-4000:]}") from e

def sha(path):
    h=hashlib.sha256()
    with open(path,"rb") as f:
        for b in iter(lambda:f.read(1024*1024),b""):h.update(b)
    return h.hexdigest()

def load_audio(path):
    raw=run(["ffmpeg","-v","error","-threads","1","-i",str(path),"-f","s16le","-ac","2","-ar",str(SR),"-"]).stdout
    return np.frombuffer(raw,np.int16).reshape(-1,2).astype(np.float32)/32768

def save_audio(path,snd):
    with wave.open(str(path),"wb") as w:
        w.setnchannels(2);w.setsampwidth(2);w.setframerate(SR)
        w.writeframes((np.clip(snd,-1,1)*32767).astype(np.int16).tobytes())

def beat_time(tempo,b):
    if "beats" in tempo:
        a=tempo["beats"];i=int(math.floor(b));p=b-i
        if i>=len(a)-1:return a[-1]+(b-len(a)+1)*(a[-1]-a[-2])
        return a[i]+p*(a[i+1]-a[i])
    return tempo.get("firstDownbeat",0)+b*tempo.get("beatSeconds",60/tempo.get("bpm",120))

def edit_time(tempo,b):return beat_time(tempo,b)-beat_time(tempo,0)

def local_beat(tempo,start,seconds):
    # Piecewise tempo maps may be nonuniform: invert the time grid, not bpm.
    t=beat_time(tempo,start)+seconds
    if "beats" in tempo:
        a=tempo["beats"];i=max(0,int(np.searchsorted(a,t,side="right"))-1)
        if i>=len(a)-1:return len(a)-1+(t-a[-1])/(a[-1]-a[-2])-start
        return i+(t-a[i])/(a[i+1]-a[i])-start
    return seconds/tempo.get("beatSeconds",60/tempo.get("bpm",120))

def source_frame(shot,beat,seconds,fps):
    if "holdFrame" in shot:return int(shot["holdFrame"])
    if "ramp" in shot:
        return int(math.floor(float(np.interp(beat,[p["beat"] for p in shot["ramp"]],[p["frame"] for p in shot["ramp"]]))+.5))
    t=shot.get("in",0)+seconds*shot.get("speed",1)
    if "out" in shot:t=min(t,shot["out"]-1/fps)
    return max(0,int(math.floor(t*fps+1e-9)))

def analyze_beats(audio,bpm=None,beatSeconds=None,firstDownbeat=None,beats=None):
    if beats and (len(beats)<2 or any(b<=a for a,b in zip(beats,beats[1:]))):raise ValueError("Declared beats must strictly increase")
    if bpm and beatSeconds and abs(60/bpm-beatSeconds)>1e-9:raise ValueError("Declared bpm and beatSeconds disagree")
    if beats and not (bpm or beatSeconds):beatSeconds=float(np.median(np.diff(beats)))
    if beats and firstDownbeat is None:firstDownbeat=beats[0]
    x=load_audio(audio);mono=x.mean(1);hop=480;n=2048
    if len(mono)<n or float(np.max(np.abs(mono)))<1e-7:
        if not (bpm or beatSeconds or beats):raise ValueError("No audible attacks; declare beats or tempo.")
        o=np.zeros(max(1,len(mono)//hop));dt=hop/SR;period=beatSeconds or 60/(bpm or 120);phase=firstDownbeat or 0;confidence=0
    else:
        # Chunk STFT blocks: no unbounded sliding-window allocation for long beds.
        spectrum=[]
        win=np.hanning(n).astype(np.float32)
        for lo in range(0,len(mono)-n+1,hop*2048):
            block=mono[lo:min(len(mono),lo+hop*2048+n-hop)]
            windows=np.lib.stride_tricks.sliding_window_view(block,n)[::hop]*win
            spectrum.append(np.log1p(np.abs(np.fft.rfft(windows,axis=1))[:,:int(4000/SR*n)]*30))
        spec=np.concatenate(spectrum)
        o=np.r_[0,np.maximum(np.diff(spec,axis=0),0).sum(1)];o/=o.max()+1e-9;dt=hop/SR
        # Autocorrelation of positive spectral flux; bounded 75..150 BPM avoids octave folding.
        centered=o-o.mean();best=None
        for lag in range(40,81):
            if lag>=len(o):continue
            score=float(np.dot(centered[:-lag],centered[lag:])/(np.linalg.norm(centered[:-lag])*np.linalg.norm(centered[lag:])+1e-9))
            if best is None or score>best[0]:best=(score,lag)
        if not best:
            if not (bpm or beatSeconds or beats):raise ValueError("Audio too short to infer tempo; declare it.")
            confidence=0;period=beatSeconds or 60/bpm;phase=firstDownbeat or 0
        else:
            confidence,lag=best;period=lag*dt
            bins=np.arange(len(o))%lag;fold=np.bincount(bins,o,minlength=lag)
            phase=float(np.argmax(fold))*dt
        # Flux timestamps describe window STARTS; attacks are localized below in the PCM.
        period=beatSeconds or (60/bpm if bpm else period);phase=phase if firstDownbeat is None else firstDownbeat
    thr=np.percentile(o,80)
    onsets=[i*dt for i in range(1,len(o)-1) if o[i]>thr and o[i]>=o[i-1] and o[i]>=o[i+1]]
    envelope=np.abs(mono);env=envelope[:len(envelope)//48*48].reshape(-1,48).max(1)
    jumps=np.zeros(len(env))
    for i in range(30,len(env)):jumps[i]=env[i]/(env[i-30:i-5].mean()+.002)
    attacks=[i/1000 for i in range(30,len(env)-1) if jumps[i]>=1.5 and jumps[i]>=jumps[i-1] and jumps[i]>=jumps[i+1] and env[i]>.002]
    declared=bool(bpm or beatSeconds or beats)
    if not declared and attacks:
        # Align phase to a nearby PCM attack, rather than the STFT window edge.
        nearest=min(attacks,key=lambda v:abs(v-phase))
        if abs(nearest-phase)<.08:phase=nearest
    grid={"bpm":60/period,"beatSeconds":period,"firstDownbeat":phase,"mode":"declared" if declared else "detected","onsets":onsets}
    if beats:grid["beats"]=beats
    return {"tempo":grid,"onsets":onsets,"attacks":attacks,"confidence":confidence,"audioSha256":sha(audio),"duration":len(x)/SR,
            "limitations":["Detected tempo may choose a half/double-time pulse; inspect and declare the intended grid."] if not declared else []}

def attack_report(audio,cuts,offset=0,tolerance=15):
    x=load_audio(audio);env=np.abs(x.mean(1))[int(offset*SR):]
    env=env[:len(env)//48*48].reshape(-1,48).max(1);rows=[]
    for cut in cuts:
        c=int(round(cut*1000));lo=max(30,c-80);hi=min(len(env)-1,c+80)
        if hi<=lo:rows.append({"cut":cut,"attackMs":None,"jump":0,"aligned":False});continue
        ratios=[env[i]/(env[i-30:i-5].mean()+.002) for i in range(lo,hi)]
        k=int(np.argmax(ratios));delta=lo+k-c;jump=float(ratios[k])
        rows.append({"cut":cut,"attackMs":delta,"jump":round(jump,3),"aligned":abs(delta)<=tolerance and jump>=1.5})
    return {"cuts":rows,"aligned":sum(x["aligned"] for x in rows),"total":len(rows),"passed":all(x["aligned"] for x in rows),
            "method":"PCM 1 ms peak-envelope jump against preceding 30..5 ms; attacks must exceed 1.5x"}

def loudness(path):
    data=run(["ffmpeg","-v","info","-threads","1","-i",str(path),"-af","loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json","-f","null","-"]).stderr.decode()
    j=json.loads(data[data.rindex("{"):data.rindex("}")+1])
    def val(k):
        x=float(j[k]);return x if math.isfinite(x) else None
    return {"integratedLUFS":val("input_i"),"truePeakDBTP":val("input_tp"),"rangeLU":val("input_lra")}

def normalize(raw,path,I,TP,prefilter=""):
    pre=prefilter+"," if prefilter else ""
    data=run(["ffmpeg","-v","info","-threads","1","-i",str(raw),"-af",pre+f"loudnorm=I={I}:TP={TP}:LRA=11:print_format=json","-f","null","-"]).stderr.decode()
    j=json.loads(data[data.rindex("{"):data.rindex("}")+1])
    if not math.isfinite(float(j["input_i"])):
        run(["ffmpeg","-v","error","-y","-i",str(raw),str(path)]);return
    ln=f"loudnorm=I={I}:TP={TP}:LRA=11:measured_I={j['input_i']}:measured_TP={j['input_tp']}:measured_LRA={j['input_lra']}:measured_thresh={j['input_thresh']}:offset={j['target_offset']}:linear=true"
    run(["ffmpeg","-v","error","-y","-threads","1","-i",str(raw),"-af",pre+ln+",aresample=48000","-ar","48000",str(path)])

def probe(path):
    return json.loads(run(["ffprobe","-v","error","-show_streams","-show_format","-of","json",str(path)]).stdout)

def audio_mix(t,path,return_samples=False):
    tempo=t["tempo"];duration=edit_time(tempo,t["shots"][-1]["startBeat"]+t["shots"][-1]["beats"])
    n=int((duration+.3)*SR);out=np.zeros((n,2),np.float32);sources={x["id"]:x for x in t["sources"]}
    cache={}
    for layer in t.get("audio",[]):
        sid=layer["source"]
        if sid not in cache:cache[sid]=load_audio(sources[sid]["path"])
        x=cache[sid];start=edit_time(tempo,layer["startBeat"]);i=int(round(start*SR))
        source0=int(layer.get("in",0)*SR);length=n-i
        if "out" in layer:length=min(length,int(layer["out"]*SR)-source0)
        if "beats" in layer:length=min(length,int((edit_time(tempo,layer["startBeat"]+layer["beats"])-start)*SR))
        clip=x[source0:source0+length].copy();tt=np.arange(len(clip))/SR;gain=np.ones(len(clip),np.float64)*layer.get("gain",1)
        fi=layer.get("fadeIn",0);fo=layer.get("fadeOut",0)
        if fi:gain*=np.clip(tt/fi,0,1)
        if fo:gain*=np.clip((layer.get('fadeOutAt',length/SR)-tt)/fo,0,1)
        for duck in layer.get("duck",[]):
            a=edit_time(tempo,duck["startBeat"])-start;b=edit_time(tempo,duck["startBeat"]+duck["beats"])-start
            attack=duck.get("attack",.03);release=duck.get("release",.1)
            strength=np.minimum(np.clip((tt-a)/max(attack,1/SR),0,1),np.clip((b+release-tt)/max(release,1/SR),0,1))
            gain*=1-strength*(1-duck["gain"])
        if i<n and len(clip):out[i:i+len(clip)]+=clip*gain[:,None]
    if return_samples:return out
    save_audio(path,out)
    return path
