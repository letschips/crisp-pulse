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
