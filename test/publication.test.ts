import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,copyFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runTrailerTool} from '../dist/index.js';
import {prepareTrailerPublication} from '../dist/publication.js';
const engineRoot=process.env.KEEL_ENGINE_ROOT,sdkRoot=process.env.KEEL_SDK_ROOT;
test('public bindings cannot bypass the core MCP publication workflow',async()=>{
 for(const input of [{},{localProof:false},{localProof:true,target:{chainId:11155111,store:'0x'+'1'.repeat(40),objectIds:{}}}]){
  await assert.rejects(()=>prepareTrailerPublication({bundleDir:'/does-not-exist',outDir:'/does-not-exist',...input}),error=>error.code==='KEEL_PUBLICATION_REUSE_REQUIRED'&&/keel-inline-reuse-plan/.test(error.message)&&/keel-inline-publication-check/.test(error.message));
 }
});
test('local proof follows the SDK defaults and assembles exact full tokenURI',{skip:!engineRoot||!sdkRoot},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'trailer-copy-'));try{
  const project=JSON.parse(await readFile(new URL('../examples/onchain/project.json',import.meta.url),'utf8'));project.adapterPath='scene.ts';await copyFile(new URL('../examples/onchain/scene.ts',import.meta.url),path.join(root,'scene.ts'));
  await runTrailerTool('trailer-onchain',{project,engineRoot,sdkRoot,outDir:'bundle'},{workspaceRoot:root});
  await assert.rejects(()=>runTrailerTool('trailer-onchain-prepare',{bundleDir:'bundle',outDir:'missing',sdkRoot},{workspaceRoot:root}),/localProof/);
  const p=await runTrailerTool('trailer-onchain-prepare',{bundleDir:'bundle',outDir:'prepared',sdkRoot,localProof:true},{workspaceRoot:root});assert.equal(p.status,'local-proof-only');assert.equal(p.bindingAuthentication,'fictional-local-test-bindings');assert.equal(p.transport,'uri81-block-v1');assert.ok(p.bytes.completeTokenURI<2000000);assert.equal(p.uploadPlan,null);assert.deepEqual(p.objectWrites,[]);
  const uri=await readFile(p.tokenURIPath,'utf8'),parts=await Promise.all(p.orderedTokenURIParts.map(file=>readFile(path.join(root,'prepared',file),'utf8')));assert.equal(parts.join(''),uri);
  const meta=JSON.parse(await(await fetch(uri)).text()),html=await(await fetch(meta.animation_url)).text();assert.match(html,/__KEEL_PREPARED_DENSE_PACKS__/);assert.match(html,/storedDense/);assert.doesNotMatch(html,/storedBase64/);
  assert.equal(p.signing,'not-performed');assert.equal(p.submission,'not-performed');
 }finally{await rm(root,{recursive:true,force:true});}
});
