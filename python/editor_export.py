"""Collected, frame-based interchange. Project content is data, never code."""
import copy, json, math, shutil, re
from pathlib import Path
from fractions import Fraction
from urllib.parse import quote, unquote
import xml.etree.ElementTree as ET
import numpy as np
from PIL import Image
from common import audio_mix, edit_time, sha, run, probe, SR
from renderer import compositor, draw_text

PACKAGE_ROOT = Path(__file__).resolve().parent.parent

def write_json(p, obj):
    p.write_text(json.dumps(obj, indent=2, ensure_ascii=True, allow_nan=False)+'\n')

def boundary(t, beat):
    return math.ceil(edit_time(t['tempo'], beat)*t['fps']-1e-9)

def timecode(frame, fps):
    h, r = divmod(frame, fps*3600); m, r = divmod(r, fps*60); s, f = divmod(r, fps)
    return f'{h:02}:{m:02}:{s:02}:{f:02}'

def safe_file(root, rel):
    # Generated package paths use portable ASCII components. No URLs/percent escapes.
    if not isinstance(rel, str) or not re.fullmatch(r'[A-Za-z0-9_./-]+', rel):
        raise ValueError('Invalid package path')
    parts=rel.split('/')
    if any(p in ('', '.', '..') for p in parts):raise ValueError('Invalid package path')
    p=root
    for part in parts:
        p=p/part
        if p.is_symlink():raise ValueError('Package symlink is forbidden')
    p.resolve().relative_to(root.resolve())
    if not p.is_file():raise ValueError('Missing media: '+rel)
    return p

def collect(t, out, workspace, attribution):
    checkpoint=copy.deepcopy(t); files={}; records=[]
    def media(value, category='source'):
        p=Path(value).resolve(); p.relative_to(workspace)
        if not p.is_file():raise ValueError('Missing source: '+str(p))
        if str(p) not in files:
            suffix=p.suffix.lower()
            if not re.fullmatch(r'\.[a-z0-9]{1,12}', suffix):suffix='.bin'
            rel=f'sources/{len(files):05}{suffix}'
            shutil.copyfile(p,out/rel);files[str(p)]=rel
            records.append({'path':rel,'originalRelativePath':p.relative_to(workspace).as_posix(),
                            'sha256':sha(p),'category':category,'rights':'Inherited from source project; no new license granted'})
        return files[str(p)]
    for source in checkpoint['sources']:
        for item in [source,*source.get('variants',[])]:
            for k in ('path','metadataPath'):
                if k in item:item[k]=media(item[k])
    for shot in checkpoint['shots']:
        for k in ('text','caption'):
            if k in shot:shot[k]['font']=media(shot[k]['font'],'font')
    if 'reference' in checkpoint:
        ref=checkpoint['reference'];cap=Path(ref['capturesRoot']).resolve();cap.relative_to(workspace)
        # Reference compositor depends on filenames; retain only its data/media, never execute recipes.
        for p in sorted(cap.rglob('*')):
            if p.is_symlink():raise ValueError('Reference capture symlink forbidden')
            if p.is_file() and p.suffix.lower() in ('.mkv','.json','.png','.wav'):
                rel='reference/'+p.relative_to(cap).as_posix()
                if not re.fullmatch(r'[A-Za-z0-9_./-]+',rel):raise ValueError('Nonportable reference filename')
                (out/rel).parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(p,out/rel)
                records.append({'path':rel,'originalRelativePath':p.relative_to(workspace).as_posix(),'sha256':sha(p),'category':'reference','rights':'Inherited from source project'})
        ref['capturesRoot']='reference';ref['font']=media(ref['font'],'font')
    # Retain conventional rights sidecars beside media and at each enclosing project directory.
    directories={workspace}
    for original in files:
        parent=Path(original).parent
        while True:
            directories.add(parent)
            if parent==workspace:break
            parent=parent.parent
    for directory in sorted(directories):
        for name in ('LICENSE','LICENSE.md','LICENSE.txt','COPYING','COPYING.txt','OFL.txt','NOTICE','NOTICE.md','ATTRIBUTION.md','ATTRIBUTION.json'):
            p=directory/name
            if p.is_file():media(p,'attribution')
    for p in attribution:media(p,'attribution')
    write_json(out/'timeline.json',checkpoint)
    return checkpoint,records

def rgba_text(target, text, seconds):
    shape=(target['height'],target['width'],3)
    safe=target.get('safeArea',{'x':0,'y':0,'width':target['width'],'height':target['height']})
    black=draw_text(np.zeros(shape,np.uint8),text,seconds,safe)
    white=draw_text(np.full(shape,255,np.uint8),text,seconds,safe)
    alpha=255-(white[:,:,0].astype(np.int16)-black[:,:,0].astype(np.int16))
    return np.dstack((black,alpha.astype(np.uint8)))

def movie(out, layer, fps):
    sequence=out/layer['sequence']
    run(['ffmpeg','-v','error','-y','-framerate',str(fps),'-start_number','0','-i',str(sequence.parent/'%06d.png'),
         '-frames:v',str(layer['endFrame']-layer['startFrame']),'-an','-c:v','prores_ks','-profile:v','4','-pix_fmt','yuva444p10le',
         '-alpha_bits','16','-threads','1','-map_metadata','-1','-fflags','+bitexact',str(out/layer['movie'])])

def fcp_xml(comp, audio, manifest):
    root=ET.Element('xmeml',version='5');seq=ET.SubElement(root,'sequence',id='keel-sequence')
    def put(parent,key,value):ET.SubElement(parent,key).text=str(value)
    def rate(parent):
        r=ET.SubElement(parent,'rate');put(r,'timebase',manifest['fps']);put(r,'ntsc','FALSE')
    put(seq,'name',comp['name']);put(seq,'duration',manifest['durationFrames']);rate(seq)
    tc=ET.SubElement(seq,'timecode');rate(tc);put(tc,'string',manifest['startTimecode']);put(tc,'frame',manifest['startTimecodeFrame']);put(tc,'displayformat','NDF')
    media=ET.SubElement(seq,'media');v=ET.SubElement(media,'video');fmt=ET.SubElement(v,'format');sc=ET.SubElement(fmt,'samplecharacteristics');rate(sc)
    for k,val in [('width',comp['width']),('height',comp['height']),('pixelaspectratio','square'),('fielddominance','none')]:put(sc,k,val)
    def clip(track,l,index,is_audio=False,channel=1):
        c=ET.SubElement(track,'clipitem',id=f'clip-{index}-{channel}');put(c,'name',l['name']);put(c,'enabled','TRUE');rate(c)
        for key,val in [('duration',l['endFrame']-l['startFrame']),('start',l['startFrame']),('end',l['endFrame']),('in',0),('out',l['endFrame']-l['startFrame'])]:put(c,key,val)
        if not is_audio:put(c,'alphatype','straight' if l['alpha'] else 'none')
        f=ET.SubElement(c,'file',id=f'file-{index}');put(f,'name',Path(l['xmlPath'] if is_audio else l['movie']).name)
        # xmeml requires an absolute file URI. Portable template uses a sentinel root; relocate.py binds it locally.
        put(f,'pathurl','file:///__KEEL_PACKAGE__/'+quote(l['xmlPath'] if is_audio else l['movie']));rate(f);put(f,'duration',l['endFrame']-l['startFrame'])
        fm=ET.SubElement(f,'media')
        if is_audio:
            am=ET.SubElement(fm,'audio');put(am,'channelcount',2);asc=ET.SubElement(am,'samplecharacteristics');put(asc,'depth',16);put(asc,'samplerate',SR)
            st=ET.SubElement(c,'sourcetrack');put(st,'mediatype','audio');put(st,'trackindex',channel)
        else:
            vm=ET.SubElement(fm,'video');vc=ET.SubElement(vm,'samplecharacteristics');rate(vc)
            for k,val in [('width',comp['width']),('height',comp['height']),('pixelaspectratio','square'),('fielddominance','none')]:put(vc,k,val)
    for z in sorted(set(l['z'] for l in comp['layers'])):
        tr=ET.SubElement(v,'track')
        for i,l in enumerate(comp['layers']):
            if l['z']==z:clip(tr,l,i)
    am=ET.SubElement(media,'audio');put(am,'channelcount',2);put(am,'layout','stereo')
    af=ET.SubElement(am,'format');asc=ET.SubElement(af,'samplecharacteristics');put(asc,'depth',16);put(asc,'samplerate',SR)
    group=ET.SubElement(ET.SubElement(am,'outputs'),'group');put(group,'index',1);put(group,'numchannels',2);put(group,'downmix',0)
    for channel in (1,2):put(ET.SubElement(group,'channel'),'index',channel)
    for i,l in enumerate(audio):
        # Two discrete source channels. No downmix guess or duplicate stereo clips.
        for channel in (1,2):
            track=ET.SubElement(am,'track');clip(track,l,100000+i,True,channel);put(track,'outputchannelindex',channel)
    return ET.tostring(root,encoding='unicode',xml_declaration=True)+'\n'

def otio(comp,audio,m):
    def rt(v):return {'OTIO_SCHEMA':'RationalTime.1','value':v,'rate':m['fps']}
    def tr(start,duration):return {'OTIO_SCHEMA':'TimeRange.1','start_time':rt(start),'duration':rt(duration)}
    tracks=[]
    groups=[('Video', [l for l in comp['layers'] if l['z']==z]) for z in sorted(set(l['z'] for l in comp['layers']))]
    groups += [('Audio',[l]) for l in audio]
    for kind,layers in groups:
        children=[];end=0
        for l in layers:
            if l['startFrame']>end:children.append({'OTIO_SCHEMA':'Gap.1','name':'gap','source_range':tr(0,l['startFrame']-end),'effects':[],'markers':[],'metadata':{}})
            count=l['endFrame']-l['startFrame'];url=l['movie'] if kind=='Video' else l['path']
            children.append({'OTIO_SCHEMA':'Clip.2','name':l['name'],'source_range':tr(0,count),'effects':[],'markers':[],
                             'media_references':{'DEFAULT_MEDIA':{'OTIO_SCHEMA':'ExternalReference.1','target_url':url,'available_range':tr(0,count),'metadata':{}}},
                             'active_media_reference_key':'DEFAULT_MEDIA','metadata':{'KEEL':{'baked':True,'alpha':l.get('alpha',False)}}})
            end=l['endFrame']
        if end<m['durationFrames']:children.append({'OTIO_SCHEMA':'Gap.1','name':'tail','source_range':tr(0,m['durationFrames']-end),'effects':[],'markers':[],'metadata':{}})
        tracks.append({'OTIO_SCHEMA':'Track.1','name':kind+' '+str(len(tracks)),'kind':kind,'children':children,'source_range':None,'effects':[],'markers':[],'metadata':{}})
    return {'OTIO_SCHEMA':'Timeline.1','name':comp['name'],'global_start_time':rt(m['startTimecodeFrame']),
            'tracks':{'OTIO_SCHEMA':'Stack.1','name':'tracks','children':tracks,'source_range':None,'effects':[],'markers':[],'metadata':{}},'metadata':{'KEEL':{'baked':True}}}

def export_package(x):
    t=x['timeline'];out=Path(x['outDir']);workspace=Path(x['workspaceRoot']).resolve()
    if any(out.iterdir()):raise ValueError('Export requires an empty output directory; checkpoints are never overwritten')
    fps=t['fps']
    if not 1<=fps<=99:raise ValueError('Editor export supports integer frame rates 1..99 only')
    last=t['shots'][-1];total=edit_time(t['tempo'],last['startBeat']+last['beats'])
    frames=int(total*fps) if t.get('reference') else math.ceil(total*fps-1e-9)
    if frames<1:raise ValueError('Timeline has no rendered frames')
    start=x.get('startTimecodeFrame',0)
    if start>=fps*86400 or start+frames>=fps*86400:raise ValueError('Timecode must fit in 24 hours')
    for folder in ('sources','passes','audio'): (out/folder).mkdir()
    checkpoint,sources=collect(t,out,workspace,x.get('attributionPaths',[]))
    (out/'source-checkpoint.json').write_text(x['sourceCheckpoint'])
    m={'version':1,'format':'keel-editor-package','name':t['name'],'fps':fps,'frameRate':{'numerator':fps,'denominator':1},
       'sourceCheckpointSha256':sha(out/'source-checkpoint.json'),'durationFrames':frames,'startTimecodeFrame':start,'startTimecode':timecode(start,fps),'dropFrame':False,'pixelAspect':1,
       'framePolicy':'floor' if t.get('reference') else 'ceil','sources':sources,'audio':[],'compositions':[],
       'limitations':['WebGL, shaders, transitions, crops, source retiming, reference effects and pixel fonts are baked.',
                      'PNG passes are exact; ProRes 4444 is lossy video with alpha, used for XML/OTIO.',
                      'Audio stems carry baked gain/fades/ducking, unnormalized 48 kHz float PCM; delivery loudnorm/EQ/AAC is excluded.',
                      'XML uses companion 16-bit PCM stems to meet xmeml audio depth limits; float peaks above 0 dBFS clip in these copies.',
                      'Titles retain source text/style metadata; raster layers allow position/scale/opacity editing, not native glyph editing.',
                      'AE/Premiere/Resolve GUI import and color management require application validation.'],
       'validation':{'afterEffects':'not-run','premiere':'not-run','resolve':'not-run'},
       'toolchain':{'ffmpeg':run(['ffmpeg','-version']).stdout.decode().splitlines()[0],'numpy':np.__version__}}
    n=math.ceil(Fraction(frames*SR,fps));stems=[]
    for i,layer in enumerate(t.get('audio',[])):
        one=copy.deepcopy(t);one['audio']=[layer];samples=audio_mix(one,None,return_samples=True)[:n]
        samples=np.pad(samples,((0,max(0,n-len(samples))),(0,0)))
        rel=f'audio/{i:04}.wav';run(['ffmpeg','-v','error','-y','-f','f32le','-ar',str(SR),'-ac','2','-i','-','-c:a','pcm_f32le','-map_metadata','-1',str(out/rel)],input=samples.astype('<f4').tobytes())
        xml_rel=f'audio/{i:04}-pcm16.wav'
        run(['ffmpeg','-v','error','-y','-i',str(out/rel),'-c:a','pcm_s16le','-map_metadata','-1',str(out/xml_rel)])
        stems.append(samples)
        m['audio'].append({'name':layer['id'],'path':rel,'xmlPath':xml_rel,'xmlClippedSamples':int(np.count_nonzero(np.abs(samples)>1)),'startFrame':0,'endFrame':frames,'samples':n,'sampleRate':SR,'channels':2,'baked':True,'original':layer})
    mixed=sum(stems,np.zeros((n,2),np.float32))
    run(['ffmpeg','-v','error','-y','-f','f32le','-ar',str(SR),'-ac','2','-i','-','-c:a','pcm_f32le','-map_metadata','-1',str(out/'audio/mix.wav')],input=mixed.astype('<f4').tobytes())
    for target in t['targets']:
        if x.get('targets') and target['id'] not in x['targets']:continue
        ci=len(m['compositions']);c={'id':target['id'],'name':t['name']+'-'+target['id'],'width':target['width'],'height':target['height'],'layers':[]}
        original=compositor(t,target);base_t=copy.deepcopy(t)
        for shot in base_t['shots']:
            if not t.get('reference') and shot.get('transition',{}).get('type','cut')=='cut':
                if shot['kind']=='card':shot['text']=dict(shot['text'],lines=[' '])
                else:shot.pop('text',None)
                shot.pop('caption',None)
        base=None if t.get("reference") else compositor(base_t,target);entries=[]
        for si,shot in enumerate(t['shots']):
            a=min(frames,boundary(t,shot['startBeat']));b=min(frames,boundary(t,shot['startBeat']+shot['beats']))
            if b<=a:continue
            split=not t.get('reference') and shot.get('transition',{}).get('type','cut')=='cut'
            passes=[('base',None)] if split else [('composite',None)]
            if split:passes += [(key,shot[key]) for key in ('text','caption') if key in shot]
            for z,(kind,text) in enumerate(passes):
                rel=f'passes/{ci:02}-{si:04}-{z}';(out/rel).mkdir()
                l={'name':shot['id']+' / '+kind,'shotIndex':si,'startFrame':a,'endFrame':b,'z':z,'alpha':text is not None,'sequence':rel+'/000000.png','movie':rel+'.mov',
                   'baked':True,'editable':['timing','position','scale','opacity'],'transform':{'position':[target['width']/2,target['height']/2],'scale':[100,100],'opacity':100}}
                if text:l['title']=copy.deepcopy(checkpoint['shots'][si][kind])
                c['layers'].append(l);entries.append((l,shot,text,split))
        digest=__import__('hashlib').sha256()
        for frame in range(frames):
            exact=original.draw(frame/fps);background=base.draw(frame/fps) if base else exact;digest.update(exact.tobytes());recomposed=None
            for l,shot,text,split in entries:
                if not l['startFrame']<=frame<l['endFrame']:continue
                seconds=frame/fps-edit_time(t['tempo'],shot['startBeat'])
                if text:rgba=rgba_text(target,text,seconds)
                else:rgba=np.dstack((background if split else exact,np.full(exact.shape[:2],255,np.uint8)))
                Image.fromarray(rgba).save(out/Path(l['sequence']).parent/f'{frame-l["startFrame"]:06}.png')
                if recomposed is None:recomposed=rgba[:,:,:3].copy()
                else:recomposed=np.where(rgba[:,:,3:4]==255,rgba[:,:,:3],recomposed)
            if not np.array_equal(recomposed,exact):raise ValueError(f'Pass composite mismatch at frame {frame}')
            if frame%150==0:print(f'Editor {target["id"]}: {frame}/{frames}',file=__import__('sys').stderr,flush=True)
        c['exactRgbSha256']=digest.hexdigest()
        for l in c['layers']:movie(out,l,fps)
        c['xml']=f'timeline-{ci:02}.xml';c['otio']=f'timeline-{ci:02}.otio'
        (out/c['xml']).write_text(fcp_xml(c,m['audio'],m));write_json(out/c['otio'],otio(c,m['audio'],m));m['compositions'].append(c)
    shutil.copyfile(PACKAGE_ROOT/'editor/import-after-effects.jsx',out/'import-after-effects.jsx')
    shutil.copyfile(PACKAGE_ROOT/'editor/relocate.py',out/'relocate.py')
    shutil.copyfile(PACKAGE_ROOT/'docs/editor-import.md',out/'README.md')
    write_json(out/'ATTRIBUTION.json',{'sourceRecords':sources,'notes':'Collected files retain original rights. Attribution sidecars are data in sources. Fonts are not installed by importer.'})
    m['files']=[{'path':p.relative_to(out).as_posix(),'bytes':p.stat().st_size,'sha256':sha(p)} for p in sorted(out.rglob('*')) if p.is_file()]
    write_json(out/'manifest.json',m)
    result=validate_package(out);write_json(out/'validation.json',result)
    return {'packageDir':str(out),'manifest':str(out/'manifest.json'),'validation':result,'compositions':len(m['compositions']),'durationFrames':frames}


def validate_package(directory):
    root=Path(directory).resolve();m=json.loads(safe_file(root,'manifest.json').read_text())
    if m.get('format')!='keel-editor-package' or m.get('version')!=1:raise ValueError('Unsupported editor manifest')
    fps=m['fps'];frames=m['durationFrames']
    if type(fps)!=int or not 1<=fps<=99 or type(frames)!=int or frames<1:raise ValueError('Invalid frame grid')
    if m['frameRate']!={'numerator':fps,'denominator':1} or m['dropFrame'] is not False or m['pixelAspect']!=1:raise ValueError('Unsupported frame grid')
    if type(m['startTimecodeFrame'])!=int or not 0<=m['startTimecodeFrame']<fps*86400 or m['startTimecode']!=timecode(m['startTimecodeFrame'],fps):raise ValueError('Timecode mismatch')
    if not m['compositions']:raise ValueError('No compositions')
    listed=set()
    for item in m['files']:
        if item['path'] in listed:raise ValueError('Duplicate package file')
        listed.add(item['path']);p=safe_file(root,item['path'])
        if p.stat().st_size!=item['bytes'] or sha(p)!=item['sha256']:raise ValueError('Hash mismatch: '+item['path'])
    if sha(safe_file(root,'source-checkpoint.json'))!=m['sourceCheckpointSha256']:raise ValueError('Checkpoint hash mismatch')
    for source in m['sources']:
        if source['path'] not in listed or sha(safe_file(root,source['path']))!=source['sha256']:raise ValueError('Source hash mismatch')
    for l in m['audio']:
        p=safe_file(root,l['path']);info=probe(p);s=info['streams'][0]
        count=round(float(s['duration'])*SR)
        if s['codec_name']!='pcm_f32le' or int(s['sample_rate'])!=SR or s['channels']!=2 or count!=l['samples'] or count!=math.ceil(Fraction(frames*SR,fps)) or l['startFrame']!=0 or l['endFrame']!=frames:raise ValueError('Audio sync mismatch')
        xml_s=probe(safe_file(root,l['xmlPath']))['streams'][0]
        if xml_s['codec_name']!='pcm_s16le' or int(xml_s['sample_rate'])!=SR or xml_s['channels']!=2 or round(float(xml_s['duration'])*SR)!=count:raise ValueError('XML audio sync mismatch')
    checked=0
    for c in m['compositions']:
        if any(type(c[k])!=int or not 4<=c[k]<=30000 for k in ('width','height')):raise ValueError('Invalid dimensions')
        digest=__import__('hashlib').sha256();base_coverage=np.zeros(frames,np.int16)
        for l in c['layers']:
            if any(type(l[k])!=int for k in ('startFrame','endFrame','z')) or not 0<=l['startFrame']<l['endFrame']<=frames or l['z']<0:raise ValueError('Invalid layer range/order')
            if l['z']==0:base_coverage[l['startFrame']:l['endFrame']]+=1
            mv=probe(safe_file(root,l['movie']));vs=next(s for s in mv['streams'] if s['codec_type']=='video')
            if int(vs['nb_frames'])!=l['endFrame']-l['startFrame'] or Fraction(vs['avg_frame_rate'])!=fps or vs['width']!=c['width'] or vs['height']!=c['height']:raise ValueError('Movie frame mismatch')
            if l['alpha'] and not vs['pix_fmt'].startswith('yuva'):raise ValueError('Movie alpha missing')
        if not np.all(base_coverage==1):raise ValueError('Base layer gap/overlap')
        for f in range(frames):
            rgba=None;active=sorted([l for l in c['layers'] if l['startFrame']<=f<l['endFrame']],key=lambda l:l['z'])
            if len(set(l['z'] for l in active))!=len(active):raise ValueError('Duplicate layer order')
            for l in active:
                rel=(Path(l['sequence']).parent/f'{f-l["startFrame"]:06}.png').as_posix()
                if rel not in listed:raise ValueError('Unlisted sequence frame')
                im=Image.open(safe_file(root,rel));pixels=np.array(im)
                if im.mode!='RGBA' or im.size!=(c['width'],c['height']):raise ValueError('Invalid RGBA sequence')
                if not np.all(np.isin(pixels[:,:,3],[0,255])):raise ValueError('Nonbinary alpha is unsupported by exact compositor check')
                if not l['alpha'] and not np.all(pixels[:,:,3]==255):raise ValueError('Opaque pass has alpha')
                rgba=pixels[:,:,:3] if rgba is None else np.where(pixels[:,:,3:4]==255,pixels[:,:,:3],rgba)
                checked+=1
            digest.update(rgba.tobytes())
        if digest.hexdigest()!=c['exactRgbSha256']:raise ValueError('Layer composite hash mismatch')
        xml=ET.parse(safe_file(root,c['xml']));seq=xml.getroot().find('sequence')
        if int(seq.findtext('duration'))!=frames or int(seq.findtext('rate/timebase'))!=fps:raise ValueError('XML frame mismatch')
        urls=[]
        for el in xml.findall('.//pathurl'):
            prefix='file:///__KEEL_PACKAGE__/'
            if not el.text.startswith(prefix):raise ValueError('Invalid portable XML URL')
            urls.append(unquote(el.text[len(prefix):]))
        expected=[l['movie'] for l in c['layers']]+[l['xmlPath'] for l in m['audio'] for _ in (1,2)]
        if sorted(urls)!=sorted(expected):raise ValueError('XML media mismatch')
        for rel in urls:safe_file(root,rel)
        if int(seq.findtext('timecode/frame'))!=m['startTimecodeFrame'] or seq.findtext('rate/ntsc')!='FALSE':raise ValueError('XML timecode mismatch')
        expected_layers=[l for z in sorted(set(l['z'] for l in c['layers'])) for l in c['layers'] if l['z']==z]
        xml_clips=seq.findall('media/video/track/clipitem')
        for clip,l in zip(xml_clips,expected_layers):
            values={key:int(clip.findtext(key)) for key in ('start','end','in','out','duration')}
            count=l['endFrame']-l['startFrame']
            if values!={'start':l['startFrame'],'end':l['endFrame'],'in':0,'out':count,'duration':count}:raise ValueError('XML edit mismatch')
        for track,channel in zip(seq.findall('media/audio/track'),[ch for _ in m['audio'] for ch in (1,2)]):
            clip=track.find('clipitem')
            if int(track.findtext('outputchannelindex'))!=channel or int(clip.findtext('sourcetrack/trackindex'))!=channel:raise ValueError('XML stereo mapping mismatch')
            if [int(clip.findtext(k)) for k in ('start','end','in','out')]!=[0,frames,0,frames]:raise ValueError('XML audio edit mismatch')
        data=json.loads(safe_file(root,c['otio']).read_text());tracks=data['tracks']['children']
        refs=[clip['media_references']['DEFAULT_MEDIA']['target_url'] for track in tracks for clip in track['children'] if clip['OTIO_SCHEMA']=='Clip.2']
        if sorted(refs)!=sorted([l['movie'] for l in c['layers']]+[l['path'] for l in m['audio']]):raise ValueError('OTIO media mismatch')
        if data['global_start_time']!={'OTIO_SCHEMA':'RationalTime.1','value':m['startTimecodeFrame'],'rate':fps}:raise ValueError('OTIO timecode mismatch')
        actual=[]
        for track in tracks:
            at=0
            for clip in track['children']:
                duration=clip['source_range']['duration'];start=clip['source_range']['start_time']
                if duration['rate']!=fps or start['rate']!=fps or start['value']!=0 or type(duration['value'])!=int or duration['value']<0:raise ValueError('OTIO frame grid mismatch')
                if clip['OTIO_SCHEMA']=='Clip.2':actual.append((clip['media_references']['DEFAULT_MEDIA']['target_url'],at,at+duration['value']))
                at+=duration['value']
            if at!=frames:raise ValueError('OTIO duration mismatch')
        expected_edits=[(l['movie'],l['startFrame'],l['endFrame']) for l in c['layers']]+[(l['path'],0,frames) for l in m['audio']]
        if sorted(actual)!=sorted(expected_edits):raise ValueError('OTIO edit mismatch')
    return {'passed':True,'filesChecked':len(listed),'sequenceFramesChecked':checked,'durationFrames':frames,
            'checks':['relative paths / no symlinks','SHA-256','PNG RGBA / ordered composite RGB hash','ProRes frame count/rate/alpha','48 kHz PCM duration','XML/OTIO references'],
            'applicationValidation':m['validation']}
