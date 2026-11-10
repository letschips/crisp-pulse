// 当日专注轨迹：一条按任务分段的占比条 + 每段专注落在当天时间轴上的位置。
// 容易出错的地方：中断的被算进专注时长、任务改名后拆成两段、跨零点的条画出界、
// 任务太多时配色用完、正在进行的番茄被当成已完成。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load() {
  class Plugin {}
  const el = () => ({ createEl: el, createDiv: el, createSpan: el, setAttr() {}, addEventListener() {}, style: {} });
  const context = {
    require: () => ({ Plugin, ItemView: class {}, Setting: class {}, PluginSettingTab: class {}, Notice: class {}, TFile: class {}, Modal: class {}, setIcon() {}, addIcon() {}, moment: { locale: () => 'zh-cn' }, normalizePath: (p) => p, Platform: {}, requestUrl: async () => ({}) }),
    module: { exports: {} }, console, window: { setTimeout, clearTimeout, setInterval, clearInterval, localStorage: { getItem: () => 'zh' } }, document: { createElement: el }, localStorage: { getItem: () => 'zh' }, navigator: { language: 'zh-CN' },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8'), context);
  return context.module.exports;
}
const { buildFocusTrace } = load().dashboardHelpers;
const plain = (v) => JSON.parse(JSON.stringify(v));
const s = (at, minutes, extra = {}) => ({ at, minutes, completed: true, pomodoro: true, note: null, ...extra });

test('没有专注记录、也没有正在进行的专注时不画', () => {
  assert.equal(buildFocusTrace([]), null);
  assert.equal(buildFocusTrace(undefined), null);
  assert.equal(buildFocusTrace([{ at: 'bad', minutes: 25 }]), null);
});

test('占比条按任务合计完成的分钟，中断的单独一段、不进专注时长', () => {
  const trace = buildFocusTrace([
    s('09:10', 25, { taskId: 'a', taskTitle: '写稿' }),
    s('09:40', 25, { taskId: 'a', taskTitle: '写稿' }),
    s('10:30', 25, { taskId: 'b', taskTitle: '修 bug' }),
    s('11:00', 12, { taskId: 'b', taskTitle: '修 bug', completed: false }),
    s('14:00', 20, { pomodoro: false }),
  ]);
  assert.equal(trace.total, 95);
  assert.equal(trace.interrupted, 12);
  assert.deepEqual(plain(trace.segments.map((g) => [g.kind, g.title, g.minutes, g.color])), [
    ['task', '写稿', 50, 'orange'], ['task', '修 bug', 25, 'blue'], ['single', '', 20, 'teal'], ['interrupted', '', 12, 'gray'],
  ]);
  assert.equal(trace.lead.title, '写稿', '过半的任务才算「大半」');
  // 每行的颜色跟它所属任务在占比条里的颜色一致；中断的行沿用任务色、另标 hatched
  assert.deepEqual(plain(trace.rows.map((r) => [r.start, r.end, r.color, r.interrupted])), [
    [550, 575, 'orange', false], [580, 605, 'orange', false], [630, 655, 'blue', false], [660, 672, 'blue', true], [840, 860, 'teal', false],
  ]);
});

test('没有哪个任务过半时不说「大半」；只有未关联任务时也不说', () => {
  const even = buildFocusTrace([s('09:00', 25, { taskId: 'a', taskTitle: 'A' }), s('10:00', 25, { taskId: 'b', taskTitle: 'B' })]);
  assert.equal(even.lead, null);
  assert.equal(buildFocusTrace([s('09:00', 25)]).lead, null);
});

test('时间轴取整到小时，至少一小时，跨零点不出界', () => {
  const one = buildFocusTrace([s('09:10', 25)]);
  assert.deepEqual([one.from, one.to], [540, 600]);
  const exact = buildFocusTrace([s('09:00', 60)]);
  assert.deepEqual([exact.from, exact.to], [540, 600]);
  const late = buildFocusTrace([s('23:50', 45)]);
  assert.deepEqual([late.from, late.to], [1380, 1440]);
  assert.equal(late.rows[0].end, 1440, '结束时刻封顶在当天 24:00');
  const spread = buildFocusTrace([s('08:20', 25), s('21:30', 50)]);
  assert.deepEqual([spread.from, spread.to], [480, 1380]);
});

test('任务改名后仍是同一段，用最新的名字；行按开始时刻排', () => {
  const trace = buildFocusTrace([
    s('15:00', 25, { taskId: 'a', taskTitle: '新名字' }),
    s('09:00', 25, { taskId: 'a', taskTitle: '旧名字' }),
  ]);
  assert.equal(trace.segments.length, 1);
  assert.equal(trace.segments[0].title, '新名字');
  assert.deepEqual(plain(trace.rows.map((r) => r.start)), [540, 900]);
});

test('超过四件事时，其余并成一段灰色，行也用灰色', () => {
  const trace = buildFocusTrace(['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => s(`${String(9 + i).padStart(2, '0')}:00`, 30 - i, { taskId: id, taskTitle: id.toUpperCase() })));
  assert.deepEqual(plain(trace.segments.map((g) => [g.kind, g.title, g.minutes, g.color, g.count || 0])), [
    ['task', 'A', 30, 'orange', 0], ['task', 'B', 29, 'blue', 0], ['task', 'C', 28, 'teal', 0], ['task', 'D', 27, 'purple', 0], ['rest', '', 51, 'gray', 2],
  ]);
  assert.deepEqual(plain(trace.rows.map((r) => r.color)), ['orange', 'blue', 'teal', 'purple', 'gray', 'gray']);
});

test('只有中断时没有专注时长，中断的行是灰色', () => {
  const trace = buildFocusTrace([s('09:00', 8, { completed: false })]);
  assert.equal(trace.total, 0);
  assert.deepEqual(plain(trace.segments.map((g) => [g.kind, g.minutes])), [['interrupted', 8]]);
  assert.equal(trace.rows[0].color, 'gray');
});

test('正在进行的专注排在最后，轴延到计划结束，不算进已完成的时长', () => {
  const trace = buildFocusTrace([s('09:00', 25, { taskId: 'a', taskTitle: '写稿' })], { start: 650, elapsed: 10, planned: 25, taskId: 'a', taskTitle: '写稿', pomodoro: true });
  assert.equal(trace.total, 25);
  assert.deepEqual([trace.from, trace.to], [540, 720]);
  const live = trace.rows.at(-1);
  assert.deepEqual(plain([live.live, live.start, live.end, live.plannedEnd, live.color]), [true, 650, 660, 675, 'orange']);
  assert.equal(trace.now, 660);
  // 只有正在进行的一段时也能画
  const only = buildFocusTrace([], { start: 650, elapsed: 3, planned: 25, pomodoro: true });
  assert.equal(only.total, 0);
  assert.equal(only.rows.length, 1);
  assert.deepEqual(plain(only.segments), []);
});

test('占比条按先后排：专注之间不超过一小时的空当算休息，更长的只留断点', () => {
  const trace = buildFocusTrace([s('09:00', 25), s('09:30', 25), s('10:44', 25), s('13:00', 25, { completed: false })]);
  assert.deepEqual(plain(trace.strip.map((x) => [x.kind, x.minutes, x.color])), [
    ['focus', 25, 'orange'], ['rest', 5, 'green'], ['focus', 25, 'orange'], ['rest', 49, 'green'], ['focus', 25, 'orange'], ['away', 111, 'gray'], ['interrupted', 25, 'orange'],
  ]);
  assert.equal(trace.rest, 54);
  assert.equal(trace.total, 75, '休息不算进专注时长');
  // 正在进行的一段接在最后，前面的空当照样算休息
  const live = buildFocusTrace([s('09:00', 25)], { start: 570, elapsed: 4, planned: 25, pomodoro: true });
  assert.deepEqual(plain(live.strip.map((x) => [x.kind, x.minutes])), [['focus', 25], ['rest', 5], ['live', 4]]);
});

test('没关联任务时按专注时开着的笔记分组，名字取文件名', () => {
  const trace = buildFocusTrace([
    s('09:00', 25, { note: 'Topics/a/写作稿.md' }), s('09:30', 25, { note: 'Topics/a/写作稿.md' }),
    s('10:00', 25, { note: 'b.md', taskId: 't', taskTitle: '任务优先' }), s('11:00', 25),
  ]);
  assert.deepEqual(plain(trace.segments.map((g) => [g.kind, g.title, g.minutes, g.color])), [
    ['note', '写作稿', 50, 'orange'], ['task', '任务优先', 25, 'blue'], ['pomodoro', '', 25, 'teal'],
  ]);
  assert.equal(trace.lead, null, '正好一半不算大半');
  assert.equal(buildFocusTrace([s('09:00', 25, { note: 'x/稿.md' })]).lead.title, '稿');
});

test('跨零点的专注：分钟照旧整段计入，时间轴上只画零点之后的部分', () => {
  const trace = buildFocusTrace([s('00:00', 25, { carry: 20 }), s('00:10', 25)]);
  assert.deepEqual(plain(trace.rows.map((r) => [r.start, r.end])), [[0, 5], [10, 35]]);
  assert.equal(trace.total, 50);
  assert.deepEqual(plain(trace.strip.map((x) => [x.kind, x.minutes])), [['focus', 5], ['rest', 5], ['focus', 25]]);
});
