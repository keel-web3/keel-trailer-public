import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {syncCues} from '../dist/cue-sync.js';
import {assertArrangement,renderArrangement} from '../dist/score-render.js';
import {TOOL_SCHEMAS} from '../dist/schema.js';

test('cue sync lands every cue on the grid and keeps footage continuous',()=>{
  const r=syncCues({cues:[3.74,7.24,11.68,45.16,46.1,46.8],sourceId:'f',sourceEnd:49.6,bpm:150,transitions:['flash','dither'],fastTransitions:['punch']});
  const beat=0.4;
  for(const c of r.cueBeats){assert.equal(c.beat%0.5,0);}
  // each shot starts where the previous one's source ended
  for(let i=1;i<r.shots.length;i++){const a=r.shots[i-1];assert.ok(Math.abs(a.in+a.speed*a.beats*beat-r.shots[i].in)<1e-4);}
  assert.equal(r.shots[0].transition,undefined);assert.equal(r.shots[1].transition.type,'flash');
  assert.equal(r.shots.at(-1).transition.type,'punch');   // a quick press uses the fast pool
  assert.ok(r.shots.every(s=>s.speed>0.6&&s.speed<1.5));
});

test('cue sync rejects empty input',()=>{assert.throws(()=>syncCues({cues:[],sourceId:'f',sourceEnd:3,bpm:120}));});

test('new tools are declared with closed schemas',()=>{
  for(const n of ['trailer-footage','trailer-cue-sync','trailer-score'])assert.equal(TOOL_SCHEMAS[n].additionalProperties,false);
});

test('arrangements are validated',()=>{
  assert.throws(()=>assertArrangement({version:2}));
  assert.throws(()=>assertArrangement({version:1,bpm:120,totalBeats:8,tracks:[],hits:[{beat:1,kind:'boom'}]}));
});

test('arrangement renders on the KEEL engine instruments with hits in time',{skip:!process.env.KEEL_ENGINE_ROOT},async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'keel-score-'));
  try{
    const r=await renderArrangement({version:1,bpm:120,totalBeats:8,tailSeconds:1,tracks:[
      {voice:'musicbox',notes:[{beat:0,beats:0.5,pitch:78},{beat:1,beats:0.5,pitch:85}]},
      {voice:'pulse',notes:[{beat:2,beats:1,pitch:66}]},{voice:'kick',notes:[{beat:0,beats:0.3,pitch:36}]}],
      hits:[{beat:4,kind:'press',power:0.6,tail:1.5},{beat:6,kind:'final',power:1.2}]},{engineRoot:process.env.KEEL_ENGINE_ROOT,outDir:dir,rate:22050});
    assert.equal(r.hits.length,2);assert.equal(r.hits[0].seconds,2);
    const wav=await readFile(r.mix);assert.equal(wav.toString('ascii',0,4),'RIFF');
    // the press is audible right on its beat: the sfx stem is silent before 1.5 s and loud just after 2 s
    const sfx=await readFile(r.sfx),at=s=>Math.abs(sfx.readFloatLE(44+Math.round(s*22050)*8));
    let before=0,after=0;for(let i=0;i<200;i++){before=Math.max(before,at(1.4+i/22050));after=Math.max(after,at(2.02+i/22050));}
    assert.ok(before<1e-3&&after>0.05,`before ${before} after ${after}`);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('a loop renders its second time round, so the tails wrap and the seam is the music\'s own',{skip:!process.env.KEEL_ENGINE_ROOT},async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'keel-loop-'));
  try{
    // a long pad from beat 0 and a reverbed note at the very end: both ring across the wrap
    const r=await renderArrangement({version:1,bpm:120,totalBeats:8,loop:true,tracks:[
      {voice:'saw-pad',reverb:0.6,release:1.5,notes:[{beat:0,beats:6,pitch:54}]},{voice:'bell',reverb:0.8,notes:[{beat:7.5,beats:0.5,pitch:78}]}],
      hits:[{beat:4,kind:'press',power:0.5,tail:1}]},{engineRoot:process.env.KEEL_ENGINE_ROOT,outDir:dir,rate:22050});
    assert.equal(r.seconds,4);assert.equal(r.totalBeats,8);assert.deepEqual(r.hits.map(h=>h.seconds),[2]);
    assert.ok(r.loop.seamless,JSON.stringify(r.loop));
    // the first sample is not silence: the bell's tail from the time before is already there
    const mix=await readFile(r.mix);assert.equal((mix.length-44)/8,4*22050);assert.ok(Math.abs(mix.readFloatLE(44))>1e-5);
  }finally{await rm(dir,{recursive:true,force:true});}
});
