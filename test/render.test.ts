import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,cp,symlink,mkdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runTrailerTool} from '../dist/index.js';
const python=process.env.TRAILER_PYTHON??'python3';
const make=root=>{const r=spawnSync(python,[fileURLToPath(new URL('make-fixtures.py',import.meta.url)),root],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
test('beat detector finds synthetic tempo, honors declaration, rejects silent guesses',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'keel-trailer-beats-'));
 try{
  make(root);const r=await runTrailerTool('trailer-beats',{audioPath:'bed.wav'},{workspaceRoot:root,python});
  assert.ok(Math.abs(r.tempo.bpm-120)<3,JSON.stringify(r.tempo));assert.ok(r.attacks.length>=8);
  const short=await runTrailerTool('trailer-beats',{audioPath:'short.wav',bpm:120},{workspaceRoot:root,python});assert.equal(short.tempo.bpm,120);
  await assert.rejects(()=>runTrailerTool('trailer-beats',{audioPath:'bed.wav',beats:[0,.5,.4]},{workspaceRoot:root,python}),/strictly increase/);
  const declared=await runTrailerTool('trailer-beats',{audioPath:'bed.wav',beatSeconds:28/59.7275,firstDownbeat:0},{workspaceRoot:root,python});
  assert.equal(declared.tempo.beatSeconds,28/59.7275);assert.equal(declared.tempo.mode,'declared');
  await assert.rejects(()=>runTrailerTool('trailer-beats',{audioPath:'silence.wav'},{workspaceRoot:root,python}),/No audible attacks/);
  const silent=await runTrailerTool('trailer-beats',{audioPath:'silence.wav',bpm:120},{workspaceRoot:root,python});assert.equal(silent.confidence,0);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('tiny end-to-end render, all targets, deterministic hashes, exact stills, verification and confinement',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'keel-trailer-e2e-'));
 try{
  make(root);await cp(fileURLToPath(new URL('fixtures/test-pixel.ttf',import.meta.url)),path.join(root,'font.ttf'));
  const timeline={version:1,name:'tiny',fps:12,seed:7,tempo:{bpm:120,firstDownbeat:0,audioSource:'bed'},
   sources:[{id:'a',kind:'image',path:'a.png',pixelArt:true},{id:'b',kind:'image',path:'b.png',pixelArt:true},{id:'bed',kind:'audio',path:'bed.wav'}],
   shots:[{id:'first',kind:'image',source:'a',startBeat:0,beats:4},
          {id:'second',kind:'image',source:'b',startBeat:4,beats:4,transition:{type:'dither',beats:1,pixelScale:4},caption:{lines:['LAUNCH'],font:'font.ttf',scale:1}}],
   audio:[{id:'bed',role:'bed',source:'bed',startBeat:0,beats:8,gain:1,fadeIn:.02,fadeOut:.1}],
   targets:[{id:'wide',width:160,height:90,maxBytes:250000,loudness:-14,truePeak:-1.5},
            {id:'tall',width:90,height:160,maxBytes:250000,loudness:-14,truePeak:-1.5},
            {id:'square',width:96,height:96,maxBytes:250000,loudness:-14,truePeak:-1.5}]};
  const opts={workspaceRoot:root,python};
  const one=await runTrailerTool('trailer-render',{timeline,outDir:'one'},opts);
  const two=await runTrailerTool('trailer-render',{timeline,outDir:'two'},opts);
  assert.equal(one.outputs.length,3);
  for(let i=0;i<3;i++){assert.equal(one.outputs[i].frames,48);assert.equal(one.outputs[i].sha256,two.outputs[i].sha256);assert.equal(one.outputs[i].rgbSha256,two.outputs[i].rgbSha256);}
  const still=await runTrailerTool('trailer-stills',{timeline,outDir:'stills',times:[2.25],targets:['wide']},opts);
  const inspected=await runTrailerTool('trailer-snapshot',{timeline,outDir:'snapshot',frames:[27],target:'wide',pixelData:true},opts);
  assert.equal(inspected.stills[0].frame,27);
  const exact=path.join(root,'exact.rgb');
  const ff=spawnSync('ffmpeg',['-v','error','-y','-i',one.outputs[0].losslessPath,'-vf','select=eq(n\\,27)','-frames:v','1','-f','rawvideo','-pix_fmt','rgb24',exact]);assert.equal(ff.status,0,ff.stderr.toString());
  const decode=p=>spawnSync(python,['-c','from PIL import Image;import sys;sys.stdout.buffer.write(Image.open(sys.argv[1]).convert("RGB").tobytes())',p]).stdout;const exactPixels=await readFile(exact);
  assert.deepEqual(decode(still.stills[0].path),exactPixels);assert.deepEqual(await readFile(inspected.stills[0].pixels.path),exactPixels);
  const report=await runTrailerTool('trailer-verify',{timeline,renderDir:'one'},opts);
  assert.equal(report.outputs.length,3);assert.ok(report.beatAlignment.passed);assert.ok(report.passed,JSON.stringify(report.outputs));
  const offbeat=structuredClone(timeline);offbeat.shots[0].beats=4.2;offbeat.shots[1].startBeat=4.2;offbeat.shots[1].beats=3.8;
  const bad=await runTrailerTool('trailer-verify',{timeline:offbeat,renderDir:'one'},opts);assert.equal(bad.beatAlignment.passed,false);
  await assert.rejects(()=>runTrailerTool('trailer-stills',{timeline,outDir:'bad',times:[4]},opts),/outside timeline/);
  await symlink('/etc/hosts',path.join(root,'escape'));const unsafe=structuredClone(timeline);unsafe.sources[0].path='escape';
  await assert.rejects(()=>runTrailerTool('trailer-render',{timeline:unsafe,outDir:'bad'},opts),/inside trailer workspace/);
  await mkdir(path.join(root,'unsafe'));await symlink('/private/tmp',path.join(root,'unsafe','link'));
  await assert.rejects(()=>runTrailerTool('trailer-render',{timeline,outDir:'unsafe'},opts),/contains a symlink/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('transition pixel invariants, rectangle mapping and Python/JS timing agree',()=>{
 const r=spawnSync(python,[fileURLToPath(new URL('materials-timing.py',import.meta.url))],{encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);
});
