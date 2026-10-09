/* 长按实时听写：每条测试对应一个会丢字、误触或卡住的失败模式。
   - 轻点仍是录音；长按才是听写；长按后浏览器补发的 click 不能再触发录音。
   - 手指滑出按钮、系统打断触摸（pointercancel）都要结束听写，不能一直开着麦克风。
   - 听写文字插在开始时的光标处，前后原有内容不变；未定稿的部分松开后被定稿文字取代。
   - 连上之前就松开：安静取消，不改输入框；启动被拒（ASR 正在给笔记听写）：提示且按钮恢复。
   - 中途断线：已经识别的文字留在输入框里，并提示原因。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const notices = [];
function load() {
  const context = {
    require: () => ({ Plugin: class {}, TFile: class {}, ItemView: class {}, PluginSettingTab: class {}, Setting: class {}, Modal: class {}, Notice: class { constructor(m) { notices.push(String(m)); } }, addIcon() {} }),
    module: { exports: {} }, console, Date, window: { setTimeout, clearTimeout, setInterval, clearInterval },
    document: { hidden: false }, navigator: {}, setTimeout, clearTimeout, structuredClone, crypto: globalThis.crypto, TextEncoder, TextDecoder, Buffer, atob,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8'), context);
  return context.module.exports;
}
const Pulse = load();
const { bindHoldPress } = Pulse.memoHelpers;
const View = Pulse.CrispPulseMemoView;

function fakeButton() {
  const handlers = {};
  return {
    handlers, captured: null,
    addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
    setPointerCapture(id) { this.captured = id; },
    fire(type, extra = {}) { const e = { type, button: 0, pointerId: 7, preventDefault() { this.prevented = true; }, ...extra }; for (const fn of handlers[type] || []) fn(e); return e; },
  };
}

function fakeTimers() {
  let now = 0; const timers = new Map(); let seq = 0;
  return {
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id) => timers.delete(id),
    advance(ms) { now += ms; for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); } },
  };
}

test('a short tap records; a long press dictates and the click after it is swallowed', () => {
  const b = fakeButton(); const t = fakeTimers(); const calls = [];
  bindHoldPress(b, { delay: 350, onTap: () => calls.push('tap'), onHoldStart: () => calls.push('start'), onHoldEnd: () => calls.push('end'), ...t });
  b.fire('pointerdown'); t.advance(100); b.fire('pointerup'); b.fire('click');
  assert.deepEqual(calls, ['tap']);
  b.fire('pointerdown'); t.advance(400); b.fire('pointerup'); b.fire('click');
  assert.deepEqual(calls, ['tap', 'start', 'end'], '长按后的 click 不能再触发录音');
  assert.equal(b.captured, 7, '按住后捕获指针，手指滑出按钮也能收到松开');
});

test('pointercancel and leaving the window end a held dictation', () => {
  for (const ending of ['pointercancel', 'lostpointercapture']) {
    const b = fakeButton(); const t = fakeTimers(); const calls = [];
    bindHoldPress(b, { delay: 350, onTap: () => calls.push('tap'), onHoldStart: () => calls.push('start'), onHoldEnd: () => calls.push('end'), ...t });
    b.fire('pointerdown'); t.advance(400); b.fire(ending); b.fire('pointerup');
    assert.deepEqual(calls, ['start', 'end'], ending);
  }
});

test('the long-press menu (iOS callout / right click) is suppressed on the button', () => {
  const b = fakeButton(); const t = fakeTimers();
  bindHoldPress(b, { delay: 350, onTap() {}, onHoldStart() {}, onHoldEnd() {}, ...t });
  assert.equal(b.fire('contextmenu').prevented, true);
});

function dictationView({ value = '买牛奶。', caret = 2, asr } = {}) {
  const input = { value, selectionStart: caret, selectionEnd: caret, setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; }, focus() {}, closest: () => ({ addClass() {} }) };
  const v = Object.create(View.prototype);
  v.containerEl = { win: { setTimeout, clearTimeout }, children: [{}, { querySelector: (sel) => (sel === '.crisp-pulse-memo-input' ? input : null) }] };
  v.draft = value; v.draftRevision = 0; v.updateRecordingUi = () => {};
  v.plugin = { memoDictationAsr: () => asr };
  return { v, input };
}

function fakeAsr({ failStart, gate } = {}) {
  const asr = { sink: null, stops: 0,
    async startMemoDictation(sink) { this.sink = sink; sink.onState?.('connecting'); if (gate) await gate; if (failStart) throw new Error(failStart); if (this.cancelled) { sink.onDone({ text: '' }); return; } sink.onState?.('listening'); },
    async stopMemoDictation() { this.stops++; if (!this.sink) return; if (gate && !this.listening) { this.cancelled = true; return; } this.sink.onState?.('finishing'); this.sink.onDone({ text: this.final ?? '', ...(this.error ? { error: this.error } : {}) }); },
  };
  return asr;
}

test('dictated text streams in at the caret, keeps the text around it, and settles on release', async () => {
  const asr = fakeAsr(); const { v, input } = dictationView({ asr });
  await v.startDictation();
  asr.sink.onText('', '下午');
  assert.equal(input.value, '买牛下午奶。');
  asr.sink.onText('下午三点', '开会');
  assert.equal(input.value, '买牛下午三点开会奶。');
  asr.final = '下午三点开会'; await v.stopDictation();
  assert.equal(input.value, '买牛下午三点开会奶。');
  assert.equal(v.draft, '买牛下午三点开会奶。');
  assert.equal(input.selectionStart, '买牛下午三点开会'.length, '光标停在听写文字后面');
  assert.equal(v.dictation, null);
});

test('releasing before the connection is up cancels without touching the composer', async () => {
  let open; const asr = fakeAsr({ gate: new Promise((r) => { open = r; }) }); const { v, input } = dictationView({ asr });
  const starting = v.startDictation();
  await v.stopDictation(); open(); await starting;
  assert.equal(input.value, '买牛奶。'); assert.equal(v.dictation, null); assert.equal(asr.stops, 1);
});

test('a refused start explains why and leaves the button usable', async () => {
  notices.length = 0;
  const asr = fakeAsr({ failStart: '实时听写正在进行，请先结束' }); const { v, input } = dictationView({ asr });
  await v.startDictation();
  assert.equal(input.value, '买牛奶。'); assert.equal(v.dictation, null);
  assert.match(notices.join('\n'), /实时听写正在进行/);
});

test('a dropped connection keeps what was recognised and says why', async () => {
  notices.length = 0;
  const asr = fakeAsr(); const { v, input } = dictationView({ asr, value: '', caret: 0 });
  await v.startDictation(); asr.sink.onText('先记下这一句', '');
  asr.sink.onDone({ text: '先记下这一句', error: '连接已断开' });
  assert.equal(input.value, '先记下这一句'); assert.equal(v.dictation, null);
  assert.match(notices.join('\n'), /连接已断开/);
});

test('without ASR dictation support a long press does nothing extra', async () => {
  const { v, input } = dictationView({ asr: null });
  await v.startDictation();
  assert.equal(input.value, '买牛奶。'); assert.equal(v.dictation ?? null, null);
});

/* 1.16.1：听写只改写自己写进去的那一段。
   - 手动补在听写文字后面的内容，不能被下一次识别更新抹掉。
   - 在听写文字前面插字，听写那段跟着挪；插入的字和那段开头相同也不能误判。
   - 改到听写那段里面：听写结束，之后的识别结果不再覆盖。
   - 这一轮结束后迟到的回调，不能改到之后的新草稿。 */
const typeAt = (v, input, pos, text) => {
  input.value = `${input.value.slice(0, pos)}${text}${input.value.slice(pos)}`;
  input.selectionStart = input.selectionEnd = pos + text.length;
  v.setDraft(input.value, input.selectionEnd);
};

test('text typed after the dictated words survives the next recognition update', async () => {
  const asr = fakeAsr(); const { v, input } = dictationView({ asr, value: '原文', caret: 2 });
  await v.startDictation();
  asr.sink.onText('听写', '');
  typeAt(v, input, input.value.length, '手动补充');
  asr.sink.onText('听写定稿', '');
  assert.equal(input.value, '原文听写定稿手动补充');
  assert.equal(input.selectionStart, input.value.length, '光标留在用户自己的文字后面');
  asr.final = '听写定稿'; await v.stopDictation();
  assert.equal(v.draft, '原文听写定稿手动补充');
});

test('text typed before the dictated words shifts the dictation range, even when the typed character matches', async () => {
  const asr = fakeAsr(); const { v, input } = dictationView({ asr, value: 'ab', caret: 2 });
  await v.startDictation();
  asr.sink.onText('cd', '');
  typeAt(v, input, 0, 'X');
  typeAt(v, input, 3, 'c'); // 插在听写那段开头，和它的第一个字相同
  asr.sink.onText('cde', '');
  assert.equal(input.value, 'Xabccde');
  assert.equal(v.dictation.detached, false);
});

test('editing inside the dictated words ends dictation and later results never overwrite the edit', async () => {
  notices.length = 0;
  const asr = fakeAsr(); const { v, input } = dictationView({ asr, value: '', caret: 0 });
  await v.startDictation();
  asr.sink.onText('今天', '下午');
  input.value = '今天上午'; input.selectionStart = input.selectionEnd = 4; v.setDraft(input.value, 4);
  assert.equal(asr.stops, 1, '改到听写文字里面就结束听写');
  assert.equal(input.value, '今天上午');
  assert.equal(v.dictation, null);
  assert.match(notices.join('\n'), /改动了正在听写的文字/);
});

test('callbacks arriving after a round ends never touch the next draft', async () => {
  const asr = fakeAsr(); const { v, input } = dictationView({ asr, value: '', caret: 0 });
  await v.startDictation();
  const old = asr.sink;
  asr.sink.onText('第一条识别结果', '');
  asr.final = '第一条识别结果'; await v.stopDictation();
  input.value = '下一条新想法'; input.selectionStart = input.selectionEnd = 6; v.setDraft(input.value, 6);
  old.onText('第一条最终结果', '');
  old.onDone({ text: '第一条最终结果' });
  assert.equal(input.value, '下一条新想法');
  assert.equal(v.draft, '下一条新想法');
});

test('a failed start ignores any late callbacks from that round', async () => {
  const asr = fakeAsr({ failStart: '网络错误' }); const { v, input } = dictationView({ asr });
  await v.startDictation();
  asr.sink.onText('迟到的文字', '');
  asr.sink.onDone({ text: '迟到的文字' });
  assert.equal(input.value, '买牛奶。');
});
