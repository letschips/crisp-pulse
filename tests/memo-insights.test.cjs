/* 1.17.0：审计优化建议。每条测试对应一个失败模式。
   - ASR 失败原因：服务商错误码（静音 20000003 等）不能原样甩给用户；本来就是说明文字的不能被改写。
   - 复盘的速记转化：同一条速记只算一次；转了多次的任务不重复计；没装 Tempo 时不能把任务算成未完成。
   - 速记增量刷新：没变的文件不再读；变了、被改、被删的文件不能读到旧结果；调用方改返回值不能污染缓存。
   - 点击式听写：点一下开始、再点结束；录音中不能开始听写。
   - 状态行：听写、录音、恢复的草稿都有可见的状态和结束 / 处理入口。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const notices = [];
const context = {
  require: () => ({ Plugin: class {}, TFile: class {}, ItemView: class {}, PluginSettingTab: class {}, Setting: class {}, Modal: class {}, Notice: class { constructor(m) { notices.push(String(m)); } }, addIcon() {} }),
  module: { exports: {} }, console, Date, window: { setTimeout, clearTimeout, setInterval, clearInterval },
  document: { hidden: false }, navigator: {}, setTimeout, clearTimeout, structuredClone, crypto: globalThis.crypto, TextEncoder, TextDecoder, Buffer, atob,
};
vm.runInNewContext(`${fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8')}\nmodule.exports.MemoStore = MemoStore;`, context);
const Pulse = context.module.exports;
const { MemoStore } = Pulse;
const View = Pulse.CrispPulseMemoView;
const { memoAsrErrorInfo, memoConversionReview, memoTranscriptionState } = Pulse.memoHelpers;
const same = (actual, expected, msg) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), msg);

test('provider error codes become actionable text; the raw error stays available', () => {
  const silent = memoAsrErrorInfo('20000003 · [Normal silence audio] no valid speech in audio · Log ID: 2026');
  assert.match(silent.text, /没有识别到说话声.*麦克风权限/);
  assert.match(silent.detail, /20000003/);
  assert.match(memoAsrErrorInfo('HTTP 401 Unauthorized').text, /API Key/);
  assert.match(memoAsrErrorInfo('429 Too Many Requests').text, /额度|频繁/);
  assert.match(memoAsrErrorInfo('fetch failed: ETIMEDOUT').text, /网络/);
  for (const own of ['请先在 Crisp ASR 设置中配置语音识别 API Key', '原速记中的录音已被移除，请检查后重试']) {
    same({ ...memoAsrErrorInfo(own) }, { text: own, detail: '' }, '已经是说明文字的原样显示');
  }
  const state = memoTranscriptionState({ memo: { transcriptAudio: [] }, job: { id: 'j', status: 'failed', lastError: '20000003 · silence audio' }, hasAsr: true, filePath: 'a.webm' });
  assert.match(state.error, /没有识别到说话声/);
  assert.match(state.errorDetail, /20000003/);
});

test('review counts each memo once and reads task completion from Tempo', () => {
  const memos = [
    { id: 'a', date: '2026-10-05', time: '09:00', text: '想法 A', links: ['笔记 A'], tempoTasks: ['t1', 't2'] },
    { id: 'a', date: '2026-10-05', time: '09:00', text: '想法 A（同一条在另一个文件的副本）', links: ['笔记 A'], tempoTasks: ['t1'] },
    { id: 'b', date: '2026-10-06', time: '10:00', text: '想法 B', links: [], tempoTasks: ['t3'] },
    { id: 'c', date: '2026-10-07', time: '11:00', text: '想法 C', links: ['Now/行动#^pulse-memo-c'], tempoTasks: [] },
    { id: 'd', date: '2026-10-08', time: '12:00', text: '只是记下', links: [], tempoTasks: [], transcriptJobs: ['j'] },
    { id: 'e', date: '2026-09-01', time: '12:00', text: '区间外', links: ['笔记 E'], tempoTasks: [] },
    { id: 'f', date: '2026-10-08', time: '13:00', text: '任务被删', links: [], tempoTasks: ['t9'] },
  ];
  const snapshots = { 'crisp-pulse:a': { id: 't2', status: 'done', title: '完成 A' }, 'crisp-pulse:b': { id: 't3', status: 'todo' } };
  const r = memoConversionReview(memos, '2026-10-01', '2026-10-09', snapshots);
  assert.equal(r.total, 5);
  assert.equal(r.converted, 4, 'A 同时转了笔记和任务，只算一条');
  assert.equal(r.toTasks, 3, 'A 重新转过一次任务，仍算一条');
  assert.equal(r.tasksDone, 1); assert.equal(r.tasksOpen, 1); assert.equal(r.tasksMissing, 1);
  assert.equal(r.toNotes, 1); assert.equal(r.toNow, 1); assert.equal(r.transcribed, 1);
  same(r.results.map((x) => x.link || x.task.id).sort(), ['t2', '笔记 A']);
  const noTempo = memoConversionReview(memos, '2026-10-01', '2026-10-09', null);
  assert.equal(noTempo.tasksUnknown, 3);
  assert.equal(noTempo.tasksOpen + noTempo.tasksDone + noTempo.tasksMissing, 0, '读不到 Tempo 时不能把任务算成未完成或已删除');
});

function storeFixture() {
  const files = new Map();
  const reads = [];
  const put = (p, content, mtime) => files.set(p, { path: p, content, stat: { mtime, size: content.length } });
  const app = {
    vault: {
      getMarkdownFiles: () => [...files.values()],
      cachedRead: async (f) => { reads.push(f.path); return files.get(f.path).content; },
    },
    metadataCache: { getFileCache: () => ({}) },
    internalPlugins: { getPluginById: () => ({ enabled: true, instance: { options: { folder: 'Daily', format: 'YYYY-MM-DD' } } }) },
  };
  const store = new MemoStore(app, () => ({}), null);
  return { store, files, reads, put };
}
const memoBlock = (time, text) => `> [!memo] ${time}\n> ${text}\n`;

test('memo listing only re-reads files that changed, and never serves stale results', async () => {
  const f = storeFixture();
  f.put('Daily/2026-10-08.md', memoBlock('09:00', '第一条'), 1);
  f.put('Daily/2026-10-09.md', memoBlock('10:00', '第二条'), 1);
  assert.equal((await f.store.list()).length, 2);
  f.reads.length = 0;
  const again = await f.store.list();
  assert.equal(again.length, 2);
  same(f.reads, [], '没变的文件不再读取');
  again[0].text = '调用方改了返回值';
  assert.notEqual((await f.store.list())[0].text, '调用方改了返回值');
  f.put('Daily/2026-10-09.md', memoBlock('10:00', '第二条') + memoBlock('11:00', '第三条'), 2);
  assert.equal((await f.store.list()).length, 3);
  same(f.reads, ['Daily/2026-10-09.md'], '只重读变了的文件');
  // 同一毫秒内写入、大小也没变：靠 modify 事件丢掉缓存
  f.files.get('Daily/2026-10-08.md').content = memoBlock('09:00', '改过了');
  f.store.forgetParsed('Daily/2026-10-08.md');
  assert.ok((await f.store.list()).some((m) => m.text === '改过了'));
  f.files.delete('Daily/2026-10-08.md');
  assert.equal((await f.store.list()).length, 2);
  assert.equal(f.store.parsed.has('Daily/2026-10-08.md'), false, '删掉的文件不留缓存');
});

function fakeAsr() {
  return { stops: 0,
    async startMemoDictation(sink) { this.sink = sink; sink.onState?.('listening'); },
    async stopMemoDictation() { this.stops++; this.sink.onState?.('finishing'); this.sink.onDone({ text: this.final ?? '' }); } };
}
function composerView(asr) {
  const input = { value: '', selectionStart: 0, selectionEnd: 0, setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; }, focus() {}, closest: () => ({ addClass() {} }) };
  const v = Object.create(View.prototype);
  v.containerEl = { win: { setTimeout, clearTimeout }, children: [{}, { querySelector: (sel) => (sel === '.crisp-pulse-memo-input' ? input : null) }] };
  v.draft = ''; v.draftRevision = 0;
  v.plugin = { memoDictationAsr: () => asr };
  return { v, input };
}

test('click-to-dictate starts and stops with one click each, with a visible end action', async () => {
  const asr = fakeAsr(); const { v, input } = composerView(asr);
  await v.toggleDictation();
  assert.equal(v.dictation.held, false);
  const status = v.composerStatus();
  assert.match(status.text, /听写中/);
  same(status.actions.map((a) => a[0]), ['结束']);
  asr.sink.onText('点一下就能听写', '');
  asr.final = '点一下就能听写';
  await v.toggleDictation();
  assert.equal(v.dictation, null);
  assert.equal(input.value, '点一下就能听写');
  assert.equal(v.composerStatus(), null);
});

test('starting dictation while recording is refused with a reason; recording shows its time and an end action', async () => {
  const asr = fakeAsr(); const { v } = composerView(asr);
  notices.length = 0;
  v.recording = { startedAt: new Date(Date.now() - 65000) };
  await v.toggleDictation();
  assert.equal(v.dictation ?? null, null);
  assert.match(notices.join('\n'), /正在录音/);
  assert.match(v.composerStatus().text, /录音中 1:0\d/);
  same(v.composerStatus().actions.map((a) => a[0]), ['结束录音']);
});

test('a restored draft is announced until the user edits or dismisses it', () => {
  const { v, input } = composerView(null);
  v.draft = '上次没提交的想法'; v.draftRestored = true;
  assert.match(v.composerStatus().text, /已恢复/);
  same(v.composerStatus().actions.map((a) => a[0]), ['清空', '知道了']);
  input.value = '上次没提交的想法，接着写'; v.setDraft(input.value);
  assert.equal(v.composerStatus(), null);
  v.draft = '又恢复了'; v.draftRestored = true; input.value = v.draft;
  v.composerStatus().actions[0][1]();
  assert.equal(v.draft, ''); assert.equal(input.value, '');
  assert.equal(v.composerStatus(), null);
});

test('memos written during a pomodoro break get #番茄 once, without matching longer tags', () => {
  const { memoWithTag } = Pulse.memoHelpers;
  assert.equal(memoWithTag('写完了第一节', '番茄'), '写完了第一节 #番茄');
  assert.equal(memoWithTag('已经有 #番茄 了', '番茄'), '已经有 #番茄 了');
  assert.equal(memoWithTag('只有 #番茄钟', '番茄'), '只有 #番茄钟 #番茄');
  assert.equal(memoWithTag('末尾有换行\n', '番茄'), '末尾有换行 #番茄');
});
