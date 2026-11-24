const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const context = { require: () => ({ Plugin: class {}, ItemView: class {}, PluginSettingTab: class {}, Modal: class {}, Notice: class {}, Setting: class {}, TFile: class {}, addIcon() {} }), module: { exports: {} }, console, Date, window: { setTimeout, clearTimeout }, document: {}, navigator: {}, setTimeout, clearTimeout, structuredClone, crypto: globalThis.crypto, atob, TextDecoder, TextEncoder, Buffer };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8') + '\nmodule.exports.calendarTest = { memoCalendarDays, memoAdjacentDates, memoRecentCount };', context);
const { memoCalendarDays, memoAdjacentDates, memoRecentCount } = context.module.exports.calendarTest;
const plain = x => JSON.parse(JSON.stringify(x));

test('month grid respects week start, leap years and year boundaries', () => {
  const feb = plain(memoCalendarDays('2024-02', 'monday'));
  assert.equal(feb[0], '2024-01-29');
  assert.equal(feb.at(-1), '2024-03-03');
  assert.ok(feb.includes('2024-02-29'));
  assert.equal(memoCalendarDays('2025-01', 'sunday')[0], '2024-12-29');
});

test('adjacent navigation uses distinct matching days, with empty boundaries', () => {
  const dates = [{date:'2026-01-02'}, {date:'2025-12-30'}, {date:'2026-01-02'}, {date:'2026-01-05'}];
  assert.deepEqual(plain(memoAdjacentDates(dates, '2026-01-02')), { previous:'2025-12-30', next:'2026-01-05' });
  assert.deepEqual(plain(memoAdjacentDates(dates, '2026-01-01')), { previous:'2025-12-30', next:'2026-01-02' });
  assert.deepEqual(plain(memoAdjacentDates(dates, '2026-01-05')), { previous:'2026-01-02', next:null });
});

test('recent ten weeks count includes today and excludes earlier and future records', () => {
  const memos = ['2026-11-24','2026-09-16','2026-09-15','2026-11-25'].map(date => ({date}));
  assert.equal(memoRecentCount(memos, '2026-11-24', 10), 2);
});
