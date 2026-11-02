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
