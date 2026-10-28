/* 顶部天空和底部地平线的画风。失败模式：
   - 拆出画风接口后，像素风不再走原来的绘制函数（画面悄悄变了）。
   - 水墨精灵的尺寸、吃水线和像素精灵对不上，船、鸭子、纸船停的位置跟着错。
   - 水墨山脊没画在 groundRidgeRow 那一行，悬停提示和山对不齐。
   - 每分钟重画天体时水墨画布越画越大。
   - 设置里存了不认识的画风，看板报错；一键切换不循环。
   - 换了画风，图例还在说城堡、小旗。
   - 像素城市的楼顶没落在 groundRidgeRow 那一行，或者分楼时一天对不上一栋。
   - 样式表还没生效时地面高度由画布撑开：高分辨率画风每次重画都把画布放大，越画越大直到内存不够。
   - 像素城市沿用山脊的跨日平滑：孤立的高分日被压矮、一段连续略低分的日子反而更高，峰值塔不是最高；悬停提示指着加高前的楼顶。
   - 像素城市里历史峰值塔和普通楼也亮红灯，「楼顶红灯是今天」不唯一。
   - 像素城市的江岸比湖面、水墨低，楼群和地标正好落在看板工具栏后面：夜里亮窗透过标签文字，电视塔压在菜单按钮上。
     江岸抬到和另外两种画风同一行时，地标不能顶出天空。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const context = {
  require: () => ({ Plugin: class {}, TFile: class {}, ItemView: class {}, PluginSettingTab: class {}, Setting: class {}, Modal: class {}, Notice: class {}, addIcon() {} }),
  module: { exports: {} }, console, Date, window: { setTimeout, clearTimeout, devicePixelRatio: 2 }, document: {}, setTimeout, clearTimeout, structuredClone, crypto: globalThis.crypto, TextEncoder, TextDecoder, Buffer, atob,
};
vm.runInNewContext(`${fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8')}
module.exports.F = { groundDayLevels: typeof groundDayLevels === 'function' ? groundDayLevels : null, pulseScene, nextPulseScene, PULSE_SCENE_IDS, paintPulseSky, paintCelestial, paintPulseGround, paintPulseVoyager, paintPulseLantern, paintPulseBird, paintPulseMeteor, paintPulseRainbow,
  pulseVoyagerSprite, buildGroundProfile, groundDayX, groundRidgeRow, PULSE_CELESTIAL_SIZE, validateAndRepairStore, CrispPulseView, inkResolution };`, context);
const F = context.module.exports.F;

function canvas(w = 0, h = 0) {
  const c = { width: w, height: h, img: null, isConnected: true };
  c.getContext = () => ({ createImageData: (W, H) => ({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4) }), putImageData: (img) => { c.img = img; } });
  return c;
}
const alphaAt = (c, x, y) => c.img.data[(y * c.img.width + x) * 4 + 3];

test('the pixel scene is exactly the original painters', () => {
  const s = F.pulseScene('pixel');
  assert.equal(s.paintGround, F.paintPulseGround);
  assert.equal(s.paintVoyager, F.paintPulseVoyager);
  assert.equal(s.paintCelestial, F.paintCelestial);
  assert.equal(s.paintLantern, F.paintPulseLantern);
  assert.equal(s.paintBird, F.paintPulseBird);
  assert.equal(s.paintMeteor, F.paintPulseMeteor);
  assert.equal(s.paintCelebration, F.paintPulseRainbow);
  const a = canvas(900, 112), b = canvas(900, 112);
  s.paintSky(a, 'day', 'cloudy', 'winter'); F.paintPulseSky(b, 'day', 7, 'cloudy', 'winter');
  assert.deepEqual(a.img.data, b.img.data, '天空和原来的种子、参数一致');
  assert.equal(F.pulseScene('nope'), s, '不认识的画风回到像素');
});

test('city sprites keep the pixel sprites’ size and waterline', () => {
  const city = F.pulseScene('city');
  for (const [kind, n] of [['boat', 0], ['duck', 0], ['family', 4], ['harbor', 3], ['paper', 5]]) {
    const sprite = F.pulseVoyagerSprite(kind, n);
    const c = canvas(), size = city.paintVoyager(c, sprite, 'night');
    assert.deepEqual({ ...size }, { ...F.paintPulseVoyager(canvas(), sprite, 'day') }, `${kind} 逻辑尺寸和吃水线一致`);
    assert.equal(c.width, size.w); assert.equal(c.height, size.h);
  }
  assert.deepEqual({ ...city.paintLantern(canvas(), 'day') }, { ...F.paintPulseLantern(canvas(), 'day') }, '无人机灯和孔明灯一样大');
});

test('each city building tops out on the row the hover tip points at', () => {
  const w = 300, h = 92, n = 40, values = Array.from({ length: n }, (_, i) => 10 + (i % 5) * 20);
  const profile = F.buildGroundProfile(values, w);
  for (const mode of ['day', 'night']) {
    const c = canvas(w, h);
    F.pulseScene('city').paintGround(c, mode, profile, F.groundDayX(n - 1, n, w), { weather: 'clear', days: n });
    const px = (x, y) => [...c.img.data.slice((y * w + x) * 4, (y * w + x) * 4 + 3)];
    for (const i of [5, 17, 28]) {
      // 取楼的左边那一列：不开窗、不立天线
      const x = F.groundDayX(i, n, w), row = Math.round(F.groundRidgeRow(h, profile[x])), edge = Math.round(i * (w - 10) / n);
      // 楼顶紧挨着的上一行（天或远处的楼影）和下一行（楼面）明显不同
      const sky = px(edge, row - 1), wall = px(edge, row + 1);
      assert.ok(Math.abs(sky[0] - wall[0]) + Math.abs(sky[1] - wall[1]) + Math.abs(sky[2] - wall[2]) > 40, `${mode} 第 ${i} 天：楼顶上面是天、下面是楼`);
    }
  }
});

test('ink sprites keep the pixel sprites’ size and waterline', () => {
  const ink = F.pulseScene('ink'), R = F.inkResolution();
  for (const [kind, n] of [['boat', 0], ['duck', 0], ['family', 4], ['harbor', 3], ['paper', 5]]) {
    const sprite = F.pulseVoyagerSprite(kind, n);
    const px = F.paintPulseVoyager(canvas(), sprite, 'day');
    const c = canvas(), size = ink.paintVoyager(c, sprite, 'night');
    assert.deepEqual({ ...size }, { ...px }, `${kind} 逻辑尺寸和吃水线一致`);
    assert.equal(c.width, size.w * R); assert.equal(c.height, size.h * R);
    assert.ok(c.img.data.some((v, i) => i % 4 === 3 && v > 200), `${kind} 画出了东西`);
  }
  for (const mode of ['day', 'night']) {
    assert.deepEqual({ ...ink.paintBird(canvas(), mode) }, { ...F.pulseScene('pixel').paintBird(canvas(), mode) });
    assert.deepEqual({ ...ink.paintLantern(canvas(), mode) }, { ...F.pulseScene('pixel').paintLantern(canvas(), mode) });
  }
});

test('the ink ridge sits on the same row the hover tip points at', () => {
  const w = 300, h = 92, values = Array.from({ length: 40 }, (_, i) => 10 + (i % 5) * 20);
  const profile = F.buildGroundProfile(values, w);
  const c = canvas(w, h);
  F.pulseScene('ink').paintGround(c, 'day', profile, F.groundDayX(39, 40, w), { weather: 'clear' });
  const R = c.width / w;
  for (const i of [5, 17, 28]) {
    const x = F.groundDayX(i, 40, w), row = F.groundRidgeRow(h, profile[x]);
    const px = Math.round((x + 0.5) * R);
    assert.ok(alphaAt(c, px, Math.round((row + 1.5) * R)) > alphaAt(c, px, Math.round((row - 3) * R)) + 60, `第 ${i} 天山脊下面是墨、上面是天`);
  }
});

test('repainting the ink sun or moon does not grow the canvas', () => {
  const c = canvas(F.PULSE_CELESTIAL_SIZE, F.PULSE_CELESTIAL_SIZE);
  F.pulseScene('ink').paintCelestial(c, 'night', 0.3);
  const first = c.width;
  F.pulseScene('ink').paintCelestial(c, 'night', 0.31);
  assert.equal(c.width, first);
});

test('unknown stored styles fall back and the switch cycles through every style', () => {
  const { store } = F.validateAndRepairStore({ settings: { sceneStyle: 'watercolor' } });
  assert.equal(store.settings.sceneStyle, 'pixel');
  assert.equal(F.validateAndRepairStore({ settings: { sceneStyle: 'ink' } }).store.settings.sceneStyle, 'ink');
  const seen = []; let id = 'pixel';
  for (let i = 0; i < F.PULSE_SCENE_IDS.length; i++) { seen.push(id); id = F.nextPulseScene(id); }
  assert.equal(id, 'pixel', '转一圈回到像素');
  assert.deepEqual([...seen].sort(), [...F.PULSE_SCENE_IDS].sort());
  assert.equal(F.nextPulseScene(undefined), F.nextPulseScene('pixel'));
});

test('the legend names what the current style draws', () => {
  const today = new Date(), key = (n) => { const t = new Date(today); t.setDate(t.getDate() - n); return t.toISOString().slice(0, 10); };
  const daily = Object.fromEntries([0, 1, 2, 4].map((n) => [key(n), { contribution: { score: 20 + n * 10 }, activity: { focusSessions: [] }, words: 10 }]));
  const legendFor = (sceneStyle) => {
    const v = Object.create(F.CrispPulseView.prototype);
    v.containerEl = { ownerDocument: { body: { classList: { contains: () => false } } } };
    v.currentScope = 'all';
    v.plugin = { store: { daily }, settings: { sceneStyle }, recordMatchesScope: () => true };
    v.updateVoyage = () => null; v.queueCelebration = () => {}; v.updatePaperBoats = async () => {}; v.checkLanterns = async () => {};
    const caption = { attrs: {}, setText() {}, setAttr(k, val) { this.attrs[k] = val; }, removeAttribute() {}, toggleClass() {}, hasClass() { return false; } };
    v.footerEls = { canvas: canvas(), ground: { getBoundingClientRect: () => ({ width: 600, height: 184 }) }, caption, locked: false };
    v.paintFooter();
    return caption.attrs['aria-label'];
  };
  const pixel = legendFor('pixel'), ink = legendFor('ink'), city = legendFor('city');
  assert.match(city, /天际线是最近/); assert.match(city, /最高的那栋塔楼/); assert.match(city, /楼顶红灯是今天/); assert.match(city, /行道树/);
  assert.doesNotMatch(city, /城堡|小旗|小石子|山脊/);
  assert.match(pixel, /小城堡/); assert.match(pixel, /小旗是今天/);
  assert.match(ink, /小亭/); assert.match(ink, /红印是今天/); assert.match(ink, /苔点是连续/);
  assert.doesNotMatch(ink, /城堡|小旗|小石子/);
});

test('a footer sized by its own canvas (no stylesheet yet) does not grow without bound', () => {
  for (const sceneStyle of ['pixel', 'ink', 'city']) {
    const c = canvas();
    const v = Object.create(F.CrispPulseView.prototype);
    v.containerEl = { ownerDocument: { body: { classList: { contains: () => false } } } };
    v.currentScope = 'all';
    v.plugin = { store: { daily: {} }, settings: { sceneStyle }, recordMatchesScope: () => true };
    v.updateVoyage = () => null; v.queueCelebration = () => {}; v.updatePaperBoats = async () => {}; v.checkLanterns = async () => {};
    const caption = { setText() {}, setAttr() {}, removeAttribute() {}, toggleClass() {}, hasClass() { return false; } };
    // 没有样式表：画布按自身像素尺寸显示，地面跟着它的高度走
    v.footerEls = { canvas: c, ground: { getBoundingClientRect: () => ({ width: 600, height: c.height || 184 }) }, caption, locked: false };
    for (let i = 0; i < 8; i++) v.paintFooter();
    assert.ok(v.footerData.height <= 120, `${sceneStyle}：重画 8 次后逻辑高度 ${v.footerData.height}，不该一直变大`);
  }
});

/** 按天的分数造一个看板页脚（像素城市），返回视图和画布。scores[0] 是最早一天，最后一个是今天。 */
function cityFooter(scores, { mode = 'day' } = {}) {
  const day = (n) => { const t = new Date(); t.setHours(12, 0, 0, 0); t.setDate(t.getDate() - n); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; };
  const daily = {};
  scores.forEach((score, i) => { daily[day(scores.length - 1 - i)] = { contribution: { score }, activity: { focusSessions: [] }, words: score ? 10 : 0 }; });
  const c = canvas();
  const v = Object.create(F.CrispPulseView.prototype);
  v.containerEl = { ownerDocument: { body: { classList: { contains: (k) => k === 'theme-dark' && mode === 'night' } } } };
  v.currentScope = 'all';
  v.plugin = { store: { daily }, settings: { sceneStyle: 'city' }, recordMatchesScope: () => true };
  v.updateVoyage = () => null; v.queueCelebration = () => {}; v.updatePaperBoats = async () => {}; v.checkLanterns = async () => {};
  const caption = { setText() {}, setAttr() {}, removeAttribute() {}, toggleClass() {}, hasClass() { return false; } };
  v.footerEls = { canvas: c, ground: { getBoundingClientRect: () => ({ width: 940, height: 184 }) }, caption, locked: false };
  v.paintFooter();
  return { v, c };
}

test('city buildings follow each day’s own score and the peak tower is the tallest', () => {
  // 30 天以上的历史：一天孤立的 100 分，一段连续 7 天的 80 分，其余 0 分
  const scores = Array(40).fill(0);
  scores[12] = 100;
  for (let i = 21; i <= 27; i++) scores[i] = 80;
  scores[39] = 5;
  const { v } = cityFooter(scores);
  const d = v.footerData, at = (k) => d.dates.indexOf(d.dates[d.dates.length - scores.length + k]);
  assert.ok(Array.isArray(d.rows) && d.rows.length === d.dates.length, '每天一个提示锚点');
  const peak = at(12), plateau = at(24), beside = at(13);
  assert.ok(d.rows[peak] < d.rows[plateau], `峰值塔（${d.rows[peak]}）要比 80 分的楼（${d.rows[plateau]}）高`);
  assert.equal(d.rows[beside], d.rows[at(5)], '峰值旁边的 0 分日不被相邻高分抬高');
  assert.ok(d.rows[plateau] < d.rows[beside], '80 分的楼比 0 分的高');
});

test('only today’s building wears the red rooftop light in the city', () => {
  const scores = Array(40).fill(20).map((v, i) => v + (i * 37) % 30);
  scores[10] = 200; // 峰值在过去
  const { v, c } = cityFooter(scores, { mode: 'night' });
  const W = c.width, data = c.img.data, reds = [];
  for (let y = 0; y < c.height; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    if (data[o] > 200 && data[o + 1] < 110 && data[o + 2] < 110) reds.push(x);
  }
  const todayX = F.groundDayX(v.footerData.dates.length - 1, v.footerData.dates.length, v.footerData.width);
  assert.ok(reds.length > 0, '今天有红灯');
  assert.ok(reds.every((x) => Math.abs(x - todayX) <= 1), `红灯只在今天那栋楼上（今天 x=${todayX}，红色出现在 ${[...new Set(reds)].join(',')}）`);
});

test('the city skyline stands on the same waterline as the other styles, landmarks inside the sky', () => {
  // 抓 cityLandmarks 的江岸行和它画到的最高一行：函数声明是 vm 上下文的全局属性，替换后天空绘制会走到这里
  const original = context.cityLandmarks;
  let base = null, top = Infinity;
  context.cityLandmarks = (buf, p, b, hash, mode) => {
    base = b;
    const set = buf.set;
    buf.set = (x, y, ...rest) => { top = Math.min(top, y); return set.call(buf, x, y, ...rest); };
    try { return original(buf, p, b, hash, mode); } finally { buf.set = set; }
  };
  try {
    for (const mode of ['day', 'night']) {
      base = null; top = Infinity;
      F.pulseScene('city').paintSky(canvas(900, 112), mode, 'clear', 'summer');
      assert.ok(base !== null, '城市天空画了地标');
      assert.ok(base + 1 <= Math.round(112 * 0.6), `江岸在第 ${base + 1} 行，湖面和水墨在第 ${Math.round(112 * 0.6)} 行`);
      assert.ok(top >= 2, `${mode}：地标顶到第 ${top} 行，顶出了天空`);
    }
  } finally { context.cityLandmarks = original; }
});
