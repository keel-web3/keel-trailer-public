/** Check the packed distribution independently of checkout imports/dependencies. */
import {mkdtempSync,mkdirSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const archive=path.resolve(process.argv[2]??'artifacts/package/keel-trailer-0.2.0.tgz');
const root=mkdtempSync(path.join(tmpdir(),'keel-trailer-package-'));
function run(command:string,args:string[]){const r=spawnSync(command,args,{cwd:root,encoding:'utf8'});assert.equal(r.status,0,r.stderr||r.stdout);return r.stdout;}
try {
  const paths=run('tar',['-tzf',archive]).trim().split('\n');
  assert(paths.some(p=>p==='package/dist/mcp.js'));assert(paths.some(p=>p==='package/dist/index.d.ts'));
  for(const p of paths)assert(!/(^|\/)(reviews|captures|node_modules)(\/|$)|\.(zip|wav|mkv)$/i.test(p),p);
  const movies=paths.filter(p=>p.endsWith('.mp4'));assert.equal(movies.length,2);assert(movies.every(p=>p.startsWith('package/examples/basic/test-')));
  run('tar',['-xzf',archive]);
  const descriptors=JSON.parse(run(process.execPath,[path.join(root,'package/dist/cli.js'),'tools']));assert.equal(Object.keys(descriptors).length,23);
  const pkg=JSON.parse(readFileSync(path.join(root,'package/package.json'),'utf8'));assert.equal(pkg.private,false);assert.equal(pkg.types,'./dist/index.d.ts');
  mkdirSync(path.join(root,'node_modules/@keel'),{recursive:true});symlinkSync(path.join(root,'package'),path.join(root,'node_modules/@keel/trailer'),'dir');
  writeFileSync(path.join(root,'package.json'),'{"type":"module"}');
  const consumer=readFileSync(new URL('../test/types.consumer.ts',import.meta.url),'utf8').replaceAll('../dist/index.js','@keel/trailer').replaceAll('../dist/program.js','@keel/trailer/program').replaceAll('../dist/music.js','@keel/trailer/music');
  writeFileSync(path.join(root,'consumer.ts'),consumer);
  const tsc=new URL('../node_modules/typescript/bin/tsc',import.meta.url).pathname;
  run(process.execPath,[tsc,'--noEmit','--strict','--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext','--skipLibCheck','--typeRoots',new URL('../node_modules/@types',import.meta.url).pathname,'consumer.ts']);
  console.log(JSON.stringify({passed:true,files:paths.length,tools:Object.keys(descriptors).length,syntheticClips:movies.length,consumerTypes:true}));
} finally {rmSync(root,{recursive:true,force:true});}
