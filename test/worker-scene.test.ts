import test from 'node:test';import assert from 'node:assert/strict';import {createWorkerScene}from'../dist/worker-scene.js';
test('worker uses verified modules in order, bounds outstanding frames, and releases on abort',async()=>{
 const names=['Worker','OffscreenCanvas','__KEEL_TRAILER_RENDER_WORKER_SOURCE__','KEEL_TRAILER_SCENE'],saved=new Map(names.map(n=>[n,globalThis[n]]));
 let instance;
 class MockWorker{constructor(){instance=this;this.sent=[];}postMessage(m){this.sent.push(m);if(m.type==='init')queueMicrotask(()=>this.onmessage({data:{id:m.id,type:'ready'}}));}terminate(){this.terminated=true;}}
 try{globalThis.Worker=MockWorker;globalThis.OffscreenCanvas=class{};globalThis.__KEEL_TRAILER_RENDER_WORKER_SOURCE__='';globalThis.KEEL_TRAILER_SCENE={supportsWorkerExport:true};
  const accessed=[],content={resources:()=>[{id:'trailer.module-runtime',role:'module'},{id:'trailer.tone',role:'module'},{id:'engine.capture.offline',role:'module'},{id:'trailer.adapter',role:'asset'}],bytes(id){accessed.push(id);return new TextEncoder().encode(';');}};
  const abort=new AbortController(),scene=await createWorkerScene({program:{fps:60},content,signal:abort.signal});assert.deepEqual(accessed,['trailer.module-runtime','trailer.adapter']);
  const first=scene.frame(0);await assert.rejects(scene.frame(1),/Concurrent/);let close=0;const request=instance.sent.at(-1);instance.onmessage({data:{id:request.id,bitmap:{close(){close++;}}}});assert((await first).bitmap);
  const second=scene.frame(1);abort.abort();await assert.rejects(second,{name:'AbortError'});assert(instance.terminated);
  instance.onmessage({data:{id:instance.sent.at(-1).id,bitmap:{close(){close++;}}}});assert.equal(close,1);scene.dispose();
 }finally{for(const[n,v]of saved)v===undefined?delete globalThis[n]:globalThis[n]=v;}
});
