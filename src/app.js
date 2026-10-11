(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let files = [], index = null, pages = [], busy = false, controller = null, sequence = 0, awaiting = new Map();
  const clientBuild = window.AutoBuild || {version:'0.1.1',protocolVersion:1,build:'0.1.1'};
  const bridge = {client:clientBuild,host:null,state:'waiting',received:0,lastMessageAt:null,receivedVia:null};
  let batchAttempt = null;
  const stateNames = {pending:'待检查',checking:'检查中',ready:'可导入',importing:'导入中',done:'已导入',error:'失败',cancelled:'已取消'};
  const stageNames = {'Loading page assets…':'加载页面资源…','Running page scripts…':'执行页面脚本…','Measuring layout…':'测量设计尺寸与布局…'};
  function post(message) { parent.postMessage({pluginMessage:message}, '*'); }
  function setPhase(page, phase, detail) {
    page.phase=phase;
    if(!page.history)page.history=[];
    page.history.push({phase,at:new Date().toISOString(),...(detail?{detail}: {})});
    if(page.history.length>40)page.history.shift();
  }
  function recordFailure(page,error,fallbackStage) {
    page.failureStage=error.stage || page.phase || fallbackStage;
    page.errorCode=error.code || (error.name==='AbortError'?'cancelled':'operation-failed');
    page.state=error.name==='AbortError'?'cancelled':'error';
    page.error=error.name==='AbortError'?'':error.message;
    setPhase(page,page.state,page.failureStage);
  }
  function operationError(message,stage,code) {
    const error=new Error(message);error.stage=stage;error.code=code;return error;
  }
  function status(text, isError) { $('status').textContent=text; $('status').className=isError?'error':''; }
  function settings() { return {width:Math.max(64,Math.min(16000,Number($('default-width').value)||1440)),height:Math.max(64,Math.min(16000,Number($('default-height').value)||900)),gap:Math.max(0,Math.min(5000,Number($('gap').value)||0))}; }
  function applySettings(s) { if(!s || busy)return; if(s.width)$('default-width').value=s.width;if(s.height)$('default-height').value=s.height;if(s.gap!=null)$('gap').value=s.gap; }
  function setBusy(value) {
    busy=value;
    for(const id of ['pick-folder','pick-files','pick-zip','clear','scan','select-all','default-width','default-height','gap','run-scripts','add-paste']) $(id).disabled=value;
    $('cancel').hidden=!value; $('progress').hidden=!value;
    render();
  }
  function uniqueWarnings(list) { const seen=new Set();return list.filter(w=>{const k=JSON.stringify([w.kind,w.source,w.reference,w.message]);if(seen.has(k))return false;seen.add(k);return true;}); }
  function render() {
    $('inventory').textContent=index?`${index.rootName || '已选文件'} · ${pages.length} 个 HTML · ${index.entries.size-pages.length} 个资源文件`:'尚未添加文件';
    $('page-count').textContent=pages.length;
    $('clear').disabled=busy||!files.length;$('scan').disabled=busy||!pages.length;
    const filter=$('filter').value.toLowerCase();
    const shown=pages.filter(p=>p.path.toLowerCase().includes(filter));
    if(!pages.length) $('pages').innerHTML='<div class="empty"><span>◇</span><p>每个 HTML 会成为一个独立的组</p><small>尺寸自动识别，资源缺失会明确提示</small></div>';
    else if(!shown.length) $('pages').innerHTML='<div class="empty">没有匹配的文件</div>';
    else $('pages').innerHTML=shown.map(p=>{
      const m=p.measurement, warning=p.warnings.length;
      const badge=p.state==='done'?'done':p.state==='error'?'error':warning?'warning':'';
      return `<div class="page"><input type="checkbox" data-select="${escape(p.path)}" ${p.selected?'checked':''} ${busy?'disabled':''} aria-label="选择 ${escape(p.path)}"><div class="page-body"><div class="path">${escape(p.path)}</div><div class="dimension">${m?`${Math.round(m.width)} × ${Math.round(m.height)} px`:'自动识别尺寸'}</div><div class="basis">${escape(p.error || (m?m.reason:'资源和布局检查后显示尺寸'))}</div>${p.state==='done'?`<div class="page-tools"><button data-locate="${escape(p.nodeId)}" class="link">定位分组</button><span>${p.count || 0} 个图层</span></div>`:`<div class="page-tools"><details><summary>尺寸覆盖</summary><label>视口 <input data-width="${escape(p.path)}" type="number" min="64" max="16000" value="${p.override?p.override.width:''}" placeholder="宽"> × <input data-height="${escape(p.path)}" type="number" min="64" max="16000" value="${p.override?p.override.height:''}" placeholder="高"></label><button data-apply="${escape(p.path)}" ${busy?'disabled':''}>应用</button></details></div>`}</div><span class="badge ${badge}">${warning?`${warning} 项提示 · `:''}${stateNames[p.state]}</span></div>`;
    }).join('');
    const eligible=pages.filter(p=>p.selected&&p.state!=='done');
    $('import').disabled=busy||!eligible.length;
    $('import').textContent=eligible.length?`导入选中页面（${eligible.length}）`:'导入选中页面';
    $('retry').hidden=busy||!pages.some(p=>p.state==='error');
    renderReport();
  }
  function renderReport() {
    const issues=pages.flatMap(p=>p.warnings.map(w=>({page:p.path,...w})).concat(p.error?[{page:p.path,kind:'page-error',message:p.error}]:[]));
    if(batchAttempt&&batchAttempt.error)issues.unshift({page:'批次初始化 / 导入',kind:'batch-error',message:`${batchAttempt.error}（阶段：${batchAttempt.failureStage}）`});
    $('diagnostics').hidden=!issues.length;$('warning-count').textContent=`${issues.length} 项`;
    $('report').innerHTML=issues.map(w=>`<div class="issue"><b>${escape(w.page)}</b>${escape(w.message||w.kind)}${w.reference?`<br><code>${escape(w.reference)}</code>`:''}${w.resolvedPath?`<br>预期路径：${escape(w.resolvedPath)}`:''}${w.source?`<br>引用来源：${escape(w.source)}`:''}</div>`).join('');
  }
  async function addFiles(nextFiles, replace=true) {
    if(busy)return;
    files=replace?Array.from(nextFiles):files.concat(Array.from(nextFiles));
    index=AutoAssets.createIndex(files);
    pages=AutoAssets.discoverPages(index).map(p=>({...p,selected:true,state:'pending',phase:'pending',history:[],warnings:[],measurement:null,prepared:null}));
    batchAttempt=null;
    render();$('summary').textContent='';
    if(!pages.length){status('没有找到 HTML 文件。请选择 HTML 或包含 HTML 的文件夹。',true);return;}
    await scan();
  }
  async function prepare(p, signal, measureOnly) {
    const opts=settings();
    setPhase(p,'assets');
    if(!p.prepared || p.scripts!==$('run-scripts').checked) {
      const original=await p.file.text();
      const clean=original.trim().replace(/^```[\w-]*\s*\n([\s\S]*?)\n?```\s*$/, '$1');
      p.prepared=await AutoAssets.prepare(clean,p.path,index,{executeScripts:$('run-scripts').checked});
      p.scripts=$('run-scripts').checked;
    }
    if(signal.aborted)throw new DOMException('已取消','AbortError');
    setPhase(p,measureOnly?'measurement':'capture');
    const result=await AutoCapture.capture(p.prepared.html,{...opts,...(p.override||{}),forceViewport:!!p.override,runScripts:p.scripts,signal,measureOnly,onProgress:stage=>{setPhase(p,stage==='Measuring layout…'?'measurement':stage==='Running page scripts…'?'scripts':'assets',stage);status(`${p.path} · ${stageNames[stage]||stage}`);}});
    p.measurement=result.measurement;
    p.warnings=uniqueWarnings([...(p.prepared.warnings||[]),...(result.warnings||[])]);
    if(p.measurement.confidence==='fallback')p.warnings.push({kind:'size-inferred',message:'源文件没有明确固定宽度，采用默认视口；可以在设置或尺寸覆盖中调整。'});
    if(!p.scripts && /<script\b/i.test(await p.file.text()))p.warnings.push({kind:'scripts-skipped',message:'页面脚本未执行；动态内容需要在导入设置中开启执行页面脚本。'});
    return result;
  }
  async function scan(targets=pages.filter(p=>p.state!=='done')) {
    if(busy||!targets.length)return;
    controller=new AbortController();setBusy(true);$('summary').textContent='';$('progress').max=targets.length;$('progress').value=0;
    try {
      for(const p of targets){
        if(controller.signal.aborted)break;
        p.state='checking';p.error='';p.failureStage='';p.errorCode='';setPhase(p,'checking');render();
        try{await prepare(p,controller.signal,true);p.state='ready';setPhase(p,'ready');}
        catch(e){recordFailure(p,e,'checking');}
        $('progress').value++;render();
      }
      status(controller.signal.aborted?'检查已取消。已检查页面可以导入。':`已检查 ${targets.length} 个页面。自动尺寸已就绪。`);
    } finally { for(const p of targets)if(p.state==='checking')p.state='cancelled';setBusy(false);controller=null; }
  }
  function requestImport(message, signal) {
    return new Promise((resolve,reject)=>{
      if(signal.aborted){reject(new DOMException('已取消','AbortError'));return;}
      const stage=message.type==='batch-start'?'batch-start':'figma-import';
      if(bridge.host&&bridge.host.protocolVersion!==clientBuild.protocolVersion){reject(operationError('插件界面和主程序的协议版本不匹配，请重新导入同一版本的 manifest.json。',stage,'protocol-mismatch'));return;}
      const timer=setTimeout(()=>{post({type:'cancel',jobId:message.jobId});const error=operationError(message.type==='batch-start'?'Figma 主程序未响应批次初始化（10 秒），尚未创建图层。请重新运行插件后重试。':'Figma 主程序在 180 秒内未完成页面导入，请重试。',stage,'host-timeout');if(signal.aborted){error.name='AbortError';error.code='cancelled';}finish(error);},message.type==='batch-start'?10000:180000);
      const abort=()=>{post({type:'cancel',jobId:message.jobId});};
      function finish(error,result){clearTimeout(timer);signal.removeEventListener('abort',abort);awaiting.delete(message.jobId);error?reject(error):resolve(result);}
      awaiting.set(message.jobId,{finish,expected:message.type==='batch-start'?'batch-ready':'done',stage});signal.addEventListener('abort',abort,{once:true});post(message);
    });
  }
  async function runBatch(targets=pages.filter(p=>p.selected&&p.state!=='done')) {
    if(busy||!targets.length)return;
    controller=new AbortController();const signal=controller.signal;setBusy(true);$('summary').textContent='';$('progress').max=targets.length;$('progress').value=0;
    const batchId=`batch-${Date.now()}-${++sequence}`;
    batchAttempt={id:batchId,startedAt:new Date().toISOString(),completedAt:null,state:'starting',phase:'batch-start',paths:targets.map(p=>p.path),error:'',errorCode:'',failureStage:''};
    for(const p of targets){p.error='';p.failureStage='';p.errorCode='';setPhase(p,'batch-start');}
    status('等待 Figma 主程序初始化批次…');renderReport();
    post({type:'save-settings',settings:settings()});let batchError=null;
    try {
      await requestImport({type:'batch-start',jobId:batchId,gap:settings().gap,existingNodeIds:pages.filter(p=>p.state==='done'&&p.nodeId).map(p=>p.nodeId)},signal);
      batchAttempt.state='running';batchAttempt.phase='pages';
      for(const p of targets){
        if(signal.aborted)break;
        p.state='importing';p.error='';setPhase(p,'capture');render();
        try{
          const result=await prepare(p,signal,false);
          if(signal.aborted)throw new DOMException('已取消','AbortError');
          p.jobId=`html-${Date.now()}-${++sequence}`;
          setPhase(p,'figma-import');
          status(`${p.path} · 创建 Figma 分组…`);
          const done=await requestImport({type:'import',jobId:p.jobId,tree:result.tree,images:result.images,sourceName:p.path.replace(/\.[^.]+$/,'')},signal);
          p.state='done';p.nodeId=done.nodeId;p.count=done.count;setPhase(p,'done');
          p.warnings=uniqueWarnings(p.warnings.concat((done.fontsMissing||done.missingFonts||[]).map(font=>({kind:'figma-font',reference:font,message:'Figma 未安装该字体，已使用替代字体。'})),(done.imageWarnings||[]).map(w=>typeof w==='string'?{kind:'figma-image',message:w}:w),(done.buildWarnings||[]).map(w=>typeof w==='string'?{kind:'conversion',message:w}:w)));
        } catch(e){recordFailure(p,e,'figma-import');}
        $('progress').value++;render();
      }
    } catch(e) {
      batchError=e;batchAttempt.error=e.name==='AbortError'?'':e.message;batchAttempt.failureStage=e.stage||batchAttempt.phase;batchAttempt.errorCode=e.code||'operation-failed';
      for(const p of targets)if(p.state!=='done')recordFailure(p,e,'batch-start');
    }
    finally {
      post({type:'batch-end'});
      const done=targets.filter(p=>p.state==='done').length, errors=targets.filter(p=>p.state==='error').length;
      batchAttempt.completedAt=new Date().toISOString();batchAttempt.state=signal.aborted?'cancelled':batchError?'error':errors?'partial':'done';batchAttempt.phase='finished';batchAttempt.completed=done;batchAttempt.failed=errors;
      $('summary').textContent=batchError?'导入未开始，请重试。':`本次完成 ${done} 个页面${errors?`，${errors} 个失败`:''}`;
      status(batchError?batchError.message:signal.aborted?'已取消剩余任务，已完成的分组保留。':'导入结束。可查看报告或定位分组。',!!batchError);
      setBusy(false);controller=null;
    }
  }
  async function addZip(file) {
    if(!file)return;
    status('读取 ZIP…');
    try {
      if(file.size>128*1024*1024)throw Error('ZIP 超过 128 MB，请直接选择文件夹。');
      let total=0,count=0;
      const entries=fflate.unzipSync(new Uint8Array(await file.arrayBuffer()),{filter:entry=>{
        if(entry.name.endsWith('/'))return false;
        if(/(^|\/)(\.\.|node_modules|\.git)(\/|$)/.test(entry.name)||/^[\/]|^[A-Za-z]:/.test(entry.name))return false;
        total+=entry.originalSize;count++;
        if(total>256*1024*1024||entry.originalSize>64*1024*1024||count>5000)throw Error('ZIP 展开内容过大，请直接选择文件夹。');
        return true;
      }});
      const zipFiles=Object.entries(entries).map(([path,bytes])=>{const f=new File([bytes],path.split('/').pop());Object.defineProperty(f,'webkitRelativePath',{value:path});return f;});
      await addFiles(zipFiles);
    }catch(e){status(e.message,true);}
  }
  $('pick-folder').onclick=()=>$('folder').click();$('pick-files').onclick=()=>$('files').click();$('pick-zip').onclick=()=>$('zip').click();
  $('folder').onchange=()=>addFiles($('folder').files);$('files').onchange=()=>addFiles($('files').files);$('zip').onchange=()=>addZip($('zip').files[0]);
  $('clear').onclick=()=>{files=[];index=null;pages=[];batchAttempt=null;for(const id of ['files','folder','zip'])$(id).value='';render();status('准备就绪');$('summary').textContent='';};
  $('filter').oninput=render;$('scan').onclick=()=>scan();$('import').onclick=()=>runBatch();$('retry').onclick=()=>runBatch(pages.filter(p=>p.state==='error'));
  $('cancel').onclick=()=>{if(controller){controller.abort();status('正在取消，等待当前任务清理…');}};
  $('select-all').onclick=()=>{const selected=pages.some(p=>!p.selected);pages.forEach(p=>p.selected=selected);render();};
  $('pages').onchange=e=>{const path=e.target.dataset.select;if(path){const p=pages.find(p=>p.path===path);if(p)p.selected=e.target.checked;render();}};
  $('pages').onclick=e=>{
    if(e.target.dataset.locate)post({type:'locate',nodeId:e.target.dataset.locate});
    if(e.target.dataset.apply){const p=pages.find(p=>p.path===e.target.dataset.apply);if(!p||busy)return;const row=e.target.closest('.page');const width=Number(row.querySelector('[data-width]').value),height=Number(row.querySelector('[data-height]').value);p.override=width&&height?{width:Math.max(64,Math.min(16000,width)),height:Math.max(64,Math.min(16000,height))}:null;scan([p]);}
  };
  for(const id of ['default-width','default-height','gap'])$(id).onchange=()=>{post({type:'save-settings',settings:settings()});if(id!=='gap')scan();};
  $('run-scripts').onchange=()=>{pages.filter(p=>p.state!=='done').forEach(p=>p.prepared=null);scan();};
  $('add-paste').onclick=async()=>{const text=$('paste-html').value.trim();if(!text)return;const file=new File([text],`pasted-${Date.now()}.html`,{type:'text/html'});await addFiles([file],false);$('paste-html').value='';};
  function createReport() { return {version:clientBuild.version,createdAt:new Date().toISOString(),settings:settings(),bridge:{...bridge},batch:batchAttempt?{...batchAttempt}:null,pages:pages.map(p=>({path:p.path,state:p.state,phase:p.phase,failureStage:p.failureStage,errorCode:p.errorCode,history:p.history,measurement:p.measurement,warnings:p.warnings,error:p.error,nodeId:p.nodeId,count:p.count,jobId:p.jobId}))}; }
  $('download-report').onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(createReport(),null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='html-to-figma-report.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  const zone=$('dropzone');zone.ondragover=e=>{e.preventDefault();zone.classList.add('dragging');};zone.ondragleave=()=>zone.classList.remove('dragging');
  zone.ondrop=async e=>{e.preventDefault();zone.classList.remove('dragging');if(busy)return;async function walk(entry,prefix=''){if(entry.isFile)return [await new Promise((resolve,reject)=>entry.file(f=>{Object.defineProperty(f,'webkitRelativePath',{value:prefix+f.name});resolve(f);},reject))];const reader=entry.createReader();let output=[],batch;do{batch=await new Promise((resolve,reject)=>reader.readEntries(resolve,reject));for(const child of batch)output.push(...await walk(child,prefix+entry.name+'/'));}while(batch.length);return output;}try{const items=Array.from(e.dataTransfer.items||[]);const entries=items.map(i=>i.webkitGetAsEntry&&i.webkitGetAsEntry()).filter(Boolean);if(entries.length){const collected=[];for(const entry of entries)collected.push(...await walk(entry));await addFiles(collected);}else await addFiles(e.dataTransfer.files);}catch(err){status('无法读取拖入的文件，请使用选择文件夹。'+err.message,true);}};
  function fromHost(e) {
    // Figma wraps the UI in several frames. Its host messages can originate at
    // an ancestor above the immediate parent; native dispatch may use null.
    // A page being rendered is a child frame and must never drive this bridge.
    if(e.source===null || e.source===parent)return true;
    let ancestor=parent;
    for(let depth=0;depth<10;depth++) {
      let next;try{next=ancestor.parent;}catch(_){return false;}
      if(!next || next===ancestor)return false;
      if(e.source===next)return e.origin==='https://www.figma.com';
      ancestor=next;
    }
    return false;
  }
  const isRecord=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
  const isId=value=>typeof value==='string'&&value.length>0&&value.length<=200;
  const isCount=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
  const isWarning=value=>typeof value==='string'||(isRecord(value)&&typeof value.message==='string');
  function validHostMessage(msg) {
    if(!isRecord(msg)||typeof msg.type!=='string')return false;
    if(msg.type==='host-info')return isId(msg.version)&&Number.isInteger(msg.protocolVersion)&&msg.protocolVersion>0&&(msg.build===undefined||isId(msg.build));
    if(msg.type==='settings')return msg.settings==null || (isRecord(msg.settings)&&['width','height','gap'].every(key=>msg.settings[key]===undefined||isCount(msg.settings[key])));
    if(msg.type==='batch-ready')return isId(msg.jobId);
    if(msg.type==='done')return isId(msg.jobId)&&isId(msg.nodeId)&&isCount(msg.count)&&['fontsMissing','missingFonts'].every(key=>msg[key]===undefined||(Array.isArray(msg[key])&&msg[key].every(font=>typeof font==='string')))&&['imageWarnings','buildWarnings'].every(key=>msg[key]===undefined||(Array.isArray(msg[key])&&msg[key].every(isWarning)));
    if(msg.type==='error'||msg.type==='cancelled')return isId(msg.jobId)&&(msg.message===undefined||typeof msg.message==='string')&&(msg.stage===undefined||typeof msg.stage==='string')&&(msg.code===undefined||typeof msg.code==='string');
    if(msg.type==='progress')return isId(msg.jobId)&&isCount(msg.count);
    if(msg.type==='batch-done')return isCount(msg.count);
    return false;
  }
  addEventListener('message',e=>{
    if(!fromHost(e)||!isRecord(e.data)||!Object.prototype.hasOwnProperty.call(e.data,'pluginMessage'))return;
    const msg=e.data.pluginMessage;if(!validHostMessage(msg))return;
    bridge.state='connected';bridge.received++;bridge.lastMessageAt=new Date().toISOString();bridge.receivedVia=e.source===null?'synthetic':e.source===parent?'parent':'figma-ancestor';
    if(isId(msg.version)&&Number.isInteger(msg.protocolVersion)&&msg.protocolVersion>0)bridge.host={version:msg.version,protocolVersion:msg.protocolVersion,build:msg.build||null};
    if(msg.type==='settings')applySettings(msg.settings);
    const pending=awaiting.get(msg.jobId);if(!pending)return;
    if(msg.type==='progress')status(`创建 Figma 分组… ${msg.count||''}`);
    if(msg.type===pending.expected)pending.finish(null,msg);
    if(msg.type==='error'||msg.type==='cancelled'){const error=operationError(msg.message||'导入已取消',msg.stage||pending.stage,msg.code||'host-error');if(msg.type==='cancelled'){error.name='AbortError';error.code='cancelled';}pending.finish(error);}
  });
  // Used by browser integration checks; the same methods power the visible UI.
  window.AutoImporter={addFiles,scan,runBatch,addZip,createReport,getState:()=>({busy,batch:batchAttempt,bridge:{...bridge},pages:pages.map(p=>({path:p.path,state:p.state,selected:p.selected,phase:p.phase,failureStage:p.failureStage,errorCode:p.errorCode,measurement:p.measurement,warnings:p.warnings,error:p.error,count:p.count,nodeId:p.nodeId}))})};
  post({type:'hello',...clientBuild});post({type:'load-settings'});render();
})();
