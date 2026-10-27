import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,mkdir,copyFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {runTrailerTool} from '../dist/index.js';
const python=process.env.TRAILER_PYTHON??'python3';
test('web adapter captures a paused clock, scripted clicks and match-cut element rects reproducibly',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'keel-trailer-web-'));
 try{
  const probe=(await readFile(new URL('../dist/probe.js',import.meta.url),'utf8')).replaceAll('export ','').replace(/\/\/# sourceMappingURL=.*$/m,'');
  const html='<html data-mode="idle"><body><button id="button" onclick="document.documentElement.dataset.mode=\'clicked\'">GO</button><div id="box" style="width:80px;height:40px;background:#ff00ff"></div><div id="time"></div><script>setInterval(()=>document.querySelector("#time").textContent=Date.now(),50)</script><script>'+probe+';window.__KEEL_INSPECTION__=createInspectionProbe();window.__KEEL_INSPECTION__.register("page","state",()=>({mode:document.documentElement.dataset.mode}));</script></body></html>';
  await writeFile(path.join(root,'index.html'),html);
  const capture={adapter:'web',url:pathToFileURL(path.join(root,'index.html')).href,width:320,height:240,fps:10,frames:8,readySelector:'#box',readyFrames:2,inspectionFrames:[0,3],rectSelectors:['#box'],stateAttributes:['data-mode'],steps:[{frame:3,action:'click',selector:'#button'}]};
  const opts={workspaceRoot:root,python};
  const a=await runTrailerTool('trailer-capture',{capture,outDir:'a'},opts);
  const b=await runTrailerTool('trailer-capture',{capture,outDir:'b'},opts);
  assert.equal(a.frames,8);assert.deepEqual(a.rects,b.rects);assert.equal(a.sha256,b.sha256);
  assert.ok(a.marks.some(m=>m.name==='state:clicked' && m.frame===3));
  assert.equal(a.rects[0].elements['#box'].width,80);
  assert.equal(a.inspectionFiles.length,2);assert.equal(JSON.parse(await readFile(a.inspectionFiles[1].path,'utf8')).state.page.mode,'clicked');
  assert.equal(JSON.parse(await readFile(a.inspectionFiles[1].path,'utf8')).frame,3);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('Game Boy adapter isolates saves, reads symbols and applies inputs on exact frames',{skip:!process.env.TRAILER_TEST_ROM},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'keel-trailer-gb-'));
 try{
  await copyFile(process.env.TRAILER_TEST_ROM,path.join(root,'game.gbc'));
  await writeFile(path.join(root,'game.sym'),'00:c000 _test\n');
  const capture={adapter:'gameboy',rom:'game.gbc',symbolsPath:'game.sym',frames:12,reads:[{name:'probe',symbol:'_test'}],
    events:[{frame:3,action:'write',address:49152,value:91},{frame:3,action:'mark',name:'write'},{frame:4,action:'press',button:'a'},{frame:5,action:'release',button:'a'}]};
  const a=await runTrailerTool('trailer-capture',{capture,outDir:'a'},{workspaceRoot:root,python});
  const b=await runTrailerTool('trailer-capture',{capture,outDir:'b'},{workspaceRoot:root,python});
  assert.equal(a.frames,12);assert.equal(a.pyboyVersion,'2.7.0');assert.equal(a.reads[3].values.probe,91);
  assert.equal(a.outputs[0].sha256,b.outputs[0].sha256);assert.deepEqual(a.marks,[{name:'write',frame:3,side:'host'}]);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('two-ROM link adapter exchanges real serial-interrupt bytes through declared hooks',{skip:!process.env.TRAILER_TEST_ROM},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'keel-trailer-link-'));
 try{
  const script=new URL('make-link-fixtures.py',import.meta.url);
  const built=spawnSync(python,[script.pathname,process.env.TRAILER_TEST_ROM,root],{encoding:'utf8'});assert.equal(built.status,0,built.stderr);
  const capture={adapter:'gameboy',rom:'host.gbc',guestRom:'guest.gbc',frames:600,
    link:{host:{bank:0,readHook:90,currentByte:49152},guest:{bank:0,readHook:90,currentByte:49152}},
    reads:[{name:'hostReceived',address:49153},{name:'guestReceived',side:'guest',address:49153}]};
  const result=await runTrailerTool('trailer-capture',{capture,outDir:'capture'},{workspaceRoot:root,python});
  assert.ok(result.linkExchanges>10,JSON.stringify(result));
  assert.ok(result.reads.some(r=>r.values.hostReceived===0x77));
  assert.ok(result.reads.some(r=>r.values.guestReceived===0x44));
  assert.equal(result.outputs.length,2);
 }finally{await rm(root,{recursive:true,force:true});}
});
