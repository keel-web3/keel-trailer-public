import test from 'node:test';
import assert from 'node:assert/strict';
import {createSceneCodec,assertProgram,createScenePlayer,assertSceneData} from '../dist/program.js';
import {pathToFileURL} from 'node:url';
const root=process.env.KEEL_ENGINE_ROOT;
const fixture=()=>({version:1,seed:7,width:320,height:180,fps:60,bpm:120,ppq:96,duration:768,actions:[{name:'scene',arity:1},{name:'speed',arity:1}],cues:[{tick:0,action:0,args:[1]},{tick:96,action:1,args:[0],to:[10],duration:192,ease:'smooth'},{tick:384,action:0,args:[2]}]});
test('scene profile rejects unknown fields, unbounded inputs, invalid references and overlapping tweens',()=>{
 for(const mutate of [p=>p.version=2,p=>p.code='eval()',p=>p.duration=0,p=>p.actions[0].name='__proto__',p=>p.cues[0].action=9,p=>p.cues[0].args=[NaN],p=>p.cues[0].args=[],p=>p.cues[1].duration=99999,p=>p.cues.reverse(),p=>p.cues.push({tick:400,action:1,args:[0],to:[1],duration:100000,ease:'linear'})]){const p=fixture();mutate(p);assert.throws(()=>assertProgram(p));}
});
test('seek reconstructs state by fixed steps and emits final tween endpoints exactly',()=>{
 let state,events;const p=fixture();const host={reset(){state={scene:0,speed:0,steps:0};events=[];},call(name,args){state[name]=args[0];events.push([name,args[0]]);},step(){state.steps++;},render(){}};
 const player=createScenePlayer(p,host);player.seek(3);const expected=structuredClone(state);assert.equal(expected.speed,10);assert.equal(expected.scene,2);
 player.seek(.1);player.seek(3);assert.deepEqual(state,expected);assert.ok(events.some(e=>e[0]==='speed'&&e[1]===10));assert.throws(()=>player.seek(Infinity));
});
test('prepared seeks apply cues and fixed steps before preparing and drawing the exact frame',async()=>{
 let state,prepared,drawn;const player=createScenePlayer(fixture(),{
  reset(){state={scene:0,speed:0,steps:0};},call(name,args){state[name]=args[0];},step(){state.steps++;},
  async prepare(frame){prepared={frame,state:structuredClone(state)};await Promise.resolve();},
  render(){drawn=structuredClone(state);assert.deepEqual(drawn,prepared.state);}
 });
 await player.seekPrepared(3);assert.equal(prepared.frame,180);assert.equal(drawn.steps,180);assert.equal(drawn.scene,2);assert.equal(drawn.speed,10);
 const expected=structuredClone(drawn);await player.seekPrepared(.1);await player.seekPrepared(3);assert.deepEqual(drawn,expected);
});
test('reset or a newer seek prevents a delayed preparation from drawing stale state',async()=>{
 let release,draws=0;const player=createScenePlayer(fixture(),{reset(){},call(){},step(){},prepare(){return new Promise(r=>release=r);},render(){draws++;}});
 const waiting=player.seekPrepared(2);player.reset();release();await waiting;assert.equal(draws,0);
 const next=player.seekPrepared(3);player.seek(.5);release();await next;assert.equal(draws,1);
});
test('real KEEL codec roundtrip is canonical, smaller than JSON and rejects damaged/trailing bytes',{skip:!root},async()=>{
 const codec=await import(pathToFileURL(root+'/packages/codec/src/runtime.ts'));const api=createSceneCodec(codec),p=fixture(),bytes=api.encode(p);
 assert.deepEqual(api.decode(bytes),p);assert.ok(bytes.length<JSON.stringify(p).length/2);
 assert.throws(()=>api.decode(bytes.subarray(0,bytes.length-1)));assert.throws(()=>api.decode(new Uint8Array([...bytes,0])));
 for(let i=0;i<50;i++){const q=fixture();q.seed=i;q.cues[0].args=[i/10];assert.deepEqual(api.decode(api.encode(q)),q);}
});
test('scene v2 configuration is bounded JSON data and v1 remains strict',()=>{
 const p={...fixture(),version:2,data:{shots:[{seed:'11',hue:195,smoke:true,speed:0.1}]}};assert.equal(assertProgram(p),p);
 for(const data of [{code:()=>{}},{bad:Infinity},{['__proto__']:1},new Date(),{text:'a'.repeat(257)},Array(257).fill(0)])assert.throws(()=>assertSceneData(data));
 const cycle={};cycle.child=cycle;assert.throws(()=>assertSceneData(cycle));
 assert.throws(()=>assertProgram({...fixture(),data:{shots:[]}}));assert.throws(()=>assertProgram({...fixture(),version:2}));
});
test('existing KEEL codec preserves complete scene-v2 configuration and v1 bytes',{skip:!root},async()=>{
 const codec=await import(pathToFileURL(root+'/packages/codec/src/runtime.ts')),api=createSceneCodec(codec),v1=fixture(),before=api.encode(v1);
 const p={...v1,version:2,data:{shots:Array.from({length:16},(_,i)=>({id:'shot-'+i,carSeed:String(i+11),camera:'side',hue:195+i,chroma:.24,light:.71,smoke:true,speed:0.1,optional:null}))}};
 const bytes=api.encode(p);assert.deepEqual(api.decode(bytes),p);assert.ok(bytes.length<1500);assert.deepEqual(api.encode(api.decode(before)),before);
 assert.throws(()=>api.decode(new Uint8Array([...bytes,0])));assert.throws(()=>api.decode(bytes.subarray(0,bytes.length-1)));
 const legacy={...codec,dyn:undefined};assert.deepEqual(createSceneCodec(legacy).decode(before),v1);assert.throws(()=>createSceneCodec(legacy).encode(p),/does not support scene v2/);
});
