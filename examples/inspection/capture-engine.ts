// Run with Node's TypeScript stripping enabled; consume canonical engine APIs.
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createInspectionProbe} from '../../dist/probe.js';
const engine=path.resolve(process.argv[2]??'../keel-engine'),out=path.resolve(process.argv[3]??'packages/trailer/artifacts/inspection-example');
const load=p=>import(pathToFileURL(path.join(engine,p)).href);
const {lookMesh}=await load('packages/bake/src/mesh.ts'),{roadGraph}=await load('packages/road/src/graph.ts'),{pathThrough}=await load('packages/road/src/path.ts'),{createTerrain}=await load('packages/terrain/src/grid.ts');
const mesh=lookMesh({boxes:[{c:[0,1,0],h:[1,1,.5],mat:2}],capsules:[{a:[-1,0,0],b:[1,0,0],r:.2,mat:1}]});
const graph=roadGraph([{id:0,x:0,z:0},{id:1,x:12,z:8},{id:2,x:-8,z:10}], [{a:0,b:1,cls:'street',path:pathThrough([0,5,12],[0,9,8])},{a:1,b:2,cls:'alley',path:pathThrough([12,2,-8],[8,15,10])}]);
const grid=createTerrain({width:8,depth:6,id:'test'});for(let y=0;y<6;y++)for(let x=0;x<8;x++)grid.setHeight(x,y,x-y);
const probe=createInspectionProbe();probe.register('look','mesh',()=>mesh);probe.register('roads','graph',()=>graph);probe.register('terrain','grid',()=>grid);probe.register('system','state',()=>({seed:7,tick:30,mode:'inspection',source:'canonical KEEL engine objects'}));
const files=['packages/bake/src/mesh.ts','packages/road/src/graph.ts','packages/road/src/path.ts','packages/terrain/src/grid.ts'];const sources=[];for(const p of files)sources.push({path:p,sha256:createHash('sha256').update(await readFile(path.join(engine,p))).digest('hex')});
await mkdir(out,{recursive:true});await writeFile(path.join(out,'snapshot.json'),JSON.stringify(probe.snapshot({frame:30,seconds:1,metadata:{sources,coordinates:'local mesh; world road/terrain'}}),null,2)+'\n');
console.log(JSON.stringify({snapshotPath:path.join(out,'snapshot.json'),vertices:mesh.positions.length/3,triangles:mesh.indices.length/3}));
