import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runTrailerTool,validateTimeline} from '../dist/index.js';
const python=process.env.TRAILER_PYTHON??'python3';
const fixtures=root=>{const r=spawnSync(python,[fileURLToPath(new URL('make-montage-fixtures.py',import.meta.url)),root],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
const base=()=>({version:1,name:'mont',fps:12,seed:7,tempo:{bpm:120,firstDownbeat:0},
  sources:[{id:'a',kind:'image',path:'still-a.png'},{id:'b',kind:'image',path:'still-b.png'},{id:'m',kind:'video',path:'motion.mp4'}],
  shots:[
   {id:'open',kind:'stage',startBeat:0,beats:4,layers:[{source:'m',blend:'normal',fit:'cover',blackPoint:.1,rectVariants:[{target:'tall',rect:{x:8,y:8,width:80,height:100}}]},{source:'a',blend:'add',opacity:.6,mask:'ellipse',feather:.6,rect:{x:20,y:10,width:80,height:60},scaleFrom:1,scaleTo:1.2}],post:{bloom:{radius:8,gain:.5},chroma:{pixels:1}}},
   {id:'mosh',kind:'stage',startBeat:4,beats:4,transition:{type:'datamosh',beats:1.5,blockSize:16},layers:[{source:'m',in:2,fit:'cover'},{source:'b',blend:'screen',opacity:.8,fit:'contain',invert:true}]},
   {id:'mosaic',kind:'stage',startBeat:8,beats:4,transition:{type:'mosaic',beats:1,blockSize:32},layers:[{source:'b',fit:'cover'},{source:'m',blend:'difference',opacity:.5,loop:true}]},
   {id:'tail',kind:'stage',startBeat:12,beats:4,transition:{type:'displace',beats:1,strength:12},layers:[{source:'a',fit:'cover',posterize:6},{source:'m',blend:'lighten',opacity:.7}],post:{pulse:{periodBeats:4,amount:.02}}}],
  targets:[{id:'web',width:160,height:96,silent:true,maxBytes:400000,posterBeat:6},{id:'tall',width:96,height:128,silent:true,crf:26}],
  loop:{seamBeats:2,transition:{type:'datamosh',beats:1.5,blockSize:16}}});
const frames=(file,w,h)=>{const r=spawnSync('ffmpeg',['-v','error','-i',file,'-f','rawvideo','-pix_fmt','rgb24','-'],{maxBuffer:1<<28});assert.equal(r.status,0,r.stderr?.toString());const n=w*h*3;return Array.from({length:r.stdout.length/n},(_,i)=>r.stdout.subarray(i*n,(i+1)*n));};
const diff=(x,y)=>{let d=0;for(let i=0;i<x.length;i++)d+=Math.abs(x[i]-y[i]);return d/x.length;};
test('layers, post effects and cross transitions render deterministically with silent delivery and a smooth loop',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'keel-trailer-montage-'));
  try{
    fixtures(root);const timeline=base();assert.ok(validateTimeline(timeline).valid,JSON.stringify(validateTimeline(timeline).issues));
    const opts={workspaceRoot:root,python};
    const one=await runTrailerTool('trailer-render',{timeline,outDir:'one'},opts);
    const two=await runTrailerTool('trailer-render',{timeline,outDir:'two'},opts);
    // 16 authored beats minus a 2-beat lead-in at 0.5 s/beat = 7 s at 12 fps.
    for(let i=0;i<2;i++){assert.equal(one.outputs[i].frames,84);assert.equal(one.outputs[i].rgbSha256,two.outputs[i].rgbSha256);assert.equal(one.outputs[i].audio,null);}
    assert.ok(one.outputs[0].bytes<=400000);
    const streams=spawnSync('ffprobe',['-v','error','-show_entries','stream=codec_type','-of','csv=p=0',one.outputs[0].path],{encoding:'utf8'}).stdout.trim().split('\n');
    assert.deepEqual(streams,['video'],'silent target carries no audio stream');
    const clip=frames(one.outputs[0].losslessPath,160,96);assert.equal(clip.length,84);
    const steps=clip.slice(1).map((f,i)=>diff(clip[i],f)).sort((p,q)=>p-q);const median=steps[steps.length>>1];
    // The join is as continuous as the video's own consecutive frames, not a cut.
    assert.ok(diff(clip.at(-1),clip[0])<=Math.max(3*median,2),'loop join '+diff(clip.at(-1),clip[0])+' vs median '+median);
    // Transitions are real: their frames differ from both neighbours' endpoints.
    assert.ok(new Set(clip.map(f=>f.subarray(0,4096).join())).size>60);
    const verification=await runTrailerTool('trailer-verify',{timeline,renderDir:'one'},opts);
    assert.ok(verification.passed,JSON.stringify(verification.outputs));assert.equal(verification.beatAlignment.skipped.length>0,true);
    const still=await runTrailerTool('trailer-stills',{timeline,outDir:'stills',times:[0,3.2],targets:['web']},opts);
    assert.equal(still.stills.length,2);
    await assert.rejects(()=>runTrailerTool('trailer-stills',{timeline,outDir:'bad',times:[7.1]},opts),/outside timeline/);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('schema rejects malformed layers, stage shots and loop seams',()=>{
  const bad=(edit,message)=>{const t=base();edit(t);const r=validateTimeline(t);assert.equal(r.valid,false);assert.ok(r.issues.some(i=>i.message.includes(message)),JSON.stringify(r.issues));};
  bad(t=>{t.shots[0].layers=[];},'stage requires');
  bad(t=>{t.shots[0].layers[0].source='nope';},'visual source');
  bad(t=>{t.shots[0].layers[0].blend='burn';},'unsupported');
  bad(t=>{t.shots[0].layers[1].opacity=2;},'out of range');
  bad(t=>{t.loop.seamBeats=4;},'shorter than the opening');
  bad(t=>{t.loop.transition.type='match-cut';},'cannot bridge');
  bad(t=>{t.targets[0].posterBeat=1;},'lead-in');
  bad(t=>{t.shots[1].layers[0].fadeInBeats=5;},'fades exceed');
  bad(t=>{t.shots[0].layers[0].rectVariants[0].target='phone';},'unknown target');
  bad(t=>{t.shots[0].layers[0].blackPoint=.9;},'out of range');
});
test('layer blends, masks, bloom, mosaic, displacement and datamosh keep their pixel invariants',()=>{
  const r=spawnSync(python,[fileURLToPath(new URL('montage-invariants.py',import.meta.url))],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);
});

const ending=()=>{
  const t=base();delete t.loop;delete t.shots[0].layers[0].rectVariants;
  t.shots=[t.shots[0],{id:'last',kind:'stage',startBeat:4,beats:4,transition:{type:'datamosh',beats:1.5,blockSize:16},layers:[
    {source:'m',in:1,fit:'cover'},{source:'a',blend:'screen',opacity:.8,fit:'contain',mask:'ellipse',feather:.5,fadeInBeats:1,scaleFrom:1,scaleTo:1.1,rect:{x:30,y:10,width:90,height:70}}]}];
  t.ending={kind:'loop',seconds:3,seamBeats:2,transition:{type:'dissolve',beats:2}};
  t.targets=[{id:'web',width:160,height:96,silent:true,maxBytes:400000,loopMaxBytes:300000,posterBeat:0}];return t;
};
test('an ending loop continues the final shot as a second video that wraps and hands over smoothly',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'keel-trailer-ending-'));
  try{
    fixtures(root);const timeline=ending();assert.ok(validateTimeline(timeline).valid,JSON.stringify(validateTimeline(timeline).issues));
    const opts={workspaceRoot:root,python};
    const one=await runTrailerTool('trailer-render',{timeline,outDir:'one'},opts);
    const two=await runTrailerTool('trailer-render',{timeline,outDir:'two'},opts);
    // 8 authored beats at 0.5 s/beat: the main video plays them once (no lead-in, no seam), the loop is 3 s.
    assert.equal(one.outputs[0].frames,48);assert.equal(one.loops.length,1);assert.equal(one.loops[0].frames,36);
    assert.equal(one.loops[0].rgbSha256,two.loops[0].rgbSha256);assert.match(one.loops[0].path,/mont-loop-web\.mp4$|mont-web-loop\.mp4$/);
    assert.ok(one.loops[0].bytes<=300000);
    const streams=spawnSync('ffprobe',['-v','error','-show_entries','stream=codec_type','-of','csv=p=0',one.loops[0].path],{encoding:'utf8'}).stdout.trim().split('\n');
    assert.deepEqual(streams,['video']);
    const main=frames(one.outputs[0].losslessPath,160,96),loop=frames(one.loops[0].losslessPath,160,96);
    const steps=loop.slice(1).map((f,i)=>diff(loop[i],f)).sort((p,q)=>p-q);const median=steps[steps.length>>1];
    assert.ok(diff(loop.at(-1),loop[0])<=Math.max(3*median,2),'wrap '+diff(loop.at(-1),loop[0])+' vs '+median);
    assert.ok(diff(main.at(-1),loop[0])<=Math.max(3*median,2),'hand-over '+diff(main.at(-1),loop[0])+' vs '+median);
    const verification=await runTrailerTool('trailer-verify',{timeline,renderDir:'one'},opts);
    assert.ok(verification.passed,JSON.stringify(verification.loops));assert.equal(verification.loops.length,1);
    assert.equal(verification.loops[0].wrapPassed&&verification.loops[0].handoverPassed,true);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('schema rejects an ending that cannot loop',()=>{
  const bad=(edit,message)=>{const t=ending();edit(t);const r=validateTimeline(t);assert.equal(r.valid,false);assert.ok(r.issues.some(i=>i.message.includes(message)),JSON.stringify(r.issues));};
  bad(t=>{t.loop={seamBeats:1,transition:{type:'dissolve'}};},'not both');
  bad(t=>{t.targets[0].silent=false;},'silent web delivery');
  bad(t=>{t.ending.seamBeats=5;},'must not exceed the final shot');
  bad(t=>{t.ending.seconds=.5;},'longer than the seam');
  bad(t=>{t.shots.at(-1).post={pulse:{periodBeats:4,amount:.02}};},'breaks the loop seam');
  bad(t=>{t.shots.at(-1).layers[0].fadeOutBeats=1;},'must stay steady');
  bad(t=>{t.shots.at(-1).layers[0].driftX=.1;},'drift');
  bad(t=>{t.tempo={beats:[0,.5,1.1,1.6]};},'constant tempo');
  bad(t=>{t.shots.at(-1).layers[0].erase=[{rect:{x:0,y:0,width:2,height:2},staticBright:{}}];},'exactly one of');
  bad(t=>{t.ending.transition.type='match-cut';},'cannot bridge');
});
test('erase, true-alpha sources and inside placement composite as cut-outs',()=>{
  const root=spawnSync('mktemp',['-d'],{encoding:'utf8'}).stdout.trim();
  try{
    fixtures(root);
    const r=spawnSync(python,[fileURLToPath(new URL('layers-invariants.py',import.meta.url)),root],{encoding:'utf8'});assert.equal(r.status,0,r.stderr+r.stdout);
  }finally{spawnSync('rm',['-rf',root]);}
});
test('lint finds cut-off crops, hard edges, clipped and upscaled pieces, and honours allow',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'keel-trailer-lint-'));
  try{
    fixtures(root);const opts={workspaceRoot:root,python};
    const t=base();delete t.loop;t.targets=[{id:'web',width:160,height:96,silent:true,maxBytes:400000}];
    t.sources.push({id:'bright',kind:'image',path:'bright.png'});
    t.shots=[{id:'s',kind:'stage',startBeat:0,beats:4,layers:[
      {source:'a',crop:{x:0,y:0,width:60,height:120},fit:'contain',blend:'screen',mask:'ellipse',feather:.9,rect:{x:0,y:0,width:60,height:96}},
      {source:'bright',blend:'screen',fit:'contain',rect:{x:20,y:10,width:60,height:40}},
      {source:'a',blend:'screen',fit:'contain',rect:{x:-50,y:0,width:120,height:90}},
      {source:'a',crop:{x:50,y:40,width:20,height:20},blend:'screen',fit:'contain',mask:'ellipse',feather:.9,rect:{x:60,y:10,width:80,height:80}}]}];
    const lint=await runTrailerTool('trailer-lint',{timeline:t,samplesPerShot:1},opts);
    const kinds=lint.findings.map(f=>f.kind+':'+f.layer);
    assert.ok(kinds.includes('cutoff:0'),kinds.join());assert.ok(kinds.includes('hard-edge:1'),kinds.join());
    assert.ok(kinds.includes('clipped:2'),kinds.join());assert.ok(kinds.includes('upscaled:3'),kinds.join());
    assert.equal(lint.passed,false);assert.ok(lint.findings.every(f=>f.fix&&f.measured));
    const allowed=structuredClone(t);allowed.shots[0].layers[0].lint={allow:['cutoff']};allowed.shots[0].layers[1].lint={allow:['hard-edge']};allowed.shots[0].layers[2].inside=true;allowed.shots[0].layers[2].lint={allow:['hard-edge']};allowed.shots[0].layers[3].lint={allow:['cutoff']};
    const again=await runTrailerTool('trailer-lint',{timeline:allowed,samplesPerShot:1},opts);
    const left=again.findings.map(f=>f.kind+':'+f.layer);assert.deepEqual(left.filter(k=>!k.startsWith('upscaled')),[],left.join());
  }finally{await rm(root,{recursive:true,force:true});}
});
