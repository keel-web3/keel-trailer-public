import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,mkdir,copyFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runTrailerTool,compileTrailerProject,verifyTrailerBundle} from '../dist/index.js';
const root=process.env.KEEL_ENGINE_ROOT,sdk=process.env.KEEL_SDK_ROOT;
test('MCP/SDK compile separate pinned modules and assets, reject unknown modules and altered bytes',{skip:!root||!sdk},async()=>{
 const workspace=await mkdtemp(path.join(os.tmpdir(),'trailer-program-'));try{
  await copyFile(new URL('../examples/onchain/scene.ts',import.meta.url),path.join(workspace,'scene.ts'));
  const project=JSON.parse(await readFile(new URL('../examples/onchain/project.json',import.meta.url),'utf8'));project.adapterPath='scene.ts';
  const result=await runTrailerTool('trailer-onchain',{project,engineRoot:root,sdkRoot:sdk,outDir:'out'},{workspaceRoot:workspace});
  assert.equal(result.schema,'keel-trailer-bundle@1');assert.equal(result.bytes.program,59);assert.ok(result.previews.some(p=>p.path==='verified-preview.html'));assert.ok(result.resources.some(r=>r.id==='trailer.music'));
  const manifest=await verifyTrailerBundle(path.join(workspace,'out'));assert.equal(manifest.publication.status,'not-published');
  assert.equal(manifest.bytes.previewSource,manifest.bytes.source);assert.equal(manifest.bytes.previewStored,manifest.bytes.stored);
  assert.equal(manifest.publication.newStoredBytes,null);assert.equal(manifest.publication.reusedStoredBytes,null);assert.ok(manifest.publication.blockedReason);
  const prepare=JSON.parse(await readFile(result.preparePath));assert.equal(prepare.localProof,true);assert.equal(prepare.bundleDir,'out');
  const bad=structuredClone(project);bad.modules=['keel/not-real'];await assert.rejects(()=>compileTrailerProject(bad,{workspaceRoot:workspace,engineRoot:root,sdkRoot:sdk,outDir:path.join(workspace,'bad')}),/Unknown engine/);
  await assert.rejects(()=>runTrailerTool('trailer-onchain',{project,engineRoot:root,sdkRoot:sdk,outDir:'../escape'},{workspaceRoot:workspace}),/inside/);
  await writeFile(path.join(workspace,'out/resources/trailer.scene.bin'),'tampered');await assert.rejects(()=>verifyTrailerBundle(path.join(workspace,'out')),/digest mismatch/);
 }finally{await rm(workspace,{recursive:true,force:true});}
});
test('MCP music pack works without video rendering',{skip:!root},async()=>{
 const workspace=await mkdtemp(path.join(os.tmpdir(),'trailer-music-'));try{const r=await runTrailerTool('trailer-music',{recipe:{from:'game',seed:42,spec:{energy:.8,tempo:120}},engineRoot:root,outDir:'music'},{workspaceRoot:workspace});assert.equal(r.mode,'recipe');assert.ok(r.bytes<100);assert.equal(r.auditionRequired,true);assert.ok((await readFile(r.musicPath)).length===r.bytes);}finally{await rm(workspace,{recursive:true,force:true});}
});
