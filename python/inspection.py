"""Diagnostic views of committed data and exact decoded source frames, with JSON evidence."""
import hashlib,json,math,re,subprocess,csv
from pathlib import Path
from collections import Counter,defaultdict
import numpy as np
from PIL import Image,ImageDraw
from common import run,probe,sha,edit_time
from renderer import compositor,contact_sheet

def bounds(points):
    a=np.asarray(points,dtype=float)
    return {'min':a.min(0).tolist(),'max':a.max(0).tolist()} if len(a) else None

def project(points,kind):
    a=np.asarray([[p[0],0,p[1]] if len(p)==2 else p for p in points],dtype=float)
    if kind=='top':return a[:,[0,2]]
    if kind=='side':return a[:,[2,1]]*np.array([1,-1])
    if kind=='iso':return np.column_stack(((a[:,0]-a[:,2])*.7071067811865476,(a[:,0]+a[:,2])*.4082482904638631-a[:,1]*.816496580927726))
    return a[:,[0,1]]*np.array([1,-1])

def fit(points,w,h):
    a=np.asarray(points,dtype=float);lo=a.min(0);hi=a.max(0);span=np.maximum(hi-lo,1e-9)
    scale=min((w-40)/span[0],(h-70)/span[1]);return (a-(lo+hi)/2)*scale+np.array([w/2,(h+30)/2])

def numeric_stats(a):
    a=np.asarray(a,dtype=float)
    return {'count':len(a),'min':float(a.min()),'max':float(a.max()),'mean':float(a.mean()),'stddev':float(a.std())} if len(a) else {'count':0}

def inspect(x):
    s=x['snapshot'];out=Path(x['outDir']);out.mkdir(parents=True,exist_ok=True);w=x.get('width',640);h=x.get('height',480)
    summaries={'meshes':[],'graphs':[],'grids':[]};objects={}
    for m in s.get('meshes',[]):
        p=np.asarray(m['positions']).reshape(-1,3);tri=np.asarray(m['indices'],dtype=int).reshape(-1,3);edges=Counter()
        for a,b,c in tri:
            for v,u in ((a,b),(b,c),(c,a)):edges[tuple(sorted((int(v),int(u))))]+=1
        crosses=np.cross(p[tri[:,1]]-p[tri[:,0]],p[tri[:,2]]-p[tri[:,0]]) if len(tri) else np.zeros((0,3))
        areas=np.linalg.norm(crosses,axis=1)*.5
        summaries['meshes'].append({'id':m['id'],'vertices':len(p),'triangles':len(tri),'bounds':bounds(p),'surfaceArea':float(areas.sum()),'degenerateTriangles':int((areas<=1e-12).sum()),'indexedBoundaryEdges':sum(c==1 for c in edges.values()),'indexedNonManifoldEdges':sum(c>2 for c in edges.values()),'attributeStrides':{k:len(v)//len(p) for k,v in m.get('attributes',{}).items()},'topologyNote':'Indexed topology; coincident duplicated vertices are not welded or treated as proof of a closed solid'})
        objects[('mesh',m['id'])]=m
        with (out/f'mesh-{m["id"]}-vertices.csv').open('w',newline='') as f:
            wr=csv.writer(f);wr.writerow(['vertex','x','y','z']);wr.writerows((i,*row) for i,row in enumerate(p))
        with (out/f'mesh-{m["id"]}-triangles.csv').open('w',newline='') as f:
            wr=csv.writer(f);wr.writerow(['triangle','a','b','c']);wr.writerows((i,*row) for i,row in enumerate(tri))
    for g in s.get('graphs',[]):
        adj={n['id']:set() for n in g['nodes']}
        for e in g['edges']:adj[e['from']].add(e['to']);adj[e['to']].add(e['from'])
        seen=set();components=[]
        for id in adj:
            if id in seen:continue
            todo=[id];seen.add(id);part=[]
            while todo:
                at=todo.pop();part.append(at)
                for near in sorted(adj[at]):
                    if near not in seen:seen.add(near);todo.append(near)
            components.append(sorted(part))
        summaries['graphs'].append({'id':g['id'],'nodes':len(adj),'edges':len(g['edges']),'weakComponents':components,'isolatedNodes':[id for id,v in adj.items() if not v],'undirectedCycleRank':len(g['edges'])-len(adj)+len(components),'directedEdges':sum(e.get('directed',False) for e in g['edges'])})
        objects[('graph',g['id'])]=g
        lines=['digraph G {']
        for n in g['nodes']:lines.append('  '+json.dumps(n['id'])+' [label='+json.dumps(n.get('label',n['id']))+'];')
        for e in g['edges']:lines.append('  '+json.dumps(e['from'])+' -> '+json.dumps(e['to'])+' [id='+json.dumps(e['id'])+(', dir=none' if not e.get('directed') else '')+'];')
        (out/f'graph-{g["id"]}.dot').write_text('\n'.join(lines+['}'])+'\n')
    for g in s.get('grids',[]):
        summaries['grids'].append({'id':g['id'],'width':g['width'],'height':g['height'],'channels':{k:numeric_stats(v) for k,v in g['channels'].items()}});objects[('grid',g['id'])]=g
        for k,a in g['channels'].items():
            # Channel names are data, not paths: numeric suffix preserves every name safely.
            index=list(g['channels']).index(k)
            with (out/f'grid-{g["id"]}-channel-{index}.csv').open('w',newline='') as f:csv.writer(f).writerows(np.asarray(a).reshape(g['height'],g['width']))
    views=x.get('views')
    if not views:
        views=[]
        for m in s.get('meshes',[]):
            for p in ('front','top','side','iso'):views.append({'id':m['id']+'-'+p,'kind':'mesh','objectId':m['id'],'projection':p})
        for g in s.get('graphs',[]):views.append({'id':g['id']+'-graph','kind':'graph','objectId':g['id'],'projection':'top'})
        for g in s.get('grids',[]):
            for i,k in enumerate(g['channels']):views.append({'id':g['id']+'-grid-'+str(i),'kind':'grid','objectId':g['id'],'channel':k})
    if len(views)>64:raise ValueError('More than 64 default views; select views explicitly')
    if len({v['id'] for v in views})!=len(views):raise ValueError('Duplicate view id')
    pictures=[];rows=[]
    for v in views:
        item=objects.get((v['kind'],v['objectId']))
        if item is None:raise ValueError('Unknown inspection object '+v['objectId'])
        im=Image.new('RGB',(w,h),'#101620');d=ImageDraw.Draw(im);label=v['kind']+' '+v['objectId']+' '+v.get('projection',v.get('channel',''))
        detail={}
        if v['kind']=='mesh':
            xy=fit(project(np.asarray(item['positions']).reshape(-1,3),v.get('projection','iso')),w,h);tri=np.asarray(item['indices']).reshape(-1,3)
            take=np.linspace(0,len(tri)-1,min(20000,len(tri)),dtype=int) if len(tri) else []
            for i in take:d.line([tuple(p) for p in xy[tri[i]]]+[tuple(xy[tri[i][0]])],fill='#71d7fa',width=1)
            if not len(tri):
                for px,py in xy:d.ellipse((px-2,py-2,px+2,py+2),fill='#71d7fa')
            detail={'displayedTriangles':len(take),'totalTriangles':len(tri),'sampled':len(take)<len(tri)}
        elif v['kind']=='graph':
            nodes=item['nodes'];positions=[n.get('position',[math.cos(i/max(1,len(nodes))*math.tau),math.sin(i/max(1,len(nodes))*math.tau)]) for i,n in enumerate(nodes)]
            # Include real curved road samples in the extent and render, not just junction chords.
            allp=positions+[p for e in item['edges'] for p in e.get('points',[])]
            if allp:
                xy=fit(project(allp,v.get('projection','top')),w,h);at={n['id']:tuple(xy[i]) for i,n in enumerate(nodes)};offset=len(nodes)
                for e in item['edges']:
                    points=e.get('points',[]);line=[tuple(p) for p in xy[offset:offset+len(points)]] if points else [at[e['from']],at[e['to']]];offset+=len(points)
                    if len(line)>1:d.line(line,fill='#65798f',width=2)
                    if e.get('directed') and len(line)>1:
                        tip=np.array(line[-1]);vec=tip-np.array(line[-2]);vec/=max(1e-9,np.linalg.norm(vec));perp=np.array([-vec[1],vec[0]])
                        d.polygon([tuple(tip),tuple(tip-vec*10+perp*4),tuple(tip-vec*10-perp*4)],fill='#f9be62')
                for n in nodes:
                    px,py=at[n['id']];d.ellipse((px-4,py-4,px+4,py+4),fill='#71d7fa')
                    if len(nodes)<=64:d.text((px+6,py),n.get('label',n['id']),fill='white')
        else:
            channel=v.get('channel',next(iter(item['channels'])))
            if channel not in item['channels']:raise ValueError('Unknown grid channel '+channel)
            a=np.asarray(item['channels'][channel]).reshape(item['height'],item['width']);lo=float(a.min());hi=float(a.max());norm=(a-lo)/max(hi-lo,1e-12)
            rgb=np.stack((norm*240+10,(1-norm)*120+40,(1-norm)*210+30),axis=2).astype(np.uint8)
            grid=Image.fromarray(rgb);scale=min((w-40)/item['width'],(h-70)/item['height']);grid=grid.resize((max(1,round(item['width']*scale)),max(1,round(item['height']*scale))),Image.Resampling.NEAREST)
            im.paste(grid,((w-grid.width)//2,45));detail={'channel':channel,'min':lo,'max':hi,'visualSampling':'nearest','csv':str(out/f'grid-{item["id"]}-channel-{list(item["channels"]).index(channel)}.csv')}
        d.text((12,12),label,fill='white');path=out/(v['id']+'.png');im.save(path);pictures.append(str(path));rows.append({**v,'path':str(path),'sha256':sha(path),**detail})
    sheet=diagnostic_sheet(pictures,out/'inspection-sheet.png') if pictures else None
    return {'version':1,'schema':'keel-inspection-report@1','summaries':summaries,'views':rows,'stillsSheet':str(sheet) if sheet else None,'stateKeys':list(s.get('state',{})),
            'scope':'Exact supplied arrays/state; projections are diagnostic views, not the engine material renderer','exports':[str(p) for p in sorted(out.glob('*.csv'))]+[str(p) for p in sorted(out.glob('*.dot'))]}

def diagnostic_sheet(paths,out):
    tiles=[]
    for path in paths:
        im=Image.open(path).convert('RGB');im.thumbnail((320,240),Image.Resampling.LANCZOS)
        tile=Image.new('RGB',(340,270),'#101620');tile.paste(im,((340-im.width)//2,0));ImageDraw.Draw(tile).text((8,245),Path(path).name,fill='white');tiles.append(tile)
    cols=min(4,len(tiles));sheet=Image.new('RGB',(cols*340,math.ceil(len(tiles)/cols)*270),'#101620')
    for i,tile in enumerate(tiles):sheet.paste(tile,((i%cols)*340,(i//cols)*270))
    sheet.save(out);return out

def media_info(path):
    try:
        im=Image.open(path);im.load();return {'kind':'image','width':im.width,'height':im.height,'fps':1,'frames':1,'duration':1},np.array(im.convert('RGB'))
    except (OSError,ValueError):pass
    info=probe(path);v=next(v for v in info['streams'] if v['codec_type']=='video');fps=float(__import__('fractions').Fraction(v['avg_frame_rate']))
    return {'kind':'video','width':v['width'],'height':v['height'],'fps':fps,'frames':int(v.get('nb_frames') or float(info['format']['duration'])*fps+.5),'duration':float(info['format']['duration']),'rate':v['avg_frame_rate'],'nominalRate':v['r_frame_rate']},None

def decoded_frame(path,index,w,h):
    r=run(['ffmpeg','-v','info','-threads','1','-i',str(path),'-vf',f'select=eq(n\\,{index}),showinfo','-frames:v','1','-fps_mode','passthrough','-f','rawvideo','-pix_fmt','rgb24','-'])
    if len(r.stdout)!=w*h*3:raise ValueError('Frame outside media: '+str(index))
    pts=re.findall(r'pts_time:([\d.eE+-]+)',r.stderr.decode());return np.frombuffer(r.stdout,np.uint8).reshape(h,w,3).copy(),float(pts[-1]) if pts else None

def crop_frame(frame,view):
    r=view.get('crop');h,w=frame.shape[:2]
    if r:
        if r['x']+r['width']>w or r['y']+r['height']>h:raise ValueError('Crop outside source frame')
        frame=frame[r['y']:r['y']+r['height'],r['x']:r['x']+r['width']]
    k=view.get('scale',1)
    if frame.shape[0]*k*frame.shape[1]*k>16000000:raise ValueError('Snapshot view exceeds 16 million pixels')
    return np.repeat(np.repeat(frame,k,axis=0),k,axis=1)

def snapshot(x):
    out=Path(x['outDir']);out.mkdir(parents=True,exist_ok=True);media=x.get('mediaPath');t=x.get('timeline')
    if media:info,image=media_info(media);sourcehash=sha(media)
    else:
        target=next(o for o in t['targets'] if o['id']==x.get('target',t['targets'][0]['id']));fps=t['fps'];end=t['shots'][-1];duration=edit_time(t['tempo'],end['startBeat']+end['beats'])
        info={'kind':'timeline','width':target['width'],'height':target['height'],'fps':fps,'duration':duration,'frames':int(duration*fps) if t.get('reference') else math.ceil(duration*fps-1e-9)};image=None;comp=compositor(t,target);sourcehash=hashlib.sha256(json.dumps(t,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    if x.get('times') and x.get('frames'):raise ValueError('Select times or frames, not both')
    wanted=x.get('frames') or [int(math.floor(ts*info['fps']+1e-9)) for ts in x.get('times',[0])]
    if any(i>=info['frames'] for i in wanted):raise ValueError('Snapshot frame outside source')
    if x.get('times') and any(ts>=info['duration'] for ts in x['times']):raise ValueError('Snapshot time outside source')
    views=x.get('views') or [{'id':'full'}]
    if len({v['id'] for v in views})!=len(views):raise ValueError('Duplicate snapshot view id')
    if len(wanted)*len(views)>240:raise ValueError('More than 240 snapshot views; select fewer frames/regions')
    rows=[];images=[];frames={};order=sorted(set(wanted))
    if t:
        for i in range(max(order)+1):
            frame=comp.draw(i/info['fps'])
            if i in order:frames[i]=(frame.copy(),i/info['fps'])
    for i in order:
        frame,actual=frames[i] if t else (image.copy(),0) if image is not None else decoded_frame(media,i,info['width'],info['height'])
        for view in views:
            pixels=crop_frame(frame,view);path=out/f'frame-{i:08}-{view["id"]}.png';Image.fromarray(pixels).save(path);images.append(str(path))
            row={'frame':i,'seconds':actual,'view':view['id'],'path':str(path),'width':pixels.shape[1],'height':pixels.shape[0],'crop':view.get('crop'),'scale':view.get('scale',1),'sha256':sha(path),'rgbSha256':hashlib.sha256(pixels.tobytes()).hexdigest(),
                 'rgbStats':{'min':pixels.min(axis=(0,1)).tolist(),'max':pixels.max(axis=(0,1)).tolist(),'mean':pixels.mean(axis=(0,1)).tolist()}}
            if x.get('pixelData'):
                raw=path.with_suffix('.rgb');raw.write_bytes(pixels.tobytes());row['pixels']={'path':str(raw),'format':'rgb24','rowStride':pixels.shape[1]*3,'bytes':len(pixels.tobytes()),'sha256':sha(raw)}
            rows.append(row)
    return {'version':1,'source':info,'sourceSha256':sourcehash,'stills':rows,'sheet':str(contact_sheet(images,out/'snapshots-sheet.png')),
            'timing':'Frame indices decode by exact n; time requests map through average FPS. Actual decoded PTS is reported. Timeline snapshots replay from frame zero.'}

def clip(x):
    out=Path(x['outDir']);out.mkdir(parents=True,exist_ok=True);info,image=media_info(x['mediaPath']);a=x['startFrame'];b=x['endFrame']
    if image is not None:raise ValueError('Clip requires video')
    if __import__('fractions').Fraction(info['rate'])!=__import__('fractions').Fraction(info['nominalRate']):raise ValueError('Frame-bounded clips require constant frame rate; normalize variable-rate footage first')
    if b<=a or b>info['frames']:raise ValueError('Clip requires 0 <= startFrame < endFrame <= source frames')
    # Validate crop and budget before ffmpeg.
    w=info['width'];h=info['height'];r=x.get('crop');k=x.get('scale',1)
    if r:
        if r['x']+r['width']>w or r['y']+r['height']>h:raise ValueError('Crop outside source frame')
        w=r['width'];h=r['height']
    if w*h*k*k>16000000:raise ValueError('Clip output exceeds 16 million pixels')
    vf=f'trim=start_frame={a}:end_frame={b},setpts=PTS-STARTPTS'
    if r:vf+=f',crop={w}:{h}:{r["x"]}:{r["y"]}:exact=1'
    if k!=1:vf+=f',scale={w*k}:{h*k}:flags=neighbor'
    # Keep RGB until after crop/scale, preserving single-pixel regions even in YUV sources.
    vf='format=rgb24,'+vf
    args=['ffmpeg','-v','error','-y','-threads','1','-i',x['mediaPath'],'-map','0:v:0','-vf',vf,'-fps_mode','passthrough','-c:v','ffv1','-pix_fmt','rgb24','-threads','1','-fflags','+bitexact','-flags:v','+bitexact','-map_metadata','-1']
    streams=probe(x['mediaPath'])['streams'];audio=x.get('includeAudio',True) and any(s['codec_type']=='audio' for s in streams)
    if audio:args+=['-map','0:a:0','-af',f'atrim=start={a/info["fps"]:.12f}:end={b/info["fps"]:.12f},asetpts=PTS-STARTPTS','-c:a','pcm_s16le']
    else:args+=['-an']
    path=out/'clip.mkv';run(args+[str(path)])
    check=json.loads(run(['ffprobe','-v','error','-count_frames','-select_streams','v:0','-show_entries','stream=nb_read_frames','-of','json',str(path)]).stdout)
    frames=int(check['streams'][0]['nb_read_frames'])
    if frames!=b-a:raise ValueError('Encoded clip frame count differs from selected interval')
    preview=out/'clip-preview.mp4'
    run(['ffmpeg','-v','error','-y','-threads','1','-i',str(path),'-vf','pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0','-c:v','libx264','-preset','veryfast','-crf','20','-pix_fmt','yuv420p','-threads','1','-c:a','aac','-b:a','160k','-map_metadata','-1','-fflags','+bitexact','-flags:v','+bitexact','-flags:a','+bitexact','-movflags','+faststart',str(preview)])
    result={'version':1,'path':str(path),'sha256':sha(path),'sourceSha256':sha(x['mediaPath']),'startFrame':a,'endFrame':b,'endExclusive':True,'frames':frames,'fps':info['fps'],'width':w*k,'height':h*k,'duration':frames/info['fps'],'audioIncluded':audio,'format':'FFV1 lossless RGB, PCM audio','sourceCrop':r,'scale':k,'previewPath':str(preview),'previewSha256':sha(preview),'previewNote':'Lossy H.264/AAC for viewing; odd dimensions pad right/bottom by one pixel. Inspect path (clip.mkv) for exact pixels.'}
    (out/'clip.json').write_text(json.dumps(result,indent=2)+'\n');return result
