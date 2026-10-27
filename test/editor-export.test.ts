import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,cp,rename,unlink,symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import vm from 'node:vm';
import {runTrailerTool} from '../dist/index.js';
const python=process.env.TRAILER_PYTHON??'python3';
const pkg=new URL('../',import.meta.url).pathname;
function command(binary,args){const r=spawnSync(binary,args,{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout;}
const json=p=>readFile(p,'utf8').then(JSON.parse);
async function importer(){const source=await readFile(path.join(pkg,'editor/import-after-effects.jsx'),'utf8');const context=vm.createContext({});vm.runInContext(source,context);return context;}
function parsed(ctx,m){return ctx.KEELParseJSON(JSON.stringify(m));}
test('editor export relocates, preserves checkpoint and exact frames/alpha/audio, rejects missing/unsafe/tampered media',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'keel-editor-'));
 try {
  command(python,[path.join(pkg,'examples/editor/make-sample.py'),path.join(root,'inputs')]);
  const options={workspaceRoot:root,python,allowOffload:false};
  const request={timelinePath:'inputs/timeline.json',outDir:'export',attributionPaths:['inputs/ATTRIBUTION.md'],startTimecodeFrame:43200};
  const original=await readFile(path.join(root,'inputs/timeline.json'));
  const result=await runTrailerTool('trailer-export',request,options);assert.equal(result.validation.passed,true);assert.equal(result.durationFrames,26);
  assert.deepEqual(await readFile(path.join(root,'inputs/timeline.json')),original);
  assert.deepEqual(await readFile(path.join(root,'export/source-checkpoint.json')),original);
  await runTrailerTool('trailer-export',{...request,outDir:'repeat'},options);
  assert.deepEqual(await json(path.join(root,'export/manifest.json')),await json(path.join(root,'repeat/manifest.json')));
  if(process.env.TRAILER_TEST_OTIO_PYTHON)command(process.env.TRAILER_TEST_OTIO_PYTHON,[path.join(pkg,'test/validate-editor-otio.py'),path.join(root,'export')]);
  const m=await json(path.join(root,'export/manifest.json'));assert.equal(m.startTimecode,'01:00:00:00');
  assert.deepEqual(m.compositions[0].layers.filter(l=>l.z===0).map(l=>[l.startFrame,l.endFrame]),[[0,11],[11,21],[21,26]]);
  assert.equal(m.compositions[0].layers[1].alpha,true);assert.equal(m.compositions[0].layers[2].name,'baked-dither / composite');
  assert.equal(m.audio[0].samples,104000);assert.ok(m.sources.some(s=>s.category==='attribution'));
  const encoded=await readFile(path.join(root,'export/manifest.json'),'utf8');assert.ok(!encoded.includes(root));
  // Independent renderer frame replay, exact PNG alpha decode, float stems and source sample placement.
  command(python,['-c',String.raw`
import sys,json,hashlib,numpy as np
from pathlib import Path
sys.path.insert(0,sys.argv[1]+'/python')
from renderer import compositor
from common import audio_mix,run,SR
from PIL import Image
r=Path(sys.argv[2]);m=json.loads((r/'export/manifest.json').read_text());t=json.loads((r/'inputs/timeline.json').read_text())
for s in t['sources']:s['path']=str(r/'inputs'/s['path'])
for s in t['shots']:
 for key in ('text','caption'):
  if key in s:s[key]['font']=str(r/'inputs'/s[key]['font'])
t['audio'][0]['in']=.25
for c,target in zip(m['compositions'],t['targets']):
 comp=compositor(t,target);h=hashlib.sha256()
 for frame in range(m['durationFrames']):h.update(comp.draw(frame/t['fps']).tobytes())
 assert h.hexdigest()==c['exactRgbSha256']
l=m['compositions'][0]['layers'][1];p=r/'export'/l['movie']
b=run(['ffmpeg','-v','error','-i',str(p),'-f','rawvideo','-pix_fmt','rgba','-']).stdout
pixels=np.frombuffer(b,np.uint8).reshape(-1,90,160,4)
assert set(np.unique(pixels[:,:,:,3]))=={0,255}
for f in range(len(pixels)):
 im=np.array(Image.open(r/'export'/Path(l['sequence']).parent/f'{f:06}.png'))
 assert np.array_equal(pixels[f,:,:,3],im[:,:,3])
stems=[]
for layer in m['audio']:
 b=run(['ffmpeg','-v','error','-i',str(r/'export'/layer['path']),'-f','f32le','-']).stdout
 stems.append(np.frombuffer(b,'<f4').reshape(-1,2))
expected=audio_mix(t,None,return_samples=True)[:m['audio'][0]['samples']]
assert np.allclose(sum(stems),expected,atol=1e-7)
start=round(.413*1.3*SR);assert np.count_nonzero(stems[1][:start])==0;assert np.count_nonzero(stems[1][start:])>0
`,pkg,root]);
  // Move entire package, remove all originals: collected KEEL timeline replays independently.
  await rename(path.join(root,'export'),path.join(root,'moved package'));
  await rm(path.join(root,'inputs'),{recursive:true});
  const validate=()=>runTrailerTool('trailer-export-validate',{packageDir:'moved package'},options);
  assert.equal((await validate()).passed,true);
  const still=await runTrailerTool('trailer-stills',{timelinePath:'moved package/timeline.json',outDir:'stills',times:[.5],targets:['wide']},{...options,checkMachineLoad:false});assert.equal(still.stills[0].frame,6);
  command(python,[path.join(root,'moved package/relocate.py')]);
  const local=await readFile(path.join(root,'moved package/timeline-00-local.xml'),'utf8');assert.ok(local.includes('moved%20package'));assert.ok(!local.includes('__KEEL_PACKAGE__'));
  const ctx=await importer();let count=0;ctx.KEELValidate(parsed(ctx,m),p=>{assert.ok(p);count++;});assert.equal(count,84+2);
  const media=path.join(root,'moved package',m.compositions[0].layers[0].sequence);const saved=await readFile(media);
  await unlink(media);await assert.rejects(validate,/Missing media/);await writeFile(media,saved);
  await symlink('/etc/hosts',path.join(root,'moved package/escape.png'));
  const altered=structuredClone(m);altered.files.push({path:'escape.png',bytes:1,sha256:'0'.repeat(64)});
  const manifest=path.join(root,'moved package/manifest.json');await writeFile(manifest,JSON.stringify(altered));await assert.rejects(validate,/symlink/);
  altered.files.at(-1).path='../outside.png';await writeFile(manifest,JSON.stringify(altered));await assert.rejects(validate,/Invalid package path/);
  await unlink(path.join(root,'moved package/escape.png'));
  const wrongOrder=structuredClone(m);wrongOrder.compositions[0].layers[1].z=0;
  await writeFile(manifest,JSON.stringify(wrongOrder));await assert.rejects(validate,/Base layer gap\/overlap/);
  const wrongAudio=structuredClone(m);wrongAudio.audio[0].startFrame=1;
  await writeFile(manifest,JSON.stringify(wrongAudio));await assert.rejects(validate,/Audio sync mismatch/);
  await writeFile(manifest,JSON.stringify(m));await writeFile(media,'tampered');await assert.rejects(validate,/Hash mismatch/);await writeFile(media,saved);
  await assert.rejects(()=>runTrailerTool('trailer-export',{timelinePath:'moved package/timeline.json',outDir:'moved package'},options),/empty output directory/);
  const bad=await json(path.join(root,'moved package/timeline.json'));bad.sources[0].path='missing.png';await assert.rejects(()=>runTrailerTool('trailer-export',{timeline:bad,outDir:'bad'},options),/ENOENT/);
 } finally {await rm(root,{recursive:true,force:true});}
});
test('AE strict data parser blocks executable content and preflight validates ranges/order before app changes',async()=>{
 const ctx=await importer();assert.equal(ctx.KEELParseJSON('{"name":"\\u003c/script\\u003e; alert(1)","n":-1.25e2}').n,-125);
 for(const s of ['({x:1})','{"x":1};system.callSystem("bad")','{"__proto__":{}}','{"x":1,"x":2}','[1,]','{"x":NaN}','01','"\n"'])assert.throws(()=>ctx.KEELParseJSON(s));
 for(const p of ['../file.png','/tmp/file.png','a//b','a/./b','a\\b','https://a/x','a/%2e%2e/b','C:/a','a\n.png'])assert.throws(()=>ctx.KEELRelativePath(p));
 const m={format:'keel-editor-package',version:1,name:'safe',fps:12,frameRate:{numerator:12,denominator:1},durationFrames:2,startTimecodeFrame:0,dropFrame:false,pixelAspect:1,audio:[],compositions:[{name:'c',width:160,height:90,layers:[{name:'base',z:0,alpha:false,sequence:'passes/a/000000.png',startFrame:0,endFrame:2},{name:'title',z:1,alpha:true,sequence:'passes/b/000000.png',startFrame:0,endFrame:2}]}]};
 assert.throws(()=>ctx.KEELValidate(parsed(ctx,m),()=>{throw Error('Missing media');}),/Missing media/);
 const bad=structuredClone(m);bad.compositions[0].layers[1].z=0;assert.throws(()=>ctx.KEELValidate(parsed(ctx,bad),()=>{}),/overlap/);
 bad.compositions[0].layers[1].z=1;bad.compositions[0].layers[0].endFrame=1;assert.throws(()=>ctx.KEELValidate(parsed(ctx,bad),()=>{}),/gap/);
 // Host mock verifies AE add-at-top behavior, start/out seconds, fps, explicit alpha and transforms.
 const calls=[];const comps=[];
 ctx.File=function(p){this.exists=true;this.alias=false;this.path=p;};ctx.Folder=function(){this.exists=true;this.alias=false;};ctx.ImportOptions=function(f){this.file=f;};ctx.AlphaMode={STRAIGHT:'straight',IGNORE:'ignore'};
 ctx.app={
  beginUndoGroup(){calls.push('begin');},endUndoGroup(){calls.push('end');},
  project:{items:{
   addFolder(){return {};},
   addComp(name,w,h,par,duration,fps){
    const layers=[];
    const c={displayStartFrame:0,createdLayers:layers,duration,fps,layers:{
     add(item){
      const property=()=>({setValue(v){calls.push(v);}});
      const l={item,property(){return {property};}};
      layers.unshift(l);return l;
     }
    }};
    comps.push(c);return c;
   }
  },importFile(options){return {options,mainSource:{}};}}
 };
 ctx.KEELImport(parsed(ctx,m),'/package');assert.equal(comps[0].fps,12);assert.equal(comps[0].duration,2/12);assert.equal(comps[0].createdLayers[0].name,'title');assert.equal(comps[0].createdLayers[0].item.mainSource.alphaMode,'straight');assert.equal(comps[0].createdLayers[1].item.mainSource.alphaMode,'ignore');assert.equal(comps[0].createdLayers[0].outPoint,2/12);assert.equal(calls[0],'begin');assert.equal(calls.at(-1),'end');
});
test('nonuniform beat grids, reverse ramps, pair layout and whole-sample rounding stay on the renderer frame clock',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'keel-editor-grid-'));
 try {
  command(python,[path.join(pkg,'examples/editor/make-sample.py'),root]);
  command(python,['-c',String.raw`
import sys,numpy as np
sys.path.insert(0,sys.argv[1]+'/python')
from common import run
from pathlib import Path
frames=np.zeros((12,8,8,3),np.uint8)
for f in range(12):frames[f,:,:]=[f*20,255-f*20,f*10]
run(['ffmpeg','-v','error','-y','-f','rawvideo','-pix_fmt','rgb24','-s','8x8','-r','24','-i','-','-c:v','ffv1',str(Path(sys.argv[2])/'ramp.mkv')],input=frames.tobytes())
`,pkg,root]);
  const t=await json(path.join(root,'timeline.json'));t.fps=29;t.targets=t.targets.slice(0,1);t.tempo={beats:[.2,.35,.67,.8]};t.audio=[];
  t.sources.push({id:'ramp',kind:'video',path:'ramp.mkv',fps:24,pixelArt:true});
  t.shots=[{id:'reverse',kind:'video',source:'ramp',startBeat:0,beats:1.4,ramp:[{beat:0,frame:11},{beat:1.4,frame:0}]},
   {id:'pair',kind:'pair',source:'a',secondSource:'b',startBeat:1.4,beats:1.1},
   {id:'hold',kind:'video',source:'ramp',startBeat:2.5,beats:.3,holdFrame:4}];
  const result=await runTrailerTool('trailer-export',{timeline:t,outDir:'export'},{workspaceRoot:root,python});assert.equal(result.durationFrames,17);
  const m=await json(path.join(root,'export/manifest.json'));assert.deepEqual(m.compositions[0].layers.map(l=>[l.startFrame,l.endFrame]),[[0,9],[9,16],[16,17]]);
  const readPixel=p=>command(python,['-c','from PIL import Image;import sys,json;print(json.dumps(list(Image.open(sys.argv[1]).getpixel((80,45)))))',p]);
  assert.deepEqual(JSON.parse(readPixel(path.join(root,'export',m.compositions[0].layers[0].sequence))),[220,35,110,255]);
  assert.deepEqual(JSON.parse(readPixel(path.join(root,'export',m.compositions[0].layers[2].sequence))),[80,175,40,255]);
 } finally {await rm(root,{recursive:true,force:true});}
});
