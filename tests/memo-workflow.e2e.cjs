/* Failure modes, before implementation:
 * Failed capture must retain the modal and draft; repeated submission must not duplicate writes.
 * A fenced example must never enter the timeline or be changed by tag/delete actions.
 * Converting a memo must keep its source Topic, exact backlink and one durable destination.
 * A failed backlink followed by retry/reload must not duplicate notes or Now tasks.
 * Already completed Now tasks must remain completed on retry.
 * Reject an edited source before producing a destination; do not delete partial/stale blocks.
 * Filesystem-backed workflow tests run only in an OS temporary directory, never a user vault.
 */
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
class El{constructor(tag){this.tag=tag;this.children=[];this.events={};this.value='';this.disabled=false;this.style={};this.classList={add(){},remove(){}};}addClass(){}setAttribute(){}createEl(tag,opts){const x=new El(tag);x.opts=opts;this.children.push(x);return x;}createDiv(opts){return this.createEl('div',opts);}addEventListener(k,fn){this.events[k]=fn;}empty(){this.children=[];}focus(){}select(){}}
class Modal{constructor(app){this.app=app;this.contentEl=new El('div');this.closed=false;}close(){this.closed=true;this.onClose();}}
class TFile{constructor(p){this.path=p;this.extension='md';this.basename=p.split('/').pop().replace(/\.md$/,'');}}
const context={module:{exports:{}},require:()=>({Plugin:class{},ItemView:class{},PluginSettingTab:class{},Modal,TFile,Notice:class{},Setting:class{},addIcon(){}}),console,Date,window:{setTimeout,clearTimeout,setInterval,clearInterval},setTimeout,clearTimeout,document:{hidden:false},crypto:globalThis.crypto,TextEncoder,TextDecoder,Buffer,atob};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../main.js'),'utf8')+'\nmodule.exports.AuditModal=CrispPulseMemoInputModal;',context);
const P=context.module.exports,H=P.memoHelpers,observations=[];
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pulse-memo-workflow-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const files=new Map(),folders=new Set(),queues=new Map();
 function put(p,c){fs.mkdirSync(path.dirname(path.join(root,p)),{recursive:true});fs.writeFileSync(path.join(root,p),c);const f=files.get(p)||new TFile(p);files.set(p,f);return f;}
 const read=f=>fs.readFileSync(path.join(root,f.path),'utf8');
 const app={vault:{getAbstractFileByPath:p=>files.get(p)||(folders.has(p)?{path:p,children:[]}:null),getMarkdownFiles:()=>[...files.values()].filter(f=>f.path.endsWith('.md')),read:async f=>read(f),cachedRead:async f=>read(f),create:async(p,c)=>{assert(!files.has(p),'destination overwrite');return put(p,c);},createFolder:async p=>{folders.add(p);fs.mkdirSync(path.join(root,p),{recursive:true});},process:(f,fn)=>{const job=(queues.get(f.path)||Promise.resolve()).then(()=>{const c=fn(read(f));put(f.path,c);return c;});queues.set(f.path,job.catch(()=>{}));return job;},adapter:{exists:async p=>fs.existsSync(path.join(root,p)),read:async p=>fs.readFileSync(path.join(root,p),'utf8')}},metadataCache:{getFileCache:f=>({frontmatter:{memo_date:'2026-10-08',topic:f.path.split('/')[1]}})},internalPlugins:{getPluginById:()=>({enabled:true,instance:{options:{folder:'Daily',format:'YYYY-MM-DD'}}})},fileManager:{getNewFileParent:()=>({path:'Notes'})},workspace:{getLeaf:()=>({openFile:async()=>{}})}};
 const settings={memoMode:'anks',memoAnksTopic:'self-media'};
 put('Topics/main-business/raw/inbox/scratch/2026-10-08 速记.md','> [!memo] 10:00\n> 供应链问题 #工作\n');
 put('Topics/self-media/raw/inbox/other.md','other');put('Now/行动.md','# 行动\n');
 put('Sidecar/tools/capture-metadata/contract.json',JSON.stringify({contract:'test',routing:{'pulse-memo':{inbox_type:'scratch'}}}));
 const make=()=>{const p=Object.create(P.prototype);p.app=app;p.settings=settings;p.memoStore=new H.MemoStore(app,()=>settings);return p;};
 const source=files.get('Topics/main-business/raw/inbox/scratch/2026-10-08 速记.md');
 const memo=()=>({...H.parseMemoBlocks(read(source))[0],path:source.path,date:'2026-10-08'});
 return {root,files,app,read,put,source,memo,make,p:make()};
}
test('save failure retains the quick modal and draft, then retries successfully',async()=>{
 let fail=true;const modal=new P.AuditModal({},'速记','输入','',async()=>{if(fail)throw new Error('disk unavailable');});modal.onOpen();
 const input=modal.contentEl.children.find(x=>x.tag==='textarea');input.value='不可丢的想法';
 const row=modal.contentEl.children.find(x=>x.tag==='div'&&x.children.some(c=>c.tag==='button'));const button=row.children.find(x=>x.tag==='button');
 await button.events.click().catch(()=>{});assert.equal(modal.closed,false);assert.equal(input.value,'不可丢的想法');assert.equal(button.disabled,false);
 fail=false;await button.events.click();assert.equal(modal.closed,true);observations.push('modal failure/retry retains draft');
});
test('fenced examples never enter the timeline or tag-renaming workflow',async t=>{
 const f=fixture(t);const content='```md\n> [!memo] 09:00\n> 示例 #工作\n```\n\n~~~markdown\n> [!memo] 09:05\n> 第二示例 #工作\n~~~\n\n> [!memo] 10:00\n> 真正记录 #工作\n';f.put(f.source.path,content);
 const memos=await f.p.memoStore.list();assert.equal(memos.length,1);assert.equal(memos[0].text,'真正记录 #工作');
 await f.p.memoStore.renameTag('工作','业务');const updated=f.read(f.source);assert(updated.includes('> 示例 #工作'));assert(updated.includes('> 第二示例 #工作'));assert(updated.includes('> 真正记录 #业务'));
 await f.p.memoStore.remove((await f.p.memoStore.list())[0]);assert(f.read(f.source).includes('> 示例 #工作'));observations.push('fenced examples remain byte-preserved');
});
test('question conversion inherits source Topic and persists an exact backlink',async t=>{
 const f=fixture(t);await f.p.convertMemoToQuestion(f.memo());const targets=[...f.files.keys()].filter(p=>p.includes('/questions/'));
 assert.equal(targets.length,1);assert(targets[0].startsWith('Topics/main-business/questions/backlog/'));assert(f.read(f.files.get(targets[0])).includes('topic: "main-business"'));
 assert(f.read(f.source).includes('[[Topics/main-business/questions/backlog/'));observations.push('question source Topic preserved');
});
test('note backlink failure retries after plugin recreation without creating another destination',async t=>{
 const f=fixture(t);const stale=f.memo();let fail=true;const process=f.app.vault.process;
 f.app.vault.process=(file,fn)=>process(file,text=>{const next=fn(text);if(fail&&file.path===f.source.path&&next.includes('> → [['))throw new Error('backlink write blocked');return next;});
 await assert.rejects(f.p.convertMemoToNote(stale));assert.equal([...f.files.keys()].filter(p=>p.startsWith('Notes/')).length,1);
 fail=false;const reloaded=f.make();await reloaded.convertMemoToNote(f.memo());
 assert.equal([...f.files.keys()].filter(p=>p.startsWith('Notes/')).length,1);assert.equal(f.memo().links.length,1);observations.push('partial conversion recovered across plugin recreation');
});
test('Now conversion is idempotent, remains converted, and preserves completed tasks on retry',async t=>{
 const f=fixture(t);const stale=f.memo();await Promise.all([f.p.convertMemoToNow(stale),f.p.convertMemoToNow(stale)]);
 const now=f.files.get('Now/行动.md');assert.equal((f.read(now).match(/^- \[ \]/gm)||[]).length,1);assert.equal(H.filterMemos([f.memo()],{converted:true}).length,1);
 f.put(now.path,f.read(now).replace('- [ ]','- [x]'));await f.make().convertMemoToNow(f.memo());assert.equal((f.read(now).match(/^- \[/gm)||[]).length,1);assert(f.read(now).includes('- [x]'));assert(/\[\[Now\/行动#\^/.test(f.read(f.source)));observations.push('Now retry preserves one completed task and backlink');
});
test('edited source is rejected before creating a note and cannot be partially deleted',async t=>{
 const f=fixture(t);const stale=f.memo();f.put(f.source.path,f.read(f.source)+'> 新追加内容\n');
 await assert.rejects(f.p.convertMemoToNote(stale));assert.equal([...f.files.keys()].filter(p=>p.startsWith('Notes/')).length,0);
 await assert.rejects(f.p.memoStore.remove(stale));assert(f.read(f.source).includes('新追加内容'));observations.push('stale source fails safely before destination write');
});
test.after(()=>{const out=process.env.PULSE_MEMO_REPORT||path.join(os.tmpdir(),'crisp-pulse-memo-workflow-results.json');fs.writeFileSync(out,JSON.stringify({completed:observations},null,2));});
