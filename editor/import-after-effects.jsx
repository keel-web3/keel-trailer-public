/* KEEL reviewed static importer. Manifest JSON is never evaluated as script.
 * Exact PNG passes; no fonts installed, source code executed, shell or network calls.
 * ExtendScript ES3. Use File > Scripts > Run Script File in After Effects.
 */
function KEELParseJSON(input) {
    var i=0, depth=0;
    function fail() { throw new Error('Invalid JSON at '+i); }
    function ws() { while (/\s/.test(input.charAt(i)) && i<input.length) i++; }
    function string() {
        var out='', c, h;
        if(input.charAt(i++)!=='"')fail();
        while(i<input.length) {
            c=input.charAt(i++);
            if(c==='"')return out;
            if(c==='\\') {
                c=input.charAt(i++);
                if(c==='u'){h=input.substr(i,4);if(!/^[0-9a-fA-F]{4}$/.test(h))fail();out+=String.fromCharCode(parseInt(h,16));i+=4;}
                else if(c==='"'||c==='\\'||c==='/')out+=c;
                else if(c==='b')out+='\b';else if(c==='f')out+='\f';else if(c==='n')out+='\n';else if(c==='r')out+='\r';else if(c==='t')out+='\t';else fail();
            } else {if(c.charCodeAt(0)<32)fail();out+=c;}
        }
        fail();
    }
    function value() {
        ws();if(++depth>64)fail();var c=input.charAt(i),v,a,k,m;
        if(c==='"')v=string();
        else if(c==='{'||c==='[') {
            i++;v=c==='{'?{}:[];ws();
            if(input.charAt(i)!==(c==='{'?'}':']'))while(true){
                if(c==='{') {ws();k=string();if(k==='__proto__'||k==='constructor'||k==='prototype'||Object.prototype.hasOwnProperty.call(v,k))fail();ws();if(input.charAt(i++)!==':')fail();v[k]=value();}
                else v.push(value());
                ws();if(input.charAt(i)!==',')break;i++;
            }
            if(input.charAt(i++)!==(c==='{'?'}':']'))fail();
        } else if(input.substr(i,4)==='true'){i+=4;v=true;}
        else if(input.substr(i,5)==='false'){i+=5;v=false;}
        else if(input.substr(i,4)==='null'){i+=4;v=null;}
        else {m=/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(input.substr(i));if(!m)fail();i+=m[0].length;v=Number(m[0]);if(!isFinite(v))fail();}
        depth--;return v;
    }
    if(input.length>16000000)throw new Error('Manifest exceeds 16 MB');
    var result=value();ws();if(i!==input.length)fail();return result;
}
function KEELRelativePath(p) {
    if(typeof p!=='string'||! /^[A-Za-z0-9_.\/-]+$/.test(p))throw new Error('Invalid package path');
    var a=p.split('/'),i;for(i=0;i<a.length;i++)if(a[i]===''||a[i]==='.'||a[i]==='..')throw new Error('Invalid package path');
    return p;
}
function KEELInteger(n,min,max) {if(typeof n!=='number'||Math.floor(n)!==n||n<min||n>max)throw new Error('Invalid frame/dimension');}
function KEELValidate(m,exists) {
    if(!m||m.format!=='keel-editor-package'||m.version!==1)throw new Error('Unsupported KEEL manifest');
    KEELInteger(m.fps,1,99);KEELInteger(m.durationFrames,1,10000000);KEELInteger(m.startTimecodeFrame,0,m.fps*86400-1);
    if(m.dropFrame!==false||m.pixelAspect!==1||m.frameRate.numerator!==m.fps||m.frameRate.denominator!==1)throw new Error('Unsupported frame grid');
    if(!(m.compositions instanceof Array)||!m.compositions.length||m.compositions.length>100||!(m.audio instanceof Array)||m.audio.length>10000)throw new Error('Invalid manifest collections');
    var ci,li,c,l,f,p,z,end={},coverage,frames,active;
    for(ci=0;ci<m.compositions.length;ci++) {
        c=m.compositions[ci];KEELInteger(c.width,4,30000);KEELInteger(c.height,4,30000);
        if(!(c.layers instanceof Array)||!c.layers.length||c.layers.length>10000)throw new Error('Invalid layers');
        coverage=[];end={};
        for(li=0;li<c.layers.length;li++) {
            l=c.layers[li];KEELInteger(l.startFrame,0,m.durationFrames-1);KEELInteger(l.endFrame,l.startFrame+1,m.durationFrames);KEELInteger(l.z,0,10000);
            if(typeof l.name!=='string'||typeof l.alpha!=='boolean')throw new Error('Invalid layer');
            if(end[l.z]!==undefined&&end[l.z]>l.startFrame)throw new Error('Layer order/overlap mismatch');end[l.z]=l.endFrame;
            p=KEELRelativePath(l.sequence);if(!/\/000000\.png$/.test(p))throw new Error('Invalid sequence');
            for(f=0;f<l.endFrame-l.startFrame;f++) {
                if(f>999999)throw new Error('Sequence too long');
                frames=('000000'+f).slice(-6);exists(p.replace(/000000\.png$/,frames+'.png'));
                if(l.z===0) {if(coverage[f+l.startFrame])throw new Error('Base overlap');coverage[f+l.startFrame]=true;}
            }
        }
        for(f=0;f<m.durationFrames;f++)if(!coverage[f])throw new Error('Base layer gap');
    }
    for(li=0;li<m.audio.length;li++) {
        l=m.audio[li];if(l.startFrame!==0||l.endFrame!==m.durationFrames||l.sampleRate!==48000||l.channels!==2||l.samples!==Math.ceil(m.durationFrames*48000/m.fps))throw new Error('Audio sync mismatch');
        if(!/\.wav$/.test(l.path))throw new Error('Invalid audio');exists(KEELRelativePath(l.path));
    }
}
function KEELImport(m,root) {
    function media(p) {
        KEELRelativePath(p);var parts=p.split('/'),current=root,folder,file,i;
        for(i=0;i<parts.length-1;i++){current+='/'+parts[i];folder=new Folder(current);if(!folder.exists||folder.alias)throw new Error('Missing/alias directory: '+p);}
        file=new File(root+'/'+p);if(!file.exists||file.alias)throw new Error('Missing/alias media: '+p);
        return file;
    }
    // Validate every sequence frame before modifying the current project.
    KEELValidate(m,media);
    app.beginUndoGroup('Import KEEL editor package');
    try {
        if(!app.project)app.newProject();
        var folder=app.project.items.addFolder(m.name),c,comp,i,j,l,options,item,layer,ordered;
        for(i=0;i<m.compositions.length;i++) {
            c=m.compositions[i];comp=app.project.items.addComp(c.name,c.width,c.height,1,m.durationFrames/m.fps,m.fps);comp.parentFolder=folder;
            comp.displayStartTime=m.startTimecodeFrame/m.fps;if(typeof comp.displayStartFrame!=='undefined')comp.displayStartFrame=m.startTimecodeFrame;
            comp.dropFrame=false;
            ordered=c.layers.slice(0);ordered.sort(function(a,b){return a.z-b.z||a.startFrame-b.startFrame;});
            // AE adds at the top. Import bottom to top to retain compositor order.
            for(j=0;j<ordered.length;j++) {
                l=ordered[j];options=new ImportOptions(media(l.sequence));options.sequence=true;options.forceAlphabetical=true;
                item=app.project.importFile(options);item.parentFolder=folder;item.mainSource.conformFrameRate=m.fps;
                item.mainSource.alphaMode=l.alpha?AlphaMode.STRAIGHT:AlphaMode.IGNORE;
                item.pixelAspect=1;
                layer=comp.layers.add(item);layer.name=l.name;layer.startTime=l.startFrame/m.fps;layer.inPoint=l.startFrame/m.fps;layer.outPoint=l.endFrame/m.fps;
                layer.property('ADBE Transform Group').property('ADBE Position').setValue([c.width/2,c.height/2]);
                layer.property('ADBE Transform Group').property('ADBE Scale').setValue([100,100]);
                layer.property('ADBE Transform Group').property('ADBE Opacity').setValue(100);
                layer.comment='KEEL baked pixels. Editable: timing, position, scale, opacity. See manifest for original title/style.';
            }
            for(j=0;j<m.audio.length;j++) {
                l=m.audio[j];item=app.project.importFile(new ImportOptions(media(l.path)));item.parentFolder=folder;
                layer=comp.layers.add(item);layer.name=l.name;layer.startTime=0;layer.inPoint=0;layer.outPoint=m.durationFrames/m.fps;
            }
        }
        return folder;
    } finally {app.endUndoGroup();}
}
if(typeof app!=='undefined') {
    try {
        var manifest=File.openDialog('Choose KEEL manifest.json','*.json');
        if(manifest) {
            if(manifest.alias||manifest.parent.alias)throw new Error('Choose a physical package folder');
            manifest.encoding='UTF-8';if(!manifest.open('r'))throw new Error('Cannot read manifest');
            var data=manifest.read();manifest.close();KEELImport(KEELParseJSON(data),manifest.parent.fsName);
            alert('KEEL import complete. Baked PNG layers and PCM stems imported. Review color management and save your AE project.');
        }
    } catch(e) {alert('KEEL import stopped: '+e.toString());}
}
