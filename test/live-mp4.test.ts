import test from'node:test';import assert from'node:assert/strict';import{mkdtemp,writeFile,rm}from'node:fs/promises';import os from'node:os';import path from'node:path';import{execFileSync}from'node:child_process';import{runTrailerTool}from'../dist/index.js';
const engineRoot=process.env.KEEL_ENGINE_ROOT,sdkRoot=process.env.KEEL_SDK_ROOT;
test('verified scene starts in the engine then becomes a savable MP4 with generated sound',{skip:!engineRoot||!sdkRoot},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'keel-live-film-'));try{
  await writeFile(root+'/scene.js',`export const supportsWorkerExport=true;export function createTrailerScene({canvas}){let f=0,prepared=-1;const c=canvas.getContext('2d');return{reset(){f=0},actions:{shot(){}},arities:{shot:0},step(dt,n){f=n},async prepareFrame(n){if(n!==f)throw Error('Preparation preceded simulation');await new Promise(r=>setTimeout(r,1));prepared=n;},render(){if(prepared!==f)throw Error('Drawing an unprepared frame');c.fillStyle='#14283c';c.fillRect(0,0,32,18);c.fillStyle='#e08040';c.fillRect(f%27,5,5,5);},snapshot(){return{f}}}}`);
  const project={program:{version:1,seed:42,width:32,height:18,fps:12,bpm:120,ppq:96,duration:384,actions:[{name:'shot',arity:0}],cues:[{tick:0,action:0,args:[]}]},modules:['keel/core'],adapterPath:'scene.js',music:{mode:'recipe',recipe:{from:'game',seed:42,spec:{energy:.8,tempo:120}}},liveMP4:{scale:6,autoplay:true}};
  await runTrailerTool('trailer-onchain',{project,engineRoot,sdkRoot,outDir:'bundle'},{workspaceRoot:root});
  const r=await runTrailerTool('trailer-onchain-live-test',{bundleDir:'bundle',outDir:'proof'},{workspaceRoot:root});assert.equal(r.pass,true,JSON.stringify(r));assert.equal(r.checks.savable,true);
  const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-of','json',r.video.path]));assert.ok(probe.streams.some(s=>s.codec_type==='audio'&&s.codec_name==='aac'));assert.ok(probe.streams.some(s=>s.codec_type==='video'&&s.codec_name==='h264'));assert.equal(r.publication,'not-published');
 }finally{await rm(root,{recursive:true,force:true})}
});
