import {runTrailerTool, registerCaptureAdapter, createInspectionProbe, type Timeline, type ToolInputMap} from '../dist/index.js';
import {createScenePlayer, type SceneProgram} from '../dist/program.js';
import {assertScore, type SynthScore} from '../dist/music.js';
const timeline:Timeline={version:1,name:'typed',fps:12,seed:7,tempo:{bpm:120},sources:[{id:'image',kind:'image',path:'image.png'}],shots:[{id:'a',kind:'image',source:'image',startBeat:0,beats:4}],audio:[],targets:[{id:'wide',width:160,height:90}]};
const render:ToolInputMap['trailer-render']={timeline,outDir:'out',preview:true};
void runTrailerTool('trailer-render',render);
// @ts-expect-error unsupported request names must be rejected
void runTrailerTool('invented-tool',{});
// @ts-expect-error authored timeline tempo uses numeric beats per minute
const bad:Timeline={...timeline,tempo:{bpm:'fast'}};
// @ts-expect-error render requires its output directory
const invalid:ToolInputMap['trailer-render']={timeline};
registerCaptureAdapter('custom',async (capture,outDir,context)=>({path:outDir+'/capture.mkv',metadataPath:outDir+'/metadata.json',frames:1}),{type:'object',properties:{}});
const probe=createInspectionProbe();probe.register('system','state',()=>({seed:7}));probe.snapshot({frame:1,seconds:1/12});
const program:SceneProgram={version:1,seed:7,width:32,height:18,fps:12,bpm:120,ppq:96,duration:192,actions:[],cues:[]};
void program;void createScenePlayer;
const score:SynthScore={version:1,bpm:120,ppq:96,duration:96,instruments:[{wave:'sine',attack:0,decay:0,sustain:1000,release:0,gain:500}],notes:[{tick:0,duration:48,pitch:60,velocity:100,instrument:0}]};assertScore(score);
void bad;void invalid;
