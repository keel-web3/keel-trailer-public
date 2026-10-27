import {createMulberry32} from '@keel-engine/core';
// An engine-backed test scene, not a REDLINE branding replacement.
export function createTrailerScene({canvas}){
 const ctx=canvas.getContext('2d');let dots,frame,speed,hue;
 return {arities:{speed:1,hue:1},actions:{speed:v=>speed=v,hue:v=>hue=v},
  reset(seed){const rng=createMulberry32(seed);dots=Array.from({length:96},()=>[rng()*320,rng()*180,rng()*2+1]);frame=0;speed=1;hue=190;},
  step(dt,f){frame=f;for(const d of dots)d[0]=(d[0]+speed*d[2]+320)%320;},
  render(){ctx.fillStyle='#080a18';ctx.fillRect(0,0,320,180);for(const [x,y,size]of dots){ctx.fillStyle=`hsl(${hue} 95% ${45+size*12}%)`;ctx.fillRect(Math.floor(x),Math.floor(y),Math.ceil(size*speed),Math.ceil(size));}ctx.fillStyle='#fff';ctx.fillRect(24,160,Math.floor(frame/480*272),2);},
  snapshot(){return {frame,speed,hue,dots};}
 };
}
