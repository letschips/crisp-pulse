/* Failure modes recorded before fixes:
 * Concurrent deletes/purges/expiry cleanup must not lose recoverable entries.
 * A rejected stale delete must not roll back a different successful deletion.
 * Failed trash writes (including silent no-op) must leave source memos untouched.
 * Malformed entries must never be silently discarded by automatic expiry.
 * Restoration followed by cleanup failure must stay idempotent after reloading the store.
 * Distinct identical memos must stay distinct; recovery must not overwrite edited notes.
 * Repeated microphone clicks during permission acquisition must acquire one stream.
 * Closing during acquisition and recorder start failures must release every track.
 * Filesystem workflows use only OS temporary directories. No real microphone is acquired.
 */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const observations = [];
class TFile { constructor(p) { this.path=p; this.extension='md'; } }
const context = {module:{exports:{}},require:()=>({Plugin:class{},ItemView:class{},PluginSettingTab:class{},Modal:class{},TFile,Notice:class{},addIcon(){}}),console,Date,Blob,window:{setTimeout,clearTimeout,setInterval,clearInterval},setTimeout,clearTimeout,document:{hidden:false},crypto:globalThis.crypto,TextEncoder,TextDecoder,Buffer,atob};
vm.runInNewContext(fs.readFileSync(process.env.PULSE_RUNTIME||path.join(__dirname,'../main.js'),'utf8')+'\nmodule.exports.AuditMemoView=CrispPulseMemoView;',context);
const {MemoStore,parseMemoBlocks}=context.module.exports.memoHelpers, View=context.module.exports.AuditMemoView;
const now=new Date(2026,9,9,10), source='Daily/2026-10-09.md', trash='plugin/memo-trash.json';
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pulse-memo-safety-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const files=new Map(), queues=new Map();
  const put=(p,c)=>{fs.mkdirSync(path.dirname(path.join(root,p)),{recursive:true});fs.writeFileSync(path.join(root,p),c);if(p.endsWith('.md'))files.set(p,files.get(p)||new TFile(p));};
  const read=p=>fs.readFileSync(path.join(root,p),'utf8');
  const app={vault:{getAbstractFileByPath:p=>files.get(p),getMarkdownFiles:()=>[...files.values()],read:async f=>read(f.path),cachedRead:async f=>read(f.path),createFolder:async p=>fs.mkdirSync(path.join(root,p),{recursive:true}),create:async(p,c)=>{assert(!files.has(p));put(p,c);return files.get(p);},process:(f,fn)=>{const job=(queues.get(f.path)||Promise.resolve()).then(()=>{const c=fn(read(f.path));put(f.path,c);return c;});queues.set(f.path,job.catch(()=>{}));return job;},adapter:{exists:async p=>fs.existsSync(path.join(root,p)),read:async p=>read(p),write:async(p,c)=>put(p,c)}},metadataCache:{getFileCache:()=>({})},internalPlugins:{getPluginById:()=>({enabled:true,instance:{options:{folder:'Daily',format:'YYYY-MM-DD'}}})}};
  put(source,'# 日记\n\n## 速记\n\n> [!memo] 08:00\n> 第一条\n\n> [!memo] 09:00\n> 第二条\n');
  const make=()=>new MemoStore(app,()=>({memoMode:'general',memoHeading:'## 速记'}),null,{trashPath:trash});
  return {root,app,put,read,make,files,s:make(),memos:()=>parseMemoBlocks(read(source)).map(m=>({...m,path:source,date:'2026-10-09'}))};
}
test('concurrent deletion preserves both sources in the trash',async t=>{const f=fixture(t);await Promise.all(f.memos().map(m=>f.s.remove(m,now)));assert.equal(parseMemoBlocks(f.read(source)).length,0);assert.equal((await f.s.listTrash(now)).length,2);observations.push('concurrent deletes retain 2 entries');});
test('a stale deletion cannot roll back a concurrent successful deletion',async t=>{const f=fixture(t);const [a,b]=f.memos();f.put(source,f.read(source).replace('> 第一条','> 第一条已修改'));const r=await Promise.allSettled([f.s.remove(b,now),f.s.remove(a,now)]);assert.equal(r[0].status,'fulfilled');assert.equal(r[1].status,'rejected');assert.equal((await f.s.listTrash(now)).length,1);assert(f.read(source).includes('第一条已修改'));observations.push('stale-delete rollback preserves successful entry');});
test('concurrent expiry cleanup does not overwrite a new deletion',async t=>{const f=fixture(t);await f.s.remove(f.memos()[0],new Date(2026,7,1));await Promise.all([f.s.listTrash(now),f.s.remove(f.memos()[0],now)]);assert.equal((await f.s.listTrash(now)).length,1);observations.push('expiry serialized with deletion');});
test('a silently discarded trash write never deletes the source',async t=>{const f=fixture(t);const before=f.read(source);f.app.vault.adapter.write=async()=>{};await assert.rejects(f.s.remove(f.memos()[0],now));assert.equal(f.read(source),before);observations.push('silent write failure retains source');});
test('malformed trash entries are preserved and block deletion/expiry',async t=>{const f=fixture(t);const bad=JSON.stringify({version:1,items:[{id:'broken',deletedAt:'invalid'}]});f.put(trash,bad);await assert.rejects(f.s.listTrash(now));await assert.rejects(f.s.remove(f.memos()[0],now));assert.equal(f.read(trash),bad);observations.push('malformed entries retained');});
test('restore retries after cleanup failure/reload without duplicating the memo',async t=>{const f=fixture(t);await f.s.remove(f.memos()[0],now);const [entry]=await f.s.listTrash(now);const write=f.app.vault.adapter.write;f.app.vault.adapter.write=async(p,c)=>{if(!JSON.parse(c).items.length)throw new Error('disk unavailable');return write(p,c);};await assert.rejects(f.s.restore(entry.id));assert.equal(f.memos().length,2);f.app.vault.adapter.write=write;await f.make().restore(entry.id);assert.equal(f.memos().length,2);assert.equal((await f.s.listTrash(now)).length,0);observations.push('restore retry across reload inserts once');});
test('distinct identical memos restore as two distinct records',async t=>{const f=fixture(t);f.put(source,'> [!memo] 08:00\n> 相同\n\n> [!memo] 08:00\n> 相同\n');await Promise.all(f.memos().map(m=>f.s.remove(m,now)));const entries=await f.s.listTrash(now);for(const e of entries)await f.s.restore(e.id);assert.equal(f.memos().length,2);observations.push('identical memos retain multiplicity');});
test('failed creation of a fallback note retries at the same destination after settings change',async t=>{
 const f=fixture(t);await f.s.remove(f.memos()[0],now);const [entry]=await f.s.listTrash(now);
 f.files.delete(source);fs.unlinkSync(path.join(f.root,source));
 const create=f.app.vault.create;f.app.vault.create=async()=>{throw new Error('creation failed');};
 await assert.rejects(f.s.restore(entry.id));f.app.vault.create=create;
 f.app.internalPlugins.getPluginById=()=>({enabled:true,instance:{options:{folder:'Changed',format:'YYYY-MM-DD'}}});
 await f.make().restore(entry.id);assert.equal(parseMemoBlocks(f.read(source)).length,1);assert(!f.files.has('Changed/2026-10-09.md'));
 observations.push('fallback creation retry retains original destination');
});
test('simultaneous restore clicks insert one record',async t=>{
 const f=fixture(t);await f.s.remove(f.memos()[0],now);const [entry]=await f.s.listTrash(now);
 const result=await Promise.allSettled([f.s.restore(entry.id),f.s.restore(entry.id)]);
 assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.memos().length,2);
 observations.push('simultaneous restore inserts once');
});
function recordingFixture() {
  let resolve, acquisitions=0, stops=0, starts=0, interval=0;
  const stream={getTracks:()=>[{stop:()=>stops++}]};
  const win={navigator:{mediaDevices:{getUserMedia:()=>{acquisitions++;return new Promise(r=>resolve=r);}}},setInterval:()=>++interval,clearInterval(){}};
  class Recorder {static isTypeSupported(){return true;}constructor(){this.events={};this.state='inactive';}addEventListener(k,fn){this.events[k]=fn;}start(){starts++;this.state='recording';}stop(){this.state='inactive';this.events.stop?.();}}
  win.MediaRecorder=Recorder;
  const v=Object.create(View.prototype);v.containerEl={win,children:[{}, {querySelector:()=>null}]};v.memoMarkdownComponents=new Map();v.updateRecordingUi=()=>{};
  return {v,win,grant:()=>resolve(stream),counts:()=>({acquisitions,stops,starts})};
}
test('repeated microphone clicks during permission prompt acquire only one stream',async()=>{const f=recordingFixture();const a=f.v.toggleRecording(),b=f.v.toggleRecording();assert.equal(f.counts().acquisitions,1);f.grant();await Promise.all([a,b]);assert.equal(f.counts().starts,1);await f.v.onClose();assert.equal(f.counts().stops,1);observations.push('permission clicks acquire one stream');});
test('closing a view while permission is pending releases the late stream',async()=>{const f=recordingFixture();const job=f.v.toggleRecording();await f.v.onClose();f.grant();await job;assert.equal(f.counts().stops,1);assert.equal(f.counts().starts,0);observations.push('late permission stream released after close');});
test('recorder start failure releases the microphone and allows retry',async()=>{const f=recordingFixture();f.win.MediaRecorder=class{static isTypeSupported(){return true;}addEventListener(){}start(){throw new Error('codec failure');}};const job=f.v.toggleRecording();f.grant();await job;assert.equal(f.counts().stops,1);assert(!f.v.recording);observations.push('failed recorder start releases microphone');});
test.after(()=>{fs.writeFileSync(process.env.PULSE_SAFETY_REPORT||path.join(os.tmpdir(),'crisp-pulse-memo-safety-results.json'),JSON.stringify({completed:observations},null,2));});
