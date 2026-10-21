/* 看板页脚的像素地平线。失败模式：
   - 一天的极高分把其余日子压成平地；没有数据时画出乱跳的山。
   - 新用户只有几天数据却画 180 天，几乎全是平地；画布太窄时一天挤不到一列。
   - 未激活时页脚偷偷读统计数据（锁定页不该显示任何统计）。
   - 数据范围（可靠记录等）之外的日子仍然顶高山脊。
   - 「今天」的标记贴着右边被切掉。
   - 连续天数的小石子和看板的「当前连续」口径不一致：范围外的日子没把连续打断，今天还没写就把昨天以前的连续清零。
   - 湖面倒影和顶部的太阳/月亮不在同一列，或者天空换成自定义图片后还在画倒影。 */
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
module.exports.F = { celestialPlacement, lunarPhase, paintCelestial, buildGroundProfile, groundDayCount, groundDayX, paintPulseGround, getTodayKey, reviewDayKey, reviewDayNumber, PULSE_GROUND_MARGIN, CrispPulseView, groundVoyagerSpot, groundLakeTop, PULSE_VOYAGERS };`, context);
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

function footerView({ daily, locked = false, scope = 'reliable', celestial = null, bannerMode = 'day' }) {
  let painted = null;
  const canvas = { isConnected: true, width: 0, height: 0, getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData: (img) => { painted = img; } }) };
  const v = Object.create(F.CrispPulseView.prototype);
  v.containerEl = { ownerDocument: { body: { classList: { contains: () => false } } } };
  v.currentScope = scope;
  v.celestialPosition = celestial;
  v.bannerMode = bannerMode;
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

test('pebbles mark the current streak with the same rules as the streak tile', () => {
  const today = F.getTodayKey();
  const ago = (n) => F.reviewDayKey(F.reviewDayNumber(today) - n);
  const daily = {
    [ago(6)]: { quality: 'recorded', contribution: { score: 30 } },
    [ago(5)]: { quality: 'estimated', contribution: { score: 30 } },
    [ago(4)]: { quality: 'recorded', contribution: { score: 0, meaningfulEdits: 2 } },
    [ago(3)]: { quality: 'recorded', contribution: { score: 12 } },
    [ago(2)]: { quality: 'recorded', contribution: { score: 8 } },
    [ago(1)]: { quality: 'recorded', contribution: { score: 5 } },
  };
  const { v } = footerView({ daily });
  const { dates, streak } = v.footerData;
  assert.deepEqual([...streak.map((i) => dates[i])], [ago(4), ago(3), ago(2), ago(1)], '今天还没写不清零；范围外的那天打断连续；有效编辑也算活跃');
  assert.match(v.footerEls.caption.text, /连续 4 天/);
  const broken = footerView({ daily: { [ago(2)]: { quality: 'recorded', contribution: { score: 5 } } } }).v;
  assert.equal(broken.footerData.streak.length, 0, '昨天和今天都没写，连续已经断了');
  assert.doesNotMatch(broken.footerEls.caption.text, /连续/);
});

function lakeLuminance({ celestial, bannerMode = 'day', at }) {
  const { v, painted } = footerView({ daily: {}, celestial, bannerMode });
  const img = painted(), w = v.footerData.width, h = v.footerData.height;
  let sum = 0;
  for (let y = h - 4; y < h; y++) { const o = (y * w + at(w)) * 4; sum += img.data[o] + img.data[o + 1] + img.data[o + 2]; }
  return sum;
}

test('the lake reflects the sun or moon in the same column as the sky above', () => {
  const sun = { mode: 'day', x: 60, opacity: 1, phase: 0.5 };
  const under = lakeLuminance({ celestial: sun, at: (w) => Math.round(w * 0.6) });
  const aside = lakeLuminance({ celestial: sun, at: (w) => Math.round(w * 0.25) });
  assert.ok(under > aside + 150, `太阳正下方的水面更亮：${under} vs ${aside}`);
  const image = lakeLuminance({ celestial: sun, bannerMode: 'image', at: (w) => Math.round(w * 0.6) });
  assert.ok(image < under - 150, '天空换成自定义图片时不画倒影');
  const newMoon = lakeLuminance({ celestial: { mode: 'night', x: 60, opacity: 1, phase: 0.01 }, at: (w) => Math.round(w * 0.6) });
  assert.ok(newMoon < under - 150, '新月没有倒影');
});

/* 顶部天空的太阳和月亮。失败模式：
   - 太阳/月亮位置不随时间走，或跑出天空（盖住标题、掉到地平线下）。
   - 白天主题深夜、夜间主题白天时乱跳或压到标签栏上，应停在右上角。
   - 月相算反（上弦月亮在左边）或新月时画出一轮满月。 */
test('the sun crosses 6–18 and the moon 18–6, resting at the upper right otherwise', () => {
  const at = (h, m = 0) => new Date(2026, 9, 19, h, m);
  const noon = F.celestialPlacement(at(12), 'day');
  assert.equal(noon.t, 0.5);
  const morning = F.celestialPlacement(at(8), 'day'), evening = F.celestialPlacement(at(16), 'day');
  assert.ok(morning.x < noon.x && noon.x < evening.x, '从左往右走');
  assert.ok(noon.y < morning.y && noon.y < evening.y, '正午最高');
  for (const [h, mode] of [[3, 'day'], [22, 'day'], [9, 'night'], [15, 'night']]) {
    const rest = F.celestialPlacement(at(h), mode);
    assert.deepEqual([rest.t, rest.x, rest.y], [null, 86, 20], `${mode} ${h}:00 不在自己的时段，停在右上角`);
  }
  assert.equal(F.celestialPlacement(at(0), 'night').t, 0.5, '午夜月亮最高');
  assert.ok(Math.abs(F.celestialPlacement(at(21), 'night').t - 0.25) < 1e-9);
  for (let h = 0; h < 24; h++) for (const mode of ['day', 'night']) {
    const { x, y } = F.celestialPlacement(at(h, 30), mode);
    assert.ok(x >= 40 && x <= 94 && y >= 13 && y <= 36, `${mode} ${h}:30 留在天空里：${x},${y}`);
  }
});

test('the moon phase follows the synodic month', () => {
  // 2026-10-10 前后为新月、2026-10-26 前后为满月（容差一天）
  const near = (a, b, tol) => Math.min(Math.abs(a - b), 1 - Math.abs(a - b)) < tol;
  assert.ok(near(F.lunarPhase(new Date(Date.UTC(2026, 9, 10, 16))), 0, 0.04), String(F.lunarPhase(new Date(Date.UTC(2026, 9, 10, 16)))));
  assert.ok(near(F.lunarPhase(new Date(Date.UTC(2026, 9, 26, 4))), 0.5, 0.04), String(F.lunarPhase(new Date(Date.UTC(2026, 9, 26, 4)))));
});

test('pixel moon lights the correct side and a new moon shows only a faint disc', () => {
  const draw = (phase) => {
    const data = new Uint8ClampedArray(25 * 25 * 4);
    const canvas = { width: 25, height: 25, getContext: () => ({ createImageData: (w, h) => ({ data, width: w, height: h }), putImageData() {} }) };
    F.paintCelestial(canvas, 'night', phase);
    const lum = (x, y) => { const o = (y * 25 + x) * 4; return data[o + 3] ? data[o] + data[o + 1] + data[o + 2] : 0; };
    return { left: lum(9, 12), right: lum(15, 12) };
  };
  const waxing = draw(0.25), waning = draw(0.75), full = draw(0.5), fresh = draw(0.01);
  assert.ok(waxing.right > waxing.left + 150, '上弦：右边亮');
  assert.ok(waning.left > waning.right + 150, '下弦：左边亮');
  assert.ok(full.left > 400 && full.right > 400, '满月两边都亮');
  assert.ok(fresh.left < 300 && fresh.right < 300, '新月只有暗盘');
});

/* 番茄钟帆船/小鸭子。失败模式：
   - 进度 0 或 1 时船伸出画布两侧被切掉；船漂在半空或沉到画布外。
   - 两个精灵行宽不一致，画出来是歪的。 */
test('the pomodoro boat and duck stay on the lake and inside the canvas', () => {
  for (const [kind, sprite] of Object.entries(F.PULSE_VOYAGERS)) {
    assert.ok(sprite.rows.every((r) => r.length === sprite.rows[0].length), `${kind} 每行一样宽`);
    const s = { w: sprite.rows[0].length, h: sprite.rows.length, waterline: sprite.waterline, depth: sprite.depth };
    for (const [w, h] of [[300, 92], [900, 92], [160, 84]]) {
      const a = F.groundVoyagerSpot(0, w, h, s), b = F.groundVoyagerSpot(1, w, h, s), mid = F.groundVoyagerSpot(0.5, w, h, s);
      assert.ok(a.x >= 0 && b.x + s.w <= w, `${kind} 两端不出画布`);
      assert.ok(a.x < mid.x && mid.x < b.x, `${kind} 随进度往右走`);
      assert.ok(a.y + s.h <= h, `${kind} 不沉到画布外`);
      assert.ok(a.y + s.waterline > F.groundLakeTop(h), `${kind} 吃水线在湖面里`);
    }
  }
});
