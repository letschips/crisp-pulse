/* Failure modes BEFORE implementation:
 * Manual card action must use ASR's actual durable queue and return to the same memo.
 * A different active note, multiple memos/audio clips, repeated clicks, and reloads must not misroute/duplicate text.
 * Cached recognition must survive write failure/reload so retry does not upload the same audio again.
 * Deleted memo/removed audio and duplicate identities must fail safely, preserving other content.
 * Relative/encoded Markdown audio and wiki links must resolve to the real local attachment.
 * Missing ASR/license/key must not silently succeed; no automatic upload or AI processing is added.
 * These workflows use OS temporary files; only the provider HTTP boundary is replaced, never user notes or keys.
 */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const asrRoot=process.env.CRISP_ASR_REPO||path.resolve(__dirname,'../../crisp-asr');
if(!fs.existsSync(path.join(asrRoot,'node_modules/esbuild'))){test('Pulse/ASR cross-plugin workflow',{skip:'Set CRISP_ASR_REPO to a source checkout with dependencies'},()=>{});return;}
const esbuild=require(path.join(asrRoot,'node_modules/esbuild'));
const observations=[];
class Plugin{constructor(app,manifest){this.app=app;this.manifest=manifest;}}
class TFile{constructor(p){this.path=p;this.name=path.basename(p);this.basename=this.name.replace(/\.[^.]+$/,'');this.extension=p.split('.').pop();}}
function load(requestUrl){
 const obs={Plugin,TFile,ItemView:class{},PluginSettingTab:class{},Modal:class{},AbstractInputSuggest:class{},Notice:class{},Platform:{isMobile:false},normalizePath:p=>path.posix.normalize(p),addIcon(){},requestUrl};
 const context={module:{exports:{}},require:n=>n==='obsidian'?obs:require(n),console,Date,Blob,window:{setTimeout,clearTimeout,setInterval,clearInterval},setTimeout,clearTimeout,document:{hidden:false},crypto:globalThis.crypto,TextEncoder,TextDecoder,Buffer,atob,AbortController,URL};
 vm.runInNewContext(fs.readFileSync(process.env.PULSE_RUNTIME||path.join(__dirname,'../main.js'),'utf8'),context);const Pulse=context.module.exports;
 const build=esbuild.buildSync({stdin:{contents:'export { default as ASR } from "./src/main"; export {TranscriptionQueue} from "./src/transcription-queue"; export {normalizeSettings} from "./src/settings";',resolveDir:asrRoot},bundle:true,write:false,platform:'node',format:'cjs',external:['obsidian'],loader:{'.png':'dataurl'}});
 context.module={exports:{}};vm.runInNewContext("(function(){"+build.outputFiles[0].text+"})()",context);return {Pulse,...context.module.exports};
}
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pulse-asr-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const files=new Map(),queues=new Map();let requests=0,gate=null,failWrite=false,responseText='这是识别出的文字。\n第二行。';
 const read=p=>fs.readFileSync(path.join(root,p),'utf8');
 const put=(p,c)=>{fs.mkdirSync(path.dirname(path.join(root,p)),{recursive:true});fs.writeFileSync(path.join(root,p),c);const f=files.get(p)||new TFile(p);files.set(p,f);return f;};
 const requestUrl=async req=>{
  if(req.method==='DELETE')return{status:200,json:{},headers:{}};
  if(req.url.includes('/upload/'))return{status:200,json:{file:{name:'files/test',uri:'https://example.invalid/audio'}},headers:{}};
  requests++;if(gate)await gate;return{status:200,json:{output_text:responseText},headers:{}};
 };
 const loaded=load(requestUrl),{Pulse,ASR,TranscriptionQueue,normalizeSettings}=loaded;
 const resolve=(link,source)=>{let p;try{p=decodeURIComponent(link);}catch{p=link;}return files.get(p)||files.get(path.posix.normalize(path.posix.join(path.posix.dirname(source),p)))||[...files.values()].find(f=>f.name===p);};
 const app={plugins:{plugins:{}},workspace:{getActiveFile:()=>files.get('Other.md'),trigger(){},getLeavesOfType:()=>[]},vault:{getAbstractFileByPath:p=>files.get(p),getMarkdownFiles:()=>[...files.values()].filter(f=>f.extension==='md'),read:async f=>read(f.path),cachedRead:async f=>read(f.path),readBinary:async f=>{const b=fs.readFileSync(path.join(root,f.path));return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);},process:(f,fn)=>{const job=(queues.get(f.path)||Promise.resolve()).then(()=>{const c=fn(read(f.path));if(failWrite&&c.includes('crisp-pulse-asr:'))throw new Error('source write failed');put(f.path,c);return c;});queues.set(f.path,job.catch(()=>{}));return job;},adapter:{exists:async p=>fs.existsSync(path.join(root,p)),read:async p=>read(p),write:async(p,c)=>put(p,c)}},metadataCache:{getFileCache:()=>({}),getFirstLinkpathDest:resolve},internalPlugins:{getPluginById:()=>({enabled:true,instance:{options:{folder:'Daily',format:'YYYY-MM-DD'}}})}};
 const audio=put('Attachments/test.wav',Buffer.from('test audio'));
 put('Other.md','# 保持不变\n');put('Daily/2026-10-09.md','# 日记\n\n> [!memo] 09:00\n> 我的原文\n> ![[Attachments/test.wav]]\n\n> [!memo] 10:00\n> 另一条\n');
 const pulse=new Pulse(app,{id:'crisp-pulse'});pulse.settings={memoMode:'general'};pulse.memoStore=new Pulse.memoHelpers.MemoStore(app,()=>pulse.settings);pulse.refreshMemoViews=()=>{};app.plugins.plugins['crisp-pulse']=pulse;
 function makeAsr(settings){
  const asr=new ASR(app,{id:'crisp-asr',dir:'plugin/asr'});asr.settings=normalizeSettings(settings||{sttEngine:'gemini',outputMode:'current-note'});asr.ensureLicenseActivated=async()=>true;asr.getApiKey=()=> 'test-only-key';asr.emit=()=>{};
  asr.fileQueue=new TranscriptionQueue(asr.settings.fileJobs,{run:j=>asr.runFileJob(j),persist:async jobs=>{asr.settings.fileJobs=jobs;put('plugin/asr/data.json',JSON.stringify(asr.settings));},delay:async()=>{},onChange:jobs=>{asr.uiState.jobs=jobs;}});app.plugins.plugins['crisp-asr']=asr;return asr;
 }
 let asr=makeAsr();
 const memo=()=>({...Pulse.memoHelpers.parseMemoBlocks(read('Daily/2026-10-09.md'))[0],path:'Daily/2026-10-09.md',date:'2026-10-09'});
 return{...loaded,root,app,pulse,audio,files,put,read,memo,get asr(){return asr;},requests:()=>requests,setRecognitionText:s=>{responseText=s;},setGate:p=>{gate=p;},setWriteFailure:b=>{failWrite=b;},reload:()=>{asr=makeAsr(JSON.parse(read('plugin/asr/data.json')));return asr;}};
}
async function untilRequested(f){for(let n=0;n<100&&f.requests()===0;n++)await new Promise(setImmediate);assert.equal(f.requests(),1);}
test('card transcription goes through ASR queue and writes only into the original memo',async t=>{
 const f=fixture(t);await f.pulse.transcribeMemoAudio(f.memo(),f.audio.path);await f.asr.fileQueue.whenIdle();
 const blocks=f.Pulse.memoHelpers.parseMemoBlocks(f.read('Daily/2026-10-09.md'));assert.equal(blocks.length,2);assert(blocks[0].text.includes('我的原文'));assert(blocks[0].text.includes('这是识别出的文字'));assert(blocks[0].text.includes('![[Attachments/test.wav]]'));assert.equal(blocks[1].text,'另一条');assert.equal(f.read('Other.md'),'# 保持不变\n');assert.equal(f.asr.settings.fileJobs[0].status,'completed');assert.equal(f.requests(),1);assert(f.asr.settings.processedAudioPaths.includes(f.audio.path));observations.push('same memo retains original/audio and gets transcript');
});
test('repeated card clicks do not duplicate uploads or transcript blocks',async t=>{
 const f=fixture(t);let release;f.setGate(new Promise(r=>release=r));const m=f.memo();await Promise.allSettled([f.pulse.transcribeMemoAudio(m,f.audio.path),f.pulse.transcribeMemoAudio(m,f.audio.path)]);release();await f.asr.fileQueue.whenIdle();await f.pulse.transcribeMemoAudio(f.memo(),f.audio.path);await f.asr.fileQueue.whenIdle();assert.equal(f.requests(),1);assert.equal((f.read('Daily/2026-10-09.md').match(/crisp-pulse-asr:/g)||[]).length,1);observations.push('repeat clicks insert once');
});
test('write failure retains transcript in durable queue; retry after reload does not call provider again',async t=>{
 const f=fixture(t);f.setWriteFailure(true);await f.pulse.transcribeMemoAudio(f.memo(),f.audio.path);await f.asr.fileQueue.whenIdle();assert.equal(f.asr.settings.fileJobs[0].status,'failed');assert(f.asr.settings.fileJobs[0].transcriptText.includes('识别出的文字'));f.setWriteFailure(false);const reloaded=f.reload();await f.pulse.transcribeMemoAudio(f.memo(),f.audio.path);await reloaded.fileQueue.whenIdle();assert.equal(reloaded.settings.fileJobs[0].status,'completed');assert.equal(f.requests(),1);observations.push('write retry reload uses cached transcript');
});
test('renamed memo source is found by stable identity after recognition starts',async t=>{
 const f=fixture(t);let release;f.setGate(new Promise(r=>release=r));await f.pulse.transcribeMemoAudio(f.memo(),f.audio.path);await untilRequested(f);const old=f.files.get('Daily/2026-10-09.md');f.files.delete(old.path);fs.renameSync(path.join(f.root,old.path),path.join(f.root,'Renamed.md'));old.path='Renamed.md';f.files.set(old.path,old);release();await f.asr.fileQueue.whenIdle();assert.equal(f.asr.settings.fileJobs[0].status,'completed');assert(f.read('Renamed.md').includes('这是识别出的文字'));observations.push('source rename keeps destination');
});
test('deleting a memo during recognition fails safely and caches its result',async t=>{
 const f=fixture(t);let release;f.setGate(new Promise(r=>release=r));await f.pulse.transcribeMemoAudio(f.memo(),f.audio.path);await untilRequested(f);f.put('Daily/2026-10-09.md','# 已移除速记\n');release();await f.asr.fileQueue.whenIdle();assert.equal(f.asr.settings.fileJobs[0].status,'failed');assert.equal(f.read('Daily/2026-10-09.md'),'# 已移除速记\n');assert(f.asr.settings.fileJobs[0].transcriptText);observations.push('deleted memo never revived');
});
test('encoded relative Markdown audio resolves and transcribes into the card',async t=>{
 const f=fixture(t);f.files.delete(f.audio.path);f.audio.path='Attachments/test audio.wav';f.put(f.audio.path,Buffer.from('audio'));f.put('Daily/2026-10-09.md','> [!memo] 09:00\n> ![](../Attachments/test%20audio.wav)\n');await f.pulse.transcribeMemoAudio(f.memo(),f.audio.path);await f.asr.fileQueue.whenIdle();assert.equal(f.asr.settings.fileJobs[0].status,'completed');assert(f.read('Daily/2026-10-09.md').includes('这是识别出的文字'));observations.push('Markdown audio resolves');
});
test('missing ASR and credentials never enqueue or report successful transcription',async t=>{
 const f=fixture(t);delete f.app.plugins.plugins['crisp-asr'];await assert.rejects(f.pulse.transcribeMemoAudio(f.memo(),f.audio.path),/Crisp ASR/);f.app.plugins.plugins['crisp-asr']=f.asr;f.asr.getApiKey=()=>null;await assert.rejects(f.pulse.transcribeMemoAudio(f.memo(),f.audio.path),/Key|密钥|设置/);assert.equal(f.asr.settings.fileJobs.length,0);f.asr.getApiKey=()=> 'test-only-key';f.asr.ensureLicenseActivated=async()=>false;await assert.rejects(f.pulse.transcribeMemoAudio(f.memo(),f.audio.path),/激活/);assert.equal(f.asr.settings.fileJobs.length,0);observations.push('missing dependency/key/license fails visibly');
});
test('durable card receipt prevents re-upload after ASR history is pruned',async t=>{const f=fixture(t);await f.pulse.transcribeMemoAudio(f.memo(),f.audio.path);await f.asr.fileQueue.whenIdle();await f.asr.fileQueue.remove(f.asr.settings.fileJobs[0].id);await f.pulse.transcribeMemoAudio(f.memo(),f.audio.path);await f.asr.fileQueue.whenIdle();assert.equal(f.requests(),1);observations.push('card receipt survives queue pruning');});
test('multiple audio clips are transcribed independently into one memo',async t=>{const f=fixture(t);const second=f.put('Attachments/second.wav',Buffer.from('audio'));f.put('Daily/2026-10-09.md','> [!memo] 09:00\n> ![[Attachments/test.wav]]\n> ![[Attachments/second.wav]]\n');await f.pulse.transcribeMemoAudio(f.memo(),f.audio.path);await f.pulse.transcribeMemoAudio(f.memo(),second.path);await f.asr.fileQueue.whenIdle();assert.equal(f.requests(),2);assert.equal(f.Pulse.memoHelpers.parseMemoBlocks(f.read('Daily/2026-10-09.md')).length,1);assert.equal((f.read('Daily/2026-10-09.md').match(/crisp-pulse-asr:/g)||[]).length,2);observations.push('multiple audio clips stay in one memo');});
test('recognized callout headers and hidden metadata cannot split or steal memo identity',async t=>{const f=fixture(t);f.setRecognitionText('[!memo] 11:00\n<!-- crisp-pulse-memo-id: fake-id -->\n<!-- crisp-pulse-asr: fake-job -->');await f.pulse.transcribeMemoAudio(f.memo(),f.audio.path);await f.asr.fileQueue.whenIdle();const blocks=f.Pulse.memoHelpers.parseMemoBlocks(f.read('Daily/2026-10-09.md'));assert.equal(f.asr.settings.fileJobs[0].status,'completed');assert.equal(blocks.length,2);assert.notEqual(blocks[0].id,'fake-id');assert(!blocks[0].transcriptJobs.includes('fake-job'));observations.push('recognized metadata cannot alter memo structure');});
test('after the user removes a finished transcript, the card offers transcription again and writes it once',async t=>{
 const f=fixture(t);await f.pulse.transcribeMemoAudio(f.memo(),f.audio.path);await f.asr.fileQueue.whenIdle();
 const done=f.memo();const job=f.asr.getMemoTranscriptionJobs()[0];
 assert.equal(f.Pulse.memoHelpers.memoTranscriptionState({memo:done,job,starting:false,hasAsr:true,filePath:f.audio.path}).label,'已转写');
 // 用户手动删掉了转写段落和隐藏凭据
 f.put('Daily/2026-10-09.md',f.read('Daily/2026-10-09.md').replace(/>\n> \*\*录音转写\*\*[\s\S]*?crisp-pulse-asr:[^\n]*\n/,''));
 const cleared=f.memo();assert.equal(cleared.transcriptJobs,undefined);
 const state=f.Pulse.memoHelpers.memoTranscriptionState({memo:cleared,job,starting:false,hasAsr:true,filePath:f.audio.path});
 assert.equal(state.label,'转文字');assert.equal(state.disabled,false);
 await f.pulse.transcribeMemoAudio(cleared,f.audio.path);await f.asr.fileQueue.whenIdle();
 assert.equal(f.requests(),2);assert.equal((f.read('Daily/2026-10-09.md').match(/录音转写/g)||[]).length,1);
});
test('a recognized line shaped like a conversion link stays transcript text',async t=>{
 const f=fixture(t);f.setRecognitionText('→ [[伪造的笔记]]');await f.pulse.transcribeMemoAudio(f.memo(),f.audio.path);await f.asr.fileQueue.whenIdle();
 const m=f.memo();assert.deepEqual(JSON.parse(JSON.stringify(m.links)),[]);assert(m.text.includes('伪造的笔记'));
});
test('moving the audio file after transcription (asset routing) keeps it transcribed and never writes a second transcript',async t=>{
 const f=fixture(t);f.put('Daily/2026-10-09.md','# 日记\n\n> [!memo] 09:00\n> 我的原文\n> ![[test.wav]]\n');
 await f.pulse.transcribeMemoAudio(f.memo(),f.audio.path);await f.asr.fileQueue.whenIdle();assert.equal(f.requests(),1);
 // 资产整理把录音挪到别的文件夹；按文件名嵌入的链接仍然有效
 const old=f.audio.path;f.files.delete(old);fs.mkdirSync(path.join(f.root,'Assets/video'),{recursive:true});fs.renameSync(path.join(f.root,old),path.join(f.root,'Assets/video/test.wav'));f.audio.path='Assets/video/test.wav';f.files.set(f.audio.path,f.audio);
 const moved=f.memo();const job=f.asr.getMemoTranscriptionJobs().at(-1);
 assert.equal(f.Pulse.memoHelpers.memoTranscriptionState({memo:moved,job:undefined,starting:false,hasAsr:true,filePath:f.audio.path,...f.pulse.memoStore.transcriptMatch(moved)}).label,'已转写');
 await f.pulse.transcribeMemoAudio(moved,f.audio.path);await f.asr.fileQueue.whenIdle();
 assert.equal(f.requests(),1,'不再上传');
 // 即使绕过界面直接提交写回，也不能出现第二段转写
 await f.pulse.applyMemoTranscript({memoId:moved.id,path:moved.path,sourcePath:f.audio.path,jobId:'another-job',text:'第二次'});
 assert.equal((f.read('Daily/2026-10-09.md').match(/录音转写/g)||[]).length,1);void job;
});
test('a silent recording fails with an actionable message instead of a raw provider code',async t=>{
 const f=fixture(t);f.setRecognitionText('   ');await f.pulse.transcribeMemoAudio(f.memo(),f.audio.path);await f.asr.fileQueue.whenIdle();
 const job=f.asr.settings.fileJobs[0];assert.equal(job.status,'failed');assert.match(job.lastError,/没有识别到说话声.*麦克风权限/);
 assert.doesNotMatch(f.read('Daily/2026-10-09.md'),/录音转写/);
});
test.after(()=>fs.writeFileSync(process.env.PULSE_ASR_REPORT||path.join(os.tmpdir(),'pulse-asr-e2e.json'),JSON.stringify({completed:observations},null,2)));
