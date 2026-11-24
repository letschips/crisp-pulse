const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const context = { require: () => ({ Plugin: class {}, ItemView: class {}, setIcon() {}, PluginSettingTab: class {}, Modal: class {}, Notice: class {}, Setting: class {}, TFile: class {}, addIcon() {} }), module: { exports: {} }, console, Date, window: { setTimeout, clearTimeout }, document: {}, navigator: {}, setTimeout, clearTimeout, structuredClone, crypto: globalThis.crypto, atob, TextDecoder, TextEncoder, Buffer };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8') + '\nmodule.exports.calendarTest = { memoCalendarDays, memoAdjacentDates, CrispPulseMemoView, getTodayKey };', context);
const { memoCalendarDays, memoAdjacentDates, CrispPulseMemoView, getTodayKey } = context.module.exports.calendarTest;
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

class El {
  constructor(opts = {}) { this.cls = opts.cls || ''; this.text = opts.text || ''; this.attr = { ...(opts.attr || {}) }; this.children = []; this.events = {}; this.style = { setProperty() {} }; }
  createEl(_tag, opts) { const el = new El(opts); this.children.push(el); return el; }
  createDiv(opts) { return this.createEl('div', opts); }
  createSpan(opts) { return this.createEl('span', opts); }
  setAttribute(k, v) { this.attr[k] = v; }
  addEventListener(k, fn) { this.events[k] = fn; }
  *walk() { yield this; for (const c of this.children) yield* c.walk(); }
  find(test) { for (const el of this.walk()) if (test(el)) return el; return null; }
}

test('heatmap and month shortcuts move the calendar to the selected period', () => {
  const today = getTodayKey();
  const view = Object.create(CrispPulseMemoView.prototype);
  Object.assign(view, { plugin: { settings: { weekStartsOn: 'monday' } }, memos: [{ date: today, tags: [] }], filters: { from: '', to: '' }, filterDate: null, calendarMonth: '2000-01', tab: 'all', render() {} });
  const root = new El();
  view.renderStats(root, { cells: [{ date: today, count: 1, future: false }, ...Array.from({ length: 6 }, (_, i) => ({ date: `2999-01-0${i + 1}`, count: 0, future: true }))], streak: 1, month: 1, total: 1 });
  root.find(el => el.cls.includes('crisp-pulse-memo-heat-cell') && el.attr.title?.startsWith(today)).events.click();
  assert.equal(view.filterDate, today);
  assert.equal(view.calendarMonth, today.slice(0, 7));
  view.calendarMonth = '2000-01';
  root.find(el => el.cls === 'crisp-pulse-memo-month-metric').events.click();
  assert.equal(view.filters.from, `${today.slice(0, 7)}-01`);
  assert.equal(view.calendarMonth, today.slice(0, 7));
});

test('wide metric counts the same weeks the heatmap shows', () => {
  const today = getTodayKey();
  const view = Object.create(CrispPulseMemoView.prototype);
  Object.assign(view, { plugin: { settings: { weekStartsOn: 'sunday' } }, memos: [{ date: today, tags: [] }, { date: '2000-01-01', tags: [] }], filters: {}, render() {} });
  const root = new El();
  const cells = Array.from({ length: 140 }, (_, i) => ({ date: i === 139 ? today : `1999-01-${i}`, count: i === 139 ? 1 : 0, future: false }));
  view.renderStats(root, { cells, recent: 1, streak: 0, month: 1, total: 2 });
  const metrics = root.find(el => el.cls === 'crisp-pulse-memo-metrics');
  assert.equal(metrics.children[0].text, '近 20 周 1 条');
  assert.equal(metrics.children.some(el => el.text.includes('连续')), false);
});
