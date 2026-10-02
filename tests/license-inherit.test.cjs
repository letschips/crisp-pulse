// 授权继承回归：库内有多张 Crisp 授权时，必须采用第一张“本地校验通过”的，
// 而不是第一张看起来像授权码的。全部用本地生成的临时密钥，不接触真实卡密，也不联网。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const { generateKeyPairSync, sign, webcrypto } = require("node:crypto");

const PLUGIN_ID = "crisp-pulse";
const pair = generateKeyPairSync("ed25519");
const pem = pair.publicKey.export({ type: "spki", format: "pem" }).toString().trim();

function code(features, extra = {}) {
  const payload = Buffer.from(JSON.stringify({
    product: "Crisp Suite", licenseId: "LOCAL-TEST", userName: "local", expiresAt: "2999-01-01T00:00:00.000Z", features, ...extra,
  })).toString("base64url");
  return `${payload}.${sign(null, Buffer.from(payload), pair.privateKey).toString("base64url")}`;
}
const forged = (features) => `${code(features).split(".")[0]}.${Buffer.alloc(64).toString("base64url")}`;

function load() {
  const mainPath = path.join(__dirname, "..", "main.js");
  const original = fs.readFileSync(mainPath, "utf8");
  const PEM_RE = /`-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----`/;
  assert.ok(PEM_RE.test(original), "main.js 应内置一把公钥");
  const source = `${original.replace(PEM_RE, "`" + pem + "`")}\nglobalThis.__t = { discoverVaultCrispLicense, verifyLicenseCode, CrispPulseLicenseManager, CrispPulseView, PULSE_GATED_FEATURES: typeof PULSE_GATED_FEATURES === "undefined" ? undefined : PULSE_GATED_FEATURES };`;
  const module = { exports: {} };
  const quiet = { log() {}, warn() {}, error() {}, debug() {} };
  const obsidian = new Proxy({
    requestUrl: async () => { throw new Error("no network in tests"); },
    addIcon() {}, setIcon() {}, Platform: {},
  }, { get: (target, key) => (key in target ? target[key] : class {}) });
  const sandbox = {
    module, exports: module.exports, console: quiet, atob, btoa, crypto: webcrypto, TextDecoder, TextEncoder, Buffer,
    setTimeout, clearTimeout, structuredClone,
    require: (name) => (name === "obsidian" ? obsidian : require(name)),
  };
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox, { filename: mainPath });
  return { ...sandbox.__t, PluginClass: module.exports };
}

// 真实目录结构的临时库：entries 为 [插件目录名, data.json 内容或原始字符串]。
function makeVault(t, entries, loaded = {}) {
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), "crisp-inherit-"));
  t.after(() => fs.rmSync(basePath, { recursive: true, force: true }));
  for (const [dir, data] of entries) {
    const pluginDir = path.join(basePath, ".obsidian", "plugins", dir);
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "data.json"), typeof data === "string" ? data : JSON.stringify(data));
  }
  const plugins = Object.fromEntries(Object.entries(loaded).map(([id, licenseCode]) => [id, { settings: { licenseCode } }]));
  return {
    appId: "local-fixture",
    vault: { adapter: { basePath }, configDir: ".obsidian" },
    plugins: { plugins },
    workspace: { getLeavesOfType: () => [] },
  };
}

const lib = load();

test("继承跳过不含本插件权限的单款码，采用后面的全家桶码", async (t) => {
  const good = code(["all"]);
  const app = makeVault(t, [["crisp-annotations", { licenseCode: code(["crisp-focus"]) }], ["crisp-reading-rail", { licenseCode: good }]]);
  assert.equal(await lib.discoverVaultCrispLicense(app), good);
});

test("已加载插件里的不适用码不会挡住磁盘上的可用码", async (t) => {
  const good = code(["crisp-pulse"]);
  const app = makeVault(t, [["crisp-base", { licenseCode: good }]], { "crisp-focus": code(["crisp-focus"]) });
  assert.equal(await lib.discoverVaultCrispLicense(app), good);
});

test("继承跳过伪造签名、已过期的码，损坏的 data.json 不中断扫描", async (t) => {
  const good = code(["all"]);
  const app = makeVault(t, [
    ["crisp-a", { licenseCode: forged(["all"]) }],
    ["crisp-b", "{ this is not json"],
    ["crisp-c", { licenseCode: code(["all"], { expiresAt: "2001-01-01T00:00:00.000Z" }) }],
    ["crisp-d", { settings: { licenseCode: good } }],
  ]);
  assert.equal(await lib.discoverVaultCrispLicense(app), good);
});

test("没有任何可用候选时返回 null，且不把无效码写进设置", async (t) => {
  const app = makeVault(t, [["crisp-a", { licenseCode: forged(["all"]) }], ["crisp-b", { licenseCode: code(["crisp-focus"]) }]]);
  assert.equal(await lib.discoverVaultCrispLicense(app), null);
  const settings = { licenseCode: "" };
  const manager = new lib.CrispPulseLicenseManager(app, settings);
  assert.equal(settings.licenseCode, "", "构造时不得采用未校验的继承码");
  assert.equal(manager.isEntitled(), false, "未校验的继承码不得让状态变为有效");
  const result = await manager.verify();
  assert.equal(result.valid, false);
  assert.equal(settings.licenseCode, "");
});

test("授权管理器在未填码时继承可用码并写入设置", async (t) => {
  const good = code(["all"]);
  const app = makeVault(t, [["crisp-a", { licenseCode: code(["crisp-focus"]) }], ["crisp-z", { licenseCode: good }]]);
  const settings = { licenseCode: "" };
  const manager = new lib.CrispPulseLicenseManager(app, settings);
  const result = await manager.verify();
  assert.equal(result.valid, true, result.reason);
  assert.equal(settings.licenseCode, good);
  assert.equal(manager.isEntitled(), true);
});

test("不扫描自己的 data.json", async (t) => {
  const app = makeVault(t, [[PLUGIN_ID, { licenseCode: code(["all"]) }]]);
  assert.equal(await lib.discoverVaultCrispLicense(app), null);
});

// ---------------------------------------------------------------------------
// 门控与启动时序
// ---------------------------------------------------------------------------
test("授权管理器构造后默认未授权：库内有看起来像授权码的文件也不得先放行", async (t) => {
  const app = makeVault(t, [["crisp-a", { licenseCode: forged(["all"]) }]]);
  const manager = new lib.CrispPulseLicenseManager(app, { licenseCode: forged(["all"]) });
  assert.equal(manager.isEntitled(), false, "未经验签不得授予权限（伪造签名的码只有正确的 product 字段）");
  const result = await manager.initialize();
  assert.equal(result.valid, false);
  assert.equal(manager.isEntitled(), false);
});

test("initialize 只做本地验签，通过后在后台做在线校验", async (t) => {
  const good = code(["all"]);
  const calls = [];
  const verifier = async (c, id, app, win, options = {}) => { calls.push(options.skipOnline === true ? "local" : "online"); return lib.verifyLicenseCode(c, id, app, win, options); };
  const manager = new lib.CrispPulseLicenseManager(makeVault(t, []), { licenseCode: good }, { verifier });
  const result = await manager.initialize();
  assert.equal(result.valid, true, result.reason);
  assert.equal(manager.isEntitled(), true);
  assert.equal(calls[0], "local", "首个校验必须是不联网的本地校验");
  await manager.backgroundVerification;
  assert.deepEqual(calls, ["local", "online"]);
});

test("在线校验明确拒绝（吊销）时收回权限并通知界面", async (t) => {
  const good = code(["all"]);
  const changes = [];
  const verifier = async (c, id, app, win, options = {}) => options.skipOnline
    ? lib.verifyLicenseCode(c, id, app, win, options)
    : { valid: false, reason: "该授权已被吊销，如有疑问请联系卖家" };
  const manager = new lib.CrispPulseLicenseManager(makeVault(t, []), { licenseCode: good }, { verifier, onEntitlementChange: (v) => changes.push(v) });
  await manager.initialize();
  await manager.backgroundVerification;
  assert.equal(manager.isEntitled(), false);
  assert.deepEqual(changes, [true, false], "应依次通知：本地通过 → 在线吊销");
});

test("单款卡不含 Pulse 权限时不授权，权限为 all 或 crisp-pulse 时授权", async (t) => {
  const app = makeVault(t, []);
  for (const [features, expected] of [[["crisp-focus"], false], [["crisp-pulse"], true], [["all"], true]]) {
    const manager = new lib.CrispPulseLicenseManager(app, { licenseCode: code(features) });
    await manager.initialize();
    assert.equal(manager.isEntitled(), expected, JSON.stringify(features));
  }
});

// 视图层：用最小的假 DOM 验证锁定面板，避免依赖真实 Obsidian。
function el() {
  const node = { children: [], dataset: {}, classList: { add() {}, remove() {}, contains: () => false }, attrs: {}, style: {}, listeners: {} };
  node.createDiv = (o = {}) => { const c = el(); c.cls = o.cls; c.text = o.text; node.children.push(c); return c; };
  node.createEl = (tag, o = {}) => { const c = el(); c.tag = tag; c.cls = o.cls; c.text = o.text; node.children.push(c); return c; };
  node.createSpan = node.createEl.bind(null, "span");
  node.setText = (v) => { node.text = v; };
  node.setAttr = (k, v) => { node.attrs[k] = v; };
  node.addEventListener = (type, fn) => { node.listeners[type] = fn; };
  node.empty = () => { node.children = []; };
  return node;
}
const flatten = (n) => [n, ...n.children.flatMap(flatten)];

function makeView(entitled, extra = {}) {
  const opened = [];
  const plugin = {
    settings: { licenseCode: extra.licenseCode || "" }, store: { daily: {} },
    isEntitled: () => entitled, licenseManager: { getStatus: () => extra.status || { valid: false, reason: "尚未验证" } },
    openLicenseSettings: () => opened.push("settings"),
  };
  const view = new lib.CrispPulseView({}, plugin);
  return { view, opened, plugin };
}

test("门控表只包含复盘、数据分析、年度画像和周报，采集、备份、导出不在其中", () => {
  const keys = Object.keys(lib.PULSE_GATED_FEATURES || {}).sort();
  assert.deepEqual(keys, ["analytics", "review", "weeklyReport", "yearly"]);
});

test("未授权时三个进阶标签页显示锁定面板，不渲染任何统计内容", () => {
  for (const tab of ["review", "analytics", "yearly"]) {
    const { view, opened } = makeView(false);
    const wrapper = el();
    view.activeViewTab = tab;
    assert.equal(view.renderGatedTab(wrapper, tab), true, `${tab} 应被锁定`);
    const nodes = flatten(wrapper);
    assert.ok(nodes.some((n) => /需要激活/.test(n.text || "")), `${tab} 应说明需要激活`);
    assert.ok(nodes.some((n) => /照常记录/.test(n.text || "")), "应告知数据仍在记录");
    const button = nodes.find((n) => n.tag === "button");
    assert.ok(button, "应提供前往激活的按钮");
    button.listeners.click();
    assert.deepEqual(opened, ["settings"]);
  }
});

test("已授权时进阶标签页不被锁定；看板视图始终可用", () => {
  for (const tab of ["review", "analytics", "yearly"]) {
    assert.equal(makeView(true).view.renderGatedTab(el(), tab), false, `${tab} 已授权不应锁定`);
  }
  assert.equal(makeView(false).view.renderGatedTab(el(), "dashboard"), false, "看板视图不应被锁定");
});

test("授权码已过期时锁定面板显示具体原因", () => {
  const { view } = makeView(false, { licenseCode: "x.y", status: { valid: false, reason: "授权已于 2026-01-01 到期" } });
  const wrapper = el();
  view.renderGatedTab(wrapper, "analytics");
  assert.ok(flatten(wrapper).some((n) => /授权已于 2026-01-01 到期/.test(n.text || "")));
});

test("周报命令未授权时不输出内容，已授权时放行", async () => {
  const notices = [];
  const Pulse = lib.PluginClass;
  const run = (entitled) => {
    const plugin = Object.create(Pulse.prototype);
    plugin.licenseManager = { isEntitled: () => entitled };
    return plugin;
  };
  const locked = run(false);
  assert.equal(locked.requireEntitlement("weeklyReport"), false);
  assert.equal(run(true).requireEntitlement("weeklyReport"), true);
});
