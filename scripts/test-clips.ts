/** Original procedural fixtures only: no external footage, fonts or music. */
import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const out=new URL('../examples/basic/',import.meta.url);mkdirSync(out,{recursive:true});
const width=96,height=54,fps=12,frames=24;
const receipts=[];
for(const [name,variant] of [['test-grid',0],['test-orbit',1]] as const){
  const pixels=Buffer.alloc(width*height*3*frames);
  for(let f=0;f<frames;f++)for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const p=((f*height+y)*width+x)*3,checker=((x>>3)+(y>>3)+Math.floor(f/6))%2;
    const marker=variant===0?Math.abs(x-(f*3)%width)<5&&Math.abs(y-27)<9:(x-48)**2+(y-27)**2<((f%12)+8)**2;
    pixels[p]=marker?240:checker?35:15;pixels[p+1]=marker?130:checker?90:35;pixels[p+2]=marker?75:checker?125:65;
  }
  const target=new URL(name+'.mp4',out);
  const r=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','rawvideo','-pixel_format','rgb24','-video_size',`${width}x${height}`,'-framerate',String(fps),'-i','pipe:0','-an','-c:v','libx264','-threads','1','-preset','medium','-crf','18','-pix_fmt','yuv420p','-map_metadata','-1','-fflags','+bitexact','-flags:v','+bitexact','-movflags','+faststart',target.pathname],{input:pixels});
  if(r.status!==0)throw Error(r.stderr.toString());
  const bytes=readFileSync(target);receipts.push({file:name+'.mp4',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),width,height,fps,frames});
}
writeFileSync(new URL('clips.json',out),JSON.stringify({origin:'scripts/test-clips.ts; original procedural pixels; no audio',clips:receipts},null,2)+'\n');
console.log(JSON.stringify(receipts));
