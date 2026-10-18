/* 界面语言测试：Pulse 跟随 Obsidian 的界面语言显示中文或英文。
   失败模式：英文界面仍显示中文；中文界面被改成英文；旧版 Obsidian 取不到语言；
   切成英文后写进笔记、会被再次解析的数据格式（速记块、ANKS 采集件）跟着变了。 */

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');

function load({ language, storedLanguage } = {}) {
  class Plugin { registerEvent() {} registerInterval() {} addCommand() {} }
  class TFile {}
  class Setting { setName() { return this; } setDesc() { return this; } }
  const obsidian = { Plugin, TFile, Setting, ItemView: class {}, PluginSettingTab: class {}, Notice: class {}, Modal: class {}, addIcon() {} };
  if (language !== undefined) obsidian.getLanguage = () => language;
  const window = { setInterval, clearInterval, setTimeout, clearTimeout };
  if (storedLanguage !== undefined) window.localStorage = { getItem: (key) => (key === 'language' ? storedLanguage : null) };
  const context = {
    require: () => obsidian,
    module: { exports: {} }, console, Date, window,
    document: { hidden: false }, navigator: { clipboard: { writeText: async () => {} } },
    setTimeout, clearTimeout, structuredClone, crypto: globalThis.crypto, atob, TextDecoder, TextEncoder, Buffer,
  };
  vm.runInNewContext(SOURCE + '\nmodule.exports.i18nProbe = { formatDateDisplay, DEFAULT_SETTINGS };', context);
  return context.module.exports;
}

const review = { totalScore: 12, notesCreated: 2, wordsAdded: 300, rewrittenWords: 0, tasksCompleted: 1, activeHours: 1.5, focusHours: 0, dirBreakdown: [], topFiles: [] };
const pendingJob = { id: 'j1', status: 'queued' };

test('英文界面：报告、转写状态和日期都显示英文', () => {
  const pulse = load({ language: 'en' });
  const report = pulse.generateWeeklyMarkdown(review);
  assert.doesNotMatch(report, /[一-鿿]/, report);
  assert.match(report, /Contribution score/);
  const state = pulse.memoHelpers.memoTranscriptionState({ memo: { text: '' }, job: pendingJob, filePath: 'a.webm' });
  assert.equal(state.label, 'Queued');
  assert.equal(pulse.i18nProbe.formatDateDisplay('2026-10-18'), 'Oct 18, 2026');
  assert.match(pulse.memoHelpers.memoRecordingName('audio/webm', new Date(2026, 9, 18, 9, 5, 7)), /^Recording 20261018090507\.webm$/);
});

test('中文界面：保持原来的中文', () => {
  const pulse = load({ language: 'zh' });
  assert.match(pulse.generateWeeklyMarkdown(review), /总贡献得分/);
  const state = pulse.memoHelpers.memoTranscriptionState({ memo: { text: '' }, job: pendingJob, filePath: 'a.webm' });
  assert.equal(state.label, '排队中');
  assert.equal(pulse.i18nProbe.formatDateDisplay('2026-10-18'), '2026年10月18日');
  assert.match(pulse.memoHelpers.memoRecordingName('audio/webm', new Date(2026, 9, 18, 9, 5, 7)), /^录音 /);
});

test('繁体中文界面也显示中文', () => {
  assert.equal(load({ language: 'zh-TW' }).i18nProbe.formatDateDisplay('2026-10-18'), '2026年10月18日');
});

test('旧版 Obsidian 没有 getLanguage：按 localStorage 判断，没存语言就是英文', () => {
  assert.equal(load({ storedLanguage: null }).i18nProbe.formatDateDisplay('2026-10-18'), 'Oct 18, 2026');
  assert.equal(load({ storedLanguage: 'zh' }).i18nProbe.formatDateDisplay('2026-10-18'), '2026年10月18日');
});

test('英文界面：新装的速记段落标题用英文，已有设置不改', () => {
  const en = load({ language: 'en' });
  const fresh = en.validateAndRepairStore(null, en.i18nProbe.DEFAULT_SETTINGS).store.settings;
  assert.equal(fresh.memoHeading, '## Memos');
  const kept = en.validateAndRepairStore({ settings: { memoHeading: '## 速记' } }, en.i18nProbe.DEFAULT_SETTINGS).store.settings;
  assert.equal(kept.memoHeading, '## 速记');
});

test('英文界面不改数据格式：速记块和 ANKS 采集件与中文界面逐字一致', () => {
  const en = load({ language: 'en' }).memoHelpers;
  const zh = load({ language: 'zh' }).memoHelpers;
  const at = new Date(2026, 9, 18, 9, 5);
  assert.equal(en.buildMemoBlock('first line #tag', at), zh.buildMemoBlock('first line #tag', at));
  const args = { date: '2026-10-18', topic: 'self-media', now: at, contract: { contract: 'anks-capture-v2', routing: { 'pulse-memo': { inbox_type: 'scratch' } } } };
  const anks = en.buildAnksMemoFile(args);
  assert.match(anks, /\n# 2026-10-18 速记\n$/);
  assert.equal(anks.replace(/RAW-\d+-MEMO-[0-9A-F]{4}/, 'ID'), zh.buildAnksMemoFile(args).replace(/RAW-\d+-MEMO-[0-9A-F]{4}/, 'ID'));
});
