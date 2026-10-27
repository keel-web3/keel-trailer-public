import test from 'node:test';import assert from 'node:assert/strict';
import {reviewTrailerSharedSourceReuse} from '../dist/reuse-review.js';
const hash='a'.repeat(64);
const fixture=()=>({boundary:{schema:'keel-trailer-adapter-boundary@1',creatorSourceBytes:17000,inlinedSharedSourceBytes:700000,inlinedSharedSources:[{path:'/game/src/grid.ts',byteLength:500000},{path:'/game/src/traffic.ts',byteLength:200000}]},reference:{chainId:11155111,modules:[{id:'game.traffic',integrity:{digest:'0x'+hash,byteLength:300}}]},sourceManifest:{resources:[{id:'game.traffic',sha256:hash,bytes:300,sources:['game/src/traffic.ts'],exports:['createGridScene']}]},sourceRoots:[{path:'/game',prefix:'game'}]});
test('names cannot fill absent source bindings or claim source-version compatibility',()=>{
 const r=reviewTrailerSharedSourceReuse(fixture());
 assert.equal(r.rows[0].status,'source-not-in-selected-published-graph');assert.deepEqual(r.rows[0].providers,[]);
 assert.equal(r.rows[1].status,'coverage-only-source-version-unverified');assert.equal(r.bytes.sourceOutsideSelectedGraph,500000);
 assert.equal(r.bytes.inlinedSharedSource,700000);assert.equal(r.publicationReady,false);assert.equal(r.uploadPlan,null);assert.equal(r.chainWrites,0);
});
test('source manifests must match actual decoded resource digest and length',()=>{
 for(const change of [x=>x.sourceManifest.resources[0].sha256='b'.repeat(64),x=>x.sourceManifest.resources[0].bytes++]){const x=fixture();change(x);assert.throws(()=>reviewTrailerSharedSourceReuse(x),/no exact byte-matched/);}
});
test('root mapping rejects prefix collisions and uses the most specific mapping',()=>{
 const x=fixture();x.boundary.inlinedSharedSources=[{path:'/game2/src/traffic.ts',byteLength:1},{path:'/game/src/traffic.ts',byteLength:1}];x.sourceRoots.push({path:'/game/src',prefix:'game/src'});
 const r=reviewTrailerSharedSourceReuse(x);assert.equal(r.rows[0].source,null);assert.equal(r.rows[0].status,'unmapped-source-root');assert.equal(r.rows[1].source,'game/src/traffic.ts');
});
test('duplicate graph identities and invalid evidence fail closed',()=>{
 const x=fixture();x.reference.modules.push(x.reference.modules[0]);assert.throws(()=>reviewTrailerSharedSourceReuse(x),/Duplicate/);
 assert.throws(()=>reviewTrailerSharedSourceReuse({...fixture(),boundary:{}}),/source-boundary/);
});
