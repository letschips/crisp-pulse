/* 看板页脚的像素地平线。失败模式：
   - 一天的极高分把其余日子压成平地；没有数据时画出乱跳的山。
   - 新用户只有几天数据却画 180 天，几乎全是平地；画布太窄时一天挤不到一列。
   - 未激活时页脚偷偷读统计数据（锁定页不该显示任何统计）。
   - 数据范围（可靠记录等）之外的日子仍然顶高山脊。
   - 「今天」的标记贴着右边被切掉。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const context = {
  require: () => ({ Plugin: class {}, TFile: class {}, ItemView: class {}, PluginSettingTab: class {}, Setting: class {}, Modal: class {}, Notice: class {}, addIcon() {} }),
  module: { exports: {} }, console, Date, window: { setTimeout, clearTimeout }, document: {}, setTimeout, clearTimeout, structuredClone, crypto: globalThis.crypto, TextEncoder, TextDecoder, Buffer, atob,
};
vm.runInNewContext(`${fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8')}
module.exports.F = { buildGroundProfile, groundDayCount, groundDayX, paintPulseGround, getTodayKey, reviewDayKey, reviewDayNumber, PULSE_GROUND_MARGIN, CrispPulseView };`, context);
const F = context.module.exports.F;

test('one huge day does not flatten the rest; no data stays flat', () => {
  const flat = F.buildGroundProfile([0, 0, 0, 0], 40);
  assert.equal(flat.length, 40);
  assert.ok([...flat].every((v) => v === 0));
  const days = Array(20).fill(20); days[10] = 2000;
  const p = F.buildGroundProfile(days, 200);
  const ordinary = p[F.groundDayX(3, 20, 200)];
  assert.ok(ordinary > 0.08, `普通日子的山脊不能被一天高峰压平：${ordinary}`);
  assert.ok(p[F.groundDayX(10, 20, 200)] > ordinary, '高分那天仍然更高');
});

test('the day range follows the history and the canvas width', () => {
  assert.equal(F.groundDayCount(700, 3), 30, '新用户也画一个月，不是 180 天');
  assert.equal(F.groundDayCount(700, 60), 68);
  assert.equal(F.groundDayCount(700, 1000), 180, '最多 180 天');
  assert.equal(F.groundDayCount(120, 1000), Math.floor((120 - F.PULSE_GROUND_MARGIN) / 3), '窄画布每天至少 3 列');
  const n = 40, w = 300;
  assert.ok(F.groundDayX(n - 1, n, w) <= w - F.PULSE_GROUND_MARGIN, '今天的标记不贴右边');
});

function footerView({ daily, locked = false, scope = 'reliable' }) {
  let painted = null;
  const canvas = { isConnected: true, width: 0, height: 0, getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData: (img) => { painted = img; } }) };
  const v = Object.create(F.CrispPulseView.prototype);
  v.containerEl = { ownerDocument: { body: { classList: { contains: () => false } } } };
  v.currentScope = scope;
  const store = {};
  Object.defineProperty(store, 'daily', { get() { if (locked) throw new Error('未激活时读了统计'); return daily; } });
  v.plugin = { store, recordMatchesScope: (record, key, s) => s === 'all' || record.quality === 'recorded' };
  v.footerEls = { canvas, ground: { getBoundingClientRect: () => ({ width: 600, height: 120 }) }, caption: { text: null, setText(t) { this.text = t; } }, locked };
  v.paintFooter();
  return { v, painted: () => painted };
}

test('a locked view paints only the landscape and never reads statistics', () => {
  const { v, painted } = footerView({ daily: {}, locked: true });
  assert.ok(painted(), '地形照常画');
  assert.equal(v.footerEls.caption.text, '');
  assert.equal(v.footerData.dates.length, 0);
});

test('days outside the selected data scope do not raise the ridge', () => {
  const today = F.getTodayKey();
  const ago = (n) => F.reviewDayKey(F.reviewDayNumber(today) - n);
  const daily = {
    [ago(2)]: { quality: 'recorded', contribution: { score: 40 } },
    [ago(1)]: { quality: 'estimated', contribution: { score: 900 } },
    [today]: { quality: 'recorded', contribution: { score: 10 } },
  };
  const { v } = footerView({ daily });
  const { dates, values } = v.footerData;
  assert.equal(dates.at(-1), today);
  assert.equal(values[dates.indexOf(ago(1))], 0, '可靠记录范围外的那天不算');
  assert.match(v.footerEls.caption.text, new RegExp(`峰值 ${Number(ago(2).slice(5, 7))}月${Number(ago(2).slice(8))}日`));
  assert.match(v.footerEls.caption.text, /小旗是今天/, '浅色主题下是小旗');
  assert.equal(v.footerEls.canvas.height * 2, 120, '画布高度跟显示高度走，像素保持方形');
});
