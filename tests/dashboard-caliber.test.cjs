// 看板口径：未记录的日子不算没产出；月初样本太少不下判断；首屏先回答今天。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function element(tag = 'div', options = {}) {
  const el = { tag, options, children: [], text: options.text || '', attrs: { ...(options.attr || {}) }, handlers: {}, style: {}, classList: { add() {}, remove() {} },
    setAttr(k, v) { this.attrs[k] = v; }, addEventListener(k, v) { this.handlers[k] = v; }, setText(v) { this.text = v; }, empty() { this.children = []; } };
  el.createEl = (t, o = {}) => { const child = element(t, o); el.children.push(child); return child; };
  el.createDiv = (o) => el.createEl('div', o);
  el.createSpan = (o) => el.createEl('span', o);
  return el;
}
const all = (e) => [e, ...e.children.flatMap(all)];
const textOf = (e) => all(e).map((n) => n.text).filter(Boolean).join(' ');

function load() {
  class Plugin {}
  const context = {
    require: () => ({ Plugin, ItemView: class {}, Setting: class {}, PluginSettingTab: class {}, Notice: class {}, TFile: class {}, Modal: class {}, setIcon() {}, addIcon() {}, moment: { locale: () => 'zh-cn' } }),
    module: { exports: {} }, console, window: { setTimeout, clearTimeout, setInterval, clearInterval, localStorage: { getItem: () => 'zh' } }, document: { createElement: () => element() }, localStorage: { getItem: () => 'zh' },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8'), context);
  return context.module.exports;
}
const Pulse = load();

test('活跃率的分母是有记录的天数，不把没记录的日子算成没产出', () => {
  const { activeDayShare } = Pulse.dashboardHelpers;
  assert.deepEqual({ ...activeDayShare(51, 54) }, { denominator: 54, share: 51 / 54 });
  assert.deepEqual({ ...activeDayShare(0, 0) }, { denominator: 0, share: 0 });
  assert.equal(activeDayShare(60, 54).share, 1);
});

test('月初第 7 天之前不判断落后，也不推算月底', () => {
  const { paceReading } = Pulse.dashboardHelpers;
  const base = { days: 30, deltaPct: -38, projection: 300, needPerDay: 29 };
  const early = paceReading({ ...base, today: 2 });
  assert.deepEqual([early.settled, early.behind, early.showProjection], [false, false, false]);
  const settled = paceReading({ ...base, today: 7 });
  assert.deepEqual([settled.settled, settled.behind, settled.showProjection], [true, true, true]);
  assert.equal(paceReading({ ...base, today: 30 }).showProjection, false, '月末不用推算');
  assert.equal(paceReading({ ...base, today: 10, deltaPct: null }).behind, false);
});

function strip({ record, entitled = true, streak = 3 }) {
  const opened = [];
  const view = Object.create(Pulse.CrispPulseView.prototype);
  view.plugin = { store: { daily: record ? { [Pulse.dashboardHelpers.todayKey()]: record } : {} }, settings: {} };
  view.pomodoroFocus = () => null;
  view.openAnalyticsDay = (date) => opened.push(date);
  const parent = element();
  view.renderTodayStrip(parent, { currentStreak: streak }, entitled);
  return { parent, opened };
}
const record = { contribution: { score: 4.4, wordsAdded: 88 }, activity: { focusMinutes: 25 } };

test('今天条显示今天的分数和数据，点开跳到今天明细', () => {
  const { parent, opened } = strip({ record });
  const text = textOf(parent);
  for (const part of ['今天', '4.4', '88', '25', '连续 3 天']) assert.ok(text.includes(part), `${part} in ${text}`);
  all(parent).find((n) => n.tag === 'button').handlers.click();
  assert.deepEqual(opened, [Pulse.dashboardHelpers.todayKey()]);
});

test('今天没有数据时说还没开始，不显示 0 分', () => {
  const text = textOf(strip({ record: null, streak: 0 }).parent);
  assert.ok(text.includes('还没开始'));
  assert.ok(!text.includes('0 分'));
});

test('未激活只显示分数和连续，不多放开当天明细', () => {
  const { parent } = strip({ record, entitled: false });
  const text = textOf(parent);
  assert.ok(text.includes('4.4') && text.includes('连续 3 天'));
  assert.ok(!text.includes('88') && !text.includes('25 '));
});

test('摘要行只在确实集中时才说主要在哪个目录', () => {
  const { heatDayFolder } = Pulse.dashboardHelpers;
  assert.equal(heatDayFolder({ 'Topics/a/x/1.md': { wordsAdded: 80 }, 'Topics/a/y.md': { wordsAdded: 20 }, 'Core/z.md': { wordsAdded: 10 } }), 'Topics/a');
  assert.equal(heatDayFolder({ 'Topics/a/1.md': { wordsAdded: 50 }, 'Core/b/2.md': { wordsAdded: 50 }, 'Now/c/3.md': { wordsAdded: 50 } }), null, '没有过半的目录');
  assert.equal(heatDayFolder({ 'root.md': { wordsAdded: 90 } }), null, '库根目录不算');
  assert.equal(heatDayFolder({ 'Topics/a/1.md': { wordsAdded: 0 } }), null);
  assert.equal(heatDayFolder(undefined), null);
});

test('摘要行区分有记录、未记录和不在范围', () => {
  const { heatDaySummary } = Pulse.dashboardHelpers;
  const rec = { quality: 'recorded', contribution: { score: 86, wordsAdded: 1200 }, activity: { focusMinutes: 25 }, files: { 'Topics/a/1.md': { wordsAdded: 1200 } } };
  const full = heatDaySummary('2026-10-05', rec, { inRange: true, included: true });
  for (const part of ['10月5日', '贡献 86 分', '新增 1,200 词', '专注 25 分钟', '主要在 Topics/a']) assert.ok(full.includes(part), `${part} in ${full}`);
  assert.ok(heatDaySummary('2026-10-05', null, { inRange: true, included: true }).includes('未记录'));
  assert.ok(heatDaySummary('2026-10-05', { ...rec, quality: 'none' }, { inRange: true, included: true }).includes('未记录'));
  assert.ok(heatDaySummary('2026-10-05', rec, { inRange: true, included: false }).includes('不在当前数据范围'));
  assert.ok(heatDaySummary('2026-10-05', rec, { inRange: false, included: true }).includes('统计区间外'));
});

test('标题总量跟着指标变，只算范围内且符合口径的日子', () => {
  const { heatMetricSummary } = Pulse.dashboardHelpers;
  const daily = { a: { contribution: { score: 10.5, wordsAdded: 13023 }, activity: { activeMinutes: 90 } }, b: { contribution: { score: 2, wordsAdded: 7 } }, c: { contribution: { score: 99, wordsAdded: 99 } } };
  const dates = ['a', 'b', 'missing'];
  assert.equal(heatMetricSummary(daily, dates, () => true, 'words'), '新增 13,030 词');
  assert.equal(heatMetricSummary(daily, dates, () => true, 'contribution'), '贡献 12.5 分');
  assert.equal(heatMetricSummary(daily, dates, () => true, 'activity'), '交互 1.5 小时');
  assert.equal(heatMetricSummary(daily, dates, (_, key) => key === 'b', 'words'), '新增 7 词');
});

test('方向键跨周连续移动，Home/End 跳到首尾', () => {
  const { heatMoveTarget } = Pulse.dashboardHelpers;
  const at = (...args) => ({ ...heatMoveTarget(...args) });
  assert.deepEqual(at('ArrowUp', 3, 0), { week: 2, day: 6 });
  assert.deepEqual(at('ArrowDown', 3, 6), { week: 4, day: 0 });
  assert.deepEqual(at('ArrowUp', 3, 2), { week: 3, day: 1 });
  assert.deepEqual(at('ArrowLeft', 3, 2), { week: 2, day: 2 });
  assert.deepEqual(at('Home', 3, 2), { edge: 'first' });
  assert.deepEqual(at('End', 3, 2), { edge: 'last' });
  assert.equal(heatMoveTarget('a', 3, 2), null);
});

test('今天条的入口只有图标，读屏仍能读到名称', () => {
  const button = all(strip({ record }).parent).find((n) => n.tag === 'button');
  assert.equal(button.text, '');
  assert.equal(button.attrs['aria-label'], '看明细');
  assert.ok(button.innerHTML.includes('<svg'));
});
