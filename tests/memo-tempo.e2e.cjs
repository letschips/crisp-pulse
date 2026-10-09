/* Failure modes BEFORE implementation:
 * A memo must become exactly one Tempo task, even after repeated clicks, a failed receipt write or a reload.
 * The task must land where Tempo's own default destination says, carry the memo text and point back to its note.
 * Tempo refusing (no license, data not saved, data unreadable) must never leave a receipt for a task that does not exist.
 * Pulse must keep working in a plain vault (no ANKS) and when Tempo is missing.
 * These workflows use OS temporary files and the real Tempo store; no user notes are touched.
 */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const tempoRoot=process.env.CRISP_TEMPO_REPO||path.resolve(__dirname,'../../crisp-tempo');
if(!fs.existsSync(path.join(tempoRoot,'node_modules/esbuild'))){test('Pulse/Tempo cross-plugin workflow',{skip:'Set CRISP_TEMPO_REPO to a source checkout with dependencies'},()=>{});return;}
const esbuild=require(path.join(tempoRoot,'node_modules/esbuild'));
class TFile{constructor(p){this.path=p;this.name=path.basename(p);this.basename=this.name.replace(/\.[^.]+$/,'');this.extension=p.split('.').pop();}}
class Plugin{constructor(app,manifest){this.app=app;this.manifest=manifest;}registerView(){}addRibbonIcon(){}addCommand(){}addSettingTab(){}register(fn){(this.__cleanup||=[]).push(fn);}registerEvent(){}}
function load(){
 const obs={Plugin,TFile,ItemView:class{},PluginSettingTab:class{},Setting:class{},Modal:class{},Notice:class{},Platform:{isMobile:false,isDesktop:true},normalizePath:p=>p,addIcon(){},setIcon(){},requestUrl:()=>Promise.reject(new Error('offline in test'))};
 const base={require:n=>n==='obsidian'?obs:require(n),console,Date,Blob,setTimeout,clearTimeout,setInterval,clearInterval,window:{setTimeout,clearTimeout,setInterval,clearInterval},document:{hidden:false},crypto:globalThis.crypto,TextEncoder,TextDecoder,Buffer,atob,btoa,AbortController,URL,structuredClone};
 const pulseCtx={...base,module:{exports:{}}};vm.runInNewContext(fs.readFileSync(process.env.PULSE_RUNTIME||path.join(__dirname,'../main.js'),'utf8'),pulseCtx);
 const build=esbuild.buildSync({stdin:{contents:'export { default as Tempo } from "./src/main"; export { TempoStore } from "./src/core/store";',resolveDir:tempoRoot,loader:'ts'},bundle:true,write:false,platform:'node',format:'cjs',external:['obsidian'],jsx:'automatic',jsxImportSource:'preact',logLevel:'silent'});
 const tempoCtx={...base,module:{exports:{}}};vm.runInNewContext('(function(){'+build.outputFiles[0].text+'})()',{...tempoCtx,exports:tempoCtx.module.exports,module:tempoCtx.module});
 return {Pulse:pulseCtx.module.exports,...tempoCtx.module.exports};
}
function fixture(t,{licensed=true,dest='inbox',daily='> [!memo] 09:00\n> 买一本《卡片笔记写作法》 #读书\n> 周末前下单\n\n> [!memo] 10:00\n> 另一条\n'}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pulse-tempo-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const files=new Map();let failMemoWrite=false,failTempoWrite=false;const triggered=[];
 const abs=p=>path.join(root,p);const read=p=>fs.readFileSync(abs(p),'utf8');
 const put=(p,c)=>{fs.mkdirSync(path.dirname(abs(p)),{recursive:true});fs.writeFileSync(abs(p),c);const f=files.get(p)||new TFile(p);files.set(p,f);return f;};
 const adapter={exists:async p=>fs.existsSync(abs(p)),read:async p=>read(p),write:async(p,c)=>{if(failTempoWrite&&p.startsWith('plugin/tempo/'))throw new Error('disk full');fs.mkdirSync(path.dirname(abs(p)),{recursive:true});fs.writeFileSync(abs(p),c);},stat:async p=>fs.existsSync(abs(p))?{size:fs.statSync(abs(p)).size,mtime:0,ctime:0,type:'file'}:null,mkdir:async p=>fs.mkdirSync(abs(p),{recursive:true}),list:async p=>({files:fs.existsSync(abs(p))?fs.readdirSync(abs(p)).map(n=>`${p}/${n}`):[],folders:[]}),remove:async p=>fs.rmSync(abs(p),{force:true}),copy:async(a,b)=>fs.copyFileSync(abs(a),abs(b))};
 const app={plugins:{plugins:{}},workspace:{trigger:name=>triggered.push(name),getLeavesOfType:()=>[],on:()=>({})},metadataCache:{getFileCache:()=>null,getFirstLinkpathDest:()=>null},vault:{adapter,configDir:'.obsidian',getAbstractFileByPath:p=>files.get(p),getMarkdownFiles:()=>[...files.values()].filter(f=>f.extension==='md'),read:async f=>read(f.path),cachedRead:async f=>read(f.path),process:async(f,fn)=>{const next=fn(read(f.path));if(failMemoWrite&&next.includes('crisp-pulse-tempo:'))throw new Error('note locked');fs.writeFileSync(abs(f.path),next);return next;}},internalPlugins:{getPluginById:()=>({enabled:true,instance:{options:{folder:'Daily',format:'YYYY-MM-DD'}}})}};
 put('Daily/2026-10-09.md','# 日记\n\n## 速记\n\n'+daily);
 put('plugin/tempo/data.json',JSON.stringify({schemaVersion:1,locale:'zh',defaultDest:dest,database:{schemaVersion:1,tasks:{},projects:{},areas:{},cycles:{},labels:{}}}));
 const loaded=load();const {Pulse,Tempo,TempoStore}=loaded;
 const pulse=new Pulse(app,{id:'crisp-pulse'});pulse.settings={memoMode:'general',memoHeading:'## 速记'};pulse.memoStore=new Pulse.memoHelpers.MemoStore(app,()=>pulse.settings);pulse.refreshMemoViews=()=>{};app.plugins.plugins['crisp-pulse']=pulse;
 let tempo;
 const makeTempo=async()=>{tempo=new Tempo(app,{id:'crisp-tempo',dir:'plugin/tempo',version:'0.2.0'});tempo.activateView=async()=>null;await tempo.onload();const store=TempoStore.get(tempo);await store.load(true);if(licensed)store.data.licenseStatus='valid';app.plugins.plugins['crisp-tempo']=tempo;return tempo;};
 const memos=()=>Pulse.memoHelpers.parseMemoBlocks(read('Daily/2026-10-09.md')).map(m=>({...m,path:'Daily/2026-10-09.md',date:'2026-10-09'}));
 const tasks=()=>Object.values(JSON.parse(read('plugin/tempo/data.json')).database.tasks);
 return {Pulse,TempoStore,app,pulse,read,put,memos,tasks,triggered,makeTempo,get tempo(){return tempo;},setMemoWriteFailure:b=>{failMemoWrite=b;},setTempoWriteFailure:b=>{failTempoWrite=b;}};
}

test('a memo becomes one Tempo task in the default destination, with its text and a link back to the note',async t=>{
 const f=fixture(t);await f.makeTempo();
 const task=await f.pulse.convertMemoToTempo(f.memos()[0]);
 const saved=f.tasks();assert.equal(saved.length,1,'任务已写进 Tempo 的 data.json');
 const [s]=saved;assert.equal(s.id,task.id);assert.equal(s.title,'买一本《卡片笔记写作法》');assert.equal(s.triage,'inbox');assert.equal(s.status,'todo');
 assert.match(s.description,/周末前下单/);assert.equal(s.notePath,'Daily/2026-10-09.md');assert.match(s.sourceId,/^crisp-pulse:[A-Za-z0-9-]+$/);
 const [memo,other]=f.memos();assert.deepEqual(JSON.parse(JSON.stringify(memo.tempoTasks)),[task.id]);assert.equal(memo.text,'买一本《卡片笔记写作法》 #读书\n周末前下单','速记正文不变');assert.equal(other.text,'另一条');
 assert(f.triggered.includes('crisp-tempo:state'),'Tempo 通知 Pulse 刷新');
});

test('Tempo set to "today" puts the task in Today',async t=>{
 const f=fixture(t,{dest:'today'});await f.makeTempo();await f.pulse.convertMemoToTempo(f.memos()[0]);
 const [s]=f.tasks();assert.equal(s.triage,'processed');assert.match(s.focusDate,/^\d{4}-\d{2}-\d{2}$/);
});

test('repeated and concurrent clicks create one task and one receipt',async t=>{
 const f=fixture(t);await f.makeTempo();const m=f.memos()[0];
 await Promise.allSettled([f.pulse.convertMemoToTempo(m),f.pulse.convertMemoToTempo(m)]);await f.pulse.convertMemoToTempo(f.memos()[0]);
 assert.equal(f.tasks().length,1);assert.equal((f.read('Daily/2026-10-09.md').match(/crisp-pulse-tempo:/g)||[]).length,1);
});

test('a failed receipt write retries without creating a second task, also after Tempo reloads',async t=>{
 const f=fixture(t);await f.makeTempo();
 const m=f.memos()[0];await f.pulse.memoStore.ensureIdentity(m);f.setMemoWriteFailure(true);
 await assert.rejects(()=>f.pulse.convertMemoToTempo(f.memos()[0]));assert.equal(f.tasks().length,1,'任务已建好');assert.doesNotMatch(f.read('Daily/2026-10-09.md'),/crisp-pulse-tempo:/);
 f.setMemoWriteFailure(false);await f.makeTempo();await f.pulse.convertMemoToTempo(f.memos()[0]);
 assert.equal(f.tasks().length,1);assert.equal((f.read('Daily/2026-10-09.md').match(/crisp-pulse-tempo:/g)||[]).length,1);
});

test('Tempo without a license or failing to save never leaves a receipt',async t=>{
 const a=fixture(t,{licensed:false});await a.makeTempo();
 await assert.rejects(()=>a.pulse.convertMemoToTempo(a.memos()[0]),/激活/);assert.equal(a.tasks().length,0);assert.doesNotMatch(a.read('Daily/2026-10-09.md'),/crisp-pulse-tempo:/);
 const b=fixture(t);await b.makeTempo();b.setTempoWriteFailure(true);
 await assert.rejects(()=>b.pulse.convertMemoToTempo(b.memos()[0]),/保存/);assert.doesNotMatch(b.read('Daily/2026-10-09.md'),/crisp-pulse-tempo:/);
 b.setTempoWriteFailure(false);await b.pulse.convertMemoToTempo(b.memos()[0]);assert.equal(b.tasks().length,1,'修好后重试只建一条');
});

test('Pulse sees task status changes and deletions made in Tempo',async t=>{
 const f=fixture(t);await f.makeTempo();const task=await f.pulse.convertMemoToTempo(f.memos()[0]);
 const sourceId=f.tasks()[0].sourceId;let snap=await f.tempo.getTasksBySource([sourceId]);assert.equal(snap[sourceId].status,'todo');
 const store=f.TempoStore.get(f.tempo);store.updateDatabase(db=>({...db,tasks:{...db.tasks,[task.id]:{...db.tasks[task.id],status:'done',completedAt:Date.now()}}}));
 snap=await f.tempo.getTasksBySource([sourceId]);assert.equal(snap[sourceId].status,'done');
 assert.equal(f.Pulse.memoHelpers.memoTempoLabel(snap[sourceId]),'已完成');
 store.updateDatabase(db=>{const tasks={...db.tasks};delete tasks[task.id];return {...db,tasks};});
 snap=await f.tempo.getTasksBySource([sourceId]);assert.equal(snap[sourceId],undefined);assert.equal(f.Pulse.memoHelpers.memoTempoLabel(undefined),'任务已删除');
});

test('task titles come from the first meaningful line; images, tags and markup are dropped',()=>{
 const {memoTaskTitle}=load().Pulse.memoHelpers;
 assert.equal(memoTaskTitle('**联系** [[张三|老张]] 确认报价 #工作\n细节'),'联系 老张 确认报价');
 assert.equal(memoTaskTitle('![[a.png]]\n- 整理照片'),'整理照片');
 assert.equal(memoTaskTitle('![[录音 20261009.webm]]',{date:'2026-10-09',time:'16:56'}),'速记 2026-10-09 16:56');
 const long=memoTaskTitle('很长'.repeat(60));assert(long.length<=61&&long.endsWith('…'));
});

test('without Tempo, Pulse offers no task conversion and reports a clear reason',async t=>{
 const f=fixture(t);assert.equal(f.pulse.memoTempo(),null);
 await assert.rejects(()=>f.pulse.convertMemoToTempo(f.memos()[0]),/Crisp Tempo 0\.2\.0/);assert.doesNotMatch(f.read('Daily/2026-10-09.md'),/crisp-pulse-tempo:/);
});

test('after the task is deleted in Tempo, converting again creates one new task and keeps the old receipt harmless',async t=>{
 const f=fixture(t);await f.makeTempo();const first=await f.pulse.convertMemoToTempo(f.memos()[0]);
 const store=f.TempoStore.get(f.tempo);store.updateDatabase(db=>{const tasks={...db.tasks};delete tasks[first.id];return {...db,tasks};});await store.flush();
 const second=await f.pulse.convertMemoToTempo(f.memos()[0]);assert.notEqual(second.id,first.id);
 assert.equal(f.tasks().length,1);const m=f.memos()[0];assert.deepEqual(JSON.parse(JSON.stringify(m.tempoTasks)),[first.id,second.id]);
 const snap=await f.tempo.getTasksBySource([`crisp-pulse:${m.id}`]);assert.equal(snap[`crisp-pulse:${m.id}`].id,second.id);
});
