import test from 'node:test';import assert from 'node:assert/strict';
import {auditTrailerAdapterBoundary,assertTrailerDataOnlyUpload}from'../dist/dependency-boundary.js';
const root='/creator',dir='/build';
const audit=inputs=>auditTrailerAdapterBoundary({workspaceRoot:root,workingDirectory:dir,metafile:{inputs:Object.fromEntries(Object.keys(inputs).map(p=>[p,{}])),outputs:{'adapter.js':{inputs:Object.fromEntries(Object.entries(inputs).map(([p,bytesInOutput])=>[p,{bytesInOutput}]))}}}});
test('transitive private game imports remain shared even inside a trailer named adapter',()=>{
 const x=audit({'../creator/scene.ts':1800,'../keel-games/redline/web/grid.ts':300000,'engine-api:keel/bake':60,'../keel-engine/codec.ts':20000});
 assert.equal(x.status,'blocked-shared-source-in-adapter');assert.equal(x.creatorSourceBytes,1800);assert.equal(x.inlinedSharedSourceBytes,320000);assert.deepEqual(x.linkedEngineModules,['keel/bake']);assert.equal(x.uploadPlan,null);
});
test('linked engine imports produce no new engine source bytes and cannot claim publication',()=>{
 const x=audit({'../creator/scene.ts':2000,'engine-api:keel/bake':50,'../keel-games/unused.ts':0});
 assert.equal(x.inlinedSharedSourceBytes,0);assert.equal(x.publicationReady,false);assert.equal(x.status,'requires-authenticated-module-reuse');
});
test('installed libraries inside the creator workspace remain shared dependencies',()=>{
 const x=audit({'../creator/scene.ts':1000,'../creator/node_modules/keel-grid/index.js':250000});
 assert.equal(x.creatorSourceBytes,1000);assert.equal(x.inlinedSharedSourceBytes,250000);assert.equal(x.status,'blocked-shared-source-in-adapter');
});
const resources=[{id:'trailer.scene',role:'asset',mediaType:'application/octet-stream',byteLength:104},{id:'trailer.music',role:'asset',mediaType:'application/octet-stream',byteLength:15},...['trailer.adapter','trailer.player','trailer.tone','engine.keel.capture','trailer.mp4'].map(id=>({id,role:'module',mediaType:'text/javascript',byteLength:999999}))];
test('data-only plan rejects shared runtimes and videos rather than confusing full URI size with new bytes',()=>{
 const manifest={resources,adapterBoundary:audit({'../creator/scene.ts':2000,'engine-api:keel/bake':50})};
 assert.equal(assertTrailerDataOnlyUpload(manifest,['trailer.scene','trailer.music']).sourceBytes,119);
 for(const r of resources.slice(2))assert.throws(()=>assertTrailerDataOnlyUpload(manifest,['trailer.scene',r.id]),e=>e.code==='KEEL_TRAILER_SHARED_UPLOAD_BLOCKED');
});
test('tiny scene data does not make an unlinked game adapter publishable',()=>{
 assert.throws(()=>assertTrailerDataOnlyUpload({resources},['trailer.scene']),e=>e.code==='KEEL_TRAILER_BOUNDARY_REQUIRED');
 assert.throws(()=>assertTrailerDataOnlyUpload({resources,adapterBoundary:audit({'../keel-games/grid.ts':300000})},['trailer.scene','trailer.music']),e=>e.code==='KEEL_TRAILER_SHARED_SOURCE_IN_ADAPTER');
});
