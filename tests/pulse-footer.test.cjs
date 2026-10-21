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
module.exports.F = { celestialPlacement, lunarPhase, paintCelestial, buildGroundProfile, groundDayCount, groundDayX, paintPulseGround, getTodayKey, reviewDayKey, reviewDayNumber, PULSE_GROUND_MARGIN, CrispPulseView, groundVoyagerSpot, groundLakeTop, PULSE_VOYAGERS, pulseVoyagerSprite, groundHarborSpot, paintPulseRainbow, pulseWeatherFor, groundPaperSpot, pulseSeason };`, context);
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
  v.footerEls = { canvas, ground: { getBoundingClientRect: () => ({ width: 600, height: 120 }) }, caption: { text: null, attrs: {}, classes: new Set(), setText(t) { this.text = t; }, setAttr(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; }, toggleClass(c, on) { if (on) this.classes.add(c); else this.classes.delete(c); }, hasClass(c) { return this.classes.has(c); }, get full() { return this.attrs['aria-label'] ?? this.text; } }, locked };
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
  assert.match(v.footerEls.caption.full, new RegExp(`峰值 ${Number(ago(2).slice(5, 7))}月${Number(ago(2).slice(8))}日`));
  assert.match(v.footerEls.caption.full, /小旗是今天/, '浅色主题下是小旗');
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
  assert.match(v.footerEls.caption.full, /连续 4 天/);
  const broken = footerView({ daily: { [ago(2)]: { quality: 'recorded', contribution: { score: 5 } } } }).v;
  assert.equal(broken.footerData.streak.length, 0, '昨天和今天都没写，连续已经断了');
  assert.doesNotMatch(broken.footerEls.caption.full, /连续/);
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

/* 失败模式：看板重画后页脚说明被重置，但「帆船/小鸭子」那句没再接上。 */
test('the boat note stays in the caption after the footer is repainted', () => {
  const { v } = footerView({ daily: {} });
  v.footerEls.voyager = { isConnected: true, ownerDocument: { hidden: false }, style: { setProperty() {} }, toggleClass() {}, getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} }) };
  v.plugin.settings = { enableCrispFocusSync: true };
  v.pomodoroFocus = () => ({ getPomodoroSnapshot: () => ({ status: 'running', kind: 'break', remainingMs: 60000, plannedMs: 300000 }) });
  v.paintFooter();
  assert.match(v.footerEls.caption.text, /小鸭子/);
  v.paintFooter();
  assert.match(v.footerEls.caption.text, /小鸭子/, '重画后还在');
});

/* 长休的鸭妈妈和岸边的船队。失败模式：
   - 小鸭数量和这一轮的番茄数对不上，或者小鸭和妈妈不在同一条吃水线上（有的飘在空中）；
   - 船队伸出画布、占满湖面，窄面板里把整片湖都停满；
   - 专注的帆船开进停着的船队里，叠在一起看不清。 */
test('the long-break family has one duckling per pomodoro, all on one waterline', () => {
  const fam = F.pulseVoyagerSprite('family', 4);
  const duck = F.PULSE_VOYAGERS.duck, chick = F.PULSE_VOYAGERS.duckling;
  assert.equal(fam.rows[0].length, 4 * (chick.rows[0].length + 1) + duck.rows[0].length);
  assert.ok(fam.rows.every((r) => r.length === fam.rows[0].length));
  const eyes = fam.rows.join('\n').split('e').length - 1;
  assert.equal(eyes, 5, '4 只小鸭 + 鸭妈妈');
  const row = fam.rows[fam.waterline];
  assert.match(row.slice(0, chick.rows[0].length), /\S/, '小鸭的吃水线和妈妈对齐');
  assert.equal(F.pulseVoyagerSprite('family', 30).rows[0].length, F.pulseVoyagerSprite('family', 8).rows[0].length, '小鸭有上限');
});

test('moored boats sit at the right shore inside the canvas, and the sailing boat stops before them', () => {
  for (const [w, h] of [[800, 92], [180, 84]]) {
    const harbor = F.groundHarborSpot(20, w, h);
    const sw = harbor.sprite.rows[0].length;
    assert.ok(harbor.x >= 0 && harbor.x + sw <= w, '船队不出画布');
    assert.ok(sw <= w * 0.4 + 1, `船队不超过湖面四成：${sw}/${w}`);
    assert.ok(harbor.y + harbor.sprite.waterline > F.groundLakeTop(h), '泊船在水里');
    const boat = { w: F.PULSE_VOYAGERS.boat.rows[0].length, h: 11, waterline: 9, depth: 3 };
    const end = F.groundVoyagerSpot(1, w, h, boat, harbor.x - 2);
    assert.ok(end.x + boat.w <= harbor.x, '帆船停在船队前面');
  }
  assert.equal(F.groundHarborSpot(0, 800, 92), null, '没完成番茄就不停船');
});

/* 彩虹：脚落在湖面上、不伸出画布；倒影比天上的淡。 */
test('the rainbow stands on the lake inside the canvas, its reflection fainter', () => {
  let img = null;
  const canvas = { width: 0, height: 0, getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData: (i) => { img = i; } }) };
  const w = 300, h = 92;
  F.paintPulseRainbow(canvas, w, h);
  const lake = F.groundLakeTop(h);
  const alpha = (x, y) => img.data[(y * w + x) * 4 + 3];
  let sky = 0, water = 0, maxSky = 0, maxWater = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const a = alpha(x, y);
    if (!a) continue;
    if (y < lake) { sky++; maxSky = Math.max(maxSky, a); } else { water++; maxWater = Math.max(maxWater, a); }
  }
  assert.ok(sky > 0 && water > 0, '天上有彩虹，湖里有倒影');
  assert.ok(maxWater < maxSky, '倒影更淡');
  assert.ok([...Array(w).keys()].some((x) => alpha(x, lake - 1)), '彩虹的脚落到湖面');
});

/* 天气跟最近 7 天写了几天。失败模式：
   - 今天还没开始写，一早打开就因为「今天没写」掉一档；
   - 档位边界算错（7 天写了 6 天却不是晴）；
   - 起雾的地平线和平常一样，看不出来。 */
test('the weather follows how many of the last 7 days were active', () => {
  const T = 1000;
  const days = (set) => (k) => set.has(k);
  const last = (n, end = T) => new Set(Array.from({ length: n }, (_, i) => end - i));
  assert.deepEqual({ ...F.pulseWeatherFor(days(last(7)), T) }, { level: 'clear', active: 7 });
  assert.equal(F.pulseWeatherFor(days(last(6, T - 1)), T).level, 'clear', '今天还没写：从昨天往前数，不掉档');
  assert.equal(F.pulseWeatherFor(days(last(5)), T).level, 'fair');
  assert.equal(F.pulseWeatherFor(days(last(4)), T).level, 'fair');
  assert.equal(F.pulseWeatherFor(days(last(3)), T).level, 'cloudy');
  assert.equal(F.pulseWeatherFor(days(last(2)), T).level, 'cloudy');
  assert.equal(F.pulseWeatherFor(days(last(1)), T).level, 'fog');
  assert.equal(F.pulseWeatherFor(days(new Set([T - 20])), T).level, 'fog', '7 天以前的不算');
});

test('a foggy horizon looks different from a fair one', () => {
  const paint = (weather) => {
    let img = null;
    const canvas = { width: 200, height: 92, getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData: (i) => { img = i; } }) };
    F.paintPulseGround(canvas, 'day', new Float32Array(200).fill(0.4), 180, { weather });
    return img.data;
  };
  const fair = paint('fair'), fog = paint('fog');
  let changed = 0;
  for (let i = 0; i < fair.length; i += 4) if (fair[i] !== fog[i] || fair[i + 1] !== fog[i + 1] || fair[i + 2] !== fog[i + 2]) changed++;
  assert.ok(changed > fair.length / 4 * 0.3, `起雾要明显：只变了 ${changed} 个像素`);
  assert.deepEqual([...paint('clear')], [...fair], '晴和少云的地平线一样，区别只在天上的云');
});

/* 说明太长会挤成两三行。失败模式：图例又塞回说明；悬停提示里漏了内容；展开后收不回去。 */
test('the caption keeps one sentence; the rest is in the hover legend and expands on click', () => {
  const today = F.getTodayKey();
  const n = F.reviewDayNumber(today);
  const daily = {};
  for (let i = 0; i < 5; i++) daily[F.reviewDayKey(n - i)] = { quality: 'recorded', contribution: { score: 10 + i, notesCreated: 1 }, activity: {} };
  const { v } = footerView({ daily });
  const c = v.footerEls.caption;
  assert.match(c.text, /^山脊是最近 \d+ 天的贡献$/, `说明只留一句：${c.text}`);
  assert.match(c.attrs['aria-label'], /峰值/);
  assert.match(c.attrs['aria-label'], /天气是最近 7 天/);
  assert.equal(c.attrs['data-tooltip-position'], 'top');
  v.footerLegendOpen = true; v.setFooterCaption();
  assert.match(c.text, /峰值/, '点开后全部显示');
  assert.equal(c.attrs['aria-expanded'], 'true');
  v.footerLegendOpen = false; v.setFooterCaption();
  assert.doesNotMatch(c.text, /峰值/, '再点收起');
});

/* 速记的纸船和飞鸟。失败模式：
   - 纸船挤满湖面、伸出画布，或者帆船从纸船身上开过去；
   - 打开看板、重载插件时把今天已有的速记当成「刚记的」，一下飞起一群鸟；
   - 条数变少（转化、删除）也飞鸟；换了一天把昨天的条数当基准。 */
test('paper boats stay at the left shore, and the sailing boat starts after them', () => {
  for (const [w, h] of [[800, 92], [180, 84]]) {
    const spot = F.groundPaperSpot(30, w, h);
    const sw = spot.sprite.rows[0].length;
    assert.ok(spot.x >= 0 && sw <= w * 0.3 + 1, `纸船不超过湖面三成：${sw}/${w}`);
    assert.ok(spot.y + spot.sprite.waterline > F.groundLakeTop(h), '纸船在水里');
    const boat = { w: 14, h: 11, waterline: 9, depth: 3 };
    assert.ok(F.groundVoyagerSpot(0, w, h, boat, w - 4, spot.x + sw + 2).x >= spot.x + sw, '帆船从纸船后面出发');
  }
  assert.equal(F.groundPaperSpot(0, 800, 92), null);
});

test('birds fly only when today’s memo count grows', async () => {
  const { v } = footerView({ daily: {} });
  const flown = [];
  v.releaseBirds = (n) => flown.push(n);
  v.footerEls.paper = { isConnected: true, style: {}, toggleClass() {}, getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} }) };
  let memos = { today: 4, pending: 2 };
  v.plugin.getTodaySnapshot = async () => ({ memos });
  await v.updatePaperBoats();
  assert.deepEqual(flown, [], '第一次读只记下条数');
  memos = { today: 5, pending: 3 };
  await v.updatePaperBoats();
  assert.deepEqual(flown, [1], '记了一条，飞一只');
  memos = { today: 4, pending: 2 };
  await v.updatePaperBoats();
  memos = { today: 12, pending: 2 };
  await v.updatePaperBoats();
  assert.deepEqual(flown, [1, 3], '删了不飞；一次多条最多 3 只');
  v.memoSeen = { date: '2000-01-01', today: 0 };
  await v.updatePaperBoats();
  assert.deepEqual(flown, [1, 3], '换了一天不拿昨天比');
  assert.match(v.footerEls.caption.attrs['aria-label'], /纸船是今天还没处理的 2 条速记/);
});

/* 季节和峰值积雪。失败模式：季节边界错一个月；积雪没落在峰值那天的列上，或者没有峰值时也画雪；换季后树色没变。 */
test('seasons follow the month, and the snow cap sits on the peak day', () => {
  const months = [1, 2, 3, 5, 6, 8, 9, 11, 12].map((m) => F.pulseSeason(new Date(2026, m - 1, 15)));
  assert.deepEqual(months, ['winter', 'winter', 'spring', 'spring', 'summer', 'summer', 'autumn', 'autumn', 'winter']);
  const paint = (opts) => {
    let img = null;
    const canvas = { width: 200, height: 92, getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData: (i) => { img = i; } }) };
    const profile = new Float32Array(200).fill(0.3);
    for (let x = 90; x < 110; x++) profile[x] = 0.9;
    F.paintPulseGround(canvas, 'day', profile, 180, opts);
    return img.data;
  };
  const white = (d, x0, x1) => { let n = 0; for (let y = 0; y < 92; y++) for (let x = x0; x < x1; x++) { const o = (y * 200 + x) * 4; if (d[o] > 235 && d[o + 1] > 235 && d[o + 2] > 235) n++; } return n; };
  const snowy = paint({ peakX: 100 }), plain = paint({});
  assert.ok(white(snowy, 92, 108) > white(plain, 92, 108) + 10, '峰值那几列山顶有雪');
  assert.equal(white(snowy, 0, 60), white(plain, 0, 60), '别处不画雪');
  const autumn = paint({ season: 'autumn' }), summer = paint({});
  assert.notDeepEqual([...autumn], [...summer], '秋天的树色和夏天不一样');
});

/* Tempo 完成任务的孔明灯。失败模式：打开看板就把今天已完成的任务全放一遍；取消、撤销完成（数字变小）也放；
   换了一天拿昨天比；旧版 Tempo 没有接口时报错或乱放。 */
test('lanterns rise only when Tempo’s done-today count grows', async () => {
  const { v } = footerView({ daily: {} });
  const released = [];
  v.releaseLanterns = (n) => released.push(n);
  let done = { date: '2026-10-21', count: 10 };
  v.app = { plugins: { plugins: { 'crisp-tempo': { getCompletedToday: async () => done } } } };
  await v.checkLanterns();
  assert.deepEqual(released, [], '第一次读只记下数字');
  done = { date: '2026-10-21', count: 11 };
  await v.checkLanterns();
  done = { date: '2026-10-21', count: 10 };
  await v.checkLanterns();
  done = { date: '2026-10-21', count: 20 };
  await v.checkLanterns();
  assert.deepEqual(released, [1, 3], '完成一个放一盏；撤销不放；一次最多 3 盏');
  done = { date: '2026-10-22', count: 25 };
  await v.checkLanterns();
  assert.deepEqual(released, [1, 3], '换了一天不拿昨天比');
  assert.match(v.footerEls.caption.attrs['aria-label'], /完成了 25 个任务/);
  v.app.plugins.plugins['crisp-tempo'] = { activateView() {} };
  await v.checkLanterns();
  assert.doesNotMatch(v.footerEls.caption.attrs['aria-label'] || '', /孔明灯/, '旧版 Tempo：不显示也不报错');
});

/* 峰值山尖上的小城堡。失败模式：城堡立在峰值那天的列上、但山尖其实偏了几列，城堡悬空或埋进坡里；
   没有峰值也画城堡。 */
test('the castle stands on the true summit near the peak day', () => {
  const paint = (peakX, todayX = 180) => {
    let img = null;
    const canvas = { width: 200, height: 92, getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData: (i) => { img = i; } }) };
    const profile = new Float32Array(200).fill(0.3);
    for (let x = 96; x < 110; x++) profile[x] = 0.6 + 0.3 * (1 - Math.abs(x - 103) / 7);
    F.paintPulseGround(canvas, 'day', profile, todayX, { peakX });
    return img.data;
  };
  // 屋顶红色像素的平均列：应在山尖 103 附近，而不是传进去的 98
  // 只看左边 160 列：右边今天的小旗也是这种红
  const roofCols = (d) => { const xs = []; for (let y = 0; y < 92; y++) for (let x = 0; x < 160; x++) { const o = (y * 200 + x) * 4; if (d[o] > 140 && d[o + 1] < 90 && d[o + 2] < 80) xs.push(x); } return xs; };
  const xs = roofCols(paint(98));
  assert.ok(xs.length > 6, '画出了城堡屋顶');
  const mid = xs.reduce((a, b) => a + b, 0) / xs.length;
  assert.ok(Math.abs(mid - 103) <= 3, `城堡在山尖上：${mid}`);
  assert.equal(roofCols(paint(-1)).length, 0, '没有峰值就没有城堡');
  const flag = (d) => { let n = 0; for (let y = 0; y < 92; y++) for (let x = 170; x < 190; x++) { const o = (y * 200 + x) * 4; if (d[o] > 180 && d[o + 1] < 100 && d[o + 2] < 90) n++; } return n; };
  assert.ok(flag(paint(98, 180)) > 0, '平时右边有今天的小旗');
});
