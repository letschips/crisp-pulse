const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { generateKeyPairSync, sign } = require('node:crypto');

// 授权测试一律用本测试进程里临时生成的 Ed25519 密钥对：内置公钥在加载 main.js 时被替换成它，
// 因此测试里的授权码只对本进程有效，不能是生产私钥签发的真实授权码（本文件是公开仓库的一部分）。
const LOCAL_KEY_PAIR = generateKeyPairSync('ed25519');
const LOCAL_PUBLIC_PEM = LOCAL_KEY_PAIR.publicKey.export({ type: 'spki', format: 'pem' }).toString().trim();
const PUBLIC_PEM_RE = /`-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----`/;
function localLicenseCode(overrides = {}) {
  const payload = Buffer.from(JSON.stringify({
    product: 'Crisp Suite', licenseId: 'LOCAL-PULSE-TEST', userName: 'local-tester',
    issuedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2999-01-01T00:00:00.000Z', maxDevices: 3, features: ['all'], ...overrides,
  })).toString('base64url');
  return `${payload}.${sign(null, Buffer.from(payload), LOCAL_KEY_PAIR.privateKey).toString('base64url')}`;
}

function setup() {
  let time = new Date(2026, 8, 8, 12).getTime();
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [time])); } static now() { return time; } }
  const events = new EventTarget();
  events.setInterval = (fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return t; };
  events.clearInterval = clearInterval;
  const cleanup = [];
  const registeredIcons = new Map();
  function addIcon(id, svg) { registeredIcons.set(id, svg); }
  class Plugin { registerEvent() {} registerInterval() {} addCommand(cmd) { (this.commands = this.commands || []).push(cmd); } addStatusBarItem() { return { setText() {}, addClass() {}, setAttr() {}, empty() {}, appendChild() {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, removeEventListener() {} }; } registerDomEvent(el, type, fn, options) { if (el?.addEventListener) el.addEventListener(type, fn, options); cleanup.push(() => el?.removeEventListener?.(type, fn, options)); } }
  class TFile {}
  class Modal { open() {} close() {} }
  class Setting {
    setName() { return this; }
    setDesc() { return this; }
    addDropdown() { return this; }
    addButton() { return this; }
    addToggle() { return this; }
    addSlider() { return this; }
    addText() { return this; }
    setCta() { return this; }
    setPlaceholder() { return this; }
    setValue() { return this; }
    onChange() { return this; }
    onClick() { return this; }
  }
  const context = {
    require: (mod) => {
      if (mod === "crypto") return require("crypto");
      if (mod === "util") return require("util");
      if (mod === "fs") return require("fs");
      if (mod === "path") return require("path");
      return { Plugin, TFile, Setting, ItemView: class {}, PluginSettingTab: class {}, Notice: class {}, Modal, addIcon };
    },
    module: { exports: {} },
    console,
    Date: Clock,
    window: events,
    document: { hidden: false, hasFocus: () => true, createElement: () => ({ setAttribute() {}, appendChild() {}, classList: { add() {}, remove() {} } }) },
    navigator: { clipboard: { writeText: async () => {} } },
    setTimeout,
    clearTimeout,
    structuredClone,
    crypto: globalThis.crypto,
    atob: globalThis.atob,
    TextDecoder: globalThis.TextDecoder,
    TextEncoder: globalThis.TextEncoder,
    Buffer: globalThis.Buffer
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8').replace(PUBLIC_PEM_RE, '`' + LOCAL_PUBLIC_PEM + '`') +
    '\nmodule.exports.helpers={sanitizeCSVCell,formatPulseMinutes:typeof formatPulseMinutes === "function" ? formatPulseMinutes : undefined,buildAnalyticsData:typeof buildAnalyticsData === "function" ? buildAnalyticsData : undefined,buildWritingMix:typeof buildWritingMix === "function" ? buildWritingMix : undefined,buildFolderShare:typeof buildFolderShare === "function" ? buildFolderShare : undefined,buildYearProfile:typeof buildYearProfile === "function" ? buildYearProfile : undefined,buildStrata:typeof buildStrata === "function" ? buildStrata : undefined,portraitDates:typeof portraitDates === "function" ? portraitDates : undefined,moonPath:typeof moonPath === "function" ? moonPath : undefined,buildWeekProfile:typeof buildWeekProfile === "function" ? buildWeekProfile : undefined,buildMonthPace:typeof buildMonthPace === "function" ? buildMonthPace : undefined,buildDayProfile:typeof buildDayProfile === "function" ? buildDayProfile : undefined,analyticsScale:typeof analyticsScale === "function" ? analyticsScale : undefined,analyticsLinePath:typeof analyticsLinePath === "function" ? analyticsLinePath : undefined,CrispPulseView,createEmptyDailyRecord,countTasks,countLinks,validateAndRepairStore,isPathIncluded,getScoreBreakdown,generateDailyCSV,filterDatesByRange,generateReviewData,generateWeeklyMarkdown,getLineSet,getCompletedTaskSet,getIsoWeekString,generateAnksWeeklyReviewFileContent,CrispFocusAdapter,verifyLicenseCode,CrispPulseLicenseManager,discoverVaultCrispLicense,renderAboutCard,ICON_COMPUTER_SVG,ICON_BLOCKS_WAVE_SVG,ICON_BLOCKS_WAVE_REGISTERED_SVG,CRISP_PULSE_ICON_ID:typeof CRISP_PULSE_ICON_ID !== "undefined" ? CRISP_PULSE_ICON_ID : undefined,checkBannerImageSize:typeof checkBannerImageSize === "function" ? checkBannerImageSize : undefined,splitActiveInterval:typeof splitActiveInterval === "function" ? splitActiveInterval : undefined,buildHourlyProfile:typeof buildHourlyProfile === "function" ? buildHourlyProfile : undefined,getReviewClues,reviewWeekRange};',
    context
  );
  const Pulse = context.module.exports;
  const p = new Pulse();
  p.manifest = { version: '1.7.0' };
  p.loadData = async () => null;
  p.saveData = async value => { p.persisted = JSON.parse(JSON.stringify(value)); };
  p.app = {
    vault: {
      getMarkdownFiles: () => [],
      read: async file => file.content,
      create: async (path, content) => ({ path, content }),
      modify: async (file, content) => { file.content = content; },
      createFolder: async () => {},
      getAbstractFileByPath: () => null,
      adapter: { exists: async () => false, write: async () => {}, list: async () => ({ files: [] }) }
    },
    workspace: { getLeavesOfType: () => [], getActiveFile: () => null, openLinkText: () => {}, onLayoutReady: () => {} },
    plugins: { getPlugin: () => null }
  };
  p.focusAdapter = new Pulse.helpers.CrispFocusAdapter(p);
  p.fileSnapshots = new Map();
  p.activeSessions = new Map();
  p.fileQueues = new Map();
  p.lastInteractionTime = time;
  // 多数统计测试模拟本人在编辑器里写；归因测试用 realEvidence() 换回真实判断
  p.hasWritingEvidence = () => true;
  p.hasCreationEvidence = () => true;
  p.realEvidence = () => { delete p.hasWritingEvidence; delete p.hasCreationEvidence; };
  const handlers = {};
  p.app.vault.on = (name, fn) => { handlers[name] = fn; };
  return { p, handlers, helpers: Pulse.helpers, events, context, registeredIcons, advance: ms => time += ms, cleanup: () => cleanup.forEach(fn => fn()) };
}

test('zero contribution weights really disable each component', async () => {
  const { p, helpers } = setup();
  await p.loadPluginData();
  for (const k of ['weightNoteCreated', 'weightMeaningfulEdit', 'weightTaskCompleted', 'weightLinkCreated', 'weightFocusMinute', 'captureMultiplier']) p.settings[k] = 0;
  p.settings.includeFocusInContribution = true;
  const r = helpers.createEmptyDailyRecord('2026-09-08');
  Object.assign(r.contribution, { notesCreated: 1, meaningfulEdits: 1, tasksCompleted: 1, linksCreated: 1, wordsAdded: 500, captureWords: 500 });
  r.activity.focusMinutes = 60;
  assert.equal(p.recomputeScore(r), 0);
});

test('forced historical rebuild preserves recorded days', async () => {
  const { p, helpers } = setup();
  await p.loadPluginData();
  const r = helpers.createEmptyDailyRecord('2026-09-07');
  r.contribution.wordsAdded = 123;
  p.store.daily[r.date] = r;
  const t = new Date(2026, 8, 7).getTime();
  p.app.vault.getMarkdownFiles = () => [{ path: 'a.md', stat: { ctime: t, mtime: t } }];
  await p.runHistoricalBackfill(true);
  assert.equal(p.store.daily[r.date].contribution.wordsAdded, 123);
  assert.equal(p.store.daily[r.date].quality, 'recorded');
});

test('frequent typing contributes time and listeners are removed on unload', async () => {
  const { p, events, advance, cleanup } = setup();
  await p.loadPluginData();
  p.registerActivityListeners();
  for (let i = 0; i < 121; i++) { advance(500); events.dispatchEvent(new Event('keydown')); }
  assert.ok(p.getOrCreateTodayRecord().activity.activeMinutes >= 1);
  const before = p.getOrCreateTodayRecord().activity.activeMinutes;
  cleanup();
  advance(2000);
  events.dispatchEvent(new Event('keydown'));
  assert.equal(p.getOrCreateTodayRecord().activity.activeMinutes, before);
});

test('small edits are persisted even without a meaningful session', async () => {
  const { p } = setup();
  await p.loadPluginData();
  p.fileSnapshots.set('a.md', { words: 1, tasks: 0, links: 0, lastTime: Date.now() });
  await p.handleFileModification({ path: 'a.md', content: 'one two' });
  await p.checkIdleSessions();
  assert.equal(p.persisted?.daily['2026-09-08'].contribution.wordsAdded, 1);
});

test('session closing after midnight credits its original date', async () => {
  const { p, helpers } = setup();
  await p.loadPluginData();
  p.store.daily['2026-09-07'] = helpers.createEmptyDailyRecord('2026-09-07');
  p.activeSessions.set('a.md', { date: '2026-09-07', lastEventTime: 0, isMeaningful: true });
  await p.checkIdleSessions();
  assert.equal(p.store.daily['2026-09-07'].contribution.meaningfulEdits, 1);
  assert.equal(p.getOrCreateTodayRecord().contribution.meaningfulEdits, 0);
});

test('markdown code examples are excluded from tasks and links', () => {
  const { helpers } = setup();
  const text = '- [x] real\n* [X] real too\n```md\n- [x] example [[fake]]\n```\ninline `- [x] fake [[fake]]` [[real]]';
  assert.equal(helpers.countTasks(text), 2);
  assert.equal(helpers.countLinks(text), 1);
});

test('queued saves cannot overwrite newer data with an older snapshot', async () => {
  const { p } = setup();
  await p.loadPluginData();
  let writes = 0;
  let disk;
  p.saveData = async value => {
    const snapshot = JSON.parse(JSON.stringify(value));
    await new Promise(r => setTimeout(r, ++writes === 1 ? 30 : 1));
    disk = snapshot;
  };
  p.getOrCreateTodayRecord().contribution.wordsAdded = 1;
  const a = p.savePluginData();
  p.getOrCreateTodayRecord().contribution.wordsAdded = 2;
  const b = p.savePluginData();
  await Promise.all([a, b]);
  assert.equal(disk.daily['2026-09-08'].contribution.wordsAdded, 2);
});

test('recent intensity excludes old outliers', async () => {
  const { p, helpers } = setup();
  await p.loadPluginData();
  for (const [d, v] of [['2020-01-01', 1000], ['2026-09-08', 5]]) {
    const r = helpers.createEmptyDailyRecord(d);
    r.contribution.score = v;
    p.store.daily[d] = r;
  }
  assert.equal(p.calculateIntensities().map.get('2026-09-08').percentile, 100);
});

test('startup baseline captures the first edit of an existing note', async () => {
  const { p } = setup();
  await p.loadPluginData();
  const file = { path: 'a.md', content: 'one', extension: 'md' };
  p.app.vault.getMarkdownFiles = () => [file];
  assert.equal(typeof p.initializeSnapshots, 'function');
  await p.initializeSnapshots();
  file.content = 'one two';
  await p.handleFileModification(file);
  assert.equal(p.getOrCreateTodayRecord().contribution.wordsAdded, 1);
});

test('concurrent reads cannot move the snapshot backwards or double count', async () => {
  const { p } = setup();
  await p.loadPluginData();
  p.fileSnapshots.set('a.md', { words: 1, tasks: 0, links: 0, lastTime: 0 });
  let reads = 0;
  p.app.vault.read = async () => {
    const n = ++reads;
    await new Promise(r => setTimeout(r, n === 1 ? 20 : 1));
    return n === 1 ? 'one two' : 'one two three';
  };
  await Promise.all([p.handleFileModification({ path: 'a.md' }), p.handleFileModification({ path: 'a.md' })]);
  assert.equal(p.fileSnapshots.get('a.md').words, 3);
  assert.equal(p.getOrCreateTodayRecord().contribution.wordsAdded, 2);
});

test('recorded activity mixed into estimates remains protected on rebuild', async () => {
  const { p, helpers } = setup();
  await p.loadPluginData();
  p.store.daily['2026-09-08'] = helpers.createEmptyDailyRecord('2026-09-08', 'estimated');
  const rec = p.getOrCreateTodayRecord();
  assert.equal(rec.quality, 'mixed');
});

test('settings loaded from disk reject negative and nonfinite weights', async () => {
  const { p, helpers } = setup();
  p.loadData = async () => ({ settings: { weightNoteCreated: -5, weightTaskCompleted: 'Infinity', captureMultiplier: 0 } });
  await p.loadPluginData();
  const r = helpers.createEmptyDailyRecord('2026-09-08');
  r.contribution.notesCreated = 1;
  r.contribution.tasksCompleted = 1;
  assert.equal(p.recomputeScore(r), 7);
  assert.equal(p.settings.captureMultiplier, 0);
});

test('folder renames keep historical file links and live snapshots connected', async () => {
  const { p, helpers, handlers } = setup();
  await p.loadPluginData();
  const r = helpers.createEmptyDailyRecord('2026-09-07');
  r.files['old/a.md'] = { wordsAdded: 4, created: true, tasks: 1, links: 0 };
  p.store.daily[r.date] = r;
  p.fileSnapshots.set('old/a.md', { words: 4 });
  p.activeSessions.set('old/a.md', { date: r.date, isMeaningful: true, lastEventTime: 0 });
  p.registerVaultEvents();
  await handlers.rename({ path: 'new' }, 'old');
  assert.equal(p.store.daily[r.date].files['new/a.md']?.wordsAdded, 4);
  assert.equal(p.fileSnapshots.get('new/a.md')?.words, 4);
  assert.equal(p.store.daily[r.date].files['old/a.md'], undefined);
});

test('deleting an edited file closes its session rather than losing it', async () => {
  const { p, handlers } = setup();
  await p.loadPluginData();
  p.activeSessions.set('a.md', { date: '2026-09-08', isMeaningful: true, lastEventTime: 0 });
  p.registerVaultEvents();
  await handlers.delete({ path: 'a.md' });
  assert.equal(p.getOrCreateTodayRecord().contribution.meaningfulEdits, 1);
});

test('legacy recorded values remain intact but are flagged as unverified', async () => {
  const { p, helpers } = setup();
  const r = helpers.createEmptyDailyRecord('2026-09-08');
  r.contribution.notesCreated = 2046;
  p.loadData = async () => ({ daily: { '2026-09-08': r } });
  await p.loadPluginData();
  assert.equal(p.store.daily['2026-09-08'].contribution.notesCreated, 2046);
  assert.equal(p.store.daily['2026-09-08'].legacyUnverified, true);
});

// --- 1.0.2 Tests ---

test('savePluginData returns error state and throwOnError propagates', async () => {
  const { p } = setup();
  await p.loadPluginData();
  p.saveData = async () => { throw new Error('disk write failed'); };

  const res = await p.savePluginData({ throwOnError: false });
  assert.equal(res.success, false);
  assert.equal(p.saveStatus, 'error');
  assert.equal(p.dirty, true);

  await assert.rejects(async () => {
    await p.savePluginData({ throwOnError: true });
  }, /disk write failed/);
});

/* 1.19.9：插件重载时旧实例还没写完的统计保存，不能在新实例读取、保存之后才落盘把新数据盖掉；
   卸载后旧实例迟到的保存也不再写盘。adapter 按 Obsidian 的方式串行读写。 */
test('a slow statistics save from the unloading instance lands before the new instance reads and saves', async () => {
  const files = new Map();
  let queue = Promise.resolve(), release, hold = true;
  const enqueue = (fn) => { const job = queue.then(fn, fn); queue = job.catch(() => {}); return job; };
  const adapter = {
    exists: async (p) => files.has(p),
    read: (p) => enqueue(async () => { if (!files.has(p)) throw new Error('missing'); return files.get(p); }),
    write: (p, c) => enqueue(async () => { if (hold) { hold = false; await new Promise((r) => { release = r; }); } files.set(p, c); }),
  };
  const make = () => {
    const { p } = setup();
    p.manifest = { version: '1.7.0', dir: 'plugin' };
    p.app.vault.adapter = adapter;
    p.saveData = (value) => adapter.write('plugin/data.json', JSON.stringify(value));
    p.loadData = async () => (files.has('plugin/data.json') ? JSON.parse(await adapter.read('plugin/data.json')) : null);
    return p;
  };
  const old = make();
  await old.loadPluginData();
  old.settings.memoHeading = '## 旧设置';
  const first = old.savePluginData();
  await new Promise((r) => setTimeout(r, 0));
  old.settings.memoHeading = '## 卸载快照';
  old.onunload();
  old.settings.memoHeading = '## 卸载后迟到';
  const late = old.savePluginData();
  const fresh = make();
  const loading = fresh.loadPluginData().then(async () => {
    assert.equal(fresh.settings.memoHeading, '## 卸载快照', '新实例读到旧实例最后的保存');
    fresh.settings.memoHeading = '## 新实例的重要设置';
    return fresh.savePluginData();
  });
  await new Promise((r) => setTimeout(r, 10));
  release();
  await first;
  assert.equal((await late).success, false, '卸载后的旧实例不再保存');
  const saved = await loading;
  assert.equal(saved.success, true);
  assert.equal(fresh.saveStatus, 'idle');
  assert.equal(JSON.parse(files.get('plugin/data.json')).settings.memoHeading, '## 新实例的重要设置');
});

test('validateAndRepairStore fixes missing contribution and activity subtrees', async () => {
  const { helpers } = setup();
  const brokenStore = {
    daily: {
      '2026-09-08': {
        quality: 'invalid_quality'
      }
    }
  };
  const { store, repairedCount } = helpers.validateAndRepairStore(brokenStore);
  assert.ok(repairedCount > 0);
  assert.equal(store.daily['2026-09-08'].quality, 'recorded');
  assert.equal(typeof store.daily['2026-09-08'].contribution.score, 'number');
  assert.equal(typeof store.daily['2026-09-08'].activity.focusMinutes, 'number');
  assert.equal(store.trackingVersion, 3);
});

test('automatic backup creates valid snapshot file', async () => {
  const { p } = setup();
  await p.loadPluginData();
  const writtenFiles = new Map();
  p.app.vault.adapter = {
    exists: async () => true,
    write: async (filePath, content) => { writtenFiles.set(filePath, content); },
    list: async () => ({ files: Array.from(writtenFiles.keys()) })
  };
  const backupRes = await p.createBackup('test');
  assert.equal(backupRes.success, true);
  assert.ok(writtenFiles.has(backupRes.path));
  const parsed = JSON.parse(writtenFiles.get(backupRes.path));
  assert.equal(parsed.trackingVersion, 3);
});

test('backup write failure halts destructive operations', async () => {
  const { p, helpers } = setup();
  await p.loadPluginData();
  const r = helpers.createEmptyDailyRecord('2026-09-08');
  r.contribution.wordsAdded = 999;
  p.store.daily['2026-09-08'] = r;

  p.app.vault.adapter = {
    exists: async () => true,
    write: async () => { throw new Error('EACCES: permission denied'); }
  };

  const backupRes = await p.createBackup('pre-reset');
  assert.equal(backupRes.success, false);
  assert.ok(backupRes.error);

  if (backupRes.success) {
    p.store.daily = {};
  }
  assert.equal(p.store.daily['2026-09-08'].contribution.wordsAdded, 999);
});

// --- 1.1.0 Credible Analytics Tests ---

test('path filtering respects excludedFolders and includedFolders whitelist', () => {
  const { helpers } = setup();
  const isPathIncluded = helpers.isPathIncluded;

  // Default: exclude templates, .obsidian
  assert.equal(isPathIncluded('Core/Notes.md', [], ['.obsidian', 'templates']), true);
  assert.equal(isPathIncluded('templates/Daily.md', [], ['.obsidian', 'templates']), false);
  assert.equal(isPathIncluded('.obsidian/plugins/crisp-pulse/test.md', [], ['.obsidian', 'templates']), false);

  // ANKS preset: include only Core, Topics
  assert.equal(isPathIncluded('Core/Architecture.md', ['Core', 'Topics'], ['Sidecar']), true);
  assert.equal(isPathIncluded('Topics/AI/Agent.md', ['Core', 'Topics'], ['Sidecar']), true);
  assert.equal(isPathIncluded('Sidecar/tools/sync.md', ['Core', 'Topics'], ['Sidecar']), false);
  assert.equal(isPathIncluded('RandomFolder/Note.md', ['Core', 'Topics'], ['Sidecar']), false);
});

test('trackingStartDate isolates historical anomalies from current streak and total', async () => {
  const { p, helpers } = setup();
  await p.loadPluginData();

  // Create old historical anomaly
  const oldRec = helpers.createEmptyDailyRecord('2026-08-01');
  oldRec.contribution.score = 5000;
  oldRec.legacyUnverified = true;
  p.store.daily['2026-08-01'] = oldRec;

  // Create today record
  const todayRec = helpers.createEmptyDailyRecord('2026-09-08');
  todayRec.contribution.score = 15;
  todayRec.contribution.notesCreated = 3;
  p.store.daily['2026-09-08'] = todayRec;

  // 1. Reliable scope automatically ignores legacyUnverified
  let stats = p.calcStats('reliable');
  assert.equal(stats.totalScore, 15);

  // 2. Setting trackingStartDate cleanly starts from specified date
  p.settings.trackingStartDate = '2026-09-08';
  stats = p.calcStats('reliable');
  assert.equal(stats.totalScore, 15);
  assert.equal(stats.activeDays, 1);
  assert.equal(stats.currentStreak, 1);

  // 3. With scope "all", old anomaly is included
  const allStats = p.calcStats('all');
  assert.equal(allStats.totalScore, 5015);
});

test('score breakdown sums exactly to total contribution score', async () => {
  const { p, helpers } = setup();
  await p.loadPluginData();
  const rec = helpers.createEmptyDailyRecord('2026-09-08');
  rec.contribution.notesCreated = 2; // 2 * 5 = 10
  rec.contribution.meaningfulEdits = 3; // 3 * 2 = 6
  rec.contribution.tasksCompleted = 4; // 4 * 2 = 8
  rec.contribution.linksCreated = 5; // 5 * 1 = 5
  rec.contribution.wordsAdded = 1000;
  rec.contribution.captureWords = 250;

  p.recomputeScore(rec);
  const breakdown = helpers.getScoreBreakdown(rec, p.settings);
  assert.equal(breakdown.totalScore, rec.contribution.score);
  assert.equal(
    Math.round((breakdown.notesCreatedScore + breakdown.meaningfulEditsScore + breakdown.tasksCompletedScore + breakdown.linksCreatedScore + breakdown.wordsTotalScore + breakdown.focusScore) * 10) / 10,
    rec.contribution.score
  );
});

test('generateDailyCSV escapes formula injection and formats rows', async () => {
  const { helpers } = setup();
  const daily = {
    '2026-09-08': {
      date: '=HYPERLINK("evil.com")',
      quality: 'recorded',
      contribution: { score: 10, wordsAdded: 100, wordsRemoved: 0, notesCreated: 1, meaningfulEdits: 1, tasksCompleted: 0, linksCreated: 0 },
      activity: { activeMinutes: 20, focusMinutes: 15 },
      files: { 'a.md': {} }
    }
  };
  const csv = helpers.generateDailyCSV(daily);
  const lines = csv.split('\n');
  assert.equal(lines[0], 'Date,Quality,Score,WordsAdded,WordsRemoved,NotesCreated,MeaningfulEdits,TasksCompleted,LinksCreated,ActiveMinutes,FocusMinutes,FilesCount');
  assert.ok(lines[1].includes("'=HYPERLINK") || lines[1].includes("''=HYPERLINK"));
  assert.ok(lines[1].includes('10'));
  assert.ok(lines[1].includes('20'));
});

// --- 1.2.0 Work Review & Retrospective Tests ---

test('rewriting detection credits content polish when net word delta is near zero', async () => {
  const { p, helpers } = setup();
  await p.loadPluginData();

  // Baseline initial content: 5 lines of 20 words each (total 100 words)
  const initialLines = [
    'Alpha one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen',
    'Bravo one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen',
    'Charlie one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen',
    'Delta one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen',
    'Echo one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'
  ];
  const initialContent = initialLines.join('\n');
  const initialWords = 100;

  p.fileSnapshots.set('draft.md', {
    words: initialWords,
    tasks: 0,
    links: 0,
    lineSet: helpers.getLineSet(initialContent),
    completedTaskSet: new Set(),
    lastTime: Date.now() - 5000
  });

  // Heavily polish all 5 lines to completely new wording of identical length
  const rewrittenLines = [
    'Zenith one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen',
    'Yankee one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen',
    'Xray one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen',
    'Whiskey one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen',
    'Victor one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'
  ];
  const rewrittenContent = rewrittenLines.join('\n');

  // Net words delta = 0, but 5 lines added, 5 lines removed
  await p.handleFileModification({ path: 'draft.md', content: rewrittenContent });

  const rec = p.getOrCreateTodayRecord();
  assert.ok(rec.contribution.rewrittenWords > 0, 'rewrittenWords should be recorded');
  assert.equal(rec.files['draft.md'].rewrittenWords, rec.contribution.rewrittenWords);
  assert.ok(rec.contribution.score > 0, 'score should increase from rewriting polish');
});

test('task state tracking prevents score inflation from toggling checkboxes back and forth', async () => {
  const { p, helpers } = setup();
  await p.loadPluginData();

  const file = { path: 'todo.md', content: '- [ ] Ship version 1.2.0 features' };
  p.fileSnapshots.set('todo.md', {
    words: 5,
    tasks: 0,
    links: 0,
    lineSet: helpers.getLineSet(file.content),
    completedTaskSet: helpers.getCompletedTaskSet(file.content),
    lastTime: Date.now() - 5000
  });

  // 1. Complete task
  file.content = '- [x] Ship version 1.2.0 features';
  await p.handleFileModification(file);
  const afterCheck = p.getOrCreateTodayRecord().contribution.tasksCompleted;
  assert.equal(afterCheck, 1, 'completing task adds 1');

  // 2. Uncheck task
  file.content = '- [ ] Ship version 1.2.0 features';
  await p.handleFileModification(file);
  const afterUncheck = p.getOrCreateTodayRecord().contribution.tasksCompleted;
  assert.equal(afterUncheck, 0, 'unchecking task subtracts 1');

  // 3. Re-check task
  file.content = '- [x] Ship version 1.2.0 features';
  await p.handleFileModification(file);
  const afterRecheck = p.getOrCreateTodayRecord().contribution.tasksCompleted;
  assert.equal(afterRecheck, 1, 'rechecking restores to 1, does not inflate to 2');
});

test('date range filtering properly clips calcStats active days and totals', async () => {
  const { p, helpers } = setup();
  await p.loadPluginData();

  // Reference date in mock is 2026-09-08
  // Add 1 entry today (within 7d, 30d, 90d, year, ytd)
  const todayRec = helpers.createEmptyDailyRecord('2026-09-08');
  todayRec.contribution.score = 20;
  todayRec.contribution.meaningfulEdits = 2;
  p.store.daily['2026-09-08'] = todayRec;

  // Add 1 entry 20 days ago (within 30d, 90d, year, ytd; outside 7d)
  const day20Rec = helpers.createEmptyDailyRecord('2026-08-19');
  day20Rec.contribution.score = 30;
  day20Rec.contribution.meaningfulEdits = 3;
  p.store.daily['2026-08-19'] = day20Rec;

  // Add 1 entry 60 days ago (within 90d, year, ytd; outside 7d, 30d)
  const day60Rec = helpers.createEmptyDailyRecord('2026-07-10');
  day60Rec.contribution.score = 50;
  day60Rec.contribution.meaningfulEdits = 5;
  p.store.daily['2026-07-10'] = day60Rec;

  // Test filterDatesByRange directly
  const allDates = ['2026-07-10', '2026-08-19', '2026-09-08'];
  assert.deepEqual(helpers.filterDatesByRange(allDates, '7d', new Date(2026, 8, 8)), ['2026-09-08']);
  assert.deepEqual(helpers.filterDatesByRange(allDates, '30d', new Date(2026, 8, 8)), ['2026-08-19', '2026-09-08']);
  assert.deepEqual(helpers.filterDatesByRange(allDates, '90d', new Date(2026, 8, 8)), ['2026-07-10', '2026-08-19', '2026-09-08']);

  // Test calcStats with date range
  const stats7d = p.calcStats('reliable', '7d');
  assert.equal(stats7d.totalScore, 20);
  assert.equal(stats7d.activeDays, 1);

  const stats30d = p.calcStats('reliable', '30d');
  assert.equal(stats30d.totalScore, 50);
  assert.equal(stats30d.activeDays, 2);

  const stats90d = p.calcStats('reliable', '90d');
  assert.equal(stats90d.totalScore, 100);
  assert.equal(stats90d.activeDays, 3);
});

test('weekly review generator outputs structured markdown with directory breakdown and top files', () => {
  const { helpers } = setup();

  const daily = {
    '2026-09-07': {
      date: '2026-09-07',
      contribution: { score: 15, notesCreated: 1, wordsAdded: 300, rewrittenWords: 50, tasksCompleted: 2 },
      activity: { activeMinutes: 45 },
      files: {
        'Core/System/Architecture.md': { wordsAdded: 200, created: true, tasks: 1 },
        'Topics/AI/Agent.md': { wordsAdded: 100, created: false, tasks: 1 }
      }
    },
    '2026-09-08': {
      date: '2026-09-08',
      contribution: { score: 25, notesCreated: 2, wordsAdded: 500, rewrittenWords: 100, tasksCompleted: 1 },
      activity: { activeMinutes: 75 },
      files: {
        'Core/System/Workflow.md': { wordsAdded: 400, created: true, tasks: 0 },
        'Sidecar/tools/sync.js': { wordsAdded: 100, created: false, tasks: 1 }
      }
    }
  };

  const review = helpers.generateReviewData(daily, '2026-09-07', '2026-09-08');
  assert.equal(review.totalScore, 40);
  assert.equal(review.notesCreated, 3);
  assert.equal(review.wordsAdded, 800);
  assert.equal(review.rewrittenWords, 150);
  assert.equal(review.tasksCompleted, 3);
  assert.equal(review.activeHours, '2.0');

  // Check directory breakdown
  assert.ok(review.dirBreakdown.length >= 2);
  const coreDir = review.dirBreakdown.find(d => d.dir === 'Core');
  assert.ok(coreDir);
  assert.equal(coreDir.count, 2);
  assert.equal(coreDir.words, 600);

  // Check top files
  assert.equal(review.topFiles[0].path, 'Core/System/Workflow.md');
  assert.equal(review.topFiles[0].words, 400);

  // Check markdown output
  const md = helpers.generateWeeklyMarkdown(review, '第37周知识工作复盘');
  assert.ok(md.includes('# 第37周知识工作复盘'));
  assert.ok(md.includes('总贡献得分**: 40 分'));
  assert.ok(md.includes('`Core`:'));
  assert.ok(md.includes('Core/System/Workflow.md'));
});

// --- 1.3.0 Ecosystem Integration Tests ---

test('getIsoWeekString computes standard ISO 8601 week number format', () => {
  const { helpers } = setup();
  assert.equal(helpers.getIsoWeekString(new Date(2026, 8, 8)), '2026-W37'); // 2026-09-08 is week 37
  assert.equal(helpers.getIsoWeekString(new Date(2026, 0, 1)), '2026-W01'); // 2026-01-01 is week 01
});

test('generateAnksWeeklyReviewFileContent generates valid ANKS frontmatter and insights', () => {
  const { helpers } = setup();

  // Case A: High Topics share (e.g. 75%)
  const reviewTopics = {
    totalScore: 52.5,
    notesCreated: 4,
    wordsAdded: 1200,
    rewrittenWords: 200,
    tasksCompleted: 6,
    activeHours: '3.5',
    dirBreakdown: [
      { dir: 'Topics', percent: 75, count: 12, words: 900 },
      { dir: 'Core', percent: 25, count: 4, words: 300 }
    ],
    topFiles: [{ path: 'Topics/self-media/draft.md', words: 600, created: true, tasks: 2 }]
  };

  const contentTopics = helpers.generateAnksWeeklyReviewFileContent(reviewTopics, '第37周知识工作复盘', '2026-09-01 ~ 2026-09-08');
  assert.ok(contentTopics.startsWith('---\n'));
  assert.ok(contentTopics.includes('type: review'));
  assert.ok(contentTopics.includes('subtype: weekly-review'));
  assert.ok(contentTopics.includes('anks/review'));
  assert.ok(contentTopics.includes('period: "2026-09-01 ~ 2026-09-08"'));
  assert.ok(contentTopics.includes('pulse_score: 52.5'));
  assert.ok(contentTopics.includes('ANKS 知识沉淀建议'));
  assert.ok(contentTopics.includes('Topics 占比 75%'));

  // Case B: High Core share (e.g. 60%)
  const reviewCore = {
    totalScore: 30,
    notesCreated: 2,
    wordsAdded: 800,
    rewrittenWords: 0,
    tasksCompleted: 2,
    activeHours: '2.0',
    dirBreakdown: [
      { dir: 'Core', percent: 60, count: 6, words: 500 },
      { dir: 'Topics', percent: 40, count: 4, words: 300 }
    ],
    topFiles: []
  };
  const contentCore = helpers.generateAnksWeeklyReviewFileContent(reviewCore, '第37周知识工作复盘', '2026-09-01 ~ 2026-09-08');
  assert.ok(contentCore.includes('ANKS 底层建设反馈'));
  assert.ok(contentCore.includes('Core 占比 60%'));
});

test('CrispFocusAdapter handles absence gracefully, hooks completion, and deduplicates', async () => {
  const { p, helpers } = setup();
  await p.loadPluginData();

  // 1. When Focus is absent
  p.app.plugins.getPlugin = () => null;
  const adapter = new helpers.CrispFocusAdapter(p);
  assert.equal(adapter.isAvailable(), false);
  assert.equal(adapter.isFocusRunning(), false);
  assert.equal(adapter.getFocusRemainingMs(), 0);
  adapter.attach();
  adapter.detach();
  const startRes = await adapter.startFocusSession(25);
  assert.equal(startRes, false);

  // 2. When Focus is present
  let focusCompletedCalled = 0;
  const mockFocusPlugin = {
    settings: { sessionDurationMinutes: 25 },
    session: {
      getSnapshot: () => ({ status: 'running', endAt: Date.now() + 1500000, remainingMs: 1500000 })
    },
    completeFocusSession: async () => { focusCompletedCalled++; },
    startFocusSession: async () => true
  };
  p.app.plugins.getPlugin = (id) => (id === 'crisp-focus' ? mockFocusPlugin : null);

  const activeAdapter = new helpers.CrispFocusAdapter(p);
  assert.equal(activeAdapter.isAvailable(), true);
  assert.equal(activeAdapter.isFocusRunning(), true);
  assert.ok(activeAdapter.getFocusRemainingMs() > 0);

  // Attach hook
  activeAdapter.attach();
  p.settings.includeFocusInContribution = true;
  p.settings.weightFocusMinute = 0.05;

  // Trigger completion
  await mockFocusPlugin.completeFocusSession();
  assert.equal(focusCompletedCalled, 1);
  assert.equal(p.getOrCreateTodayRecord().activity.focusMinutes, 25);
  assert.ok(p.getOrCreateTodayRecord().contribution.score > 0);

  // Trigger immediate second completion within 5s (deduplication check)
  await mockFocusPlugin.completeFocusSession();
  assert.equal(focusCompletedCalled, 2);
  // Should still be 25 mins, NOT 50 mins
  assert.equal(p.getOrCreateTodayRecord().activity.focusMinutes, 25);

  // Detach hook
  activeAdapter.detach();
  assert.equal(mockFocusPlugin.completeFocusSession, activeAdapter.originalComplete || mockFocusPlugin.completeFocusSession);
});

test('archiveWeeklyReviewToVault creates folders, writes file, and opens leaf', async () => {
  const { p } = setup();
  await p.loadPluginData();

  const createdFolders = [];
  const writtenFiles = new Map();
  let openedPath = null;

  p.app.vault.adapter = {
    exists: async (path) => writtenFiles.has(path),
    write: async (path, content) => { writtenFiles.set(path, content); }
  };
  p.app.vault.createFolder = async (path) => { createdFolders.push(path); };
  p.app.vault.create = async (path, content) => {
    writtenFiles.set(path, content);
    return { path, content };
  };
  p.app.vault.modify = async (file, content) => {
    writtenFiles.set(file.path, content);
  };
  p.app.workspace.openLinkText = (path) => { openedPath = path; };

  p.settings.reviewArchiveFolder = 'Topics/self-media/outputs/reviews';

  const reviewData = {
    totalScore: 45,
    notesCreated: 2,
    wordsAdded: 600,
    rewrittenWords: 50,
    tasksCompleted: 4,
    activeHours: '2.5',
    dirBreakdown: [{ dir: 'Topics', percent: 100, count: 5, words: 600 }],
    topFiles: []
  };

  const res = await p.archiveWeeklyReviewToVault(reviewData, '2026-09-01', '2026-09-08');
  assert.equal(res.success, true);
  assert.ok(res.path.includes('Topics/self-media/outputs/reviews'));
  assert.ok(res.path.includes('知识工作周报.md'));
  assert.ok(createdFolders.length > 0, 'should create target folder hierarchy');
  assert.ok(writtenFiles.has(res.path), 'file should be written');
  assert.equal(openedPath, res.path, 'file should be opened in workspace');

  const content = writtenFiles.get(res.path);
  assert.ok(content.includes('type: review'));
  assert.ok(content.includes('pulse_score: 45'));
});

test('calcStats computes both totalActiveHours and totalFocusHours independently', async () => {
  const { p, helpers } = setup();
  await p.loadPluginData();

  const rec = helpers.createEmptyDailyRecord('2026-09-08');
  rec.contribution.score = 20;
  rec.contribution.meaningfulEdits = 1;
  rec.activity.activeMinutes = 120; // 2.0 hours
  rec.activity.focusMinutes = 75;  // 1.25 hours -> 1.3
  p.store.daily['2026-09-08'] = rec;

  const stats = p.calcStats('reliable', '7d');
  assert.equal(stats.totalActiveHours, '2.0');
  assert.equal(stats.totalFocusHours, '1.3');
});

test('calculateIntensities distinguishes activity minutes from deep focus minutes', async () => {
  const { p, helpers } = setup();
  await p.loadPluginData();

  const rec = helpers.createEmptyDailyRecord('2026-09-08');
  rec.contribution.score = 10;
  rec.activity.activeMinutes = 90;
  rec.activity.focusMinutes = 25;
  p.store.daily['2026-09-08'] = rec;

  const actMap = p.calculateIntensities('activity', 'reliable').map;
  assert.equal(actMap.get('2026-09-08').value, 90);

  const focusMap = p.calculateIntensities('focus', 'reliable').map;
  assert.equal(focusMap.get('2026-09-08').value, 25);
});

test('archiveWeeklyReviewToVault preserves an existing report even when not cached as TFile', async () => {
  const { p } = setup();
  await p.loadPluginData();

  let adapterWritten = false;
  let adapterWritePath = '';
  let vaultCreateCalled = false;

  p.app.vault.adapter.exists = async () => true; // exists on disk
  p.app.vault.adapter.write = async (targetPath, content) => {
    adapterWritten = true;
    adapterWritePath = targetPath;
  };
  p.app.vault.getAbstractFileByPath = () => null; // not indexed in cache
  p.app.vault.create = async () => {
    vaultCreateCalled = true;
    throw new Error('File already exists.');
  };

  const reviewData = {
    totalScore: 50,
    notesCreated: 1,
    wordsAdded: 300,
    rewrittenWords: 0,
    tasksCompleted: 2,
    activeHours: '1.0',
    focusHours: '0.5',
    dirBreakdown: [],
    topFiles: []
  };

  const res = await p.archiveWeeklyReviewToVault(reviewData, '2026-09-01', '2026-09-08');
  assert.equal(res.success, false);
  assert.equal(adapterWritten, false);
  assert.equal(vaultCreateCalled, false);
  assert.equal(res.reason, 'exists');
});




test('activity does not count as completed Focus time and blur breaks the interval', async () => {
  const {p,events,advance}=setup(); await p.loadPluginData(); p.registerActivityListeners();
  advance(2000); events.dispatchEvent(new Event('keydown'));
  assert.ok(p.getOrCreateTodayRecord().activity.activeMinutes>0);
  assert.equal(p.getOrCreateTodayRecord().activity.focusMinutes,0);
  const before=p.getOrCreateTodayRecord().activity.activeMinutes;
  events.dispatchEvent(new Event('blur'));advance(30000);events.dispatchEvent(new Event('keydown'));
  assert.equal(p.getOrCreateTodayRecord().activity.activeMinutes,before);
});
test('an edit arriving while disk write is pending remains dirty and is saved next',async()=>{
  const {p}=setup();await p.loadPluginData();let release;
  p.saveData=()=>new Promise(r=>release=r);
  const saving=p.savePluginData();await new Promise(r=>setImmediate(r));
  p.getOrCreateTodayRecord().contribution.wordsAdded=7;p.dirty=true;release();await saving;
  assert.equal(p.dirty,true);
  p.saveData=async value=>p.persisted=JSON.parse(JSON.stringify(value));await p.checkIdleSessions();
  assert.equal(p.persisted.daily['2026-09-08'].contribution.wordsAdded,7);
});
test('literal folder rename does not rename a regex lookalike path',async()=>{
  const {p,handlers,helpers}=setup();await p.loadPluginData();p.registerVaultEvents();
  const r=helpers.createEmptyDailyRecord('2026-09-08');r.files={'a.b/n.md':{wordsAdded:2},'axb/n.md':{wordsAdded:3}};p.store.daily[r.date]=r;
  handlers.rename({path:'new'},'a.b');assert.equal(r.files['axb/n.md']?.wordsAdded,3);assert.equal(r.files['new/n.md']?.wordsAdded,2);
});
test('rolling seven-day range includes today and six previous days',()=>{
  const {helpers}=setup();assert.deepEqual(Array.from(helpers.filterDatesByRange(['2026-09-01','2026-09-02','2026-09-08'],'7d',new Date(2026,8,8))),['2026-09-02','2026-09-08']);
});
test('reliable totals and heatmap exclude estimated mixed legacy and pre-start records',async()=>{
  const {p,helpers}=setup();await p.loadPluginData();p.settings.trackingStartDate='2026-09-04';
  for(const [d,q,legacy]of [['2026-09-02','recorded',false],['2026-09-04','estimated',false],['2026-09-05','mixed',false],['2026-09-06','recorded',true],['2026-09-08','recorded',false]]){const r=helpers.createEmptyDailyRecord(d,q);r.legacyUnverified=legacy;r.contribution.score=5;p.store.daily[d]=r;}
  assert.equal(p.calcStats('reliable').totalScore,5);
  const map=p.calculateIntensities('contribution','reliable').map;
  assert.equal(map.get('2026-09-06').value,0);assert.equal(map.get('2026-09-08').percentile,100);
});
test('backup without durable storage must fail',async()=>{
  const {p}=setup();await p.loadPluginData();p.app.vault.adapter=null;assert.equal((await p.createBackup()).success,false);
});
test('new configuration receives string and list defaults',async()=>{
  const {p}=setup();await p.loadPluginData();assert.equal(p.settings.weekStartsOn,'sunday');assert.deepEqual(Array.from(p.settings.excludedFolders),['.obsidian','.trash','templates']);
});
test('unload during baseline read discards the in-flight result',async()=>{
  const {p}=setup();await p.loadPluginData();let release;p.app.vault.getMarkdownFiles=()=>[{path:'a.md'}];p.app.vault.read=()=>new Promise(r=>release=r);
  const reading=p.initializeSnapshots();p.stopped=true;release('hello');await reading;assert.equal(p.fileSnapshots.size,0);
});
test('Focus reload restores old instance and wrapper does not call another instances method',async()=>{
  const {p,helpers}=setup();await p.loadPluginData();let firstCalls=0,secondCalls=0;
  const first={settings:{sessionDurationMinutes:25},completeFocusSession:async()=>firstCalls++,onSessionUpdate:()=>{}};
  const second={settings:{sessionDurationMinutes:25},completeFocusSession:async()=>secondCalls++,onSessionUpdate:()=>{}};
  let current=first;p.app.plugins.getPlugin=()=>current;const a=new helpers.CrispFocusAdapter(p);const original=first.completeFocusSession;
  a.attach();current=second;a.attach();assert.equal(first.completeFocusSession,original);await first.completeFocusSession();assert.equal(secondCalls,0);a.detach();
});
test('task replacement in one save is net zero and cannot cancel another files contribution',async()=>{
 const {p,helpers}=setup();await p.loadPluginData();p.fileSnapshots.set('a.md',{words:2,tasks:1,links:0,completedTaskSet:helpers.getCompletedTaskSet('- [x] old'),lineSet:helpers.getLineSet('- [x] old'),lastTime:0});
 const r=p.getOrCreateTodayRecord();r.contribution.tasksCompleted=3;r.files['a.md']={wordsAdded:0,tasks:1,links:0};
 await p.handleFileModification({path:'a.md',content:'- [ ] old\n- [x] new'});assert.equal(r.contribution.tasksCompleted,3);
 p.fileSnapshots.set('b.md',{words:2,tasks:1,links:0,completedTaskSet:helpers.getCompletedTaskSet('- [x] previous day'),lastTime:0});
 await p.handleFileModification({path:'b.md',content:'- [ ] previous day'});assert.equal(r.contribution.tasksCompleted,3);
});
test('identical completed task lines preserve multiplicity',()=>{
 const {helpers}=setup();assert.equal(helpers.getCompletedTaskSet('- [x] review\n- [x] review').size,2);
});
test('weekly review uses the same reliable record selection as the dashboard',async()=>{
 const {p,helpers}=setup();await p.loadPluginData();for(const [d,q] of [['2026-09-07','estimated'],['2026-09-08','recorded']]){const r=helpers.createEmptyDailyRecord(d,q);r.contribution.score=10;p.store.daily[d]=r;}
 assert.equal(typeof p.getReviewData,'function');assert.equal(p.getReviewData('2026-09-02','2026-09-08','reliable').totalScore,10);
});
test('archive rejects paths escaping the vault without creating a folder or writing',async()=>{
 const {p}=setup();await p.loadPluginData();p.settings.reviewArchiveFolder='../outside';let mutations=0;p.app.vault.createFolder=async()=>mutations++;p.app.vault.create=async()=>{mutations++;return {path:'x'}};
 const r=await p.archiveWeeklyReviewToVault({dirBreakdown:[],topFiles:[]},'2026-09-02','2026-09-08');assert.equal(r.success,false);assert.equal(mutations,0);
});
test('an already stale session closes before the next edit begins',async()=>{
 const {p}=setup();await p.loadPluginData();p.activeSessions.set('a.md',{date:'2026-09-07',lastEventTime:0,isMeaningful:true,wordsDeltaTotal:20});p.fileSnapshots.set('a.md',{words:1,tasks:0,links:0,lastTime:0});await p.handleFileModification({path:'a.md',content:'one two'});
 assert.equal(p.store.daily['2026-09-07'].contribution.meaningfulEdits,1);assert.equal(p.activeSessions.get('a.md').date,'2026-09-08');
});

test('verifyLicenseCode validates Ed25519 signature and rejects invalid codes', async () => {
  const { helpers } = setup();
  const validCode = localLicenseCode();
  
  // 1. Empty code
  const emptyRes = await helpers.verifyLicenseCode("");
  assert.equal(emptyRes.valid, false);
  assert.match(emptyRes.reason, /为空/);

  // 2. Malformed code
  const malformedRes = await helpers.verifyLicenseCode("invalid.token.extra");
  assert.equal(malformedRes.valid, false);

  // 3. Valid Crisp Suite signature
  const validRes = await helpers.verifyLicenseCode(validCode);
  assert.equal(validRes.valid, true);
  assert.equal(validRes.payload.userName, "local-tester");
  assert.equal(validRes.payload.product, "Crisp Suite");

  // 4. Tampered signature
  const tamperedCode = validCode.slice(0, -6) + "xxxxxx";
  const tamperedRes = await helpers.verifyLicenseCode(tamperedCode);
  assert.equal(tamperedRes.valid, false);

  // 5. Well-formed signature from a key that is not the embedded trust anchor
  const foreignPayload = validCode.split(".")[0];
  const foreignKey = generateKeyPairSync('ed25519').privateKey;
  const foreignRes = await helpers.verifyLicenseCode(`${foreignPayload}.${sign(null, Buffer.from(foreignPayload), foreignKey).toString('base64url')}`);
  assert.equal(foreignRes.valid, false);
});

test('CrispPulseLicenseManager verifies and maintains entitlement state', async () => {
  const { helpers } = setup();
  const validCode = localLicenseCode();
  const settings = { licenseCode: validCode, licenseLastOnlineAt: 0 };
  const lm = new helpers.CrispPulseLicenseManager(null, settings);

  assert.equal(lm.isEntitled(), false, '构造后必须先是未授权，不能在验签前放行');
  await lm.initialize();
  assert.equal(lm.isEntitled(), true);
  assert.equal(lm.getStatus().valid, true);

  const res = await lm.verify(validCode);
  assert.equal(res.valid, true);
  assert.equal(lm.isEntitled(), true);

  // Invalidate license
  const invalidRes = await lm.verify("bad.signature");
  assert.equal(invalidRes.valid, false);
  assert.equal(lm.isEntitled(), false);
});

test('renderAboutCard creates author card with letschips link', () => {
  const { helpers } = setup();
  const createdElements = [];
  const fakeDoc = {
    createElement(tag) {
      const el = {
        tagName: tag.toUpperCase(),
        className: "",
        textContent: "",
        children: [],
        append(...kids) { el.children.push(...kids); }
      };
      createdElements.push(el);
      return el;
    }
  };
  const container = {
    ownerDocument: fakeDoc,
    append(child) { this.child = child; }
  };

  helpers.renderAboutCard(container, "Crisp Pulse", "知识脉冲热力图");
  assert.ok(container.child);
  assert.equal(container.child.className, "crisp-pulse-about");
  const authorLink = createdElements.find(e => e.className === "crisp-pulse-about__author-link");
  assert.ok(authorLink);
  assert.equal(authorLink.textContent, "小红书 letschips");
  assert.equal(authorLink.href, "https://xhslink.cn/m/3MwtKu4822b");
});

test('Score breakdown title renders SVG computer icon rather than emoji', () => {
  const { helpers } = setup();
  assert.ok(helpers.ICON_COMPUTER_SVG);
  assert.ok(helpers.ICON_COMPUTER_SVG.includes("viewBox=\"0 0 281.25 281.25\""));
  assert.ok(helpers.ICON_COMPUTER_SVG.includes("crisp-pulse-breakdown-icon"));
});

test('Header title renders animated blocks-wave SVG rather than lightning emoji', () => {
  const { helpers } = setup();
  assert.ok(helpers.ICON_BLOCKS_WAVE_SVG);
  assert.ok(helpers.ICON_BLOCKS_WAVE_SVG.includes('viewBox="0 0 24 24"'));
  assert.ok(helpers.ICON_BLOCKS_WAVE_SVG.includes('crisp-pulse-title-icon-svg'));
  assert.ok(helpers.ICON_BLOCKS_WAVE_SVG.includes('<animate'));
  assert.ok(helpers.ICON_BLOCKS_WAVE_SVG.includes('fill="currentColor"'));
  assert.ok(!helpers.ICON_BLOCKS_WAVE_SVG.includes('fill="#000000"'));
});

test('Animated blocks-wave icon is registered for tab header and ribbon without duplicate IDs', async () => {
  const { p, helpers, registeredIcons } = setup();
  await p.loadPluginData();
  assert.equal(helpers.CRISP_PULSE_ICON_ID, "crisp-pulse");
  assert.equal(registeredIcons.get(helpers.CRISP_PULSE_ICON_ID), helpers.ICON_BLOCKS_WAVE_REGISTERED_SVG);
  assert.ok(helpers.ICON_BLOCKS_WAVE_REGISTERED_SVG.includes('<animate'));
  assert.equal((helpers.ICON_BLOCKS_WAVE_REGISTERED_SVG.match(/<animate/g) || []).length, 36);
  assert.ok(!helpers.ICON_BLOCKS_WAVE_REGISTERED_SVG.includes(' id="'));
  assert.ok(!helpers.ICON_BLOCKS_WAVE_REGISTERED_SVG.includes('begin="SVG'));
  assert.ok(!helpers.ICON_BLOCKS_WAVE_REGISTERED_SVG.includes('crisp-pulse-title-icon-svg'));
  const view = new helpers.CrispPulseView({}, p);
  assert.equal(view.getIcon(), helpers.CRISP_PULSE_ICON_ID);
});

test('schema validation preserves large valid daily records and their legacy warning',()=>{
 const {helpers}=setup();const r=helpers.createEmptyDailyRecord('2026-09-08');r.legacyUnverified=true;r.contribution.wordsAdded=150000;r.contribution.notesCreated=1;r.contribution.score=35;r.files['Research.md']={wordsAdded:150000,created:true,tasks:0,links:0};
 const before=JSON.stringify(r);const {store}=helpers.validateAndRepairStore({trackingVersion:3,daily:{[r.date]:r}});assert.equal(JSON.stringify(store.daily[r.date]),before);
});
test('same-second backups have distinct paths and preserve unrelated JSON files',async()=>{
 const {p}=setup();await p.loadPluginData();const written=new Map();const unrelated='.obsidian/plugins/crisp-pulse/backups/000-notes.json';written.set(unrelated,'user data');
 p.app.vault.adapter={exists:async path=>written.has(path),mkdir:async()=>{},write:async(path,data)=>written.set(path,data),list:async()=>({files:[...written.keys()]}),remove:async path=>written.delete(path)};
 const paths=[];for(let i=0;i<6;i++)paths.push((await p.createBackup('manual')).path);
 assert.equal(new Set(paths).size,6);assert.equal(written.get(unrelated),'user data');assert.equal(written.size,6);
});
test('in-flight modification after unload cannot change snapshots or counters',async()=>{
 const {p}=setup();await p.loadPluginData();p.fileSnapshots.set('a.md',{words:1,tasks:0,links:0,lastTime:0});let release;p.app.vault.read=()=>new Promise(r=>release=r);
 const pending=p.handleFileModification({path:'a.md'});await new Promise(r=>setImmediate(r));p.stopped=true;release('one two');await pending;assert.equal(p.fileSnapshots.get('a.md').words,1);assert.equal(Object.keys(p.store.daily).length,0);
});
test('renaming while a file read is queued cleans up its original queue key',async()=>{
 const {p,handlers}=setup();await p.loadPluginData();p.registerVaultEvents();const file={path:'old.md',extension:'md'};let release;p.app.vault.read=()=>new Promise(r=>release=r);const pending=p.handleFileModification(file);await new Promise(r=>setImmediate(r));file.path='new.md';handlers.rename(file,'old.md');release('one');await pending;assert.equal(p.fileQueues.size,0);
});


test('all time filters keep 53 complete week columns with the selected interval marked',async()=>{
  const {p,helpers}=setup();await p.loadPluginData();
  function element(cls='') {
    const e={cls,children:[],dataset:{},style:{},classList:{add(){}},setAttr(){},addEventListener(){}};
    e.createDiv=options=>{const child=element(options?.cls||'');e.children.push(child);return child;};
    e.createSpan=e.createDiv;e.createEl=(_tag,options)=>e.createDiv(options);return e;
  }
  function all(e){return [e,...e.children.flatMap(all)];}
  for(const range of ['year','90d','30d','7d','ytd']){
    const v=new helpers.CrispPulseView({},p);v.currentDateRange=range;const root=element();v.renderHeatmapCard(root);
    assert.equal(all(root).filter(e=>e.cls==='crisp-pulse-week-col').length,53,range);
    const days=all(root).filter(e=>e.dataset.date);
    assert.ok(days.length>=365,range);
    if(['90d','30d','7d'].includes(range))assert.equal(days.filter(e=>e.dataset.inRange==='true').length,parseInt(range),range);
  }
});


test('analytics distinguishes zero missing and filtered dates without mutating the store',()=>{
 const {helpers}=setup();const r=helpers.createEmptyDailyRecord('2026-09-08');r.contribution.score=0;
 const excluded=helpers.createEmptyDailyRecord('2026-09-07','estimated');excluded.contribution.score=100;
 const daily={'2026-09-08':r,'2026-09-07':excluded};const before=JSON.stringify(daily);
 const data=helpers.buildAnalyticsData(daily,['2026-09-06','2026-09-07','2026-09-08'],rec=>rec.quality==='recorded');
 assert.equal(data.points[0].status,'missing');assert.equal(data.points[0].score,null);
 assert.equal(data.points[1].status,'excluded');assert.equal(data.points[1].score,null);
 assert.equal(data.points[2].score,0);assert.equal(data.recordedDays,1);assert.equal(data.totals.score,0);assert.equal(JSON.stringify(daily),before);
});
test('analytics keeps writing and time series in independent units',()=>{
 const {helpers}=setup();const r=helpers.createEmptyDailyRecord('2026-09-08');Object.assign(r.contribution,{score:12.3,wordsAdded:200,wordsRemoved:30,rewrittenWords:45});Object.assign(r.activity,{activeMinutes:6.5,focusMinutes:25});
 const d=helpers.buildAnalyticsData({[r.date]:r},[r.date],()=>true);
 assert.equal(d.totals.score,12.3);assert.equal(d.totals.wordsAdded,200);assert.equal(d.totals.activeMinutes,6.5);assert.equal(d.totals.focusMinutes,25);
});
test('chart axes cover the maximum and line segments break at missing data',()=>{
 const {helpers}=setup();for(const n of [0,0.1,7,115,1000000]){const scale=helpers.analyticsScale(n);assert.ok(scale.max>=n&&scale.max>0);assert.equal(scale.ticks[0],0);}
 const p=helpers.analyticsLinePath([{value:2},{value:null},{value:3},{value:4}], 'value',i=>i*10,v=>100-v);
 assert.equal(p,'M0,98 M20,97 L30,96');
});

test('small daily time values accumulate before rounding in both summaries',async()=>{
 const {p,helpers}=setup();await p.loadPluginData();for(let i=1;i<=8;i++){const key=`2026-09-0${i}`;const r=helpers.createEmptyDailyRecord(key);r.activity.activeMinutes=.4;r.activity.focusMinutes=.4;p.store.daily[key]=r;}
 assert.equal(p.calcStats('all').totalActiveHours,'0.1');assert.equal(p.calcStats('all').totalFocusHours,'0.1');const review=helpers.generateReviewData(p.store.daily);assert.equal(review.activeHours,'0.1');assert.equal(review.focusHours,'0.1');
});
test('directory shares total exactly 100 percent',()=>{
 const {helpers}=setup();const r=helpers.createEmptyDailyRecord('2026-09-08');r.files={'A/a.md':{},'B/b.md':{},'C/c.md':{}};
 const review=helpers.generateReviewData({[r.date]:r});assert.equal(review.dirBreakdown.reduce((n,d)=>n+d.percent,0),100);
});
test('impossible calendar dates cannot enter date filters',()=>{
 const {p,helpers}=setup();assert.equal(p.recordMatchesScope({},'2026-02-31','all'),false);assert.deepEqual(Array.from(helpers.filterDatesByRange(['2026-02-31','2026-02-28','2026-13-01'],'ytd',new Date(2026,8,8))),['2026-02-28']);
});
test('creating a large imported note applies the existing capture discount',async()=>{
 const {p,handlers}=setup();await p.loadPluginData();p.registerVaultEvents();
 assert.equal(typeof p.handleFileCreation,'function');
 await p.handleFileCreation({path:'import.md',content:'word '.repeat(600)});
 assert.equal(p.getOrCreateTodayRecord().contribution.captureWords,600);
});


test('minute display limits precision without changing the underlying value',()=>{
 const {helpers}=setup();const value=11.801533333333333;
 assert.equal(helpers.formatPulseMinutes(value),'11.8');
 assert.equal(helpers.formatPulseMinutes(20),'20');
 assert.equal(helpers.formatPulseMinutes(0),'0');
 assert.equal(helpers.formatPulseMinutes(NaN),'0');
 assert.equal(value,11.801533333333333);
});


test('CSV quoting handles carriage returns and formulas preceded by whitespace',()=>{
 const {helpers}=setup();assert.equal(helpers.sanitizeCSVCell('hello\rworld'),'"hello\rworld"');assert.equal(helpers.sanitizeCSVCell('  =1+1'),"'  =1+1");
});
test('Focus availability refresh attaches a replacement plugin without opening a view',async()=>{
 const {p,helpers}=setup();await p.loadPluginData();let current=null;p.app.plugins.getPlugin=()=>current;const adapter=new helpers.CrispFocusAdapter(p);adapter.isFocusRunning();
 const original=async()=>{};current={settings:{sessionDurationMinutes:25},completeFocusSession:original,session:{getSnapshot:()=>({status:'running'})}};
 adapter.isFocusRunning();assert.notEqual(current.completeFocusSession,original);adapter.detach();assert.equal(current.completeFocusSession,original);
});
test('idle persistence refreshes the displayed daily aggregates',async()=>{
 const {p}=setup();await p.loadPluginData();p.dirty=true;p.getOrCreateTodayRecord().contribution.wordsAdded=42;let displayed=null;
 p.refreshViews=()=>{displayed=p.store.daily['2026-09-08'].contribution.wordsAdded;};await p.checkIdleSessions();assert.equal(displayed,42);
});

test('empty review does not claim balanced knowledge work or proven knowledge quality', () => {
 const {helpers}=setup();const review=helpers.generateReviewData({});
 const md=helpers.generateAnksWeeklyReviewFileContent(review);
 assert.ok(!md.includes('节奏均衡'));assert.ok(md.includes('没有文件记录'));
});

test('review drilldown retains all files including rewrite-only notes and separates path boundaries', async () => {
 const {p,helpers}=setup();await p.loadPluginData();const r=helpers.createEmptyDailyRecord('2026-09-08');
 for(let i=0;i<7;i++)r.files[`Topics/a/${i}.md`]={wordsAdded:100-i,tasks:0};
 r.files['Topics/ab/other.md']={wordsAdded:500};r.files['Topics/a/rewrite.md']={wordsAdded:0,rewrittenWords:800,tasks:2};
 p.store.daily[r.date]=r;const before=JSON.stringify(p.store.daily);const review=p.getReviewData(r.date,r.date);
 assert.equal(review.allFiles.length,9);
 const drill=p.constructor.getReviewDrilldown(review,'Topics/a','rewrittenWords');
 assert.equal(drill.files.length,8);assert.equal(drill.files[0].path,'Topics/a/rewrite.md');
 assert.equal(drill.files[0].rewrittenWords,800);assert.equal(JSON.stringify(p.store.daily),before);
});

test('comparison uses adjacent equal calendar periods and preserves missing versus zero baseline', async () => {
 const {p,helpers}=setup();await p.loadPluginData();
 let model=p.getReviewModel('2026-09-02','2026-09-08','all');
 assert.equal(model.period.days,7);assert.equal(model.period.previousStart,'2026-08-26');assert.equal(model.period.previousEnd,'2026-09-01');
 assert.equal(model.comparison[0].percent,null);assert.equal(model.current.coverage.recorded,0);
 for(const date of ['2026-09-01','2026-09-08'])p.store.daily[date]=helpers.createEmptyDailyRecord(date);
 p.store.daily['2026-09-08'].contribution.score=10;
 model=p.getReviewModel('2026-09-02','2026-09-08','all');
 assert.equal(model.comparison[0].percent,null);assert.equal(model.comparison[0].changeLabel,'前期为零');
 p.store.daily['2026-09-01'].contribution.score=5;
 assert.equal(p.getReviewModel('2026-09-02','2026-09-08','all').comparison[0].percent,100);
});

test('review range rejects invalid, reversed, future and oversized ranges', async () => {
 const {p}=setup();await p.loadPluginData();
 for(const [a,b] of [['2026-02-31','2026-09-08'],['2026-09-08','2026-09-01'],['2026-09-01','2026-09-09'],['2020-01-01','2026-09-08']])assert.throws(()=>p.getReviewModel(a,b,'all'));
 assert.equal(p.getReviewModel('2024-02-28','2024-03-01','all').period.days,3);
});

test('comparison scope consistently excludes legacy and estimated records with explicit coverage', async () => {
 const {p,helpers}=setup();await p.loadPluginData();
 const record=helpers.createEmptyDailyRecord('2026-09-08');record.contribution.score=10;
 const prior=helpers.createEmptyDailyRecord('2026-09-01','estimated');prior.contribution.score=100;
 p.store.daily={[record.date]:record,[prior.date]:prior};
 const model=p.getReviewModel('2026-09-02','2026-09-08','reliable');
 assert.equal(model.current.totalScore,10);assert.equal(model.previous.totalScore,0);
 assert.equal(model.previous.coverage.filtered,1);assert.equal(model.previous.coverage.missing,6);
 assert.equal(model.comparison[0].changeLabel,'前期无可用记录');
});

test('review drafts persist verbatim, stay isolated by period and scope and do not change scores', async () => {
 const {p}=setup();await p.loadPluginData();const before=JSON.stringify(p.store.daily);
 p.updateReviewDraft('2026-09-02','2026-09-08','all','learning','发现 A\n[[Notes/B]]');
 await p.savePluginData();assert.equal(p.persisted.reviewDrafts['2026-09-02:2026-09-08:all'].learning,'发现 A\n[[Notes/B]]');
 assert.equal(p.getReviewModel('2026-09-02','2026-09-08','reliable').draft.learning,'');
 assert.equal(JSON.stringify(p.store.daily),before);
 const report=p.constructor.generateReviewReport(p.getReviewModel('2026-09-02','2026-09-08','all'));
 assert.ok(report.includes('发现 A\n[[Notes/B]]'));assert.ok(report.includes('2026-08-26'));assert.ok(report.includes('文件×日期'));
 assert.ok(!report.includes('licenseCode'));
});

test('range report archive preserves existing files and embeds correct dates and draft', async () => {
 const {p}=setup();await p.loadPluginData();const written=new Map();
 p.app.vault.adapter.exists=async path=>written.has(path);
 p.app.vault.create=async(path,content)=>{written.set(path,content);return {path};};
 p.updateReviewDraft('2026-09-02','2026-09-08','all','next','复查证据');
 const model=p.getReviewModel('2026-09-02','2026-09-08','all');
 const result=await p.archiveReviewReport(model);assert.equal(result.success,true);
 assert.ok(result.path.includes('2026-09-02_2026-09-08'));assert.ok(written.get(result.path).includes('复查证据'));
 assert.ok(written.get(result.path).includes('topic: "self-media"'));
 assert.equal((await p.archiveReviewReport(model)).reason,'exists');assert.equal(written.size,1);
});

test('review comparisons retain fractional focus minutes until display',async()=>{
 const {p,helpers}=setup();await p.loadPluginData();
 for(const [date,minutes] of [['2026-09-08',0.4],['2026-09-01',0.2]]){const r=helpers.createEmptyDailyRecord(date);r.activity.focusMinutes=minutes;p.store.daily[date]=r;}
 const metric=p.getReviewModel('2026-09-02','2026-09-08','all').comparison.find(m=>m.key==='focusMinutes');
 assert.equal(metric.current,0.4);assert.equal(metric.percent,100);
});

test('range reports keep quality scopes separate in filenames and reject escaping archive paths',async()=>{
 const {p}=setup();await p.loadPluginData();const paths=[];
 p.app.vault.create=async(path)=>{paths.push(path);return {path};};
 for(const scope of ['all','reliable'])assert.equal((await p.archiveReviewReport(p.getReviewModel('2026-09-02','2026-09-08',scope))).success,true);
 assert.equal(new Set(paths).size,2);p.settings.reviewArchiveFolder='../outside';
 assert.equal((await p.archiveReviewReport(p.getReviewModel('2026-09-02','2026-09-08','all'))).reason,'invalid_path');assert.equal(paths.length,2);
});

test('period navigation and draft input are wired to the live review model', async()=>{
 const {p,helpers}=setup();await p.loadPluginData();
 function element(tag='div',options={}){
  const el={tag,options,children:[],dataset:{},attrs:{...(options.attr||{})},handlers:{},style:{},value:'',setAttr(k,v){this.attrs[k]=v;},addEventListener(k,v){this.handlers[k]=v;},setText(v){this.text=v;},empty(){this.children=[];}};
  el.createEl=(t,o={})=>{const child=element(t,o);el.children.push(child);return child;};
  el.createDiv=o=>el.createEl('div',o);el.createSpan=o=>el.createEl('span',o);return el;
 }
 const all=e=>[e,...e.children.flatMap(all)];const view=new helpers.CrispPulseView({},p);view.app=p.app;let renders=0;view.render=()=>renders++;
 // 默认打开最近一个完整自然周（设置默认周日开始；今天 2026-09-08 是周二）。
 let root=element();view.renderRetrospectivePanel(root);
 assert.deepEqual([view.reviewStart,view.reviewEnd],['2026-08-30','2026-09-05']);
 view.reviewStart='2026-09-02';view.reviewEnd='2026-09-08';
 root=element();view.renderRetrospectivePanel(root);
 const fields=all(root);const progress=fields.find(e=>e.dataset.reviewField==='progress');
 progress.value='A verified finding';progress.handlers.input();
 assert.equal(p.getReviewModel('2026-09-02','2026-09-08','reliable').draft.progress,'A verified finding');
 progress.handlers.compositionstart();assert.equal(view.reviewComposing,true);progress.handlers.compositionend();assert.equal(view.reviewComposing,false);
 fields.find(e=>e.attrs['aria-label']==='前一个周期').handlers.click();assert.equal(view.reviewStart,'2026-08-26');assert.equal(view.reviewEnd,'2026-09-01');assert.equal(renders,1);
 root=element();view.renderRetrospectivePanel(root);assert.equal(all(root).find(e=>e.dataset.reviewField==='progress').value,'');
 // 写过的草稿出现在「历史复盘」里，选中即回到那一期。
 const history=all(root).find(e=>e.attrs['aria-label']==='历史复盘');
 assert.ok(history.children.some(o=>o.options.value==='2026-09-02:2026-09-08'));
 history.value='2026-09-02:2026-09-08';history.handlers.change();assert.deepEqual([view.reviewStart,view.reviewEnd],['2026-09-02','2026-09-08']);
 const input=all(root).find(e=>e.dataset.reviewField==='period-start');input.value='2026-08-20';input.handlers.input();all(root).find(e=>e.options.text==='应用日期').handlers.click();assert.equal(view.reviewStart,'2026-08-20');
});

test('natural weeks keep fixed boundaries and clip the running week to today', ()=>{
 const {helpers}=setup();const week=(...args)=>({...helpers.reviewWeekRange(...args)});
 assert.deepEqual(week('2026-10-19','monday',-1),{start:'2026-10-12',end:'2026-10-18'});
 assert.deepEqual(week('2026-10-19','monday',0),{start:'2026-10-19',end:'2026-10-19'});
 assert.deepEqual(week('2026-10-21','monday',0),{start:'2026-10-19',end:'2026-10-21'});
 assert.deepEqual(week('2026-10-19','sunday',-1),{start:'2026-10-11',end:'2026-10-17'});
 // 同一周里哪天打开，上一周都是同一个区间，草稿键不漂移。
 for(const day of ['2026-10-19','2026-10-22','2026-10-25'])assert.deepEqual(week(day,'monday',-1),{start:'2026-10-12',end:'2026-10-18'});
});

test('review clues stay factual: capped at three, no memo clue when memos are unknown', ()=>{
 const {helpers}=setup();const clues=helpers.getReviewClues;
 const files=[{path:'Topics/a/Report.md',words:5808,rewrittenWords:20,captureWords:5740,days:2,created:true,tasks:0},{path:'Core/b.md',words:320,rewrittenWords:400,captureWords:0,days:3,created:false,tasks:0}];
 const model=(current={},previous={})=>({current:{coverage:{recorded:7},wordsAdded:6128,notesCreated:9,focusMinutes:150,allFiles:files,...current},previous:{coverage:{recorded:7},focusMinutes:25,...previous}});
 const memos={total:11,converted:0,pending:Array.from({length:11},(_,i)=>({id:String(i)}))};
 const full=clues(model(),{memos,carry:2});
 assert.equal(full.length,3);
 assert.deepEqual([...full.map(c=>c.key)],['carry','focus-file','memos']);
 assert.match(full[1].title,/Report/);assert.match(full[1].detail,/5,808 \/ 6,128/);
 assert.match(full[2].title,/11/);
 // 速记读取失败或尚未读取：不出速记线索，也不说成 0 条。
 for(const unknown of [null,{error:'boom'}])assert.ok(!clues(model(),{memos:unknown}).some(c=>c.key==='memos'));
 assert.ok(!clues(model(),{memos:{total:3,converted:3,pending:[]}}).some(c=>c.key==='memos'));
 // 新增不集中时不点名某篇，改给新建入口；专注给绝对差，不给倍数。
 const spread=clues(model({allFiles:[{...files[1],words:100}],wordsAdded:6128}));
 assert.ok(!spread.some(c=>c.key==='focus-file'));assert.ok(spread.some(c=>c.key==='created'));
 const focus=spread.find(c=>c.key==='focus');assert.match(focus.title,/多 125 分钟/);assert.doesNotMatch(focus.title,/%/);
 // 上一期没有记录时，不比较专注。
 assert.doesNotMatch(clues(model({},{coverage:{recorded:0}})).find(c=>c.key==='focus').title,/上期/);
 // 没有可用记录：只给一条中性提示。
 const empty=clues(model({coverage:{recorded:0}}),{memos,carry:2});assert.equal(empty.length,1);assert.equal(empty[0].key,'empty');
 // 有记录但没有突出事实：返回空，由界面给一句中性提示（不能留一张空卡）。
 assert.equal(clues(model({wordsAdded:50,notesCreated:0,focusMinutes:0,allFiles:[{...files[1],words:50,rewrittenWords:0}]})).length,0);
});

test('exported report carries the memo summary, and says so when memos could not be read', async()=>{
 const {p}=setup();await p.loadPluginData();
 const report=p.constructor.generateReviewReport;
 const model=p.getReviewModel('2026-09-02','2026-09-08','all');
 assert.doesNotMatch(report(model),/速记与转化/);
 model.memos={total:4,converted:2,toTasks:1,tasksDone:1,tasksOpen:0,tasksMissing:0,tasksUnknown:0,toNotes:2,toNow:0,pending:[]};
 const text=report(model);assert.match(text,/## 速记与转化/);assert.match(text,/本期记下 4 条，已转化 2 条/);assert.match(text,/转为任务 1 条（完成 1，未完成 0）/);
 model.memos={error:'disk'};assert.match(report(model),/速记读取失败，未计入/);
 model.memos={total:2,converted:1,toTasks:1,tasksDone:0,tasksOpen:0,tasksMissing:0,tasksUnknown:1,toNotes:0,toNow:0,pending:[]};assert.match(report(model),/完成情况未知/);
});

// 1.7: source provenance, cross-period actions, cited review evidence.
test('system artifact exclusions respect path boundaries and preserve the existing folder filters',async()=>{
 const {p}=setup();await p.loadPluginData();
 assert.equal(p.shouldTrackPath('Sidecar/logs/backup.md'),true);
 p.settings.excludeSystemArtifacts=true;
 for(const path of ['Sidecar/logs/backup.md','Sidecar/manifests/a.md','Sidecar/backups/a.md'])assert.equal(p.shouldTrackPath(path),false,path);
 for(const path of ['Sidecar/logs-notes/a.md','Topics/Sidecar/logs/a.md','Sidecar/tools/guide.md'])assert.equal(p.shouldTrackPath(path),true,path);
 p.settings.includedFolders=['Core'];assert.equal(p.shouldTrackPath('Topics/a.md'),false);
});

test('new source attribution does not relabel old words or infer human authorship',async()=>{
 const {p,helpers}=setup();await p.loadPluginData();
 const old=helpers.createEmptyDailyRecord('2026-09-07');old.contribution.wordsAdded=10;old.files['old.md']={wordsAdded:10};p.store.daily[old.date]=old;
 await p.handleFileCreation({path:'Sidecar/logs/run.md',content:'one two three'});
 await p.handleFileCreation({path:'capture.md',content:'word '.repeat(600)});
 await p.handleFileCreation({path:'other.md',content:'one two'});
 const sources=p.getReviewModel('2026-09-02','2026-09-08','all').current.sourceWords;
 assert.equal(sources.system,0);assert.equal(p.getOrCreateTodayRecord().contribution.externalWords,3);assert.equal(sources.capture,600);assert.equal(sources.unattributed,2);assert.equal(sources.historical,10);
 assert.equal(old.files['old.md'].sourceWords,undefined);
});

test('source attribution adds only newly observed words to a partially historical file',async()=>{
 const {p,helpers}=setup();await p.loadPluginData();const file={path:'a.md',content:'one two three'};
 const r=helpers.createEmptyDailyRecord('2026-09-08');r.files['a.md']={wordsAdded:10};r.contribution.wordsAdded=10;p.store.daily[r.date]=r;
 p.fileSnapshots.set(file.path,{words:1,tasks:0,links:0,lastTime:0});await p.handleFileModification(file);
 const source=p.getReviewModel(r.date,r.date,'all').current.sourceWords;assert.equal(source.historical,10);assert.equal(source.unattributed,2);
});

test('previous period actions import once, preserve history and keep source lineage across periods',async()=>{
 const {p}=setup();await p.loadPluginData();
 p.updateReviewDraft('2026-08-26','2026-09-01','all','next','- 核对证据\n- 完成报告');
 assert.equal(p.importPreviousActions('2026-09-02','2026-09-08','all'),2);
 assert.equal(p.importPreviousActions('2026-09-02','2026-09-08','all'),0);
 let model=p.getReviewModel('2026-09-02','2026-09-08','all');assert.equal(model.actions.length,2);assert.equal(model.actions[0].status,'pending');
 p.updateReviewAction('2026-09-02','2026-09-08','all',model.actions[0].id,{status:'done'});
 assert.ok(p.getReviewModel('2026-08-26','2026-09-01','all').draft.next.includes('核对证据'));
 assert.equal(p.importPreviousActions('2026-09-02','2026-09-08','reliable'),0);
 p.addReviewAction('2026-08-26','2026-09-01','reliable','已完成');
 const action=p.getReviewModel('2026-08-26','2026-09-01','reliable').actions[0];
 p.updateReviewAction('2026-08-26','2026-09-01','reliable',action.id,{status:'done'});
 assert.equal(p.importPreviousActions('2026-09-02','2026-09-08','reliable'),0);
});

test('action updates reject invalid states and report exports include action status',async()=>{
 const {p}=setup();await p.loadPluginData();p.addReviewAction('2026-09-02','2026-09-08','all','验证改动');
 const model=p.getReviewModel('2026-09-02','2026-09-08','all');
 assert.throws(()=>p.updateReviewAction('2026-09-02','2026-09-08','all',model.actions[0].id,{status:'invented'}));
 p.updateReviewAction('2026-09-02','2026-09-08','all',model.actions[0].id,{status:'deferred'});
 const report=p.constructor.generateReviewReport(p.getReviewModel('2026-09-02','2026-09-08','all'));
 assert.ok(report.includes('延期'));assert.ok(report.includes('验证改动'));
});

test('evidence stores an exact checked quote and rejects invented or out-of-period sources',async()=>{
 const {p,helpers}=setup();await p.loadPluginData();const r=helpers.createEmptyDailyRecord('2026-09-08');r.files['Core/a.md']={wordsAdded:20};p.store.daily[r.date]=r;
 const file={path:'Core/a.md',extension:'md',content:'原始证据\n真实的一段话'};p.app.vault.getAbstractFileByPath=path=>path===file.path?file:null;
 await p.addReviewEvidence('2026-09-02','2026-09-08','all',file.path,'真实的一段话');
 const model=p.getReviewModel('2026-09-02','2026-09-08','all');assert.equal(model.evidence[0].quote,'真实的一段话');
 await assert.rejects(()=>p.addReviewEvidence('2026-09-02','2026-09-08','all',file.path,'编造引文'));
 await assert.rejects(()=>p.addReviewEvidence('2026-08-26','2026-09-01','all',file.path,'原始证据'));
 assert.equal(p.getReviewModel('2026-09-02','2026-09-08','all').evidence.length,1);
 const report=p.constructor.generateReviewReport(model);assert.ok(report.includes('[[Core/a.md]]'));assert.ok(report.includes('> 真实的一段话'));
});

test('renaming a cited note keeps its original evidence path and updates the working link',async()=>{
 const {p,helpers,handlers}=setup();await p.loadPluginData();p.registerVaultEvents();
 const r=helpers.createEmptyDailyRecord('2026-09-08');r.files['Core/a.md']={wordsAdded:1};p.store.daily[r.date]=r;
 const file={path:'Core/a.md',extension:'md',content:'证据'};p.app.vault.getAbstractFileByPath=()=>file;
 await p.addReviewEvidence(r.date,r.date,'all',file.path,'证据');file.path='Core/b.md';handlers.rename(file,'Core/a.md');
 const evidence=p.getReviewModel(r.date,r.date,'all').evidence[0];assert.equal(evidence.path,'Core/b.md');assert.equal(evidence.originalPath,'Core/a.md');assert.equal(evidence.quote,'证据');
});

test('system exclusion changes do not back-count skipped edits when re-enabled',async()=>{
 const {p,helpers}=setup();await p.loadPluginData();const file={path:'Sidecar/logs/a.md',extension:'md',content:'one two',stat:{mtime:0}};
 p.app.vault.getMarkdownFiles=()=>[file];p.fileSnapshots.set(file.path,{words:1,tasks:0,links:0,lastTime:0});
 const before=JSON.stringify(p.store.daily);await p.setSystemArtifactsExcluded(true);file.content='one two three four';await p.handleFileModification(file);assert.equal(JSON.stringify(p.store.daily),before);
 await p.setSystemArtifactsExcluded(false);await p.handleFileModification(file);assert.equal(JSON.stringify(p.store.daily),before);
 file.content+=' five';await p.handleFileModification(file);assert.equal(p.getOrCreateTodayRecord().contribution.wordsAdded,0);assert.equal(p.getOrCreateTodayRecord().contribution.externalWords,1);
});

test('system exclusion save failure restores the previous preference',async()=>{
 const {p}=setup();await p.loadPluginData();p.saveData=async()=>{throw new Error('disk full')};
 await assert.rejects(()=>p.setSystemArtifactsExcluded(true));assert.equal(p.settings.excludeSystemArtifacts,false);assert.equal(p.sourceFilterChanging,false);
});

test('recreated file preserves same-day word totals and source attribution',async()=>{
 const {p}=setup();await p.loadPluginData();const file={path:'a.md',content:'one two'};
 await p.handleFileCreation(file);p.fileSnapshots.delete(file.path);file.content='three four five';await p.handleFileCreation(file);
 const record=p.getOrCreateTodayRecord();assert.equal(record.files[file.path].wordsAdded,5);assert.equal(record.files[file.path].sourceWords.unattributed,5);
});

test('evidence accepts CRLF source selections and de-duplicates normalized quotes',async()=>{
 const {p,helpers}=setup();await p.loadPluginData();const r=helpers.createEmptyDailyRecord('2026-09-08');r.files['a.md']={wordsAdded:2};p.store.daily[r.date]=r;
 const file={path:'a.md',extension:'md',content:'第一行\r\n第二行'};p.app.vault.getAbstractFileByPath=()=>file;
 assert.equal(await p.addReviewEvidence(r.date,r.date,'all',file.path,'第一行\n第二行'),true);
 assert.equal(await p.addReviewEvidence(r.date,r.date,'all',file.path,'第一行\r\n第二行'),false);
});

test('removing evidence leaves source notes and reflection text intact',async()=>{
 const {p,helpers}=setup();await p.loadPluginData();const r=helpers.createEmptyDailyRecord('2026-09-08');r.files['a.md']={wordsAdded:1};p.store.daily[r.date]=r;
 const file={path:'a.md',extension:'md',content:'证据'};p.app.vault.getAbstractFileByPath=()=>file;
 p.updateReviewDraft(r.date,r.date,'all','learning','我的认识');await p.addReviewEvidence(r.date,r.date,'all',file.path,'证据');
 const e=p.getReviewModel(r.date,r.date,'all').evidence[0];p.removeReviewEvidence(r.date,r.date,'all',e.id);
 assert.equal(p.getReviewModel(r.date,r.date,'all').evidence.length,0);assert.equal(file.content,'证据');assert.equal(p.getReviewModel(r.date,r.date,'all').draft.learning,'我的认识');
});

test('action carry-over across three periods preserves origin and ignores completed work',async()=>{
 const {p,advance}=setup();await p.loadPluginData();advance(7*86400000);
 p.addReviewAction('2026-08-26','2026-09-01','all','验证证据');p.importPreviousActions('2026-09-02','2026-09-08','all');
 const first=p.getReviewModel('2026-08-26','2026-09-01','all').actions[0];
 assert.equal(p.importPreviousActions('2026-09-09','2026-09-15','all'),1);
 const third=p.getReviewModel('2026-09-09','2026-09-15','all').actions[0];assert.equal(third.originId,first.id);
 assert.equal(p.importPreviousActions('2026-09-09','2026-09-15','all'),0);
});

test('legacy action import parses numbered list checkboxes and preserves identities upon editing previous draft',async()=>{
 const {p}=setup();await p.loadPluginData();
 p.updateReviewDraft('2026-08-26','2026-09-01','all','next','1. [x] Completed task\n2. [ ] Pending task\n3) Another pending');
 assert.equal(p.importPreviousActions('2026-09-02','2026-09-08','all'),2);
 let model=p.getReviewModel('2026-09-02','2026-09-08','all');
 assert.equal(model.actions.length,2);
 assert.equal(model.actions[0].title,'Pending task');
 assert.equal(model.actions[1].title,'Another pending');

 const { p: p1 } = setup(); await p1.loadPluginData();
 p1.updateReviewDraft('2026-08-26','2026-09-01','all','next','- A\n- B');
 assert.equal(p1.importPreviousActions('2026-09-02','2026-09-08','all'),2);
 let m1=p1.getReviewModel('2026-09-02','2026-09-08','all');
 assert.equal(m1.actions.map(a=>a.title).join(','),'A,B');

 p1.updateReviewDraft('2026-08-26','2026-09-01','all','next','- NEW\n- A\n- B');
 assert.equal(p1.importPreviousActions('2026-09-02','2026-09-08','all'),1);
 m1=p1.getReviewModel('2026-09-02','2026-09-08','all');
 assert.equal(m1.actions.map(a=>a.title).join(','),'A,B,NEW');
});

test('moving file across exclusion boundaries establishes baseline and does not back-count excluded edits',async()=>{
 const {p,handlers}=setup();await p.loadPluginData();
 p.registerVaultEvents();
 await p.setSystemArtifactsExcluded(true);

 const file={path:'Topics/a.md',extension:'md',content:'one',stat:{mtime:100}};
 p.app.vault.getMarkdownFiles=()=>[file];
 p.app.vault.getAbstractFileByPath=path=>path===file.path?file:null;
 p.app.vault.read=async f=>f.content;
 await p.handleFileCreation(file);

 const oldPath=file.path;
 file.path='Sidecar/logs/a.md';
 await handlers.rename(file,oldPath);

 file.content='one '+'word '.repeat(99).trim();
 await p.handleFileModification(file);
 assert.equal(p.getOrCreateTodayRecord().contribution.wordsAdded,1);

 const excludedPath=file.path;
 file.path='Topics/a.md';
 await handlers.rename(file,excludedPath);

 file.content+=' extra';
 await p.handleFileModification(file);
 assert.equal(p.getOrCreateTodayRecord().contribution.wordsAdded,2);
});

test('copy and archive commands generate modern review report with reflections and actions',async()=>{
 const {p,context}=setup();
 p.addSettingTab=()=>{};p.registerView=()=>{};p.addRibbonIcon=()=>{};
 await p.onload();

 const today = '2026-09-08';
 const start = '2026-09-02';
 p.updateReviewDraft(start,today,'reliable','learning','本周新认识');
 p.addReviewAction(start,today,'reliable','关键改动任务');

 let copiedText='';
 context.navigator.clipboard.writeText=async txt=>{copiedText=txt;};

 const copyCmd=p.commands.find(c=>c.id==='copy-pulse-weekly-markdown');
 assert.ok(copyCmd);
 p.licenseManager={isEntitled:()=>false};
 await copyCmd.callback();
 assert.equal(copiedText,'','未激活时周报命令不得输出内容');
 p.licenseManager={isEntitled:()=>true};
 await copyCmd.callback();
 assert.ok(copiedText.includes('## 复盘反思'));
 assert.ok(copiedText.includes('本周新认识'));
 assert.ok(copiedText.includes('## 行动追踪'));
 assert.ok(copiedText.includes('关键改动任务'));

 let archivedFile=null;
 p.app.vault.create=async(path,content)=>{archivedFile={path,content};return{path};};
 p.app.vault.getAbstractFileByPath=()=>null;

 const archiveCmd=p.commands.find(c=>c.id==='archive-weekly-review');
 assert.ok(archiveCmd);
 p.licenseManager={isEntitled:()=>false};
 await archiveCmd.callback();
 assert.equal(archivedFile,null,'未激活时归档命令不得写入文件');
 p.licenseManager={isEntitled:()=>true};
 await archiveCmd.callback();
 assert.ok(archivedFile);
 assert.ok(archivedFile.path.includes(`${start}_${today}-reliable-知识工作复盘.md`));
 assert.ok(archivedFile.content.includes('本周新认识'));
 assert.ok(archivedFile.content.includes('关键改动任务'));
});

test('rebuilding estimated history does not retroactively exclude historical system artifacts when excludeSystemArtifacts is enabled',async()=>{
 const {p}=setup();await p.loadPluginData();
 await p.setSystemArtifactsExcluded(true);

 const pastDate=new Date('2026-08-01T10:00:00Z');
 const pastKey='2026-08-01';
 const topicFile={path:'Topics/note.md',stat:{ctime:pastDate.getTime(),mtime:pastDate.getTime()}};
 const sidecarFile={path:'Sidecar/logs/note.md',stat:{ctime:pastDate.getTime(),mtime:pastDate.getTime()}};

 p.app.vault.getMarkdownFiles=()=>[topicFile,sidecarFile];
 await p.runHistoricalBackfill(true);

 const rec=p.store.daily[pastKey];
 assert.ok(rec);
 assert.equal(rec.contribution.notesCreated,2);
});

test('validateAndRepairStore repairs corrupted reviewDrafts safely',async()=>{
 const {helpers}=setup();
 const corrupted={
  daily:{},
  settings:{},
  reviewDrafts:{
   '2026-09-02:2026-09-08:all':{
    actions:[{id:123,title:456,status:'invalid_status'},null,{title:'valid action'}],
    evidence:[{id:null,path:123,quote:999,capturedAt:888},{path:'Core/ok.md',quote:123,capturedAt:456}]
   },
   'bad_draft':'not an object'
  }
 };
 const {store,repairedCount}=helpers.validateAndRepairStore(corrupted);
 assert.ok(repairedCount>0);
 assert.equal(typeof store.reviewDrafts['bad_draft'],'undefined');
 const draft=store.reviewDrafts['2026-09-02:2026-09-08:all'];
 assert.ok(draft);
 // 标题有问题不丢整条行动（状态、结果笔记关联要保住）：数字标题转成文字，非对象条目才丢
 assert.equal(draft.actions.length,2);
 assert.equal(draft.actions[0].title,'456');
 assert.equal(typeof draft.actions[0].id,'string');
 assert.equal(draft.actions[0].status,'pending');
 assert.equal(draft.actions[1].title,'valid action');
 assert.equal(draft.actions[1].status,'pending');
 assert.equal(draft.evidence.length,1);
 assert.equal(typeof draft.evidence[0].quote,'string');
 assert.equal(typeof draft.evidence[0].capturedAt,'string');
});

test('mobile responsive rules only target classes rendered by the plugin',()=>{
 const styles=fs.readFileSync(path.join(__dirname,'../styles.css'),'utf8');
 const markup=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8');
 const start=styles.indexOf('/* Mobile (iPhone / iPad) Responsive Adaptations */');
 assert.ok(start>=0,'mobile responsive block should exist');
 const block=styles.slice(start);
 // A class starts with a letter; "-.025em" and similar values are not selectors.
 const classes=[...new Set([...block.matchAll(/\.(-?[a-z_][a-z0-9_-]*)/gi)].map(match=>match[1]))];
 const obsidianBodyClasses=new Set(['is-mobile','theme-dark','theme-light','is-translucent','is-popout-window','is-popout-modal']);
 for(const className of classes){
  if(obsidianBodyClasses.has(className)) continue; // Obsidian adds these to <body>, not the plugin.
  assert.ok(markup.includes(className),`mobile CSS targets missing class: ${className}`);
 }
 assert.match(block,/\.crisp-pulse-title-group > \.crisp-pulse-actions/);
 assert.match(block,/\.crisp-pulse-header > \.crisp-pulse-actions/);
 assert.doesNotMatch(block,/\.crisp-pulse-header-controls/);
 assert.doesNotMatch(block,/\.crisp-pulse-tabs\b/);
});

test('rename into a deleted historical path preserves both file records through save and reload', async () => {
  const { p, handlers } = setup();
  await p.loadPluginData();p.registerVaultEvents();
  // 今天编辑过、随后删除的旧笔记：记录保留（当天新建又删的才撤回）
  const target = { path: 'target.md', content: 'zero', extension: 'md' };
  p.fileSnapshots.set(target.path, baseline(target.content));
  target.content = 'zero one two';await p.handleFileModification(target);
  await handlers.delete({ path: 'target.md' });
  const file = { path: 'source.md', content: 'three four five', extension: 'md' };
  await p.handleFileCreation(file);
  const record = p.getOrCreateTodayRecord();
  Object.assign(record.files['target.md'], { tasks: 2, links: 3, rewrittenWords: 7 });
  Object.assign(record.files['source.md'], { tasks: 1, links: 2, rewrittenWords: 4 });
  file.path = 'target.md';await handlers.rename(file, 'source.md');
  await p.savePluginData();p.loadData = async () => p.persisted;await p.loadPluginData();
  const merged = p.getOrCreateTodayRecord().files['target.md'];
  assert.equal(merged.wordsAdded, 5);
  assert.equal(merged.tasks, 3);assert.equal(merged.links, 5);assert.equal(merged.rewrittenWords, 11);
  assert.equal(merged.sourceWords.unattributed, 5);
  assert.equal(p.getOrCreateTodayRecord().contribution.wordsAdded, 5);
  assert.equal(p.getReviewModel('2026-09-08','2026-09-08','all').current.allFiles[0].words, 5);
});

test('malformed array containers cannot silently discard collected data on save and reload', async () => {
  for (const raw of [[], { daily: [] }, { daily: { '2026-09-08': [] } },
    { daily: { '2026-09-08': { activity: [], contribution: [], files: [] } } }]) {
    const { p } = setup();p.loadData = async () => structuredClone(raw);await p.loadPluginData();
    await p.handleFileCreation({ path: 'new.md', extension: 'md', content: 'one two three' });
    await p.handleFocusSessionCompleted(5);
    p.loadData = async () => p.persisted;await p.loadPluginData();
    const record = p.getOrCreateTodayRecord();
    assert.equal(record.contribution.wordsAdded, 3);
    assert.equal(record.files['new.md'].wordsAdded, 3);
    assert.equal(record.activity.focusMinutes, 5);
  }
});

const baseline = content => ({ words: content.split(/\s+/).filter(Boolean).length, tasks: 0, links: 0, lineSet: new Set(content.split('\n').map(l => l.trim()).filter(Boolean)), completedTaskSet: new Set(), lastTime: 0 });

test('re-including an excluded folder does not back-count edits made while excluded', async () => {
  const { p } = setup();await p.loadPluginData();
  const file = { path: 'Drafts/a.md', extension: 'md', content: 'one' };
  p.app.vault.getMarkdownFiles = () => [file];
  p.fileSnapshots.set(file.path, baseline(file.content));
  p.settings.excludedFolders = ['Drafts'];await p.syncSnapshotsToTrackingRules();
  assert.equal(p.fileSnapshots.has(file.path), false);
  file.content = 'one ' + 'word '.repeat(50);await p.handleFileModification(file);
  p.settings.excludedFolders = [];await p.syncSnapshotsToTrackingRules();
  await p.handleFileModification(file);
  assert.equal(p.store.daily['2026-09-08']?.contribution.wordsAdded || 0, 0);
  file.content += ' more';await p.handleFileModification(file);
  assert.equal(p.getOrCreateTodayRecord().contribution.wordsAdded, 1);
});

test('a large paste into an idle existing note is classified as capture', async () => {
  const { p } = setup();await p.loadPluginData();
  const file = { path: 'a.md', extension: 'md', content: 'one' };
  p.fileSnapshots.set(file.path, baseline(file.content));
  file.content = 'one\n' + 'word '.repeat(600);await p.handleFileModification(file);
  const record = p.getOrCreateTodayRecord();
  assert.equal(record.contribution.captureWords, 600);
  assert.equal(record.files['a.md'].sourceWords.capture, 600);
});

test('deleting a folder clears child snapshots and closes their sessions', async () => {
  const { p, handlers } = setup();await p.loadPluginData();p.registerVaultEvents();
  p.fileSnapshots.set('Dir/a.md', baseline('old text'));p.fileSnapshots.set('Other/b.md', baseline('keep'));
  p.activeSessions.set('Dir/a.md', { date: '2026-09-08', lastEventTime: Date.now(), isMeaningful: true, wordsDeltaTotal: 20 });
  handlers.delete({ path: 'Dir' });
  assert.equal(p.fileSnapshots.has('Dir/a.md'), false);assert.equal(p.fileSnapshots.has('Other/b.md'), true);
  assert.equal(p.activeSessions.size, 0);assert.equal(p.getOrCreateTodayRecord().contribution.meaningfulEdits, 1);
  await p.handleFileCreation({ path: 'Dir/a.md', extension: 'md', content: 'fresh' });
  assert.equal(p.getOrCreateTodayRecord().contribution.notesCreated, 1);
});

test('pointer taps count as interaction so mobile activity is recorded', async () => {
  const { p, events, advance } = setup();await p.loadPluginData();p.registerActivityListeners();
  events.dispatchEvent(new Event('pointerdown'));advance(60000);events.dispatchEvent(new Event('pointerdown'));
  assert.ok(p.getOrCreateTodayRecord().activity.activeMinutes >= 1);
});

test('report top files use safe links for names that break wikilinks', () => {
  const { helpers } = setup();
  const md = helpers.generateWeeklyMarkdown({ totalScore: 0, notesCreated: 0, wordsAdded: 1, rewrittenWords: 0, tasksCompleted: 0, activeHours: '0', dirBreakdown: [], topFiles: [{ path: 'A/x|y.md', words: 1 }, { path: 'A/plain.md', words: 1 }] });
  assert.match(md, /\[笔记\]\(A\/x%7Cy\.md\)/);assert.match(md, /\[\[A\/plain\.md\]\]/);
});

test('archiving returns the created file name', async () => {
  const { p } = setup();await p.loadPluginData();
  const res = await p.archiveWeeklyReviewToVault({ dirBreakdown: [], topFiles: [] }, '2026-09-02', '2026-09-08', { fileName: 'r.md', content: 'x' });
  assert.equal(res.success, true);assert.equal(res.fileName, 'r.md');
});

test('JSON backup never carries the license code', async () => {
  const { p } = setup();await p.loadPluginData();
  p.settings.licenseCode = 'secret.payload.sig';p.settings.licenseLastOnlineAt = 123;
  let saved;p.saveExportFile = async (name, content) => { saved = content; return { success: true }; };
  await p.exportJSONFile();
  assert.doesNotMatch(saved, /secret\.payload\.sig|licenseLastOnlineAt/);
  assert.equal(JSON.parse(saved).settings.dataQualityScope, p.settings.dataQualityScope);
  assert.equal(p.settings.licenseCode, 'secret.payload.sig');
});

test('writing mix never attributes more words than were added and keeps legacy words unclassified', () => {
  const { helpers } = setup();
  const day = (words, files, quality = 'recorded') => ({ quality, contribution: { wordsAdded: words }, files });
  const daily = {
    '2026-09-06': day(100, { 'Sidecar/logs/a.md': { sourceWords: { system: 80 } }, 'b.md': { sourceWords: { capture: 600, unattributed: 30 } } }),
    '2026-09-07': day(50, { 'old.md': { wordsAdded: 50 } }),
    '2026-09-08': day(999, { 'x.md': { sourceWords: { unattributed: 999 } } }, 'estimated')
  };
  const mix = helpers.buildWritingMix(daily, ['2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08'], rec => rec.quality === 'recorded');
  assert.deepEqual({ ...mix.parts }, { typed: 0, capture: 20, system: 80, historical: 50 });
  assert.equal(mix.total, 150);
  assert.equal(mix.days[0], null);assert.equal(mix.days[3], null);
  assert.equal(mix.days[1].system + mix.days[1].capture + mix.days[1].typed + mix.days[1].historical, 100);
});

test('folder share groups by project folder, folds the tail into 其他 and sums to 100%', () => {
  const { helpers } = setup();
  const files = {};
  for (const name of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) files[`Topics/${name}/n.md`] = { wordsAdded: 10 };
  files['Topics/A/m.md'] = { wordsAdded: 5 };files['Core/x.md'] = { wordsAdded: 1 };files['root.md'] = { wordsAdded: 1 };
  const daily = { '2026-09-07': { quality: 'recorded', files }, '2026-09-08': { quality: 'estimated', files: { 'Skip/z.md': { wordsAdded: 999 } } } };
  const share = helpers.buildFolderShare(daily, ['2026-09-07', '2026-09-08'], rec => rec.quality === 'recorded');
  assert.equal(share.total, 10);
  assert.equal(share.items[0].name, 'Topics/A');assert.equal(share.items[0].count, 2);assert.equal(share.items[0].words, 15);
  assert.equal(share.items.length, 6);assert.equal(share.items.at(-1).name, '其他');assert.equal(share.items.at(-1).count, 4);
  assert.ok(share.items.every(item => item.name !== 'Skip'));
  assert.equal(share.items.reduce((sum, item) => sum + item.percent, 0), 100);
  const empty = helpers.buildFolderShare({}, ['2026-09-08'], () => true);
  assert.equal(empty.total, 0);assert.equal(empty.items.length, 0);
});

test('folder share and strata leave out system artifacts, matching the writing-source card', () => {
  const { helpers } = setup();
  const files = {
    'Topics/A/n.md': { wordsAdded: 10 },
    'Sidecar/logs/docs-sync/backups/1/AGENTS.md': { wordsAdded: 900, sourceWords: { system: 900 } },
    'Sidecar/manifests/snap.md': { wordsAdded: 50 },
    'Sidecar/tools/readme.md': { wordsAdded: 5 }
  };
  const daily = { '2026-01-05': { quality: 'recorded', contribution: { wordsAdded: 15 }, files } };
  const share = helpers.buildFolderShare(daily, ['2026-01-05'], () => true);
  assert.equal(share.total, 2);
  assert.deepEqual([...share.items.map(item => item.name)].sort(), ['Sidecar/tools', 'Topics/A']);
  const strata = helpers.buildStrata(daily, ['2026-01-05'], () => true, 6);
  assert.equal(strata.weeks[0].total, 2);
  assert.equal(strata.weeks[0].counts['其他'] || 0, 0);
});

test('year profile separates future, missing, excluded and zero days and picks the dominant dimension', () => {
  const { helpers } = setup();
  const rec = (c, a = {}, quality = 'recorded') => ({ quality, contribution: { score: 0, wordsAdded: 0, notesCreated: 0, tasksCompleted: 0, ...c }, activity: { activeMinutes: 0, focusMinutes: 0, ...a } });
  const daily = {
    '2026-01-01': rec({ score: 10, wordsAdded: 100 }, { activeMinutes: 10 }),
    '2026-01-02': rec({ score: 40, wordsAdded: 50 }, { activeMinutes: 5, focusMinutes: 120 }),
    '2026-01-03': rec({ score: 0 }),
    '2026-01-04': rec({ score: 99, wordsAdded: 9999 }, {}, 'estimated'),
    '2026-01-06': rec({ score: 20, wordsAdded: 400 }, { activeMinutes: 20 })
  };
  const profile = helpers.buildYearProfile(daily, 2026, r => r.quality === 'recorded', '2026-01-06');
  assert.equal(profile.days.length, 365);
  const [d1, d2, d3, d4, d5, d6, d7] = profile.days;
  assert.equal(d4.status, 'excluded');assert.equal(d5.status, 'missing');assert.equal(d7.status, 'future');
  assert.equal(d3.status, 'included');assert.equal(d3.length, 0);assert.equal(d3.intensity, 0);assert.equal(d3.dominant, null);
  assert.equal(d2.dominant, 'focus');assert.equal(d6.dominant, 'write');
  assert.equal(d2.intensity, 1);assert.equal(d2.length, 1);
  assert.ok(profile.days.every(d => d.length >= 0 && d.length <= 1 && d.intensity >= 0 && d.intensity <= 1));
  assert.equal(profile.recordedDays, 4);assert.equal(profile.activeDays, 3);
  assert.equal(profile.totals.score, 70);assert.equal(profile.totals.words, 550);
});

test('strata groups Monday weeks, keeps folder order stable and folds the tail the same way every week', () => {
  const { helpers } = setup();
  const files = names => Object.fromEntries(names.map(([path, words]) => [path, { wordsAdded: words }]));
  const daily = {
    '2026-01-01': { quality: 'recorded', contribution: { wordsAdded: 30 }, files: files([['Topics/A/x.md', 10], ['Topics/B/y.md', 20]]) },
    '2026-01-05': { quality: 'recorded', contribution: { wordsAdded: 5 }, files: files([['Topics/A/x.md', 5], ['Core/z.md', 0]]) },
    '2026-01-06': { quality: 'recorded', contribution: { wordsAdded: 7 }, files: files([['Topics/A/x.md', 7], ['Z/q.md', 0]]) }
  };
  const dates = Array.from({ length: 20 }, (_, i) => { const d = new Date(2026, 0, 1 + i); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
  const strata = helpers.buildStrata(daily, dates, () => true, 2);
  assert.deepEqual([...strata.folders], ['Topics/A', 'Topics/B', '其他']);
  assert.equal(strata.weeks[0].start, '2026-01-01');assert.equal(strata.weeks[0].end, '2026-01-04');
  assert.equal(strata.weeks[1].start, '2026-01-05');assert.equal(strata.weeks[1].end, '2026-01-11');
  assert.equal(strata.weeks[0].words, 30);assert.equal(strata.weeks[0].counts['Topics/B'], 1);assert.equal(strata.weeks[0].counts['其他'] || 0, 0);
  assert.equal(strata.weeks[1].counts['Topics/A'], 2);assert.equal(strata.weeks[1].counts['其他'], 2);assert.equal(strata.weeks[1].total, 4);
  assert.equal(strata.weeks[2].recorded, false);assert.equal(strata.weeks[2].total, 0);
});

test('portrait range follows the data: first included record to today, at least 30 days', () => {
  const { helpers } = setup();
  const daily = { '2026-08-20': { quality: 'estimated' }, '2026-09-01': { quality: 'recorded' }, '2026-09-10': { quality: 'recorded' } };
  const recorded = r => r.quality === 'recorded';
  const long = helpers.portraitDates(daily, recorded, '2026-10-15');
  assert.equal(long[0], '2026-09-01');assert.equal(long.at(-1), '2026-10-15');assert.equal(long.length, 45);
  const short = helpers.portraitDates(daily, recorded, '2026-09-10');
  assert.equal(short.length, 30);assert.equal(short.at(-1), '2026-09-10');assert.equal(short[0], '2026-08-12');
  const none = helpers.portraitDates({}, recorded, '2026-09-10');
  assert.equal(none.length, 30);assert.equal(none.at(-1), '2026-09-10');
  const profile = helpers.buildDayProfile(daily, long, recorded, '2026-10-15');
  assert.equal(profile.days.length, 45);assert.equal(profile.recordedDays, 2);
});

test('moon path draws nothing for a new moon, a full disc at 1, and bends the terminator the right way', () => {
  const { helpers } = setup();
  assert.equal(helpers.moonPath(0, 10, 10, 8), '');
  assert.equal(helpers.moonPath(-1, 10, 10, 8), '');
  const full = helpers.moonPath(1, 10, 10, 8);
  assert.match(full, /^M10,2 A8,8 0 1 1 10,18 A8,8 0 1 1 10,2 Z$/);
  // Crescent: terminator bulges toward the lit (right) side; gibbous: toward the dark side.
  assert.match(helpers.moonPath(0.25, 10, 10, 8), /A4,8 0 0 0 10,2 Z$/);
  assert.match(helpers.moonPath(0.75, 10, 10, 8), /A4,8 0 0 1 10,2 Z$/);
  assert.match(helpers.moonPath(0.5, 10, 10, 8), /A0,8 0 0 [01] 10,2 Z$/);
  assert.equal(helpers.moonPath(2, 10, 10, 8), full);
});

test('long portraits fold into Monday weeks that keep sums, the best day and honest statuses', () => {
  const { helpers } = setup();
  const rec = (score, words, quality = 'recorded') => ({ quality, contribution: { score, wordsAdded: words, notesCreated: 1, tasksCompleted: 0 }, activity: { activeMinutes: 10, focusMinutes: 0 } });
  const daily = { '2026-09-02': rec(10, 100), '2026-09-04': rec(30, 50), '2026-09-08': rec(5, 5, 'estimated') };
  const dates = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10'];
  const day = helpers.buildDayProfile(daily, dates, r => r.quality === 'recorded', '2026-09-09');
  const week = helpers.buildWeekProfile(day);
  assert.equal(week.unit, 'week');assert.equal(week.days.length, 2);
  const [w1, w2] = week.days;
  assert.equal(w1.date, '2026-09-01');assert.equal(w1.end, '2026-09-06');assert.equal(w1.status, 'included');
  assert.equal(w1.score, 40);assert.equal(w1.words, 150);assert.equal(w1.activeDays, 2);assert.equal(w1.bestDate, '2026-09-04');
  assert.equal(w2.date, '2026-09-07');assert.equal(w2.end, '2026-09-10');assert.equal(w2.status, 'excluded');assert.equal(w2.score, 0);
  assert.equal(w1.length, 1);assert.equal(w1.intensity, 1);assert.ok(w1.dominant);
  assert.equal(week.activeDays, day.activeDays);assert.deepEqual({ ...week.totals }, { ...day.totals });
});

test('auto portrait range never exceeds the most recent 365 days', () => {
  const { helpers } = setup();
  const dates = helpers.portraitDates({ '2024-01-01': { quality: 'recorded' } }, () => true, '2026-09-30');
  assert.equal(dates.length, 365);assert.equal(dates.at(-1), '2026-09-30');assert.equal(dates[0], '2025-10-01');
});

// 1.10.1: Obsidian's loadData returns undefined on unreadable JSON, and saveData swallows write errors.
function diskVault(p, files) {
  p.manifest = { ...p.manifest, dir: '.obsidian/plugins/crisp-pulse' };
  p.app.vault.adapter = {
    exists: async path => files.has(path),
    read: async path => { if (!files.has(path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return files.get(path); },
    write: async (path, data) => { files.set(path, data); },
    mkdir: async () => {},
    list: async () => ({ files: [...files.keys()] })
  };
}

test('an unreadable data.json is kept, copied aside and never overwritten by defaults', async () => {
  const { p } = setup();
  const dataPath = '.obsidian/plugins/crisp-pulse/data.json';
  const broken = '{ "daily": { "2026-09-07": ';
  const files = new Map([[dataPath, broken]]);
  diskVault(p, files);
  let writes = 0;
  p.loadData = async () => undefined;
  p.saveData = async value => { writes++; files.set(dataPath, JSON.stringify(value, undefined, 2)); };
  await p.loadPluginData();
  await p.checkIdleSessions();
  const result = await p.savePluginData();
  assert.equal(writes, 0);
  assert.equal(files.get(dataPath), broken);
  assert.equal(result.success, false);
  assert.ok([...files.entries()].some(([path, data]) => path.includes('/backups/') && data === broken), 'raw bytes copied to backups');
});

test('a save that Obsidian silently drops is reported as failed and stays dirty', async () => {
  const { p } = setup();
  const dataPath = '.obsidian/plugins/crisp-pulse/data.json';
  const files = new Map();
  diskVault(p, files);
  await p.loadPluginData();
  p.saveData = async () => {};
  p.getOrCreateTodayRecord().contribution.wordsAdded = 123;
  p.dirty = true;
  const failed = await p.savePluginData();
  assert.equal(failed.success, false);
  assert.equal(p.dirty, true);
  assert.equal(p.saveStatus, 'error');
  p.saveData = async value => { files.set(dataPath, JSON.stringify(value, undefined, 2)); };
  const saved = await p.savePluginData();
  assert.equal(saved.success, true);
  assert.equal(p.dirty, false);
});

test('focus minutes use the length the session started with, not a default changed mid-session', async () => {
  const { p } = setup();
  await p.loadPluginData();
  const focus = {
    settings: { sessionDurationMinutes: 25 },
    async startFocusSession(minutes = this.settings.sessionDurationMinutes) { this.settings.sessionDurationMinutes = Math.round(minutes); },
    async completeFocusSession() {}
  };
  p.app.plugins.getPlugin = id => id === 'crisp-focus' ? focus : null;
  p.focusAdapter.attach();
  await focus.startFocusSession();
  focus.settings.sessionDurationMinutes = 50;
  await focus.completeFocusSession();
  assert.equal(p.getOrCreateTodayRecord().activity.focusMinutes, 25);
  p.focusAdapter.detach();
  assert.equal(typeof focus.startFocusSession, 'function');
});

// 1.11: month pace against the same point of the previous month.
function paceDay(score, quality = 'recorded') { return { quality, contribution: { score, wordsAdded: score * 10 }, activity: { focusMinutes: score / 2 } }; }

test('month pace compares this month with the same day of last month and projects the month end', () => {
  const { helpers } = setup();
  const daily = {};
  for (let d = 1; d <= 30; d++) daily[`2026-09-${String(d).padStart(2, '0')}`] = paceDay(10);
  for (let d = 1; d <= 3; d++) daily[`2026-10-0${d}`] = paceDay(20);
  const pace = helpers.buildMonthPace(daily, '2026-10-03', () => true, 'score');
  assert.equal(pace.days, 31);assert.equal(pace.today, 3);
  assert.equal(pace.actualToDate, 60);assert.equal(pace.baselineToDate, 30);assert.equal(pace.baselineTotal, 300);
  assert.equal(pace.deltaPct, 100);
  assert.deepEqual([...pace.actual], [20, 40, 60]);
  assert.equal(pace.baseline.length, 31);assert.equal(pace.baseline[30], 300);
  // Recent rate: the last 7 calendar days with a record (Sep 27-30 at 10, Oct 1-3 at 20).
  assert.equal(Math.round(pace.recentRate * 100) / 100, 14.29);
  assert.equal(Math.round(pace.projection), 60 + Math.round(100 / 7 * 28));
  const words = helpers.buildMonthPace(daily, '2026-10-03', () => true, 'words');
  assert.equal(words.actualToDate, 600);
  const active = helpers.buildMonthPace({ ...daily, '2026-10-02': paceDay(0) }, '2026-10-03', () => true, 'active');
  assert.equal(active.baselineTotal, 30);assert.deepEqual([...active.actual], [1, 1, 2]);
});

test('month pace words leave out what was written into system folders', () => {
  const { helpers } = setup();
  const day = (words, system) => ({ quality: 'recorded', contribution: { score: 1, wordsAdded: words }, files: { 'Sidecar/logs/a.md': { sourceWords: { system } }, 'b.md': { sourceWords: { unattributed: words - system } } } });
  const pace = helpers.buildMonthPace({ '2026-10-01': day(1000, 800), '2026-10-02': day(50, 0), '2026-10-03': day(10, 99) }, '2026-10-03', () => true, 'words');
  assert.deepEqual([...pace.actual], [200, 250, 250]);
});

test('month pace maps days past the end of a shorter previous month onto its total', () => {
  const { helpers } = setup();
  const daily = {};
  for (let d = 1; d <= 28; d++) daily[`2026-02-${String(d).padStart(2, '0')}`] = paceDay(1);
  for (let d = 1; d <= 31; d++) daily[`2026-03-${String(d).padStart(2, '0')}`] = paceDay(1);
  const pace = helpers.buildMonthPace(daily, '2026-03-31', () => true, 'score');
  assert.equal(pace.baselineTotal, 28);assert.equal(pace.baselineToDate, 28);
  assert.equal(pace.baseline[29], 28);assert.equal(pace.baseline[30], 28);
  assert.equal(pace.needPerDay, null);
});

test('month pace never counts excluded or missing days and reports when there is no baseline', () => {
  const { helpers } = setup();
  const daily = { '2026-10-01': paceDay(50, 'estimated'), '2026-10-03': paceDay(30) };
  const pace = helpers.buildMonthPace(daily, '2026-10-03', rec => rec.quality === 'recorded', 'score');
  assert.equal(pace.actualToDate, 30);assert.deepEqual([...pace.actual], [0, 0, 30]);
  assert.equal(pace.missingDays, 2);
  assert.equal(pace.prevFirstDay, null);
  assert.equal(pace.baseline, null);assert.equal(pace.baselineTotal, 0);assert.equal(pace.deltaPct, null);
  const behind = helpers.buildMonthPace({ ...daily, '2026-09-01': paceDay(100), '2026-09-02': paceDay(100) }, '2026-10-03', rec => rec.quality === 'recorded', 'score');
  assert.equal(behind.deltaPct, -85);
  assert.equal(behind.prevFirstDay, 1);
  assert.equal(helpers.buildMonthPace({ '2026-09-08': paceDay(5) }, '2026-10-03', () => true, 'score').prevFirstDay, 8);
  assert.equal(Math.round(behind.needPerDay * 100) / 100, Math.round(170 / 28 * 100) / 100);
});

// Lifecycle E2E: delayed read → vault event → collection → save → reload.
// Failure modes: deleted-file snapshots return; recreated files are skipped; moved-out notes re-enter
// tracking; an old-path read overwrites a newer read at the destination; creation is half-counted.
function deferredRead() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

test('lifecycle E2E: deleting during a read cannot resurrect a snapshot or hide a recreated note', async () => {
  const { p, handlers } = setup();
  await p.loadPluginData();p.registerVaultEvents();
  const file = { path: 'notes/a.md', extension: 'md', content: 'one' };
  await p.initializeSnapshots([file]);
  const read = deferredRead();p.app.vault.read = () => read.promise;
  const pending = p.handleFileModification(file);
  await new Promise(resolve => setImmediate(resolve));
  handlers.delete({ path: 'notes' });
  read.release('one two');await pending;
  assert.equal(p.fileSnapshots.has('notes/a.md'), false);
  p.app.vault.read = async file => file.content;
  await p.handleFileCreation({ path: 'notes/a.md', extension: 'md', content: 'new' });
  await p.flushAllSessions();
  p.loadData = async () => p.persisted;await p.loadPluginData();
  const day = p.store.daily['2026-09-08'];
  assert.equal(day.contribution.notesCreated, 1);assert.equal(day.contribution.wordsAdded, 1);
  assert.equal(p.fileSnapshots.get('notes/a.md').words, 1);
});

test('lifecycle E2E: a read finishing after a move into an excluded folder stays excluded', async () => {
  const { p, handlers } = setup();
  await p.loadPluginData();p.registerVaultEvents();p.settings.excludedFolders.push('excluded');
  const file = { path: 'notes/a.md', extension: 'md', content: 'one' };
  await p.initializeSnapshots([file]);
  const read = deferredRead();p.app.vault.read = () => read.promise;
  const pending = p.handleFileModification(file);await new Promise(resolve => setImmediate(resolve));
  file.path = 'excluded/a.md';await handlers.rename(file, 'notes/a.md');
  read.release('one two');await pending;
  assert.equal(p.fileSnapshots.has('excluded/a.md'), false);
  await p.savePluginData();p.loadData = async () => p.persisted;await p.loadPluginData();
  assert.equal(Object.values(p.store.daily).reduce((sum, day) => sum + day.contribution.wordsAdded, 0), 0);
});

test('lifecycle E2E: a stale old-path read cannot undo a newer edit after rename', async () => {
  const { p, handlers } = setup();
  await p.loadPluginData();p.registerVaultEvents();
  const file = { path: 'notes/a.md', extension: 'md', content: 'one' };
  await p.initializeSnapshots([file]);
  const read = deferredRead();let reads = 0;
  p.app.vault.read = () => ++reads === 1 ? read.promise : Promise.resolve('one two three');
  const pending = p.handleFileModification(file);await new Promise(resolve => setImmediate(resolve));
  file.path = 'notes/b.md';await handlers.rename(file, 'notes/a.md');
  const newer = p.handleFileModification(file);await new Promise(resolve => setImmediate(resolve));
  read.release('one two');await Promise.all([pending, newer]);
  assert.equal(p.fileSnapshots.get('notes/b.md').words, 3);
  await p.handleFileModification(file);await p.flushAllSessions();
  p.loadData = async () => p.persisted;await p.loadPluginData();
  assert.equal(p.store.daily['2026-09-08'].contribution.wordsAdded, 2);
  assert.equal(p.store.daily['2026-09-08'].contribution.wordsRemoved, 0);
});

test('lifecycle E2E: deletion during creation never leaves a half-counted file in saved history', async () => {
  const { p, handlers } = setup();
  await p.loadPluginData();p.registerVaultEvents();
  const file = { path: 'notes/a.md', extension: 'md' };
  const read = deferredRead();p.app.vault.read = () => read.promise;
  const pending = p.handleFileCreation(file);await new Promise(resolve => setImmediate(resolve));
  handlers.delete(file);read.release('one two');await pending;
  await p.savePluginData();p.loadData = async () => p.persisted;await p.loadPluginData();
  assert.equal(p.fileSnapshots.has(file.path), false);
  assert.equal(Object.values(p.store.daily).reduce((sum, day) => sum + day.contribution.notesCreated, 0), 0);
});

test('lifecycle E2E: deletion also invalidates reads waiting in the old file queue', async () => {
  const { p, handlers } = setup();
  await p.loadPluginData();p.registerVaultEvents();
  const file = { path: 'a.md', extension: 'md', content: 'one' };
  await p.initializeSnapshots([file]);
  const read = deferredRead();let reads = 0;
  p.app.vault.read = () => ++reads === 1 ? read.promise : Promise.resolve('new');
  const first = p.handleFileModification(file);
  const queued = p.handleFileModification(file);
  await new Promise(resolve => setImmediate(resolve));
  handlers.delete(file);read.release('one two');await Promise.all([first, queued]);
  assert.equal(p.fileSnapshots.has(file.path), false);
  await p.handleFileCreation({ path: file.path, extension: 'md', content: 'new' });
  await p.savePluginData();p.loadData = async () => p.persisted;await p.loadPluginData();
  assert.equal(p.store.daily['2026-09-08'].contribution.notesCreated, 1);
});


test('lifecycle E2E: renaming a pending new note preserves creation and subsequent edits', async () => {
  const { p, handlers } = setup();
  await p.loadPluginData();p.registerVaultEvents();
  const file = { path: 'a.md', extension: 'md' };
  const read = deferredRead();let reads = 0;
  p.app.vault.read = () => ++reads === 1 ? read.promise : Promise.resolve('one two');
  const created = p.handleFileCreation(file);await new Promise(resolve => setImmediate(resolve));
  file.path = 'b.md';await handlers.rename(file, 'a.md');
  const edited = p.handleFileModification(file);await new Promise(resolve => setImmediate(resolve));
  read.release('one');await Promise.all([created, edited]);await p.flushAllSessions();
  p.loadData = async () => p.persisted;await p.loadPluginData();
  const day = p.store.daily['2026-09-08'];
  assert.equal(day.contribution.notesCreated, 1);assert.equal(day.contribution.wordsAdded, 2);
  assert.equal(day.files['b.md'].created, true);assert.equal(day.files['a.md'], undefined);
  assert.equal(p.fileQueues.size, 0);
});

test('lifecycle E2E: moving out and back cannot revive a read from before the exclusion', async () => {
  const { p, handlers } = setup();
  await p.loadPluginData();p.registerVaultEvents();p.settings.excludedFolders.push('excluded');
  const file = { path: 'a.md', extension: 'md', content: 'one' };
  await p.initializeSnapshots([file]);
  const read = deferredRead();let reads = 0;
  p.app.vault.read = () => ++reads === 1 ? read.promise : Promise.resolve('one two three');
  const pending = p.handleFileModification(file);await new Promise(resolve => setImmediate(resolve));
  file.path = 'excluded/a.md';await handlers.rename(file, 'a.md');
  file.path = 'a.md';await handlers.rename(file, 'excluded/a.md');
  read.release('one two');await pending;
  assert.equal(p.fileSnapshots.get('a.md').words, 3);
  await p.handleFileModification(file);await p.savePluginData();
  p.loadData = async () => p.persisted;await p.loadPluginData();
  assert.equal(Object.values(p.store.daily).reduce((sum, day) => sum + day.contribution.wordsAdded, 0), 0);
});

test('banner image size check flags tall, overly wide and low-resolution images', () => {
  const { helpers } = setup();
  const check = helpers.checkBannerImageSize;
  assert.equal(typeof check, 'function');
  assert.deepEqual(Array.from(check(3000, 500)), []);
  assert.deepEqual(Array.from(check(2400, 400)), []);
  assert.match(check(1920, 1080).join(' '), /比例偏高/);
  assert.match(check(6000, 400).join(' '), /比例过宽/);
  assert.match(check(1200, 200).join(' '), /分辨率偏低/);
  assert.equal(check(1200, 1200).length, 2);
});

test('renaming the custom banner image keeps the setting pointed at it', async () => {
  const { p, handlers } = setup();
  await p.loadPluginData();
  p.settings.headerBannerImage = 'assets/sky.png';
  p.registerVaultEvents();
  await handlers.rename({ path: 'assets/banners/sky.png', extension: 'png' }, 'assets/sky.png');
  assert.equal(p.settings.headerBannerImage, 'assets/banners/sky.png');
  await handlers.rename({ path: 'assets/x.png', extension: 'png' }, 'assets/banners/sky.png.bak');
  assert.equal(p.settings.headerBannerImage, 'assets/banners/sky.png');
  await handlers.rename({ path: 'media' }, 'assets');
  assert.equal(p.settings.headerBannerImage, 'media/banners/sky.png');
  await handlers.rename({ path: 'pics' }, 'media/banners');
  assert.equal(p.settings.headerBannerImage, 'pics/sky.png');
});

/* ---------- 24 小时活跃时段 ---------- */
const plainJSON = (x) => JSON.parse(JSON.stringify(x));

test('hourly: an active interval is split at every hour boundary and at midnight', () => {
  const { helpers } = setup();
  const t = (d, h, m) => new Date(2026, 8, d, h, m).getTime();
  assert.deepEqual(plainJSON(helpers.splitActiveInterval(t(8, 9, 50), t(8, 10, 20))),
    [{ day: '2026-09-08', hour: 9, minutes: 10 }, { day: '2026-09-08', hour: 10, minutes: 20 }]);
  assert.deepEqual(plainJSON(helpers.splitActiveInterval(t(8, 23, 50), t(9, 0, 10))),
    [{ day: '2026-09-08', hour: 23, minutes: 10 }, { day: '2026-09-09', hour: 0, minutes: 10 }]);
  assert.deepEqual(plainJSON(helpers.splitActiveInterval(t(8, 9, 0), t(8, 9, 0))), []);
});

test('hourly: interaction accounting fills hourly buckets whose sum equals the daily active minutes', async () => {
  const { p, events, advance } = setup(); // clock starts 2026-09-08 12:00
  await p.loadPluginData();
  p.registerActivityListeners();
  advance(58 * 60000); events.dispatchEvent(new Event('keydown'));   // 12:58:00 (first touch, no minutes)
  advance(90000); events.dispatchEvent(new Event('keydown'));         // 12:59:30 → +1.5 in 12h
  advance(90000); events.dispatchEvent(new Event('keydown'));         // 13:01:00 → +0.5 in 12h, +1 in 13h
  const rec = p.getOrCreateTodayRecord();
  assert.equal(rec.activity.hourly.length, 24);
  assert.ok(Math.abs(rec.activity.hourly[12] - 2) < 1e-9);
  assert.ok(Math.abs(rec.activity.hourly[13] - 1) < 1e-9);
  const sum = rec.activity.hourly.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - rec.activity.activeMinutes) < 1e-9);
});

test('hourly: profile uses only days with hourly data, finds the busiest 3-hour window and withholds it on thin samples', () => {
  const { helpers } = setup();
  const day = (key, hourly, active) => {
    const r = helpers.createEmptyDailyRecord(key);
    r.activity.activeMinutes = active ?? (hourly ? hourly.reduce((a, b) => a + b, 0) : 0);
    if (hourly) r.activity.hourly = hourly;
    return r;
  };
  const h = (pairs) => { const a = Array(24).fill(0); for (const [k, v] of Object.entries(pairs)) a[k] = v; return a; };
  const daily = {
    '2026-09-07': day('2026-09-07', null, 300),                 // before hourly tracking: must not count as zeros
    '2026-09-08': day('2026-09-08', h({ 9: 40, 10: 50, 11: 30, 20: 10 })), // Tuesday
    '2026-09-09': day('2026-09-09', h({ 10: 4, 23: 5, 0: 5 })),            // Wednesday
  };
  const dates = ['2026-09-07', '2026-09-08', '2026-09-09'];
  const prof = helpers.buildHourlyProfile(daily, dates, () => true, { weekStartsOn: 'monday', minSample: 60 });
  assert.equal(prof.total, 144);
  assert.equal(prof.days, 2);
  assert.equal(prof.missingDays, 1);
  assert.equal(prof.hours[10], 54);
  assert.deepEqual(plainJSON(prof.peak), { start: 9, end: 12, minutes: 124, share: 124 / 144 });
  assert.equal(prof.matrix.length, 7);
  assert.equal(prof.matrix[0].label, '一');           // Monday first
  assert.equal(prof.matrix[1].hours[9], 40);          // Tuesday 09h
  assert.equal(prof.matrix[2].hours[23], 5);
  const thin = helpers.buildHourlyProfile(daily, dates, () => true, { minSample: 1000 });
  assert.equal(thin.peak, null);
  assert.equal(thin.needMinutes, 856);
  const filtered = helpers.buildHourlyProfile(daily, dates, (r, key) => key !== '2026-09-08', { minSample: 1 });
  assert.equal(filtered.total, 14);
  // 跨午夜的窗口（22–01 与 23–02 都是 10 分钟）胜出，并列时取更早的起点
  assert.deepEqual(plainJSON(filtered.peak), { start: 22, end: 1, minutes: 10, share: 10 / 14 });
});

test('hourly: repair drops malformed hourly arrays and zeroes invalid buckets without touching daily totals', () => {
  const { helpers } = setup();
  const store = { schemaVersion: 1, settings: {}, daily: {
    '2026-09-08': { date: '2026-09-08', quality: 'recorded', activity: { activeMinutes: 30, focusMinutes: 0, editingSessions: 0, notesOpened: 0, notesEdited: 0, hourly: [1, 2] }, contribution: {}, files: {} },
    '2026-09-09': { date: '2026-09-09', quality: 'recorded', activity: { activeMinutes: 30, focusMinutes: 0, editingSessions: 0, notesOpened: 0, notesEdited: 0, hourly: Array.from({ length: 24 }, (_, i) => (i === 3 ? -5 : i === 4 ? 'x' : 1)) }, contribution: {}, files: {} },
  } };
  const { store: repaired } = helpers.validateAndRepairStore(store);
  assert.equal(repaired.daily['2026-09-08'].activity.hourly, undefined);
  assert.equal(repaired.daily['2026-09-09'].activity.hourly[3], 0);
  assert.equal(repaired.daily['2026-09-09'].activity.hourly[4], 0);
  assert.equal(repaired.daily['2026-09-09'].activity.hourly[5], 1);
  assert.equal(repaired.daily['2026-09-09'].activity.activeMinutes, 30);
});


/* ---------- 速记：每日回顾提醒与 URL 入口（插件层） ---------- */

test('memo review reminder fires once per day after the configured time and never without old memos', async () => {
  const { p } = setup();
  await p.loadPluginData();
  const memos = [{ date: '2026-09-01', time: '09:00', text: '旧想法', tags: [], links: [], path: 'Daily/2026-09-01.md', startLine: 0 }];
  p.memoStore = { list: async () => memos };
  p.settings.memoReviewTime = '09:00';
  await p.checkMemoReviewReminder(new Date(2026, 8, 8, 8, 59));
  assert.equal(p.settings.memoReviewNotifiedOn, '');
  await p.checkMemoReviewReminder(new Date(2026, 8, 8, 9, 1));
  assert.equal(p.settings.memoReviewNotifiedOn, '2026-09-08');
  let listed = 0;
  p.memoStore = { list: async () => { listed++; return memos; } };
  await p.checkMemoReviewReminder(new Date(2026, 8, 8, 18, 0));
  assert.equal(listed, 0, 'already reminded today');
  p.settings.memoReviewTime = '';
  await p.checkMemoReviewReminder(new Date(2026, 8, 9, 10, 0));
  assert.equal(p.settings.memoReviewNotifiedOn, '2026-09-08', 'empty time disables the reminder');
});

test('memo URL handler captures text with extra tags and only opens the view when asked or empty', async () => {
  const { p } = setup();
  await p.loadPluginData();
  const captured = [];
  let opened = 0;
  p.memoStore = { capture: async (text) => { captured.push(text); } };
  p.refreshMemoViews = () => {};
  p.activateMemoView = async () => { opened++; };
  await p.handleMemoUrl({ action: 'crisp-pulse-memo', text: '路上想到的', tags: '灵感' });
  await p.handleMemoUrl({ text: '' });
  await p.handleMemoUrl({ text: '再记一条', open: '1' });
  assert.deepEqual(captured, ['路上想到的 #灵感', '再记一条']);
  assert.equal(opened, 2);
});

// 1.13.1: only writes made inside Obsidian count as writing; background and system writes are kept aside.
test('system directory writes never count as writing, created notes or score, even when tracked', async () => {
  const { p } = setup();await p.loadPluginData();
  assert.equal(p.settings.excludeSystemArtifacts, false);
  await p.handleFileCreation({ path: 'Sidecar/logs/backup/AGENTS.md', extension: 'md', content: 'word '.repeat(800) });
  const file = { path: 'Sidecar/logs/run.md', extension: 'md', content: 'one' };
  p.fileSnapshots.set(file.path, baseline(file.content));
  file.content = 'one two three four - [x] done [[link]]';await p.handleFileModification(file);
  const record = p.getOrCreateTodayRecord();
  assert.equal(record.contribution.wordsAdded, 0);
  assert.equal(record.contribution.notesCreated, 0);
  assert.equal(record.contribution.linksCreated, 0);
  assert.equal(record.contribution.score, 0);
  assert.equal(Object.keys(record.files).length, 0);
  assert.ok(record.contribution.externalWords >= 800);
  assert.equal(p.activeSessions.size, 0);
});

/* 本人写作要有输入证据：在这篇笔记的标签页里键入 / 粘贴 / 点任务框，或 Pulse 自己的速记提交。
   失败模式：前台脚本、同步、别的插件写文件被算成本人写作（窗口在前台不能证明是本人键入）。 */
function leafFor(p, path) {
  const leafEl = { closest: () => leafEl };
  const target = { closest: (sel) => (sel === '.workspace-leaf' ? leafEl : sel.includes('checkbox') ? target : null) };
  const leaves = (p.app.workspace.leaves ||= []);
  leaves.push({ containerEl: leafEl, view: { file: { path } } });
  p.app.workspace.iterateAllLeaves = (fn) => leaves.forEach(fn);
  return target;
}

test('a foreground write with no input evidence is not counted as the user\'s writing', async () => {
  const { p } = setup();await p.loadPluginData();p.realEvidence();
  const file = { path: 'Topics/self-media/raw/inbox/script-generated.md', extension: 'md', content: '原有内容' };
  p.fileSnapshots.set(file.path, baseline(file.content));
  file.content += '\n完全由脚本写入的二十个文字不是用户键入';await p.handleFileModification(file);
  const record = p.getOrCreateTodayRecord();
  assert.equal(record.contribution.wordsAdded, 0, '窗口在前台不能证明是本人键入');
  assert.ok(record.contribution.externalWords > 0);
  await p.handleFileCreation({ path: 'notes/agent-made.md', extension: 'md', content: 'agent '.repeat(30) });
  assert.equal(p.getOrCreateTodayRecord().contribution.notesCreated, 0, '没有键盘或点击时新建的笔记不算本人新建');
});

test('typing in a note\'s tab counts; another note written meanwhile does not', async () => {
  const { p, advance } = setup();await p.loadPluginData();p.realEvidence();
  const typed = { path: 'notes/draft.md', extension: 'md', content: 'one' };
  const other = { path: 'notes/synced.md', extension: 'md', content: 'one' };
  p.fileSnapshots.set(typed.path, baseline(typed.content));p.fileSnapshots.set(other.path, baseline(other.content));
  const target = leafFor(p, typed.path);
  p.noteWritingEvidence({ type: 'keydown', key: 'a', target });
  advance(2000);
  typed.content += ' typed here';await p.handleFileModification(typed);
  other.content += ' synced in';await p.handleFileModification(other);
  const record = p.getOrCreateTodayRecord();
  assert.equal(record.contribution.wordsAdded, 2);
  assert.equal(record.files['notes/draft.md'].sourceWords.unattributed, 2);
  assert.equal(record.contribution.externalWords, 2);
});

test('an editor save landing just after switching away still counts as writing; a later write does not', async () => {
  const { p, context, advance } = setup();await p.loadPluginData();p.realEvidence();
  const file = { path: 'notes/a.md', extension: 'md', content: 'one' };
  p.fileSnapshots.set(file.path, baseline(file.content));
  p.noteWritingEvidence({ type: 'keydown', key: 'a', target: leafFor(p, file.path) });
  context.document.hasFocus = () => false;p.noteWindowBlur();advance(3000);
  file.content = 'one two three';await p.handleFileModification(file);
  assert.equal(p.getOrCreateTodayRecord().contribution.wordsAdded, 2);
  advance(60000);
  file.content += ' four';await p.handleFileModification(file);
  assert.equal(p.getOrCreateTodayRecord().contribution.wordsAdded, 2);
  assert.equal(p.getOrCreateTodayRecord().contribution.externalWords, 1);
});

test('clicking a task checkbox counts; a plain click in the note does not', async () => {
  const { p } = setup();await p.loadPluginData();p.realEvidence();
  const file = { path: 'notes/tasks.md', extension: 'md', content: '- [ ] a' };
  p.fileSnapshots.set(file.path, baseline(file.content));
  const target = leafFor(p, file.path);
  const plain = { closest: (sel) => (sel === '.workspace-leaf' ? target.closest('.workspace-leaf') : null) };
  p.noteWritingEvidence({ type: 'click', target: plain });
  assert.equal(p.hasWritingEvidence(file.path), false);
  p.noteWritingEvidence({ type: 'click', target });
  file.content = '- [x] a';await p.handleFileModification(file);
  assert.equal(p.getOrCreateTodayRecord().contribution.tasksCompleted, 1);
});

test('editor-change counts only right after real input, not when an external write reloads the editor', async () => {
  const { p, advance } = setup();await p.loadPluginData();p.realEvidence();
  const listeners = {};p.app.workspace.on = (name, fn) => { listeners[name] = fn; return {}; };
  p.registerActivityListeners();
  listeners['editor-change'](null, { file: { path: 'canvas/embedded.md' } });
  assert.equal(p.hasWritingEvidence('canvas/embedded.md'), false, '外部写入导致的编辑器重载不算');
  p.noteWritingEvidence({ type: 'keydown', key: 'a', target: null });
  advance(100);
  listeners['editor-change'](null, { file: { path: 'canvas/embedded.md' } });
  assert.equal(p.hasWritingEvidence('canvas/embedded.md'), true);
});

test('a new note right after a click or keypress counts as created; Pulse memo capture marks its own write', async () => {
  const { p, advance } = setup();await p.loadPluginData();p.realEvidence();
  p.noteWritingEvidence({ type: 'pointerdown', target: null });
  advance(500);
  await p.handleFileCreation({ path: 'notes/new.md', extension: 'md', content: '' });
  assert.equal(p.getOrCreateTodayRecord().contribution.notesCreated, 1);
  p.markWritingEvidence('Daily/2026-09-08.md');
  const daily = { path: 'Daily/2026-09-08.md', extension: 'md', content: 'x' };
  p.fileSnapshots.set(daily.path, baseline(daily.content));
  daily.content += '\n> [!memo] 12:00\n> 一条 速记';await p.handleFileModification(daily);
  assert.ok(p.getOrCreateTodayRecord().contribution.wordsAdded > 0);
});

/* 番茄钟联动（Pulse 1.19.0 + Crisp Focus 1.5.0）。失败模式：
   - 中途结束的番茄也计分（开了就停能刷分）；不到 1 分钟的误触留下记录。
   - 同一个事件来两次就记两次；新版 Focus 同时被事件和旧的方法包装各记一次。
   - 休息事件被当成专注计分。
   - 存储里的番茄记录被写坏后拖垮整天的统计。 */
function focusEvent(type, extra = {}) {
  return { apiVersion: 1, type, id: 's1', kind: 'focus', phase: 'focus', pomodoro: true, round: 1, roundsPerCycle: 4, plannedMinutes: 25, startedAt: new Date(2026, 8, 8, 11, 30).getTime(), notePath: 'notes/draft.md', ...extra };
}

test('a completed pomodoro is recorded and scored; an interrupted one is recorded but not scored', async () => {
  const { p } = setup();await p.loadPluginData();
  p.settings.enableCrispFocusSync = true;p.settings.includeFocusInContribution = true;
  await p.handleFocusSessionEvent(focusEvent('complete', { completed: true, elapsedMs: 25 * 60000 }));
  await p.handleFocusSessionEvent(focusEvent('complete', { completed: true, elapsedMs: 25 * 60000 }));
  let today = p.getOrCreateTodayRecord();
  assert.equal(today.activity.focusMinutes, 25, '同一个事件只记一次');
  assert.deepEqual(JSON.parse(JSON.stringify(today.activity.focusSessions)), [{ at: '11:30', minutes: 25, completed: true, pomodoro: true, note: 'notes/draft.md' }]);
  const score = today.contribution.score;
  await p.handleFocusSessionEvent(focusEvent('stop', { id: 's2', completed: false, elapsedMs: 12 * 60000 + 5000 }));
  await p.handleFocusSessionEvent(focusEvent('stop', { id: 's3', completed: false, elapsedMs: 40000 }));
  today = p.getOrCreateTodayRecord();
  assert.equal(today.activity.focusMinutes, 25, '中断的不计入专注分钟');
  assert.equal(today.contribution.score, score, '中断的不计分');
  assert.equal(today.activity.focusSessions.length, 2, '不到 1 分钟的不留记录');
  assert.equal(today.activity.focusSessions[1].completed, false);
  assert.equal(today.activity.focusSessions[1].minutes, 12);
});

test('break events never score and drive the memo prompt', async () => {
  const { p } = setup();await p.loadPluginData();
  p.settings.enableCrispFocusSync = true;
  await p.handleFocusSessionEvent(focusEvent('start', { id: 'b1', kind: 'break', phase: 'short-break' }));
  assert.equal(p.pomodoroBreak.id, 'b1');
  await p.handleFocusSessionEvent(focusEvent('complete', { id: 'b1', kind: 'break', phase: 'short-break', completed: true }));
  assert.equal(p.pomodoroBreak, null);
  assert.equal(p.getOrCreateTodayRecord().activity.focusMinutes, 0);
  assert.equal(p.getOrCreateTodayRecord().activity.focusSessions, undefined);
});

test('a Focus with the session event API is not wrapped, so nothing is counted twice', () => {
  const { p, helpers } = setup();
  p.settings = { enableCrispFocusSync: true };
  const original = async () => {};
  const focus = { focusApiVersion: 1, completeFocusSession: original, startFocusSession: async () => {} };
  p.app.plugins.getPlugin = (id) => (id === 'crisp-focus' ? focus : null);
  const adapter = new helpers.CrispFocusAdapter(p);
  adapter.attach();
  assert.equal(focus.completeFocusSession, original, '新版 Focus 走事件，不包装');
  const legacy = { completeFocusSession: original, startFocusSession: async () => {} };
  p.app.plugins.getPlugin = (id) => (id === 'crisp-focus' ? legacy : null);
  adapter.attach();
  assert.notEqual(legacy.completeFocusSession, original, '旧版 Focus 仍按原方式记录');
  adapter.detach();
});

test('damaged focus session records are dropped without touching the rest of the day', () => {
  const { helpers } = setup();
  const store = { version: 1, settings: {}, daily: { '2026-09-08': { date: '2026-09-08', quality: 'recorded', contribution: { score: 3 }, activity: { activeMinutes: 5, focusMinutes: 25, focusSessions: [{ at: '09:00', minutes: 25, completed: true, pomodoro: true, note: null }, { at: 'bad', minutes: 25, completed: true, pomodoro: true }, 'x'] }, files: {} } } };
  const { store: repaired } = helpers.validateAndRepairStore(store);
  const day = repaired.daily['2026-09-08'];
  assert.equal(day.activity.focusSessions.length, 1);
  assert.equal(day.activity.focusMinutes, 25);
  assert.equal(day.activity.activeMinutes, 5);
});


/* 删除笔记（1.19.0）。失败模式：
   - 当天新建又删掉的草稿、误建的「未命名」文件仍算新建笔记和字数（用户看到已删的文件还在计分）。
   - 反过来，删掉一篇旧笔记把过去那些天的记录也擦掉。
   - Obsidian 关着时删掉的，重新打开后仍在计分。 */
test('a note created and deleted on the same day is rolled back; a deleted older note keeps its history', async () => {
  const { p, handlers } = setup();
  await p.loadPluginData();p.registerVaultEvents();
  p.settings.weightNoteCreated = 5;
  await p.handleFileCreation({ path: 'drafts/未命名思维导图.mind.md', extension: 'md', content: 'word '.repeat(56) });
  const kept = { path: 'notes/old.md', extension: 'md', content: 'zero' };
  p.fileSnapshots.set(kept.path, baseline(kept.content));
  kept.content = 'zero one two three';await p.handleFileModification(kept);
  let today = p.getOrCreateTodayRecord();
  assert.equal(today.contribution.notesCreated, 1);
  assert.equal(today.contribution.wordsAdded, 59);
  await handlers.delete({ path: 'drafts/未命名思维导图.mind.md' });
  await handlers.delete({ path: 'notes/old.md' });
  today = p.getOrCreateTodayRecord();
  assert.equal(today.contribution.notesCreated, 0);
  assert.equal(today.contribution.wordsAdded, 3);
  assert.deepEqual(Object.keys(today.files), ['notes/old.md'], '旧笔记今天的编辑仍保留');
  const yesterday = p.getOrCreateRecord('2026-09-07');
  yesterday.files = { 'notes/gone.md': { wordsAdded: 40, created: true, tasks: 0, links: 0 } };
  yesterday.contribution.notesCreated = 1;yesterday.contribution.wordsAdded = 40;
  await handlers.delete({ path: 'notes/gone.md' });
  assert.equal(p.getOrCreateRecord('2026-09-07').contribution.wordsAdded, 40, '以前的记录不擦掉');
});

test('deleting a folder rolls back the notes created in it today', async () => {
  const { p, handlers } = setup();
  await p.loadPluginData();p.registerVaultEvents();
  await p.handleFileCreation({ path: 'scratch/a.md', extension: 'md', content: 'one two' });
  await p.handleFileCreation({ path: 'scratch/b.md', extension: 'md', content: 'three' });
  await p.handleFileCreation({ path: 'keep.md', extension: 'md', content: 'four five' });
  await handlers.delete({ path: 'scratch' });
  const today = p.getOrCreateTodayRecord();
  assert.equal(today.contribution.notesCreated, 1);
  assert.equal(today.contribution.wordsAdded, 2);
});

test('notes deleted while Obsidian was closed are rolled back on startup', async () => {
  const { p } = setup();
  await p.loadPluginData();
  await p.handleFileCreation({ path: 'gone.md', extension: 'md', content: 'one two three' });
  await p.handleFileCreation({ path: 'here.md', extension: 'md', content: 'four' });
  p.app.vault.getAbstractFileByPath = (path) => (path === 'here.md' ? { path } : null);
  assert.equal(p.rollbackSameDayCreations((path) => !p.app.vault.getAbstractFileByPath(path)), true);
  const today = p.getOrCreateTodayRecord();
  assert.deepEqual(Object.keys(today.files), ['here.md']);
  assert.equal(today.contribution.wordsAdded, 1);
  assert.equal(today.contribution.notesCreated, 1);
});

/* 1.19.2 审计复核。失败模式：
   - 当天新建的笔记编辑会话已经结算，之后删掉笔记，有效编辑次数和编辑会话没跟着撤回，已删的笔记仍在计分。
   - 休息中第二次暂停被当成重复事件丢掉，速记仍提示「带 #番茄」。 */
test('a same-day note deleted after its edit session closed takes the session score with it', async () => {
  const { p, handlers, advance } = setup();
  await p.loadPluginData();p.registerVaultEvents();
  const note = { path: 'drafts/new.md', extension: 'md', content: '' };
  await p.handleFileCreation(note);
  p.fileSnapshots.set(note.path, baseline(note.content));
  note.content = 'word '.repeat(21);await p.handleFileModification(note);
  advance(10 * 60 * 1000);await p.checkIdleSessions();
  let today = p.getOrCreateTodayRecord();
  assert.equal(today.contribution.meaningfulEdits, 1, '会话已结算');
  await handlers.delete({ path: note.path });
  today = p.getOrCreateTodayRecord();
  assert.equal(today.contribution.meaningfulEdits, 0);
  assert.equal(today.activity.editingSessions, 0);
  assert.equal(today.contribution.score, 0);
});

test('pausing a break a second time clears the memo prompt again', async () => {
  const { p } = setup();await p.loadPluginData();
  p.settings.enableCrispFocusSync = true;
  const states = [];
  for (const [type, at] of [['start', 1], ['pause', 2], ['resume', 3], ['pause', 4], ['resume', 5]]) {
    await p.handleFocusSessionEvent(focusEvent(type, { id: 'b1', kind: 'break', phase: 'short-break', at }));
    states.push(!!p.pomodoroBreak);
  }
  assert.deepEqual(states, [true, false, true, false, true]);
});

test('deleting a note re-created at an old note\'s path rolls back only the new note', async () => {
  const { p, handlers } = setup();
  await p.loadPluginData();p.registerVaultEvents();
  const old = { path: 'notes/same.md', extension: 'md', content: 'zero' };
  p.fileSnapshots.set(old.path, baseline(old.content));
  old.content = 'zero ' + 'word '.repeat(20);await p.handleFileModification(old);
  const session = p.activeSessions.get(old.path);
  if (session) session.isMeaningful = true;
  await handlers.delete({ path: old.path });
  let today = p.getOrCreateTodayRecord();
  const words = today.contribution.wordsAdded, edits = today.contribution.meaningfulEdits;
  assert.equal(words, 20);
  await p.handleFileCreation({ path: 'notes/same.md', extension: 'md', content: 'brand new note text' });
  assert.equal(p.getOrCreateTodayRecord().contribution.notesCreated, 1);
  await handlers.delete({ path: 'notes/same.md' });
  today = p.getOrCreateTodayRecord();
  assert.equal(today.contribution.wordsAdded, words, '旧笔记今天写的 20 字还在');
  assert.equal(today.contribution.meaningfulEdits, edits, '旧笔记的有效编辑还在');
  assert.equal(today.contribution.notesCreated, 0);
  assert.equal(today.files['notes/same.md'].created, false);
  assert.equal(today.files['notes/same.md'].wordsAdded, 20);
});

/* 1.19.7。失败模式：
   - 清空复盘行动的标题后重载，整条行动（完成状态、结果笔记）消失。
   - 在笔记里按方向键、Cmd+F 后，脚本写进这篇笔记的字算成本人写作。 */
test('a review action whose title was cleared survives save and reload with its status and outcome', async () => {
  const { p } = setup();await p.loadPluginData();
  p.app.vault.getAbstractFileByPath = (path) => (path === 'result.md' ? { path, extension: 'md' } : null);
  const range = ['2026-09-02', '2026-09-08', 'all'];
  p.addReviewAction(...range, '写完第一稿');
  const id = p.getReviewModel(...range).actions[0].id;
  p.updateReviewAction(...range, id, { title: '', status: 'done', outcomePath: 'result.md' });
  await p.savePluginData();p.loadData = async () => p.persisted;await p.loadPluginData();
  const [action] = p.getReviewModel(...range).actions;
  assert.equal(action?.id, id);
  assert.equal(action.title, '');
  assert.equal(action.status, 'done');
  assert.equal(action.outcomePath, 'result.md');
  assert.match(p.constructor.generateReviewReport(p.getReviewModel(...range)), /待填写行动/);
});

test('cursor movement and non-editing shortcuts are not writing evidence; real edits are', async () => {
  const { p, advance } = setup();await p.loadPluginData();p.realEvidence();
  const file = { path: 'notes/nav.md', extension: 'md', content: 'start' };
  p.fileSnapshots.set(file.path, baseline(file.content));
  const target = leafFor(p, file.path);
  for (const key of ['ArrowDown', 'ArrowUp', 'PageDown', 'Home', 'End', 'Escape', 'Shift']) p.noteWritingEvidence({ type: 'keydown', key, target });
  p.noteWritingEvidence({ type: 'keydown', key: 'f', metaKey: true, target });
  assert.equal(p.hasWritingEvidence(file.path), false, '只移动光标或搜索不算');
  file.content += ' ' + 'script '.repeat(20);await p.handleFileModification(file);
  assert.equal(p.getOrCreateTodayRecord().contribution.wordsAdded, 0);
  assert.equal(p.getOrCreateTodayRecord().contribution.externalWords, 20);
  for (const key of ['a', 'Backspace', 'Enter', 'Process']) {
    p.writingEvidence = new Map();
    p.noteWritingEvidence({ type: 'keydown', key, target });
    assert.equal(p.hasWritingEvidence(file.path), true, key);
  }
  // 快捷键要编辑器紧接着真的变了才算（如 Cmd+Z、Alt+↑ 移动行）
  const listeners = {};p.app.workspace.on = (name, fn) => { listeners[name] = fn; return {}; };
  p.registerActivityListeners();p.writingEvidence = new Map();
  p.noteWritingEvidence({ type: 'keydown', key: 'z', metaKey: true, target });
  assert.equal(p.hasWritingEvidence(file.path), false);
  advance(200);listeners['editor-change'](null, { file: { path: file.path } });
  assert.equal(p.hasWritingEvidence(file.path), true);
});

/* 1.19.8。失败模式：模板或说明文档的代码块里贴了转换凭据 / Now 行动标记的示例，
   转换时把示例文档当成已转换的目标：不建新笔记、打开示例、回链指向示例。 */
function conversionStubs(p, files) {
  const linked = [];const opened = [];const created = [];
  p.app.vault.getMarkdownFiles = () => Object.keys(files).map((path) => ({ path, basename: path.split('/').pop().replace(/\.md$/, '') }));
  p.app.vault.cachedRead = async (f) => files[f.path];
  p.app.vault.getAbstractFileByPath = (path) => (files[path] !== undefined ? { path, basename: path.split('/').pop().replace(/\.md$/, '') } : null);
  p.app.vault.process = async (f, fn) => { files[f.path] = fn(files[f.path]); };
  p.app.workspace.getLeaf = () => ({ openFile: async (f) => opened.push(f.path) });
  p.createUnique = async (path, content) => { files[path] = content; created.push(path); return { path, basename: path.split('/').pop().replace(/\.md$/, '') }; };
  p.memoStore = { relinkFor: (text) => text, linkBack: async (_m, link) => linked.push(link), ensureIdentity: async (m) => ({ ...m, id: 'memo-a' }) };
  return { linked, opened, created };
}

test('a conversion receipt shown inside a code block is an example, not the converted note', async () => {
  const { p } = setup();await p.loadPluginData();
  const files = { 'Templates/example.md': '# 示例\n```markdown\n<!-- crisp-pulse-conversion:memo-a:note -->\n```\n' };
  const { linked, opened, created } = conversionStubs(p, files);
  const file = await p.finishMemoDocument({ id: 'memo-a', path: 'Daily/2026-10-12.md' }, 'note', { path: 'Output/真实想法.md', content: '> 真实想法' });
  assert.equal(file.path, 'Output/真实想法.md');
  assert.deepEqual(created, ['Output/真实想法.md']);
  assert.deepEqual(opened, ['Output/真实想法.md']);
  assert.deepEqual(linked, ['Output/真实想法']);
  // 刚建好的笔记带着代码块外的真凭据：重试复用它，不再新建
  const again = await p.finishMemoDocument({ id: 'memo-a', path: 'Daily/2026-10-12.md' }, 'note', { path: 'Output/另一个.md', content: 'x' });
  assert.equal(again.path, 'Output/真实想法.md');
  assert.deepEqual(created, ['Output/真实想法.md']);
});

test('a Now action marker shown inside a code block does not stop the memo being added', async () => {
  const { p } = setup();await p.loadPluginData();
  const files = { 'Now/行动.md': '# 行动\n```\n- [ ] 示例 ^pulse-memo-memo-a\n```\n' };
  const { linked } = conversionStubs(p, files);
  await p.convertMemoToNow({ path: 'Daily/2026-10-12.md', startLine: 3, text: '真实想法' });
  assert.match(files['Now/行动.md'], /```\n- \[ \] 真实想法 \[\[Daily\/2026-10-12\]\] \^pulse-memo-memo-a\n$/);
  assert.deepEqual(linked, ['Now/行动#^pulse-memo-memo-a']);
  await p.convertMemoToNow({ path: 'Daily/2026-10-12.md', startLine: 3, text: '真实想法' });
  assert.equal(files['Now/行动.md'].split('^pulse-memo-memo-a').length - 1, 2, '再点一次不重复加（示例 1 处 + 真实 1 处）');
});

test('the current streak does not depend on the selected date range', async () => {
  const { p, helpers } = setup();
  await p.loadPluginData();
  p.settings.trackingStartDate = '';
  const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  for (let i = 0; i < 30; i++) {
    const k = key(new Date(2026, 8, 8 - i));
    const rec = helpers.createEmptyDailyRecord(k);
    rec.contribution.score = 10; rec.contribution.meaningfulEdits = 1;
    p.store.daily[k] = rec;
  }
  for (const range of ['7d', '30d', '90d']) assert.equal(p.calcStats('reliable', range).currentStreak, 30, range);
  assert.equal(p.calcStats('reliable', '7d').activeDays, 7, '总量类指标仍按范围算');
});

test('the longest streak is never shorter than the current streak, whatever the range', async () => {
  const { p, helpers } = setup();
  await p.loadPluginData();
  p.settings.trackingStartDate = '';
  const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  for (let i = 0; i < 20; i++) {
    const k = key(new Date(2026, 8, 8 - i));
    const rec = helpers.createEmptyDailyRecord(k);
    rec.contribution.score = 10; rec.contribution.meaningfulEdits = 1;
    p.store.daily[k] = rec;
  }
  for (const range of ['7d', '30d', 'year']) {
    const stats = p.calcStats('reliable', range);
    assert.equal(stats.currentStreak, 20, range);
    assert.equal(stats.longestStreak, 20, range);
  }
});

test('opening the memo view falls back to a new tab when the right sidebar has no leaf', async () => {
  const { p } = setup();
  const leaf = { state: null, async setViewState(s) { this.state = s; } };
  let revealed = null;
  p.app = { ...p.app, workspace: { getLeavesOfType: () => [], getRightLeaf: () => null, getLeaf: () => leaf, revealLeaf: (l) => { revealed = l; } } };
  await p.activateMemoView();
  assert.equal(leaf.state?.type, 'crisp-pulse-memo-view');
  assert.equal(revealed, leaf);
});
