/* 1.16.1：采集环节的恢复与身份。每条测试对应一个会丢内容或显示错状态的失败模式。
   - 录音存进库失败：录音留着，重试成功只生成一个附件，不用重录。
   - 录音时关掉面板：存好的录音链接和没提交的文字，下次打开速记面板能找回；多个面板的草稿不互相覆盖。
   - 草稿文件损坏：不覆盖它。
   - 不同目录的同名录音各算各的；录音被挪走后仍认得出已转写。
   - Tempo 状态乱序返回：只显示最新一次；读取失败不当成任务被删。
   - 速记提交给统计记一笔本人写作证据。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const notices = [];
const context = {
  require: () => ({ Plugin: class {}, TFile: class {}, ItemView: class {}, PluginSettingTab: class {}, Setting: class {}, Modal: class {}, Notice: class { constructor(m) { notices.push(String(m)); } }, addIcon() {} }),
  module: { exports: {} }, console, Date, window: { setTimeout, clearTimeout, setInterval, clearInterval },
  document: { hidden: false }, navigator: {}, setTimeout, clearTimeout, structuredClone, crypto: globalThis.crypto, TextEncoder, TextDecoder, Buffer, atob, Blob,
};
vm.runInNewContext(`${fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8')}\nmodule.exports.MemoDraftStore = MemoDraftStore;\nmodule.exports.MemoStore = MemoStore;`, context);
const Pulse = context.module.exports;
const { MemoDraftStore, MemoStore } = Pulse;
const View = Pulse.CrispPulseMemoView;
const { memoHasTranscriptFor } = Pulse.memoHelpers;

function fakeAdapter(files = new Map()) {
  return {
    files, writes: 0,
    async exists(p) { return files.has(p) || [...files.keys()].some((k) => k.startsWith(`${p}/`)); },
    async read(p) { if (!files.has(p)) throw new Error('missing'); return files.get(p); },
    async write(p, c) { this.writes++; files.set(p, c); },
    async writeBinary(p, d) { files.set(p, d); },
    async readBinary(p) { return files.get(p); },
    async mkdir() {},
    async remove(p) { files.delete(p); },
  };
}

function recordingView({ saveAttachment, drafts, key = 'leaf-a' }) {
  let grant;
  const stream = { getTracks: () => [{ stop() {} }] };
  class Recorder { static isTypeSupported() { return true; } constructor() { this.events = {}; this.state = 'inactive'; this.mimeType = 'audio/webm'; } addEventListener(k, fn) { this.events[k] = fn; } start() { this.state = 'recording'; } stop() { this.state = 'inactive'; this.events.dataavailable?.({ data: new Blob(['abc']) }); this.done = this.events.stop?.(); } }
  const win = { navigator: { mediaDevices: { getUserMedia: () => new Promise((r) => { grant = r; }) } }, setInterval: () => 1, clearInterval() {}, MediaRecorder: Recorder };
  const v = Object.create(View.prototype);
  v.containerEl = { win, children: [{}, { querySelector: () => null }] };
  v.memoMarkdownComponents = new Map(); v.updateRecordingUi = () => {}; v.renderPendingRecordings = () => {};
  v.draft = ''; v.draftRevision = 0; v.draftKey = key;
  v.plugin = { memoStore: { saveAttachment }, memoDrafts: drafts };
  return { v, grant: () => grant(stream) };
}

async function record(f) {
  const started = f.v.toggleRecording(); f.grant(); await started;
  const recorder = f.v.recording.recorder;
  f.v.toggleRecording(); await recorder.done;
}

test('a recording that fails to save is kept, and a retry saves the same audio once', async () => {
  notices.length = 0;
  const saved = []; let fail = true;
  const drafts = new MemoDraftStore(fakeAdapter(), 'plugin');
  const f = recordingView({ drafts, saveAttachment: async (name, data) => { if (fail) throw new Error('磁盘已满'); saved.push({ name, size: data.byteLength }); return `![[${name}]]`; } });
  await record(f);
  assert.equal(drafts.recordings.length, 1, '录音留在待保存列表');
  assert.match(drafts.recordings[0].stash, /^plugin\/memo-pending\//, '插件目录里留了一份，重载后也能重试');
  assert.match(notices.join('\n'), /录音已保留/);
  fail = false;
  await f.v.retryRecording(drafts.recordings[0]);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].size, 3, '存的是原来那段录音');
  assert.equal(drafts.recordings.length, 0);
  assert.match(f.v.draft, /!\[\[录音 \d+\.webm\]\]/);
  assert.equal([...drafts.adapter.files.keys()].some((k) => k.includes('memo-pending/')), false, '暂存文件删掉了');
});

test('closing the panel while recording keeps the saved link and unsent text for the next panel', async () => {
  const adapter = fakeAdapter();
  const drafts = new MemoDraftStore(adapter, 'plugin');
  const f = recordingView({ drafts, saveAttachment: async (name) => `![[${name}]]` });
  f.v.setDraft('还没提交的想法');
  const started = f.v.toggleRecording(); f.grant(); await started;
  const recorder = f.v.recording.recorder;
  await f.v.onClose(); await recorder.done; await drafts.flush();
  const reloaded = new MemoDraftStore(adapter, 'plugin'); await reloaded.load();
  const text = reloaded.claimDraft('leaf-new', ['leaf-new']);
  assert.match(text, /^还没提交的想法\n!\[\[录音 \d+\.webm\]\]/);
});

test('each open panel keeps its own draft; submitting clears only that one', async () => {
  const adapter = fakeAdapter();
  const drafts = new MemoDraftStore(adapter, 'plugin');
  drafts.setDraft('a', '面板 A'); drafts.setDraft('b', '面板 B');
  assert.equal(drafts.claimDraft('a', ['a', 'b']), '面板 A');
  assert.equal(drafts.claimDraft('b', ['a', 'b']), '面板 B');
  drafts.setDraft('a', '');
  await drafts.flush();
  const reloaded = new MemoDraftStore(adapter, 'plugin'); await reloaded.load();
  assert.equal(reloaded.claimDraft('c', ['b', 'c']), '', '面板 B 还开着，它的草稿不被别人认领');
  assert.equal(reloaded.claimDraft('b', ['b', 'c']), '面板 B');
});

test('a damaged draft file is left untouched', async () => {
  const adapter = fakeAdapter(new Map([['plugin/memo-drafts.json', '{"version":1,"drafts":']]));
  const drafts = new MemoDraftStore(adapter, 'plugin'); await drafts.load();
  drafts.setDraft('a', '新草稿'); await drafts.flush();
  assert.equal(adapter.writes, 0);
  assert.equal(adapter.files.get('plugin/memo-drafts.json'), '{"version":1,"drafts":');
});

test('same-named recordings in different folders are transcribed independently; a moved one stays transcribed', () => {
  const memo = { transcriptAudio: ['A/meeting.wav'] };
  const vault = new Set(['A/meeting.wav', 'B/meeting.wav']);
  const ctx = { audioPaths: ['A/meeting.wav', 'B/meeting.wav'], exists: (p) => vault.has(p) };
  assert.equal(memoHasTranscriptFor(memo, 'A/meeting.wav', ctx), true);
  assert.equal(memoHasTranscriptFor(memo, 'B/meeting.wav', ctx), false, 'B 还没转写');
  // 资产整理把唯一那段录音挪走了
  const moved = { transcriptAudio: ['images/rec.webm'] };
  assert.equal(memoHasTranscriptFor(moved, 'video/rec.webm', { audioPaths: ['video/rec.webm'], exists: () => false }), true);
  // 挪走后又出现两段同名录音：认不出是哪段，交给用户核实
  assert.equal(memoHasTranscriptFor(moved, 'video/rec.webm', { audioPaths: ['video/rec.webm', 'other/rec.webm'], exists: () => false }), false);
});

function tempoView(tempo) {
  const v = Object.create(View.prototype);
  const rendered = [];
  const row = { isConnected: true };
  v.memoClosed = false; v.memoTempoRows = new Map([[row, { id: 'm1' }]]);
  v.plugin = { memoTempo: () => tempo };
  v.renderTempoChip = (_row, _m, snapshots, opts) => rendered.push({ status: snapshots?.['crisp-pulse:m1']?.status, stale: !!opts?.stale });
  return { v, rendered };
}

test('an older Tempo status response arriving late never replaces a newer one', async () => {
  const pending = [];
  const tempo = { getTasksBySource: () => new Promise((r) => pending.push(r)) };
  const { v, rendered } = tempoView(tempo);
  const first = v.refreshTempoChips(); const second = v.refreshTempoChips();
  pending[1]({ 'crisp-pulse:m1': { id: 't', status: 'done' } }); await second;
  pending[0]({ 'crisp-pulse:m1': { id: 't', status: 'todo' } }); await first;
  assert.deepEqual(rendered.map((r) => r.status), ['done']);
  assert.equal(v.tempoSnapshots['crisp-pulse:m1'].status, 'done');
});

test('a failed Tempo read keeps the last known status instead of treating the task as deleted', async () => {
  let fail = false;
  const tempo = { getTasksBySource: async () => { if (fail) throw new Error('Tempo busy'); return { 'crisp-pulse:m1': { id: 't', status: 'in_progress' } }; } };
  const { v, rendered } = tempoView(tempo);
  await v.refreshTempoChips();
  fail = true; await v.refreshTempoChips();
  assert.deepEqual(rendered.at(-1), { status: 'in_progress', stale: true });
  assert.equal(v.tempoSnapshots['crisp-pulse:m1'].id, 't', '菜单仍是「在 Tempo 中打开」，不是「重新转为任务」');
});

test('submitting a memo marks the write as the user\'s own for writing stats', async () => {
  const marked = [];
  const store = new MemoStore({}, () => ({}), null, { onOwnWrite: (p) => marked.push(p) });
  store.writeBlock = async (block, now, beforeWrite) => { await beforeWrite('Daily/2026-10-09.md', '', '## 速记'); return { path: 'Daily/2026-10-09.md' }; };
  await store.capture('一条速记', new Date());
  assert.deepEqual(marked, ['Daily/2026-10-09.md']);
});

/* 1.19.2：草稿恢复文件写入后读回核对。失败模式：写入返回成功但文件被截断，插件仍当已保存，同一草稿也不再重写。 */
test('a draft write that does not read back is reported and retried', async () => {
  notices.length = 0;
  const adapter = fakeAdapter();
  let truncate = true;
  const write = adapter.write;
  adapter.write = async function (p, c) { return write.call(this, p, truncate ? c.slice(0, 10) : c); };
  const drafts = new MemoDraftStore(adapter, 'plugin'); await drafts.load();
  drafts.setDraft('a', '不能丢的草稿'); await drafts.flush();
  assert.match(notices.join('\n'), /草稿恢复文件保存失败/);
  truncate = false;
  drafts.setDraft('a', '不能丢的草稿'); await drafts.flush();
  assert.equal(JSON.parse(adapter.files.get('plugin/memo-drafts.json')).drafts.a.text, '不能丢的草稿', '同一草稿会重写');
});

/* 1.19.3：面板关掉或重试保存时，附件链接不落错地方。失败模式：
   - 点「重试保存」后、录音存好前提交，录音链接插进下一条草稿。
   - 图片还在保存时关掉面板、马上重新打开继续写：迟到的链接把旧草稿写回恢复文件，当前草稿缺图。 */
test('retrying a recording blocks submit until its link is in the draft', async () => {
  const adapter = fakeAdapter();
  const drafts = new MemoDraftStore(adapter, 'plugin');
  let release;
  const f = recordingView({ drafts, saveAttachment: (name) => new Promise((r) => { release = () => r(`![[${name}]]`); }) });
  const rec = { id: 'r1', name: '录音 1.webm', type: 'audio/webm', startedAt: new Date().toISOString(), data: new ArrayBuffer(3), error: '' };
  drafts.recordings.push(rec);
  const retry = f.v.retryRecording(rec);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(f.v.attachmentSaving(), true, '重试保存期间不能提交');
  release(); await retry;
  assert.equal(f.v.attachmentSaving(), false);
  assert.match(f.v.draft, /!\[\[录音 1\.webm\]\]/);
});

test('a link that arrives after the panel closed goes to the panel that took over its draft', async () => {
  const adapter = fakeAdapter();
  const drafts = new MemoDraftStore(adapter, 'plugin');
  const views = [];
  const make = (key) => {
    const v = recordingView({ drafts, key, saveAttachment: async () => '' }).v;
    v.app = { workspace: { getLeavesOfType: () => views.filter((x) => !x.memoClosed).map((view) => ({ view })) } };
    views.push(v);
    return v;
  };
  const a = make('leaf-a');
  a.setDraft('关掉前写的');
  a.memoClosed = true; a.persistDraft();
  const b = make('leaf-b');
  b.draft = drafts.claimDraft('leaf-b', ['leaf-b']);
  b.setDraft(`${b.draft}，接着写`);
  a.insertIntoComposer('![[图片.png]]');
  assert.equal(b.draft, '关掉前写的，接着写\n![[图片.png]]\n', '链接进了接手的面板');
  assert.deepEqual(Object.keys(drafts.drafts), ['leaf-b'], '恢复文件里没有多出一份旧草稿');
  b.memoClosed = true;
  a.insertIntoComposer('![[第二张.png]]');
  assert.match(drafts.drafts['leaf-b'].text, /第二张\.png/, '接手的面板也关了：链接接到它留下的草稿');
  assert.deepEqual(Object.keys(drafts.drafts), ['leaf-b']);
});

test('a dictation result that arrives after the panel closed does not write back the old draft', async () => {
  const drafts = new MemoDraftStore(fakeAdapter(), 'plugin');
  const a = recordingView({ drafts, key: 'leaf-a', saveAttachment: async () => '' }).v;
  a.setDraft('前文听写');
  const d = { start: 2, shown: '听写', detached: false };
  a.memoClosed = true; a.persistDraft();
  drafts.claimDraft('leaf-b', ['leaf-b']);
  a.applyDictation(d, '听写定稿');
  assert.deepEqual(Object.keys(drafts.drafts), ['leaf-b']);
  assert.equal(drafts.drafts['leaf-b'].text, '前文听写');
});

/* 1.19.4：插件重载与草稿接手。失败模式：
   - 图片还在保存时重载插件，新面板补写的文字已存好；旧实例迟到的保存用旧草稿覆盖恢复文件，新文字丢失。
   - 接手草稿的新面板不知道上一个面板的附件还在保存，允许提前提交，迟到的链接串入下一条。 */
function liveView(drafts, key, views, plugins = {}) {
  const v = recordingView({ drafts, key, saveAttachment: async () => '' }).v;
  v.app = { workspace: { getLeavesOfType: () => views.filter((x) => !x.memoClosed).map((view) => ({ view })) }, plugins: { plugins } };
  views.push(v);
  return v;
}

for (const sameLeaf of [true, false]) {
  test(`a link that arrives after a plugin reload lands in the new draft without overwriting it (${sameLeaf ? 'same leaf' : 'new leaf'})`, async () => {
    const adapter = fakeAdapter();
    const oldStore = new MemoDraftStore(adapter, 'plugin'); await oldStore.load();
    const plugins = {};
    const oldViews = [];
    const a = liveView(oldStore, 'leaf-a', oldViews, plugins);
    a.setDraft('重载前写的');
    await oldStore.flush();
    // 插件卸载：先关面板，再停掉旧的草稿存储
    a.memoClosed = true; a.persistDraft(); oldStore.retire();
    const newStore = new MemoDraftStore(adapter, 'plugin'); await newStore.load();
    plugins['crisp-pulse'] = { memoDrafts: newStore };
    const newViews = [];
    const b = liveView(newStore, sameLeaf ? 'leaf-a' : 'leaf-b', newViews, plugins);
    a.app.workspace = b.app.workspace;
    b.draft = newStore.claimDraft(b.draftKey, [b.draftKey]);
    b.setDraft(`${b.draft}，重载后补写`);
    await newStore.flush();
    a.insertIntoComposer('![[图片.png]]');
    a.setDraft('重载前写的');
    await oldStore.flush(); await newStore.flush();
    const reloaded = new MemoDraftStore(adapter, 'plugin'); await reloaded.load();
    assert.equal(reloaded.claimDraft('leaf-z', ['leaf-z']), '重载前写的，重载后补写\n![[图片.png]]\n');
    assert.equal(Object.keys(reloaded.drafts).length, 1);
  });
}

test('the panel that takes over a draft also waits for its attachments before submitting', async () => {
  const drafts = new MemoDraftStore(fakeAdapter(), 'plugin');
  const views = [];
  let release;
  const fa = recordingView({ drafts, key: 'leaf-a', saveAttachment: (name) => new Promise((r) => { release = () => r(`![[${name}]]`); }) });
  const a = fa.v;
  a.app = { workspace: { getLeavesOfType: () => views.filter((x) => !x.memoClosed).map((view) => ({ view })) } };
  views.push(a);
  a.setDraft('关掉前写的');
  const started = a.toggleRecording(); fa.grant(); await started;
  const recorder = a.recording.recorder;
  await a.onClose();
  const b = liveView(drafts, 'leaf-b', views);
  b.draft = drafts.claimDraft('leaf-b', ['leaf-b']);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(b.attachmentSaving(), true, '接手的面板也要等附件存好');
  release(); await recorder.done;
  assert.equal(b.attachmentSaving(), false);
  assert.match(b.draft, /^关掉前写的\n!\[\[录音 \d+\.webm\]\]\n$/);
});

/* 1.19.5：卸载前已经开始、还没写完的草稿写入，不能在新实例保存之后才落盘把新草稿盖掉。 */
test('a slow draft write started before unload lands before the new instance reads and writes', async () => {
  const adapter = fakeAdapter();
  let release; let gated = true;
  const write = adapter.write;
  adapter.write = async function (p, c) { if (gated) { gated = false; await new Promise((r) => { release = r; }); } return write.call(this, p, c); };
  const oldStore = new MemoDraftStore(adapter, 'plugin'); await oldStore.load();
  oldStore.setDraft('old', '卸载前的旧内容');
  const retiring = oldStore.retire();
  const newStore = new MemoDraftStore(adapter, 'plugin');
  const loading = newStore.load().then(async () => { newStore.setDraft('new', '新实例新增的重要内容'); await newStore.flush(); });
  await new Promise((r) => setTimeout(r, 10));
  release(); await retiring; await loading;
  const reloaded = new MemoDraftStore(adapter, 'plugin'); await reloaded.load();
  assert.equal(reloaded.drafts.new?.text, '新实例新增的重要内容');
  assert.equal(reloaded.drafts.old?.text, '卸载前的旧内容');
});
