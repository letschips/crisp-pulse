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
    ['task', 'A', 30, 'orange', 0], ['task', 'B', 29, 'blue', 0], ['task', 'C', 28, 'teal', 0], ['task', 'D', 27, 'purple', 0], ['others', '', 51, 'gray', 2],
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
  // 每一段带起止时刻，专注段带对应的那一行，悬停时各说各的
  assert.deepEqual(plain(trace.strip.map((x) => [x.from, x.to])), [[540, 565], [565, 570], [570, 595], [595, 644], [644, 669], [669, 780], [780, 805]]);
  assert.deepEqual(plain(trace.strip.map((x) => (x.row ? x.row.start : null))), [540, null, 570, null, 644, null, 780]);
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

// 专注归到哪篇笔记：开始时开着的那篇只是兜底，专注期间真动手写得最多的那篇优先。
// 容易出错的地方：打字的事件太密把一篇刷成第一、专注前后的编辑被算进来、系统文件抢走归属、没写字时丢掉兜底。
test('专注归到期间编辑分钟数最多的笔记，按分钟计、只看专注期间', () => {
  const { pushFocusEdit, pickFocusNote } = load().focusNoteHelpers;
  const m = (min) => Date.UTC(2026, 10, 10, 7, min); // 15:00 + min
  const log = [];
  // 演示.md 在 3 个不同的分钟里写过；另一篇一分钟里敲了很多下，只算 1 分钟
  for (const t of [m(1), m(1) + 5000, m(4), m(9)]) pushFocusEdit(log, 'Topics/a/演示.md', t);
  for (let i = 0; i < 50; i++) pushFocusEdit(log, 'Topics/a/别的.md', m(5) + i * 100);
  // 专注之前、之后写的不算；系统文件和非 md 不算
  for (const min of [-30, -20, -10, 40, 41, 42]) pushFocusEdit(log, 'Topics/a/之外.md', m(min));
  for (const min of [2, 3, 6, 7]) pushFocusEdit(log, 'Sidecar/logs/x.md', m(min));
  for (const min of [2, 3, 6, 7]) pushFocusEdit(log, 'Topics/a/图.canvas', m(min));
  assert.equal(log.filter((e) => e.path === 'Topics/a/别的.md').length, 1, '同一分钟同一篇只记一次');
  assert.equal(pickFocusNote(log, m(0), m(25), null), 'Topics/a/演示.md');
  // 没写字就用开始时开着的那篇
  assert.equal(pickFocusNote(log, m(100), m(125), 'Topics/a/开着的.md'), 'Topics/a/开着的.md');
  assert.equal(pickFocusNote(log, m(100), m(125), null), null);
  // 分钟数一样时取最后写的那篇
  const tie = [];
  pushFocusEdit(tie, 'a.md', m(1)); pushFocusEdit(tie, 'b.md', m(2));
  assert.equal(pickFocusNote(tie, m(0), m(25), null), 'b.md');
  // 日志有上限，不会一直涨
  const big = [];
  for (let i = 0; i < 5000; i++) pushFocusEdit(big, `n${i % 7}.md`, m(0) + i * 60000);
  assert.ok(big.length <= 2000);
});

// 审查 2026-11-10：暂停、同一分钟的编辑、重命名。
test('暂停过的专注：时间轴画到真正结束的时刻，暂停单独一段、不算专注也不算休息', () => {
  // 09:00 开始，专注 25 分钟、中间暂停 10 分钟，09:35 结束；09:40 下一段
  const trace = buildFocusTrace([s('09:00', 25, { paused: 10 }), s('09:40', 25)]);
  assert.deepEqual(plain(trace.rows.map((r) => [r.start, r.end])), [[540, 575], [580, 605]]);
  assert.deepEqual(plain(trace.strip.map((x) => [x.kind, x.minutes])), [['focus', 25], ['paused', 10], ['rest', 5], ['focus', 25]]);
  assert.equal(trace.rest, 5, '暂停不算进休息');
  assert.equal(trace.total, 50, '暂停不算进专注');
});

test('正在进行的专注：暂停期间已专注的分钟不涨，条画到现在', () => {
  // 09:00 开始，已专注 10 分钟、暂停到 09:15
  const live = { start: 540, elapsed: 10, wall: 15, planned: 25, pomodoro: true, paused: true };
  const trace = buildFocusTrace([], live);
  const row = trace.rows[0];
  assert.deepEqual(plain([row.start, row.end, row.minutes, row.planned, row.paused]), [540, 555, 10, 25, true]);
  assert.equal(row.plannedEnd, 570, '剩下的 15 分钟接在现在后面');
  // 没有开始时刻（旧版 Focus）时照旧按已专注的分钟画
  const old = buildFocusTrace([], { start: 545, elapsed: 10, planned: 25 }).rows[0];
  assert.deepEqual(plain([old.start, old.end, old.minutes]), [545, 555, 10]);
});

test('同一分钟里的编辑：跨过专注开始也算，平局按真正最后一次编辑', () => {
  const { pushFocusEdit, pickFocusNote } = load().focusNoteHelpers;
  const at = (sec) => Date.UTC(2026, 10, 10, 7, 0, sec);
  const a = [];
  pushFocusEdit(a, 'a.md', at(5)); pushFocusEdit(a, 'a.md', at(45));
  assert.equal(a.length, 1, '同一分钟仍只记一条');
  assert.equal(pickFocusNote(a, at(30), at(30) + 25 * 60000, 'fallback.md'), 'a.md');
  // 只在开始前写过的那一分钟不算
  const before = [];
  pushFocusEdit(before, 'a.md', at(5)); pushFocusEdit(before, 'a.md', at(20));
  assert.equal(pickFocusNote(before, at(30), at(30) + 25 * 60000, 'fallback.md'), 'fallback.md');
  const b = [];
  pushFocusEdit(b, 'a.md', at(5)); pushFocusEdit(b, 'b.md', at(10)); pushFocusEdit(b, 'a.md', at(55));
  assert.equal(pickFocusNote(b, at(0), at(0) + 25 * 60000, null), 'a.md');
});

test('重命名：专注记录和编辑日志里的路径跟着改，整个文件夹也一样', () => {
  const { migrateFocusPaths } = load().focusNoteHelpers;
  const daily = {
    '2026-11-10': { activity: { focusSessions: [s('09:00', 25, { note: 'old.md' }), s('10:00', 25, { note: 'dir/x.md' }), s('11:00', 25, { note: 'other.md' })] } },
    '2026-11-09': { activity: {} },
  };
  const log = [{ path: 'old.md', minute: 1, at: 1, last: 1 }, { path: 'dir/y.md', minute: 2, at: 2, last: 2 }];
  const file = (from, to, isFolder) => (p) => (p === from || (isFolder && p.startsWith(`${from}/`)) ? to + p.slice(from.length) : p);
  assert.equal(migrateFocusPaths(daily, log, file('old.md', 'new.md', false)), true);
  assert.equal(migrateFocusPaths(daily, log, file('dir', 'moved', true)), true);
  assert.deepEqual(plain(daily['2026-11-10'].activity.focusSessions.map((x) => x.note)), ['new.md', 'moved/x.md', 'other.md']);
  assert.deepEqual(plain(log.map((e) => e.path)), ['new.md', 'moved/y.md']);
  assert.equal(migrateFocusPaths(daily, log, file('none.md', 'z.md', false)), false, '没变化就不标脏');
});

test('补记时：这一分钟最后一次编辑在结束之后，不拿结束时刻顶替，平局归结束前真正最后写的那篇', () => {
  const { pushFocusEdit, pickFocusNote } = load().focusNoteHelpers;
  const at = (min, sec) => Date.UTC(2026, 10, 10, 7, min, sec);
  const log = [];
  pushFocusEdit(log, 'a.md', at(0, 5)); pushFocusEdit(log, 'b.md', at(0, 20)); pushFocusEdit(log, 'a.md', at(0, 55));
  assert.equal(pickFocusNote(log, at(0, 30) - 25 * 60000, at(0, 30), null), 'b.md');
});

test('跨零点又暂停过：时间轴画到真正结束的时刻；零点前暂停比专注还长也不多画', () => {
  // 23:50 开始、专注 25 分钟、暂停 10 分钟，00:25 结束
  const a = buildFocusTrace([s('00:00', 25, { carry: 10, paused: 10 })]).rows[0];
  assert.deepEqual(plain([a.start, a.end]), [0, 25]);
  // 23:20 开始，零点前大多在暂停（零点前 40 分钟），专注 25、暂停 40，00:25 结束
  const b = buildFocusTrace([s('00:00', 25, { carry: 40, paused: 40 })]).rows[0];
  assert.deepEqual(plain([b.start, b.end]), [0, 25]);
});

function plugin() {
  const P = load();
  const p = Object.create(P.prototype);
  p.store = { daily: {} }; p.focusEditLog = [];
  p.getOrCreateRecord = (day) => (p.store.daily[day] ||= { files: {}, activity: {} });
  return p;
}

test('记一段跨零点的专注：暂停分钟也存下，零点前的分钟含暂停', () => {
  const p = plugin();
  const start = new Date(2026, 10, 9, 23, 50).getTime(), end = new Date(2026, 10, 10, 0, 25).getTime();
  const saved = p.appendFocusSession({ type: 'complete', plannedMinutes: 25, startedAt: start, at: end, apiVersion: 3, pomodoro: true }, new Date(end));
  const x = saved.record.activity.focusSessions[0];
  assert.deepEqual(plain([x.at, x.minutes, x.carry, x.paused]), ['00:00', 25, 10, 10]);
  assert.equal(buildFocusTrace([x]).rows[0].end, 25);
});

test('开始前的改名不作用到后来同名的新笔记；开始之后的改名照常跟过去', () => {
  const p = plugin();
  const t = (h, m) => new Date(2026, 10, 10, h, m).getTime();
  const rename = (from, to, at) => ({ at, migrate: (x) => (x === from ? to : x) });
  p.focusRenames = [rename('a.md', 'archive.md', t(15, 0))];
  const one = p.appendFocusSession({ type: 'complete', plannedMinutes: 25, startedAt: t(16, 0), at: t(16, 25), notePath: 'a.md', pomodoro: true }, new Date(t(16, 25)));
  assert.equal(one.record.activity.focusSessions[0].note, 'a.md');
  p.focusRenames.push(rename('a.md', 'b.md', t(17, 10)));
  const two = p.appendFocusSession({ type: 'complete', plannedMinutes: 25, startedAt: t(17, 0), at: t(17, 25), notePath: 'a.md', pomodoro: true }, new Date(t(17, 25)));
  assert.equal(two.record.activity.focusSessions[1].note, 'b.md');
});
