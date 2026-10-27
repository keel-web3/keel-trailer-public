"""Isolated PyBoy adapter: frame inputs, symbol reads, optional explicit serial hooks."""
import io,json,re,subprocess,wave
from pathlib import Path
from importlib.metadata import version
import numpy as np
from common import sha,SR
FPS=59.7275
BUTTONS={"a","b","up","down","left","right","start","select"}

def symbols(path):
    if not path:return {}
    out={}
    for line in Path(path).read_text().splitlines():
        m=re.match(r"\s*([0-9a-fA-F]+):([0-9a-fA-F]{4})\s+(\S+)",line)
        if m:out[m[3]]=(int(m[1],16),int(m[2],16));continue
        m=re.match(r"\s*DEF\s+(\S+)\s+0x([0-9a-fA-F]+)",line)
        if m:
            value=int(m[2],16);out[m[1]]=(value>>16,value&65535)
    return out

def capture(config,out):
    if version("pyboy")!="2.7.0":raise ValueError("Game Boy capture requires pinned PyBoy 2.7.0")
    from pyboy import PyBoy
    out=Path(out);out.mkdir(parents=True,exist_ok=True);pair=bool(config.get("guestRom"));hooks=config.get("link")
    if pair and not hooks:raise ValueError("PyBoy 2.7.0 needs ROM-specific serial read hooks for a link pair; supply link.host and link.guest")
    paths=[config["rom"]]+([config["guestRom"]] if pair else [])
    emulators=[PyBoy(str(p),window="null",cgb=config.get("cgb",True),sound_emulated=True,sound_sample_rate=SR,
                     ram_file=io.BytesIO(bytes(131072)),rtc_file=io.BytesIO(),log_level="ERROR") for p in paths]
    for pb in emulators:pb.set_emulation_speed(0)
    pending=[None];exchanges=[0];procs=[];audio=[[] for _ in paths];reads=[];marks=[];names=["host","guest"][:len(paths)]
    def mem(pb,at,bank=None):return (bank if bank is not None else 1,at) if 0xd000<=at<0xe000 else ((bank,at) if bank is not None and at<0x8000 else at)
    if pair:
        host,guest=emulators;h,g=hooks["host"],hooks["guest"]
        def host_read(_):
            if pending[0] is not None or not(guest.memory[0xff02]&0x80):host.register_file.A=0xff;return
            tx=host.memory[mem(host,h["currentByte"])];back=guest.memory[mem(guest,g["currentByte"])]
            pending[0]=tx;host.register_file.A=back;exchanges[0]+=1
        def guest_read(_):
            guest.register_file.A=pending[0] if pending[0] is not None else 0xff;pending[0]=None
        host.hook_register(h["bank"],h["readHook"],host_read,None);guest.hook_register(g["bank"],g["readHook"],guest_read,None)
    def tick():
        emulators[0].tick()
        if pair:
            if pending[0] is not None:emulators[1].memory[0xff0f]|=8
            emulators[1].tick()
    sym=symbols(config.get("symbolsPath"));events={}
    for e in config.get("events",[]):events.setdefault(e["frame"],[]).append(e)
    count=config.get("frames",600);warm=config.get("warmupFrames",0)
    try:
        for _ in range(warm):
            tick()
            for pb in emulators:pb.sound.ndarray
        for name in names:
            procs.append(subprocess.Popen(["ffmpeg","-v","error","-y","-f","rawvideo","-pix_fmt","rgb24","-s","160x144","-r",str(FPS),"-i","-","-c:v","ffv1","-threads","1",
                                           "-fflags","+bitexact","-flags:v","+bitexact",str(out/f'{name}.mkv')],stdin=subprocess.PIPE))
        for f in range(count):
            for e in events.get(f,[]):
                side=names.index(e.get("side","host"));pb=emulators[side];action=e["action"]
                if action=="press":pb.button_press(e["button"])
                elif action=="release":pb.button_release(e["button"])
                elif action=="write":pb.memory[mem(pb,e["address"],e.get("bank"))]=e["value"]
                elif action=="mark":marks.append({"name":e["name"],"frame":f,"side":names[side]})
            tick()
            for i,pb in enumerate(emulators):
                procs[i].stdin.write(np.ascontiguousarray(pb.screen.ndarray[:,:,:3]).tobytes());audio[i].append(pb.sound.ndarray.copy())
            values={}
            for r in config.get("reads",[]):
                if "symbol" in r:
                    if r["symbol"] not in sym:raise ValueError("Unknown ROM symbol "+r["symbol"])
                    bank,at=sym[r["symbol"]]
                    if bank==0 and 0xd000<=at<0xe000:bank=1
                else:bank,at=r.get("bank"),r["address"]
                pb=emulators[names.index(r.get("side","host"))]
                values[r["name"]]=int(pb.memory[mem(pb,at,bank)])
            if values:reads.append({"frame":f,"values":values})
        for proc in procs:
            proc.stdin.close()
            if proc.wait():raise RuntimeError("Capture ffmpeg failed")
        files=[]
        for i,name in enumerate(names):
            chunks=audio[i];raw=np.concatenate(chunks).astype(np.float64)*256;cum=np.r_[0,np.cumsum([len(c) for c in chunks])]
            times=np.arange(count+1)/FPS;src=np.interp(np.arange(int(times[-1]*SR))/SR,times,cum)
            snd=np.stack([np.interp(src,np.arange(len(raw)),raw[:,c]) for c in range(2)],1).round().astype(np.int16)
            wav=out/f'{name}.wav'
            with wave.open(str(wav),"wb") as w:w.setnchannels(2);w.setsampwidth(2);w.setframerate(SR);w.writeframes(snd.tobytes())
            vid=out/f'{name}.mkv';files.append({"id":name,"path":str(vid),"audioPath":str(wav),"sha256":sha(vid),"romSha256":sha(paths[i]),"fps":FPS,"frames":count})
        report={"adapter":"gameboy","pyboyVersion":version("pyboy"),"fps":FPS,"frames":count,"outputs":files,"marks":marks,"reads":reads,"linkExchanges":exchanges[0],
                "linkModel":"Explicit ROM serial-ISR read hooks; frame-stepped host then guest" if pair else None}
        (out/"capture.json").write_text(json.dumps(report,indent=2)+"\n");return report
    finally:
        for proc in procs:
            if proc.poll() is None:proc.kill();proc.wait()
        for pb in emulators:pb.stop(save=False)
