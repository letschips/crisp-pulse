/* 顶部天空和底部地平线的画风。失败模式：
   - 拆出画风接口后，像素风不再走原来的绘制函数（画面悄悄变了）。
   - 水墨精灵的尺寸、吃水线和像素精灵对不上，船、鸭子、纸船停的位置跟着错。
   - 水墨山脊没画在 groundRidgeRow 那一行，悬停提示和山对不齐。
   - 每分钟重画天体时水墨画布越画越大。
   - 设置里存了不认识的画风，看板报错；一键切换不循环。
   - 换了画风，图例还在说城堡、小旗。
   - 像素城市的楼顶没落在 groundRidgeRow 那一行，或者分楼时一天对不上一栋。
   - 样式表还没生效时地面高度由画布撑开：高分辨率画风每次重画都把画布放大，越画越大直到内存不够。 */
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
module.exports.F = { pulseScene, nextPulseScene, PULSE_SCENE_IDS, paintPulseSky, paintCelestial, paintPulseGround, paintPulseVoyager, paintPulseLantern, paintPulseBird, paintPulseMeteor, paintPulseRainbow,
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
