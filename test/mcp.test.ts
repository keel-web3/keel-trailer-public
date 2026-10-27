import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const entry=process.env.KEEL_MCP_ENTRY;
const createMcpServer=entry?(await import(pathToFileURL(entry).href)).createMcpServer:undefined;
test('existing KEEL MCP exposes trailer schemas and dispatches structured plan/errors',{skip:!entry},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'keel-trailer-mcp-'));
 try{
  const server=await createMcpServer({workspaceRoot:root,pluginConfig:false,plugins:[new URL('../dist/mcp.js',import.meta.url).pathname]});
  const init=await server.handle({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'trailer-test',version:'1'}}});
  assert.match(init.result.instructions,/Public publication must start with keel-inline-reuse-plan/);
  assert.match(init.result.instructions,/configured public gas ceiling is not measured read gas/);
  await server.handle({jsonrpc:'2.0',method:'notifications/initialized'});
  const list=await server.handle({jsonrpc:'2.0',id:2,method:'tools/list',params:{}});
  const names=['trailer-onchain-reuse-review','trailer-onchain','trailer-onchain-prepare','trailer-onchain-test','trailer-onchain-live-test','trailer-onchain-render','trailer-music','trailer-audio-test','trailer-snapshot','trailer-clip','trailer-inspect','trailer-plan','trailer-capture','trailer-beats','trailer-render','trailer-verify','trailer-stills','trailer-lint','trailer-export','trailer-export-validate','trailer-footage','trailer-cue-sync','trailer-score'];
  for(const name of names){const descriptor=list.result.tools.find(t=>t.name===name);assert.ok(descriptor);assert.equal(descriptor.inputSchema.additionalProperties,false);}
  const prepare=list.result.tools.find(t=>t.name==='trailer-onchain-prepare');assert.match(prepare.description,/LOCAL PROOF ONLY/);assert.equal(prepare.inputSchema.properties.localProof.const,true);assert.equal(prepare.inputSchema.properties.target,undefined);
  const publicAttempt=await server.handle({jsonrpc:'2.0',id:6,method:'tools/call',params:{name:'trailer-onchain-prepare',arguments:{bundleDir:'bundle',outDir:'publish',target:{chainId:11155111}}}});assert.equal(publicAttempt.result.isError,true);assert.match(publicAttempt.result.content[0].text,/INVALID_SCHEMA/);
  const plan=await server.handle({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'trailer-plan',arguments:{brief:'World, play, launch',sources:[{id:'a',kind:'image',path:'a.png'}]}}});
  assert.equal(plan.result.structuredContent.timeline.version,1);assert.equal(plan.result.isError,undefined);
  if(process.env.KEEL_ENGINE_ROOT){const music=await server.handle({jsonrpc:'2.0',id:5,method:'tools/call',params:{name:'trailer-music',arguments:{recipe:{from:'game',seed:42,spec:{tempo:120}},engineRoot:process.env.KEEL_ENGINE_ROOT,outDir:'score'}}});assert.equal(music.result.isError,undefined);assert.equal(music.result.structuredContent.mode,'recipe');assert.ok(music.result.structuredContent.bytes<100);}
  const bad=await server.handle({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'trailer-render',arguments:{outDir:'out',timeline:{version:999}}}});
  assert.equal(bad.result.isError,true);assert.match(bad.result.content[0].text,/INVALID_SCHEMA/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('existing MCP dispatch exports and validates a collected editor package',{skip:!entry},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'keel-trailer-editor-mcp-'));
 try {
  const python=process.env.TRAILER_PYTHON??'python3';
  const made=spawnSync(python,[new URL('../examples/editor/make-sample.py',import.meta.url).pathname,path.join(root,'inputs')],{encoding:'utf8'});
  assert.equal(made.status,0,made.stderr);
  const server=await createMcpServer({workspaceRoot:root,pluginConfig:false,plugins:[new URL('../dist/mcp.js',import.meta.url).pathname]});
  await server.handle({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'editor-test',version:'1'}}});
  await server.handle({jsonrpc:'2.0',method:'notifications/initialized'});
  const exported=await server.handle({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'trailer-export',arguments:{timelinePath:'inputs/timeline.json',outDir:'editor'}}});
  assert.equal(exported.result.isError,undefined,JSON.stringify(exported));
  assert.equal(exported.result.structuredContent.durationFrames,26);
  assert.equal(exported.result.structuredContent.validation.passed,true);
  const validated=await server.handle({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'trailer-export-validate',arguments:{packageDir:'editor'}}});
  assert.equal(validated.result.isError,undefined);assert.equal(validated.result.structuredContent.passed,true);
 } finally {await rm(root,{recursive:true,force:true});}
});
