import numpy as np,subprocess,sys
from PIL import Image
from pathlib import Path
p=Path(sys.argv[1]);rng=np.random.default_rng(5)
y,x=np.mgrid[0:120,0:160]
for name,cx,cy,col in (('still-a.png',60,50,(255,60,120)),('still-b.png',100,70,(255,190,40))):
    r=np.sqrt((x-cx)**2+(y-cy)**2);im=np.zeros((120,160,3),np.float32)
    for c in range(3):im[...,c]=np.clip(col[c]*np.exp(-(r/38)**2),0,255)
    Image.fromarray(im.astype(np.uint8)).save(p/name)
subprocess.run(['ffmpeg','-v','error','-y','-f','lavfi','-i','testsrc2=size=160x120:rate=12:duration=6','-pix_fmt','yuv420p','-c:v','libx264',str(p/'motion.mp4')],check=True)
# A transparent GIF (opaque ring on a transparent ground), a bright solid still, and a clip whose caption is fixed
# while the picture moves, for the erase / alpha / lint tests.
ring=Image.new('RGBA',(40,40),(0,0,0,0))
for yy in range(40):
    for xx in range(40):
        d=((xx-19.5)**2+(yy-19.5)**2)**.5
        if 8<=d<=15:ring.putpixel((xx,yy),(255,80,40,255))
ring2=ring.transform(ring.size,Image.AFFINE,(1,0,2,0,1,0))
ring.save(p/'sticker.gif',save_all=True,append_images=[ring2],duration=100,loop=0,disposal=2,transparency=0)
Image.fromarray(np.full((120,160,3),200,np.uint8)).save(p/'bright.png')
subprocess.run(['ffmpeg','-v','error','-y','-f','lavfi','-i','testsrc2=size=160x120:rate=12:duration=4','-vf','drawbox=x=10:y=8:w=70:h=14:color=white:t=fill','-pix_fmt','yuv420p','-c:v','libx264','-crf','12',str(p/'captioned.mp4')],check=True)
