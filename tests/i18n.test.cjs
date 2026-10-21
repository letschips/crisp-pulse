/* 界面语言测试：Pulse 跟随 Obsidian 的界面语言显示简体、繁体或英文。
   失败模式：英文界面仍显示中文；中文界面被改成英文；繁体界面露出简体；旧版 Obsidian 把「跟随系统」误判成英文；
   切换语言后写进库里的东西（速记块、ANKS 采集件、番茄标签、录音和归档文件名）跟着变了；改了中文文案没重新生成繁体表。 */

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');

function load({ language, storedLanguage, systemLanguage } = {}) {
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
    document: { hidden: false }, navigator: { clipboard: { writeText: async () => {} }, ...(systemLanguage ? { language: systemLanguage } : {}) },
    setTimeout, clearTimeout, structuredClone, crypto: globalThis.crypto, atob, TextDecoder, TextEncoder, Buffer,
  };
  vm.runInNewContext(SOURCE + '\nmodule.exports.i18nProbe = { formatDateDisplay, DEFAULT_SETTINGS, tr };\nmodule.exports.generateReviewReport = generateReviewReport;', context);
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
});

test('中文界面：保持原来的中文', () => {
  const pulse = load({ language: 'zh' });
  assert.match(pulse.generateWeeklyMarkdown(review), /总贡献得分/);
  const state = pulse.memoHelpers.memoTranscriptionState({ memo: { text: '' }, job: pendingJob, filePath: 'a.webm' });
  assert.equal(state.label, '排队中');
  assert.equal(pulse.i18nProbe.formatDateDisplay('2026-10-18'), '2026年10月18日');
  assert.match(pulse.memoHelpers.memoRecordingName('audio/webm', new Date(2026, 9, 18, 9, 5, 7)), /^录音 /);
});

/* 繁体只转界面文案：报告里的笔记路径、目录名是库里的真实名字，转成繁体链接就指不到了。 */
test('繁体中文界面：报告里的路径、链接和目录名保持库里的原样', () => {
  const pulse = load({ language: 'zh-TW' });
  const weekly = pulse.generateWeeklyMarkdown({ ...review, dirBreakdown: [{ dir: '知识/开发记录', percent: 60, count: 3, words: 120 }], topFiles: [{ path: '知识/开发记录.md', words: 120 }] });
  assert.match(weekly, /`知识\/开发记录`/, weekly);
  assert.match(weekly, /\[\[知识\/开发记录\.md\]\]/, weekly);
  assert.match(weekly, /檔案×日期記錄/, '界面文案照样是繁体');
  const actions = [{ title: '整理', status: 'done', outcomePath: '知识/开发记录.md' }];
  const evidence = [{ path: '知识/开发记录.md', originalPath: '旧目录/开发记录.md', capturedAt: '2026-10-21', quote: '' }];
  const line = (report, re) => report.split('\n').find((l) => re.test(l)) || '';
  const coverage = { recorded: 7, missing: 0, filtered: 0 };
  const period = { start: '2026-10-15', end: '2026-10-21', previousStart: '2026-10-08', previousEnd: '2026-10-14', days: 7 };
  const report = pulse.generateReviewReport({ period, current: { ...review, coverage, sourceWords: {} }, previous: { ...review, coverage }, comparison: [], scope: 'all', draft: {}, actions, evidence });
  assert.match(line(report, /結果筆記/), /\[\[知识\/开发记录\.md\]\]/, report);
  assert.match(line(report, /摘錄時路徑/), /旧目录\/开发记录\.md/, report);
});

test('繁体中文界面：界面和报告显示繁体，用台湾用语', () => {
  const pulse = load({ language: 'zh-TW' });
  assert.equal(pulse.i18nProbe.formatDateDisplay('2026-10-18'), '2026年10月18日');
  const report = pulse.generateWeeklyMarkdown(review);
  assert.match(report, /總貢獻得分/);
  assert.doesNotMatch(report, /总贡献得分|贡献|总/, report);
  const state = pulse.memoHelpers.memoTranscriptionState({ memo: { text: '' }, job: pendingJob, filePath: 'a.webm' });
  assert.equal(state.label, '排隊中');
  assert.equal(pulse.i18nProbe.tr('默认设置', 'Default settings'), '預設設定');
  assert.equal(pulse.i18nProbe.tr('工作复盘', 'Review'), '工作復盤');
  assert.equal(pulse.i18nProbe.tr('本地验签通过', 'x'), '本地驗簽通過');
  assert.equal(pulse.i18nProbe.tr('速记未通过写回核对，请重试', 'x'), '速記未通過寫回核對，請重試');
  assert.equal(pulse.i18nProbe.tr('通过 Crisp ASR 转写', 'x'), '透過 Crisp ASR 轉寫');
  // tr 里常嵌套 tr：已经转过的繁体再转一次不能变
  const once = pulse.i18nProbe.tr('基于有效编辑算法的番茄钟复盘', 'x');
  assert.equal(pulse.i18nProbe.tr(once, 'x'), once);
  // 只有简体界面保持简体
  assert.equal(load({ language: 'zh' }).i18nProbe.tr('默认设置', 'Default settings'), '默认设置');
  assert.equal(load({ storedLanguage: null, systemLanguage: 'zh-HK' }).i18nProbe.tr('设置', 'Settings'), '設定');
});

test('繁体表和文案同步：改了中文文案要重跑 npm run hant', () => {
  const { fingerprint, BEGIN, END } = require('../scripts/gen-hant.cjs');
  const table = JSON.parse(SOURCE.slice(SOURCE.indexOf(BEGIN) + BEGIN.length, SOURCE.indexOf(END)));
  assert.equal(table.fp, fingerprint(SOURCE), '中文文案变了，繁体表没重新生成：npm run hant');
});

test('旧版 Obsidian 没有 getLanguage：先看 localStorage，没存就跟随系统语言', () => {
  const date = (opts) => load(opts).i18nProbe.formatDateDisplay('2026-10-18');
  assert.equal(date({ storedLanguage: null, systemLanguage: 'zh-CN' }), '2026年10月18日');
  assert.equal(date({ storedLanguage: null, systemLanguage: 'en-US' }), 'Oct 18, 2026');
  assert.equal(date({ storedLanguage: 'zh', systemLanguage: 'en-US' }), '2026年10月18日');
  assert.equal(date({ storedLanguage: 'en', systemLanguage: 'zh-CN' }), 'Oct 18, 2026');
});

test('切换界面语言不改写进库里的名字：番茄标签、录音名、归档文件名', async () => {
  const at = new Date(2026, 9, 18, 9, 5, 7);
  for (const language of ['en', 'zh', 'zh-TW']) {
    const pulse = load({ language });
    assert.equal(pulse.memoHelpers.memoRecordingName('audio/webm', at), '录音 20261018090507.webm');
    const names = [];
    const plugin = Object.create(pulse.prototype);
    plugin.settings = { reviewArchiveFolder: 'reviews' };
    plugin.app = { vault: { adapter: { exists: async () => false }, create: async (p) => { names.push(p); }, createFolder: async () => {} }, workspace: { openLinkText() {} } };
    await plugin.archiveWeeklyReviewToVault(review, '2026-10-12', '2026-10-18');
    assert.match(names[0] || '', /^reviews\/\d{4}-W\d{2}-知识工作周报\.md$/, `${language}: ${names[0]}`);
  }
  assert.match(SOURCE, /const MEMO_POMODORO_TAG = "番茄";/);
});

test('英文界面：新装的速记段落标题用英文，已有设置不改', () => {
  const en = load({ language: 'en' });
  const fresh = en.validateAndRepairStore(null, en.i18nProbe.DEFAULT_SETTINGS).store.settings;
  assert.equal(fresh.memoHeading, '## Memos');
  const kept = en.validateAndRepairStore({ settings: { memoHeading: '## 速记' } }, en.i18nProbe.DEFAULT_SETTINGS).store.settings;
  assert.equal(kept.memoHeading, '## 速记');
});

test('英文、繁体界面不改数据格式：速记块和 ANKS 采集件与简体界面逐字一致', () => {
  const zh = load({ language: 'zh' }).memoHelpers;
  const at = new Date(2026, 9, 18, 9, 5);
  const args = { date: '2026-10-18', topic: 'self-media', now: at, contract: { contract: 'anks-capture-v2', routing: { 'pulse-memo': { inbox_type: 'scratch' } } } };
  for (const language of ['en', 'zh-TW']) {
    const other = load({ language }).memoHelpers;
    assert.equal(other.buildMemoBlock('first line #tag', at), zh.buildMemoBlock('first line #tag', at), language);
    const anks = other.buildAnksMemoFile(args);
    assert.match(anks, /\n# 2026-10-18 速记\n$/);
    assert.equal(anks.replace(/RAW-\d+-MEMO-[0-9A-F]{4}/, 'ID'), zh.buildAnksMemoFile(args).replace(/RAW-\d+-MEMO-[0-9A-F]{4}/, 'ID'), language);
  }
});
