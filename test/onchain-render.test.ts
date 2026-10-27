import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {runTrailerTool} from '../dist/index.js';
const engineRoot=process.env.KEEL_ENGINE_ROOT,sdkRoot=process.env.KEEL_SDK_ROOT;
test('scene export awaits preparation and renders exact native frames with integer scaling',{skip:!engineRoot||!sdkRoot},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'trailer-export-'));try{
  await writeFile(path.join(root,'scene.js'),`export async function createTrailerScene({canvas}){await new Promise(r=>setTimeout(r,40));let f=0,prepared=-1;const c=canvas.getContext('2d');return{reset(){f=0},actions:{speed(){}},arities:{speed:0},step(dt,frame){f=frame},async prepareFrame(n){if(n!==f)throw Error('Preparation preceded simulation');await new Promise(r=>setTimeout(r,1));prepared=n;},render(){if(prepared!==f)throw Error('Drawing an unprepared frame');c.fillStyle='#14283c';c.fillRect(0,0,32,18);c.fillStyle='#e08040';c.fillRect(f*4,5,5,5)},snapshot(){return{f}}}}`);
  // bake includes worker source strings containing dynamic imports. These must
  // remain data when the canonical verifier scans the classic module source.
  const project={program:{version:1,seed:42,width:32,height:18,fps:4,bpm:120,ppq:96,duration:192,actions:[{name:'speed',arity:0}],cues:[{tick:0,action:0,args:[]}]},modules:['keel/core','keel/bake'],adapterPath:'scene.js'};
  await runTrailerTool('trailer-onchain',{project,engineRoot,sdkRoot,outDir:'bundle'},{workspaceRoot:root});
  const r=await runTrailerTool('trailer-onchain-render',{bundleDir:'bundle',outDir:'video',scale:6,crf:0},{workspaceRoot:root});
  assert.equal(r.video.frames,4);assert.equal(r.video.width,192);assert.equal(r.video.height,108);assert.equal(r.video.scaler,'nearest-neighbor');assert.equal(r.native.width,32);assert.equal(r.audio,null);assert.ok(r.checks.canonicalShell);
  const native=execFileSync('ffmpeg',['-v','error','-i',r.native.path,'-f','rawvideo','-pix_fmt','rgb24','-']);assert.equal(native.length,32*18*3*4);
  const zoom=execFileSync('ffmpeg',['-v','error','-i',r.native.path,'-vf','scale=192:108:flags=neighbor','-f','rawvideo','-pix_fmt','rgb24','-']);
  for(let f=0;f<4;f++)for(let y=0;y<108;y++)for(let x=0;x<192;x++)for(let c=0;c<3;c++)assert.equal(zoom[((f*108+y)*192+x)*3+c],native[((f*18+Math.floor(y/6))*32+Math.floor(x/6))*3+c]);
  assert.equal(JSON.parse(await readFile(r.reportPath)).pass,true);
  await assert.rejects(()=>runTrailerTool('trailer-onchain-render',{bundleDir:'bundle',outDir:'bad',scale:1.5},{workspaceRoot:root}),/integer/);
 }finally{await rm(root,{recursive:true,force:true})}
});
