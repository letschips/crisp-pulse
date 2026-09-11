const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function setup() {
  let time = new Date(2026, 8, 8, 12).getTime();
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [time])); } static now() { return time; } }
  const events = new EventTarget();
  const cleanup = [];
  class Plugin { registerEvent() {} registerDomEvent(el, type, fn, options) { el.addEventListener(type, fn, options); cleanup.push(() => el.removeEventListener(type, fn, options)); } }
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
      return { Plugin, TFile, Setting, ItemView: class {}, PluginSettingTab: class {}, Notice: class {}, Modal };
    },
    module: { exports: {} },
    console,
    Date: Clock,
    window: events,
    document: { hidden: false, hasFocus: () => true },
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
    fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8') +
    '\nmodule.exports.helpers={sanitizeCSVCell,formatPulseMinutes:typeof formatPulseMinutes === "function" ? formatPulseMinutes : undefined,buildAnalyticsData:typeof buildAnalyticsData === "function" ? buildAnalyticsData : undefined,analyticsScale:typeof analyticsScale === "function" ? analyticsScale : undefined,analyticsLinePath:typeof analyticsLinePath === "function" ? analyticsLinePath : undefined,CrispPulseView,createEmptyDailyRecord,countTasks,countLinks,validateAndRepairStore,isPathIncluded,getScoreBreakdown,generateDailyCSV,filterDatesByRange,generateReviewData,generateWeeklyMarkdown,getLineSet,getCompletedTaskSet,getIsoWeekString,generateAnksWeeklyReviewFileContent,CrispFocusAdapter,verifyLicenseCode,CrispPulseLicenseManager,discoverVaultCrispLicense,renderAboutCard,ICON_COMPUTER_SVG,ICON_BLOCKS_WAVE_SVG};',
    context
  );
  const Pulse = context.module.exports;
  const p = new Pulse();
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
    workspace: { getLeavesOfType: () => [], getActiveFile: () => null, openLinkText: () => {} },
    plugins: { getPlugin: () => null }
  };
  p.focusAdapter = new Pulse.helpers.CrispFocusAdapter(p);
  p.fileSnapshots = new Map();
  p.activeSessions = new Map();
  p.fileQueues = new Map();
  p.lastInteractionTime = time;
  const handlers = {};
  p.app.vault.on = (name, fn) => { handlers[name] = fn; };
  return { p, handlers, helpers: Pulse.helpers, events, advance: ms => time += ms, cleanup: () => cleanup.forEach(fn => fn()) };
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
  const validCode = "eyJwcm9kdWN0IjoiQ3Jpc3AgU3VpdGUiLCJsaWNlbnNlSWQiOiJDUklTUC1NUzhTSTYxQyIsInVzZXJOYW1lIjoieGl4aSIsImlzc3VlZEF0IjoiMjAyNi0wNy0zMVQxMDoxODo0MS44MDhaIiwiZXhwaXJlc0F0IjoiMjEyNi0wNy0wN1QxMDoxODo0MS44MDhaIiwibWF4RGV2aWNlcyI6MywiZmVhdHVyZXMiOlsiYWxsIl19.qzIxKzUeMutCIcvZwIlkIyU_CUvwhqI_uW7RCvexknv_1Kp87vUgkb_TNDzH4l5rubuhhJSbSk537_fod8FqBw";
  
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
  assert.equal(validRes.payload.userName, "xixi");
  assert.equal(validRes.payload.product, "Crisp Suite");

  // 4. Tampered signature
  const tamperedCode = validCode.slice(0, -6) + "xxxxxx";
  const tamperedRes = await helpers.verifyLicenseCode(tamperedCode);
  assert.equal(tamperedRes.valid, false);
});

test('CrispPulseLicenseManager verifies and maintains entitlement state', async () => {
  const { helpers } = setup();
  const validCode = "eyJwcm9kdWN0IjoiQ3Jpc3AgU3VpdGUiLCJsaWNlbnNlSWQiOiJDUklTUC1NUzhTSTYxQyIsInVzZXJOYW1lIjoieGl4aSIsImlzc3VlZEF0IjoiMjAyNi0wNy0zMVQxMDoxODo0MS44MDhaIiwiZXhwaXJlc0F0IjoiMjEyNi0wNy0wN1QxMDoxODo0MS44MDhaIiwibWF4RGV2aWNlcyI6MywiZmVhdHVyZXMiOlsiYWxsIl19.qzIxKzUeMutCIcvZwIlkIyU_CUvwhqI_uW7RCvexknv_1Kp87vUgkb_TNDzH4l5rubuhhJSbSk537_fod8FqBw";
  const settings = { licenseCode: validCode, licenseLastOnlineAt: 0 };
  const lm = new helpers.CrispPulseLicenseManager(null, settings);

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
