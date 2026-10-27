import numpy as np,wave,sys
from PIL import Image
from pathlib import Path
p=Path(sys.argv[1]);x=np.zeros((8,8,3),np.uint8);x[::2,::2]=[255,0,255];x[1::2,1::2]=[0,255,255]
Image.fromarray(x).save(p/'a.png');Image.fromarray(255-x).save(p/'b.png')
sr=48000;t=np.arange(int(5*sr))/sr;audio=.03*np.sin(t*2*np.pi*220)
for at in np.arange(0,5,.5):
 i=int(at*sr);n=1200;audio[i:i+n]+=.25*np.sin(np.arange(n)*2*np.pi*1800/sr)*np.exp(-np.arange(n)/300)
with wave.open(str(p/'bed.wav'),'wb') as w:w.setnchannels(2);w.setsampwidth(2);w.setframerate(sr);w.writeframes((np.repeat(audio[:,None],2,axis=1)*32767).astype(np.int16).tobytes())
with wave.open(str(p/'silence.wav'),'wb') as w:w.setnchannels(1);w.setsampwidth(2);w.setframerate(sr);w.writeframes(bytes(sr*2))

with wave.open(str(p/'short.wav'),'wb') as w:w.setnchannels(2);w.setsampwidth(2);w.setframerate(sr);w.writeframes((np.repeat(audio[:int(.3*sr),None],2,axis=1)*32767).astype(np.int16).tobytes())
