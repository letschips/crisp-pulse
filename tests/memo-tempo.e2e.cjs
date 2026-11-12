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
 const build=esbuild.buildSync({stdin:{contents:'export { default as Tempo } from "./src/main"; export { TempoStore } from "./src/core/store";',resolveDir:tempoRoot,loader:'ts'},bundle:true,write:false,platform:'node',format:'cjs',external:['obsidian'],alias:{'tempo-apple-helper':path.join(__dirname,'fixtures/tempo-apple-helper.stub.js')},jsx:'automatic',jsxImportSource:'preact',logLevel:'silent'});
 const tempoCtx={...base,module:{exports:{}}};vm.runInNewContext('(function(){'+build.outputFiles[0].text+'})()',{...tempoCtx,exports:tempoCtx.module.exports,module:tempoCtx.module});
 return {Pulse:pulseCtx.module.exports,...tempoCtx.module.exports};
}
function fixture(t,{licensed=true,dest='inbox',daily='> [!memo] 09:00\n> 买一本《卡片笔记写作法》 #读书\n> 周末前下单\n\n> [!memo] 10:00\n> 另一条\n'}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pulse-tempo-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const files=new Map();let failMemoWrite=false,failTempoWrite=false;const triggered=[];
 const abs=p=>path.join(root,p);const read=p=>fs.readFileSync(abs(p),'utf8');
 const put=(p,c)=>{fs.mkdirSync(path.dirname(abs(p)),{recursive:true});fs.writeFileSync(abs(p),c);const f=files.get(p)||new TFile(p);files.set(p,f);return f;};
 const adapter={exists:async p=>fs.existsSync(abs(p)),read:async p=>read(p),write:async(p,c)=>{if(failTempoWrite&&p.startsWith('plugin/tempo/'))throw new Error('disk full');fs.mkdirSync(path.dirname(abs(p)),{recursive:true});fs.writeFileSync(abs(p),c);},stat:async p=>fs.existsSync(abs(p))?{size:fs.statSync(abs(p)).size,mtime:0,ctime:0,type:'file'}:null,mkdir:async p=>fs.mkdirSync(abs(p),{recursive:true}),list:async p=>({files:fs.existsSync(abs(p))?fs.readdirSync(abs(p)).map(n=>`${p}/${n}`):[],folders:[]}),remove:async p=>fs.rmSync(abs(p),{force:true}),copy:async(a,b)=>fs.copyFileSync(abs(a),abs(b))};
 const app={plugins:{plugins:{}},workspace:{trigger:name=>triggered.push(name),getLeavesOfType:()=>[],on:()=>({}),onLayoutReady:fn=>fn()},metadataCache:{getFileCache:()=>null,getFirstLinkpathDest:()=>null},vault:{adapter,configDir:'.obsidian',getAbstractFileByPath:p=>files.get(p),getMarkdownFiles:()=>[...files.values()].filter(f=>f.extension==='md'),read:async f=>read(f.path),cachedRead:async f=>read(f.path),process:async(f,fn)=>{const next=fn(read(f.path));if(failMemoWrite&&next.includes('crisp-pulse-tempo:'))throw new Error('note locked');fs.writeFileSync(abs(f.path),next);return next;}},internalPlugins:{getPluginById:()=>({enabled:true,instance:{options:{folder:'Daily',format:'YYYY-MM-DD'}}})}};
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

/* Tempo 完成的任务出现在 Pulse 当日明细（Tempo 0.10.0 getCompletedOn + Pulse 1.35.0），只展示、不计分。失败模式：
 * - 列出了别的日子完成的、已取消的或已删除的任务；子任务看不出属于哪件事。
 * - 把 Tempo 的完成数加进 Pulse 的「完成任务」或贡献分（会被新建再勾掉刷分）。
 * - Tempo 缺失、旧版、返回坏数据时 Pulse 报错，而不是安静地不显示。 */
test('Pulse lists the Tempo tasks finished on a day, without scoring them',async t=>{
 const f=fixture(t);await f.makeTempo();
 const store=f.TempoStore.get(f.tempo);
 const day=new Date(2026,9,28,15,30).getTime(),dayKey='2026-10-28';
 const mk=(id,title,x={})=>({id,title,status:'done',triage:'processed',availability:'anytime',priority:'none',createdAt:1,updatedAt:1,order:id,completedAt:day,...x});
 store.updateDatabase(db=>({...db,projects:{p:{id:'p',title:'产品方案',status:'active',priority:'none',createdAt:1,updatedAt:1,order:'a'}},tasks:{
   a:mk('a','写方案',{projectId:'p',completedAt:day+60000}),
   b:mk('b','改错别字',{completedAt:day-3600000}),
   parent:mk('parent','准备分享',{status:'todo',completedAt:undefined}),
   sub:mk('sub','做幻灯片',{parentTaskId:'parent'}),
   y:mk('y','昨天做完的',{completedAt:day-86400000}),
   c:mk('c','取消的',{status:'canceled',completedAt:undefined,canceledAt:day}),
 }}),false);await store.flush();
 const api=await f.tempo.getCompletedOn(dayKey);
 assert.deepEqual(JSON.parse(JSON.stringify(api.tasks.map(x=>[x.id,x.title,x.parentTitle??null,x.projectTitle??null]))),
   [['b','改错别字',null,null],['sub','做幻灯片','准备分享',null],['a','写方案',null,'产品方案']],'按完成时间排，只有那天完成的');
 const rows=await f.pulse.tempoCompletedOn(dayKey);
 assert.deepEqual(JSON.parse(JSON.stringify(rows.map(r=>[r.id,r.label,r.time]))),[['b','改错别字','14:30'],['sub','准备分享 › 做幻灯片','15:30'],['a','写方案','15:31']]);
 assert.equal(rows[2].project,'产品方案');
 const rec=f.pulse.store?.daily?.[dayKey];assert.ok(!rec||!(rec.contribution?.tasksCompleted>0),'不计入 Pulse 的完成任务');
});

test('without Tempo, with an older one or with bad data, Pulse shows no Tempo list and does not throw',async t=>{
 const f=fixture(t);
 assert.deepEqual(JSON.parse(JSON.stringify(await f.pulse.tempoCompletedOn('2026-10-28'))),[]);
 f.app.plugins.plugins['crisp-tempo']={getCompletedToday:async()=>({count:1})};
 assert.deepEqual(JSON.parse(JSON.stringify(await f.pulse.tempoCompletedOn('2026-10-28'))),[],'旧版没有接口');
 f.app.plugins.plugins['crisp-tempo']={getCompletedOn:async()=>({tasks:[{id:'x',title:42},null,{id:'ok',title:'好的',completedAt:Date.now()}]})};
 assert.deepEqual(JSON.parse(JSON.stringify((await f.pulse.tempoCompletedOn('2026-10-28')).map(r=>r.id))),['ok'],'坏条目丢掉');
 f.app.plugins.plugins['crisp-tempo']={getCompletedOn:async()=>{throw new Error('reloading');}};
 assert.deepEqual(JSON.parse(JSON.stringify(await f.pulse.tempoCompletedOn('2026-10-28'))),[]);
});

/* 速记卡片上的截止倒计时（Pulse 1.46.0，读 Tempo 0.13.0 起的 getActionOverview）。失败模式：
 * - 已完成、已取消、已删除的任务还在倒计时；没有截止日期或日期格式不对时显示成「还剩 NaN 天」。
 * - 今天、明天落成「还剩 0 天」「还剩 1 天」；逾期和快到期用同一种颜色；跨月、夏令时差一天。
 * - Tempo 旧版没有这个接口、接口抛错或给了坏数据时，卡片连任务状态也不显示了。
 * - 拿到了别的任务（不是这条速记转出来的）的截止日期。
 */
test('the countdown follows the task due date and stops once the task is closed',()=>{
 const {memoTempoDue}=load().Pulse.memoHelpers;const T='2026-11-11';const open={id:'t',status:'todo',title:'x'};
 assert.deepEqual({...memoTempoDue(open,'2026-11-09',T)},{text:'逾期 2 天',tone:'is-overdue'});
 assert.deepEqual({...memoTempoDue(open,'2026-11-11',T)},{text:'今天截止',tone:'is-soon'});
 assert.deepEqual({...memoTempoDue(open,'2026-11-12',T)},{text:'明天截止',tone:'is-soon'});
 assert.deepEqual({...memoTempoDue({...open,status:'waiting'},'2026-11-14',T)},{text:'还剩 3 天',tone:'is-soon'});
 assert.deepEqual({...memoTempoDue({...open,status:'in_progress'},'2026-12-01',T)},{text:'还剩 20 天',tone:''});
 assert.equal(memoTempoDue(open,'2026-11-02','2026-10-31').text,'还剩 2 天','美国夏令时结束那天不差一天');
 for(const status of ['done','canceled'])assert.equal(memoTempoDue({...open,status},'2026-11-12',T),null);
 assert.equal(memoTempoDue(undefined,'2026-11-12',T),null,'任务已删除');
 for(const bad of [undefined,'','11/12','2026-13-40x',20261112])assert.equal(memoTempoDue(open,bad,T),null);
});

test('due dates come from Tempo for converted memos only, and a Tempo that cannot answer just gives none',async t=>{
 const f=fixture(t);assert.deepEqual({...await f.pulse.memoTempoDueDates()},{}, '没有 Tempo');
 await f.makeTempo();const task=await f.pulse.convertMemoToTempo(f.memos()[0]);const sourceId=f.tasks()[0].sourceId;
 assert.deepEqual({...await f.pulse.memoTempoDueDates()},{}, '没设截止日期');
 const store=f.TempoStore.get(f.tempo);
 store.updateDatabase(db=>({...db,tasks:{...db.tasks,[task.id]:{...db.tasks[task.id],dueDate:'2026-11-20'},other:{...db.tasks[task.id],id:'other',sourceId:undefined,dueDate:'2026-11-12'},foreign:{...db.tasks[task.id],id:'foreign',sourceId:'crisp-annotations:abc',dueDate:'2026-11-13'}}}));
 assert.deepEqual({...await f.pulse.memoTempoDueDates()},{[sourceId]:'2026-11-20'});
 const real=f.tempo.getActionOverview;
 f.tempo.getActionOverview=async()=>{throw new Error('boom');};assert.deepEqual({...await f.pulse.memoTempoDueDates()},{});
 f.tempo.getActionOverview=async()=>({tasks:[null,{sourceId},{sourceId,dueDate:'soon'},'x']});assert.deepEqual({...await f.pulse.memoTempoDueDates()},{});
 f.tempo.getActionOverview=undefined;assert.deepEqual({...await f.pulse.memoTempoDueDates()},{}, '旧版 Tempo');
 f.tempo.getActionOverview=real;
});

/* 记录时直接转为任务（输入框「记为任务」开关、⌘⏎、URL task=1）。失败模式：
 * - 速记和任务各写一半：任务建了速记没回执，或回执写进了别的速记。
 * - Tempo 拒绝（未激活、保存失败）时把用户刚写的速记也弄丢了。
 * - 没装 Tempo 时照样写速记却悄悄不建任务，用户以为已经建好。
 * - 转任务的速记不再算本人写作。 */
test('capturing as a task writes one memo with its receipt and one Tempo task',async t=>{
 const f=fixture(t);await f.makeTempo();const own=[];f.pulse.memoStore.onOwnWrite=p=>own.push(p);
 const {memo,task}=await f.pulse.captureMemoAsTask('订一下周六的场地 #活动\n问清押金',new Date(2026,9,9,11,5));
 assert.equal(memo.path,'Daily/2026-10-09.md');assert.deepEqual(own,['Daily/2026-10-09.md'],'算本人写作');
 const all=f.memos();assert.equal(all.length,3,'原有两条不动');const m=all.find(x=>x.id===memo.id);
 assert.equal(m.time,'11:05');assert.equal(m.text,'订一下周六的场地 #活动\n问清押金');assert.deepEqual(JSON.parse(JSON.stringify(m.tempoTasks)),[task.id]);
 const [s]=f.tasks();assert.equal(f.tasks().length,1);assert.equal(s.title,'订一下周六的场地');assert.equal(s.sourceId,`crisp-pulse:${memo.id}`);
});

test('when Tempo refuses, the memo is still saved and can be converted later from its card',async t=>{
 const f=fixture(t,{licensed:false});await f.makeTempo();
 await assert.rejects(()=>f.pulse.captureMemoAsTask('给房东打电话',new Date(2026,9,9,12,0)),/已记下/);
 const m=f.memos().find(x=>x.text==='给房东打电话');assert.ok(m,'速记没丢');assert.ok(m.id);assert.equal(f.tasks().length,0);assert.doesNotMatch(f.read('Daily/2026-10-09.md'),/crisp-pulse-tempo:/);
 f.TempoStore.get(f.tempo).data.licenseStatus='valid';await f.pulse.convertMemoToTempo(m);assert.equal(f.tasks().length,1,'之后从卡片菜单转只建一条');
});

test('without Tempo, capturing as a task writes nothing and says why',async t=>{
 const f=fixture(t);const before=f.read('Daily/2026-10-09.md');
 await assert.rejects(()=>f.pulse.captureMemoAsTask('不该写进去',new Date(2026,9,9,12,0)),/Crisp Tempo 0\.2\.0/);
 assert.equal(f.read('Daily/2026-10-09.md'),before);
});

test('the memo URL accepts task=1',()=>{
 const {parseMemoUrlParams}=load().Pulse.memoHelpers;
 assert.equal(parseMemoUrlParams({text:'买牛奶',task:'1'}).task,true);
 assert.equal(parseMemoUrlParams({text:'买牛奶'}).task,false);
 assert.equal(parseMemoUrlParams({task:'1'}).task,false,'没有正文时只打开面板');
});

/* 卡片上的倒计时取自这条任务自己的状态（1.48.1）。1.46.0 读的是 getActionOverview，它不含「将来也许」里的任务和子任务，
   这些任务设了截止日期也不显示倒计时。Tempo 0.17.0 起 getTasksBySource 的快照里带 dueDate，直接用它；更旧的 Tempo 仍读概览。 */
function chipRow(texts){
 const el={disabled:false,addClass(){},toggleClass(){},setAttribute(){},addEventListener(){},createSpan(o={}){if(o.text)texts.push(o.text);return el;},createEl(){return el;}};
 return {isConnected:true,empty(){texts.length=0;},createEl(){return el;}};
}
test('a converted memo shows its own task countdown, also when the task sits in Someday',async t=>{
 const f=fixture(t);await f.makeTempo();const task=await f.pulse.convertMemoToTempo(f.memos()[0]);
 const store=f.TempoStore.get(f.tempo);
 store.updateDatabase(db=>({...db,tasks:{...db.tasks,[task.id]:{...db.tasks[task.id],availability:'someday',dueDate:'2099-01-01'}}}));
 let overviewCalls=0;const real=f.tempo.getActionOverview.bind(f.tempo);f.tempo.getActionOverview=async()=>{overviewCalls++;return real();};
 const texts=[];const v=Object.create(f.Pulse.CrispPulseMemoView.prototype);
 Object.assign(v,{plugin:f.pulse,memoClosed:false,memoTempoRows:new Map([[chipRow(texts),f.memos()[0]]])});
 await v.refreshTempoChips();
 assert.match(texts.join(' '),/^Tempo · 待办 · 还剩 \d+ 天$/);
 assert.equal(overviewCalls,0,'新版 Tempo 不再读概览');
});
