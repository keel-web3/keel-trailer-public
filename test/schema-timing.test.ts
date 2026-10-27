import test from 'node:test';
import assert from 'node:assert/strict';
import {validateTimeline,beatToSeconds,editSeconds,boundaryFrame,sourceFrame,runTrailerTool} from '../dist/index.js';
const fixture=()=>({version:1,name:'tiny',fps:30,tempo:{bpm:128},sources:[{id:'a',kind:'image',path:'a.png'}],
 shots:[{id:'s',kind:'image',source:'a',startBeat:0,beats:4}],targets:[{id:'16x9',width:160,height:90}]});
test('schema rejects drift, unknown fields, missing sources, overlapping shots and inconsistent tempo',()=>{
 assert.equal(validateTimeline(fixture()).valid,true);
 for(const mutate of [
   t=>t.shots[0].startBeat=1,t=>t.shots[0].source='missing',t=>t.fps=29.97,t=>t.shots[0].mystery=true,
   t=>t.targets[0].width=161,t=>t.tempo.beatSeconds=.5,t=>t.name='../escape',
   t=>t.shots[0].ramp=[{beat:0,frame:0},{beat:1,frame:30}],
   t=>t.targets[0].safeArea={x:150,y:0,width:20,height:20},
   t=>t.tempo={beats:[0,.5,.4]},t=>t.shots[0].transition={type:'match-cut'}
 ]){const t=fixture();mutate(t);assert.equal(validateTimeline(t).valid,false,JSON.stringify(t));}
});
test('timing uses exact GB beat and nonuniform beat grid without accumulating rounding',()=>{
 const tempo={beatSeconds:28/59.7275};assert.equal(editSeconds(tempo,74),34.69088778200996);
 assert.equal(boundaryFrame(editSeconds(tempo,16),30),226);
 assert.equal(beatToSeconds({beats:[2,2.5,3.2]},1.5),2.85);
 assert.ok(Math.abs(editSeconds({beats:[2,2.5,3.2]},1.5)-.85)<1e-12);
 assert.equal(sourceFrame({in:2,speed:1.5},1,.5,60),165);
 const ramp={ramp:[{beat:0,frame:10},{beat:2,frame:130},{beat:4,frame:130}]};
 assert.equal(sourceFrame(ramp,1,.5,60),70);assert.equal(sourceFrame(ramp,3,1.5,60),130);
 assert.equal(sourceFrame({holdFrame:7},2,4,60),7);
});
test('plan returns a validated editable JSON scaffold and preserves sources',async()=>{
 const result=await runTrailerTool('trailer-plan',{brief:'Show the world and the launch',sources:fixture().sources,durationBeats:16});
 assert.equal(validateTimeline(result.timeline).valid,true);assert.deepEqual(result.timeline.sources,fixture().sources);
 await assert.rejects(()=>runTrailerTool('trailer-plan',{brief:'x',sources:[{id:'a',kind:'audio',path:'a.wav'}]}),/visual source/);
});
test('custom capture adapters register their own validated JSON options',async()=>{
 const {registerCaptureAdapter}=await import('../dist/index.js');
 const {mkdtemp,rm}=await import('node:fs/promises');const os=await import('node:os');const path=await import('node:path');
 const root=await mkdtemp(path.join(os.tmpdir(),'keel-trailer-adapter-'));
 try {
  registerCaptureAdapter('fixture',async c=>({adapter:'fixture',frames:c.options.frames}),
    {type:'object',properties:{frames:{type:'integer',minimum:1}},required:['frames'],additionalProperties:false});
  const result=await runTrailerTool('trailer-capture',{capture:{adapter:'fixture',options:{frames:3}},outDir:'out'},{workspaceRoot:root});
  assert.equal(result.frames,3);
  await assert.rejects(()=>runTrailerTool('trailer-capture',{capture:{adapter:'fixture',options:{frames:0}},outDir:'out'},{workspaceRoot:root}),/INVALID_SCHEMA/);
 }finally{await rm(root,{recursive:true,force:true});}
});
