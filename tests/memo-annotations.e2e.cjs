/* Failure modes BEFORE implementation:
 * One click on an annotation must become exactly one memo, even after repeated or concurrent clicks, or after the memo moved to another note.
 * The memo must keep the user's own note apart from the quoted source text, link back to the source note and heading, and stay readable without Annotations.
 * Quoted or annotated text must never be parsed as a second memo, a conversion backlink or a hidden receipt.
 * Importing must not count as the user's own writing; editing the annotation later must be reported, never silently rewrite the memo.
 * Missing / older Pulse, a newer request version or a stale annotation must fail clearly without touching any note.
 * These workflows use OS temporary files and the real Pulse store in plain (non-ANKS) mode; no user notes are touched.
 */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const annRoot=process.env.CRISP_ANNOTATIONS_REPO||path.resolve(__dirname,'../../crisp-annotations');
if(!fs.existsSync(path.join(annRoot,'node_modules/esbuild'))){test('Pulse/Annotations cross-plugin workflow',{skip:'Set CRISP_ANNOTATIONS_REPO to a source checkout with dependencies'},()=>{});return;}
const esbuild=require(path.join(annRoot,'node_modules/esbuild'));
class TFile{constructor(p){this.path=p;this.name=path.basename(p);this.basename=this.name.replace(/\.[^.]+$/,'');this.extension=p.split('.').pop();}}
class Plugin{constructor(app,manifest){this.app=app;this.manifest=manifest;}registerView(){}addRibbonIcon(){}addCommand(){}addSettingTab(){}register(fn){(this.__cleanup||=[]).push(fn);}registerEvent(){}}
function load(){
 const obs={Plugin,TFile,ItemView:class{},PluginSettingTab:class{},Setting:class{},Modal:class{},Notice:class{},Platform:{isMobile:false,isDesktop:true},normalizePath:p=>p,addIcon(){},setIcon(){},requestUrl:()=>Promise.reject(new Error('offline in test'))};
 const base={require:n=>n==='obsidian'?obs:require(n),console,Date,Blob,setTimeout,clearTimeout,setInterval,clearInterval,window:{setTimeout,clearTimeout,setInterval,clearInterval},document:{hidden:false},crypto:globalThis.crypto,TextEncoder,TextDecoder,Buffer,atob,btoa,AbortController,URL,structuredClone};
 const pulseCtx={...base,module:{exports:{}}};vm.runInNewContext(fs.readFileSync(process.env.PULSE_RUNTIME||path.join(__dirname,'../main.js'),'utf8'),pulseCtx);
 const build=esbuild.buildSync({stdin:{contents:'export * from "./src/pulse-memo"; export { findAnnotations } from "./src/annotation-syntax";',resolveDir:annRoot,loader:'ts'},bundle:true,write:false,platform:'node',format:'cjs',external:['obsidian'],logLevel:'silent'});
 const annCtx={...base,module:{exports:{}}};vm.runInNewContext('(function(){'+build.outputFiles[0].text+'})()',{...annCtx,exports:annCtx.module.exports,module:annCtx.module});
 return {Pulse:pulseCtx.module.exports,Ann:annCtx.module.exports};
}
const ARTICLE='# 卡片笔记\n\n## 第一节\n\n==写作不是从空白页开始=={ann note="同意，先有素材再写"}\n\n## 第二节\n\n==写作不是从空白页开始=={ann note="第二处同样的句子" color=blue}\n';
function fixture(t,{pulse:withPulse=true}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pulse-ann-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const files=new Map();const abs=p=>path.join(root,p);const read=p=>fs.readFileSync(abs(p),'utf8');
 const put=(p,c)=>{fs.mkdirSync(path.dirname(abs(p)),{recursive:true});fs.writeFileSync(abs(p),c);const f=files.get(p)||new TFile(p);files.set(p,f);return f;};
 const adapter={exists:async p=>fs.existsSync(abs(p)),read:async p=>read(p),write:async(p,c)=>{fs.mkdirSync(path.dirname(abs(p)),{recursive:true});fs.writeFileSync(abs(p),c);},mkdir:async p=>fs.mkdirSync(abs(p),{recursive:true}),list:async()=>({files:[],folders:[]}),remove:async p=>fs.rmSync(abs(p),{force:true})};
 const writes=[];
 const app={plugins:{plugins:{}},workspace:{trigger(){},getLeavesOfType:()=>[],on:()=>({})},metadataCache:{getFileCache:()=>null,getFirstLinkpathDest:()=>null},
  fileManager:{generateMarkdownLink:(file,_from,subpath='')=>`[[${file.basename}${subpath}]]`},
  vault:{adapter,configDir:'.obsidian',getAbstractFileByPath:p=>files.get(p),getMarkdownFiles:()=>[...files.values()].filter(f=>f.extension==='md'),read:async f=>read(f.path),cachedRead:async f=>read(f.path),
   create:async(p,c)=>{writes.push(p);return put(p,c);},createFolder:async p=>fs.mkdirSync(abs(p),{recursive:true}),process:async(f,fn)=>{const next=fn(read(f.path));writes.push(f.path);fs.writeFileSync(abs(f.path),next);return next;}},
  internalPlugins:{getPluginById:()=>({enabled:true,instance:{options:{folder:'Daily',format:'YYYY-MM-DD'}}})}};
 put('Reading/卡片笔记.md',ARTICLE);
 const {Pulse,Ann}=load();
 let pulse=null;const evidence=[];
 if(withPulse){pulse=new Pulse(app,{id:'crisp-pulse'});pulse.settings={memoMode:'general',memoHeading:'## 速记'};pulse.memoStore=new Pulse.memoHelpers.MemoStore(app,()=>pulse.settings,null,{onOwnWrite:p=>evidence.push(p)});pulse.markWritingEvidence=p=>evidence.push(p);pulse.refreshMemoViews=()=>{};app.plugins.plugins['crisp-pulse']=pulse;}
 const headings=src=>[...src.matchAll(/^(#{1,6}) (.+)$/gm)].map(m=>({heading:m[2],level:m[1].length,position:{start:{offset:m.index}}}));
 const send=(n=0,p='Reading/卡片笔记.md')=>{const source=read(p);const reference=Ann.findAnnotations(source)[n];return Ann.sendAnnotationToPulse(app,{path:p,source,reference,headings:headings(source)});};
 const memos=async()=>{pulse.memoStore.parsed?.clear();return pulse.memoStore.list();};
 const allMemos=()=>[...files.values()].filter(f=>f.extension==='md').flatMap(f=>Pulse.memoHelpers.parseMemoBlocks(read(f.path)).map(m=>({...m,path:f.path})));
 return {Pulse,Ann,app,pulse,read,put,files,send,memos,allMemos,evidence,writes};
}

test('an annotation becomes one memo: own note first, quote kept apart, a link back to the heading, and no writing credit',async t=>{
 const f=fixture(t);
 const result=await f.send(0);
 assert.equal(result.status,'created');assert.equal(result.changed,false);
 const list=await f.memos();assert.equal(list.length,1);const [m]=list;
 assert.equal(m.id,result.memo.id);assert.equal(m.path,result.memo.path);assert.match(m.path,/^Daily\/\d{4}-\d{2}-\d{2}\.md$/);
 assert.equal(m.text,'同意，先有素材再写\n\n> 写作不是从空白页开始\n\n出处：[[卡片笔记#第一节]]');
 assert.equal(m.sources.length,1);assert.match(m.sources[0].id,/^crisp-annotations:[0-9a-f]{16}$/);
 assert.deepEqual(JSON.parse(JSON.stringify(m.links)),[],'出处不是转化回链');
 assert.deepEqual(f.evidence,[],'导入不算本人写作');
});

test('repeated and concurrent clicks keep one memo; editing the note later reports a change and leaves the memo as it was',async t=>{
 const f=fixture(t);
 const [a,b]=await Promise.all([f.send(0),f.send(0)]);assert.deepEqual(new Set([a.status,b.status]),new Set(['created','existing']));
 const again=await f.send(0);assert.equal(again.status,'existing');assert.equal(again.changed,false);assert.equal(again.memo.id,a.memo.id);
 assert.equal((await f.memos()).length,1);
 f.put('Reading/卡片笔记.md',f.read('Reading/卡片笔记.md').replace('同意，先有素材再写','改过的批注'));
 const edited=await f.send(0);assert.equal(edited.status,'existing');assert.equal(edited.changed,true);
 const [m]=await f.memos();assert.match(m.text,/^同意，先有素材再写/,'原卡不被改写');
});

test('a memo moved to another note is still found instead of duplicated',async t=>{
 const f=fixture(t);const first=await f.send(0);
 const daily=f.read(first.memo.path);f.put(first.memo.path,'# 日记\n');f.put('Notes/整理.md',daily);
 const again=await f.send(0);assert.equal(again.status,'existing');assert.equal(again.memo.path,'Notes/整理.md');
 assert.equal(f.allMemos().length,1);
});

test('the same sentence annotated twice, or in another note, makes separate memos',async t=>{
 const f=fixture(t);const one=await f.send(0);const two=await f.send(1);
 f.put('Reading/另一篇.md','==写作不是从空白页开始=={ann note="同意，先有素材再写"}\n');const three=await f.send(0,'Reading/另一篇.md');
 assert.equal(new Set([one.memo.id,two.memo.id,three.memo.id]).size,3);
 const list=await f.memos();assert.equal(list.length,3);assert(list.some(m=>m.text.endsWith('出处：[[卡片笔记#第二节]]')));
 assert(list.some(m=>m.text.endsWith('出处：[[另一篇]]')),'没有标题时只链到笔记');
});

test('quotes and notes that look like memo syntax stay text; multi-line quotes stay inside one quote block',async t=>{
 const f=fixture(t);
 f.put('Reading/卡片笔记.md','==第一行\n\n> [!memo] 09:00\n→ [[伪回链]]=={ann note="[!memo] 10:00"}\n');
 await f.send(0);
 const list=await f.memos();assert.equal(list.length,1);const [m]=list;
 assert.deepEqual(JSON.parse(JSON.stringify(m.links)),[]);assert.equal(m.tempoTasks,undefined);
 assert.match(m.text,/^\\\[!memo\] 10:00\n\n> 第一行\n>\n> > \[!memo\] 09:00\n> → \[\[伪回链\]\]/);
});

test('without Pulse, with an older Pulse or a newer request version nothing is written and the reason is clear',async t=>{
 const none=fixture(t,{pulse:false});
 assert.equal(none.Ann.findPulseMemoApi(none.app),null);
 await assert.rejects(()=>none.send(0),/Crisp Pulse 1\.20\.0/);assert.deepEqual(none.writes,[]);
 const old=fixture(t);old.app.plugins.plugins['crisp-pulse']={convertMemoToTempo(){}};
 await assert.rejects(()=>old.send(0),/Crisp Pulse 1\.20\.0/);
 const f=fixture(t);
 await assert.rejects(()=>f.pulse.captureMemoFromSource({apiVersion:2,sourceId:'crisp-annotations:0000000000000000',note:'x',quote:'',sourcePath:null,subpath:null}),/更新 Crisp Pulse/);
 await assert.rejects(()=>f.pulse.captureMemoFromSource({apiVersion:1,sourceId:'bad id',note:'x',quote:''}),/来源标识/);
 await assert.rejects(()=>f.pulse.captureMemoFromSource({apiVersion:1,sourceId:'crisp-annotations:0000000000000000',note:' ',quote:''}),/为空/);
 assert.deepEqual(f.writes,[]);
});

test('an annotation that changed or disappeared since the panel was drawn is refused',async t=>{
 const f=fixture(t);const source=f.read('Reading/卡片笔记.md');const reference=f.Ann.findAnnotations(source)[0];
 f.put('Reading/卡片笔记.md','# 卡片笔记\n\n没有标注了\n');
 const now=f.read('Reading/卡片笔记.md');
 await assert.rejects(()=>f.Ann.sendAnnotationToPulse(f.app,{path:'Reading/卡片笔记.md',source:now,reference,headings:[]}),/标注内容已经变化/);
 assert.equal(f.allMemos().length,0);
});

test('revealMemo opens the memo panel filtered to that one memo',async t=>{
 const f=fixture(t);const r=await f.send(0);
 const focused=[];let activated=0;
 f.pulse.activateMemoView=async()=>{activated++;};
 f.app.workspace.getLeavesOfType=()=>[{view:{focusMemo:id=>focused.push(id)}}];
 await f.pulse.revealMemo(r.memo);
 assert.equal(activated,1);assert.deepEqual(focused,[r.memo.id]);
});
