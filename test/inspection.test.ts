import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createInspectionProbe,assertInspection,queryInspection,runTrailerTool} from '../dist/index.js';
const python=process.env.TRAILER_PYTHON??'python3';
function fixture(){const p=createInspectionProbe();p.register('tetra','mesh',()=>({positions:new Float32Array([0,0,0,2,0,0,0,2,0,0,0,2]),indices:new Uint32Array([0,2,1,0,1,3,0,3,2,1,2,3]),attrs:new Float32Array(16).fill(.25)}));p.register('roads','graph',()=>({nodes:[{id:'a',x:0,z:0},{id:'b',x:2,z:0},{id:'c',x:0,z:2},{id:'d',x:5,z:5}],edges:[{id:0,a:'a',b:'b'},{id:1,a:'b',b:'c'},{id:2,a:'c',b:'a'}]}));p.register('terrain','grid',()=>({width:2,depth:2,height:new Int16Array([-1,0,2,5]),type:new Uint8Array([1,1,2,3])}));p.register('system','state',()=>({tick:30,payload:'</script><script>globalThis.compromised=true</script>'}));return p.snapshot({frame:30,seconds:1});}
test('inspection probe preserves typed buffers and validates graph/mesh/grid integrity and code queries',()=>{
 const s=fixture();assertInspection(s);assert.equal(s.meshes[0].attributes.attrs[0],.25);assert.deepEqual(s.grids[0].channels.height,[-1,0,2,5]);
 assert.deepEqual(queryInspection(s,{pointer:'/meshes/0/positions',start:3,count:3}).values,[2,0,0]);
 assert.throws(()=>queryInspection(s,{pointer:'/state/constructor'}),/Unknown/);
 for(const mutate of [x=>x.meshes[0].indices[0]=999,x=>x.grids[0].channels.height.pop(),x=>x.graphs[0].edges[0].to='missing',x=>x.state.system.tick=NaN]){const x=structuredClone(s);mutate(x);assert.throws(()=>assertInspection(x));}
 const p=createInspectionProbe();p.register('x','state',()=>({f(){}}));assert.throws(()=>p.snapshot(),/JSON data/);
});
test('inspection report and offline viewer bind topology, statistics, raw exports and interactive selections',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'keel-inspection-'));let browser;
 try{const snapshot=fixture(),opts={workspaceRoot:root,python};const r=await runTrailerTool('trailer-inspect',{snapshot,outDir:'one',queries:[{pointer:'/grids/0/channels/height',start:1,count:2}]},opts);
 const repeat=await runTrailerTool('trailer-inspect',{snapshot,outDir:'two'},opts);
 assert.deepEqual(JSON.parse(await readFile(r.snapshotPath,'utf8')),snapshot);assert.deepEqual(r.views.map(v=>v.sha256),repeat.views.map(v=>v.sha256));
 const mesh=r.summaries.meshes[0];assert.equal(mesh.indexedBoundaryEdges,0);assert.equal(mesh.indexedNonManifoldEdges,0);assert.equal(mesh.triangles,4);assert.ok(Math.abs(mesh.surfaceArea-(6+2*Math.sqrt(3)))<1e-10);
 assert.equal(r.summaries.graphs[0].weakComponents.length,2);assert.equal(r.summaries.graphs[0].undirectedCycleRank,1);assert.deepEqual(r.summaries.graphs[0].isolatedNodes,['d']);assert.equal(r.summaries.grids[0].channels.height.mean,1.5);assert.deepEqual(r.queries[0].values,[0,2]);
 assert.match(await readFile(path.join(root,'one','mesh-tetra-vertices.csv'),'utf8'),/1,2,0,0/);
 const {chromium}=await import('playwright');browser=await chromium.launch({args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});const page=await browser.newPage({viewport:{width:1200,height:850}});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(pathToFileURL(r.viewer).href);
 assert.equal(await page.evaluate(()=>globalThis.compromised),undefined);assert.match(await page.locator('#summary').textContent(),/"triangles": 4/);
 await page.locator('#pointer').fill('/meshes/0/positions');await page.locator('#start').fill('3');await page.locator('#count').fill('3');await page.locator('#query').click();assert.deepEqual(JSON.parse(await page.locator('#code').textContent()).values,[2,0,0]);
 await page.locator('#object').selectOption('1');assert.match(await page.locator('#summary').textContent(),/isolatedNodes/);assert.equal(await page.locator('#pointer').inputValue(),'/graphs/0');
 await page.locator('#object').selectOption('2');await page.locator('#channel').selectOption('height');const rect=await page.locator('#canvas').boundingBox();await page.mouse.move(rect.x+rect.width*.7,rect.y+rect.height*.7);assert.match(await page.locator('#detail').textContent(),/"values"/);assert.match(await page.locator('#pointer').inputValue(),/^\/grids\/0\/channels\/height\//);
 assert.deepEqual(errors,[]);await assert.rejects(()=>runTrailerTool('trailer-inspect',{snapshot,outDir:'bad',queries:[{pointer:'/missing'}]},opts),/Unknown/);
 }finally{await browser?.close();await rm(root,{recursive:true,force:true});}
});
test('snapshots and lossless frame-bounded clips retain odd-pixel crops and integer-scaled RGB exactly',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'keel-snapshot-'));try{
 const make=spawnSync(python,[fileURLToPath(new URL('make-inspection-fixture.py',import.meta.url)),root],{encoding:'utf8'});assert.equal(make.status,0,make.stderr);const opts={workspaceRoot:root,python},crop={x:1,y:1,width:3,height:4};
 const views=[{id:'full'},{id:'detail',crop,scale:3}],r=await runTrailerTool('trailer-snapshot',{mediaPath:'source.mkv',frames:[2,6],views,pixelData:true,outDir:'snaps'},opts);assert.equal(r.stills.length,4);
 const source=await readFile(path.join(root,'frames.rgb'));const expected=[];for(let f=2;f<7;f++)for(let y=1;y<5;y++)for(let yy=0;yy<3;yy++)for(let x=1;x<4;x++)for(let xx=0;xx<3;xx++){const at=(f*16*8+y*16+x)*3;expected.push(...source.subarray(at,at+3));}
 const detail=r.stills.find(x=>x.frame===2&&x.view==='detail');assert.deepEqual(await readFile(detail.pixels.path),Buffer.from(expected.slice(0,9*12*3)));assert.equal(detail.scale,3);
 const clip=await runTrailerTool('trailer-clip',{mediaPath:'source.mkv',startFrame:2,endFrame:7,crop,scale:3,outDir:'clip'},opts);assert.equal(clip.frames,5);assert.equal(clip.width,9);assert.equal(clip.height,12);assert.equal(clip.audioIncluded,true);assert.ok(clip.previewPath);
 const audio=spawnSync('ffmpeg',['-v','error','-i',clip.path,'-vn','-f','s16le','-ac','2','-ar','48000','-']);assert.equal(audio.status,0,audio.stderr.toString());assert.equal(audio.stdout.length,5*4000*4);for(let i=0;i<5*4000;i++)assert.equal(audio.stdout.readInt16LE(i*4),(2+Math.floor(i/4000))*1000);
 const decoded=spawnSync('ffmpeg',['-v','error','-i',clip.path,'-f','rawvideo','-pix_fmt','rgb24','-']);assert.equal(decoded.status,0,decoded.stderr.toString());assert.deepEqual(decoded.stdout,Buffer.from(expected));
 const second=await runTrailerTool('trailer-snapshot',{mediaPath:'source.mkv',frames:[2],views:[{id:'detail',crop,scale:3}],outDir:'repeat'},opts);assert.equal(detail.sha256,second.stills[0].sha256);
 await assert.rejects(()=>runTrailerTool('trailer-snapshot',{mediaPath:'source.mkv',frames:[12],outDir:'bad'},opts),/outside/);await assert.rejects(()=>runTrailerTool('trailer-clip',{mediaPath:'source.mkv',startFrame:2,endFrame:2,outDir:'bad'},opts),/startFrame/);
 }finally{await rm(root,{recursive:true,force:true});}
});
