/** Regenerate tool request types from the runtime-exported JSON Schemas. */
import {readFileSync,writeFileSync} from 'node:fs';
import ts from 'typescript';
import type {JsonSchema} from '../src/contracts.js';
const shared:Record<string,string>={timeline:'Timeline',snapshot:'InspectionSnapshot',capture:'CaptureRequest',project:'TrailerProject',score:'SynthScore',arrangement:'Arrangement'};
function typeOf(s:JsonSchema,key=''):string {
  if(shared[key]) return shared[key];
  if('const' in s) return JSON.stringify(s.const);
  if(s.enum) return s.enum.map(v=>JSON.stringify(v)).join(' | ');
  if(s.anyOf) return s.anyOf.map(v=>'('+typeOf(v)+')').join(' | ');
  if(s.type==='array') return '('+typeOf(s.items??{})+')[]';
  if(s.type==='object') return s.properties?'{'+Object.entries(s.properties).map(([k,v])=>JSON.stringify(k)+(s.required?.includes(k)?'':'?')+':'+typeOf(v,k)+';').join('')+'}':'Record<string,unknown>';
  if(s.type==='string') return 'string';
  if(s.type==='number'||s.type==='integer') return 'number';
  if(s.type==='boolean') return 'boolean';
  return 'unknown';
}
const schemas=JSON.parse(readFileSync(new URL('../schemas/tools.json',import.meta.url),'utf8')) as Record<string,JsonSchema>;
const source=`// Generated from schemas/tools.json by scripts/tool-types.ts. Do not edit by hand.
import type {CaptureRequest} from './contracts.js';
import type {SynthScore} from './music.js';
import type {TrailerProject} from './onchain.js';
import type {InspectionSnapshot} from './probe.js';
import type {Arrangement} from './score-render.js';
import type {Timeline} from './timeline.js';
export interface ToolInputMap {${Object.entries(schemas).map(([k,v])=>JSON.stringify(k)+':'+typeOf(v)+';').join('\n')}}
export type TrailerToolName=keyof ToolInputMap;
export type ToolRequest={[N in TrailerToolName]:{name:N;input:ToolInputMap[N]}}[TrailerToolName];
`;
writeFileSync(new URL('../src/tool-types.ts',import.meta.url),ts.createPrinter().printFile(ts.createSourceFile('tool-types.ts',source,ts.ScriptTarget.Latest,true)));
