import sys,subprocess,wave
from pathlib import Path
import numpy as np
p=Path(sys.argv[1]);p.mkdir(parents=True,exist_ok=True)
frames=np.empty((12,8,16,3),np.uint8)
for i in range(12):
    yy,xx=np.mgrid[:8,:16];frames[i,:,:,0]=i*17;frames[i,:,:,1]=xx*13;frames[i,:,:,2]=yy*29
(p/'frames.rgb').write_bytes(frames.tobytes())
audio=np.repeat(np.repeat(np.arange(12,dtype=np.int16)*1000,4000)[:,None],2,axis=1)
with wave.open(str(p/'sound.wav'),'wb') as w:w.setnchannels(2);w.setsampwidth(2);w.setframerate(48000);w.writeframes(audio.tobytes())
subprocess.run(['ffmpeg','-v','error','-y','-f','rawvideo','-pix_fmt','rgb24','-s','16x8','-r','12','-i',str(p/'frames.rgb'),'-i',str(p/'sound.wav'),'-c:a','pcm_s16le','-c:v','ffv1','-threads','1',str(p/'source.mkv')],check=True)
