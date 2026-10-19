/* ==========================================================================
   Crisp Pulse — Knowledge Work Analytics Plugin for Obsidian
   Crafted for the Crisp Plugin Suite
   ========================================================================== */

const { Plugin, ItemView, Setting, PluginSettingTab, Notice, TFile, Modal, MarkdownRenderer = null, Component = null, AbstractInputSuggest = null, Platform = {}, addIcon = (() => {}), setIcon = (() => {}), Menu = null, moment = null, getLanguage = null } = require("obsidian");

/* 界面语言跟随 Obsidian：中文界面（含繁体）显示中文，其他语言显示英文。Obsidian 改语言要重启，加载时读一次即可。
   旧版（1.8.7 前）没有 getLanguage：读 localStorage 的 language；没存表示跟随系统，和 Obsidian 一样回退 navigator.language。
   只翻译界面和报告；写进库里的东西（速记块、ANKS 采集件、番茄标签、录音和周报文件名）不随语言变化，切换语言后不会分裂成两套。 */
function detectPulseLanguage() {
  try { if (typeof getLanguage === "function") return String(getLanguage() || "en"); } catch (_) { /* 取不到时往下找 */ }
  try {
    const storage = typeof window !== "undefined" ? window.localStorage : null;
    const stored = storage ? storage.getItem("language") : null;
    if (stored) return String(stored);
  } catch (_) { /* 无法访问 localStorage */ }
  try { if (typeof navigator !== "undefined" && navigator.language) return String(navigator.language); } catch (_) { /* 取不到系统语言 */ }
  return "zh"; // 真实环境总有 navigator.language，走到这里只会是测试环境
}
const PULSE_ZH = /^zh\b/i.test(detectPulseLanguage());
const tr = (zh, en) => (PULSE_ZH ? zh : en);
const PULSE_NUMBER_LOCALE = PULSE_ZH ? "zh-CN" : "en-US";
const PULSE_MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** 月份标签：中文「10月」，英文「Oct」。month 从 1 开始。 */
const pulseMonthLabel = (month) => (PULSE_ZH ? `${month}月` : PULSE_MONTHS_EN[(month - 1 + 12) % 12]);
/** 月日：中文「10月18日」，英文「Oct 18」。 */
const pulseMonthDay = (month, day) => (PULSE_ZH ? `${month}月${day}日` : `${PULSE_MONTHS_EN[(month - 1 + 12) % 12]} ${day}`);
/** 英文计数的单复数：plural(1, "day") → "1 day"。中文界面不用。 */
const plural = (n, word, many = `${word}s`) => `${n} ${Number(n) === 1 ? word : many}`;
// 既显示给人看、又在内存里当分组键用的名字：同一次运行里前后一致即可
const PULSE_ROOT_DIR = tr("(根目录)", "(root)");
const PULSE_OTHER_GROUP = tr("其他", "Other");
// 新装时日笔记里速记段落的默认标题；已保存的设置不受影响
const MEMO_DEFAULT_HEADING = tr("## 速记", "## Memos");
// 番茄钟休息时自动加的标签：写进速记正文，不随界面语言变化
const MEMO_POMODORO_TAG = "番茄";
// 速记面板「高级筛选」按钮的标签，渲染后还要按它找回按钮
const MEMO_FILTER_LABEL = tr("高级筛选", "Advanced filters");
const MEMO_DICTATE_LABEL = tr("实时听写（点一下开始，再点结束）", "Live dictation (click to start, click again to stop)");

const VIEW_TYPE_PULSE = "crisp-pulse-view";
// data.json 的跨实例写入队列（同 MEMO_DRAFT_WRITES）：Symbol.for 在插件重载后仍是同一个键
const PULSE_STORE_WRITES = Symbol.for("crisp-pulse.store.writes");

const CRISP_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAiz41HIDpD59SH3DjKnovUO+EEhTJXjvmiug/ev9t4ZQ=
-----END PUBLIC KEY-----`;

const CRISP_LICENSE_PRODUCTS = [
  "Crisp Suite",
  "Crisp Organize",
  "Crisp ASR",
  "Crisp Annotations",
  "Crisp File Explorer",
  "Crisp Focus",
  "Crisp Reading Rail",
  "Crisp Base",
  "Crisp Pulse",
];

function base64UrlToUint8Array(base64url) {
  const base64 = (base64url || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = base64.length % 4;
  const padded = pad ? base64 + "=".repeat(4 - pad) : base64;
  const decodeFn = typeof atob === "function" ? atob : (b64) => (typeof Buffer !== "undefined" ? Buffer.from(b64, "base64").toString("binary") : "");
  const raw = decodeFn(padded);
  const buffer = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    buffer[i] = raw.charCodeAt(i);
  }
  return buffer;
}

function getCryptoSubtle(windowObj = (typeof window !== "undefined" ? window : null)) {
  if (windowObj && windowObj.crypto && windowObj.crypto.subtle) {
    return windowObj.crypto.subtle;
  }
  if (typeof globalThis !== "undefined" && globalThis.crypto && globalThis.crypto.subtle) {
    return globalThis.crypto.subtle;
  }
  try {
    const nodeCrypto = require("crypto");
    if (nodeCrypto && nodeCrypto.webcrypto && nodeCrypto.webcrypto.subtle) {
      return nodeCrypto.webcrypto.subtle;
    }
  } catch (e) {}
  return null;
}

async function importEd25519PublicKey(pem, windowObj = null) {
  const subtle = getCryptoSubtle(windowObj);
  if (!subtle) {
    throw new Error(tr("当前环境不支持 WebCrypto Ed25519", "This environment does not support WebCrypto Ed25519"));
  }
  const pemContents = pem
    .replace("-----BEGIN PUBLIC KEY-----", "")
    .replace("-----END PUBLIC KEY-----", "")
    .replace(/\s/g, "");
  const der = base64UrlToUint8Array(pemContents);
  return await subtle.importKey(
    "spki",
    der.buffer,
    { name: "Ed25519" },
    true,
    ["verify"]
  );
}

// 库内其它 Crisp 插件保存的授权码，按「已加载插件 → 磁盘 data.json」顺序去重收集（不含 Pulse 自己）。
function collectVaultCrispLicenseCandidates(app) {
  if (!app) return [];
  const seen = new Set();
  const candidates = [];
  const add = (code) => {
    if (typeof code !== "string") return;
    const trimmed = code.trim();
    if (!trimmed.includes(".") || seen.has(trimmed)) return;
    seen.add(trimmed);
    candidates.push(trimmed);
  };
  for (const [pid, instance] of Object.entries(app.plugins?.plugins || {})) {
    if (pid.startsWith("crisp-") && pid !== "crisp-pulse") add(instance?.settings?.licenseCode);
  }
  try {
    const pathMod = typeof require === "function" ? require("path") : null;
    const fsMod = typeof require === "function" ? require("fs") : null;
    if (pathMod && fsMod) {
      const basePath = app.vault?.adapter?.basePath || (app.vault?.adapter?.getBasePath ? app.vault.adapter.getBasePath() : "");
      const configDir = app.vault?.configDir || ".obsidian";
      const pluginsDir = basePath ? pathMod.join(basePath, configDir, "plugins") : "";
      if (pluginsDir && fsMod.existsSync(pluginsDir)) {
        for (const d of fsMod.readdirSync(pluginsDir)) {
          if (!d.startsWith("crisp-") || d === "crisp-pulse") continue;
          const dataPath = pathMod.join(pluginsDir, d, "data.json");
          if (!fsMod.existsSync(dataPath)) continue;
          try {
            const data = JSON.parse(fsMod.readFileSync(dataPath, "utf-8"));
            add(data?.licenseCode || data?.settings?.licenseCode);
          } catch (e) {
            // 单个损坏的 data.json 不影响其余候选
          }
        }
      }
    }
  } catch (e) {}
  return candidates;
}

// 返回一张对本插件确实可用的授权码，找不到则返回 null。候选只做本地校验（不增加在线请求），
// 因此作用域不含 Pulse、已过期或签名无效的码不会再挡住后面可用的全家桶码。
async function discoverVaultCrispLicense(app) {
  for (const code of collectVaultCrispLicenseCandidates(app)) {
    const local = await verifyLicenseCode(code, "crisp-pulse", app, null, { skipOnline: true });
    if (local.valid) return code;
  }
  return null;
}

async function verifyLicenseCode(licenseCode, targetPluginId = "crisp-pulse", app = null, windowObj = null, options = {}) {
  const trimmed = (licenseCode || "").trim();
  if (!trimmed) return { valid: false, reason: tr("授权码为空", "License code is empty") };
  const parts = trimmed.split(".");
  if (parts.length !== 2) return { valid: false, reason: tr("授权码格式无效", "Invalid license code format") };
  const [payloadBase64, signatureBase64] = parts;
  try {
    const Decoder = typeof TextDecoder !== "undefined" ? TextDecoder : require("util").TextDecoder;
    const payloadJson = new Decoder().decode(base64UrlToUint8Array(payloadBase64));
    const payload = JSON.parse(payloadJson);
    if (!payload || typeof payload !== "object") {
      return { valid: false, reason: tr("授权数据无效", "Invalid license data") };
    }
    if (!CRISP_LICENSE_PRODUCTS.includes(payload.product)) {
      return { valid: false, reason: tr("授权码不属于 Crisp 系列插件", "This license code is not for Crisp plugins") };
    }
    const features = Array.isArray(payload.features) ? payload.features : [];
    if (!features.includes("all") && !features.includes(targetPluginId)) {
      return { valid: false, reason: tr(`该授权码未包含 ${targetPluginId} 权限`, `This license code does not include ${targetPluginId}`) };
    }
    if (payload.expiresAt) {
      const expiresAt = new Date(payload.expiresAt).getTime();
      if (!Number.isFinite(expiresAt)) {
        return { valid: false, reason: tr("授权到期时间无效", "Invalid license expiry date") };
      }
      if (expiresAt < Date.now()) {
        return { valid: false, reason: tr(`授权已于 ${String(payload.expiresAt).split("T")[0]} 到期`, `License expired on ${String(payload.expiresAt).split("T")[0]}`) };
      }
    }
    const publicKey = await importEd25519PublicKey(CRISP_PUBLIC_KEY_PEM, windowObj);
    const subtle = getCryptoSubtle(windowObj);
    const Encoder = typeof TextEncoder !== "undefined" ? TextEncoder : require("util").TextEncoder;
    const isValid = await subtle.verify(
      "Ed25519",
      publicKey,
      base64UrlToUint8Array(signatureBase64),
      new Encoder().encode(payloadBase64)
    );
    if (!isValid) return { valid: false, reason: tr("授权签名无效", "Invalid license signature") };
    if (options.skipOnline) return { valid: true, payload, message: tr("本地验签通过", "Local signature check passed"), source: "offline" };

    let reqUrl = null;
    try {
      const obsidian = require("obsidian");
      reqUrl = obsidian.requestUrl;
    } catch (e) {}

    if (typeof reqUrl === "function") {
      try {
        const deviceId = app?.appId || (app?.vault?.getName ? "vault-" + encodeURIComponent(app.vault.getName()) : "device-default");
        const res = await Promise.race([
          reqUrl({
            url: "https://license.letschips.xyz/api/verify-device",
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              licenseCode: trimmed,
              deviceId: deviceId,
              action: "activate",
              pluginId: targetPluginId
            }),
            throw: false
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Crisp license check timeout")), 2500))
        ]);

        let cloudResult = null;
        try {
          cloudResult = res.json;
        } catch {
          cloudResult = null;
        }

        const isAuthDenial =
          (res.status === 200 || res.status === 400 || res.status === 401 || res.status === 403) &&
          cloudResult !== null &&
          cloudResult.valid === false;

        if (isAuthDenial) {
          return {
            valid: false,
            reason: cloudResult?.reason || tr("授权已被服务端拒绝或设备数已达上限", "The license was rejected by the server or the device limit was reached")
          };
        }

        if (res.status === 200 && cloudResult && cloudResult.valid === true) {
          return { valid: true, payload, message: cloudResult.message, source: "online" };
        }

        if (res.status >= 400) {
          console.warn(`[Crisp Pulse] License server unavailable (status ${res.status}), offline fallback`);
        }
      } catch (netErr) {
        return { valid: true, payload, message: tr("离线验证成功", "Verified offline"), source: "offline" };
      }
    }

    return { valid: true, payload, message: tr("离线验证成功", "Verified offline"), source: "offline" };
  } catch (e) {
    return { valid: false, reason: tr(`解析授权码失败: ${e.message}`, `Failed to parse license code: ${e.message}`) };
  }
}

// 功能分级。要调整哪些功能需要激活，只改这一张表（以及对应的 requireEntitlement / renderGatedTab 调用点）。
// 固定原则：数据采集、存储、备份、导出与看板视图永不上锁——用户自己的数据始终可读、可带走，
// 未激活期间采集照常进行，激活后能看到完整历史。
const PULSE_GATED_FEATURES = Object.freeze({
  review: tr("知识复盘", "Review"),
  analytics: tr("数据分析", "Analytics"),
  yearly: tr("年度画像", "Year Portrait"),
  weeklyReport: tr("周报复制与归档", "Weekly report copy & archive"),
});

class CrispPulseLicenseManager {
  constructor(app, settings, options = {}) {
    this.app = app;
    this.settings = settings;
    this.verifier = options.verifier || verifyLicenseCode;
    this.now = options.now || (() => Date.now());
    this.windowObj = options.windowObj || (typeof window !== "undefined" ? window : null);
    this.onEntitlementChange = options.onEntitlementChange || (() => {});
    // 一律从「未验证」起步：只有本地验签通过才放行，不凭库内某个文件的 product 字段先授予权限。
    this.status = { valid: false, reason: tr("尚未验证", "Not verified yet") };
    this.verificationId = 0;
    this.backgroundVerification = null;
  }

  isEntitled() {
    return this.status.valid === true;
  }

  getStatus() {
    return this.status;
  }

  async runVerifier(code, options) {
    try {
      return await this.verifier(code, "crisp-pulse", this.app, this.windowObj, options);
    } catch (error) {
      return { valid: false, reason: tr(`授权验证失败: ${error.message || error}`, `License verification failed: ${error.message || error}`) };
    }
  }

  apply(result, code) {
    const wasEntitled = this.isEntitled();
    this.status = result;
    if (result.valid && this.settings) {
      this.settings.licenseCode = code;
      if (result.source === "online") this.settings.licenseLastOnlineAt = this.now();
    }
    if (wasEntitled !== this.isEntitled()) this.onEntitlementChange(this.isEntitled());
  }

  // 启动时调用：只做不联网的本地验签（毫秒级），通过后在线设备校验转入后台。
  async initialize() {
    const id = ++this.verificationId;
    let code = ((this.settings && this.settings.licenseCode) || "").trim();
    if (!code) code = (await discoverVaultCrispLicense(this.app)) || "";
    const result = await this.runVerifier(code, { skipOnline: true });
    if (id !== this.verificationId) return result;
    this.apply(result, code);
    if (result.valid) this.backgroundVerification = this.verify(code);
    return result;
  }

  async verify(code = this.settings?.licenseCode) {
    const id = ++this.verificationId;
    let targetCode = (code || "").trim();
    if (!targetCode) targetCode = (await discoverVaultCrispLicense(this.app)) || "";
    const result = await this.runVerifier(targetCode, {});
    // 更新的校验已经开始：本次结果不再落地，避免旧结果覆盖新状态。
    if (id !== this.verificationId) return result;
    this.apply(result, targetCode);
    return result;
  }
}

function renderAboutCard(container, pluginName, description) {
  const document = container.ownerDocument || (typeof window !== "undefined" ? window.document : null);
  if (!document) return;
  const card = document.createElement("section");
  card.className = "crisp-pulse-about";

  const title = document.createElement("h3");
  title.className = "crisp-pulse-about__title";
  title.textContent = tr(`关于 ${pluginName}`, `About ${pluginName}`);

  const copy = document.createElement("p");
  copy.className = "crisp-pulse-about__description";
  copy.textContent = description;

  const byline = document.createElement("p");
  byline.className = "crisp-pulse-about__author";
  const label = document.createElement("span");
  label.textContent = tr("作者：", "Author: ");
  const author = document.createElement("a");
  author.className = "crisp-pulse-about__author-link";
  author.textContent = tr("小红书 letschips", "letschips on Xiaohongshu (RedNote)");
  author.href = "https://xhslink.cn/m/3MwtKu4822b";
  author.target = "_blank";
  author.rel = "noopener noreferrer";
  byline.append(label, author);

  card.append(title, copy, byline);
  container.append(card);
}

const ICON_COMPUTER_SVG = `<svg viewBox="0 0 281.25 281.25" class="crisp-pulse-breakdown-icon" aria-hidden="true"><g transform="translate(6402.3564,-4296.9987)"><path d="m -6251.0783,4337.2868 a 4.6879687,4.6879687 0 0 0 -4.6875,4.6875 v 128.7945 a 4.6879687,4.6879687 0 0 0 0.9814,2.8674 l 19.4129,25.0965 a 4.6879687,4.6879687 0 0 0 7.4157,0 l 19.4147,-25.0965 a 4.6879687,4.6879687 0 0 0 0.9778,-2.8674 v -128.7945 a 4.6879687,4.6879687 0 0 0 -4.6875,-4.6875 z m 4.6875,9.375 h 29.4525 v 122.5067 l -14.7235,19.0338 -14.729,-19.0357 z m -109.3323,64.0191 a 4.6879687,4.6879687 0 0 0 -4.6875,4.6875 v 117.9053 a 4.6879687,4.6879687 0 0 0 4.6875,4.6875 h 187.9834 a 4.6879687,4.6879687 0 0 0 4.6875,-4.6875 v -117.9053 a 4.6879687,4.6879687 0 0 0 -4.6875,-4.6875 h -21.308 a 4.6875,4.6875 0 0 0 -4.6875,4.6875 4.6875,4.6875 0 0 0 4.6875,4.6875 h 16.6205 v 108.5303 h -178.6084 v -108.5303 h 74.3884 a 4.6875,4.6875 0 0 0 4.6875,-4.6875 4.6875,4.6875 0 0 0 -4.6875,-4.6875 z m 25.0964,78.1293 a 4.6875,4.6875 0 0 0 -4.6875,4.6875 4.6875,4.6875 0 0 0 4.6875,4.6875 h 50.6653 a 4.6875,4.6875 0 0 0 4.6875,-4.6875 4.6875,4.6875 0 0 0 -4.6875,-4.6875 z" fill="currentColor"/></g></svg>`;

const BLOCKS_WAVE_CELLS = [
  [1, 1, 0],
  [8.33, 1, 0.1],
  [1, 8.33, 0.1],
  [15.66, 1, 0.2],
  [8.33, 8.33, 0.2],
  [1, 15.66, 0.2],
  [15.66, 8.33, 0.3],
  [8.33, 15.66, 0.3],
  [15.66, 15.66, 0.4]
];

function buildBlocksWaveSvg(animated, className) {
  const rects = BLOCKS_WAVE_CELLS.map(([x, y, delay]) => {
    let animations = "";
    if (animated) {
      animations = ["x", "y", "width", "height"].map((attributeName) => {
        let values = "7.33;1.33;7.33;7.33";
        if (attributeName === "x") values = `${x};${x + 3};${x};${x}`;
        if (attributeName === "y") values = `${y};${y + 3};${y};${y}`;
        return `<animate attributeName="${attributeName}" begin="${delay}s" dur="1.2s" repeatCount="indefinite" keyTimes="0;0.25;0.5;1" values="${values}"/>`;
      }).join("");
    }
    return `<rect width="7.33" height="7.33" x="${x}" y="${y}" fill="currentColor">${animations}</rect>`;
  }).join("");
  const classAttribute = className ? ` class="${className}"` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"${classAttribute} aria-hidden="true">${rects}</svg>`;
}

const ICON_BLOCKS_WAVE_SVG = buildBlocksWaveSvg(true, "crisp-pulse-title-icon-svg");
const ICON_BLOCKS_WAVE_REGISTERED_SVG = buildBlocksWaveSvg(true, "");

const CRISP_PULSE_ICON_ID = "crisp-pulse";

function crispPulseRegisterIcons() {
  try {
    if (typeof addIcon === "function") {
      addIcon(CRISP_PULSE_ICON_ID, ICON_BLOCKS_WAVE_REGISTERED_SVG);
    }
  } catch (e) {
    console.warn("[Crisp Pulse] Failed to register custom icon:", e);
  }
}
crispPulseRegisterIcons();

const DEFAULT_SETTINGS = {
  weekStartsOn: "sunday", // "sunday" | "monday"
  defaultMetric: "contribution", // "contribution" | "activity" | "words" | "notes" | "tasks" | "focus"
  sessionIdleTimeoutMinutes: 3,
  focusIdleTimeoutMinutes: 5,
  weightNoteCreated: 5,
  weightMeaningfulEdit: 2,
  weightTaskCompleted: 2,
  weightLinkCreated: 1,
  captureMultiplier: 0.2,
  includeFocusInContribution: true, // v1.3.0: enabled by default for ecosystem integration
  weightFocusMinute: 0.05,
  hasRunBackfill: false,
  showStatusBarItem: true,
  showHeaderBanner: true,
  showFooterLandscape: true,
  memoPomodoroPrompt: true, // during a Crisp Focus pomodoro break, the memo composer asks what the round produced // pixel horizon at the bottom of the Pulse view; the ridge is recent daily contribution
  headerBannerImage: "", // vault path of a custom banner image; empty uses the generated sky

  // --- 1.1 Credible Analytics Settings ---
  trackingStartDate: null, // "YYYY-MM-DD" or null
  dataQualityScope: "reliable", // "reliable" | "all" | "recorded_only"
  includedFolders: [], // string[]: empty means all
  excludedFolders: [".obsidian", ".trash", "templates"], // string[]
  excludeSystemArtifacts: false, // opt-in; preserve existing collection scope
  activeFolderPreset: "all", // "all" | "anks-knowledge" | "custom"

  // --- 1.2.0 Work Review Settings ---
  defaultDateRange: "year", // "year" | "90d" | "30d" | "7d" | "ytd"

  // --- 1.3.0 Ecosystem Integration Settings ---
  enableCrispFocusSync: true,
  reviewArchiveFolder: "Topics/self-media/outputs/reviews",

  // --- 1.4.0 Software License ---
  licenseCode: "",
  licenseLastOnlineAt: 0,

  // --- 1.13.0 速记 ---
  memoMode: "auto", // "auto" | "general" | "anks"
  memoAnksTopic: "", // empty: first Topic
  memoHeading: MEMO_DEFAULT_HEADING, // empty: append to the end of the daily note
  memoDailyFolder: "", // empty: follow the core Daily notes plugin
  memoDailyFormat: "", // empty: follow the core Daily notes plugin
  memoNoteFolder: "", // empty: Obsidian's default new-note location
  memoReviewCount: 6, // 每日回顾条数，1–24
  memoReviewTags: "", // 空：全部标签；多个用空格分隔，含子标签
  memoReviewWithinDays: 0, // 0：全部时间
  memoReviewTime: "", // "HH:MM" 到点提醒；空：不提醒
  memoReviewNotifiedOn: "" // 内部：今天是否已提醒
};

// Words scoring with diminishing marginal returns (Section 6)
function calcWordsContribution(wordsAdded) {
  if (!wordsAdded || wordsAdded <= 0) return 0;
  let score = 0;
  if (wordsAdded <= 500) {
    score = wordsAdded * (1 / 250);
  } else if (wordsAdded <= 2000) {
    score = 500 * (1 / 250) + (wordsAdded - 500) * (1 / 250) * 0.6;
  } else if (wordsAdded <= 5000) {
    score = 500 * (1 / 250) + 1500 * (1 / 250) * 0.6 + (wordsAdded - 2000) * (1 / 250) * 0.3;
  } else {
    score = 500 * (1 / 250) + 1500 * (1 / 250) * 0.6 + 3000 * (1 / 250) * 0.3 + (wordsAdded - 5000) * (1 / 250) * 0.1;
  }
  return Math.min(30, Math.round(score * 10) / 10);
}

// CJK + English Word Counter
function countWords(str) {
  if (!str) return 0;
  const cjk = (str.match(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const en = (str.replace(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g, " ").match(/\b[a-zA-Z0-9_-]+\b/g) || []).length;
  return cjk + en;
}

// Ignore fenced/inline code so examples do not count as completed work.
function markdownProse(str) {
  let fence = null;
  return (str || "").split("\n").map(line => {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      return "";
    }
    return fence ? "" : line;
  }).join("\n").replace(/(`+)[\s\S]*?\1/g, "");
}

function countTasks(str) {
  return (markdownProse(str).match(/^\s*(?:[-+*]|\d+[.)])\s+\[[xX]\](?:\s|$)/gm) || []).length;
}

function countLinks(str) {
  return (markdownProse(str).match(/\[\[[^\]]+\]\]/g) || []).length;
}

// 1.2 Line Hashes for Rewriting / Polish Detection
function getLineSet(str) {
  if (!str) return new Set();
  const lines = str.split("\n").map(l => l.trim()).filter(l => l.length > 0);
  return new Set(lines);
}

// 1.2 Task Fingerprints for Lifecycle Tracking
function getCompletedTaskSet(str) {
  if (!str) return new Set();
  const prose = markdownProse(str);
  const matches = prose.match(/^\s*(?:[-+*]|\d+[.)])\s+\[[xX]\](?:\s+.*)?$/gm) || [];
  const set = new Set();
  const counts = new Map();
  for (const m of matches) {
    const content = m.replace(/^\s*(?:[-+*]|\d+[.)])\s+\[[xX]\]\s*/, "").trim().slice(0, 50);
    if (!content) continue;
    const count = counts.get(content) || 0;
    counts.set(content, count + 1);
    set.add(count === 0 ? content : `${content}:::${count}`);
  }
  return set;
}

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function getTodayKey() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatPulseMinutes(value) {
  const minutes = Number.isFinite(value) && value > 0 ? value : 0;
  return minutes.toLocaleString(PULSE_NUMBER_LOCALE, { maximumFractionDigits: 1 });
}

function formatDateDisplay(dateStr) {
  if (!dateStr) return "";
  const parts = dateStr.split("-");
  if (parts.length !== 3) return dateStr;
  const month = parseInt(parts[1], 10), day = parseInt(parts[2], 10);
  return PULSE_ZH ? `${parts[0]}年${month}月${day}日` : `${pulseMonthDay(month, day)}, ${parts[0]}`;
}

function createEmptyDailyRecord(dateStr, quality = "recorded") {
  return {
    date: dateStr,
    quality: quality,
    activity: {
      activeMinutes: 0,
      focusMinutes: 0,
      editingSessions: 0,
      notesOpened: 0,
      notesEdited: 0
    },
    contribution: {
      score: 0,
      meaningfulEdits: 0,
      notesCreated: 0,
      wordsAdded: 0,
      wordsRemoved: 0,
      tasksCompleted: 0,
      linksCreated: 0,
      captureWords: 0,
      rewrittenWords: 0, // 1.2 additions
      externalWords: 0 // 1.13.1: system/background writes, recorded but never scored
    },
    files: {},
    intensity: 0
  };
}

// 1.1 Path Filtering Pure Function
function isPathIncluded(filePath, includedFolders = [], excludedFolders = []) {
  if (!filePath) return false;
  const norm = filePath.replace(/^\/+/, "");

  if (Array.isArray(excludedFolders) && excludedFolders.length > 0) {
    for (const ex of excludedFolders) {
      const cleanEx = ex.replace(/^\/+|\/+$/g, "");
      if (!cleanEx) continue;
      if (norm === cleanEx || norm.startsWith(cleanEx + "/")) {
        return false;
      }
    }
  }

  if (Array.isArray(includedFolders) && includedFolders.length > 0) {
    let matched = false;
    for (const inc of includedFolders) {
      const cleanInc = inc.replace(/^\/+|\/+$/g, "");
      if (!cleanInc) continue;
      if (norm === cleanInc || norm.startsWith(cleanInc + "/")) {
        matched = true;
        break;
      }
    }
    return matched;
  }

  return true;
}

// 1.2 Score Breakdown Pure Function
function getScoreBreakdown(record, settings = DEFAULT_SETTINGS) {
  if (!record || !record.contribution) {
    return {
      notesCreatedScore: 0,
      meaningfulEditsScore: 0,
      tasksCompletedScore: 0,
      linksCreatedScore: 0,
      wordsNormalScore: 0,
      wordsCaptureScore: 0,
      wordsRewrittenScore: 0,
      wordsTotalScore: 0,
      focusScore: 0,
      totalScore: 0
    };
  }
  const c = record.contribution;
  const s = settings;
  const normalWords = Math.max(0, c.wordsAdded - (c.captureWords || 0));
  const captureWords = c.captureWords || 0;
  const rewrittenWords = c.rewrittenWords || 0;

  const wordsNormalScore = calcWordsContribution(normalWords);
  const wordsCaptureScore = Math.round(calcWordsContribution(captureWords) * (s.captureMultiplier ?? 0.2) * 10) / 10;
  const wordsRewrittenScore = Math.round(calcWordsContribution(rewrittenWords) * 0.5 * 10) / 10;
  const wordsTotalScore = Math.min(30, Math.round((wordsNormalScore + wordsCaptureScore + wordsRewrittenScore) * 10) / 10);

  const notesCreatedScore = Math.round((c.notesCreated * (s.weightNoteCreated ?? 5)) * 10) / 10;
  const meaningfulEditsScore = Math.round((c.meaningfulEdits * (s.weightMeaningfulEdit ?? 2)) * 10) / 10;
  const tasksCompletedScore = Math.round((c.tasksCompleted * (s.weightTaskCompleted ?? 2)) * 10) / 10;
  const linksCreatedScore = Math.round((c.linksCreated * (s.weightLinkCreated ?? 1)) * 10) / 10;

  let focusScore = 0;
  if (s.includeFocusInContribution) {
    const focusMins = Math.round(record.activity?.focusMinutes || 0);
    focusScore = Math.round((focusMins * (s.weightFocusMinute ?? 0.05)) * 10) / 10;
  }

  const totalScore = Math.round((notesCreatedScore + meaningfulEditsScore + tasksCompletedScore + linksCreatedScore + wordsTotalScore + focusScore) * 10) / 10;

  return {
    notesCreatedScore,
    meaningfulEditsScore,
    tasksCompletedScore,
    linksCreatedScore,
    wordsNormalScore,
    wordsCaptureScore,
    wordsRewrittenScore,
    wordsTotalScore,
    focusScore,
    totalScore
  };
}

// 1.2 Date Range Filter Function
function filterDatesByRange(allDates, rangeKey = "year", refDate = new Date()) {
  if (!allDates || allDates.length === 0) return [];
  const refTime = new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate()).getTime();
  const daysAgo = days => new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate() - days).getTime();

  let minTime = 0;
  if (rangeKey === "7d") {
    minTime = daysAgo(6);
  } else if (rangeKey === "30d") {
    minTime = daysAgo(29);
  } else if (rangeKey === "90d") {
    minTime = daysAgo(89);
  } else if (rangeKey === "ytd") {
    minTime = new Date(refDate.getFullYear(), 0, 1).getTime();
  } else {
    // year / 53w = 371 days
    minTime = daysAgo(370);
  }

  return allDates.filter(dStr => {
    const [y, m, d] = dStr.split("-").map(Number);
    const time = new Date(y, m - 1, d).getTime();
    return dateKey(new Date(time)) === dStr && time >= minTime && time <= refTime;
  });
}

// 1.2 Review Data Analyzer
function generateReviewData(daily = {}, startDateStr, endDateStr, scope = "all", filterFn = null) {
  const sortedDates = Object.keys(daily).sort();
  const matchedDates = sortedDates.filter(d => Number.isFinite(reviewDayNumber(d)) && (!startDateStr || d >= startDateStr) && (!endDateStr || d <= endDateStr));

  let totalScore = 0;
  let notesCreated = 0;
  let wordsAdded = 0;
  let rewrittenWords = 0;
  let tasksCompleted = 0;
  let totalActiveMins = 0;
  let totalFocusMins = 0;

  const sourceWords = { system: 0, capture: 0, unattributed: 0, historical: 0 };
  const dirCounts = new Map(); // dirName -> { count: number, words: number }
  const fileStats = new Map(); // path -> { words: number, created: boolean, tasks: number }

  for (const d of matchedDates) {
    const r = daily[d];
    if (!r) continue;
    if (typeof filterFn === "function" && !filterFn(r, d)) continue;
    totalScore += (r.contribution?.score || 0);
    notesCreated += (r.contribution?.notesCreated || 0);
    wordsAdded += (r.contribution?.wordsAdded || 0);
    rewrittenWords += (r.contribution?.rewrittenWords || 0);
    tasksCompleted += (r.contribution?.tasksCompleted || 0);
    totalActiveMins += (r.activity?.activeMinutes || 0);
    totalFocusMins += (r.activity?.focusMinutes || 0);

    for (const [fp, finfo] of Object.entries(r.files || {})) {
      for (const source of ['system', 'capture', 'unattributed']) {
        const amount = finfo.sourceWords?.[source];
        if (Number.isFinite(amount) && amount > 0) sourceWords[source] += amount;
      }
      // Extract top level dir
      const parts = fp.split("/");
      const dir = parts.length > 1 ? parts[0] : PULSE_ROOT_DIR;
      if (!dirCounts.has(dir)) dirCounts.set(dir, { count: 0, words: 0 });
      const dc = dirCounts.get(dir);
      dc.count += 1;
      dc.words += (finfo.wordsAdded || 0);

      if (!fileStats.has(fp)) fileStats.set(fp, { words: 0, rewrittenWords: 0, captureWords: 0, days: 0, created: false, tasks: 0 });
      const fs = fileStats.get(fp);
      fs.words += (finfo.wordsAdded || 0);
      if (Number.isFinite(finfo.sourceWords?.capture) && finfo.sourceWords.capture > 0) fs.captureWords += finfo.sourceWords.capture;
      fs.rewrittenWords += (finfo.rewrittenWords || 0);
      fs.days++;
      if (finfo.created) fs.created = true;
      fs.tasks += (finfo.tasks || 0);
    }
  }

  let unclassified = wordsAdded;
  for (const source of ['system', 'capture', 'unattributed']) {
    sourceWords[source] = Math.min(unclassified, sourceWords[source]);unclassified -= sourceWords[source];
  }
  sourceWords.historical = Math.max(0, unclassified);

  // Calculate dir breakdown percentages
  let totalDirEvents = 0;
  for (const item of dirCounts.values()) totalDirEvents += item.count;

  const dirBreakdown = [];
  for (const [dir, item] of dirCounts.entries()) {
    const pct = totalDirEvents > 0 ? Math.floor((item.count / totalDirEvents) * 100) : 0;
    dirBreakdown.push({ dir, percent: pct, count: item.count, words: item.words });
  }
  let remainder = totalDirEvents ? 100 - dirBreakdown.reduce((sum, d) => sum + d.percent, 0) : 0;
  const fractional = [...dirBreakdown].sort((a, b) =>
    (b.count * 100 / totalDirEvents - b.percent) - (a.count * 100 / totalDirEvents - a.percent) || a.dir.localeCompare(b.dir));
  for (const item of fractional) { if (remainder-- <= 0) break; item.percent++; }
  dirBreakdown.sort((a, b) => b.percent - a.percent);

  // Top 5 files
  const topFiles = [];
  for (const [path, s] of fileStats.entries()) {
    topFiles.push({ path, ...s });
  }
  topFiles.sort((a, b) => b.words - a.words);

  return {
    totalScore: Math.round(totalScore * 10) / 10,
    notesCreated,
    wordsAdded,
    rewrittenWords,
    tasksCompleted,
    activeHours: (totalActiveMins / 60).toFixed(1),
    focusHours: (totalFocusMins / 60).toFixed(1),
    dirBreakdown,
    sourceWords,
    focusMinutes: totalFocusMins,
    activeMinutes: totalActiveMins,
    allFiles: topFiles,
    topFiles: topFiles.slice(0, 5)
  };
}

// Review periods use calendar dates (UTC ordinals avoid daylight-saving drift).
function reviewDayNumber(key) {
  if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return NaN;
  const date = new Date(`${key}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === key ? date.getTime() / 86400000 : NaN;
}
function reviewDayKey(day) { return new Date(day * 86400000).toISOString().slice(0, 10); }
function getReviewPeriod(start, end) {
  const first = reviewDayNumber(start), last = reviewDayNumber(end);
  const days = last - first + 1;
  if (!Number.isFinite(days) || days < 1 || days > 371 || end > getTodayKey()) {
    throw new Error(tr('请选择有效日期：开始不晚于结束，结束不晚于今天，区间最多 371 天。', 'Choose valid dates: the start must not be after the end, the end must not be after today, and the range can be at most 371 days.'));
  }
  return { start, end, days, previousStart: reviewDayKey(first - days), previousEnd: reviewDayKey(first - 1) };
}
const PULSE_RANGE_LABELS = { year: tr('近 53 周', 'last 53 weeks'), '90d': tr('最近 90 天', 'last 90 days'), '30d': tr('最近 30 天', 'last 30 days'), '7d': tr('最近 7 天', 'last 7 days'), ytd: tr('本年', 'year to date') };
const REVIEW_SCOPE_LABELS = { reliable: tr('可靠记录', 'Reliable records'), recorded_only: tr('仅实测记录', 'Measured only'), all: tr('全部历史', 'All history') };
const REVIEW_DRAFT_FIELDS = { progress: tr('主要进展', 'Main progress'), learning: tr('洞见与证据', 'Insights and evidence'), blockers: tr('阻塞与疑问', 'Blockers and questions'), next: tr('下一步行动', 'Next actions') };
function getReviewDrilldown(review, folder = '', sort = 'words') {
  const files = (review.allFiles || []).filter(file => folder === PULSE_ROOT_DIR ? !file.path.includes('/') : !folder || file.path.startsWith(`${folder}/`));
  const sortKey = ['words', 'rewrittenWords', 'tasks', 'days'].includes(sort) ? sort : 'words';
  files.sort((a, b) => b[sortKey] - a[sortKey] || a.path.localeCompare(b.path));
  return { files, words: files.reduce((n, f) => n + f.words, 0), rewrittenWords: files.reduce((n, f) => n + f.rewrittenWords, 0), tasks: files.reduce((n, f) => n + f.tasks, 0) };
}
/** 自然周：weekStartsOn 决定周一或周日开始；offset=-1 是上一个完整周，本周的结束日截到今天。 */
function reviewWeekRange(todayKey, weekStartsOn = 'sunday', offset = 0) {
  const today = reviewDayNumber(todayKey);
  const first = weekStartsOn === 'monday' ? 1 : 0;
  const start = today - ((new Date(today * 86400000).getUTCDay() - first + 7) % 7) + offset * 7;
  return { start: reviewDayKey(start), end: reviewDayKey(Math.min(start + 6, today)) };
}
function reviewDraftSize(model) {
  return Object.keys(REVIEW_DRAFT_FIELDS).filter(key => model.draft[key]?.trim()).length + model.actions.length + model.evidence.length;
}
/**
 * 复盘首屏的线索：只从本期记录里挑可核对的事实，最多三条，每条带一个能打开原始内容的入口。
 * 不评判价值，也不推断原因；速记读取失败（memos 缺失或带 error）时不出速记线索，避免把未知当成零。
 */
function getReviewClues(model, { memos = null, carry = 0 } = {}) {
  const { current, previous } = model;
  const n = formatPulseMinutes;
  const name = path => path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
  if (!current.coverage.recorded) return [{ key: 'empty', color: 'gray', title: tr('这段时间没有可用记录', 'No usable records in this period'), detail: tr('换一个周期，或在右上角换一个数据范围。未记录不等于零。', 'Try another period, or another data scope at the top right. Not recorded is not zero.') }];
  const clues = [];
  if (carry > 0) clues.push({ key: 'carry', color: 'teal', title: tr(`上一期还有 ${carry} 项行动没收尾`, `${plural(carry, 'action')} left open last period`), detail: tr('带入本期，再决定继续、延期还是取消。', 'Carry them over, then decide whether to continue, defer or cancel.'), action: { kind: 'carry', label: tr('带入本期', 'Carry over') } });
  const files = current.allFiles || [];
  const top = files.reduce((best, file) => (!best || file.words > best.words ? file : best), null);
  if (top && current.wordsAdded >= 200 && top.words / current.wordsAdded >= 0.5) {
    const pct = Math.min(100, Math.round(top.words / current.wordsAdded * 100));
    clues.push({ key: 'focus-file', color: 'purple', title: tr(`新增大多来自「${name(top.path)}」`, `Most new words came from “${name(top.path)}”`), detail: tr(`${n(top.words)} / ${n(current.wordsAdded)} 词，占 ${pct}%。字数多不等于价值高，打开看看哪些值得继续跟进。`, `${n(top.words)} of ${n(current.wordsAdded)} words, ${pct}%. More words is not more value; open it and pick what deserves follow-up.`), action: { kind: 'open', path: top.path, label: tr('打开笔记', 'Open note') } });
  } else if (current.notesCreated > 0) {
    clues.push({ key: 'created', color: 'rose', title: tr(`本期新建 ${current.notesCreated} 篇笔记`, `${plural(current.notesCreated, 'note')} created this period`), detail: tr('挑一篇看看，它有没有接上已有的笔记。', 'Pick one and check whether it connects to what you already have.'), action: { kind: 'materials', mode: 'created', label: tr('看新建的笔记', 'See new notes') } });
  }
  if (memos && !memos.error && memos.pending?.length) {
    clues.push({ key: 'memos', color: 'orange', title: tr(`${memos.pending.length} 条速记还没有去处`, `${plural(memos.pending.length, 'memo')} not yet followed up`), detail: tr(`本期记下 ${memos.total} 条。回看一遍，挑出值得继续的；不必每条都转。`, `${memos.total} captured this period. Skim them and keep going with the ones worth it; not every memo needs converting.`), action: { kind: 'memos', label: tr('回看速记', 'Review memos') } });
  }
  const rewritten = files.reduce((best, file) => (!best || file.rewrittenWords > best.rewrittenWords ? file : best), null);
  if (rewritten && rewritten.rewrittenWords >= 300 && rewritten.path !== clues.find(c => c.key === 'focus-file')?.action.path) {
    clues.push({ key: 'rewritten', color: 'green', title: tr(`改写最多的是「${name(rewritten.path)}」`, `Most rewritten: “${name(rewritten.path)}”`), detail: tr(`改写估算 ${n(rewritten.rewrittenWords)} 词。改动大的地方，常常是想法变了的地方。`, `About ${n(rewritten.rewrittenWords)} words rewritten. Heavy rewrites often mark where your thinking changed.`), action: { kind: 'open', path: rewritten.path, label: tr('打开笔记', 'Open note') } });
  }
  if (current.focusMinutes > 0) {
    const delta = previous.coverage.recorded ? current.focusMinutes - previous.focusMinutes : null;
    const change = delta === null ? '' : delta > 0 ? tr(`，比上期多 ${n(delta)} 分钟`, `, ${n(delta)} more than last period`) : delta < 0 ? tr(`，比上期少 ${n(-delta)} 分钟`, `, ${n(-delta)} fewer than last period`) : tr('，和上期持平', ', same as last period');
    clues.push({ key: 'focus', color: 'blue', title: tr(`专注 ${n(current.focusMinutes)} 分钟${change}`, `${n(current.focusMinutes)} focus minutes${change}`), detail: tr('补一句：这些专注推进了什么？', 'Add a line: what did this focus move forward?'), action: { kind: 'write', label: tr('写一句', 'Write it down') } });
  }
  return clues.slice(0, 3);
}
function getReviewInsight(review) {
  if (!review.dirBreakdown?.length) return tr('没有文件记录，无法据此判断知识流向或产出质量。', 'No file records, so knowledge flow and output quality cannot be judged from them.');
  const topics = review.dirBreakdown.find(d => d.dir === 'Topics')?.percent || 0;
  const core = review.dirBreakdown.find(d => d.dir === 'Core')?.percent || 0;
  const basis = tr('占比按文件×日期记录数计算，不代表工时或知识质量。', ' Shares count file × day records; they do not reflect hours worked or knowledge quality.');
  if (topics >= 60) return tr(`ANKS 知识沉淀建议：Topics 占比 ${topics}%。可回看相关笔记中的证据与可复用经验；进入 Core 前仍需人工或策略批准。${basis}`, `ANKS distillation tip: Topics make up ${topics}%. Review the evidence and reusable lessons in those notes; promotion to Core still needs human or policy approval.${basis}`);
  if (core >= 40) return tr(`ANKS 底层建设反馈：Core 占比 ${core}%。可检查这些笔记是否已被实际问题引用和验证。${basis}`, `ANKS foundation feedback: Core makes up ${core}%. Check whether these notes have been cited and validated by real problems.${basis}`);
  return tr(`目录记录分布：Core 占比 ${core}%，Topics 占比 ${topics}%。请结合实际笔记复盘。${basis}`, `Folder record distribution: Core ${core}%, Topics ${topics}%. Review alongside the actual notes.${basis}`);
}
function generateReviewReport(model) {
  const { period, current, previous, comparison, scope, draft } = model;
  const lines = PULSE_ZH ? [generateWeeklyMarkdown(current, `知识工作复盘 (${period.start} ~ ${period.end})`), '', '## 数据口径',
    `- 筛选：${REVIEW_SCOPE_LABELS[scope]}`,
    `- 当前区间：${period.start} ~ ${period.end}；纳入 ${current.coverage.recorded}/${period.days} 天，未记录 ${current.coverage.missing} 天，筛除 ${current.coverage.filtered} 天。`,
    `- 对比区间：${period.previousStart} ~ ${period.previousEnd}；纳入 ${previous.coverage.recorded}/${period.days} 天，未记录 ${previous.coverage.missing} 天，筛除 ${previous.coverage.filtered} 天。`,
    '- 未记录不等于零；覆盖不足时，变化只代表已纳入的记录。改写量为估算，贡献分不代表知识质量。',
    '- 目录占比按文件×日期记录数计算，不是编辑次数或工时。', '', '## 前后周期对比',
    '| 指标 | 当前 | 前期 | 变化 |', '| --- | ---: | ---: | --- |'] : [generateWeeklyMarkdown(current, `Knowledge Work Review (${period.start} ~ ${period.end})`), '', '## Data scope',
    `- Filter: ${REVIEW_SCOPE_LABELS[scope]}`,
    `- Current period: ${period.start} ~ ${period.end}; included ${current.coverage.recorded}/${period.days} days, ${current.coverage.missing} not recorded, ${current.coverage.filtered} filtered out.`,
    `- Comparison period: ${period.previousStart} ~ ${period.previousEnd}; included ${previous.coverage.recorded}/${period.days} days, ${previous.coverage.missing} not recorded, ${previous.coverage.filtered} filtered out.`,
    '- Not recorded is not zero; with partial coverage, changes only reflect included records. Rewrites are estimates, and the contribution score does not reflect knowledge quality.',
    '- Folder shares count file × day records, not edits or hours worked.', '', '## Period comparison',
    '| Metric | Current | Previous | Change |', '| --- | ---: | ---: | --- |'];
  for (const row of comparison) lines.push(`| ${row.label} | ${formatPulseMinutes(row.current)} ${row.unit} | ${formatPulseMinutes(row.previous)} ${row.unit} | ${row.changeLabel} |`);
  lines.push('', tr('## 复盘反思', '## Reflection'));
  for (const [key, label] of Object.entries(REVIEW_DRAFT_FIELDS)) lines.push('', `### ${label}`, draft[key] || tr('（待补充）', '(to be added)'));
  lines.push('', tr('## 新增词数来源', '## Sources of added words'), tr('系统目录仅按路径识别，大段捕获为估算；其他新增不能据此归为人工写作。升级前记录保留为历史未分类。', 'System folders are identified by path only, and large captures are estimates; other additions cannot be attributed to human writing on this basis. Records from before the upgrade stay as historical, unclassified.'));
  for (const [key, label] of Object.entries(REVIEW_SOURCE_LABELS)) lines.push(tr(`- ${label}：${current.sourceWords?.[key] || 0} 词`, `- ${label}: ${current.sourceWords?.[key] || 0} words`));
  lines.push('', tr('## 行动追踪', '## Action tracking'));
  for (const action of model.actions || []) {
    lines.push(`- ${action.status === 'done' ? '[x]' : '[ ]'} ${action.title || tr('（待填写行动）', '(action to be filled in)')} · ${REVIEW_ACTION_STATES[action.status] || REVIEW_ACTION_STATES.pending}`);
    if (action.sourcePeriod) lines.push(tr(`  - 继承自：${action.sourcePeriod}`, `  - Carried over from: ${action.sourcePeriod}`));
    if (action.outcomePath) lines.push(tr(`  - 结果笔记：${reportNoteLink(action.outcomePath)}`, `  - Outcome note: ${reportNoteLink(action.outcomePath)}`));
  }
  if (!model.actions?.length) lines.push(tr('（暂无结构化行动）', '(No structured actions yet)'));
  if (model.memos) {
    const m = model.memos;
    lines.push('', tr('## 速记与转化', '## Memos and conversions'));
    if (m.error) lines.push(tr(`速记读取失败，未计入：${m.error}`, `Memos could not be read and are not included: ${m.error}`));
    else if (!m.total) lines.push(tr('这段时间没有速记。', 'No memos in this period.'));
    else {
      lines.push(tr(`- 本期记下 ${m.total} 条，已转化 ${m.converted} 条（按速记去重，状态截至导出时）`, `- ${m.total} captured this period, ${m.converted} converted (each memo counted once; status as of export)`));
      const tasks = m.tempoFailed ? tr('完成情况读取失败', 'completion could not be read') : m.tasksUnknown ? tr('完成情况未知', 'completion unknown') : tr(`完成 ${m.tasksDone}，未完成 ${m.tasksOpen}${m.tasksMissing ? `，已删除 ${m.tasksMissing}` : ''}`, `${m.tasksDone} done, ${m.tasksOpen} open${m.tasksMissing ? `, ${m.tasksMissing} deleted` : ''}`);
      lines.push(tr(`- 转为任务 ${m.toTasks} 条${m.toTasks ? `（${tasks}）` : ''}`, `- To tasks: ${m.toTasks}${m.toTasks ? ` (${tasks})` : ''}`), tr(`- 转为笔记 ${m.toNotes} 条`, `- To notes: ${m.toNotes}`), tr(`- 加入 Now 行动 ${m.toNow} 条`, `- Added to Now actions: ${m.toNow}`));
    }
  }
  lines.push('', tr('## 洞见证据', '## Evidence for insights'));
  for (const evidence of model.evidence || []) {
    lines.push('', `- ${reportNoteLink(evidence.path)} · ${tr('摘录时间', 'Captured at')} ${typeof evidence.capturedAt === 'string' ? evidence.capturedAt : ''}`);
    if (evidence.originalPath !== evidence.path) lines.push(tr(`  - 摘录时路径：${evidence.originalPath}`, `  - Path when captured: ${evidence.originalPath}`));
    if (typeof evidence.quote === 'string' && evidence.quote) lines.push(...evidence.quote.split('\n').map(line => `> ${line}`));
  }
  if (!model.evidence?.length) lines.push(tr('（暂无关联证据）', '(No linked evidence yet)'));
  return lines.join('\n');
}

const SYSTEM_ARTIFACT_FOLDERS = ['Sidecar/logs', 'Sidecar/backups', 'Sidecar/manifests'];
// Obsidian saves the editor about 2s after the last keystroke, so a save shortly after switching away is still typing.
const BACKGROUND_WRITE_GRACE_MS = 10000;
// 新建笔记前这么久内有过键盘或点击，才算本人新建（Cmd+N、点新建按钮、点未创建的链接）
const CREATE_ACTION_WINDOW_MS = 3000;
// editor-change 紧跟在一次键盘 / 输入事件之后才算本人编辑；外部改文件后编辑器重载也会触发 editor-change
const EDITOR_INPUT_LINK_MS = 2000;
const REVIEW_SOURCE_LABELS = { system: tr('系统目录新增', 'Added in system folders'), capture: tr('大段捕获（估算）', 'Large captures (estimated)'), unattributed: tr('其他新增（来源未确认）', 'Other additions (source unconfirmed)'), historical: tr('历史未分类', 'Historical, unclassified') };
const REVIEW_ACTION_STATES = { pending: tr('待办', 'To do'), done: tr('完成', 'Done'), deferred: tr('延期', 'Deferred'), cancelled: tr('取消', 'Cancelled') };
function isSystemArtifact(path) {
  return typeof path === 'string' && SYSTEM_ARTIFACT_FOLDERS.some(folder => path === folder || path.startsWith(`${folder}/`));
}
function recordSourceWords(fileRecord, path, words, capture) {
  if (!(words > 0)) return;
  if (!fileRecord.sourceWords || typeof fileRecord.sourceWords !== 'object' || Array.isArray(fileRecord.sourceWords)) fileRecord.sourceWords = {};
  const source = isSystemArtifact(path) ? 'system' : capture ? 'capture' : 'unattributed';
  fileRecord.sourceWords[source] = (Number.isFinite(fileRecord.sourceWords[source]) ? fileRecord.sourceWords[source] : 0) + words;
}
function reviewEntryId() {
  return typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
function getReviewDraftKey(start, end, scope) {
  getReviewPeriod(start, end);
  if (!Object.hasOwn(REVIEW_SCOPE_LABELS, scope)) throw new Error(tr('未知的数据筛选范围', 'Unknown data scope'));
  return `${start}:${end}:${scope}`;
}
function reviewSafePath(path) {
  return typeof path === 'string' && path.endsWith('.md') && !path.startsWith('/') && !path.includes('\\') && !/(?:^|\/)\.\.(?:\/|$)/.test(path) && !/[\r\n\0]/.test(path);
}
function reportNoteLink(path) {
  // Use encoded Markdown links for filenames that cannot safely be represented as wikilinks.
  return /[\[\]|#]/.test(path) ? `[${tr('笔记', 'Note')}](${path.split('/').map(part => encodeURIComponent(part).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16))).join('/')})` : `[[${path}]]`;
}

// 1.2 Weekly Markdown Generator
function generateWeeklyMarkdown(reviewData, weekTitle = tr("知识工作周报 (Week Review)", "Weekly Knowledge Work Report")) {
  const { totalScore, notesCreated, wordsAdded, rewrittenWords, tasksCompleted, activeHours, focusHours, dirBreakdown, topFiles } = reviewData;

  const lines = [
    `# ${weekTitle}`,
    "",
    tr("## 📊 区间总览", "## 📊 Overview"),
    tr(`- **总贡献得分**: ${totalScore} 分`, `- **Contribution score**: ${totalScore} pts`),
    tr(`- **新建笔记**: ${notesCreated} 篇`, `- **Notes created**: ${notesCreated}`),
    tr(`- **沉淀文字量**: +${wordsAdded} 词${rewrittenWords > 0 ? ` (深度改写/润色: +${rewrittenWords} 词)` : ""}`, `- **Words added**: +${wordsAdded}${rewrittenWords > 0 ? ` (rewrites/polishing: +${rewrittenWords})` : ""}`),
    tr(`- **完成任务**: ${tasksCompleted} 项`, `- **Tasks completed**: ${tasksCompleted}`),
    tr(`- **交互活跃时长**: ${activeHours} 小时`, `- **Active time**: ${activeHours} h`),
  ];

  if (focusHours && Number(focusHours) > 0) {
    lines.push(tr(`- **深度专注时长**: ${focusHours} 小时`, `- **Focus time**: ${focusHours} h`));
  }

  lines.push("");
  lines.push(tr("## 🗂️ 核心目录分布", "## 🗂️ Top folders"));

  if (dirBreakdown.length === 0) {
    lines.push(tr("- *区间内没有文件记录*", "- *No file records in this period*"));
  } else {
    for (const d of dirBreakdown) {
      lines.push(tr(`- \`${d.dir}\`: ${d.percent}% (文件×日期记录 ${d.count} 条 / +${d.words} 词)`, `- \`${d.dir}\`: ${d.percent}% (${d.count} file × day records / +${d.words} words)`));
    }
  }

  lines.push("");
  lines.push(tr("## 📝 新增词数 Top 5", "## 📝 Top 5 by words added"));
  if (topFiles.length === 0) {
    lines.push(tr("- *区间内没有笔记记录*", "- *No note records in this period*"));
  } else {
    topFiles.forEach((f, i) => {
      lines.push(`${i + 1}. ${reportNoteLink(f.path)} (${reportFileTags(f)})`);
    });
  }

  return lines.join("\n");
}

function reportFileTags(f) {
  const tags = [];
  if (f.created) tags.push(tr("新建", "new"));
  if (f.words > 0) tags.push(tr(`+${f.words}词`, `+${f.words} words`));
  if (f.tasks > 0) tags.push(tr(`${f.tasks}任务`, plural(f.tasks, "task")));
  return tags.join(" · ") || tr("已编辑", "edited");
}

// 1.3.0 ISO Week Calculator
function getIsoWeekString(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

// 1.3.0 ANKS Weekly Review Generator with Standard Frontmatter & Knowledge Insights
function generateAnksWeeklyReviewFileContent(reviewData, weekTitle = tr("知识工作周报", "Weekly Knowledge Work Report"), dateRangeStr = "") {
  const todayKey = getTodayKey();
  const isoWeek = getIsoWeekString(new Date());

  const coreItem = (reviewData.dirBreakdown || []).find(d => d.dir === "Core");
  const topicsItem = (reviewData.dirBreakdown || []).find(d => d.dir === "Topics");
  const corePct = coreItem ? coreItem.percent : 0;
  const topicsPct = topicsItem ? topicsItem.percent : 0;

  const anksInsight = `> [!NOTE] ${getReviewInsight(reviewData)}`;

  const lines = [
    "---",
    "type: review",
    "subtype: weekly-review",
    "tags:",
    "  - anks/review",
    "  - knowledge-work",
    "  - crisp-pulse",
    `created: ${todayKey}`,
    `period: "${dateRangeStr}"`,
    `iso_week: "${isoWeek}"`,
    `pulse_score: ${reviewData.totalScore}`,
    "---",
    "",
    `# 🗓️ ${weekTitle}`,
    "",
    tr("## 📊 脉冲总览 (Pulse Overview)", "## 📊 Pulse Overview"),
    tr(`- **总贡献得分**: ${reviewData.totalScore} 分`, `- **Contribution score**: ${reviewData.totalScore} pts`),
    tr(`- **新建笔记**: ${reviewData.notesCreated} 篇`, `- **Notes created**: ${reviewData.notesCreated}`),
    tr(`- **沉淀文字量**: +${reviewData.wordsAdded} 词${reviewData.rewrittenWords > 0 ? ` (深度改写/润色: +${reviewData.rewrittenWords} 词)` : ""}`, `- **Words added**: +${reviewData.wordsAdded}${reviewData.rewrittenWords > 0 ? ` (rewrites/polishing: +${reviewData.rewrittenWords})` : ""}`),
    tr(`- **完成关键任务**: ${reviewData.tasksCompleted} 项`, `- **Key tasks completed**: ${reviewData.tasksCompleted}`),
    tr(`- **交互活跃时长**: ${reviewData.activeHours} 小时`, `- **Active time**: ${reviewData.activeHours} h`),
  ];

  if (reviewData.focusHours && Number(reviewData.focusHours) > 0) {
    lines.push(tr(`- **深度专注时长**: ${reviewData.focusHours} 小时`, `- **Focus time**: ${reviewData.focusHours} h`));
  }

  lines.push("", tr("## 🗂️ 核心知识目录记录分布", "## 🗂️ Records by knowledge folder"), anksInsight, "");

  if (!reviewData.dirBreakdown || reviewData.dirBreakdown.length === 0) {
    lines.push(tr("- *区间内没有文件记录*", "- *No file records in this period*"));
  } else {
    for (const d of reviewData.dirBreakdown) {
      lines.push(tr(`- \`${d.dir}\`: **${d.percent}%** (文件×日期记录 ${d.count} 条 / 沉淀 +${d.words} 词)`, `- \`${d.dir}\`: **${d.percent}%** (${d.count} file × day records / +${d.words} words)`));
    }
  }

  lines.push("");
  lines.push(tr("## 📝 新增词数 Top 5", "## 📝 Top 5 by words added"));
  if (!reviewData.topFiles || reviewData.topFiles.length === 0) {
    lines.push(tr("- *区间内没有笔记记录*", "- *No note records in this period*"));
  } else {
    reviewData.topFiles.forEach((f, i) => {
      lines.push(`${i + 1}. ${reportNoteLink(f.path)} (${reportFileTags(f)})`);
    });
  }

  lines.push("");
  lines.push(tr("## 💡 复盘反思与下周计划", "## 💡 Reflection and next week’s plan"));
  lines.push(tr("- **本周最重要的进展**：", "- **Most important progress this week**:"));
  lines.push(tr("- **遇到的阻塞或卡点**：", "- **Blockers or sticking points**:"));
  lines.push(tr("- **下周优先推进的 1~3 个核心事项**：", "- **1–3 priorities for next week**:"));
  lines.push("");

  return lines.join("\n");
}

// 1.3.0 Crisp Focus Ecosystem Soft-Adapter
class CrispFocusAdapter {
  constructor(plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.originalComplete = null;
    this.attachedPlugin = null;
    this.lastHandledSessionEndAt = 0;
  }

  getFocusPlugin() {
    return this.app?.plugins?.getPlugin ? this.app.plugins.getPlugin("crisp-focus") : null;
  }

  isAvailable() {
    const p = this.getFocusPlugin();
    if (!p) { this.detach(); return false; }
    if (!this.plugin.settings.enableCrispFocusSync) this.detach();
    if (this.plugin.settings.enableCrispFocusSync && this.attachedPlugin !== p) {
      this.attach();
    }
    return true;
  }

  isFocusRunning() {
    if (!this.isAvailable()) return false;
    const p = this.getFocusPlugin();
    if (!p || !p.session || typeof p.session.getSnapshot !== "function") return false;
    try {
      const snap = p.session.getSnapshot();
      return snap?.status === "running";
    } catch {
      return false;
    }
  }

  getFocusRemainingMs() {
    const p = this.getFocusPlugin();
    if (!p || !p.session || typeof p.session.getSnapshot !== "function") return 0;
    try {
      const snap = p.session.getSnapshot();
      return snap?.remainingMs || 0;
    } catch {
      return 0;
    }
  }

  attach() {
    if (!this.plugin.settings.enableCrispFocusSync) return;
    const focusPlugin = this.getFocusPlugin();
    if (!focusPlugin || typeof focusPlugin.completeFocusSession !== "function") return;

    if (this.attachedPlugin === focusPlugin) return;

    this.detach();
    // Focus 1.5.0 起对外发 crisp-focus:session 事件，Pulse 只听事件，不再包装它的方法（否则同一段会记两次）
    if (Number(focusPlugin.focusApiVersion) >= 1) {
      this.attachedPlugin = focusPlugin;
      return;
    }
    const self = this;
    this.attachedPlugin = focusPlugin;
    this.originalComplete = focusPlugin.completeFocusSession;

    // Remember the length a session started with; Focus lets the default change while it runs.
    this.sessionMinutes = null;
    if (typeof focusPlugin.startFocusSession === "function") {
      this.originalStart = focusPlugin.startFocusSession;
      const originalStart = this.originalStart;
      this.startWrapper = function(...args) {
        const requested = args.length && args[0] !== undefined ? args[0] : focusPlugin.settings?.sessionDurationMinutes;
        self.sessionMinutes = Math.max(1, Math.min(240, Math.round(Number(requested) || 25)));
        return originalStart.apply(this, args);
      };
      focusPlugin.startFocusSession = this.startWrapper;
    }

    const originalComplete = this.originalComplete;
    this.completeWrapper = async function(...args) {
      const duration = self.sessionMinutes || focusPlugin.settings?.sessionDurationMinutes || 25;
      self.sessionMinutes = null;
      const result = await originalComplete.apply(this, args);
      if (self.attachedPlugin !== focusPlugin || self.plugin.stopped) return result;
      try {
        const now = Date.now();
        if (now - self.lastHandledSessionEndAt > 5000) {
          self.lastHandledSessionEndAt = now;
          await self.plugin.handleFocusSessionCompleted(duration);
        }
      } catch (err) {
        console.error("[Crisp Pulse] Error in focus completion callback:", err);
      }
      return result;
    };

    focusPlugin.completeFocusSession = this.completeWrapper;
    if (typeof focusPlugin.onSessionUpdate === "function" && !this.originalOnSessionUpdate) {
      this.originalOnSessionUpdate = focusPlugin.onSessionUpdate;
      const originalUpdate = this.originalOnSessionUpdate;
      this.updateWrapper = function(snapshot, reason) {
        const res = originalUpdate.apply(this, arguments);
        if (reason !== "tick" && self.attachedPlugin === focusPlugin && !self.plugin.stopped) {
          self.plugin.updateStatusBar();
        }
        return res;
      };
      focusPlugin.onSessionUpdate = this.updateWrapper;
    }
  }

  detach() {
    if (this.attachedPlugin) {
      if (this.originalStart && this.attachedPlugin.startFocusSession === this.startWrapper) this.attachedPlugin.startFocusSession = this.originalStart;
      this.originalStart = null;
      this.sessionMinutes = null;
      if (this.originalComplete && this.attachedPlugin.completeFocusSession === this.completeWrapper) {
        this.attachedPlugin.completeFocusSession = this.originalComplete;
        this.originalComplete = null;
      }
      if (this.originalOnSessionUpdate && this.attachedPlugin.onSessionUpdate === this.updateWrapper) {
        this.attachedPlugin.onSessionUpdate = this.originalOnSessionUpdate;
        this.originalOnSessionUpdate = null;
      }
      this.attachedPlugin = null;
      this.originalComplete = null;
      this.originalOnSessionUpdate = null;
    }
  }

  async startFocusSession(minutes = 25) {
    const focusPlugin = this.getFocusPlugin();
    if (!focusPlugin || typeof focusPlugin.startFocusSession !== "function") {
      new Notice(tr("未检测到 Crisp Focus 插件或该插件尚未加载。", "Crisp Focus was not found or has not loaded yet."));
      return false;
    }
    await focusPlugin.startFocusSession(minutes);
    return true;
  }
}

// 1.1 CSV Generator with Anti-Injection Sanitization
function sanitizeCSVCell(val) {
  let str = String(val ?? "");
  if (/^\s*[=+\-@]|^[\t\r\n]/.test(str)) {
    str = "'" + str;
  }
  if (str.includes(",") || str.includes("\"") || str.includes("\n") || str.includes("\r")) {
    str = `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function generateDailyCSV(daily = {}) {
  const headers = [
    "Date",
    "Quality",
    "Score",
    "WordsAdded",
    "WordsRemoved",
    "NotesCreated",
    "MeaningfulEdits",
    "TasksCompleted",
    "LinksCreated",
    "ActiveMinutes",
    "FocusMinutes",
    "FilesCount"
  ];
  const rows = [headers.join(",")];
  const sortedDates = Object.keys(daily).sort();
  for (const d of sortedDates) {
    const r = daily[d];
    const fCount = Object.keys(r.files || {}).length;
    const row = [
      sanitizeCSVCell(r.date),
      sanitizeCSVCell(r.quality || "recorded"),
      sanitizeCSVCell(r.contribution?.score || 0),
      sanitizeCSVCell(r.contribution?.wordsAdded || 0),
      sanitizeCSVCell(r.contribution?.wordsRemoved || 0),
      sanitizeCSVCell(r.contribution?.notesCreated || 0),
      sanitizeCSVCell(r.contribution?.meaningfulEdits || 0),
      sanitizeCSVCell(r.contribution?.tasksCompleted || 0),
      sanitizeCSVCell(r.contribution?.linksCreated || 0),
      sanitizeCSVCell((r.activity?.activeMinutes || 0)),
      sanitizeCSVCell((r.activity?.focusMinutes || 0)),
      sanitizeCSVCell(fCount)
    ];
    rows.push(row.join(","));
  }
  return rows.join("\n");
}

// Version 3 Schema Validation & Deep Auto-Repair
function validateAndRepairStore(store, defaultSettings = DEFAULT_SETTINGS) {
  if (!store || typeof store !== "object" || Array.isArray(store)) store = {};
  if (!store.settings || typeof store.settings !== "object" || Array.isArray(store.settings)) store.settings = {};
  for (const [key, fallback] of Object.entries(defaultSettings)) {
    if (store.settings[key] === undefined) store.settings[key] = Array.isArray(fallback) ? [...fallback] : fallback;
  }
  for (const key of ["includedFolders", "excludedFolders"]) {
    const value = store.settings[key];
    store.settings[key] = Array.isArray(value) ? value.filter(x => typeof x === "string" && x.trim()).map(x => x.trim()) : [...defaultSettings[key]];
  }

  for (const [key, fallback] of Object.entries(defaultSettings)) {
    const value = store.settings[key];
    if (typeof fallback === "number" && (!Number.isFinite(value) || value < 0)) store.settings[key] = fallback;
    if (typeof fallback === "boolean" && typeof value !== "boolean") store.settings[key] = fallback;
  }
  store.settings.sessionIdleTimeoutMinutes = Math.max(1, Math.min(10, store.settings.sessionIdleTimeoutMinutes ?? 3));
  store.settings.focusIdleTimeoutMinutes = Math.max(1, Math.min(30, store.settings.focusIdleTimeoutMinutes ?? 5));
  store.settings.captureMultiplier = Math.max(0, Math.min(1, store.settings.captureMultiplier ?? 0.2));

  if (!store.daily || typeof store.daily !== "object" || Array.isArray(store.daily)) store.daily = {};

  let repairedCount = 0;
  for (const [dKey, rec] of Object.entries(store.daily)) {
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) {
      store.daily[dKey] = createEmptyDailyRecord(dKey, "recorded");
      repairedCount++;
      continue;
    }

    rec.date = dKey;
    if (!["recorded", "estimated", "mixed"].includes(rec.quality)) {
      rec.quality = "recorded";
      repairedCount++;
    }

    if (!rec.activity || typeof rec.activity !== "object" || Array.isArray(rec.activity)) {
      rec.activity = { activeMinutes: 0, focusMinutes: 0, editingSessions: 0, notesOpened: 0, notesEdited: 0 };
      repairedCount++;
    } else {
      for (const field of ["activeMinutes", "focusMinutes", "editingSessions", "notesOpened", "notesEdited"]) {
        const val = rec.activity[field];
        if (!Number.isFinite(val) || val < 0) {
          rec.activity[field] = 0;
          repairedCount++;
        }
      }
      // 每一段专注（来自 Crisp Focus 事件）：形状不对的条目丢掉，不影响其他统计
      if (rec.activity.focusSessions !== undefined) {
        if (!Array.isArray(rec.activity.focusSessions)) {
          delete rec.activity.focusSessions;
          repairedCount++;
        } else {
          const valid = rec.activity.focusSessions.filter((x) => x && typeof x === "object" && /^\d{2}:\d{2}$/.test(x.at)
            && Number.isFinite(x.minutes) && x.minutes >= 0 && x.minutes <= 240 && typeof x.completed === "boolean" && typeof x.pomodoro === "boolean"
            && (x.note === undefined || x.note === null || typeof x.note === "string")).slice(-200);
          if (valid.length !== rec.activity.focusSessions.length) { rec.activity.focusSessions = valid; repairedCount++; }
        }
      }
      // 24 小时分布只从开始按小时记录的那天起存在；形状不对就当作没记录，不伪造零。
      if (rec.activity.hourly !== undefined) {
        if (!Array.isArray(rec.activity.hourly) || rec.activity.hourly.length !== 24) {
          delete rec.activity.hourly;
          repairedCount++;
        } else {
          rec.activity.hourly = rec.activity.hourly.map((v) => {
            if (Number.isFinite(v) && v >= 0) return v;
            repairedCount++;
            return 0;
          });
        }
      }
    }

    if (!rec.contribution || typeof rec.contribution !== "object" || Array.isArray(rec.contribution)) {
      rec.contribution = {
        score: 0,
        meaningfulEdits: 0,
        notesCreated: 0,
        wordsAdded: 0,
        wordsRemoved: 0,
        tasksCompleted: 0,
        linksCreated: 0,
        captureWords: 0,
        rewrittenWords: 0
      };
      repairedCount++;
    } else {
      for (const field of ["score", "meaningfulEdits", "notesCreated", "wordsAdded", "wordsRemoved", "tasksCompleted", "linksCreated", "captureWords", "rewrittenWords"]) {
        const val = rec.contribution[field];
        if (!Number.isFinite(val) || val < 0) {
          rec.contribution[field] = 0;
          repairedCount++;
        }
      }
    }

    if (!rec.files || typeof rec.files !== "object" || Array.isArray(rec.files)) {
      rec.files = {};
      repairedCount++;
    } else {
      for (const [fp, fileMeta] of Object.entries(rec.files)) {
        if (!fileMeta || typeof fileMeta !== "object" || Array.isArray(fileMeta)) {
          rec.files[fp] = { wordsAdded: 0, created: false, tasks: 0, links: 0 };
          repairedCount++;
        } else {
          if (!Number.isFinite(fileMeta.wordsAdded)) fileMeta.wordsAdded = 0;
          if (typeof fileMeta.created !== "boolean") fileMeta.created = false;
          if (!Number.isFinite(fileMeta.tasks)) fileMeta.tasks = 0;
          if (!Number.isFinite(fileMeta.links)) fileMeta.links = 0;
          if (fileMeta.createdBase !== undefined && (!fileMeta.createdBase || typeof fileMeta.createdBase !== "object" || Array.isArray(fileMeta.createdBase))) delete fileMeta.createdBase;
        }
      }
    }

    if (!Number.isFinite(rec.intensity) || rec.intensity < 0) {
      rec.intensity = 0;
    }
  }

  if (store.reviewDrafts && typeof store.reviewDrafts === "object" && !Array.isArray(store.reviewDrafts)) {
    for (const [draftKey, draft] of Object.entries(store.reviewDrafts)) {
      if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
        delete store.reviewDrafts[draftKey];
        repairedCount++;
        continue;
      }
      if (Array.isArray(draft.actions)) {
        const validActions = [];
        for (const a of draft.actions) {
          if (!a || typeof a !== "object" || Array.isArray(a)) {
            repairedCount++;
            continue;
          }
          let changed = false;
          if (typeof a.id !== "string" || !a.id.trim()) { a.id = reviewEntryId(); changed = true; }
          // 标题清空的行动照样保留：完成状态和结果笔记关联不能因为标题暂时为空就丢掉
          if (typeof a.title !== "string") { a.title = typeof a.title === "number" ? String(a.title) : ""; changed = true; }
          if (typeof a.status !== "string" || !Object.hasOwn(REVIEW_ACTION_STATES, a.status)) { a.status = "pending"; changed = true; }
          if (a.outcomePath !== undefined && (typeof a.outcomePath !== "string" || !a.outcomePath.trim())) { delete a.outcomePath; changed = true; }
          if (a.originalOutcomePath !== undefined && (typeof a.originalOutcomePath !== "string" || !a.originalOutcomePath.trim())) { delete a.originalOutcomePath; changed = true; }
          if (changed) repairedCount++;
          validActions.push(a);
        }
        if (validActions.length !== draft.actions.length) repairedCount++;
        draft.actions = validActions;
      }
      if (Array.isArray(draft.evidence)) {
        const validEvidence = [];
        for (const e of draft.evidence) {
          if (!e || typeof e !== "object" || Array.isArray(e)) {
            repairedCount++;
            continue;
          }
          let changed = false;
          if (typeof e.id !== "string" || !e.id.trim()) { e.id = reviewEntryId(); changed = true; }
          if (typeof e.path !== "string" || !e.path.trim()) {
            repairedCount++;
            continue;
          }
          if (typeof e.originalPath !== "string" || !e.originalPath.trim()) { e.originalPath = e.path; changed = true; }
          if (typeof e.quote !== "string") { e.quote = typeof e.quote === "number" ? String(e.quote) : ""; changed = true; }
          if (typeof e.capturedAt !== "string") { e.capturedAt = new Date().toISOString(); changed = true; }
          if (changed) repairedCount++;
          validEvidence.push(e);
        }
        if (validEvidence.length !== draft.evidence.length) repairedCount++;
        draft.evidence = validEvidence;
      }
    }
  } else if (store.reviewDrafts !== undefined) {
    store.reviewDrafts = {};
    repairedCount++;
  }

  if (store.trackingVersion !== 3) {
    if (!store.trackingVersion) {
      for (const record of Object.values(store.daily)) {
        if (record.quality !== "estimated") record.legacyUnverified = true;
      }
    }
    store.trackingVersion = 3;
    store.dirty = true;
  }


  return { store, repairedCount };
}

class CrispPulsePlugin extends Plugin {
  async onload() {
    console.log(`[Crisp Pulse] Initializing plugin (v${this.manifest.version})...`);
    this.saveStatus = "idle";
    this.lastSavedTime = null;
    this.lastSaveError = null;
    this.saveErrorShown = false;

    await this.loadPluginData();

    this.licenseManager = new CrispPulseLicenseManager(this.app, this.settings, {
      onEntitlementChange: () => { if (this.app?.workspace) this.refreshViews(); },
    });
    // 本地验签只需毫秒：先等它完成再创建视图和命令，已激活用户不会先看到一帧锁定界面。
    await this.licenseManager.initialize();

    if (this.settings.showStatusBarItem) {
      this.initStatusBar();
    }

    this.registerView(VIEW_TYPE_PULSE, (leaf) => new CrispPulseView(leaf, this));
    this.memoStore = new MemoStore(this.app, () => this.settings, typeof moment === "function" ? moment : null, {
      // 速记是在 Pulse 输入框里写的：提交时记一笔本人写作证据，统计照常计入
      onOwnWrite: (path) => this.markWritingEvidence(path),
      trashPath: `${this.manifest?.dir || `${this.app.vault?.configDir || ".obsidian"}/plugins/crisp-pulse`}/memo-trash.json`
    });
    this.memoDrafts = new MemoDraftStore(this.app.vault?.adapter, this.manifest?.dir || `${this.app.vault?.configDir || ".obsidian"}/plugins/crisp-pulse`);
    this.registerView(VIEW_TYPE_MEMO, (leaf) => new CrispPulseMemoView(leaf, this));
    this.addRibbonIcon("feather", tr("打开 Crisp Pulse 速记", "Open Crisp Pulse memos"), () => this.activateMemoView());
    this.addCommand({ id: "open-memo-view", name: tr("打开速记", "Open memos"), callback: () => this.activateMemoView() });
    this.addCommand({
      id: "toggle-memo-dictation",
      name: tr("速记：开始 / 结束实时听写", "Memos: start / stop live dictation"),
      checkCallback: (checking) => {
        if (!this.memoDictationAsr()) return false;
        if (!checking) void this.toggleMemoDictation();
        return true;
      }
    });
    this.addCommand({
      id: "quick-memo",
      name: tr("记一条速记", "Capture a memo"),
      callback: () => new CrispPulseMemoInputModal(this.app, tr("记一条速记", "Capture a memo"), tr("现在的想法是…", "What’s on your mind…"), "", async (text) => {
        await this.memoStore.capture(text, new Date());
        new Notice(tr("Crisp Pulse：已记录速记", "Crisp Pulse: memo saved"));
        this.refreshMemoViews();
      }).open()
    });
    if (this.app.workspace?.on) {
      this.registerEvent(this.app.workspace.on("crisp-focus:session", (event) => { void this.handleFocusSessionEvent(event); }));
    }
    if (this.app.metadataCache?.on) {
      this.registerEvent(this.app.metadataCache.on("changed", (file, data) => {
        if (typeof data === "string" && data.includes("[!memo]")) this.refreshMemoViews();
      }));
    }
    if (this.app.vault?.on) {
      // 原来有速记块的笔记改了也要刷新：删掉最后一条后新内容里已经没有 [!memo]
      this.registerEvent(this.app.vault.on("modify", (file) => { if (this.memoStore.forgetParsed(file.path)) this.refreshMemoViews(); }));
      this.registerEvent(this.app.vault.on("delete", (file) => { this.memoStore.forgetParsed(file?.path); this.refreshMemoViews(); }));
      this.registerEvent(this.app.vault.on("rename", (file, oldPath) => { this.memoStore.forgetParsed(oldPath); this.memoStore.forgetParsed(file?.path); this.refreshMemoViews(); }));
    }
    this.registerObsidianProtocolHandler?.("crisp-pulse-memo", (params) => this.handleMemoUrl(params));
    this.registerInterval(window.setInterval(() => { this.checkMemoReviewReminder().catch(() => {}); }, 60000));
    crispPulseRegisterIcons();
    this.addRibbonIcon(CRISP_PULSE_ICON_ID, tr("打开 Crisp Pulse 年度知识看板", "Open the Crisp Pulse dashboard"), () => {
      this.activatePulseView();
    });

    this.addCommand({
      id: "open-crisp-pulse-view",
      name: tr("打开年度知识工作看板 (Pulse View)", "Open the knowledge work dashboard (Pulse View)"),
      callback: () => this.activatePulseView()
    });

    this.addCommand({
      id: "copy-pulse-weekly-markdown",
      name: tr("复制本周工作复盘 Markdown 周报", "Copy this week’s review as Markdown"),
      callback: async () => {
        if (!this.requireEntitlement("weeklyReport")) return;
        const today = new Date();
        const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6);
        const sKey = dateKey(start), eKey = dateKey(today);
        const model = this.getReviewModel(sKey, eKey, this.settings.dataQualityScope);
        const md = generateReviewReport(model);
        try {
          await navigator.clipboard.writeText(md);
          new Notice(tr("已成功复制本周工作复盘周报至剪贴板！", "This week’s review was copied to the clipboard."));
        } catch (e) {
          new Notice(tr("复制失败，请检查剪贴板权限后重试。", "Copy failed. Check clipboard permissions and try again."));
        }
      }
    });

    this.addCommand({
      id: "export-pulse-csv",
      name: tr("导出知识脉冲数据 (CSV)", "Export Pulse data (CSV)"),
      callback: () => this.exportCSVFile()
    });

    this.addCommand({
      id: "export-pulse-json",
      name: tr("导出知识脉冲数据 (JSON 备份)", "Export Pulse data (JSON backup)"),
      callback: () => this.exportJSONFile()
    });

    this.addCommand({
      id: "retry-save-pulse-data",
      name: tr("立即重试保存知识脉冲数据", "Retry saving Pulse data now"),
      callback: async () => {
        new Notice(tr("Crisp Pulse：正在保存数据...", "Crisp Pulse: saving data..."));
        const res = await this.savePluginData({ throwOnError: false });
        if (res.success) {
          new Notice(tr("Crisp Pulse：数据已成功保存！", "Crisp Pulse: data saved."));
        } else {
          new Notice(tr("Crisp Pulse：保存依然失败，请查看控制台日志。", "Crisp Pulse: saving still failed. Check the console log."));
        }
      }
    });

    this.addCommand({
      id: "create-pulse-backup",
      name: tr("创建知识脉冲数据备份快照", "Create a Pulse data backup snapshot"),
      callback: async () => {
        new Notice(tr("Crisp Pulse：正在创建备份...", "Crisp Pulse: creating backup..."));
        const res = await this.createBackup("manual");
        if (res.success) {
          new Notice(tr(`Crisp Pulse：备份成功（${res.fileName}）`, `Crisp Pulse: backup created (${res.fileName})`));
        } else {
          new Notice(tr("Crisp Pulse：备份失败：", "Crisp Pulse: backup failed: ") + (res.error?.message || res.error));
        }
      }
    });

    this.addCommand({
      id: "rebuild-estimated-history",
      name: tr("重新估算历史知识脉冲数据", "Re-estimate historical Pulse data"),
      callback: async () => {
        await this.runHistoricalBackfill(true);
        new Notice(tr("Crisp Pulse: 历史数据重新估算完成", "Crisp Pulse: historical data re-estimated"));
        this.refreshViews();
      }
    });

    this.addCommand({
      id: "archive-weekly-review",
      name: tr("归档本周工作复盘至知识库 (ANKS Review)", "Archive this week’s review to the vault (ANKS Review)"),
      callback: async () => {
        if (!this.requireEntitlement("weeklyReport")) return;
        const today = new Date();
        const startWeek = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6);
        const sKey = dateKey(startWeek), eKey = dateKey(today);
        const model = this.getReviewModel(sKey, eKey, this.settings.dataQualityScope);
        // archiveReviewReport already reports success, existing files and failures.
        await this.archiveReviewReport(model);
      }
    });

    this.addCommand({
      id: "start-crisp-focus-session",
      name: tr("开启 25 分钟 Crisp Focus 专注", "Start a 25-minute Crisp Focus session"),
      callback: async () => {
        await this.focusAdapter?.startFocusSession(25);
      }
    });

    this.addSettingTab(new CrispPulseSettingTab(this.app, this));

    this.fileSnapshots = new Map();
    this.activeSessions = new Map();
    this.fileQueues = new Map();
    this.lastInteractionTime = null;
    this.focusAdapter = new CrispFocusAdapter(this);

    this.registerActivityListeners();

    this.registerInterval(
      window.setInterval(() => {
        this.checkIdleSessions();
        if (this.focusAdapter?.isFocusRunning()) {
          this.updateStatusBar();
        }
      }, 30000)
    );

    this.app.workspace.onLayoutReady(async () => {
      this.focusAdapter.attach();
      await this.initializeSnapshots();
      if (this.stopped) return;
      this.registerVaultEvents();
      // Obsidian 关着或 Pulse 停用时删掉的当天新建笔记，启动时补一次撤回
      if (this.rollbackSameDayCreations((path) => !this.app.vault.getAbstractFileByPath(path))) {
        await this.savePluginData();
        this.refreshViews();
      }
      if (!this.settings.hasRunBackfill) {
        console.log("[Crisp Pulse] Running initial historical backfill...");
        await this.runHistoricalBackfill(false);
        this.settings.hasRunBackfill = true;
        await this.savePluginData();
      }
      this.updateStatusBar();
    });
  }

  onunload() {
    console.log("[Crisp Pulse] Unloading plugin...");
    this.stopped = true;
    if (this.snapshotSyncTimer) clearTimeout(this.snapshotSyncTimer);
    this.focusAdapter?.detach();
    this.flushAllSessions();
    // 卸载快照已排进共用写入队列；此后旧实例迟到的保存不再落盘，免得盖掉新实例的设置和统计
    this.storeRetired = true;
    this.memoDrafts?.retire();
  }

  /** data.json 的写入队列：挂在 vault adapter 上按文件路径共用，插件重载后新旧实例排同一条队。 */
  storeWriteQueue() {
    const adapter = this.app?.vault?.adapter;
    if (!adapter || typeof adapter !== "object" || !this.storeFilePath()) return null;
    try { return adapter[PULSE_STORE_WRITES] ||= new Map(); } catch (_) { return null; }
  }

  storeFilePath() {
    return this.manifest?.dir ? `${this.manifest.dir}/data.json` : null;
  }

  // Obsidian's loadData() yields null for a missing file but undefined when data.json exists and cannot be
  // read or parsed (sync conflict, partial write). Never let defaults overwrite such a file.
  async handleUnreadableStore() {
    this.storeLoadFailed = true;
    const path = this.storeFilePath();
    const adapter = this.app?.vault?.adapter;
    try {
      if (path && typeof adapter?.read === "function" && typeof adapter?.write === "function") {
        const raw = await adapter.read(path);
        const backupDir = `${this.manifest.dir}/backups`;
        if (typeof adapter.exists === "function" && !(await adapter.exists(backupDir)) && typeof adapter.mkdir === "function") await adapter.mkdir(backupDir);
        const d = new Date();
        const ts = `${dateKey(d).replace(/-/g, "")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;
        await adapter.write(`${backupDir}/data-unreadable-${ts}.json`, raw);
      }
    } catch (error) {
      console.error("[Crisp Pulse] Could not copy unreadable data.json:", error);
    }
    console.error("[Crisp Pulse] data.json could not be read; saving is paused to protect it.");
    new Notice(tr("Crisp Pulse：无法读取统计文件 data.json（可能是同步冲突或写入中断）。原文件已保留并在 backups 里复制了一份，本次运行暂停保存。修复或恢复该文件后请重启 Obsidian。", "Crisp Pulse: cannot read the stats file data.json (possibly a sync conflict or an interrupted write). The original file was kept and a copy was placed in backups; saving is paused for this session. Restart Obsidian after repairing or restoring the file."), 0);
  }

  // saveData() swallows write errors in Obsidian, so read the file back before calling a save successful.
  async verifyStoreWrite(payload) {
    const path = this.storeFilePath();
    const adapter = this.app?.vault?.adapter;
    if (!path || typeof adapter?.read !== "function") return;
    let onDisk;
    try {
      onDisk = JSON.stringify(JSON.parse(await adapter.read(path)));
    } catch (error) {
      throw new Error(tr(`data.json 写入后无法读回：${error?.message || error}`, `data.json could not be read back after writing: ${error?.message || error}`));
    }
    if (onDisk !== JSON.stringify(payload)) throw new Error(tr("data.json 未写入：磁盘内容与待保存数据不一致", "data.json was not written: the file on disk does not match the data being saved"));
  }

  async loadPluginData() {
    // 旧实例卸载前排进队列的保存全部落盘后再读，读到的才是最新数据
    await this.storeWriteQueue()?.get(this.storeFilePath());
    const raw = await this.loadData();
    if (raw === undefined) await this.handleUnreadableStore();
    const { store, repairedCount } = validateAndRepairStore(raw, DEFAULT_SETTINGS);
    this.store = store;
    this.settings = this.store.settings;
    if (repairedCount > 0) {
      console.log(`[Crisp Pulse] Schema validator repaired ${repairedCount} issues in pulse store.`);
      this.dirty = true;
    }
    if (this.store.dirty) {
      this.dirty = true;
      delete this.store.dirty;
    }
  }

  async savePluginData({ throwOnError = false } = {}) {
    if (this.storeLoadFailed) {
      // Keep collected changes pending; writing now would replace the unreadable history with defaults.
      this.saveStatus = "error";
      const error = new Error(tr("data.json 读取失败，已暂停保存以保护原文件", "Failed to read data.json; saving is paused to protect the original file"));
      this.lastSaveError = error;
      this.updateStatusBar?.();
      if (throwOnError) throw error;
      return { success: false, reason: "load_failed", error };
    }
    if (this.storeRetired) {
      const error = new Error(tr("插件已重新加载，旧实例不再保存", "The plugin was reloaded; the old instance no longer saves"));
      if (throwOnError) throw error;
      return { success: false, reason: "retired", error };
    }
    this.store.settings = this.settings;
    this.saveStatus = "saving";
    this.dirty = false;
    const payload = JSON.parse(JSON.stringify(this.store));

    const queue = this.storeWriteQueue();
    const path = this.storeFilePath();
    const currentSave = ((queue && queue.get(path)) || this.saveQueue || Promise.resolve())
      .catch(() => {})
      .then(async () => {
        await this.saveData(payload);
        await this.verifyStoreWrite(payload);
        this.saveStatus = "idle";
        this.lastSavedTime = Date.now();
        this.lastSaveError = null;
        this.saveErrorShown = false;
        return { success: true, savedAt: this.lastSavedTime };
      })
      .catch((error) => {
        this.dirty = true;
        this.saveStatus = "error";
        this.lastSaveError = error;
        console.error("[Crisp Pulse] Save failed:", error);
        if (!this.saveErrorShown) {
          new Notice(tr("Crisp Pulse：统计保存失败，将在下一次检查重试。", "Crisp Pulse: failed to save stats; will retry at the next check."));
          this.saveErrorShown = true;
        }
        if (throwOnError) {
          throw error;
        }
        return { success: false, error };
      });

    this.saveQueue = currentSave;
    queue?.set(path, currentSave.catch(() => {}));
    const result = await currentSave;
    this.updateStatusBar();
    return result;
  }

  async saveSettings() {
    for (const record of Object.values(this.store.daily)) this.recomputeScore(record);
    await this.savePluginData({ throwOnError: true });
    this.refreshViews();
  }

  isEntitled() {
    return this.licenseManager?.isEntitled() === true;
  }

  // 命令层门控：未激活时提示并返回 false，调用方直接 return。
  requireEntitlement(featureKey) {
    if (this.isEntitled()) return true;
    new Notice(tr(`Crisp Pulse：${PULSE_GATED_FEATURES[featureKey] || "该功能"}需要激活。请在 设置 → Crisp Pulse 输入 Crisp 授权码；数据仍在照常记录。`, `Crisp Pulse: ${PULSE_GATED_FEATURES[featureKey] || "This feature"} requires activation. Enter your Crisp license code in Settings → Crisp Pulse; data is still being recorded as usual.`));
    return false;
  }

  openLicenseSettings() {
    const setting = this.app?.setting;
    if (setting?.open && setting?.openTabById) {
      setting.open();
      setting.openTabById(this.manifest?.id || "crisp-pulse");
    } else {
      new Notice(tr("请在 设置 → Crisp Pulse 输入 Crisp 授权码。", "Enter your Crisp license code in Settings → Crisp Pulse."));
    }
  }

  async activateLicense(code) {
    if (!this.licenseManager) {
      this.licenseManager = new CrispPulseLicenseManager(this.app, this.settings);
    }
    const result = await this.licenseManager.verify(code);
    await this.saveSettings();
    return result;
  }

  async refreshLicense() {
    if (!this.licenseManager) {
      this.licenseManager = new CrispPulseLicenseManager(this.app, this.settings);
    }
    return await this.licenseManager.verify();
  }

  createBackup(reason = "manual") {
    const pending = (this.backupQueue || Promise.resolve()).catch(() => {}).then(() => this.writeBackup(reason));
    this.backupQueue = pending;
    return pending;
  }

  async writeBackup(reason) {
    try {
      const adapter = this.app?.vault?.adapter;
      const baseDir = this.manifest?.dir || ".obsidian/plugins/crisp-pulse";
      const backupDir = `${baseDir}/backups`;

      const now = new Date();
      const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
      const safeReason = String(reason).replace(/[^a-zA-Z0-9-]/g, "-") || "manual";
      let existingFiles = [];
      if (adapter?.list && (!adapter.exists || await adapter.exists(backupDir))) {
        existingFiles = (await adapter.list(backupDir))?.files || [];
      }
      let fileName;
      let filePath;
      do {
        this.backupSequence = (this.backupSequence || 0) + 1;
        fileName = `pulse-backup-${ts}-${String(this.backupSequence).padStart(6, "0")}-${safeReason}.json`;
        filePath = `${backupDir}/${fileName}`;
      } while (existingFiles.includes(filePath));
      const payload = JSON.stringify(this.store, null, 2);

      if (adapter && typeof adapter.write === "function") {
        if (typeof adapter.exists === "function" && !(await adapter.exists(backupDir))) {
          if (typeof adapter.mkdir === "function") await adapter.mkdir(backupDir);
        }
        await adapter.write(filePath, payload);

        if (typeof adapter.list === "function") {
          const list = await adapter.list(backupDir);
          const files = (list?.files || []).filter(f => f.startsWith(`${backupDir}/`) &&
            /^pulse-backup-\d{8}-\d{6}-(?:\d{6}-)?[a-zA-Z0-9-]+\.json$/.test(f.slice(backupDir.length + 1))).sort();
          if (files.length > 5) {
            const toRemove = files.slice(0, files.length - 5);
            for (const rmPath of toRemove) {
              if (typeof adapter.remove === "function") await adapter.remove(rmPath);
            }
          }
        }
      } else {
        throw new Error(tr("备份存储不可用，已取消操作。", "Backup storage is unavailable; the operation was cancelled."));
      }

      console.log(`[Crisp Pulse] Backup created: ${filePath}`);
      return { success: true, path: filePath, fileName };
    } catch (err) {
      console.error("[Crisp Pulse] Backup creation failed:", err);
      return { success: false, error: err };
    }
  }

  async saveExportFile(fileName, content, type) {
    if (Platform.isMobile) {
      // Mobile webviews ignore download links; write next to the vault root instead.
      try {
        const dot = fileName.lastIndexOf(".");
        let path = fileName;
        for (let i = 2; await this.app.vault.adapter.exists(path); i++) path = `${fileName.slice(0, dot)}-${i}${fileName.slice(dot)}`;
        if (typeof content !== 'string') await this.app.vault.createBinary(path, content);
        else await this.app.vault.create(path, content);
        new Notice(tr(`已导出到库根目录：${path}`, `Exported to the vault root: ${path}`));
        return { success: true, path };
      } catch (error) {
        console.error("[Crisp Pulse] Export failed:", error);
        new Notice(tr("导出失败：", "Export failed: ") + (error?.message || error));
        return { success: false, error };
      }
    }
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    // Revoking synchronously can cancel the download before it starts.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { success: true };
  }

  async exportCSVFile() {
    const res = await this.saveExportFile(`crisp-pulse-export-${getTodayKey()}.csv`, generateDailyCSV(this.store.daily || {}), "text/csv;charset=utf-8;");
    if (res.success && !res.path) new Notice(tr("已导出 CSV 数据", "CSV data exported"));
  }

  async exportJSONFile() {
    // Backups can land inside a synced vault on mobile; keep the license code out of them.
    const { licenseCode, licenseLastOnlineAt, ...settings } = this.store.settings || {};
    const res = await this.saveExportFile(`crisp-pulse-backup-${getTodayKey()}.json`, JSON.stringify({ ...this.store, settings }, null, 2), "application/json;charset=utf-8;");
    if (res.success && !res.path) new Notice(tr("已导出 JSON 备份", "JSON backup exported"));
  }

  getOrCreateTodayRecord() {
    return this.getOrCreateRecord(getTodayKey());
  }

  getOrCreateRecord(today) {
    if (!this.store.daily[today]) {
      this.store.daily[today] = createEmptyDailyRecord(today, "recorded");
    }
    if (this.store.daily[today].quality === "estimated") this.store.daily[today].quality = "mixed";
    return this.store.daily[today];
  }

  // --- Status Bar ---
  initStatusBar() {
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.classList.add("crisp-pulse-status");
    this.statusBarEl.setAttr("aria-label", tr("Crisp Pulse 知识脉冲", "Crisp Pulse"));
    this.statusBarEl.setAttr("role", "button");
    this.statusBarEl.tabIndex = 0;
    this.registerDomEvent(this.statusBarEl, "keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.activatePulseView();
      }
    });

    this.statusBarEl.addEventListener("click", () => {
      this.activatePulseView();
    });

    this.updateStatusBar();
  }

  updateStatusBar() {
    if (!this.statusBarEl) return;
    const todayRecord = this.store.daily[getTodayKey()] || createEmptyDailyRecord(getTodayKey());
    const score = todayRecord.contribution.score || 0;
    const stats = this.calcStats(this.settings.dataQualityScope, "year");
    const streak = stats.currentStreak || 0;

    this.statusBarEl.empty();

    const isFocusing = this.focusAdapter?.isFocusRunning();
    this.statusBarEl.classList.toggle("is-focusing", !!isFocusing);

    const iconSpan = document.createElement("span");
    iconSpan.className = "crisp-pulse-status-icon";
    iconSpan.textContent = "⚡";

    const textSpan = document.createElement("span");
    textSpan.className = "crisp-pulse-status-text";
    textSpan.textContent = `${score.toFixed(0)} | 🔥 ${streak}d`;

    this.statusBarEl.appendChild(iconSpan);
    this.statusBarEl.appendChild(textSpan);

    if (isFocusing) {
      const focusSpan = document.createElement("span");
      focusSpan.className = "crisp-pulse-status-focus-dot";
      focusSpan.textContent = " 🎯";
      this.statusBarEl.appendChild(focusSpan);
    }

    if (this.saveStatus === "error") {
      const warnSpan = document.createElement("span");
      warnSpan.className = "crisp-pulse-status-warn";
      warnSpan.textContent = " ⚠️";
      this.statusBarEl.appendChild(warnSpan);
    }

    const scopeName = REVIEW_SCOPE_LABELS[this.settings.dataQualityScope] || this.settings.dataQualityScope;
    let tooltip = tr(`Crisp Pulse 今日知识脉冲\n今日贡献: ${score.toFixed(1)} 分\n连续活跃: ${streak} 天 (范围: ${scopeName})\n新建笔记: ${todayRecord.contribution.notesCreated} 篇\n新增字数: ${todayRecord.contribution.wordsAdded} 词`,
      `Crisp Pulse · Today\nContribution: ${score.toFixed(1)} pts\nStreak: ${plural(streak, "day")} (scope: ${scopeName})\nNotes created: ${todayRecord.contribution.notesCreated}\nWords added: ${todayRecord.contribution.wordsAdded}`);
    if (isFocusing) {
      const remainingMs = this.focusAdapter.getFocusRemainingMs();
      const mins = Math.ceil(remainingMs / 60000);
      tooltip += tr(`\n🎯 Crisp Focus 正在专注中 (剩余约 ${mins} 分钟)`, `\n🎯 Crisp Focus session in progress (about ${mins} min left)`);
    }
    tooltip += tr(`\n点击打开年度知识看板`, `\nClick to open the dashboard`);
    if (this.saveStatus === "error") {
      tooltip += tr(`\n\n⚠️ 警告：统计数据最近一次写盘失败，将在30秒后自动重试，或可在命令面板执行“立即重试保存知识脉冲数据”。`, `\n\n⚠️ Warning: the last save of the stats failed. It will retry automatically in 30 seconds, or run “Retry saving Pulse data now” from the command palette.`);
    }
    this.statusBarEl.setAttr("aria-label", tooltip);
  }

  // 1.3.0 Ecosystem: Handle Crisp Focus completed session
  /* Crisp Focus 1.5.0 起的会话事件。完成的专注照旧计入专注分钟（参与贡献分）；中途结束的只记录，不计分，
     免得开了就停也能刷分。休息只用来提示记速记。 */
  async handleFocusSessionEvent(event) {
    if (!this.settings.enableCrispFocusSync || !event || !(Number(event.apiVersion) >= 1) || this.stopped) return;
    // 只有结束事件会写记录，按 id 去重防止记两次；暂停、继续一轮里可以有多次，照原样跟随
    if (event.type === "complete" || event.type === "stop") {
      const key = `${event.id}:${event.type}`;
      this.focusEventsSeen ||= new Set();
      if (this.focusEventsSeen.has(key)) return;
      this.focusEventsSeen.add(key);
      if (this.focusEventsSeen.size > 200) this.focusEventsSeen.delete(this.focusEventsSeen.values().next().value);
    }
    if (event.kind === "break") {
      this.pomodoroBreak = event.type === "start" || event.type === "resume" ? { id: event.id, phase: event.phase, dismissed: this.pomodoroBreak?.id === event.id && this.pomodoroBreak.dismissed } : null;
      this.refreshMemoComposerStatus();
    } else if (event.type === "start") {
      this.pomodoroBreak = null;
      this.refreshMemoComposerStatus();
    }
    if (event.kind === "focus" && (event.type === "complete" || event.type === "stop")) {
      const completed = event.type === "complete";
      const minutes = completed ? Math.max(1, Math.round(Number(event.plannedMinutes) || 0)) : Math.floor((Number(event.elapsedMs) || 0) / 60000);
      // 不到 1 分钟就结束的不留记录
      if (completed || minutes >= 1) {
        const started = new Date(Number(event.startedAt) || Date.now());
        const today = this.getOrCreateTodayRecord();
        if (!Array.isArray(today.activity.focusSessions)) today.activity.focusSessions = [];
        today.activity.focusSessions.push({
          at: `${String(started.getHours()).padStart(2, "0")}:${String(started.getMinutes()).padStart(2, "0")}`,
          minutes: Math.min(240, minutes), completed, pomodoro: !!event.pomodoro,
          note: typeof event.notePath === "string" ? event.notePath : null,
        });
        this.dirty = true;
        if (completed) await this.handleFocusSessionCompleted(minutes, { quiet: !!event.pomodoro });
        else { await this.savePluginData(); this.refreshViews(); }
      }
    } else {
      this.refreshViews();
    }
    this.updateStatusBar();
  }

  /** 速记面板的状态行跟着番茄钟的休息变化。 */
  refreshMemoComposerStatus() {
    for (const leaf of this.app.workspace?.getLeavesOfType?.(VIEW_TYPE_MEMO) || []) leaf.view?.updateRecordingUi?.();
  }

  async handleFocusSessionCompleted(minutes, { quiet = false } = {}) {
    if (!this.settings.enableCrispFocusSync) return;
    const mins = Math.max(1, Math.round(Number(minutes) || 25));
    const today = this.getOrCreateTodayRecord();
    today.activity.focusMinutes = (today.activity.focusMinutes || 0) + mins;
    this.dirty = true;
    this.recomputeScore(today);
    await this.savePluginData();
    this.updateStatusBar();
    this.refreshViews();

    if (quiet) return; // 番茄钟自己会提示「第 N 个番茄完成」，这里不再叠一条
    const bonus = this.settings.includeFocusInContribution
      ? tr(`（+${(mins * (this.settings.weightFocusMinute ?? 0.05)).toFixed(1)} 贡献分）`, ` (+${(mins * (this.settings.weightFocusMinute ?? 0.05)).toFixed(1)} pts)`)
      : "";
    new Notice(tr(`Crisp Focus: 专注 ${mins} 分钟已计入今日知识脉冲！${bonus}`, `Crisp Focus: ${mins} focus minutes added to today’s Pulse.${bonus}`));
  }

  // 1.3.0 ANKS Vault: Archive Weekly Review note
  async archiveWeeklyReviewToVault(reviewData, startKey, endKey, report = null) {
    const rawFolder = (this.settings.reviewArchiveFolder || "Topics/self-media/outputs/reviews").trim();
    if (/(?:^|\/)\.\.(?:\/|$)/.test(rawFolder) || rawFolder.startsWith("/") || rawFolder.includes("\\")) {
      return { success: false, reason: "invalid_path", error: new Error("Invalid archive path escaping vault") };
    }
    const targetFolder = rawFolder.replace(/^\/+|\/+$/g, "");
    const isoWeek = getIsoWeekString(new Date());
    const fileName = report?.fileName || `${isoWeek}-知识工作周报.md`;
    const fullPath = targetFolder ? `${targetFolder}/${fileName}` : fileName;

    if (targetFolder && this.app?.vault?.adapter) {
      const parts = targetFolder.split("/");
      let cur = "";
      for (const part of parts) {
        cur = cur ? `${cur}/${part}` : part;
        const exists = await this.app.vault.adapter.exists(cur);
        if (!exists) {
          try {
            await this.app.vault.createFolder(cur);
          } catch (e) {
            // Already created or concurrent
          }
        }
      }
    }

    const title = tr(`${isoWeek} 知识工作周报 (${startKey} ~ ${endKey})`, `${isoWeek} Weekly Knowledge Work Report (${startKey} ~ ${endKey})`);
    const content = report?.content || generateAnksWeeklyReviewFileContent(reviewData, title, `${startKey} ~ ${endKey}`);

    try {
      const fileExists = this.app?.vault?.adapter?.exists ? await this.app.vault.adapter.exists(fullPath) : false;
      let targetFile;
      if (fileExists) {
        new Notice(tr(`周报已存在，保留原文：${fullPath}`, `The report already exists; the original was kept: ${fullPath}`));
        return { success: false, reason: "exists", path: fullPath };
      } else {
        targetFile = await this.app.vault.create(fullPath, content);
      }

      new Notice(tr(`Crisp Pulse: 周报已成功归档至 ${fullPath}`, `Crisp Pulse: report archived to ${fullPath}`));
      if (targetFile) {
        this.app.workspace.openLinkText(targetFile.path, "");
      }
      return { success: true, path: fullPath, fileName };
    } catch (err) {
      console.error("[Crisp Pulse] Archive weekly review failed:", err);
      new Notice(tr("周报归档失败：", "Failed to archive the report: ") + (err?.message || err));
      return { success: false, error: err };
    }
  }

  async activatePulseView() {
    const { workspace } = this.app;
    let leaf = null;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_PULSE);

    if (leaves.length > 0) {
      leaf = leaves[0];
      workspace.revealLeaf(leaf);
    } else {
      leaf = workspace.getLeaf(true);
      await leaf.setViewState({
        type: VIEW_TYPE_PULSE,
        active: true
      });
    }
  }

  getBannerImageFile() {
    const path = this.settings.headerBannerImage;
    const file = path ? this.app.vault.getAbstractFileByPath(path) : null;
    return file instanceof TFile && PULSE_BANNER_IMAGE_EXTENSIONS.has(String(file.extension).toLowerCase()) ? file : null;
  }

  refreshViews() {
    this.updateStatusBar();
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_PULSE);
    for (const leaf of leaves) {
      if (leaf.view instanceof CrispPulseView) {
        leaf.view.render();
      }
    }
  }

  async initializeSnapshots(files = this.app.vault.getMarkdownFiles()) {
    const concurrency = 16;
    let index = 0;
    const worker = async () => {
      while (index < files.length && !this.stopped) {
        const file = files[index++];
        if (!this.shouldTrackPath(file.path)) {
          continue;
        }
        try {
          const content = await this.readTrackedFile(file);
          if (content === null) continue;
          this.fileSnapshots.set(file.path, {
            words: countWords(content),
            tasks: countTasks(content),
            links: countLinks(content),
            lineSet: getLineSet(content),
            completedTaskSet: getCompletedTaskSet(content),
            lastTime: file.stat?.mtime || Date.now()
          });
        } catch (e) {
          console.error("[Crisp Pulse] Baseline read failed for:", file.path, e);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, files.length || 1) }, worker));
  }

  // --- Tracking & Session Engine ---
  registerVaultEvents() {
    this.registerEvent(
      this.app.vault.on("create", async (file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        if (!this.shouldTrackPath(file.path)) {
          return;
        }

        return this.handleFileCreation(file);
      })
    );

    this.registerEvent(
      this.app.vault.on("modify", async (file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        if (!this.shouldTrackPath(file.path)) {
          return;
        }
        await this.handleFileModification(file);
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        this.invalidateFileReads(file.path);
        // A deleted folder takes its notes with it; stale snapshots would hide a later re-creation.
        const isGone = path => path === file.path || path.startsWith(`${file.path}/`);
        for (const path of [...this.fileSnapshots.keys()]) if (isGone(path)) this.fileSnapshots.delete(path);
        for (const path of [...this.fileQueues.keys()]) if (isGone(path)) this.fileQueues.delete(path);
        const createdToday = new Set(Object.keys(this.store.daily[getTodayKey()]?.files || {}).filter((path) => isGone(path) && this.store.daily[getTodayKey()].files[path]?.created));
        for (const [path, session] of [...this.activeSessions.entries()]) {
          if (!isGone(path)) continue;
          // 当天新建又删掉的笔记，编辑会话也不算
          if (!createdToday.has(path)) this.closeSession(session, path);
          this.activeSessions.delete(path);
        }
        if (this.rollbackSameDayCreations(isGone)) {
          void this.savePluginData().then(() => { this.updateStatusBar(); this.refreshViews(); });
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", async (file, oldPath) => {
        const isFolder = !file.extension;
        const migratePath = path => path === oldPath || (isFolder && path.startsWith(`${oldPath}/`))
          ? file.path + path.slice(oldPath.length) : path;
        this.invalidateFileReads(oldPath, migratePath);
        // Keep one serial queue across an included rename: a newer destination edit must wait
        // for the same note's earlier read instead of racing it under a different path key.
        for (const [key, queue] of [...this.fileQueues.entries()]) {
          const next = migratePath(key);
          if (next === key) continue;
          this.fileQueues.delete(key);
          if (this.shouldTrackPath(key) && this.shouldTrackPath(next)) this.fileQueues.set(next, queue);
        }

        const filesToBaseline = [];
        if (!isFolder && file.extension === 'md') {
          const wasTracked = this.shouldTrackPath(oldPath);
          const isTracked = this.shouldTrackPath(file.path);
          if (!wasTracked && isTracked) {
            filesToBaseline.push(file);
          }
        } else if (isFolder) {
          const allMd = typeof this.app.vault.getMarkdownFiles === 'function' ? this.app.vault.getMarkdownFiles() : [];
          for (const f of allMd) {
            if (f.path.startsWith(`${file.path}/`)) {
              const oldFp = oldPath + f.path.slice(file.path.length);
              if (!this.shouldTrackPath(oldFp) && this.shouldTrackPath(f.path)) {
                filesToBaseline.push(f);
              }
            }
          }
        }

        for (const [key, snap] of Array.from(this.fileSnapshots.entries())) {
          const next = migratePath(key);
          if (next !== key) {
            this.fileSnapshots.delete(key);
            if (this.shouldTrackPath(next) && this.shouldTrackPath(key)) {
              this.fileSnapshots.set(next, snap);
            }
          }
        }
        for (const [key, sess] of Array.from(this.activeSessions.entries())) {
          const next = migratePath(key);
          if (next !== key) {
            this.activeSessions.delete(key);
            if (this.shouldTrackPath(next) && this.shouldTrackPath(key)) {
              this.activeSessions.set(next, sess);
            } else {
              this.closeSession(sess, key);
            }
          }
        }
        if (filesToBaseline.length > 0) {
          await this.initializeSnapshots(filesToBaseline);
        }
        for (const draft of Object.values(this.store.reviewDrafts || {})) {
          for (const evidence of (Array.isArray(draft?.evidence) ? draft.evidence : [])) {
            if (typeof evidence?.path !== 'string') continue;
            const next = migratePath(evidence.path);
            if (next !== evidence.path) { evidence.originalPath ||= evidence.path;evidence.path = next;this.dirty = true; }
          }
          for (const action of (Array.isArray(draft?.actions) ? draft.actions : [])) {
            if (typeof action?.outcomePath !== 'string') continue;
            const next = migratePath(action.outcomePath);
            if (next !== action.outcomePath) { action.originalOutcomePath ||= action.outcomePath;action.outcomePath = next;this.dirty = true; }
          }
        }
        const banner = this.settings.headerBannerImage;
        if (banner && migratePath(banner) !== banner) { this.settings.headerBannerImage = migratePath(banner);this.dirty = true; }
        for (const record of Object.values(this.store.daily)) {
          if (!record.files) continue;
          for (const key of Object.keys(record.files)) {
            const next = migratePath(key);
            if (next !== key) {
              const source = record.files[key];
              const target = record.files[next];
              if (target) {
                // A deleted note can leave history at the destination path.
                // Merge file detail only: daily totals already include both notes.
                const merged = { ...target, ...source, created: !!(target.created || source.created) };
                for (const field of ['wordsAdded', 'tasks', 'links', 'rewrittenWords', 'sessions']) {
                  merged[field] = (target[field] || 0) + (source[field] || 0);
                }
                if (target.sourceWords || source.sourceWords) {
                  merged.sourceWords = {};
                  for (const field of ['system', 'capture', 'unattributed']) {
                    merged.sourceWords[field] = (target.sourceWords?.[field] || 0) + (source.sourceWords?.[field] || 0);
                  }
                }
                record.files[next] = merged;
              } else {
                record.files[next] = source;
              }
              delete record.files[key];
              this.dirty = true;
            }
          }
        }
      })
    );
  }

  registerActivityListeners() {
    const recordActivity = () => {
      const isVisible = typeof document === "undefined" || (!document.hidden && (!document.hasFocus || document.hasFocus()));
      const now = Date.now();
      const previous = this.lastInteractionTime;
      this.lastInteractionTime = now;
      if (!isVisible) { this.lastInteractionTime = null; return; }
      if (!previous) return;

      const maxIdleMs = (this.settings.focusIdleTimeoutMinutes || 5) * 60 * 1000;
      if (now - previous > maxIdleMs || now <= previous) return;

      // 按整点（含午夜）拆分，同时累计全天总数与 24 小时分布；两者之和恒等。
      for (const piece of splitActiveInterval(previous, now)) {
        const rec = this.getOrCreateRecord(piece.day);
        rec.activity.activeMinutes += piece.minutes;
        if (!Array.isArray(rec.activity.hourly) || rec.activity.hourly.length !== 24) rec.activity.hourly = Array(24).fill(0);
        rec.activity.hourly[piece.hour] += piece.minutes;
      }
      this.dirty = true;
    };

    this.registerDomEvent(window, "blur", () => { this.lastInteractionTime = null; this.noteWindowBlur(); });
    this.registerDomEvent(window, "focus", () => { this.windowBlurredAt = null; });
    this.registerDomEvent(window, "keydown", recordActivity, { passive: true });
    this.registerDomEvent(window, "pointerdown", recordActivity, { passive: true });
    this.registerWritingEvidence(window);
    if (this.app?.workspace?.on) {
      this.registerEvent(this.app.workspace.on("window-open", (_workspaceWindow, win) => { if (win) this.registerWritingEvidence(win); }));
      // 画布节点、悬浮编辑器里的编辑：按编辑器报告的文件记，但要紧跟一次真实输入
      this.registerEvent(this.app.workspace.on("editor-change", (_editor, info) => {
        const path = info?.file?.path;
        if (path && this.lastWritingInputAt && Date.now() - this.lastWritingInputAt <= EDITOR_INPUT_LINK_MS) this.markWritingEvidence(path);
      }));
    }
  }

  noteWindowBlur() {
    this.windowBlurredAt = Date.now();
  }

  /* 本人写作的证据：在某篇笔记的标签页里键入、粘贴、拖入、剪切，或点了任务复选框。
     只看窗口在前台不够：Agent、同步或别的插件在前台写文件时也是前台。 */
  registerWritingEvidence(win) {
    const handler = (event) => this.noteWritingEvidence(event);
    for (const type of ["keydown", "beforeinput", "paste", "drop", "cut", "click", "pointerdown"]) {
      this.registerDomEvent(win, type, handler, { capture: true, passive: true });
    }
  }

  noteWritingEvidence(event) {
    const now = Date.now();
    this.lastUserActionAt = now;
    if (event?.type === "pointerdown") return;
    const target = event?.target;
    if (event?.type === "click" && !target?.closest?.('input[type="checkbox"], .task-list-item-checkbox')) return;
    if (event?.type === "keydown") {
      const kind = writingKeyKind(event);
      // 方向键、翻页、Esc 这类只移动光标的键不算
      if (!kind) return;
      this.lastWritingInputAt = now;
      // 快捷键可能改文字（撤销、加粗、移动行），也可能只是搜索、切换：编辑器紧接着真的变了才算（见 editor-change）
      if (kind === "shortcut") return;
    }
    this.lastWritingInputAt = now;
    const leafEl = target?.closest?.(".workspace-leaf");
    if (!leafEl) return;
    let path = null;
    this.app?.workspace?.iterateAllLeaves?.((leaf) => { if (!path && leaf.containerEl === leafEl) path = leaf.view?.file?.path || null; });
    if (path) this.markWritingEvidence(path);
  }

  markWritingEvidence(path) {
    if (!this.writingEvidence) this.writingEvidence = new Map();
    this.writingEvidence.set(path, Date.now());
  }

  hasWritingEvidence(path, at = Date.now()) {
    const t = this.writingEvidence?.get(path);
    return t != null && at - t <= BACKGROUND_WRITE_GRACE_MS && t - at <= 1000;
  }

  hasCreationEvidence(path, at = Date.now()) {
    if (this.hasWritingEvidence(path, at)) return true;
    const t = this.lastUserActionAt;
    return t != null && at - t <= CREATE_ACTION_WINDOW_MS && t - at <= 1000;
  }

  // Writes to system folders, or without evidence of the user's own input (agents, scripts, sync, other
  // plugins — in the background or the foreground), are not the user's writing here: they are tallied as
  // externalWords and never scored. An editor save landing after switching away still counts, because the
  // typing that caused it happened within the grace window.
  isExternalWrite(path, at = Date.now(), { creation = false } = {}) {
    if (isSystemArtifact(path)) return true;
    return !(creation ? this.hasCreationEvidence(path, at) : this.hasWritingEvidence(path, at));
  }

  recordExternalWords(words) {
    if (!(words > 0)) return;
    const today = this.getOrCreateTodayRecord();
    today.contribution.externalWords = (Number(today.contribution.externalWords) || 0) + words;
    this.dirty = true;
  }

  handleFileCreation(file) {
    if (!this.shouldTrackPath(file.path)) return Promise.resolve();
    const at = Date.now();
    return this.queueFileOperation(file, async () => {
      if (this.fileSnapshots.has(file.path)) return;
        try {
          const content = await this.readTrackedFile(file);
          if (content === null) return;
          const words = countWords(content);
          const external = this.isExternalWrite(file.path, at, { creation: true });
          this.fileSnapshots.set(file.path, {
            words,
            tasks: countTasks(content),
            links: countLinks(content),
            lineSet: getLineSet(content),
            completedTaskSet: getCompletedTaskSet(content),
            lastTime: Date.now()
          });
          if (external) {
            this.recordExternalWords(words);
            if (this.dirty) await this.savePluginData();
            return;
          }
          const today = this.getOrCreateTodayRecord();
          today.contribution.notesCreated += 1;
          if (!today.files[file.path]) {
            today.files[file.path] = { wordsAdded: 0, created: true, tasks: 0, links: 0 };
          } else {
            // 同一路径今天已有旧笔记的记录（编辑后删掉，又在这里新建）：记下旧笔记当时的数值，
            // 这篇新笔记再被删掉时只撤回它自己的部分，不连带旧笔记今天的工作
            const rec = today.files[file.path];
            if (!rec.created) {
              rec.createdBase = {
                wordsAdded: Number(rec.wordsAdded) || 0, links: Number(rec.links) || 0, tasks: Number(rec.tasks) || 0,
                rewrittenWords: Number(rec.rewrittenWords) || 0, sessions: Number(rec.sessions) || 0,
                sourceWords: rec.sourceWords ? { ...rec.sourceWords } : null,
              };
            }
            rec.created = true;
          }
          if (words > 0) {
            today.contribution.wordsAdded += words;
            today.files[file.path].wordsAdded += words;
            recordSourceWords(today.files[file.path], file.path, words, words >= 500);
            if (words >= 500) today.contribution.captureWords = (today.contribution.captureWords || 0) + words;
          }
          this.dirty = true;
          this.recomputeScore(today);
          await this.savePluginData();
          this.updateStatusBar();
        } catch (e) {
          console.error("[Crisp Pulse] Error reading created file:", e);
        }
    });
  }

  // Discard deleted/excluded lifecycles even if their path is reused. Within the tracked area,
  // keep pending reads attached to the same note through a rename.
  invalidateFileReads(path, migratePath = null) {
    for (const read of this.pendingFileReads || []) {
      if (read.path !== path && !read.path.startsWith(`${path}/`)) continue;
      const next = migratePath?.(read.path);
      if (next && this.shouldTrackPath(read.path) && this.shouldTrackPath(next)) read.path = next;
      else read.invalidated = true;
    }
  }

  async readTrackedFile(file) {
    if (this.stopped || !this.shouldTrackPath(file.path)) return null;
    const read = { path: file.path, invalidated: false };
    if (!this.pendingFileReads) this.pendingFileReads = new Set();
    this.pendingFileReads.add(read);
    try {
      const content = await this.app.vault.read(file);
      if (this.stopped || read.invalidated || file.path !== read.path || !this.shouldTrackPath(read.path)) return null;
      return content;
    } finally {
      this.pendingFileReads.delete(read);
    }
  }

  handleFileModification(file) {
    const at = Date.now();
    return this.queueFileOperation(file, () => this.processFileModification(file, at));
  }

  async queueFileOperation(file, operation) {
    if (this.stopped || (this.sourceFilterChanging && isSystemArtifact(file.path))) return;
    if (!this.fileQueues) this.fileQueues = new Map();
    const queuedPath = file.path;
    // Reserve the lifecycle before joining the queue, including work not yet in vault.read().
    const read = { path: queuedPath, invalidated: false };
    if (!this.pendingFileReads) this.pendingFileReads = new Set();
    this.pendingFileReads.add(read);
    const queue = (this.fileQueues.get(queuedPath) || Promise.resolve())
      .catch(() => {})
      .then(() => {
        if (!this.stopped && !read.invalidated && file.path === read.path && this.shouldTrackPath(read.path)) return operation();
      });
    this.fileQueues.set(queuedPath, queue);
    try {
      await queue;
    } finally {
      this.pendingFileReads.delete(read);
      if (this.fileQueues.get(queuedPath) === queue) this.fileQueues.delete(queuedPath);
      if (this.fileQueues.get(read.path) === queue) this.fileQueues.delete(read.path);
    }
  }

  async processFileModification(file, at = Date.now()) {
    if (this.stopped || !this.shouldTrackPath(file.path)) return;
    try {
      const content = await this.readTrackedFile(file);
      if (content === null) return;
      const newWords = countWords(content);
      const newTasks = countTasks(content);
      const newLinks = countLinks(content);
      const newLineSet = getLineSet(content);
      const newCompletedTasks = getCompletedTaskSet(content);
      const now = Date.now();

      let snapshot = this.fileSnapshots.get(file.path);
      if (!snapshot) {
        snapshot = {
          words: newWords,
          tasks: newTasks,
          links: newLinks,
          lineSet: newLineSet,
          completedTaskSet: newCompletedTasks,
          lastTime: now
        };
        this.fileSnapshots.set(file.path, snapshot);
        return;
      }

      const wordsDelta = newWords - snapshot.words;
      const linksDelta = Math.max(0, newLinks - (snapshot.links || 0));

      // 1.2 Task Lifecycle Tracking: calculate net real tasks added and removed
      let realTasksAdded = 0;
      let realTasksRemoved = 0;
      if (snapshot.completedTaskSet) {
        for (const t of newCompletedTasks) {
          if (!snapshot.completedTaskSet.has(t)) realTasksAdded++;
        }
        for (const t of snapshot.completedTaskSet) {
          if (!newCompletedTasks.has(t)) realTasksRemoved++;
        }
      } else {
        realTasksAdded = Math.max(0, newTasks - (snapshot.tasks || 0));
      }

      // 1.2 Rewriting & Polish Detection: line-diff check
      let addedLines = 0;
      let removedLines = 0;
      if (snapshot.lineSet) {
        for (const l of newLineSet) {
          if (!snapshot.lineSet.has(l)) addedLines++;
        }
        for (const l of snapshot.lineSet) {
          if (!newLineSet.has(l)) removedLines++;
        }
      }

      let isMeaningfulRewrite = false;
      let rewrittenWordsDelta = 0;
      // If net words change is small but substantial lines were rewritten
      if (Math.abs(wordsDelta) < 150 && addedLines >= 3 && removedLines >= 3) {
        isMeaningfulRewrite = true;
        rewrittenWordsDelta = Math.min(newWords, Math.max(addedLines, removedLines) * 15);
      }

      snapshot.words = newWords;
      snapshot.tasks = newTasks;
      snapshot.links = newLinks;
      snapshot.lineSet = newLineSet;
      snapshot.completedTaskSet = newCompletedTasks;
      snapshot.lastTime = now;

      if (wordsDelta === 0 && realTasksAdded === 0 && realTasksRemoved === 0 && linksDelta === 0 && !isMeaningfulRewrite) {
        return;
      }

      if (this.isExternalWrite(file.path, at)) {
        this.recordExternalWords(wordsDelta);
        return;
      }

      const today = this.getOrCreateTodayRecord();
      if (!today.files[file.path]) {
        today.files[file.path] = { wordsAdded: 0, created: false, tasks: 0, links: 0 };
      }
      const fileRecord = today.files[file.path];

      // One save adding 500+ words is a paste or import, however long the note sat idle before it.
      const isCapture = wordsDelta >= 500;
      if (isCapture) {
        today.contribution.captureWords = (today.contribution.captureWords || 0) + wordsDelta;
      }

      if (wordsDelta > 0) {
        today.contribution.wordsAdded += wordsDelta;
        fileRecord.wordsAdded += wordsDelta;
        recordSourceWords(fileRecord, file.path, wordsDelta, isCapture);
      } else if (wordsDelta < 0) {
        today.contribution.wordsRemoved += Math.abs(wordsDelta);
      }

      if (rewrittenWordsDelta > 0) {
        today.contribution.rewrittenWords = (today.contribution.rewrittenWords || 0) + rewrittenWordsDelta;
        fileRecord.rewrittenWords = (fileRecord.rewrittenWords || 0) + rewrittenWordsDelta;
      }

      const netTasks = realTasksAdded - realTasksRemoved;
      if (netTasks > 0) {
        today.contribution.tasksCompleted += netTasks;
        fileRecord.tasks = (fileRecord.tasks || 0) + netTasks;
      } else if (netTasks < 0) {
        const tasksToSubtract = Math.min(Math.abs(netTasks), Math.max(0, fileRecord.tasks || 0));
        today.contribution.tasksCompleted = Math.max(0, today.contribution.tasksCompleted - tasksToSubtract);
        fileRecord.tasks = Math.max(0, (fileRecord.tasks || 0) - tasksToSubtract);
      }

      if (linksDelta > 0) {
        today.contribution.linksCreated += linksDelta;
        fileRecord.links += linksDelta;
      }

      const timeoutMs = (this.settings.sessionIdleTimeoutMinutes || 3) * 60 * 1000;
      let session = this.activeSessions.get(file.path);
      if (session && (now - session.lastEventTime >= timeoutMs || session.date !== getTodayKey())) {
        this.closeSession(session, file.path);
        this.activeSessions.delete(file.path);
        session = null;
      }

      if (!session) {
        session = {
          date: getTodayKey(),
          startTime: now,
          lastEventTime: now,
          wordsDeltaTotal: 0,
          isMeaningful: false
        };
        this.activeSessions.set(file.path, session);
      }
      session.lastEventTime = now;
      session.wordsDeltaTotal += wordsDelta;

      if (Math.abs(session.wordsDeltaTotal) >= 15 || realTasksAdded > 0 || linksDelta > 0 || isMeaningfulRewrite) {
        session.isMeaningful = true;
      }

      this.dirty = true;
      this.recomputeScore(today);
      this.updateStatusBar();
    } catch (err) {
      console.error("[Crisp Pulse] File modify handler error:", err);
    }
  }

  async checkIdleSessions() {
    const now = Date.now();
    const timeoutMs = (this.settings.sessionIdleTimeoutMinutes || 3) * 60 * 1000;
    let modified = false;

    for (const [filePath, session] of this.activeSessions.entries()) {
      if (now - session.lastEventTime >= timeoutMs) {
        if (session.isMeaningful) {
          this.closeSession(session, filePath);
          modified = true;
        }
        this.activeSessions.delete(filePath);
      }
    }

    if (modified || this.dirty) {
      await this.savePluginData();
      if (!this.stopped) this.refreshViews();
    }
  }

  async flushAllSessions() {
    for (const [path, session] of this.activeSessions.entries()) this.closeSession(session, path);
    this.activeSessions.clear();
    await this.savePluginData();
  }

  /* 当天新建、当天删除的笔记（草稿、误建的「未命名」文件）不算当天的产出，把它在今天的记录整条撤回。
     以前的记录保留：那些天的工作确实做过，删旧笔记、整理库不该擦掉过去的热力图。 */
  rollbackSameDayCreations(isGone) {
    const today = this.store?.daily?.[getTodayKey()];
    if (!today?.files || !today.contribution) return false;
    let changed = false;
    for (const [path, rec] of Object.entries(today.files)) {
      if (!rec?.created || !isGone(path)) continue;
      const c = today.contribution;
      // 同一路径先有旧笔记、后新建的：只撤回新建之后的部分，记录还原成旧笔记的样子
      const base = rec.createdBase && typeof rec.createdBase === "object" ? rec.createdBase : null;
      const delta = (field, baseValue) => Math.max(0, (Number(rec[field]) || 0) - (Number(baseValue) || 0));
      const sub = (field, value) => { c[field] = Math.max(0, (Number(c[field]) || 0) - (Number(value) || 0)); };
      const sessions = delta("sessions", base?.sessions);
      sub("notesCreated", 1);
      sub("wordsAdded", delta("wordsAdded", base?.wordsAdded));
      sub("linksCreated", delta("links", base?.links));
      sub("tasksCompleted", delta("tasks", base?.tasks));
      sub("rewrittenWords", delta("rewrittenWords", base?.rewrittenWords));
      sub("captureWords", Math.max(0, (Number(rec.sourceWords?.capture) || 0) - (Number(base?.sourceWords?.capture) || 0)));
      sub("meaningfulEdits", sessions);
      if (today.activity) today.activity.editingSessions = Math.max(0, (Number(today.activity.editingSessions) || 0) - sessions);
      if (base) {
        for (const field of ["wordsAdded", "links", "tasks", "rewrittenWords", "sessions"]) rec[field] = Number(base[field]) || 0;
        if (base.sourceWords) rec.sourceWords = { ...base.sourceWords };
        else delete rec.sourceWords;
        rec.created = false;
        delete rec.createdBase;
      } else {
        delete today.files[path];
      }
      changed = true;
    }
    if (changed) {
      this.recomputeScore(today);
      this.dirty = true;
    }
    return changed;
  }

  closeSession(session, path = null) {
    if (!session?.isMeaningful) return;
    const record = this.getOrCreateRecord(session.date || getTodayKey());
    record.contribution.meaningfulEdits += 1;
    record.activity.editingSessions += 1;
    // 记在这篇笔记名下：当天新建又删掉时，结算过的会话也能一起撤回
    const fileRecord = path && record.files?.[path];
    if (fileRecord) fileRecord.sessions = (Number(fileRecord.sessions) || 0) + 1;
    this.recomputeScore(record);
    this.dirty = true;
  }

  // Folder rules changed: drop snapshots that are no longer tracked and baseline newly tracked notes,
  // so edits made while a folder was excluded are never back-counted after it is included again.
  async syncSnapshotsToTrackingRules() {
    if (this.snapshotSyncing) { this.snapshotSyncPending = true; return; }
    this.snapshotSyncing = true;
    try {
      do {
        this.snapshotSyncPending = false;
        await Promise.allSettled([...(this.fileQueues?.values() || [])]);
        for (const path of [...this.fileSnapshots.keys()]) if (!this.shouldTrackPath(path)) this.fileSnapshots.delete(path);
        for (const [path, session] of [...this.activeSessions.entries()]) {
          if (this.shouldTrackPath(path)) continue;
          this.closeSession(session, path);
          this.activeSessions.delete(path);
        }
        const files = typeof this.app.vault.getMarkdownFiles === "function" ? this.app.vault.getMarkdownFiles() : [];
        await this.initializeSnapshots(files.filter(file => this.shouldTrackPath(file.path) && !this.fileSnapshots.has(file.path)));
      } while (this.snapshotSyncPending && !this.stopped);
    } finally { this.snapshotSyncing = false; }
  }

  scheduleSnapshotSync(delayMs = 1500) {
    if (this.snapshotSyncTimer) clearTimeout(this.snapshotSyncTimer);
    this.snapshotSyncTimer = setTimeout(() => {
      this.snapshotSyncTimer = null;
      if (!this.stopped) this.syncSnapshotsToTrackingRules().catch(err => console.error("[Crisp Pulse] Snapshot sync failed:", err));
    }, delayMs);
  }

  recomputeScore(dayRecord) {
    const b = getScoreBreakdown(dayRecord, this.settings);
    dayRecord.contribution.score = b.totalScore;
    return dayRecord.contribution.score;
  }

  // --- Historical Backfill ---
  async runHistoricalBackfill(force = false) {
    const files = this.app.vault.getMarkdownFiles();
    console.log(`[Crisp Pulse] Backfilling from ${files.length} markdown files...`);

    const createdMap = new Map();
    const modifiedMap = new Map();

    for (const file of files) {
      if (!isPathIncluded(file.path, this.settings.includedFolders, this.settings.excludedFolders)) {
        continue;
      }
      const cDate = new Date(file.stat.ctime);
      const cKey = `${cDate.getFullYear()}-${String(cDate.getMonth() + 1).padStart(2, "0")}-${String(cDate.getDate()).padStart(2, "0")}`;
      createdMap.set(cKey, (createdMap.get(cKey) || 0) + 1);

      const mDate = new Date(file.stat.mtime);
      const mKey = `${mDate.getFullYear()}-${String(mDate.getMonth() + 1).padStart(2, "0")}-${String(mDate.getDate()).padStart(2, "0")}`;

      if (!modifiedMap.has(mKey)) {
        modifiedMap.set(mKey, { count: 0, words: 0, files: [] });
      }
      const mItem = modifiedMap.get(mKey);
      mItem.count += 1;
      mItem.files.push(file.path);
    }

    const allDates = new Set([...createdMap.keys(), ...modifiedMap.keys()]);
    for (const dStr of allDates) {
      if (dStr >= getTodayKey()) continue;
      const existing = this.store.daily[dStr];
      if (existing && existing.quality !== "estimated") continue;

      const rec = createEmptyDailyRecord(dStr, "estimated");
      rec.contribution.notesCreated = createdMap.get(dStr) || 0;

      const mod = modifiedMap.get(dStr);
      if (mod) {
        rec.contribution.meaningfulEdits = mod.count;
        for (const fp of mod.files.slice(0, 15)) {
          rec.files[fp] = { wordsAdded: 0, created: false, tasks: 0, links: 0 };
        }
      }

      this.recomputeScore(rec);
      this.store.daily[dStr] = rec;
    }

    this.dirty = true;
    await this.savePluginData();
    console.log("[Crisp Pulse] Backfill completed.");
  }

  recordMatchesScope(record, key, scope = this.settings.dataQualityScope || "reliable") {
    if (!record || typeof key !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(key) || key > getTodayKey()) return false;
    const [year, month, day] = key.split("-").map(Number);
    if (dateKey(new Date(year, month - 1, day)) !== key) return false;
    if (scope === "all") return true;
    if (record.quality !== "recorded") return false;
    if (scope === "recorded_only") return true;
    return !record.legacyUnverified && (!this.settings.trackingStartDate || key >= this.settings.trackingStartDate);
  }

  getReviewData(startDateStr, endDateStr, scope = this.settings.dataQualityScope || "reliable") {
    return generateReviewData(
      this.store.daily || {},
      startDateStr,
      endDateStr,
      scope,
      (record, key) => this.recordMatchesScope(record, key, scope)
    );
  }

  /** 复盘页和导出共用的速记摘要；读取失败时带 error，Tempo 读不到时标 tempoFailed，都不当成零。 */
  async getReviewMemoSummary(start, end) {
    let memos;
    try { memos = await this.memoStore.list(); }
    catch (error) { return { error: error?.message || String(error) }; }
    const tempo = this.memoTempo?.();
    const ids = memos.filter(m => m.id && m.tempoTasks?.length && m.date >= start && m.date <= end).map(m => `crisp-pulse:${m.id}`);
    let snapshots = null, tempoFailed = false;
    if (tempo && ids.length) {
      try { snapshots = await tempo.getTasksBySource(ids); }
      catch (error) { tempoFailed = true; console.warn('[Crisp Pulse] 复盘读取 Tempo 任务状态失败', error); }
    }
    return { ...memoConversionReview(memos, start, end, snapshots), hasMemos: memos.length > 0, hasTempo: !!tempo, tempoFailed };
  }

  getReviewModel(start, end, scope = this.settings.dataQualityScope || 'reliable') {
    const period = getReviewPeriod(start, end);
    if (!Object.hasOwn(REVIEW_SCOPE_LABELS, scope)) throw new Error(tr('未知的数据筛选范围', 'Unknown data scope'));
    const summarize = (a, b) => {
      const review = this.getReviewData(a, b, scope);
      const coverage = { recorded: 0, missing: 0, filtered: 0 };
      for (let day = reviewDayNumber(a); day <= reviewDayNumber(b); day++) {
        const key = reviewDayKey(day), record = this.store.daily[key];
        if (!record) coverage.missing++;
        else if (this.recordMatchesScope(record, key, scope)) coverage.recorded++;
        else coverage.filtered++;
      }
      return { ...review, coverage };
    };
    const current = summarize(start, end), previous = summarize(period.previousStart, period.previousEnd);
    const fields = PULSE_ZH ? [['totalScore', '贡献得分', '分'], ['wordsAdded', '新增词数', '词'], ['rewrittenWords', '改写估算', '词'], ['notesCreated', '新建笔记', '篇'], ['tasksCompleted', '完成任务', '项'], ['focusMinutes', '专注记录', '分钟']]
      : [['totalScore', 'Contribution score', 'pts'], ['wordsAdded', 'Words added', 'words'], ['rewrittenWords', 'Rewrites (est.)', 'words'], ['notesCreated', 'Notes created', 'notes'], ['tasksCompleted', 'Tasks completed', 'tasks'], ['focusMinutes', 'Focus logged', 'min']];
    const comparison = fields.map(([key, label, unit]) => {
      const now = current[key], before = previous[key];
      const percent = previous.coverage.recorded && current.coverage.recorded && before > 0 ? Math.round((now - before) / before * 1000) / 10 : null;
      const changeLabel = !current.coverage.recorded ? tr('当前无可用记录', 'No usable records now') : !previous.coverage.recorded ? tr('前期无可用记录', 'No usable records before') : before === 0 ? (now === 0 ? tr('均为零', 'Both zero') : tr('前期为零', 'Previously zero')) : `${percent > 0 ? '+' : ''}${percent}%`;
      return { key, label, unit, current: now, previous: before, percent, changeLabel };
    });
    const saved = this.store.reviewDrafts?.[`${start}:${end}:${scope}`];
    const draft = Object.fromEntries(Object.keys(REVIEW_DRAFT_FIELDS).map(key => [key, typeof saved?.[key] === 'string' ? saved[key] : '']));
    const actions = Array.isArray(saved?.actions) ? saved.actions.filter(a => a && typeof a.id === 'string' && typeof a.title === 'string').map(a => ({ ...a })) : [];
    const evidence = Array.isArray(saved?.evidence) ? saved.evidence.filter(e => e && typeof e.id === 'string' && typeof e.path === 'string').map(e => ({ ...e })) : [];
    return { period, scope, current, previous, comparison, draft, actions, evidence };
  }

  updateReviewDraft(start, end, scope, field, value) {
    getReviewPeriod(start, end);
    if (!Object.hasOwn(REVIEW_DRAFT_FIELDS, field) || !Object.hasOwn(REVIEW_SCOPE_LABELS, scope) || typeof value !== 'string') return;
    if (!this.store.reviewDrafts || typeof this.store.reviewDrafts !== 'object' || Array.isArray(this.store.reviewDrafts)) this.store.reviewDrafts = {};
    const key = `${start}:${end}:${scope}`;
    const old = this.store.reviewDrafts[key];
    this.store.reviewDrafts[key] = { ...(old && typeof old === 'object' ? old : {}), [field]: value, updatedAt: new Date().toISOString() };
    this.dirty = true;
  }

  async archiveReviewReport(model) {
    // Use the existing no-overwrite archive path, with a period/scope-specific name.
    const { start, end } = getReviewPeriod(model.period.start, model.period.end);
    const folder = (this.settings.reviewArchiveFolder || 'Topics/self-media/outputs/reviews').trim();
    if (/(?:^|\/)\.\.(?:\/|$)/.test(folder) || folder.startsWith('/') || folder.includes('\\') || folder.includes('\0')) {
      new Notice(tr('归档目录无效，请在设置中使用库内相对路径。', 'Invalid archive folder. Use a path relative to the vault in Settings.'));
      return { success: false, reason: 'invalid_path' };
    }
    if (!Object.hasOwn(REVIEW_SCOPE_LABELS, model.scope)) return { success: false, reason: 'invalid_scope' };
    const topic = /^Topics\/([^/]+)(?:\/|$)/.exec(folder)?.[1];
    const frontmatter = ['---', 'type: review', 'review_type: content-data', ...(topic ? [`topic: ${JSON.stringify(topic)}`] : []),
      `created: ${getTodayKey()}`, `period_start: ${start}`, `period_end: ${end}`, `data_quality_scope: ${model.scope}`, 'generator: crisp-pulse', '---', ''];
    return this.archiveWeeklyReviewToVault(model.current, start, end, {
      fileName: `${start}_${end}-${model.scope}-知识工作复盘.md`, // 文件名不随界面语言变化，避免同一期归档出两份
      content: frontmatter.join('\n') + '\n' + generateReviewReport(model)
    });
  }


  shouldTrackPath(path) {
    return isPathIncluded(path, this.settings.includedFolders, this.settings.excludedFolders) && !(this.settings.excludeSystemArtifacts && isSystemArtifact(path));
  }

  async setSystemArtifactsExcluded(enabled) {
    if (this.sourceFilterChanging) return false;
    this.sourceFilterChanging = true;
    const previous = !!this.settings.excludeSystemArtifacts;
    try {
      await Promise.allSettled([...(this.fileQueues?.values() || [])]);
      this.settings.excludeSystemArtifacts = !!enabled;
      await this.savePluginData({ throwOnError: true });
      for (const path of [...this.fileSnapshots.keys()]) if (isSystemArtifact(path)) this.fileSnapshots.delete(path);
      // Baseline before resuming collection so excluded edits are never back-counted.
      if (!enabled) await this.initializeSnapshots(this.app.vault.getMarkdownFiles().filter(file => isSystemArtifact(file.path)));
      this.refreshViews();
      return true;
    } catch (error) {
      this.settings.excludeSystemArtifacts = previous;this.dirty = true;
      throw error;
    } finally { this.sourceFilterChanging = false; }
  }

  reviewDraftForWrite(start, end, scope) {
    const key = getReviewDraftKey(start, end, scope);
    if (!this.store.reviewDrafts || typeof this.store.reviewDrafts !== 'object' || Array.isArray(this.store.reviewDrafts)) this.store.reviewDrafts = {};
    if (!this.store.reviewDrafts[key] || typeof this.store.reviewDrafts[key] !== 'object' || Array.isArray(this.store.reviewDrafts[key])) this.store.reviewDrafts[key] = {};
    return this.store.reviewDrafts[key];
  }

  markReviewDraftChanged(draft) { draft.updatedAt = new Date().toISOString();this.dirty = true; }

  addReviewAction(start, end, scope, title) {
    if (typeof title !== 'string' || !title.trim() || title.length > 500) throw new Error(tr('请填写 1–500 字的行动。', 'Enter an action of 1–500 characters.'));
    const draft = this.reviewDraftForWrite(start, end, scope);
    if (!Array.isArray(draft.actions)) draft.actions = [];
    const action = { id: reviewEntryId(), title: title.trim(), status: 'pending', createdAt: new Date().toISOString() };
    draft.actions.push(action);this.markReviewDraftChanged(draft);return action.id;
  }

  updateReviewAction(start, end, scope, id, patch) {
    if (patch.status !== undefined && !Object.hasOwn(REVIEW_ACTION_STATES, patch.status)) throw new Error(tr('行动状态无效。', 'Invalid action status.'));
    if (patch.title !== undefined && (typeof patch.title !== 'string' || patch.title.length > 500)) throw new Error(tr('行动文字最多 500 字。', 'Actions can be at most 500 characters.'));
    if (patch.outcomePath) {
      const file = this.app.vault.getAbstractFileByPath(patch.outcomePath);
      if (!reviewSafePath(patch.outcomePath) || !file || file.extension !== 'md') throw new Error(tr('结果笔记不存在，请填写已有 Markdown 笔记的完整路径。', 'Outcome note not found. Enter the full path of an existing Markdown note.'));
    }
    const draft = this.reviewDraftForWrite(start, end, scope);
    const action = draft.actions?.find(item => item?.id === id);if (!action) throw new Error(tr('行动已不存在。', 'This action no longer exists.'));
    for (const key of ['title', 'status', 'outcomePath']) if (patch[key] !== undefined) action[key] = patch[key];
    if (patch.outcomePath && !action.originalOutcomePath) action.originalOutcomePath = patch.outcomePath;
    this.markReviewDraftChanged(draft);
  }

  /** 上一期还能带入本期的行动（已带入过的不再算）。只读，不改任何草稿。 */
  previousActionCandidates(start, end, scope) {
    const period = getReviewPeriod(start, end), sourceKey = getReviewDraftKey(period.previousStart, period.previousEnd, scope);
    const previous = this.store.reviewDrafts?.[sourceKey];if (!previous) return [];
    const structured = Array.isArray(previous.actions) && previous.actions.length > 0;
    let candidates = [];
    if (structured) {
      candidates = previous.actions.filter(a => a && ['pending', 'deferred'].includes(a.status));
    } else if (typeof previous.next === 'string' && previous.next.trim()) {
      const counts = new Map();
      for (const rawLine of previous.next.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        const match = line.match(/^(?:(?:[-*+]|\d+[.)])\s+)?(?:\[([ xX])\]\s+)?(.*)$/);
        if (!match) continue;
        const check = match[1];
        const title = (match[2] || '').trim();
        if (!title) continue;
        const status = (check && check.toLowerCase() === 'x') ? 'done' : 'pending';
        const occ = counts.get(title) || 0;
        counts.set(title, occ + 1);
        const id = `legacy:${sourceKey}:${title}:${occ}`;
        candidates.push({ id, title, status });
      }
      candidates = candidates.filter(a => a.status === 'pending');
    }
    const existing = this.store.reviewDrafts?.[getReviewDraftKey(start, end, scope)]?.actions;
    const taken = Array.isArray(existing) ? existing : [];
    return candidates.filter(candidate => candidate.title && !taken.some(a => a?.originId === (candidate.originId || candidate.id) || a?.id === (candidate.originId || candidate.id))).map(candidate => ({ ...candidate, sourceKey }));
  }

  importPreviousActions(start, end, scope) {
    const candidates = this.previousActionCandidates(start, end, scope);
    if (!candidates.length) return 0;
    const draft = this.reviewDraftForWrite(start, end, scope);if (!Array.isArray(draft.actions)) draft.actions = [];
    for (const candidate of candidates) draft.actions.push({ id: reviewEntryId(), originId: candidate.originId || candidate.id, title: candidate.title, status: 'pending', sourcePeriod: candidate.sourceKey, createdAt: new Date().toISOString() });
    this.markReviewDraftChanged(draft);return candidates.length;
  }

  async addReviewEvidence(start, end, scope, path, quote = '') {
    const model = this.getReviewModel(start, end, scope);
    if (!reviewSafePath(path) || !model.current.allFiles.some(file => file.path === path)) throw new Error(tr('请选择当前区间与范围内的笔记。', 'Choose a note within the current period and scope.'));
    if (typeof quote !== 'string' || quote.length > 2000) throw new Error(tr('单条摘录最多 2000 字。', 'A quote can be at most 2000 characters.'));
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || file.extension !== 'md') throw new Error(tr('原笔记已不存在。', 'The original note no longer exists.'));
    const originalPath = path;
    const content = await this.app.vault.read(file);
    if (this.stopped) throw new Error(tr('插件已停止，请重试。', 'The plugin has stopped. Please try again.'));
    quote = quote.replace(/\r\n/g, '\n');
    if (quote && !content.replace(/\r\n/g, '\n').includes(quote)) throw new Error(tr('摘录与当前原文不一致，请重新选择原文。', 'The quote no longer matches the note. Select the text again.'));
    const draft = this.reviewDraftForWrite(start, end, scope);if (!Array.isArray(draft.evidence)) draft.evidence = [];
    if (draft.evidence.some(item => item?.path === file.path && item.quote === quote)) return false;
    draft.evidence.push({ id: reviewEntryId(), path: file.path, originalPath, quote, capturedAt: new Date().toISOString() });
    this.markReviewDraftChanged(draft);return true;
  }

  removeReviewEvidence(start, end, scope, id) {
    const draft = this.reviewDraftForWrite(start, end, scope);
    if (Array.isArray(draft.evidence)) { draft.evidence = draft.evidence.filter(item => item?.id !== id);this.markReviewDraftChanged(draft); }
  }


  // --- Statistics & Streaks with Scope & DateRange Filtering ---
  calcStats(scope = this.settings.dataQualityScope || "reliable", dateRange = "year") {
    const daily = this.store.daily || {};
    let totalScore = 0;
    let activeDays = 0;
    let totalActiveMins = 0;
    let totalFocusMins = 0;

    const allSortedDates = Object.keys(daily).sort();
    const filteredDates = filterDatesByRange(allSortedDates, dateRange);

    const startDate = this.settings.trackingStartDate;
    const activeDateSet = new Set();
    const isActive = (rec) => (scope !== "reliable" || rec.quality !== "estimated") && ((rec.contribution.score || 0) > 0 || (rec.contribution.meaningfulEdits || 0) >= 1);

    for (const dStr of filteredDates) {
      const rec = daily[dStr];
      if (!this.recordMatchesScope(rec, dStr, scope)) continue;

      totalScore += rec.contribution.score || 0;
      totalActiveMins += (rec.activity?.activeMinutes || 0);
      totalFocusMins += (rec.activity?.focusMinutes || 0);

      if (isActive(rec)) {
        activeDays += 1;
        activeDateSet.add(dStr);
      }
    }
    // 当前连续天数不受时间范围影响：选「近 7 天」时，连续 30 天也照实显示 30
    const streakDateSet = new Set(allSortedDates.filter((dStr) => this.recordMatchesScope(daily[dStr], dStr, scope) && isActive(daily[dStr])));

    let currentStreak = 0;
    let longestStreak = 0;
    let tempStreak = 0;

    const now = new Date();
    let checkDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const checkKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    let curr = new Date(checkDate);
    if (!streakDateSet.has(checkKey(curr))) {
      curr.setDate(curr.getDate() - 1);
    }
    while (streakDateSet.has(checkKey(curr))) {
      currentStreak++;
      curr.setDate(curr.getDate() - 1);
    }

    // 最长连续和当前连续同一口径（全部历史），否则选「近 7 天」时会出现当前 20 天、最长 7 天
    if (allSortedDates.length > 0) {
      let prevDate = null;
      for (const dStr of allSortedDates) {
        if (!streakDateSet.has(dStr)) continue;
        const [y, m, d] = dStr.split("-").map(Number);
        const thisDate = new Date(y, m - 1, d);

        if (prevDate) {
          const diffDays = Math.round((thisDate - prevDate) / (1000 * 60 * 60 * 24));
          if (diffDays === 1) {
            tempStreak++;
          } else {
            tempStreak = 1;
          }
        } else {
          tempStreak = 1;
        }
        prevDate = thisDate;
        if (tempStreak > longestStreak) {
          longestStreak = tempStreak;
        }
      }
    }

    return {
      totalScore: Math.round(totalScore * 10) / 10,
      activeDays,
      currentStreak,
      longestStreak,
      totalActiveHours: (totalActiveMins / 60).toFixed(1),
      totalFocusHours: (totalFocusMins / 60).toFixed(1)
    };
  }

  // --- Intensity Percentile Calculation with Scope Filtering ---
  calculateIntensities(metric = "contribution", scope = this.settings.dataQualityScope || "reliable") {
    const daily = this.store.daily || {};
    const days = Object.keys(daily);

    const getVal = (rec) => {
      if (!rec) return 0;
      switch (metric) {
        case "activity":
          return rec.activity?.activeMinutes || 0;
        case "focus":
          return rec.activity?.focusMinutes || 0;
        case "pomodoro":
          return dayPomodoros(rec).done;
        case "words":
          return rec.contribution?.wordsAdded || 0;
        case "notes":
          return rec.contribution?.notesCreated || 0;
        case "tasks":
          return rec.contribution?.tasksCompleted || 0;
        case "contribution":
        default:
          return rec.contribution?.score || 0;
      }
    };

    const now = Date.now();
    const rolling90Ms = 90 * 24 * 60 * 60 * 1000;
    const positiveValues = [];

    for (const d of days) {
      const rec = daily[d];
      if (!this.recordMatchesScope(rec, d, scope)) continue;

      const [y, m, dt] = d.split("-").map(Number);
      const cellTime = new Date(y, m - 1, dt).getTime();
      if (cellTime <= now && now - cellTime <= rolling90Ms) {
        const v = getVal(rec);
        if (v > 0) positiveValues.push(v);
      }
    }
    positiveValues.sort((a, b) => a - b);

    const map = new Map();
    const count = positiveValues.length;

    for (const d of days) {
      const rec = daily[d];
      const isFilteredOut = !this.recordMatchesScope(rec, d, scope);
      const v = isFilteredOut ? 0 : getVal(rec);

      if (v <= 0 || count === 0) {
        map.set(d, { level: 0, value: v, percentile: 0 });
        continue;
      }
      let rank = 0;
      while (rank < count && positiveValues[rank] <= v) {
        rank++;
      }
      const pct = Math.round((rank / count) * 100);

      let level = 1;
      if (pct > 90) level = 5;
      else if (pct > 75) level = 4;
      else if (pct > 50) level = 3;
      else if (pct > 25) level = 2;

      map.set(d, { level, value: v, percentile: pct });
    }

    return { map, getVal };
  }

  /* ---------- 速记 ---------- */

  memoAsr() {
    const asr = this.app.plugins?.plugins?.["crisp-asr"];
    if (!asr || asr.unloaded || typeof asr.transcribeMemoAudio !== "function" || typeof asr.getMemoTranscriptionJobs !== "function") return null;
    return asr;
  }

  async transcribeMemoAudio(memo, sourcePath) {
    const asr = this.memoAsr();
    if (!asr) throw new Error(tr("请先启用 Crisp ASR 0.8.0 或更高版本", "Enable Crisp ASR 0.8.0 or later first"));
    const file = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!file || !memoAudioFiles(memo, this.app).some((audio) => audio.path === file.path)) throw new Error(tr("速记中的录音已不存在，请刷新后再试", "The recording in this memo no longer exists. Refresh and try again"));
    const key = `${memo.path}:${memo.id || memo.startLine}:${file.path}`;
    this.memoTranscriptionStarting ||= new Set();
    if (this.memoTranscriptionStarting.has(key)) return;
    this.memoTranscriptionStarting.add(key);
    this.app.workspace.trigger?.("crisp-asr:state");
    let identityKey;
    try {
      const current = await this.memoStore.ensureIdentity(memo);
      if (memoHasTranscriptFor(current, file.path, this.memoStore.transcriptMatch(current))) return;
      identityKey = `${current.path}:${current.id}:${file.path}`;
      this.memoTranscriptionStarting.add(identityKey);
      await asr.transcribeMemoAudio(file, { memoId: current.id, path: current.path });
    } finally {
      this.memoTranscriptionStarting.delete(key);
      if (identityKey) this.memoTranscriptionStarting.delete(identityKey);
      this.app.workspace.trigger?.("crisp-asr:state");
    }
  }

  /** 支持长按实时听写的 Crisp ASR（0.9.0 起）。 */
  memoDictationAsr() {
    const asr = this.app.plugins?.plugins?.["crisp-asr"];
    if (!asr || asr.unloaded || typeof asr.startMemoDictation !== "function" || typeof asr.stopMemoDictation !== "function") return null;
    return asr;
  }

  /** 命令入口：打开速记面板，在输入框光标处开始听写；正在听写时结束。 */
  async toggleMemoDictation() {
    await this.activateMemoView();
    const view = this.app.workspace.getLeavesOfType(VIEW_TYPE_MEMO)[0]?.view;
    if (view?.toggleDictation) await view.toggleDictation();
  }

  memoTempo() {
    const tempo = this.app.plugins?.plugins?.["crisp-tempo"];
    if (!tempo || tempo.unloaded || typeof tempo.createTaskFromSource !== "function" || typeof tempo.getTasksBySource !== "function") return null;
    return tempo;
  }

  /** 速记转为 Tempo 任务：Tempo 按来源去重，所以重复点击、写凭据失败后重试都只有一条任务。 */
  async convertMemoToTempo(memo) {
    const tempo = this.memoTempo();
    if (!tempo) throw new Error(tr("转为任务需要 Crisp Tempo 0.2.0 或更高版本", "Converting to a task requires Crisp Tempo 0.2.0 or later"));
    this.memoTempoStarting ||= new Map();
    const key = `${memo.path}:${memo.id || memo.startLine}`;
    if (this.memoTempoStarting.has(key)) return this.memoTempoStarting.get(key);
    const job = (async () => {
      const current = await this.memoStore.ensureIdentity(memo);
      const task = await tempo.createTaskFromSource({
        sourceId: `crisp-pulse:${current.id}`,
        title: memoTaskTitle(current.text, { date: memo.date, time: memo.time }),
        description: current.text,
        notePath: current.path,
      });
      await this.memoStore.attachTempoTask(current.id, current.path, task.id);
      this.refreshMemoViews();
      return task;
    })();
    this.memoTempoStarting.set(key, job);
    try { return await job; } finally { this.memoTempoStarting.delete(key); }
  }

  /** 其他插件读这个版本号判断能否调用 captureMemoFromSource / revealMemo。 */
  get memoCaptureApiVersion() { return MEMO_CAPTURE_API_VERSION; }

  /** 其他插件把内容记成速记（如 Annotations 的「记为想法」）。同一 sourceId 只记一条：
      再次调用返回原来那条，revision 不同时 changed 为 true，原速记不改写。 */
  async captureMemoFromSource(request) {
    const { apiVersion, sourceId, revision = "", note = "", quote = "", sourcePath = null, subpath = null } = request || {};
    if (!Number.isInteger(apiVersion) || apiVersion < 1) throw new Error(tr("速记接口版本无效", "Invalid memo API version"));
    if (apiVersion > MEMO_CAPTURE_API_VERSION) throw new Error(tr("请先更新 Crisp Pulse 再记录", "Update Crisp Pulse before capturing"));
    if (typeof sourceId !== "string" || !/^[a-z][a-z0-9-]*:[A-Za-z0-9_-]{1,128}$/.test(sourceId)) throw new Error(tr("来源标识无效", "Invalid source ID"));
    if (typeof revision !== "string" || (revision && !/^[A-Za-z0-9_-]{1,64}$/.test(revision))) throw new Error(tr("来源版本无效", "Invalid source revision"));
    if (!String(note ?? "").trim() && !String(quote ?? "").trim()) throw new Error(tr("速记内容为空", "The memo is empty"));
    this.memoSourceCaptures ||= new Map();
    if (this.memoSourceCaptures.has(sourceId)) {
      const { memo } = await this.memoSourceCaptures.get(sourceId);
      return { status: "existing", changed: false, memo };
    }
    const job = (async () => {
      const [existing] = await this.memoStore.findSourceMemos(sourceId);
      if (existing) return { status: "existing", changed: existing.revision !== revision, memo: { id: existing.id, path: existing.path } };
      const now = new Date();
      const text = buildSourceMemoText({ note, quote, link: await this.memoSourceLink(sourcePath, subpath, now) });
      const memo = await this.memoStore.captureFromSource({ sourceId, revision, text }, now);
      this.refreshMemoViews();
      return { status: "created", changed: false, memo };
    })();
    this.memoSourceCaptures.set(sourceId, job);
    try { return await job; } finally { this.memoSourceCaptures.delete(sourceId); }
  }

  /** 出处链接：按 Obsidian 的链接格式设置生成；笔记已不在就只写路径。 */
  async memoSourceLink(sourcePath, subpath, now) {
    if (typeof sourcePath !== "string" || !sourcePath) return "";
    const heading = typeof subpath === "string" ? subpath.replace(/[#|^[\]]/g, " ").replace(/\s+/g, " ").trim() : "";
    const file = this.app.vault.getAbstractFileByPath(sourcePath);
    const from = await this.memoStore.memoFilePath(now);
    if (file && typeof this.app.fileManager?.generateMarkdownLink === "function") return this.app.fileManager.generateMarkdownLink(file, from, heading ? `#${heading}` : undefined);
    return `[[${sourcePath.replace(/\.md$/, "")}${heading ? `#${heading}` : ""}]]`;
  }

  /** 打开速记面板，只显示这一条。 */
  async revealMemo({ id } = {}) {
    if (!/^[a-zA-Z0-9-]+$/.test(id || "")) throw new Error(tr("速记标识无效", "Invalid memo ID"));
    await this.activateMemoView();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MEMO)) leaf.view?.focusMemo?.(id);
  }

  async validateMemoTranscriptionTarget(job) {
    const { file, memo } = await this.memoStore.findMemoIdentity(job.memoId, job.path);
    if (!memoAudioFiles({ ...memo, path: file.path }, this.app).some((audio) => audio.path === job.sourcePath)) throw new Error(tr("原速记中的录音已被移除，请检查后重试", "The recording was removed from the original memo. Check it and try again"));
    return { path: file.path };
  }

  async applyMemoTranscript(job) {
    const result = await this.memoStore.applyTranscript(job);
    this.refreshMemoViews();
    return result;
  }

  async activateMemoView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_MEMO)[0];
    if (!leaf) {
      // 右侧栏不可用时 getRightLeaf 返回 null，改在主区新开标签页
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE_MEMO, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  refreshMemoViews() {
    window.clearTimeout(this.memoRefreshTimer);
    this.memoRefreshTimer = window.setTimeout(() => {
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MEMO)) {
        const root = leaf.view?.containerEl?.children?.[1];
        // 正在输入（输入框有内容）时不重建，避免打断；刚提交完输入框是空的，照常刷新
        const active = root?.ownerDocument.activeElement;
        if (root && root.contains(active) && active.tagName === "TEXTAREA" && active.value.trim()) continue;
        leaf.view?.reload?.();
      }
    }, 400);
  }

  async openMemoSource(memo) {
    const file = this.app.vault.getAbstractFileByPath(memo.path);
    if (!file) return;
    await this.app.workspace.getLeaf(false).openFile(file, { eState: { line: memo.startLine } });
  }

  async createUnique(path, content) {
    const base = path.replace(/\.md$/, "");
    let target = path;
    for (let n = 2; this.app.vault.getAbstractFileByPath(target); n++) target = `${base} ${n}.md`;
    const folder = target.includes("/") ? target.slice(0, target.lastIndexOf("/")) : "";
    if (folder) await this.memoStore.ensureFolder(folder);
    return this.app.vault.create(target, content);
  }

  async convertMemoToNote(memo) {
    return this.runMemoConversion(memo, "note", async () => {
      const current = await this.memoStore.ensureIdentity(memo);
      let folder = this.settings.memoNoteFolder || this.app.fileManager.getNewFileParent?.(current.path)?.path || "";
      if (folder === "/") folder = "";
      return this.finishMemoDocument(current, "note", buildMemoNote({ memo: current, folder }));
    });
  }

  async convertMemoToQuestion(memo) {
    return this.runMemoConversion(memo, "question", async () => {
      const source = this.app.vault.getAbstractFileByPath(memo.path);
      if (!source) throw new Error(tr("速记所在的文件已不存在", "The file containing this memo no longer exists"));
      const topic = this.app.metadataCache.getFileCache(source)?.frontmatter?.topic || /^Topics\/([^/]+)\//.exec(memo.path)?.[1] || this.memoStore.anksTopic();
      if (!this.memoStore.anksTopics().includes(topic)) throw new Error(tr("速记所属 Topic 不存在，请先检查来源或选择 Topic", "The memo’s Topic does not exist. Check the source or choose a Topic first"));
      const target = await this.memoStore.anksTarget(memo.date, topic);
      const route = await this.memoStore.readJson(ANKS_ROUTE_CONTRACT_PATH);
      const rule = ((route?.data || route)?.rules || []).find((r) => r.name === "question-backlog");
      const folder = (rule?.target || "Topics/{topic}/questions/backlog").replace("{topic}", target.topic);
      const current = await this.memoStore.ensureIdentity(memo);
      return this.finishMemoDocument(current, "question", buildMemoQuestionNote({ memo: current, topic: target.topic, folder, now: new Date() }));
    });
  }

  runMemoConversion(memo, kind, action) {
    this.memoConversions ||= new Map();
    const key = `${memo.path}:${memo.startLine}:${kind}`;
    if (this.memoConversions.has(key)) return this.memoConversions.get(key);
    const pending = Promise.resolve().then(action).finally(() => this.memoConversions.delete(key));
    this.memoConversions.set(key, pending);
    return pending;
  }

  async finishMemoDocument(memo, kind, note) {
    const marker = `<!-- crisp-pulse-conversion:${memo.id}:${kind} -->`;
    let file = null;
    // The receipt lives with the created document, so retry also works after a restart or rename.
    for (const candidate of memo.identityCreated ? [] : this.app.vault.getMarkdownFiles()) {
      const text = await this.app.vault.cachedRead(candidate);
      if (!text.includes(marker)) continue;
      // 只认代码块外的凭据：模板或说明文档里贴的示例不算已转换
      const lines = text.split("\n");
      const fenced = memoFencedLines(lines);
      if (lines.some((line, i) => line === marker && !fenced.has(i))) { file = candidate; break; }
    }
    if (!file) file = await this.createUnique(note.path, `${this.memoStore.relinkFor(note.content, memo.path, note.path)}\n${marker}\n`);
    try {
      await this.memoStore.linkBack(memo, file.path.replace(/\.md$/, ""));
    } catch (error) {
      throw new Error(tr(`已创建 ${file.path}，但来源回链未完成：${error.message || error}。目标文件已保留，重试会复用它`, `Created ${file.path}, but linking back to the source failed: ${error.message || error}. The new file was kept and will be reused on retry`));
    }
    new Notice(tr(`Crisp Pulse：已转为${kind === "question" ? "问题" : "笔记"} ${file.basename}`, `Crisp Pulse: converted to ${kind === "question" ? "a question" : "a note"}: ${file.basename}`));
    await this.app.workspace.getLeaf(false).openFile(file);
    return file;
  }

  async convertMemoToNow(memo) {
    return this.runMemoConversion(memo, "now", async () => {
      const file = this.app.vault.getAbstractFileByPath(ANKS_NOW_FILE);
      if (!file) throw new Error(tr(`找不到 ${ANKS_NOW_FILE}`, `Cannot find ${ANKS_NOW_FILE}`));
      const current = await this.memoStore.ensureIdentity(memo);
      const blockId = `pulse-memo-${current.id}`;
      await this.app.vault.process(file, (text) => {
        const lines = text.split("\n");
        const fenced = memoFencedLines(lines);
        if (lines.some((line, i) => !fenced.has(i) && line.trimEnd().endsWith(` ^${blockId}`))) return text;
        return `${text.replace(/\s*$/, "")}\n${this.memoStore.relinkFor(buildMemoNowLine(current), current.path, ANKS_NOW_FILE)} ^${blockId}\n`;
      });
      try {
        await this.memoStore.linkBack(current, `${ANKS_NOW_FILE.replace(/\.md$/, "")}#^${blockId}`);
      } catch (error) {
        throw new Error(tr(`已加入 Now 行动，但来源回链未完成：${error.message || error}。重试不会重复添加行动`, `Added to Now actions, but linking back to the source failed: ${error.message || error}. Retrying will not add the action twice`));
      }
      new Notice(tr("Crisp Pulse：已加入 Now 行动", "Crisp Pulse: added to Now actions"));
    });
  }

  promptRenameTag(from, done) {
    new CrispPulseMemoInputModal(this.app, tr(`把 #${from} 改名为`, `Rename #${from} to`), tr("新标签名（可含 / 表示层级）", "New tag name (use / for nesting)"), from, async (value) => {
      const to = value.replace(/^#+/, "").trim();
      if (to === from) return;
      try {
        const preview = await this.memoStore.previewTagRename(from);
        const modal = new Modal(this.app);
        modal.onOpen = () => {
          const { contentEl } = modal;
          contentEl.createEl("h3", { text: `#${from} → #${to}` });
          contentEl.createEl("p", { text: tr(`将改写 ${preview.files} 个文件里的 ${preview.memos} 条速记（含子标签 #${from}/…）。只改速记块，日笔记其他段落里的同名标签不动。`, `This will rewrite ${plural(preview.memos, "memo")} in ${plural(preview.files, "file")} (including nested tags #${from}/…). Only memo blocks change; the same tag elsewhere in daily notes is left alone.`) });
          const row = contentEl.createDiv({ cls: "crisp-pulse-memo-modal-row" });
          row.createEl("button", { text: tr("取消", "Cancel") }).addEventListener("click", () => modal.close());
          const ok = row.createEl("button", { cls: "mod-cta", text: tr("改名", "Rename") });
          ok.addEventListener("click", async () => {
            modal.close();
            try {
              const result = await this.memoStore.renameTag(from, to);
              new Notice(tr(`Crisp Pulse：已改写 ${result.memos} 条速记`, `Crisp Pulse: rewrote ${plural(result.memos, "memo")}`));
              done?.();
            } catch (error) {
              new Notice(tr(`Crisp Pulse 速记：${error.message || error}`, `Crisp Pulse memos: ${error.message || error}`), 8000);
            }
          });
        };
        modal.onClose = () => modal.contentEl.empty();
        modal.open();
      } catch (error) {
        new Notice(tr(`Crisp Pulse 速记：${error.message || error}`, `Crisp Pulse memos: ${error.message || error}`), 8000);
      }
    }).open();
  }

  async handleMemoUrl(params) {
    const { text, open } = parseMemoUrlParams(params);
    if (text) {
      try {
        await this.memoStore.capture(text, new Date());
        new Notice(tr("Crisp Pulse：已记录速记", "Crisp Pulse: memo saved"));
        this.refreshMemoViews();
      } catch (error) {
        new Notice(tr(`Crisp Pulse 速记：${error.message || error}`, `Crisp Pulse memos: ${error.message || error}`), 8000);
        return;
      }
    }
    if (open) await this.activateMemoView();
  }

  /** 每日回顾提醒：Obsidian 开着时，到点提醒一次；关掉 Obsidian 不会提醒。 */
  async checkMemoReviewReminder(now = new Date()) {
    const time = String(this.settings.memoReviewTime || "").trim();
    if (!/^\d{1,2}:\d{2}$/.test(time)) return;
    const today = dateKey(now);
    if (this.settings.memoReviewNotifiedOn === today) return;
    const [h, m] = time.split(":").map(Number);
    if (now.getHours() * 60 + now.getMinutes() < h * 60 + m) return;
    this.settings.memoReviewNotifiedOn = today;
    await this.savePluginData();
    const tags = String(this.settings.memoReviewTags || "").split(/[,，\s]+/).map((t) => t.replace(/^#+/, "").trim()).filter(Boolean);
    const review = selectDailyReview(await this.memoStore.list(), today, { count: this.settings.memoReviewCount, tags, withinDays: Number(this.settings.memoReviewWithinDays) || 0 });
    if (!review.length) return;
    const open = async () => {
      await this.activateMemoView();
      const view = this.app.workspace.getLeavesOfType(VIEW_TYPE_MEMO)[0]?.view;
      if (view) { view.tab = "review"; view.render(); }
    };
    const NotificationCtor = typeof window !== "undefined" ? window.Notification : null;
    if (NotificationCtor && NotificationCtor.permission === "granted") {
      const n = new NotificationCtor(tr("Crisp Pulse 每日回顾", "Crisp Pulse daily review"), { body: tr(`今天有 ${review.length} 条旧速记等你回看：${review[0].text.slice(0, 40)}`, `${plural(review.length, "older memo")} to look back on today: ${review[0].text.slice(0, 40)}`) });
      n.onclick = () => { window.focus?.(); open(); };
    } else {
      new Notice(tr(`Crisp Pulse：今日回顾 ${review.length} 条，打开速记的「回顾」页查看`, `Crisp Pulse: ${plural(review.length, "memo")} to review today. Open the Review tab in memos`), 10000);
    }
  }

  confirmAction(title, message, confirmText, onConfirm, onCancel) {
    const modal = new Modal(this.app);
    let decided = false;
    modal.onOpen = () => {
      const { contentEl } = modal;
      contentEl.createEl("h3", { text: title });
      contentEl.createEl("p", { cls: "crisp-pulse-memo-muted", text: message });
      const row = contentEl.createDiv({ cls: "crisp-pulse-memo-modal-row" });
      row.createEl("button", { text: tr("取消", "Cancel") }).addEventListener("click", () => modal.close());
      row.createEl("button", { cls: "mod-warning", text: confirmText }).addEventListener("click", () => { decided = true; modal.close(); onConfirm(); });
    };
    modal.onClose = () => { modal.contentEl.empty(); if (!decided) onCancel?.(); };
    modal.open();
  }

  confirmDeleteMemo(memo, done) {
    const modal = new Modal(this.app);
    modal.onOpen = () => {
      const { contentEl } = modal;
      contentEl.createEl("h3", { text: tr("删除这条速记？", "Delete this memo?") });
      contentEl.createEl("p", { cls: "crisp-pulse-memo-muted", text: `${memo.date} ${memo.time} · ${memo.path}` });
      contentEl.createEl("blockquote", { text: memo.text.slice(0, 200) });
      contentEl.createEl("p", { cls: "crisp-pulse-memo-muted", text: tr(`只从所在笔记里移除这一块，放进速记回收站，${MEMO_TRASH_DAYS} 天内可以恢复。`, `Only this block is removed from its note and moved to the memo trash, where it can be restored for ${MEMO_TRASH_DAYS} days.`) });
      const row = contentEl.createDiv({ cls: "crisp-pulse-memo-modal-row" });
      row.createEl("button", { text: tr("取消", "Cancel") }).addEventListener("click", () => modal.close());
      const del = row.createEl("button", { cls: "mod-warning", text: tr("删除", "Delete") });
      del.addEventListener("click", async () => {
        modal.close();
        try {
          await this.memoStore.remove(memo);
          done?.();
        } catch (error) {
          new Notice(tr(`Crisp Pulse 速记：${error.message || error}`, `Crisp Pulse memos: ${error.message || error}`), 8000);
        }
      });
    };
    modal.onClose = () => modal.contentEl.empty();
    modal.open();
  }
}

/* ==========================================================================
   Crisp Pulse View (ItemView)
   ========================================================================== */

/** 把一段活跃时间按本地整点拆开（跨午夜即换日），供 24 小时活跃时段统计。 */
function splitActiveInterval(startMs, endMs) {
  const pieces = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const at = new Date(cursor);
    const nextHour = new Date(at.getFullYear(), at.getMonth(), at.getDate(), at.getHours() + 1).getTime();
    const stop = Math.min(endMs, nextHour);
    pieces.push({ day: dateKey(at), hour: at.getHours(), minutes: (stop - cursor) / 60000 });
    cursor = stop;
  }
  return pieces;
}

const HOURLY_WEEKDAY_LABELS = PULSE_ZH ? ["日", "一", "二", "三", "四", "五", "六"] : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** 24 小时活跃分布：只用带 hourly 的日期（开始按小时记录之后）；样本不足时不下「最活跃时段」的结论。 */
function buildHourlyProfile(daily, dates, includeRecord, { weekStartsOn = "sunday", minSample = 120, windowHours = 3 } = {}) {
  const hours = Array(24).fill(0);
  const firstDow = weekStartsOn === "monday" ? 1 : 0;
  const matrix = Array.from({ length: 7 }, (_, i) => {
    const dow = (firstDow + i) % 7;
    return { dow, label: HOURLY_WEEKDAY_LABELS[dow], hours: Array(24).fill(0) };
  });
  let days = 0;
  let missingDays = 0;
  for (const key of dates) {
    const record = daily[key];
    if (!record || !includeRecord(record, key)) continue;
    const hourly = record.activity?.hourly;
    if (!Array.isArray(hourly) || hourly.length !== 24) {
      if ((record.activity?.activeMinutes || 0) > 0) missingDays++;
      continue;
    }
    days++;
    const [y, m, d] = key.split("-").map(Number);
    const row = matrix[(new Date(y, m - 1, d).getDay() - firstDow + 7) % 7];
    hourly.forEach((v, h) => {
      const value = Number.isFinite(v) && v > 0 ? v : 0;
      hours[h] += value;
      row.hours[h] += value;
    });
  }
  const total = hours.reduce((a, b) => a + b, 0);
  let peak = null;
  if (total >= minSample && total > 0) {
    for (let start = 0; start < 24; start++) {
      let minutes = 0;
      for (let k = 0; k < windowHours; k++) minutes += hours[(start + k) % 24];
      if (!peak || minutes > peak.minutes) peak = { start, end: (start + windowHours) % 24, minutes, share: minutes / total };
    }
  }
  let firstDay = null;
  for (const key of Object.keys(daily).sort()) {
    if (Array.isArray(daily[key]?.activity?.hourly)) { firstDay = key; break; }
  }
  return { hours, matrix, total, days, missingDays, peak, needMinutes: peak ? 0 : Math.max(0, Math.ceil(minSample - total)), minSample, firstDay };
}

// Analytics uses daily aggregates only; a missing/excluded day is never invented as zero.
function buildAnalyticsData(daily, dates, includeRecord) {
  const fields = { score: 'contribution', wordsAdded: 'contribution', wordsRemoved: 'contribution', rewrittenWords: 'contribution', notesCreated: 'contribution', tasksCompleted: 'contribution', activeMinutes: 'activity', focusMinutes: 'activity' };
  const totals = Object.fromEntries(Object.keys(fields).map(key => [key, 0]));
  let recordedDays = 0;
  const points = dates.map(date => {
    const record = daily[date];
    const status = !record ? 'missing' : !includeRecord(record, date) ? 'excluded' : 'included';
    const point = { date, status, quality: record?.quality || null, legacy: !!record?.legacyUnverified };
    if (status === 'included') recordedDays++;
    for (const [field, group] of Object.entries(fields)) {
      const value = status === 'included' ? record[group]?.[field] : null;
      point[field] = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
      if (point[field] !== null) totals[field] += point[field];
    }
    return point;
  });
  for (const key of Object.keys(totals)) totals[key] = Math.round(totals[key] * 100) / 100;
  return { points, totals, recordedDays };
}

function analyticsScale(maximum) {
  if (!(maximum > 0)) return { max: 1, ticks: [0, 0.25, 0.5, 0.75, 1] };
  const rawStep = maximum / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 2.5, 3, 4, 5, 7.5, 10].find(n => n * magnitude >= rawStep) * magnitude;
  return { max: step * 4, ticks: [0, 1, 2, 3, 4].map(n => n * step) };
}

function analyticsLinePath(points, field, x, y) {
  let connected = false;
  const commands = [];
  points.forEach((point, index) => {
    const value = point[field];
    if (value === null || value === undefined || !Number.isFinite(value)) { connected = false; return; }
    commands.push(`${connected ? 'L' : 'M'}${x(index)},${y(value)}`);
    connected = true;
  });
  return commands.join(' ');
}

// Split each day's added words by recorded source. Sources are clamped to the day's total in a fixed
// order, and whatever older records never classified stays "historical" instead of being guessed.
function buildWritingMix(daily, dates, includeRecord) {
  const parts = { typed: 0, capture: 0, system: 0, historical: 0 };
  let external = 0;
  const sourceKeys = { system: 'system', capture: 'capture', typed: 'unattributed' };
  const days = dates.map(date => {
    const record = daily[date];
    if (!record || !includeRecord(record, date)) return null;
    external += Math.max(0, Number(record.contribution?.externalWords) || 0);
    let left = Math.max(0, Number(record.contribution?.wordsAdded) || 0);
    const day = { date, typed: 0, capture: 0, system: 0, historical: 0 };
    for (const [part, source] of Object.entries(sourceKeys)) {
      let sum = 0;
      for (const file of Object.values(record.files || {})) {
        const amount = file?.sourceWords?.[source];
        if (Number.isFinite(amount) && amount > 0) sum += amount;
      }
      day[part] = Math.min(left, sum);
      left -= day[part];
    }
    day.historical = left;
    for (const key of Object.keys(parts)) parts[key] += day[key];
    return day;
  });
  return { parts, total: Object.values(parts).reduce((sum, value) => sum + value, 0), external, days };
}

// Project-level folder for a note: "Topics/self-media/x.md" -> "Topics/self-media", "Core/x.md" -> "Core".
function analyticsFolderOf(path) {
  const parts = String(path).split('/');
  if (parts.length > 2) return `${parts[0]}/${parts[1]}`;
  return parts.length === 2 ? parts[0] : PULSE_ROOT_DIR;
}

// Where recorded work went: one count per note per day, top folders plus a folded "其他" tail.
// System artifacts (logs, backups, manifests) are left out, as in the writing-source card.
function buildFolderShare(daily, dates, includeRecord, limit = 5) {
  const groups = new Map();
  for (const date of dates) {
    const record = daily[date];
    if (!record || !includeRecord(record, date)) continue;
    for (const [path, file] of Object.entries(record.files || {})) {
      if (isSystemArtifact(path)) continue;
      const name = analyticsFolderOf(path);
      const group = groups.get(name) || { name, count: 0, words: 0 };
      group.count += 1;
      group.words += Number.isFinite(file?.wordsAdded) && file.wordsAdded > 0 ? file.wordsAdded : 0;
      groups.set(name, group);
    }
  }
  const sorted = [...groups.values()].sort((a, b) => b.count - a.count || b.words - a.words || a.name.localeCompare(b.name));
  const items = sorted.slice(0, limit);
  const tail = sorted.slice(limit);
  if (tail.length) items.push({ name: PULSE_OTHER_GROUP, count: tail.reduce((s, g) => s + g.count, 0), words: tail.reduce((s, g) => s + g.words, 0), folded: tail.length });
  const total = items.reduce((sum, item) => sum + item.count, 0);
  // Largest-remainder rounding keeps the legend summing to exactly 100%.
  for (const item of items) item.percent = total ? Math.floor(item.count * 100 / total) : 0;
  let remainder = total ? 100 - items.reduce((sum, item) => sum + item.percent, 0) : 0;
  for (const item of [...items].sort((a, b) => (b.count * 100 / total - b.percent) - (a.count * 100 / total - a.percent))) { if (remainder-- <= 0) break; item.percent++; }
  return { total, items };
}

// Robust upper reference: the value at the given quantile of the positive samples.
function yearQuantile(values, q) {
  const sorted = values.filter(v => v > 0).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0;
}

const YEAR_DIMENSIONS = [
  { key: 'write', field: 'words', label: tr('写作', 'writing') },
  { key: 'interact', field: 'active', label: tr('交互', 'interaction') },
  { key: 'focus', field: 'focus', label: tr('专注', 'focus') },
  { key: 'create', field: 'notes', label: tr('新建', 'new notes') }
];

// One entry per calendar day of the year. Each dimension is normalised against its own 90th percentile
// so a day's "dominant" colour means "unusually high for this kind of work", not "largest raw number".
function buildYearProfile(daily, year, includeRecord, todayKey = getTodayKey()) {
  const dates = [];
  for (let d = new Date(year, 0, 1); d.getFullYear() === year; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) dates.push(dateKey(d));
  return { ...buildDayProfile(daily, dates, includeRecord, todayKey), year };
}

// Default portrait window: from the first included record to today, never shorter than minDays.
// Capped at maxDays so years of history do not crowd the default view; older years stay one click away.
function portraitDates(daily, includeRecord, todayKey = getTodayKey(), minDays = 30, maxDays = 365) {
  const first = Object.keys(daily).filter(key => /^\d{4}-\d{2}-\d{2}$/.test(key) && key <= todayKey && daily[key] && includeRecord(daily[key], key)).sort()[0];
  const [y, m, d] = todayKey.split('-').map(Number);
  const earliest = dateKey(new Date(y, m - 1, d - minDays + 1));
  const oldest = dateKey(new Date(y, m - 1, d - maxDays + 1));
  const start = !first || first > earliest ? earliest : first < oldest ? oldest : first;
  const dates = [];
  const [sy, sm, sd] = start.split('-').map(Number);
  for (let i = 0; ; i++) {
    const key = dateKey(new Date(sy, sm - 1, sd + i));
    if (key > todayKey) break;
    dates.push(key);
  }
  return dates;
}

function buildDayProfile(daily, dates, includeRecord, todayKey = getTodayKey()) {
  const days = [];
  for (const date of dates) {
    const d = new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
    const record = daily[date];
    const status = date > todayKey ? 'future' : !record ? 'missing' : !includeRecord(record, date) ? 'excluded' : 'included';
    const value = (group, field) => { const v = status === 'included' ? record[group]?.[field] : 0; return Number.isFinite(v) && v > 0 ? v : 0; };
    days.push({ date, month: d.getMonth(), status, score: value('contribution', 'score'), words: value('contribution', 'wordsAdded'), notes: value('contribution', 'notesCreated'), tasks: value('contribution', 'tasksCompleted'), active: value('activity', 'activeMinutes'), focus: value('activity', 'focusMinutes') });
  }
  scoreProfileUnits(days);
  const included = days.filter(day => day.status === 'included');
  const sum = field => Math.round(included.reduce((total, day) => total + day[field], 0) * 10) / 10;
  return { unit: 'day', days, recordedDays: included.length, activeDays: included.filter(day => day.score > 0).length, totals: { score: sum('score'), words: sum('words'), active: sum('active'), focus: sum('focus'), notes: sum('notes') } };
}

// Shared by day and week units: dimensions against their own 90th percentile, petal length against the 98th.
function scoreProfileUnits(units) {
  const included = units.filter(unit => unit.status === 'included');
  const scales = Object.fromEntries(YEAR_DIMENSIONS.map(dim => [dim.key, yearQuantile(included.map(unit => unit[dim.field]), 0.9)]));
  const scoreRef = yearQuantile(included.map(unit => unit.score), 0.98);
  const positiveScores = included.map(unit => unit.score).filter(v => v > 0).sort((a, b) => a - b);
  for (const unit of units) {
    unit.dims = Object.fromEntries(YEAR_DIMENSIONS.map(dim => [dim.key, scales[dim.key] > 0 ? Math.min(1, unit[dim.field] / scales[dim.key]) : 0]));
    unit.dominant = null;
    for (const dim of YEAR_DIMENSIONS) if (unit.dims[dim.key] > 0 && (!unit.dominant || unit.dims[dim.key] > unit.dims[unit.dominant])) unit.dominant = dim.key;
    unit.length = scoreRef > 0 ? Math.min(1, Math.sqrt(unit.score / scoreRef)) : 0;
    unit.intensity = unit.score > 0 && positiveScores.length ? positiveScores.filter(v => v <= unit.score).length / positiveScores.length : 0;
  }
  return units;
}

// Long spans fold into Monday weeks so the ring and fingerprint stay legible; totals stay those of the days.
function buildWeekProfile(dayProfile) {
  const weeks = [];
  let week = null;
  for (const day of dayProfile.days) {
    const [y, m, d] = day.date.split('-').map(Number);
    if (!week || new Date(y, m - 1, d).getDay() === 1) {
      week = { date: day.date, end: day.date, month: day.month, unit: 'week', statuses: new Set(), score: 0, words: 0, notes: 0, tasks: 0, active: 0, focus: 0, activeDays: 0, bestDate: null, bestScore: -1 };
      weeks.push(week);
    }
    week.end = day.date;
    week.statuses.add(day.status);
    if (day.status !== 'included') continue;
    for (const field of ['score', 'words', 'notes', 'tasks', 'active', 'focus']) week[field] += day[field];
    if (day.score > 0) week.activeDays++;
    if (day.score > week.bestScore) { week.bestScore = day.score; week.bestDate = day.date; }
  }
  for (const w of weeks) {
    w.status = w.statuses.has('included') ? 'included' : w.statuses.size === 1 && w.statuses.has('future') ? 'future' : w.statuses.has('excluded') ? 'excluded' : 'missing';
    for (const field of ['score', 'words', 'notes', 'tasks', 'active', 'focus']) w[field] = Math.round(w[field] * 10) / 10;
    delete w.statuses; delete w.bestScore;
  }
  scoreProfileUnits(weeks);
  return { ...dayProfile, unit: 'week', days: weeks };
}

// Words written into system folders (logs, backups, manifests) are machine output, not the author's pace.
function paceSystemWords(record) {
  let sum = 0;
  for (const file of Object.values(record.files || {})) {
    const amount = file?.sourceWords?.system;
    if (Number.isFinite(amount) && amount > 0) sum += amount;
  }
  return sum;
}

const PACE_FIELDS = {
  score: record => record.contribution?.score,
  words: record => Math.max(0, (Number(record.contribution?.wordsAdded) || 0) - paceSystemWords(record)),
  active: record => (record.contribution?.score > 0 ? 1 : 0),
  focus: record => record.activity?.focusMinutes
};

// This month's running total against the same day of last month. A last-month day past this month's length
// keeps its total; days without an included record add nothing and are counted separately, never invented.
function buildMonthPace(daily, todayKey, includeRecord, field) {
  const read = PACE_FIELDS[field];
  const [y, m, today] = todayKey.split('-').map(Number);
  const days = new Date(y, m, 0).getDate();
  const prevYear = m === 1 ? y - 1 : y, prevMonth = m === 1 ? 12 : m - 1;
  const prevDays = new Date(prevYear, prevMonth, 0).getDate();
  const valueOn = key => {
    const record = daily[key];
    if (!record || !includeRecord(record, key)) return null;
    const v = read(record);
    return Number.isFinite(v) && v > 0 ? v : 0;
  };
  const keyOf = (yy, mm, dd) => `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  const actual = [];
  let running = 0, missingDays = 0;
  for (let d = 1; d <= today; d++) {
    const v = valueOn(keyOf(y, m, d));
    if (v === null) missingDays++;
    running += v || 0;
    actual.push(Math.round(running * 10) / 10);
  }
  const prevCum = [];
  let prevRunning = 0, prevRecorded = 0, prevFirstDay = null;
  for (let d = 1; d <= prevDays; d++) {
    const v = valueOn(keyOf(prevYear, prevMonth, d));
    if (v !== null) { prevRecorded++; if (prevFirstDay === null) prevFirstDay = d; }
    prevRunning += v || 0;
    prevCum.push(prevRunning);
  }
  const baselineTotal = Math.round(prevRunning * 10) / 10;
  const baseline = prevRecorded && baselineTotal > 0 ? Array.from({ length: days }, (_, i) => Math.round(prevCum[Math.min(i, prevDays - 1)] * 10) / 10) : null;
  const actualToDate = actual[today - 1] || 0;
  const baselineToDate = baseline ? baseline[today - 1] : 0;
  const deltaPct = baselineToDate > 0 ? Math.round((actualToDate - baselineToDate) / baselineToDate * 100) : null;
  // Recent pace: the last 7 calendar days, averaged over the days that actually hold a record.
  let recentSum = 0, recentDays = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(y, m - 1, today - i);
    const v = valueOn(keyOf(d.getFullYear(), d.getMonth() + 1, d.getDate()));
    if (v === null) continue;
    recentSum += v; recentDays++;
  }
  const recentRate = recentDays ? recentSum / recentDays : null;
  const remaining = days - today;
  const projection = recentRate === null ? null : actualToDate + recentRate * remaining;
  const needPerDay = baseline && actualToDate < baselineTotal && remaining > 0 ? (baselineTotal - actualToDate) / remaining : null;
  return { field, year: y, month: m, days, today, actual, baseline, baselineTotal, baselineToDate, actualToDate, deltaPct, recentRate, recentDays, projection, needPerDay, missingDays, prevMonth, prevFirstDay };
}

// Weekly layers (Monday-based, clipped to the given dates) split by a fixed set of project folders,
// so a folder worked on week after week lines up into a continuous vein.
function buildStrata(daily, dates, includeRecord, limit = 6) {
  const share = buildFolderShare(daily, dates, includeRecord, limit);
  const folders = share.items.map(item => item.name);
  const named = new Set(folders.filter(name => name !== PULSE_OTHER_GROUP));
  const weeks = [];
  let week = null;
  for (const date of dates) {
    const [y, m, d] = date.split('-').map(Number);
    if (!week || new Date(y, m - 1, d).getDay() === 1) weeks.push(week = { start: date, end: date, words: 0, total: 0, counts: {}, recorded: false });
    week.end = date;
    const record = daily[date];
    if (!record || !includeRecord(record, date)) continue;
    week.recorded = true;
    const words = record.contribution?.wordsAdded;
    if (Number.isFinite(words) && words > 0) week.words += words;
    for (const path of Object.keys(record.files || {})) {
      if (isSystemArtifact(path)) continue;
      const folder = analyticsFolderOf(path);
      const name = named.has(folder) ? folder : PULSE_OTHER_GROUP;
      week.counts[name] = (week.counts[name] || 0) + 1;
      week.total += 1;
    }
  }
  return { folders, weeks };
}

// Fingerprint colours are resolved per theme and written inline, so the exported PNG matches what is on screen.
const FINGERPRINT_PALETTES = {
  dark: { bg: '#15171a', border: '#262a2f', title: '#7d838c', heading: '#ece9e3', empty: '#1e2125', zero: '#2a2e33', tick: '#5d636b', text: '#c9c6c0', write: '#a48ef0', interact: '#6cc6a2', focus: '#edac68', create: '#ec87a4' },
  light: { bg: '#fbfaf8', border: '#e7e4df', title: '#8b9097', heading: '#1f2328', empty: '#efedea', zero: '#e3e0db', tick: '#a2a6ac', text: '#3b4046', write: '#7b5cc8', interact: '#3f9f7c', focus: '#d98a37', create: '#d0577a' }
};

// Axis labels that stay readable at any span: Mondays for short windows, month starts for long ones.
function portraitTicks(days) {
  const ticks = [];
  if (days[0]?.unit === 'week') {
    days.forEach((week, i) => { if (i > 0 && week.month !== days[i - 1].month) ticks.push({ index: i, label: pulseMonthLabel(week.month + 1) }); });
    return ticks;
  }
  days.forEach((day, i) => {
    const [y, m, d] = day.date.split('-').map(Number);
    if (days.length <= 62 ? new Date(y, m - 1, d).getDay() === 1 : d === 1) ticks.push({ index: i, label: days.length <= 62 ? `${m}/${d}` : pulseMonthLabel(m) });
  });
  return ticks;
}

function portraitTitle(profile) {
  if (profile.year) return String(profile.year);
  const first = profile.days[0]?.date || '', last = profile.days.at(-1)?.end || profile.days.at(-1)?.date || '';
  // Across a year boundary month-day alone is ambiguous, so show year and month instead.
  if (first.slice(0, 4) !== last.slice(0, 4)) return `${first.slice(0, 7).replace('-', '.')} — ${last.slice(0, 7).replace('-', '.')}`;
  return `${first.slice(5).replace('-', '.')} — ${last.slice(5).replace('-', '.')}`;
}

// Lit part of a moon lit from the right: outer right half plus an elliptical terminator.
// A crescent's terminator bows toward the lit side, a gibbous moon's toward the dark side.
function moonPath(fraction, cx, cy, r) {
  const f = Math.min(1, Number.isFinite(fraction) ? fraction : 0);
  if (!(f > 0)) return '';
  const n = v => Math.round(v * 100) / 100;
  const top = `${n(cx)},${n(cy - r)}`, bottom = `${n(cx)},${n(cy + r)}`;
  if (f >= 1) return `M${top} A${n(r)},${n(r)} 0 1 1 ${bottom} A${n(r)},${n(r)} 0 1 1 ${top} Z`;
  return `M${top} A${n(r)},${n(r)} 0 0 1 ${bottom} A${n(r * Math.abs(1 - 2 * f))},${n(r)} 0 0 ${f > 0.5 ? 1 : 0} ${top} Z`;
}

function svgDrawer(doc, svg) {
  return (tag, attributes, text, into = svg) => {
    const node = doc.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    if (text !== undefined) node.textContent = text;
    into.appendChild(node);
    return node;
  };
}

// Draws the fingerprint and returns bar geometry so the view can lay interaction targets over it.
function drawFingerprint(draw, profile, width, height, palette) {
  const mono = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  const compact = width < 560;
  const pad = Math.round(width * (compact ? 0.06 : 0.05));
  const fs = Math.max(10, Math.min(16, width / 62));
  draw('rect', { x: 0, y: 0, width, height, fill: palette.bg });
  draw('text', { x: pad, y: pad + fs, fill: palette.title, 'font-family': mono, 'font-size': fs * 0.8, 'letter-spacing': fs * 0.25 }, tr('CRISP PULSE · 知识指纹', 'CRISP PULSE · KNOWLEDGE FINGERPRINT'));
  const title = portraitTitle(profile);
  draw('text', { x: width - pad, y: pad + fs * 2.1, fill: palette.heading, 'font-family': mono, 'font-size': fs * (title.length > 6 ? 1.6 : 2.6), 'font-weight': 500, 'text-anchor': 'end' }, title);
  const x0 = pad, x1 = width - pad, y0 = pad + fs * 3.6, y1 = height - pad - fs * 4.2;
  const n = profile.days.length, step = (x1 - x0) / n;
  const barW = step < 2 ? step * 0.92 : step * (n <= 90 ? 0.66 : 0.6);
  const rx = barW >= 6 ? Math.min(4, barW * 0.22) : 0;
  const gap = barW >= 8 ? 2 : 0;
  const order = ['write', 'interact', 'focus', 'create'];
  const bars = profile.days.map((day, i) => {
    const x = x0 + i * step + (step - barW) / 2;
    const group = draw('g', { class: 'pulse-fp-bar' });
    if (day.status === 'future') return { group, x, index: i };
    const block = (y, h, fill, opacity = 1) => draw('rect', { x, y, width: barW, height: Math.max(0, h), rx, fill, 'fill-opacity': opacity }, undefined, group);
    if (day.status !== 'included') { block(y0, y1 - y0, palette.empty); return { group, x, index: i }; }
    const parts = order.filter(key => day.dims[key] > 0);
    const total = parts.reduce((sum, key) => sum + day.dims[key], 0);
    if (!parts.length) { block(y0, y1 - y0, palette.zero); return { group, x, index: i }; }
    const opacity = Math.round((0.35 + 0.65 * day.intensity) * 100) / 100;
    const usable = y1 - y0 - gap * (parts.length - 1);
    let y = y0;
    for (const key of parts) {
      const h = usable * day.dims[key] / total;
      block(y, h, palette[key], opacity);
      y += h + gap;
    }
    return { group, x, index: i };
  });
  for (const tick of portraitTicks(profile.days)) {
    if (compact && tick.index % 2 && n <= 62) continue;
    draw('text', { x: x0 + (tick.index + 0.5) * step, y: y1 + fs * 1.5, fill: palette.tick, 'font-family': mono, 'font-size': fs * 0.75, 'text-anchor': 'middle' }, tick.label);
  }
  const number = value => Number(value).toLocaleString(PULSE_NUMBER_LOCALE, { maximumFractionDigits: 1 });
  const stats = PULSE_ZH ? [`${profile.activeDays} 天`, `${number(profile.totals.words)} 词`, `${number(profile.totals.active / 60)} 小时`]
    : [plural(profile.activeDays, 'day'), `${number(profile.totals.words)} words`, `${number(profile.totals.active / 60)} h`];
  if (!compact) stats.push(tr(`${number(profile.totals.notes)} 篇新建`, `${number(profile.totals.notes)} new notes`));
  draw('text', { x: x0, y: height - pad, fill: palette.text, 'font-family': mono, 'font-size': fs }, stats.join(' · '));
  if (!compact) {
    let lx = x1;
    for (const dim of [...YEAR_DIMENSIONS].reverse()) {
      draw('text', { x: lx, y: height - pad, fill: palette.title, 'font-family': mono, 'font-size': fs * 0.8, 'text-anchor': 'end' }, dim.label);
      lx -= fs * 0.8 * dim.label.length + fs * 0.45;
      draw('rect', { x: lx - fs * 0.6, y: height - pad - fs * 0.62, width: fs * 0.6, height: fs * 0.6, rx: 1.5, fill: palette[dim.key] });
      lx -= fs * 1.6;
    }
  }
  return { bars, x0, step, y0, y1 };
}

// Procedural dithered banner: cloudy sky, far hills, sea and a lighthouse headland, painted at low resolution.
const PULSE_SKY_PALETTES = {
  night: {
    skyTop: [8, 14, 34], skyHorizon: [46, 70, 116],
    cloudShadow: [28, 40, 72], cloudLit: [90, 108, 148], cloudEdge: [176, 190, 220], cover: -0.44,
    hillFar: [36, 52, 86], hillNear: [22, 32, 56],
    seaTop: [34, 50, 84], seaBottom: [10, 16, 30], glint: [150, 172, 214],
    rock: [16, 20, 30], rockLit: [46, 54, 70], tree: [14, 26, 30], treeLit: [30, 48, 50],
    tower: [214, 218, 226], roof: [120, 50, 44], lamp: [255, 212, 136],
    stars: true, beam: 0.55, window: true
  },
  day: {
    skyTop: [64, 122, 194], skyHorizon: [186, 212, 236],
    cloudShadow: [150, 176, 210], cloudLit: [228, 238, 248], cloudEdge: [255, 255, 255], cover: -0.36,
    hillFar: [136, 166, 200], hillNear: [104, 136, 170],
    seaTop: [112, 156, 204], seaBottom: [56, 98, 150], glint: [236, 244, 252],
    rock: [78, 82, 86], rockLit: [150, 146, 136], tree: [46, 84, 60], treeLit: [82, 122, 80],
    tower: [246, 246, 244], roof: [196, 72, 58], lamp: [214, 78, 60],
    stars: false, beam: 0, window: false
  }
};

/** 像素画共用的随机数和值噪声；同一个 seed 每次画出同一幅图。 */
function pulsePixelNoise(seed) {
  let state = seed >>> 0;
  const rand = () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const perm = new Uint8Array(512), grid = new Float32Array(256);
  for (let i = 0; i < 256; i++) { perm[i] = i; grid[i] = rand(); }
  for (let i = 255; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
  for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];
  const hash = (x, y) => grid[perm[(perm[x & 255] + y) & 511]];
  const smooth = t => t * t * (3 - 2 * t);
  const noise = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = smooth(x - xi), yf = smooth(y - yi);
    const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
  };
  const fbm = (x, y, oct = 5, gain = 0.5) => {
    let v = 0, amp = 0.5, f = 1, norm = 0;
    for (let i = 0; i < oct; i++) { v += amp * noise(x * f, y * f); norm += amp; f *= 2.03; amp *= gain; }
    return v / norm;
  };
  return { rand, hash, noise, fbm };
}

const pixelMix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const pixelClamp01 = t => Math.max(0, Math.min(1, t));
const PIXEL_BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** 和顶部天空一样的 4×4 有序抖动、每通道 8 级。 */
function pixelQuantize(img, o, c, x, y) {
  const step = 255 / 7;
  const th = (PIXEL_BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16 - 0.5;
  for (let k = 0; k < 3; k++) img.data[o + k] = Math.max(0, Math.min(255, Math.round(c[k] / step + th) * step));
  img.data[o + 3] = 255;
}

function paintPulseSky(canvas, mode = "night", seed = 7) {
  const w = canvas.width, h = canvas.height;
  const p = PULSE_SKY_PALETTES[mode] || PULSE_SKY_PALETTES.night;
  const { hash, noise, fbm } = pulsePixelNoise(seed);
  const mix = pixelMix, clamp01 = pixelClamp01;

  const horizon = Math.round(h * 0.6), shore = horizon + Math.round(h * 0.05);
  // Clouds: warped fbm, banded so the sky keeps open gaps; lit from the upper right.
  const cloudAt = (x, y) => {
    const t = y / horizon, cx = x / (h * 0.85), cy = y / (h * 0.42);
    const warp = fbm(cx * 0.7 + 9.1, cy * 0.7 + 1.3, 3);
    const band = 1 - Math.pow(Math.abs(t - 0.4) / 0.6, 2);
    return (fbm(cx + warp * 1.2, cy + warp * 0.6, 6, 0.58) - 0.5) * 3 + band * 0.32 + p.cover;
  };
  const hill = new Float32Array(w), land = new Float32Array(w), canopy = new Float32Array(w);
  const cliffX = h * 1.08, towerX = Math.round(h * 0.86);
  for (let x = 0; x < w; x++) {
    hill[x] = horizon - 1 - Math.max(0, fbm(x / (h * 0.8) + 3, 3.3, 4) - 0.35) * h * 0.32;
    const k = x < cliffX ? 1 : Math.max(0, 1 - Math.pow((x - cliffX) / (h * 0.16), 1.2));
    const crown = 1 - Math.pow(Math.abs(x - h * 0.6) / (h * 0.8), 2) * 0.4;
    land[x] = k <= 0 ? h + 1 : horizon + 3 - (h * 0.19 * crown + fbm(x / 6, 8.1, 3) * 4) * Math.sqrt(k);
    const tuft = fbm(x / 3.2, 4.4, 2);
    canopy[x] = x < towerX - 5 && k > 0.9 ? land[x] - Math.max(0, tuft - 0.36) * h * 0.24 - 1 : land[x] - (k > 0.3 ? 1 : 0);
  }
  const tw = Math.max(3, Math.round(h / 32)), towerBase = Math.round(land[towerX]);
  const towerTop = towerBase - Math.round(h * 0.17), lampY = towerTop - 2;
  const houseL = towerX + tw + 1, houseR = houseL + Math.round(h * 0.09), houseTop = Math.round(land[houseL]) - Math.round(h * 0.05);
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(w, h);
  const clouds = new Float32Array(w * horizon);
  for (let y = 0; y < horizon; y++) for (let x = 0; x < w; x++) clouds[y * w + x] = cloudAt(x, y);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let c;
      if (y < horizon) {
        const t = y / horizon;
        c = mix(p.skyTop, p.skyHorizon, Math.pow(t, 1.5));
        if (p.stars && hash(x * 7 + 3, y * 13 + 5) > 0.992) c = mix(c, [226, 232, 255], 0.75 * (1 - t));
        const d = clouds[y * w + x];
        if (d > 0) {
          const lit = clamp01(0.45 + (d - clouds[Math.max(0, y - 2) * w + Math.min(w - 1, x + 1)]) * 3.2);
          let cloud = mix(p.cloudShadow, p.cloudLit, lit);
          if (d < 0.12) cloud = mix(cloud, p.cloudEdge, (1 - d / 0.12) * lit * 0.8);
          c = mix(c, cloud, clamp01(d * 6));
        }
        if (y > hill[x]) c = mix(p.hillFar, p.hillNear, clamp01((y - hill[x]) / (h * 0.12)));
      } else {
        const t = (y - horizon) / (h - horizon);
        c = mix(p.seaTop, p.seaBottom, Math.sqrt(t));
        const ripple = noise(x / (6 + t * 14), y * 1.1 + 7);
        if (ripple > 0.74) c = mix(c, p.glint, (ripple - 0.74) * 3 * (1 - t * 0.7));
        if (p.beam && Math.abs(x - towerX) < 3 + t * 12 && ripple > 0.5) c = mix(c, p.lamp, 0.45 * (1 - t));
      }
      if (y >= canopy[x] && y < land[x]) {
        c = mix(p.tree, p.treeLit, clamp01((fbm(x / 2, y / 2, 2) - 0.45) * 3));
      } else if (y >= land[x] && y < shore) {
        const depth = clamp01((y - land[x]) / (h * 0.16));
        const strata = fbm(x / 1.6, y / 7, 3), face = clamp01((land[x + 1] ?? land[x]) - land[x]) * 0.5;
        c = mix(p.rockLit, p.rock, clamp01(depth * 1.2 + (0.5 - strata) * 1.4 + face));
        if (y > horizon && land[x] > horizon - 2) c = mix(c, p.seaBottom, 0.3);
      } else if (y >= shore && land[x] < shore && noise(x / 4, y * 0.9) > 0.3) {
        c = mix(c, p.rock, 0.45 * (1 - (y - shore) / (h - shore))); // cliff reflection
      }
      // Cottage next to the tower.
      if (x >= houseL && x <= houseR && y >= houseTop && y < land[x] + 1) {
        c = mix(p.tower, p.rock, 0.35);
        if (p.window && y === houseTop + 2 && (x === houseL + 2 || x === houseR - 2)) c = p.lamp;
      }
      const roofRow = houseTop - y;
      if (roofRow >= 1 && roofRow <= 3 && x >= houseL - 1 + roofRow && x <= houseR + 1 - roofRow) c = p.roof;
      // Tower, gallery and lantern.
      const dxT = x - towerX;
      if (y >= towerTop && y < towerBase + 1) {
        const half = tw / 2 + (y - towerTop) / (h * 0.17) * 0.8;
        if (Math.abs(dxT) <= half) {
          const stripe = mode === "day" && Math.floor((y - towerTop) / 3) % 2 === 1;
          c = stripe ? p.roof : mix(p.tower, p.rock, clamp01((dxT + half) / (half * 3)));
        }
      }
      if (y === towerTop - 1 && Math.abs(dxT) <= tw / 2 + 1) c = p.rock;
      if (y >= towerTop - 4 && y < towerTop - 1 && Math.abs(dxT) <= tw / 2 - 0.5) c = p.lamp;
      if (y === towerTop - 5 && Math.abs(dxT) <= tw / 2 - 0.5) c = p.roof;
      if (p.beam) {
        const dx = x - towerX, dy = y - lampY, dist = Math.hypot(dx, dy * 1.4);
        c = mix(c, p.lamp, clamp01(1 - dist / 9) * 0.6);
        if (dx > 2 && Math.abs(dy) < dx * 0.045 + 1) c = mix(c, p.lamp, p.beam * (1 - Math.abs(dy) / (dx * 0.045 + 1)) * Math.pow(clamp01(1 - dx / (w * 0.42)), 2));
      }
      pixelQuantize(img, (y * w + x) * 4, c, x, y);
    }
  }
  ctx.putImageData(img, 0, 0);
}

/* ---------- 番茄：一天里完成 / 中断的番茄，以及像素番茄图标 ---------- */
/** 只算番茄钟的专注阶段；单次专注会话不算番茄。 */
function dayPomodoros(record) {
  const list = Array.isArray(record?.activity?.focusSessions) ? record.activity.focusSessions : [];
  let done = 0, interrupted = 0;
  for (const s of list) if (s?.pomodoro) { if (s.completed) done++; else interrupted++; }
  return { done, interrupted };
}

// 10×10 的像素番茄：G/g 果蒂叶子，r 果肉，h 高光，d 背光
const PIXEL_TOMATO_CLASSES = { G: "t-leaf-dark", g: "t-leaf", r: "t-body", h: "t-light", d: "t-shade" };
const PIXEL_TOMATO_STATES = { done: "is-done", missed: "is-missed", todo: "is-todo", current: "is-current" };
const PIXEL_TOMATO = [
  "....GG....",
  "..gggGgg..",
  ".rrgrrgrr.",
  "rrhhrrrrrr",
  "rhhrrrrrrr",
  "rhrrrrrrrr",
  "rrrrrrrrrd",
  "rrrrrrrrdd",
  ".rrrrrrdd.",
  "..dddddd..",
];

/** 画一个像素番茄。state：done 完成、missed 中断、todo 还没做（只剩轮廓）、current 正在做（按 progress 从下往上填满）。 */
function pixelTomato(parent, state = "done", progress = 0) {
  const doc = parent.ownerDocument || document;
  const NS = "http://www.w3.org/2000/svg";
  const svg = doc.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 10 10");
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", `pulse-tomato ${PIXEL_TOMATO_STATES[state] || PIXEL_TOMATO_STATES.done}`);
  // 还没做的番茄只画轮廓：四邻有空白的像素才画
  const filled = (x, y) => (PIXEL_TOMATO[y]?.[x] || ".") !== ".";
  const fillFrom = state === "current" ? 10 - Math.round(Math.max(0, Math.min(1, progress)) * 10) : 0;
  PIXEL_TOMATO.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch === ".") return;
    const outline = state === "todo" || (state === "current" && y < fillFrom);
    if (outline && filled(x - 1, y) && filled(x + 1, y) && filled(x, y - 1) && filled(x, y + 1)) return;
    const rect = doc.createElementNS(NS, "rect");
    rect.setAttribute("x", String(x));
    rect.setAttribute("y", String(y));
    rect.setAttribute("width", "1");
    rect.setAttribute("height", "1");
    rect.setAttribute("class", outline && state === "current" ? `${PIXEL_TOMATO_CLASSES[ch]} t-outline` : PIXEL_TOMATO_CLASSES[ch]);
    svg.appendChild(rect);
  }));
  parent.appendChild(svg);
  return svg;
}

/* ---------- 页脚：像素地平线，和顶部天空同一套配色与抖动 ---------- */
const PULSE_GROUND_HEIGHT = 60, PULSE_GROUND_SCALE = 2;
// 山脊在画布里的位置：没有贡献的日子停在 base，峰值升到 base + rise（占画布高度的比例，从下往上量）
// 上面约四成留给渐隐的天空和页脚文字，山都在下面
const PULSE_GROUND_BASE = 0.17, PULSE_GROUND_RISE = 0.4;
// 右侧留几列给「今天」的灯杆，不让它贴边被切掉
const PULSE_GROUND_MARGIN = 10;

/** 地平线画多少天：从第一条记录算起（至少 30 天），但每天至少占 3 列像素，最多 180 天。 */
function groundDayCount(width, firstRecordDaysAgo = 0) {
  const fit = Math.max(14, Math.floor((width - PULSE_GROUND_MARGIN) / 3));
  return Math.max(14, Math.min(180, fit, Math.max(30, firstRecordDaysAgo + 8)));
}

/** 第 index 天（0 = 最早）在画布里的中心列。 */
function groundDayX(index, n, width) {
  return Math.round((index + 0.5) * (width - PULSE_GROUND_MARGIN) / n);
}

/** 最近 N 天每天的贡献分 → 每一列像素的山脊高度（0–1）。开平方压住个别高峰、又保留天与天的高低，再高斯平滑，看起来是山，不是柱状图。 */
function buildGroundProfile(values, width) {
  const out = new Float32Array(Math.max(0, width));
  const n = values.length;
  if (!n || width <= 0) return out;
  const scores = values.map((v) => Math.max(0, Number(v) || 0));
  const positive = scores.filter((v) => v > 0).sort((a, b) => a - b);
  const ref = positive.length ? positive[Math.min(positive.length - 1, Math.floor(positive.length * 0.98))] : 0;
  const norm = scores.map((v) => (ref > 0 ? Math.sqrt(Math.min(1, v / ref)) : 0));
  // 高斯平滑（约前后 3 天），山峰圆一些，不会一天一根柱子
  const kernel = [-3, -2, -1, 0, 1, 2, 3].map((d) => [d, Math.exp(-(d * d) / (2 * 1.4 * 1.4))]);
  const soft = norm.map((_, i) => {
    let sum = 0, weight = 0;
    for (const [d, k] of kernel) { const v = norm[i + d]; if (v === undefined) continue; sum += v * k; weight += k; }
    return sum / weight;
  });
  const day = (width - PULSE_GROUND_MARGIN) / n;
  for (let x = 0; x < width; x++) {
    const t = (x + 0.5) / day - 0.5;
    const i = Math.max(0, Math.min(n - 1, Math.floor(t)));
    const j = Math.min(n - 1, i + 1);
    const f = pixelClamp01(t - i);
    out[x] = soft[i] + (soft[j] - soft[i]) * f * f * (3 - 2 * f);
  }
  return out;
}

/** 山脊顶在画布里的行号（从上往下）。 */
function groundRidgeRow(height, level) {
  return height * (1 - PULSE_GROUND_BASE - PULSE_GROUND_RISE * level);
}

/** 画页脚地平线：远处一层淡山，中间是贡献山脊（光从右上来），近处一条暗色地面和几棵像素小树；todayX 处立一根小灯杆，夜里亮灯，白天挂旗。 */
function paintPulseGround(canvas, mode, profile, todayX = -1, seed = 11) {
  const w = canvas.width, h = canvas.height;
  const p = PULSE_SKY_PALETTES[mode] || PULSE_SKY_PALETTES.night;
  const { hash, noise, fbm } = pulsePixelNoise(seed);
  const mix = pixelMix, clamp01 = pixelClamp01;
  const far = new Float32Array(w), ridge = new Float32Array(w), near = new Float32Array(w), tree = new Int16Array(w).fill(-1);
  for (let x = 0; x < w; x++) {
    far[x] = h * 0.62 - Math.max(0, fbm(x / (h * 1.1) + 5, 1.7, 4) - 0.32) * h * 0.5;
    ridge[x] = groundRidgeRow(h, profile[x] || 0) + (fbm(x / 4, 6.2, 3) - 0.5) * 2.4;
    near[x] = h * 0.88 - fbm(x / (h * 0.45) + 2, 9.4, 3) * h * 0.13;
  }
  // 坡度取前后 3 列的平均，光照才不会一列一列地跳成竖条纹
  const slopeAt = new Float32Array(w);
  for (let x = 0; x < w; x++) slopeAt[x] = ((ridge[Math.min(w - 1, x + 3)]) - (ridge[Math.max(0, x - 3)])) / 6;
  // 近处地面上稀疏的小松树：避开灯杆，彼此至少隔 6 列
  for (let x = 3, last = -99; x < w - 3; x++) {
    if (x - last < 6 || Math.abs(x - todayX) < 5 || hash(x * 3 + 1, 17) < 0.86) continue;
    tree[x] = 3 + Math.floor(hash(x, 29) * 4);
    last = x;
  }
  const lampTop = todayX >= 0 && todayX < w ? Math.round(ridge[todayX]) - 8 : -99;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = y / h;
      let c = mix(p.skyTop, p.skyHorizon, 0.55 + 0.45 * t);
      if (p.stars && y < h * 0.45 && hash(x * 7 + 3, y * 13 + 5) > 0.985) c = mix(c, [226, 232, 255], 0.6 * (1 - t * 2));
      // 远山：带一层天色的薄雾，比贡献山脊浅
      if (y >= far[x]) c = mix(mix(p.hillFar, p.skyHorizon, 0.62), mix(p.hillFar, p.skyHorizon, 0.4), clamp01((y - far[x]) / (h * 0.4)));
      if (y >= ridge[x]) {
        const depth = clamp01((y - ridge[x]) / (h * 0.5));
        const below = y - ridge[x];
        // 光从右上来：朝右的坡面（右边更低）亮，朝左的暗，只照到山脊靠顶的几行
        const slope = slopeAt[x], reach = clamp01(1 - below / 9);
        c = mix(mix(p.hillFar, p.hillNear, 0.4), mix(p.hillNear, p.rock, 0.3), depth);
        if (slope > 0.08) c = mix(c, p.cloudLit, clamp01(slope * 1.2) * 0.35 * reach);
        else if (slope < -0.08) c = mix(c, p.hillNear, clamp01(-slope * 1.2) * 0.45 * reach);
        if (below < 1.2) c = mix(c, p.cloudEdge, mode === "night" ? 0.22 : 0.3);
        if (noise(x / 3, y / 2.2) > 0.74) c = mix(c, p.hillNear, 0.3);
      }
      if (y >= near[x]) {
        c = mix(p.hillNear, p.rock, 0.45 + clamp01((y - near[x]) / (h * 0.15)) * 0.4);
        if (fbm(x / 2, y / 2, 2) > 0.62) c = mix(c, p.treeLit, 0.3);
      }
      for (let dx = -2; dx <= 2; dx++) {
        const th = tree[x + dx];
        if (th > 0) {
          const top = Math.round(near[x + dx]) - th;
          const row = y - top;
          if (row >= 0 && row < th && Math.abs(dx) <= Math.floor(row * 0.6)) c = mix(p.tree, p.treeLit, dx > 0 ? 0.45 : 0);
          if (dx === 0 && row >= th && y < near[x] + 1) c = p.tree;
        }
      }
      if (todayX >= 0) {
        const dx = x - todayX;
        if (p.beam) c = mix(c, p.lamp, clamp01(1 - Math.hypot(dx, (y - lampTop) * 1.3) / 7) * 0.55);
        // 灯杆：夜里用浅色才看得见，白天用深色
        if (dx === 0 && y > lampTop && y < ridge[x] + 1) c = p.window ? mix(p.tower, p.rock, 0.3) : mix(p.rock, p.tower, 0.15);
        if (p.window && dx >= 0 && dx <= 1 && y >= lampTop - 1 && y <= lampTop) c = p.lamp;
        if (!p.window && dx >= 1 && dx <= 3 && y >= lampTop + 1 && y <= lampTop + 2) c = p.roof;
      }
      pixelQuantize(img, (y * w + x) * 4, c, x, y);
    }
  }
  ctx.putImageData(img, 0, 0);
}

// Custom banner images fill the banner box (object-fit: cover): about 6:1 survives both wide and narrow panes.
const PULSE_BANNER_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "avif"]);
const PULSE_BANNER_IMAGE_HINT = tr("建议 3000×500 像素左右：宽高比 5:1 到 7:1，至少 1600×300。主体放在上半部分，下半部分会渐隐并被标题压住。", "About 3000×500 px is recommended: an aspect ratio of 5:1 to 7:1, at least 1600×300. Keep the subject in the upper half; the lower half fades out under the title.");
function checkBannerImageSize(width, height) {
  const issues = [];
  const ratio = width / height;
  if (ratio < 4) issues.push(tr(`比例偏高（约 ${ratio.toFixed(1)}:1），上下会被裁掉大半`, `too tall (about ${ratio.toFixed(1)}:1); most of the top and bottom will be cropped`));
  else if (ratio > 9) issues.push(tr(`比例过宽（约 ${ratio.toFixed(1)}:1），窄面板里两侧会裁掉很多`, `too wide (about ${ratio.toFixed(1)}:1); a lot of both sides will be cropped in narrow panes`));
  if (width < 1600 || height < 300) issues.push(tr(`分辨率偏低（${width}×${height}），高分屏上会发虚`, `low resolution (${width}×${height}); it will look blurry on high-DPI screens`));
  return issues;
}

function createBannerImageSuggest(app, inputEl, onPick) {
  if (!AbstractInputSuggest) return null;
  class BannerImageSuggest extends AbstractInputSuggest {
    getSuggestions(query) {
      const q = query.trim().toLowerCase();
      return app.vault.getFiles()
        .filter(file => PULSE_BANNER_IMAGE_EXTENSIONS.has(file.extension.toLowerCase()) && file.path.toLowerCase().includes(q))
        .slice(0, 50);
    }
    renderSuggestion(file, el) { el.setText(file.path); }
    selectSuggestion(file) { this.setValue(file.path); onPick(file.path); this.close(); }
  }
  return new BannerImageSuggest(app, inputEl);
}

// One painted canvas per mode; each render copies it instead of repainting.
const PULSE_SKY_WIDTH = 900, PULSE_SKY_HEIGHT = 112;
const pulseSkyCache = {};
function getPulseSky(doc, mode) {
  if (!pulseSkyCache[mode]) {
    const canvas = doc.createElement("canvas");
    canvas.width = PULSE_SKY_WIDTH;
    canvas.height = PULSE_SKY_HEIGHT;
    paintPulseSky(canvas, mode);
    pulseSkyCache[mode] = canvas;
  }
  return pulseSkyCache[mode];
}

class CrispPulseView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.selectedMetric = plugin?.settings?.defaultMetric || "contribution";
    this.selectedDate = getTodayKey();
    this.currentScope = plugin?.settings?.dataQualityScope || "reliable";
    this.currentDateRange = plugin?.settings?.defaultDateRange || "year";
    this.showBreakdown = false;
    this.analyticsDays = 7;
    this.activeViewTab = "dashboard"; // "dashboard" | "review"
  }

  getViewType() {
    return VIEW_TYPE_PULSE;
  }

  getDisplayText() {
    return tr("Crisp Pulse 知识脉冲", "Crisp Pulse");
  }

  getIcon() {
    return CRISP_PULSE_ICON_ID;
  }

  async onOpen() {
    this.render();
    const container = this.containerEl.children[1];
    this.registerEvent(this.app.workspace.on("css-change", () => {
      const mode = this.currentBannerMode();
      if (this.plugin.settings.showHeaderBanner && this.bannerMode !== "image" && this.bannerMode !== mode) this.render();
      else if (this.footerEls && this.footerMode !== mode) this.paintFooter();
    }));
    this.registerDomEvent(container, 'pointerdown', event => { this.lastPointerType = event.pointerType; }, { capture: true });
    const win = container.ownerDocument.defaultView;
    this.analyticsResizeObserver = new win.ResizeObserver(() => {
      if (!["analytics", "yearly"].includes(this.activeViewTab) || Math.abs(container.clientWidth - (this.analyticsLastWidth || 0)) < 2) return;
      if (this.analyticsResizeFrame) win.cancelAnimationFrame(this.analyticsResizeFrame);
      this.analyticsResizeFrame = win.requestAnimationFrame(() => {
        this.analyticsResizeFrame = null;
        if (container.isConnected && ["analytics", "yearly"].includes(this.activeViewTab)) this.render();
      });
    });
    this.analyticsResizeObserver.observe(container);
  }

  async onClose() {
    if (this.pomodoroTicker) window.clearInterval(this.pomodoroTicker);
    this.analyticsResizeObserver?.disconnect();
    this.footerResizeObserver?.disconnect();
    if (this.analyticsResizeFrame) this.containerEl.ownerDocument.defaultView.cancelAnimationFrame(this.analyticsResizeFrame);
  }

  render() {
    const container = this.containerEl.children[1];
    if (this.reviewComposing && container.contains(container.ownerDocument.activeElement)) return;
    const previousScroll = container?.scrollTop || 0;
    const previousHorizontal = container.querySelector(".crisp-pulse-heatmap-scroll")?.scrollLeft || 0;
    const active = container.ownerDocument.activeElement;
    const formFocus = container.contains(active) && active.dataset?.reviewField
      ? { field: active.dataset.reviewField, start: active.selectionStart, end: active.selectionEnd, scroll: active.scrollTop } : null;
    const focusedDate = container.contains(active) ? active?.dataset?.date : null;
    const chartFocus = container.contains(active) && active?.dataset?.analyticsDate ? { date: active.dataset.analyticsDate, chart: active.closest("svg")?.getAttribute("aria-label") } : null;
    const controlFocus = container.contains(active) && active.matches("button, select, [role=button]")
      ? { tag: active.tagName, label: active.getAttribute("aria-label"), text: active.textContent } : null;
    container.empty();
    container.classList.add("crisp-pulse-view");
    container.classList.add("pulse-v2");
    container.classList.toggle("has-banner", !!this.plugin.settings.showHeaderBanner);
    if (this.plugin.settings.showHeaderBanner) this.renderBanner(container);

    const wrapper = container.createDiv({ cls: "crisp-pulse-wrapper" });

    // 1. Header with View Tabs, Scope and DateRange Selectors
    this.renderHeader(wrapper);

    const locked = this.renderGatedTab(wrapper, this.activeViewTab);
    if (locked) {
      // 未激活：只显示锁定说明，不计算也不渲染任何统计内容。
    } else if (this.activeViewTab === "dashboard") {
      this.renderDashboardV2(wrapper);
    } else if (this.activeViewTab === "analytics") {
      this.renderAnalytics(wrapper);
    } else if (this.activeViewTab === "yearly") {
      this.renderYearly(wrapper);
    } else {
      // Retrospective View
      this.renderRetrospectivePanel(wrapper);
    }
    this.footerEls = null;
    if (this.plugin.settings.showFooterLandscape !== false) this.renderFooter(container, { locked });

    container.scrollTop = previousScroll;
    const heatmap = container.querySelector(".crisp-pulse-heatmap-scroll");
    if (heatmap) {
      if (previousHorizontal > 0) {
        heatmap.scrollLeft = previousHorizontal;
      } else {
        heatmap.scrollLeft = heatmap.scrollWidth;
      }
    }
    if (formFocus) {
      const input = [...container.querySelectorAll('[data-review-field]')].find(el => el.dataset.reviewField === formFocus.field);
      input?.focus({ preventScroll: true });
      if ((input?.tagName === 'TEXTAREA' || input?.type === 'text' || input?.type === 'search') && formFocus.start !== null) {
        input.setSelectionRange(formFocus.start, formFocus.end); input.scrollTop = formFocus.scroll;
      }
    }
    else if (focusedDate) {
      const target = container.querySelector(`[data-date="${focusedDate}"]`);
      if (target) {
        container.querySelectorAll('[data-date][tabindex="0"]').forEach(el => el.setAttribute('tabindex', '-1'));
        target.setAttribute('tabindex', '0');
        target.focus({ preventScroll: true });
      }
    }
    else if (chartFocus) {
      // 年度月相日历的格子不在 svg 里（没有图表标签），直接在面板里按日期找
      const chart = chartFocus.chart ? [...container.querySelectorAll("svg")].find(el => el.getAttribute("aria-label") === chartFocus.chart) : null;
      const target = chartFocus.chart
        ? chart?.querySelector(`[data-analytics-date="${chartFocus.date}"]`)
        : container.querySelector(`.crisp-pulse-moon[data-analytics-date="${chartFocus.date}"]`);
      if (target) {
        (chart || target.closest('.crisp-pulse-moon-months') || target.parentElement).querySelectorAll('[data-analytics-date][tabindex="0"]').forEach(el => el.setAttribute('tabindex', '-1'));
        target.setAttribute('tabindex', '0');
        target.focus({ preventScroll: true });
      }
    } else if (controlFocus) {
      [...container.querySelectorAll("button, select, [role=button]")].find(el => el.tagName === controlFocus.tag && el.getAttribute("aria-label") === controlFocus.label && (controlFocus.label || el.textContent === controlFocus.text))?.focus({ preventScroll: true });
    }
  }

  renderAnalytics(parent) {
    this.analyticsLastWidth = this.containerEl.children[1].clientWidth;
    const section = parent.createDiv({ cls: 'crisp-pulse-analytics' });
    const heading = section.createDiv({ cls: 'crisp-pulse-analytics-heading' });
    const text = heading.createDiv();
    text.createEl('h2', { text: tr('数据分析', 'Analytics') });
    text.createEl('p', { text: tr('把每天的记录连起来，看看写作与投入如何变化。', 'Connect your daily records to see how your writing and effort change.') });
    const ranges = heading.createDiv({ cls: 'crisp-pulse-analytics-segments' });
    ranges.setAttr('aria-label', tr('分析时间范围', 'Analytics time range'));
    for (const days of [7, 30, 90]) {
      const button = ranges.createEl('button', { text: tr(`${days} 天`, `${days} days`) });
      button.setAttr('aria-pressed', String(this.analyticsDays === days));
      button.addEventListener('click', () => {
        this.analyticsDays = days;
        this.render();
        this.containerEl.querySelector(`.crisp-pulse-analytics-segments button[aria-pressed="true"]`)?.focus({ preventScroll: true });
      });
    }
    const now = new Date();
    const dates = Array.from({ length: this.analyticsDays }, (_, i) => dateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - this.analyticsDays + 1 + i)));
    const data = buildAnalyticsData(this.plugin.store.daily || {}, dates, (record, key) => this.plugin.recordMatchesScope(record, key, this.currentScope));
    const scopeLabel = REVIEW_SCOPE_LABELS[this.currentScope];
    section.createDiv({ cls: 'crisp-pulse-analytics-coverage', text: tr(`${dates[0]} — ${dates.at(-1)} · ${scopeLabel} · 已纳入 ${data.recordedDays} / ${dates.length} 天。未记录或被筛选的日期留空，不视作零。`, `${dates[0]} — ${dates.at(-1)} · ${scopeLabel} · ${data.recordedDays} / ${dates.length} days included. Days not recorded or filtered out are left blank, not counted as zero.`) });
    const configs = [
      { title: tr('每日贡献', 'Daily contribution'), icon: 'bar-chart-3', description: tr('查看记录下来的工作节奏；分数依照当前插件计分口径，不代表知识质量。', 'See the rhythm of your recorded work. Scores follow the plugin’s current scoring rules and do not reflect knowledge quality.'), type: 'bar', unit: tr('分', 'pts'), total: 'score', totalLabel: tr('区间贡献', 'Period contribution'), series: [{ key: 'score', label: tr('贡献得分', 'Contribution score'), color: 'blue' }] },
      { title: tr('写作变化', 'Writing changes'), icon: 'line-chart', description: tr('新增与删除来自保存前后的词数变化，改写为现有算法估算。三条曲线分别展示，不相加。', 'Added and removed come from word-count changes between saves; rewrites are estimated by the current algorithm. The three lines are shown separately, not summed.'), type: 'line', unit: tr('词', 'words'), total: 'wordsAdded', totalLabel: tr('新增词数', 'Words added'), series: [{ key: 'wordsAdded', label: tr('新增', 'Added'), color: 'blue' }, { key: 'wordsRemoved', label: tr('删除', 'Removed'), color: 'orange' }, { key: 'rewrittenWords', label: tr('改写估算', 'Rewrites (est.)'), color: 'green' }] },
      { title: tr('时间投入', 'Time invested'), icon: 'clock', description: tr('交互时长按操作间隔估算，专注时长来自已有 Focus 记录。两者可能重叠，不合并计算。', 'Active time is estimated from gaps between actions; focus time comes from Focus records. They may overlap and are not combined.'), type: 'line', unit: tr('分钟', 'min'), total: 'activeMinutes', totalLabel: tr('交互活跃', 'Active time'), series: [{ key: 'activeMinutes', label: tr('交互活跃', 'Active time'), color: 'blue' }, { key: 'focusMinutes', label: tr('Focus 记录', 'Focus logged'), color: 'orange' }] }
    ];
    const include = (record, key) => this.plugin.recordMatchesScope(record, key, this.currentScope);
    this.renderAnalyticsPace(section, include);
    this.renderAnalyticsChart(section, data, configs[0]);
    this.renderAnalyticsRhythm(section, data);
    this.renderAnalyticsChart(section, data, configs[1]);
    const pair = section.createDiv({ cls: 'crisp-pulse-analytics-pair' });
    this.renderAnalyticsWritingMix(pair, buildWritingMix(this.plugin.store.daily || {}, dates, include));
    this.renderAnalyticsFolders(pair, buildFolderShare(this.plugin.store.daily || {}, dates, include));
    this.renderAnalyticsChart(section, data, configs[2]);
    this.renderAnalyticsHours(section, buildHourlyProfile(this.plugin.store.daily || {}, dates, include, { weekStartsOn: this.plugin.settings.weekStartsOn }));
  }

  // 24 小时活跃时段：本机交互活跃分钟按小时分布，外加星期 × 小时矩阵。
  renderAnalyticsHours(parent, profile) {
    const card = this.analyticsSection(parent, tr('活跃时段', 'Active hours'), tr('本机交互活跃分钟按小时分布，帮你找到一天里最容易进入状态的时间。只统计开始按小时记录之后的日期；更早的日期只有全天总数，不计入。', 'Active minutes on this device by hour, to help you find when you get into the zone most easily. Only days since hourly recording began are counted; earlier days only have daily totals and are left out.'), 'clock-4');
    const pad = (h) => String(h).padStart(2, '0');
    const fmt = (v) => Number(v).toLocaleString(PULSE_NUMBER_LOCALE, { maximumFractionDigits: 0 });
    const summary = card.createDiv({ cls: 'crisp-pulse-analytics-summary' });
    const primary = summary.createDiv();
    primary.createDiv({ cls: 'crisp-pulse-analytics-label', text: tr('最活跃时段', 'Most active window') });
    primary.createDiv({ cls: 'crisp-pulse-analytics-total', text: profile.peak ? `${pad(profile.peak.start)}:00–${pad(profile.peak.end)}:00` : '—' });
    const notes = [];
    if (profile.peak) notes.push(tr(`该时段累计 ${fmt(profile.peak.minutes)} 分钟，占 ${Math.round(profile.peak.share * 100)}%`, `${fmt(profile.peak.minutes)} min in this window, ${Math.round(profile.peak.share * 100)}% of the total`));
    else if (profile.total > 0) notes.push(tr(`再积累 ${fmt(profile.needMinutes)} 分钟后判断`, `Needs ${fmt(profile.needMinutes)} more min to tell`));
    notes.push(tr(`区间共 ${fmt(profile.total)} 个活跃分钟 · 按小时记录 ${profile.days} 天`, `${fmt(profile.total)} active min in this period · ${plural(profile.days, 'day')} recorded by hour`));
    if (profile.missingDays) notes.push(tr(`${profile.missingDays} 天只有全天总数`, `${plural(profile.missingDays, 'day')} with daily totals only`));
    summary.createDiv({ cls: 'crisp-pulse-analytics-subtotals', text: notes.join(' · ') });
    if (!profile.firstDay) {
      card.createDiv({ cls: 'crisp-pulse-analytics-empty', text: tr('从这个版本开始按小时记录。在 Obsidian 里写一会儿，这里就会出现你的活跃分布。', 'Hourly recording starts with this version. Write in Obsidian for a while and your active hours will show up here.') });
      return;
    }
    if (!profile.total) {
      card.createDiv({ cls: 'crisp-pulse-analytics-empty', text: tr(`所选范围内没有按小时的记录（从 ${profile.firstDay} 开始记录）。`, `No hourly records in the selected range (recording started ${profile.firstDay}).`) });
      return;
    }
    const level = (v, max) => (v > 0 ? Math.min(4, Math.max(1, Math.ceil((v / max) * 4))) : 0);
    const max = Math.max(...profile.hours);
    const strip = card.createDiv({ cls: 'pulse-hours-strip', attr: { role: 'list', 'aria-label': tr('24 小时活跃分布', 'Activity across 24 hours') } });
    profile.hours.forEach((v, h) => {
      const inPeak = profile.peak && ((h - profile.peak.start + 24) % 24) < 3;
      const cell = strip.createDiv({ cls: `pulse-hours-cell level-${level(v, max)}${inPeak ? ' is-peak' : ''}`, attr: { role: 'listitem', 'aria-label': `${pad(h)}:00–${pad((h + 1) % 24)}:00 · ${fmt(v)} ${tr('分钟', 'min')}` } });
      cell.setAttribute('title', `${pad(h)}:00–${pad((h + 1) % 24)}:00 · ${fmt(v)} ${tr('分钟', 'min')}`);
      if (v >= 1) cell.createSpan({ cls: 'pulse-hours-value', text: fmt(v) });
    });
    const axis = card.createDiv({ cls: 'pulse-hours-axis', attr: { 'aria-hidden': 'true' } });
    for (const h of [0, 6, 12, 18, 23]) axis.createSpan({ text: `${pad(h)}:00` });

    const matrixMax = Math.max(...profile.matrix.flatMap((row) => row.hours));
    const grid = card.createDiv({ cls: 'pulse-hours-matrix', attr: { role: 'grid', 'aria-label': tr('星期 × 小时活跃分布', 'Activity by weekday × hour') } });
    let best = null;
    for (const row of profile.matrix) {
      grid.createDiv({ cls: 'pulse-hours-matrix-label', text: tr(`周${row.label}`, row.label) });
      row.hours.forEach((v, h) => {
        if (!best || v > best.v) best = { v, label: row.label, h };
        const cell = grid.createDiv({ cls: `pulse-hours-matrix-cell level-${level(v, matrixMax)}` });
        cell.setAttribute('title', tr(`周${row.label} ${pad(h)}:00 · ${fmt(v)} 分钟`, `${row.label} ${pad(h)}:00 · ${fmt(v)} min`));
      });
    }
    if (best && best.v > 0) card.createDiv({ cls: 'pulse-hours-note', text: tr(`最常写的一格：周${best.label} ${pad(best.h)}:00，累计 ${fmt(best.v)} 分钟 · 从 ${profile.firstDay} 开始按小时记录`, `Busiest slot: ${best.label} ${pad(best.h)}:00, ${fmt(best.v)} min in total · recorded by hour since ${profile.firstDay}`) });
  }

  // Forward-looking card: where this month stands against the same day of last month, and where it is heading.
  renderAnalyticsPace(parent, include) {
    const daily = this.plugin.store.daily || {};
    const todayKey = getTodayKey();
    const metrics = [
      { field: 'score', label: tr('贡献得分', 'Contribution score'), unit: tr('分', 'pts') },
      { field: 'words', label: tr('新增词数', 'Words added'), unit: tr('词', 'words') },
      { field: 'active', label: tr('活跃天数', 'Active days'), unit: tr('天', 'days') }
    ];
    const paces = metrics.map(metric => ({ ...metric, pace: buildMonthPace(daily, todayKey, include, metric.field) }));
    const first = paces[0].pace;
    const card = this.trayCard(parent, {
      icon: 'gauge', title: tr('本月节奏', 'This month’s pace'), wrap: true,
      subtitle: tr(`${first.month} 月 1 日到今天，对照 ${first.prevMonth} 月同一天的累计。竖线是上月这时走到的位置；新增词数不含系统目录。`, `${pulseMonthDay(first.month, 1)} to today, against the running total on the same day of ${pulseMonthLabel(first.prevMonth)}. The vertical line marks where last month was at this point; words added exclude system folders.`),
      pill: tr(`第 ${first.today} / ${first.days} 天`, `Day ${first.today} / ${first.days}`), pillMuted: true,
      cls: 'crisp-pulse-analytics-section', insetCls: 'crisp-pulse-analytics-card pulse-pace'
    });
    const number = value => Number(value).toLocaleString(PULSE_NUMBER_LOCALE, { maximumFractionDigits: 0 });
    const rows = card.createDiv({ cls: 'pulse-pace-rows' });
    for (const { label, unit, pace } of paces) {
      const row = rows.createDiv({ cls: 'pulse-pace-row' });
      const head = row.createDiv({ cls: 'pulse-pace-head' });
      head.createSpan({ cls: 'pulse-pace-label', text: label });
      const ratio = pace.baselineTotal > 0 ? pace.actualToDate / pace.baselineTotal : null;
      head.createSpan({
        cls: 'pulse-pace-share',
        text: ratio === null ? `${number(pace.actualToDate)} ${unit}` : ratio >= 1 ? tr(`已超过上月全月 · ${number(pace.actualToDate)} ${unit}`, `Past all of last month · ${number(pace.actualToDate)} ${unit}`) : tr(`上月全月的 ${Math.round(ratio * 100)}%`, `${Math.round(ratio * 100)}% of last month’s total`)
      });
      const behind = pace.deltaPct !== null && pace.deltaPct < 0;
      const track = row.createDiv({ cls: `pulse-pace-track${behind ? ' is-behind' : ''}` });
      track.setAttr('role', 'img');
      if (ratio !== null) {
        track.createDiv({ cls: 'pulse-pace-fill' }).style.width = `${Math.min(100, ratio * 100)}%`;
        const markAt = pace.baselineToDate / pace.baselineTotal;
        const mark = track.createDiv({ cls: 'pulse-pace-mark' });
        mark.style.left = `${Math.min(100, markAt * 100)}%`;
        track.setAttr('aria-label', tr(`${label}：本月 ${number(pace.actualToDate)} ${unit}，上月同期 ${number(pace.baselineToDate)} ${unit}，上月全月 ${number(pace.baselineTotal)} ${unit}`, `${label}: this month ${number(pace.actualToDate)} ${unit}, same point last month ${number(pace.baselineToDate)} ${unit}, all of last month ${number(pace.baselineTotal)} ${unit}`));
      } else {
        track.addClass('is-empty');
        track.setAttr('aria-label', tr(`${label}：上月没有可对照的记录`, `${label}: no records last month to compare against`));
      }
      const foot = row.createDiv({ cls: 'pulse-pace-foot' });
      const delta = foot.createSpan({ cls: `pulse-pace-delta${behind ? ' is-behind' : pace.deltaPct > 0 ? ' is-ahead' : ''}` });
      if (pace.deltaPct === null) {
        // Last month's records may start mid-month; say so rather than imply nothing happened.
        const late = pace.baseline && pace.prevFirstDay > pace.today;
        delta.setText(!pace.baseline ? tr('上月没有可对照的记录', 'No records last month to compare against') : late ? tr(`${pace.prevMonth} 月 ${pace.prevFirstDay} 日才开始有记录，${pace.month} 月 ${pace.prevFirstDay} 日起可对照`, `Records only start on ${pulseMonthDay(pace.prevMonth, pace.prevFirstDay)}; comparable from ${pulseMonthDay(pace.month, pace.prevFirstDay)}`) : tr('上月同期还是 0', 'Still 0 at this point last month'));
      }
      else if (pace.deltaPct === 0) delta.setText(tr('与上月同期持平', 'Level with the same point last month'));
      else delta.setText(tr(`比上月同期${pace.deltaPct > 0 ? '多' : '少'} ${Math.abs(pace.deltaPct)}%`, `${Math.abs(pace.deltaPct)}% ${pace.deltaPct > 0 ? 'ahead of' : 'behind'} the same point last month`));
      let outlook = '';
      if (pace.projection !== null && pace.today < pace.days) outlook = tr(`照最近节奏，月底约 ${number(pace.projection)} ${unit}`, `At the recent pace, about ${number(pace.projection)} ${unit} by month end`);
      if (behind && pace.needPerDay !== null) {
        const remaining = pace.days - pace.today;
        const needDays = Math.ceil(pace.baselineTotal - pace.actualToDate);
        outlook = pace.field !== 'active' ? tr(`月底追平上月，每天约需 ${number(pace.needPerDay)} ${unit}`, `To match last month by month end: about ${number(pace.needPerDay)} ${unit} a day`)
          : needDays > remaining ? tr(`剩 ${remaining} 天，本月已追不平上月`, `${plural(remaining, 'day')} left; this month can no longer match last month`) : tr(`月底追平上月，还需 ${needDays} 个活跃日（剩 ${remaining} 天）`, `To match last month: ${plural(needDays, 'more active day')} needed (${remaining} left)`);
      }
      if (outlook) foot.createSpan({ cls: 'pulse-pace-outlook', text: outlook });
    }
    this.renderPaceChart(card, paces);
    const note = paces[0].pace.missingDays ? tr(`本月有 ${paces[0].pace.missingDays} 天没有纳入的记录，按 0 累计。`, `${plural(paces[0].pace.missingDays, 'day')} this month ${paces[0].pace.missingDays === 1 ? 'has' : 'have'} no included records and ${paces[0].pace.missingDays === 1 ? 'counts' : 'count'} as 0. `) : '';
    card.createDiv({ cls: 'crisp-pulse-analytics-readout pulse-pace-note', text: `${note}${tr('预测用最近 7 天里有记录的日子求平均，只是估算。', 'Projections average the recorded days in the last 7 days and are only estimates.')}` });
  }

  renderPaceChart(card, paces) {
    if (!paces.some(p => p.pace.baseline || p.pace.actualToDate > 0)) return;
    const field = paces.some(p => p.field === this.paceField) ? this.paceField : 'score';
    const { pace, unit, label } = paces.find(p => p.field === field);
    const seg = card.createDiv({ cls: 'pulse-v2-seg pulse-pace-seg' });
    seg.setAttr('role', 'tablist');
    for (const p of paces) {
      const b = seg.createEl('button', { text: p.label });
      b.setAttr('role', 'tab');
      b.setAttr('aria-selected', String(p.field === field));
      b.addEventListener('click', () => { this.paceField = p.field; this.render(); });
    }
    const width = Math.max(280, Math.min(960, card.clientWidth - 48)), height = 230;
    const scroll = card.createDiv({ cls: 'crisp-pulse-analytics-chart-scroll' });
    const { svg, draw } = this.analyticsSvg(scroll, width, height, tr(`${label}本月累计与上月同期对照。左右方向键逐日查看。`, `${label}: this month’s running total against the same point last month. Use the left and right arrow keys to step through days.`));
    const left = 58, right = width - 16, top = 14, bottom = height - 30;
    const n = pace.days;
    const x = day => left + (day - 1) / Math.max(1, n - 1) * (right - left);
    const top_ = Math.max(pace.baselineTotal, pace.projection || 0, pace.actualToDate);
    // Active days count whole days: the month length is the ceiling, ticks every 10 days.
    const scale = field === 'active' ? { max: n, ticks: [0, 10, 20, 30].filter(t => t <= n) } : analyticsScale(top_);
    const y = v => bottom - v / scale.max * (bottom - top);
    for (const tick of scale.ticks) {
      draw('line', { x1: left, x2: right, y1: y(tick), y2: y(tick), class: 'pulse-chart-grid' });
      // Six-figure word counts would overflow the axis gutter; abbreviate them (e.g. 80万).
      draw('text', { x: left - 10, y: y(tick) + 4, 'text-anchor': 'end', class: 'pulse-chart-axis' }, Number(tick.toPrecision(6)).toLocaleString(PULSE_NUMBER_LOCALE, scale.max >= 100000 ? { notation: 'compact', maximumFractionDigits: 1 } : { maximumFractionDigits: 1 }));
    }
    for (const d of [...new Set([1, Math.ceil(n / 2), n])]) draw('text', { x: x(d), y: height - 8, 'text-anchor': d === 1 ? 'start' : d === n ? 'end' : 'middle', class: 'pulse-chart-axis' }, `${pace.month}/${d}`);
    const path = values => values.map((v, i) => `${i ? 'L' : 'M'}${x(i + 1).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    if (pace.baseline) draw('path', { d: path(pace.baseline), fill: 'none', class: 'pulse-pace-baseline' });
    if (pace.actual.length) {
      const area = `${path(pace.actual)} L${x(pace.today).toFixed(1)},${bottom} L${x(1).toFixed(1)},${bottom} Z`;
      draw('path', { d: area, class: 'pulse-pace-area' });
      draw('path', { d: path(pace.actual), fill: 'none', class: 'pulse-pace-actual' });
    }
    if (pace.projection !== null && pace.today < n) draw('path', { d: `M${x(pace.today).toFixed(1)},${y(pace.actualToDate).toFixed(1)} L${x(n).toFixed(1)},${y(pace.projection).toFixed(1)}`, fill: 'none', class: 'pulse-pace-projection' });
    draw('line', { x1: x(pace.today), x2: x(pace.today), y1: top, y2: bottom, class: 'pulse-pace-today' });
    draw('circle', { cx: x(pace.today), cy: y(pace.actualToDate), r: 3.5, class: 'pulse-pace-dot' });
    const cursor = draw('line', { x1: 0, x2: 0, y1: top, y2: bottom, class: 'pulse-chart-cursor', visibility: 'hidden' });
    const number = v => Number(v).toLocaleString(PULSE_NUMBER_LOCALE, { maximumFractionDigits: 1 });
    const readout = card.createDiv({ cls: 'crisp-pulse-analytics-readout', text: tr('实线是本月累计，虚线是上月同日的累计，点线是按最近节奏推算到月底。', 'The solid line is this month’s running total, the dashed line is last month’s total on the same day, and the dotted line projects the recent pace to month end.') });
    readout.setAttr('aria-live', 'polite');
    const legend = card.createDiv({ cls: 'crisp-pulse-analytics-legend' });
    for (const [cls, text] of [['pulse-pace-key-actual', tr('本月累计', 'This month')], ['pulse-pace-key-baseline', tr('上月同期', 'Last month')], ['pulse-pace-key-projection', tr('推算', 'Projected')]]) {
      const item = legend.createSpan(); item.createSpan({ cls: `pulse-pace-key ${cls}` }); item.createSpan({ text });
    }
    const describe = day => {
      const base = pace.baseline ? pace.baseline[day - 1] : null;
      if (day > pace.today) return `${pulseMonthDay(pace.month, day)} · ${tr('上月同日累计', 'last month same day')} ${base === null ? '—' : `${number(base)} ${unit}`}${pace.projection !== null ? ` · ${tr('推算约', 'projected about')} ${number(pace.actualToDate + pace.recentRate * (day - pace.today))} ${unit}` : ''}`;
      const now = pace.actual[day - 1];
      const diff = base === null ? '' : tr(` · ${now >= base ? '多' : '少'} ${number(Math.abs(now - base))} ${unit}`, ` · ${number(Math.abs(now - base))} ${unit} ${now >= base ? 'ahead' : 'behind'}`);
      return `${pulseMonthDay(pace.month, day)} · ${tr('本月累计', 'this month')} ${number(now)} ${unit} · ${tr('上月同日', 'last month same day')} ${base === null ? '—' : `${number(base)} ${unit}`}${diff}`;
    };
    const colW = (right - left) / Math.max(1, n - 1);
    const targets = [];
    for (let day = 1; day <= n; day++) {
      const target = draw('rect', { x: x(day) - colW / 2, y: top, width: colW, height: bottom - top, class: 'pulse-chart-target', role: 'img', tabindex: day === pace.today ? 0 : -1, 'data-analytics-date': `${pace.year}-${String(pace.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, 'aria-label': describe(day) });
      targets.push(target);
      const show = () => { cursor.setAttribute('x1', x(day)); cursor.setAttribute('x2', x(day)); cursor.setAttribute('visibility', 'visible'); readout.textContent = describe(day); };
      target.addEventListener('pointerenter', show);
      target.addEventListener('focus', show);
      target.addEventListener('keydown', event => {
        const next = event.key === 'ArrowLeft' ? day - 2 : event.key === 'ArrowRight' ? day : null;
        if (next === null || !targets[next]) return;
        event.preventDefault();
        target.setAttribute('tabindex', '-1'); targets[next].setAttribute('tabindex', '0'); targets[next].focus();
      });
    }
    svg.addEventListener('pointerleave', () => cursor.setAttribute('visibility', 'hidden'));
  }

  // Touch has no hover: the first tap on a day shows its readout, a second tap on the same day opens it.
  activateDay(date, show) {
    if (this.lastPointerType === 'touch' && this.armedDate !== date) {
      this.armedDate = date;
      show?.();
      return;
    }
    this.armedDate = null;
    this.openAnalyticsDay(date);
  }

  openAnalyticsDay(date) {
    this.selectedDate = date;
    this.activeViewTab = 'dashboard';
    this.render();
    this.containerEl.querySelector('.crisp-pulse-detail-card')?.scrollIntoView({ block: 'start', behavior: 'auto' });
  }

  analyticsSection(parent, title, description, icon = 'bar-chart-2') {
    return this.trayCard(parent, { icon, title, subtitle: description, wrap: true, cls: 'crisp-pulse-analytics-section', insetCls: 'crisp-pulse-analytics-card' });
  }

  analyticsSvg(parent, width, height, label) {
    const doc = parent.ownerDocument;
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('class', 'crisp-pulse-analytics-chart');
    if (label) { svg.setAttribute('role', 'group'); svg.setAttribute('aria-label', label); } else svg.setAttribute('aria-hidden', 'true');
    parent.appendChild(svg);
    const draw = (tag, attributes, text, into = svg) => {
      const node = doc.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
      if (text !== undefined) node.textContent = text;
      into.appendChild(node);
      return node;
    };
    return { svg, draw };
  }

  // Several measures on one day-aligned grid: shows which days were broad investment and which were single-track.
  renderAnalyticsRhythm(parent, data) {
    const rows = [
      { key: 'score', label: tr('贡献得分', 'Contribution'), color: 'blue', unit: tr('分', 'pts') },
      { key: 'wordsAdded', label: tr('新增词数', 'Words added'), color: 'purple', unit: tr('词', 'words') },
      { key: 'activeMinutes', label: tr('交互活跃', 'Active time'), color: 'green', unit: tr('分钟', 'min') },
      { key: 'focusMinutes', label: 'Focus', color: 'orange', unit: tr('分钟', 'min') },
      { key: 'notesCreated', label: tr('新建笔记', 'Notes created'), color: 'rose', unit: tr('篇', 'notes') },
      { key: 'tasksCompleted', label: tr('完成任务', 'Tasks completed'), color: 'teal', unit: tr('项', 'tasks') }
    ];
    const card = this.analyticsSection(parent, tr('投入节律', 'Effort rhythm'), tr('每行一个指标，颜色深浅按该指标在本区间内的相对高低。竖向对齐同一天，可以看出哪天是全面投入，哪天只在一个方向上用力。', 'One metric per row, shaded by how high it is relative to this period. Columns line up by day, so you can see which days were all-round efforts and which focused on one direction.'), 'layout-grid');
    const { points } = data;
    const number = value => Number(value).toLocaleString(PULSE_NUMBER_LOCALE, { maximumFractionDigits: 1 });
    const compact = value => Number(value).toLocaleString(PULSE_NUMBER_LOCALE, { notation: 'compact', maximumFractionDigits: 1 });
    // A day counts as broad when at least 4 measures sit above that measure's own median for the range.
    const medians = Object.fromEntries(rows.map(row => {
      const values = points.map(p => p[row.key]).filter(v => v !== null).sort((a, b) => a - b);
      return [row.key, values.length ? values[Math.floor((values.length - 1) / 2)] : Infinity];
    }));
    const broadDays = points.filter(p => p.status === 'included' && rows.filter(r => p[r.key] > 0 && p[r.key] > medians[r.key]).length >= 4).length;
    const summary = card.createDiv({ cls: 'crisp-pulse-analytics-summary' });
    const primary = summary.createDiv();
    primary.createDiv({ cls: 'crisp-pulse-analytics-label', text: tr('全面投入', 'All-round days') });
    primary.createDiv({ cls: 'crisp-pulse-analytics-total', text: data.recordedDays ? tr(`${broadDays} 天`, plural(broadDays, 'day')) : '—' });
    summary.createDiv({ cls: 'crisp-pulse-analytics-subtotals', text: tr(`至少 4 项指标高于各自区间中位数的日子 · 已纳入 ${data.recordedDays} 天`, `Days with at least 4 metrics above their period median · ${plural(data.recordedDays, 'day')} included`) });
    if (!data.recordedDays) card.createDiv({ cls: 'crisp-pulse-analytics-empty', text: tr('所选范围暂无可用记录。', 'No usable records in the selected range.') });

    const available = Math.max(280, Math.min(960, card.clientWidth - 48));
    const labelW = 76, showTotals = available >= 520, totalW = showTotals ? 64 : 0;
    const minCol = 7;
    const width = Math.max(available, labelW + totalW + points.length * minCol);
    const rowH = 30, top = 26, height = top + rows.length * rowH + 4;
    const scroll = card.createDiv({ cls: 'crisp-pulse-analytics-chart-scroll' });
    const { svg, draw } = this.analyticsSvg(scroll, width, height, tr('投入节律矩阵。左右方向键查看日期，Enter 打开日明细。', 'Effort rhythm matrix. Use the left and right arrow keys to move between days; press Enter to open day details.'));
    if (width > available) svg.style.minWidth = `${width}px`;
    const left = labelW, right = width - totalW;
    const colW = (right - left) / points.length;
    const cellW = Math.min(26, Math.max(3, colW * (points.length > 45 ? 0.62 : 0.72)));
    const cx = i => left + (i + 0.5) * colW;
    const labelIndices = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
    for (const i of labelIndices) draw('text', { x: cx(i), y: 12, 'text-anchor': i === 0 && colW < 30 ? 'start' : i === points.length - 1 && colW < 30 ? 'end' : 'middle', class: 'pulse-chart-axis' }, points[i].date.slice(5).replace('-', '/'));
    rows.forEach((row, r) => {
      const y = top + r * rowH;
      draw('circle', { cx: 6, cy: y + rowH / 2 - 2, r: 3.5, class: `pulse-chart-fill-${row.color}` });
      draw('text', { x: 16, y: y + rowH / 2 + 2, class: 'pulse-rhythm-label' }, row.label);
      const positives = points.map(p => p[row.key]).filter(v => v > 0).sort((a, b) => a - b);
      let total = 0;
      points.forEach((p, i) => {
        const value = p[row.key];
        const attrs = { x: cx(i) - cellW / 2, y: y + 3, width: cellW, height: rowH - 10, rx: Math.min(5, cellW / 2) };
        if (value === null) { draw('rect', { ...attrs, class: 'pulse-rhythm-missing' }); return; }
        total += value;
        if (!(value > 0)) { draw('rect', { ...attrs, class: 'pulse-rhythm-zero' }); return; }
        const rank = positives.filter(v => v <= value).length / positives.length;
        const level = rank > 0.75 ? 1 : rank > 0.5 ? 0.74 : rank > 0.25 ? 0.5 : 0.3;
        draw('rect', { ...attrs, class: `pulse-chart-fill-${row.color}`, 'fill-opacity': level });
      });
      if (showTotals) draw('text', { x: width - 2, y: y + rowH / 2 + 2, 'text-anchor': 'end', class: 'pulse-rhythm-total' }, points.some(p => p[row.key] !== null) ? compact(total) : '—');
    });

    const pad = Math.max(3, Math.min(6, colW * 0.2));
    const selector = draw('rect', { x: 0, y: top - 2, width: cellW + pad * 2, height: rows.length * rowH - 2, rx: Math.min(9, cellW / 2 + pad), class: 'pulse-rhythm-selector', visibility: 'hidden' });
    const readout = card.createDiv({ cls: 'crisp-pulse-analytics-readout', text: tr('悬停或用方向键查看某一天的全部指标；点击可打开该日明细。', 'Hover or use the arrow keys to see every metric for a day; click to open its details.') });
    readout.setAttr('aria-live', 'polite');
    const describe = p => p.status === 'missing' ? `${p.date} · ${tr('未记录', 'not recorded')}` : p.status === 'excluded' ? `${p.date} · ${tr('已被当前数据范围排除', 'excluded by the current data scope')}`
      : `${p.date} · ` + rows.map(row => `${row.label} ${p[row.key] === null ? tr('未记录', 'not recorded') : `${number(p[row.key])} ${row.unit}`}`).join(' · ');
    const targets = [];
    points.forEach((point, index) => {
      const target = draw('rect', { x: left + index * colW, y: top - 4, width: colW, height: rows.length * rowH + 2, class: 'pulse-chart-target', role: 'button', tabindex: index === points.length - 1 ? 0 : -1, 'aria-label': describe(point) + tr('，打开日明细', ', open day details'), 'data-analytics-date': point.date });
      targets.push(target);
      const show = () => { selector.setAttribute('x', cx(index) - cellW / 2 - pad); selector.setAttribute('visibility', 'visible'); readout.textContent = describe(point); };
      target.addEventListener('pointerenter', show);
      target.addEventListener('focus', show);
      target.addEventListener('click', () => this.activateDay(point.date, show));
      target.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.openAnalyticsDay(point.date); return; }
        const next = event.key === 'ArrowLeft' ? index - 1 : event.key === 'ArrowRight' ? index + 1 : event.key === 'Home' ? 0 : event.key === 'End' ? points.length - 1 : null;
        if (next === null || !targets[next]) return;
        event.preventDefault();
        target.setAttribute('tabindex', '-1'); targets[next].setAttribute('tabindex', '0'); targets[next].focus();
      });
    });
    svg.addEventListener('pointerleave', () => selector.setAttribute('visibility', 'hidden'));
    // When the matrix scrolls on narrow panes, start at the most recent days like the heatmap does.
    scroll.scrollLeft = scroll.scrollWidth;
    const legend = card.createDiv({ cls: 'crisp-pulse-analytics-legend crisp-pulse-rhythm-legend' });
    legend.createSpan({ text: tr('少', 'Less') });
    for (const opacity of [0.3, 0.5, 0.74, 1]) legend.createSpan({ cls: 'pulse-rhythm-swatch', attr: { style: `opacity:${opacity}` } });
    legend.createSpan({ text: tr('多', 'More') });
    const blank = legend.createSpan(); blank.createSpan({ cls: 'pulse-rhythm-swatch is-missing' }); blank.createSpan({ text: tr('未记录', 'not recorded') });
  }

  // Where added words came from, using the per-file sources recorded since 1.7.0.
  renderAnalyticsWritingMix(parent, mix) {
    const parts = [
      { key: 'typed', label: tr('逐步写入', 'Typed'), hint: tr('单次保存少于 500 词', 'under 500 words per save'), color: 'blue' },
      { key: 'capture', label: tr('大段捕获', 'Large captures'), hint: tr('单次保存 500 词以上', '500+ words per save'), color: 'orange' },
      { key: 'system', label: tr('系统目录', 'System folders'), hint: tr('1.13.1 之前记下的日志、备份；之后不再计入新增', 'logs and backups recorded before 1.13.1; no longer counted after that'), color: 'gray' },
      { key: 'historical', label: tr('未分类', 'Unclassified'), hint: tr('早期记录没有来源信息', 'early records have no source info'), color: 'faint' }
    ];
    const card = this.analyticsSection(parent, tr('写作来源', 'Writing sources'), tr('新增词数只算你在笔记里键入、粘贴或在速记里提交的内容，按保存方式拆分。大段捕获按单次新增量推断，粘贴、导入都落在这里。', 'Words added only count what you type or paste into notes or submit as memos, split by how it was saved. Large captures are inferred from the amount added per save; pastes and imports land there.'), 'pen-line');
    card.addClass('crisp-pulse-mix-card');
    const number = value => Number(value).toLocaleString(PULSE_NUMBER_LOCALE, { maximumFractionDigits: 0 });
    const pct = value => mix.total ? Math.round(value / mix.total * 1000) / 10 : 0;
    const head = card.createDiv({ cls: 'crisp-pulse-mix-head' });
    head.createDiv({ cls: 'crisp-pulse-analytics-label', text: tr('区间新增', 'Added this period') });
    const big = head.createDiv({ cls: 'crisp-pulse-mix-big' });
    big.createSpan({ cls: 'crisp-pulse-analytics-total', text: mix.total ? tr(`${number(mix.total)} 词`, `${number(mix.total)} words`) : '—' });
    const lead = parts.filter(part => part.key !== 'historical').sort((a, b) => mix.parts[b.key] - mix.parts[a.key])[0];
    if (mix.total && mix.parts[lead.key] > 0) big.createSpan({ cls: 'crisp-pulse-mix-of', text: tr(`${lead.label}最多，占 ${pct(mix.parts[lead.key])}%`, `mostly ${lead.label.toLowerCase()}, ${pct(mix.parts[lead.key])}%`) });
    if (mix.external > 0) head.createDiv({ cls: 'crisp-pulse-mix-note', text: tr(`另有 ${number(mix.external)} 词没有你的输入记录或来自系统目录（Agent、脚本、同步、其他插件），已记下但不计入`, `Another ${number(mix.external)} words had no input from you or came from system folders (Agents, scripts, sync, other plugins); they were logged but not counted`) });
    const bar = card.createDiv({ cls: 'crisp-pulse-mix-bar' });
    bar.setAttr('role', 'img');
    bar.setAttr('aria-label', parts.map(part => `${part.label} ${pct(mix.parts[part.key])}%`).join(tr('，', ', ')));
    if (!mix.total) bar.addClass('is-empty');
    for (const part of parts) {
      if (!(mix.parts[part.key] > 0)) continue;
      const segment = bar.createDiv({ cls: `crisp-pulse-mix-segment pulse-chart-fill-${part.color}` });
      segment.style.flexGrow = String(mix.parts[part.key]);
    }
    const grid = card.createDiv({ cls: 'crisp-pulse-mix-grid' });
    for (const part of parts) {
      const cell = grid.createDiv({ cls: 'crisp-pulse-mix-cell' });
      cell.setAttr('title', part.hint);
      const name = cell.createDiv({ cls: 'crisp-pulse-mix-name' });
      name.createSpan({ cls: `pulse-chart-dot pulse-chart-fill-${part.color}` });
      name.createSpan({ text: part.label });
      const row = cell.createDiv({ cls: 'crisp-pulse-mix-value' });
      row.createSpan({ text: `${pct(mix.parts[part.key])}%` });
      const { draw } = this.analyticsSvg(row, 64, 22);
      const values = mix.days.map(day => day ? day[part.key] : null);
      const max = Math.max(0, ...values.map(v => v || 0));
      const series = values.map(v => ({ v }));
      const path = analyticsLinePath(series, 'v', i => values.length > 1 ? 2 + i * 60 / (values.length - 1) : 32, v => max > 0 ? 19 - v / max * 16 : 19);
      if (path) draw('path', { d: path, fill: 'none', class: `pulse-mix-spark pulse-chart-stroke-${part.color}` });
      cell.createDiv({ cls: 'crisp-pulse-mix-words', text: tr(`${number(mix.parts[part.key])} 词`, `${number(mix.parts[part.key])} words`) });
    }
  }

  // Share of recorded note-days per project folder.
  renderAnalyticsFolders(parent, share) {
    const colors = ['blue', 'purple', 'orange', 'green', 'rose', 'gray'];
    const card = this.analyticsSection(parent, tr('投入去向', 'Where effort went'), tr('按“笔记 × 天”计数：同一篇笔记在一天内有记录算一次。目录取到项目一级，其余合并为“其他”。', 'Counted as “note × day”: a note with records on a day counts once. Folders go down to the project level; the rest are grouped as “Other”.'), 'folder-tree');
    card.addClass('crisp-pulse-folder-card');
    if (!share.total) { card.createDiv({ cls: 'crisp-pulse-analytics-empty', text: tr('所选范围内还没有按笔记记录的数据。', 'No per-note records in the selected range yet.') }); return; }
    const body = card.createDiv({ cls: 'crisp-pulse-folder-body' });
    const size = 188, c = size / 2, radius = 76, stroke = 14;
    const ring = body.createDiv({ cls: 'crisp-pulse-folder-ring' });
    const { draw } = this.analyticsSvg(ring, size, size);
    const gap = share.items.length > 1 ? (stroke + 5) / radius : 0;
    const point = angle => `${c + radius * Math.sin(angle)},${c - radius * Math.cos(angle)}`;
    let start = 0;
    const arcs = share.items.map((item, i) => {
      const sweep = item.count / share.total * Math.PI * 2;
      const from = start + gap / 2, to = start + sweep - gap / 2, mid = start + sweep / 2;
      start += sweep;
      const color = item.name === PULSE_OTHER_GROUP ? 'gray' : colors[i % (colors.length - 1)];
      item.color = color;
      if (share.items.length === 1) return draw('circle', { cx: c, cy: c, r: radius, fill: 'none', 'stroke-width': stroke, class: `pulse-folder-arc pulse-chart-stroke-${color}` });
      if (to - from < 0.01) return draw('circle', { cx: c + radius * Math.sin(mid), cy: c - radius * Math.cos(mid), r: stroke / 2 - 1, class: `pulse-folder-arc pulse-chart-fill-${color}` });
      return draw('path', { d: `M${point(from)} A${radius},${radius} 0 ${to - from > Math.PI ? 1 : 0} 1 ${point(to)}`, fill: 'none', 'stroke-width': stroke, class: `pulse-folder-arc pulse-chart-stroke-${color}` });
    });
    const center = ring.createDiv({ cls: 'crisp-pulse-folder-center' });
    center.createDiv({ cls: 'crisp-pulse-analytics-label', text: tr('笔记 × 天', 'note × day') });
    center.createDiv({ cls: 'crisp-pulse-folder-total', text: share.total.toLocaleString(PULSE_NUMBER_LOCALE) });
    const list = body.createDiv({ cls: 'crisp-pulse-folder-list' });
    share.items.forEach((item, i) => {
      const row = list.createDiv({ cls: 'crisp-pulse-folder-row' });
      row.setAttr('tabindex', '0');
      row.setAttr('aria-label', tr(`${item.name}：${item.count} 次，占 ${item.percent}%，新增 ${item.words} 词`, `${item.name}: ${item.count} times, ${item.percent}%, ${item.words} words added`));
      row.createSpan({ cls: `pulse-chart-dot pulse-chart-fill-${item.color}` });
      const name = row.createDiv({ cls: 'crisp-pulse-folder-name' });
      name.createDiv({ text: item.name });
      if (item.folded) name.createDiv({ cls: 'crisp-pulse-folder-sub', text: tr(`${item.folded} 个目录`, plural(item.folded, 'folder')) });
      row.createSpan({ cls: 'crisp-pulse-folder-count', text: item.count.toLocaleString(PULSE_NUMBER_LOCALE) });
      row.createSpan({ cls: 'crisp-pulse-folder-pct', text: `${item.percent}%` });
      const focus = on => { body.toggleClass('is-focusing', on); arcs.forEach((arc, j) => arc.classList.toggle('is-active', on && j === i)); row.toggleClass('is-active', on); };
      row.addEventListener('pointerenter', () => focus(true));
      row.addEventListener('pointerleave', () => focus(false));
      row.addEventListener('focus', () => focus(true));
      row.addEventListener('blur', () => focus(false));
    });
  }

  renderYearly(parent) {
    this.analyticsLastWidth = this.containerEl.children[1].clientWidth;
    const daily = this.plugin.store.daily || {};
    const include = (record, key) => this.plugin.recordMatchesScope(record, key, this.currentScope);
    const thisYear = new Date().getFullYear();
    // Only offer years that hold at least one record inside the current scope.
    const years = [...new Set([thisYear, ...Object.keys(daily).filter(key => /^\d{4}-\d{2}-\d{2}$/.test(key) && daily[key] && include(daily[key], key)).map(key => Number(key.slice(0, 4))).filter(y => y >= 2000 && y <= thisYear)])].sort((a, b) => a - b).slice(-5);
    if (this.yearlyYear !== 'auto' && !years.includes(this.yearlyYear)) this.yearlyYear = 'auto';
    const section = parent.createDiv({ cls: 'crisp-pulse-analytics crisp-pulse-yearly' });
    const heading = section.createDiv({ cls: 'crisp-pulse-analytics-heading' });
    const text = heading.createDiv();
    text.createEl('h2', { text: tr('年度画像', 'Year Portrait') });
    text.createEl('p', { text: tr('把长期记录换几种形状看：年轮、指纹、月相和地层。', 'See your long-term records in a few shapes: rings, fingerprint, moon phases and strata.') });
    const segments = heading.createDiv({ cls: 'crisp-pulse-analytics-segments' });
    segments.setAttr('aria-label', tr('选择时间范围', 'Choose time range'));
    for (const option of ['auto', ...years]) {
      const button = segments.createEl('button', { text: option === 'auto' ? tr('自动', 'Auto') : String(option) });
      button.setAttr('aria-pressed', String(option === this.yearlyYear));
      button.setAttr('title', option === 'auto' ? tr('从第一条记录到今天，至少 30 天', 'From the first record to today, at least 30 days') : tr(`${option} 年完整日历年`, `Calendar year ${option}`));
      button.addEventListener('click', () => { this.yearlyYear = option; this.render(); });
    }
    const profile = this.yearlyYear === 'auto'
      ? buildDayProfile(daily, portraitDates(daily, include), include)
      : buildYearProfile(daily, this.yearlyYear, include);
    // Past ~4 months one mark per day turns into a smear; ring and fingerprint switch to weeks, the calendar stays daily.
    const portrait = profile.days.length > 120 ? buildWeekProfile(profile) : profile;
    const scopeLabel = REVIEW_SCOPE_LABELS[this.currentScope] || this.currentScope;
    const span = profile.year ? tr(`${profile.year} 年`, String(profile.year)) : `${formatDateDisplay(profile.days[0].date)} — ${tr('今天', 'today')}`;
    section.createDiv({ cls: 'crisp-pulse-analytics-coverage', text: tr(`${span} · ${scopeLabel} · 已纳入 ${profile.recordedDays} 天，其中 ${profile.activeDays} 天有贡献。未记录或被筛选的日期留空。`, `${span} · ${scopeLabel} · ${plural(profile.recordedDays, 'day')} included, ${profile.activeDays} with contributions. Days not recorded or filtered out are left blank.`) });
    this.renderYearRing(section, portrait);
    this.renderYearFingerprint(section, portrait);
    this.renderYearMoons(section, profile);
    const dates = profile.days.filter(day => day.status !== 'future').map(day => day.date);
    this.renderYearStrata(section, buildStrata(daily, dates, include));
  }

  describeYearDay(day) {
    const number = value => Number(value).toLocaleString(PULSE_NUMBER_LOCALE, { maximumFractionDigits: 1 });
    if (day.unit === 'week') {
      const range = `${day.date.slice(5).replace('-', '/')}–${day.end.slice(5).replace('-', '/')}`;
      if (day.status === 'future') return `${range} · ${tr('尚未到来', 'not yet')}`;
      if (day.status !== 'included') return `${range} · ${day.status === 'missing' ? tr('未记录', 'not recorded') : tr('已被当前数据范围排除', 'excluded by the current data scope')}`;
      const lead = YEAR_DIMENSIONS.find(dim => dim.key === day.dominant);
      return tr(`${range} · 贡献 ${number(day.score)} 分 · ${day.activeDays} 天有贡献 · 新增 ${number(day.words)} 词 · 交互 ${number(day.active)} 分钟 · 新建 ${number(day.notes)} 篇${lead ? ` · 以${lead.label}为主` : ''}`,
        `${range} · ${number(day.score)} pts · ${plural(day.activeDays, 'day')} with contributions · ${number(day.words)} words added · ${number(day.active)} min active · ${number(day.notes)} new notes${lead ? ` · mostly ${lead.label}` : ''}`);
    }
    if (day.status === 'future') return `${formatDateDisplay(day.date)} · ${tr('尚未到来', 'not yet')}`;
    if (day.status === 'missing') return `${formatDateDisplay(day.date)} · ${tr('未记录', 'not recorded')}`;
    if (day.status === 'excluded') return `${formatDateDisplay(day.date)} · ${tr('已被当前数据范围排除', 'excluded by the current data scope')}`;
    const lead = YEAR_DIMENSIONS.find(dim => dim.key === day.dominant);
    return tr(`${formatDateDisplay(day.date)} · 贡献 ${number(day.score)} 分 · 新增 ${number(day.words)} 词 · 交互 ${number(day.active)} 分钟 · Focus ${number(day.focus)} 分钟 · 新建 ${number(day.notes)} 篇${lead ? ` · 以${lead.label}为主` : ''}`,
      `${formatDateDisplay(day.date)} · ${number(day.score)} pts · ${number(day.words)} words added · ${number(day.active)} min active · Focus ${number(day.focus)} min · ${number(day.notes)} new notes${lead ? ` · mostly ${lead.label}` : ''}`);
  }

  // The range wound clockwise from a small gap at twelve o'clock; one capsule petal per day.
  renderYearRing(parent, profile) {
    const colors = { write: 'purple', interact: 'green', focus: 'orange', create: 'rose' };
    const weekly = profile.unit === 'week', unitName = weekly ? tr('周', 'week') : tr('天', 'day');
    const card = this.analyticsSection(parent, tr('年轮', 'Year Rings'), tr(`从顶部缺口右侧开始顺时针，每${unitName}一片花瓣：越长表示当${unitName}贡献越高，颜色是当${unitName}相对自己最突出的投入方向。${weekly ? '范围超过 120 天，按周汇总。' : ''}`, `Clockwise from the right of the gap at the top, one petal per ${unitName}: longer petals mean a higher contribution that ${unitName}, and the color shows that ${unitName}’s most prominent kind of effort.${weekly ? ' The range exceeds 120 days, so it is grouped by week.' : ''}`), 'orbit');
    const size = Math.max(300, Math.min(600, card.clientWidth - 48));
    const c = size / 2, inner = size * 0.19, outer = size * 0.42, labelR = size * 0.47;
    const wrap = card.createDiv({ cls: 'crisp-pulse-ring-wrap' });
    wrap.style.maxWidth = `${size}px`;
    const { svg, draw } = this.analyticsSvg(wrap, size, size, tr('年轮。左右方向键逐日查看，Enter 打开日明细。', 'Year rings. Use the left and right arrow keys to step through days; press Enter to open day details.'));
    svg.classList.add('crisp-pulse-ring');
    svg.setAttribute('tabindex', '0');
    const days = profile.days, n = days.length;
    const gapFrac = n >= 360 ? 0.02 : 0.07;
    const startAngle = Math.PI * 2 * gapFrac / 2, arc = Math.PI * 2 * (1 - gapFrac);
    const angleOf = i => startAngle + (i + 0.5) / n * arc;
    const at = (angle, r) => [c + r * Math.sin(angle), c - r * Math.cos(angle)];
    const petalW = Math.max(1.4, Math.min(18, inner * arc / n * 0.64));
    for (const f of [0.5, 1]) draw('circle', { cx: c, cy: c, r: inner + (outer - inner) * f, class: 'pulse-ring-guide' });
    const ticks = portraitTicks(days);
    for (const tick of ticks) {
      const [lx, ly] = at(angleOf(tick.index), labelR);
      draw('text', { x: lx, y: ly, 'text-anchor': 'middle', 'dominant-baseline': 'middle', class: 'pulse-ring-month' }, tick.label);
    }
    if (!profile.year) {
      const [sx, sy] = at(startAngle, outer + 2), [ex, ey] = at(-startAngle, outer + 2);
      draw('text', { x: sx + 4, y: sy - 8, 'text-anchor': 'start', class: 'pulse-ring-edge' }, tr('起', 'start'));
      draw('text', { x: ex - 4, y: ey - 8, 'text-anchor': 'end', class: 'pulse-ring-edge' }, tr('今天', 'today'));
    }
    const base = inner + petalW / 2 + 2;
    const petals = days.map((day, i) => {
      const angle = angleOf(i);
      if (day.status === 'future') return null;
      if (day.status !== 'included') { const [x, y] = at(angle, base); return draw('circle', { cx: x, cy: y, r: Math.max(1, petalW * 0.28), class: 'pulse-ring-missing pulse-ring-petal' }); }
      const length = day.length > 0 ? 4 + (outer - base - petalW / 2 - 4) * day.length : 0;
      const [x1, y1] = at(angle, base), [x2, y2] = at(angle, base + length);
      const cls = day.dominant ? `pulse-ring-petal pulse-ring-tick pulse-chart-stroke-${colors[day.dominant]}` : 'pulse-ring-petal pulse-ring-tick pulse-ring-zero';
      return draw('line', { x1, y1, x2, y2, 'stroke-width': petalW, 'stroke-opacity': day.dominant ? Math.round((0.5 + 0.5 * day.intensity) * 100) / 100 : 1, class: cls });
    });
    const center = wrap.createDiv({ cls: 'crisp-pulse-ring-center' });
    const centerTop = center.createDiv({ cls: 'crisp-pulse-analytics-label' });
    const centerMain = center.createDiv({ cls: 'crisp-pulse-ring-year' });
    const centerSub = center.createDiv({ cls: 'crisp-pulse-ring-sub' });
    const resetCenter = () => { centerTop.textContent = profile.year ? tr(`${profile.year} 年`, String(profile.year)) : weekly ? tr(`${n} 周`, plural(n, 'week')) : tr(`${n} 天`, plural(n, 'day')); centerMain.textContent = String(profile.activeDays); centerSub.textContent = tr('天有贡献', 'days with contributions'); };
    resetCenter();
    const readout = card.createDiv({ cls: 'crisp-pulse-analytics-readout', text: weekly ? tr('悬停在花瓣上查看某一周，点击打开当周贡献最高的一天。', 'Hover over a petal to see a week; click to open its highest-contribution day.') : tr('悬停在花瓣上查看某一天，点击打开日明细。', 'Hover over a petal to see a day; click to open its details.') });
    readout.setAttr('aria-live', 'polite');
    let current = null;
    const show = index => {
      const day = days[index];
      current = index;
      svg.classList.add('is-inspecting');
      petals.forEach((petal, i) => petal?.classList.toggle('is-hot', i === index));
      centerTop.textContent = weekly ? `${day.date.slice(5).replace('-', '/')}–${day.end.slice(5).replace('-', '/')}` : pulseMonthDay(Number(day.date.slice(5, 7)), Number(day.date.slice(8)));
      centerMain.textContent = day.status === 'included' ? Number(day.score).toLocaleString(PULSE_NUMBER_LOCALE, { maximumFractionDigits: 1 }) : '—';
      const lead = YEAR_DIMENSIONS.find(dim => dim.key === day.dominant);
      centerSub.textContent = day.status === 'included' ? (lead ? tr(`分 · 以${lead.label}为主`, `pts · mostly ${lead.label}`) : tr('分', 'pts')) : day.status === 'future' ? tr('尚未到来', 'not yet') : day.status === 'missing' ? tr('未记录', 'not recorded') : tr('已排除', 'excluded');
      readout.textContent = this.describeYearDay(day);
    };
    const hide = () => { current = null; svg.classList.remove('is-inspecting'); petals.forEach(petal => petal?.classList.remove('is-hot')); resetCenter(); };
    const indexAt = event => {
      const box = svg.getBoundingClientRect();
      const scale = size / box.width;
      const dx = (event.clientX - box.left) * scale - c, dy = (event.clientY - box.top) * scale - c;
      const r = Math.hypot(dx, dy);
      if (r < inner * 0.8 || r > labelR + 10) return null;
      const angle = (Math.atan2(dx, -dy) + Math.PI * 2) % (Math.PI * 2);
      if (angle < startAngle || angle > startAngle + arc) return null;
      return Math.min(n - 1, Math.floor((angle - startAngle) / arc * n));
    };
    // Crossing the start gap or the hole keeps the last petal selected; only leaving the ring clears it.
    svg.addEventListener('pointermove', event => { const i = indexAt(event); if (i !== null && i !== current) show(i); });
    svg.addEventListener('pointerleave', () => { if (svg.ownerDocument.activeElement !== svg) hide(); });
    const targetDate = unit => unit.unit === 'week' ? unit.bestDate || unit.end : unit.date;
    svg.addEventListener('click', event => { const i = indexAt(event); if (i !== null && days[i].status !== 'future') this.activateDay(targetDate(days[i]), () => show(i)); });
    const lastIncluded = days.findLastIndex(day => day.status === 'included');
    svg.addEventListener('focus', () => show(lastIncluded >= 0 ? lastIncluded : n - 1));
    svg.addEventListener('blur', hide);
    svg.addEventListener('keydown', event => {
      if (current === null) return;
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (days[current].status !== 'future') this.openAnalyticsDay(targetDate(days[current])); return; }
      const delta = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: weekly ? 4 : 7, ArrowUp: weekly ? -4 : -7 }[event.key];
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? n - 1 : delta === undefined ? null : Math.max(0, Math.min(n - 1, current + delta));
      if (next === null) return;
      event.preventDefault();
      show(next);
    });
    const legend = card.createDiv({ cls: 'crisp-pulse-analytics-legend' });
    for (const dim of YEAR_DIMENSIONS) {
      const item = legend.createSpan();
      item.createSpan({ cls: `pulse-chart-dot pulse-chart-fill-${colors[dim.key]}` });
      item.createSpan({ text: tr(`以${dim.label}为主`, `mostly ${dim.label}`) });
    }
    legend.createSpan({ cls: 'crisp-pulse-legend-note', text: tr(`花瓣长度 = 当${unitName}贡献`, `petal length = that ${unitName}’s contribution`) });
  }

  fingerprintPalette() {
    return FINGERPRINT_PALETTES[this.containerEl.ownerDocument.body.classList.contains('theme-dark') ? 'dark' : 'light'];
  }

  renderYearFingerprint(parent, profile) {
    const weekly = profile.unit === 'week', unitName = weekly ? tr('周', 'week') : tr('天', 'day');
    const card = this.analyticsSection(parent, tr('知识指纹', 'Knowledge Fingerprint'), tr(`每${unitName}一根竖条，按写作、交互、专注、新建四个方向的相对比例分段上色，亮度随当${unitName}强度变化。每个人的都不一样，可以导出成图片。${weekly ? '范围超过 120 天，按周汇总。' : ''}`, `One bar per ${unitName}, colored in segments by the relative share of writing, interaction, focus and new notes; brightness follows that ${unitName}’s intensity. Everyone’s looks different, and you can export it as an image.${weekly ? ' The range exceeds 120 days, so it is grouped by week.' : ''}`), 'fingerprint');
    const palette = this.fingerprintPalette();
    card.addClass('crisp-pulse-fingerprint-card');
    card.style.background = palette.bg;
    card.style.borderColor = palette.border;
    const width = Math.max(300, Math.min(1100, card.clientWidth));
    const height = Math.round(width * (width < 560 ? 0.66 : 0.44));
    const { svg, draw } = this.analyticsSvg(card, width, height, tr('知识指纹。左右方向键逐日查看，Enter 打开日明细。', 'Knowledge fingerprint. Use the left and right arrow keys to step through days; press Enter to open day details.'));
    svg.classList.add('crisp-pulse-fp');
    const geometry = drawFingerprint(draw, profile, width, height, palette);
    const foot = card.createDiv({ cls: 'crisp-pulse-fingerprint-actions' });
    foot.style.background = palette.bg;
    const readout = foot.createDiv({ cls: 'crisp-pulse-fp-readout', text: weekly ? tr('悬停在竖条上查看某一周，点击打开当周贡献最高的一天。', 'Hover over a bar to see a week; click to open its highest-contribution day.') : tr('悬停在竖条上查看某一天，点击打开日明细。', 'Hover over a bar to see a day; click to open its details.') });
    readout.style.color = palette.title;
    readout.setAttr('aria-live', 'polite');
    const button = foot.createEl('button', { text: tr('导出 PNG', 'Export PNG') });
    button.style.cssText = `background:${palette.empty};color:${palette.text};border-color:${palette.border}`;
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { await this.exportYearFingerprint(profile); } finally { button.disabled = false; }
    });
    const days = profile.days;
    const targets = [];
    const show = index => {
      svg.classList.add('is-inspecting');
      geometry.bars.forEach(bar => bar.group.classList.toggle('is-hot', bar.index === index));
      readout.textContent = this.describeYearDay(days[index]);
      readout.style.color = palette.text;
    };
    const hide = () => { svg.classList.remove('is-inspecting'); geometry.bars.forEach(bar => bar.group.classList.remove('is-hot')); };
    const lastIndex = days.findLastIndex(d => d.status !== 'future');
    days.forEach((day, i) => {
      if (day.status === 'future') { targets.push(null); return; }
      const target = draw('rect', { x: geometry.x0 + i * geometry.step, y: geometry.y0 - 6, width: geometry.step, height: geometry.y1 - geometry.y0 + 12, class: 'pulse-chart-target', role: 'button', tabindex: i === lastIndex ? 0 : -1, 'aria-label': this.describeYearDay(day) + tr('，打开日明细', ', open day details'), 'data-analytics-date': day.date });
      targets.push(target);
      target.addEventListener('pointerenter', () => show(i));
      target.addEventListener('focus', () => show(i));
      const date = weekly ? day.bestDate || day.end : day.date;
      target.addEventListener('click', () => this.activateDay(date, () => show(i)));
      target.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.openAnalyticsDay(date); return; }
        const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
        if (!step) return;
        let next = i + step;
        while (targets[next] === null) next += step;
        if (!targets[next]) return;
        event.preventDefault();
        target.setAttribute('tabindex', '-1'); targets[next].setAttribute('tabindex', '0'); targets[next].focus();
      });
    });
    svg.addEventListener('pointerleave', () => { if (!svg.contains(svg.ownerDocument.activeElement)) hide(); });
    svg.addEventListener('focusout', event => { if (!svg.contains(event.relatedTarget)) hide(); });
  }

  async exportYearFingerprint(profile) {
    const width = 1600, height = 704, ratio = 2;
    const doc = this.containerEl.ownerDocument;
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    svg.setAttribute('width', String(width)); svg.setAttribute('height', String(height));
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    drawFingerprint(svgDrawer(doc, svg), profile, width, height, this.fingerprintPalette());
    const win = doc.defaultView;
    const url = win.URL.createObjectURL(new win.Blob([new win.XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml;charset=utf-8' }));
    try {
      const image = new win.Image();
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error(tr('图片渲染失败', 'Failed to render the image'))); image.src = url; });
      const canvas = doc.createElement('canvas');
      canvas.width = width * ratio; canvas.height = height * ratio;
      const context = canvas.getContext('2d');
      context.scale(ratio, ratio);
      context.drawImage(image, 0, 0, width, height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error(tr('无法生成 PNG', 'Could not create the PNG'));
      const suffix = profile.year ? String(profile.year) : `${profile.days[0].date}_${profile.days.at(-1).date}`;
      const res = await this.plugin.saveExportFile(`crisp-pulse-fingerprint-${suffix}.png`, await blob.arrayBuffer(), 'image/png');
      if (res.success && !res.path) new Notice(tr('已导出知识指纹图片', 'Knowledge fingerprint image exported'));
    } catch (error) {
      console.error('[Crisp Pulse] Fingerprint export failed:', error);
      new Notice(tr('导出失败：', 'Export failed: ') + (error?.message || error));
    } finally {
      win.URL.revokeObjectURL(url);
    }
  }

  // A month calendar of moons: the lit share of each moon is that day's intensity percentile in the range.
  renderYearMoons(parent, profile) {
    const card = this.analyticsSection(parent, tr('月相日历', 'Moon Calendar'), tr('每天一个月亮，亮面比例是当天强度在本范围内的百分位：满月是高峰日，新月是有记录但没有贡献的日子，虚线圈表示未记录。', 'One moon per day; the lit portion is that day’s intensity percentile within this range. A full moon is a peak day, a new moon is a recorded day with no contribution, and a dashed circle means not recorded.'), 'moon');
    const doc = card.ownerDocument;
    const days = profile.days;
    const full = days.filter(day => day.status === 'included' && day.intensity >= 0.9).length;
    const rest = days.filter(day => day.status === 'included' && !(day.score > 0)).length;
    const summary = card.createDiv({ cls: 'crisp-pulse-analytics-summary' });
    const primary = summary.createDiv();
    primary.createDiv({ cls: 'crisp-pulse-analytics-label', text: tr('满月', 'Full moons') });
    primary.createDiv({ cls: 'crisp-pulse-analytics-total', text: profile.recordedDays ? tr(`${full} 天`, plural(full, 'day')) : '—' });
    summary.createDiv({ cls: 'crisp-pulse-analytics-subtotals', text: tr(`强度前 10% 的日子 · 新月 ${rest} 天 · 已纳入 ${profile.recordedDays} 天`, `Top 10% intensity days · ${plural(rest, 'new-moon day')} · ${plural(profile.recordedDays, 'day')} included`) });
    const months = new Map();
    days.forEach((day, index) => {
      const key = day.date.slice(0, 7);
      if (!months.has(key)) months.set(key, []);
      months.get(key).push({ day, index });
    });
    const grid = card.createDiv({ cls: `crisp-pulse-moon-months${months.size <= 2 ? ' is-few' : ''}` });
    const cells = [];
    const readout = card.createDiv({ cls: 'crisp-pulse-analytics-readout', text: tr('悬停在月亮上查看某一天，点击打开日明细。', 'Hover over a moon to see a day; click to open its details.') });
    readout.setAttr('aria-live', 'polite');
    const lastIndex = days.findLastIndex(day => day.status !== 'future');
    for (const [key, entries] of months) {
      const [y, m] = key.split('-').map(Number);
      const block = grid.createDiv({ cls: 'crisp-pulse-moon-month' });
      block.createDiv({ cls: 'crisp-pulse-moon-title', text: tr(`${y} 年 ${m} 月`, `${pulseMonthLabel(m)} ${y}`) });
      const table = block.createDiv({ cls: 'crisp-pulse-moon-grid' });
      for (const label of (PULSE_ZH ? ['一', '二', '三', '四', '五', '六', '日'] : ['M', 'T', 'W', 'T', 'F', 'S', 'S'])) table.createDiv({ cls: 'crisp-pulse-moon-weekday', text: label });
      // Leading blanks keep weekday columns aligned; days before the range stay blank rather than looking unrecorded.
      const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7;
      for (let i = 0; i < lead + Number(entries[0].day.date.slice(8)) - 1; i++) table.createDiv({ cls: 'crisp-pulse-moon-blank' });
      for (const { day, index } of entries) {
        const cell = table.createDiv({ cls: `crisp-pulse-moon is-${day.status}` });
        const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 28 28');
        svg.setAttribute('aria-hidden', 'true');
        cell.appendChild(svg);
        const draw = svgDrawer(doc, svg);
        if (day.status === 'future') draw('circle', { cx: 14, cy: 14, r: 2, class: 'pulse-moon-future' });
        else if (day.status !== 'included') draw('circle', { cx: 14, cy: 14, r: 10.5, class: 'pulse-moon-missing' });
        else {
          if (day.intensity >= 0.9) draw('circle', { cx: 14, cy: 14, r: 13, class: 'pulse-moon-halo' });
          draw('circle', { cx: 14, cy: 14, r: 10.5, class: 'pulse-moon-dark' });
          const lit = moonPath(day.intensity, 14, 14, 10.5);
          if (lit) draw('path', { d: lit, class: 'pulse-moon-lit' });
        }
        cell.createDiv({ cls: 'crisp-pulse-moon-day', text: String(Number(day.date.slice(8))) });
        if (day.status === 'future') continue;
        cell.setAttr('role', 'button');
        cell.setAttr('tabindex', index === lastIndex ? '0' : '-1');
        cell.setAttr('aria-label', this.describeYearDay(day) + tr('，打开日明细', ', open day details'));
        cell.dataset.analyticsDate = day.date;
        cells[index] = cell;
        const show = () => { grid.addClass('is-inspecting'); cells.forEach(c => c?.toggleClass('is-hot', c === cell)); readout.textContent = this.describeYearDay(day); };
        cell.addEventListener('pointerenter', show);
        cell.addEventListener('focus', show);
        cell.addEventListener('click', () => this.activateDay(day.date, show));
        cell.addEventListener('keydown', event => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.openAnalyticsDay(day.date); return; }
          const delta = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 7, ArrowUp: -7 }[event.key];
          if (delta === undefined) return;
          const next = cells[index + delta];
          if (!next) return;
          event.preventDefault();
          cell.setAttr('tabindex', '-1'); next.setAttr('tabindex', '0'); next.focus();
        });
      }
    }
    grid.addEventListener('pointerleave', () => { if (!grid.contains(doc.activeElement)) { grid.removeClass('is-inspecting'); cells.forEach(c => c?.removeClass('is-hot')); } });
    grid.addEventListener('focusout', event => { if (!grid.contains(event.relatedTarget)) { grid.removeClass('is-inspecting'); cells.forEach(c => c?.removeClass('is-hot')); } });
    const legend = card.createDiv({ cls: 'crisp-pulse-analytics-legend crisp-pulse-moon-legend' });
    legend.createSpan({ text: tr('新月', 'New') });
    for (const f of [0, 0.25, 0.5, 0.75, 1]) {
      const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 28 28');
      svg.setAttribute('aria-hidden', 'true');
      legend.appendChild(svg);
      const draw = svgDrawer(doc, svg);
      draw('circle', { cx: 14, cy: 14, r: 10.5, class: 'pulse-moon-dark' });
      if (f) draw('path', { d: moonPath(f, 14, 14, 10.5), class: 'pulse-moon-lit' });
    }
    legend.createSpan({ text: tr('满月', 'Full') });
  }

  // Weekly strata, newest on top: thickness follows words added, colour bands follow project folders.
  renderYearStrata(parent, strata) {
    const palette = ['blue', 'purple', 'orange', 'green', 'rose', 'teal'];
    const card = this.analyticsSection(parent, tr('知识地层', 'Knowledge Strata'), tr('每周一层，最新的一周在最上面。层的厚度随当周新增词数变化，层内按项目目录分色；持续投入的项目会连成一条贯穿多层的矿脉。', 'One layer per week, newest on top. Thickness follows the words added that week, and colors mark project folders; projects you keep working on form a vein running through many layers.'), 'layers');
    if (!strata.weeks.some(week => week.recorded)) { card.createDiv({ cls: 'crisp-pulse-analytics-empty', text: tr('这一年还没有可用记录。', 'No usable records for this year yet.') }); return; }
    const width = Math.max(300, Math.min(1000, card.clientWidth - 48));
    const compact = width < 520, labelW = compact ? 34 : 50;
    const minT = 5, maxT = compact ? 24 : 32;
    const ref = yearQuantile(strata.weeks.map(week => week.words), 0.95);
    // Consecutive unrecorded weeks collapse into one thin band instead of a stack of hairlines.
    const layers = [];
    let y = 4;
    for (const week of [...strata.weeks].reverse()) {
      const previous = layers[layers.length - 1];
      if (!week.recorded && previous && !previous.week.recorded) {
        previous.week = { ...previous.week, start: week.start, span: previous.week.span + 1 };
        continue;
      }
      const t = !week.recorded ? 12 : ref > 0 ? minT + (maxT - minT) * Math.sqrt(Math.min(1, week.words / ref)) : minT;
      layers.push({ week: week.recorded ? week : { ...week, span: 1 }, top: y, bottom: y + t });
      y += t + (week.recorded ? 0 : 2);
    }
    const height = Math.ceil(y + 4);
    const { svg, draw } = this.analyticsSvg(card, width, height, tr('知识地层。上下方向键逐周查看。', 'Knowledge strata. Use the up and down arrow keys to step through weeks.'));
    svg.classList.add('crisp-pulse-strata');
    const left = labelW, right = width;
    // Deterministic seams so the same year always draws the same rock.
    const seam = (k, x) => (k === 0 || k === layers.length) ? 0 : Math.sin(x / 37 + k * 1.7) * 1.6 + Math.sin(x / 13 + k * 0.9) * 0.7;
    const edge = (k, base) => {
      const points = [];
      for (let x = left; x <= right; x += 10) points.push([x, base + seam(k, x)]);
      if (points[points.length - 1][0] !== right) points.push([right, base + seam(k, right)]);
      return points;
    };
    const uid = `pulse-strata-${Math.random().toString(36).slice(2, 8)}`;
    const defs = draw('defs', {});
    const colorOf = name => name === PULSE_OTHER_GROUP ? 'gray' : palette[strata.folders.indexOf(name) % palette.length];
    const groups = [];
    let lastMonth = null, lastLabelY = -Infinity;
    layers.forEach((layer, k) => {
      const upper = edge(k, layer.top), lower = edge(k + 1, layer.bottom).reverse();
      const d = 'M' + [...upper, ...lower].map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' L') + ' Z';
      const group = draw('g', { class: 'pulse-strata-layer' });
      groups.push(group);
      const { week } = layer;
      if (!week.recorded) {
        draw('path', { d, class: 'pulse-strata-gap' }, undefined, group);
        draw('text', { x: left + 10, y: (layer.top + layer.bottom) / 2 + 3.5, class: 'pulse-strata-gap-label' }, tr(`未记录 · ${week.span} 周`, `not recorded · ${plural(week.span, 'week')}`), group);
      }
      else if (!week.total) draw('path', { d, class: 'pulse-strata-blank' }, undefined, group);
      else {
        const clip = draw('clipPath', { id: `${uid}-${k}` }, undefined, defs);
        draw('path', { d }, undefined, clip);
        const intensity = ref > 0 ? Math.min(1, week.words / ref) : 0;
        let x = left;
        for (const name of strata.folders) {
          const count = week.counts[name] || 0;
          if (!count) continue;
          const w = (right - left) * count / week.total;
          draw('rect', { x, y: layer.top - 3, width: w + 0.5, height: layer.bottom - layer.top + 6, 'clip-path': `url(#${uid}-${k})`, 'fill-opacity': Math.round((0.42 + 0.58 * intensity) * 100) / 100, class: `pulse-chart-fill-${colorOf(name)}` }, undefined, group);
          x += w;
        }
      }
      const month = Number(week.start.slice(5, 7));
      const labelY = (layer.top + layer.bottom) / 2 + 4;
      if (week.recorded && month !== lastMonth && labelY - lastLabelY >= 14) { draw('text', { x: 0, y: labelY, class: 'pulse-strata-label' }, pulseMonthLabel(month)); lastLabelY = labelY; }
      lastMonth = month;
    });
    layers.forEach((layer, k) => { if (k && layer.week.recorded && layers[k - 1].week.recorded) draw('path', { d: 'M' + edge(k, layer.top).map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' L'), class: 'pulse-strata-seam' }); });
    const readout = card.createDiv({ cls: 'crisp-pulse-analytics-readout', text: tr('悬停在某一层查看当周的投入分布。', 'Hover over a layer to see how that week’s effort was spread.') });
    readout.setAttr('aria-live', 'polite');
    const describe = week => {
      const range = `${week.start.slice(5).replace('-', '/')}–${week.end.slice(5).replace('-', '/')}`;
      const [yy, mm, dd] = week.start.split('-').map(Number);
      const weekNo = getIsoWeekString(new Date(yy, mm - 1, dd)).replace(/^\d+-W/, '');
      const title = `${tr(`第 ${weekNo} 周`, `Week ${weekNo}`)} · ${range}`;
      if (!week.recorded) return week.span > 1 ? `${week.start.slice(5).replace('-', '/')}–${week.end.slice(5).replace('-', '/')} · ${tr(`连续 ${week.span} 周未记录`, `${week.span} weeks not recorded`)}` : `${title} · ${tr('未记录', 'not recorded')}`;
      const parts = strata.folders.filter(name => week.counts[name]).map(name => `${name} ${Math.round(week.counts[name] / week.total * 100)}%`);
      return `${title} · ${tr(`新增 ${Number(week.words).toLocaleString(PULSE_NUMBER_LOCALE)} 词`, `${Number(week.words).toLocaleString(PULSE_NUMBER_LOCALE)} words added`)}` + (parts.length ? ` · ${parts.join(' · ')}` : '');
    };
    const targets = layers.map((layer, k) => {
      const target = draw('rect', { x: left, y: layer.top, width: right - left, height: layer.bottom - layer.top, class: 'pulse-chart-target pulse-strata-target', role: 'img', tabindex: k === 0 ? 0 : -1, 'aria-label': describe(layer.week) });
      const show = () => { svg.classList.add('is-inspecting'); groups.forEach((g, j) => g.classList.toggle('is-hot', j === k)); readout.textContent = describe(layer.week); };
      target.addEventListener('pointerenter', show);
      target.addEventListener('focus', show);
      target.addEventListener('keydown', event => {
        const next = event.key === 'ArrowUp' ? k - 1 : event.key === 'ArrowDown' ? k + 1 : null;
        if (next === null || !targets[next]) return;
        event.preventDefault();
        target.setAttribute('tabindex', '-1'); targets[next].setAttribute('tabindex', '0'); targets[next].focus();
      });
      return target;
    });
    svg.addEventListener('pointerleave', () => { svg.classList.remove('is-inspecting'); groups.forEach(g => g.classList.remove('is-hot')); });
    const legend = card.createDiv({ cls: 'crisp-pulse-analytics-legend' });
    for (const name of strata.folders) {
      const item = legend.createSpan();
      item.createSpan({ cls: `pulse-chart-dot pulse-chart-fill-${colorOf(name)}` });
      item.createSpan({ text: name });
    }
  }

  renderAnalyticsChart(parent, data, config) {
    const card = this.analyticsSection(parent, config.title, config.description, config.icon);
    const summary = card.createDiv({ cls: 'crisp-pulse-analytics-summary' });
    const number = value => Number(value).toLocaleString(PULSE_NUMBER_LOCALE, { maximumFractionDigits: 1 });
    const primary = summary.createDiv();
    primary.createDiv({ cls: 'crisp-pulse-analytics-label', text: config.totalLabel });
    primary.createDiv({ cls: 'crisp-pulse-analytics-total', text: data.points.some(p => p[config.total] !== null) ? `${number(data.totals[config.total])} ${config.unit}` : "—" });
    if (config.type === 'line') {
      const details = summary.createDiv({ cls: 'crisp-pulse-analytics-subtotals' });
      for (const series of config.series.filter(s => s.key !== config.total)) {
        details.createDiv({ text: `${series.label} ${number(data.totals[series.key])} ${config.unit}` });
      }
    }
    const hasValues = data.points.some(p => config.series.some(s => p[s.key] !== null));
    if (!hasValues) card.createDiv({ cls: 'crisp-pulse-analytics-empty', text: tr('所选范围暂无可用记录。开始记录后，曲线会从真实数据出现的位置绘制。', 'No usable records in the selected range. Once recording starts, the lines are drawn from where real data begins.') });
    const scroll = card.createDiv({ cls: 'crisp-pulse-analytics-chart-scroll' });
    const doc = card.ownerDocument;
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const chartWidth = Math.max(280, Math.min(960, card.clientWidth - 48));
    svg.setAttribute('viewBox', `0 0 ${chartWidth} 270`);
    svg.setAttribute('class', 'crisp-pulse-analytics-chart');
    svg.setAttribute('role', 'group');
    svg.setAttribute('aria-label', tr(`${config.title}，单位${config.unit}。左右方向键查看日期，Enter 打开日明细。`, `${config.title}, in ${config.unit}. Use the left and right arrow keys to move between days; press Enter to open day details.`));
    scroll.appendChild(svg);
    const draw = (tag, attributes, text) => {
      const node = doc.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
      if (text !== undefined) node.textContent = text;
      svg.appendChild(node);
      return node;
    };
    const { points } = data;
    const left = 62, right = chartWidth - 22, top = 18, bottom = 222;
    const width = (right - left) / points.length;
    const x = index => left + (index + 0.5) * width;
    const maxValue = Math.max(0, ...points.flatMap(p => config.series.map(s => p[s.key] ?? 0)));
    const scale = analyticsScale(maxValue);
    const y = value => bottom - value / scale.max * (bottom - top);
    for (const tick of scale.ticks) {
      draw('line', { x1: left, x2: right, y1: y(tick), y2: y(tick), class: 'pulse-chart-grid' });
      draw('text', { x: left - 13, y: y(tick) + 4, 'text-anchor': 'end', class: 'pulse-chart-axis' }, Number(tick.toPrecision(6)).toLocaleString(PULSE_NUMBER_LOCALE, { maximumFractionDigits: 6 }));
    }
    const labelIndices = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
    for (const i of labelIndices) draw('text', { x: x(i), y: 252, 'text-anchor': i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle', class: 'pulse-chart-axis' }, points[i].date.slice(5).replace('-', '/'));
    for (const series of config.series) {
      if (config.type === 'bar') {
        points.forEach((p, i) => {
          const value = p[series.key];
          if (value === null) return;
          if (value === 0) draw('circle', { cx: x(i), cy: bottom, r: 2, class: `pulse-chart-fill-${series.color}` });
          else draw('rect', { x: x(i) - width * 0.34, y: y(value), width: width * 0.68, height: bottom - y(value), rx: Math.min(5, width * 0.15), class: `pulse-chart-fill-${series.color}` });
        });
      } else {
        draw('path', { d: analyticsLinePath(points, series.key, x, y), fill: 'none', class: `pulse-chart-line pulse-chart-stroke-${series.color}` });
        points.forEach((p, i) => {
          if (p[series.key] !== null) draw('circle', { cx: x(i), cy: y(p[series.key]), r: 3, class: `pulse-chart-fill-${series.color}` });
        });
      }
    }
    const marker = draw('line', { x1: left, x2: left, y1: top, y2: bottom, class: 'pulse-chart-cursor', visibility: 'hidden' });
    const readout = card.createDiv({ cls: 'crisp-pulse-analytics-readout', text: tr('悬停或用方向键查看每日数值；点击可打开该日明细。', 'Hover or use the arrow keys to see daily values; click to open a day’s details.') });
    readout.setAttr('aria-live', 'polite');
    const description = point => {
      if (point.status === 'missing') return `${point.date} · ${tr('未记录', 'not recorded')}`;
      if (point.status === 'excluded') return `${point.date} · ${tr('已被当前数据范围排除', 'excluded by the current data scope')}`;
      const quality = point.legacy ? tr('旧版未校验', 'legacy, unverified') : point.quality === 'estimated' ? tr('历史估算', 'historical estimate') : point.quality === 'mixed' ? tr('含估算', 'partly estimated') : tr('实际记录', 'recorded');
      return `${point.date} · ${quality} · ` + config.series.map(s => `${s.label} ${point[s.key] === null ? tr('未记录', 'not recorded') : number(point[s.key]) + ' ' + config.unit}`).join(' · ');
    };
    const targets = [];
    points.forEach((point, index) => {
      const target = draw('rect', { x: left + index * width, y: top, width, height: bottom - top, class: 'pulse-chart-target', role: 'button', tabindex: index === points.length - 1 ? 0 : -1, 'aria-label': description(point) + tr('，打开日明细', ', open day details'), 'data-analytics-date': point.date });
      targets.push(target);
      const show = () => {
        marker.setAttribute('x1', x(index)); marker.setAttribute('x2', x(index)); marker.setAttribute('visibility', 'visible');
        readout.textContent = description(point);
      };
      target.addEventListener('pointerenter', show);
      target.addEventListener('focus', show);
      const open = () => this.openAnalyticsDay(point.date);
      target.addEventListener('click', () => this.activateDay(point.date, show));
      target.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); return; }
        const next = event.key === 'ArrowLeft' ? index - 1 : event.key === 'ArrowRight' ? index + 1 : event.key === 'Home' ? 0 : event.key === 'End' ? points.length - 1 : null;
        if (next === null) return;
        event.preventDefault();
        if (targets[next]) { target.setAttribute('tabindex', '-1'); targets[next].setAttribute('tabindex', '0'); targets[next].focus(); }
      });
    });
    const legend = card.createDiv({ cls: 'crisp-pulse-analytics-legend' });
    for (const series of config.series) {
      const item = legend.createSpan();
      item.createSpan({ cls: `pulse-chart-dot pulse-chart-fill-${series.color}` });
      item.createSpan({ text: series.label });
    }
  }

  // 需要激活的标签页在未激活时显示锁定说明。返回 true 表示已渲染锁定面板。
  renderGatedTab(parent, tab) {
    if (!["review", "analytics", "yearly"].includes(tab) || this.plugin?.isEntitled?.()) return false;
    const status = this.plugin?.licenseManager?.getStatus?.();
    const hasCode = !!this.plugin?.settings?.licenseCode;
    const panel = parent.createDiv({ cls: "crisp-pulse-locked" });
    panel.createEl("h3", { text: tr(`${PULSE_GATED_FEATURES[tab]}需要激活`, `${PULSE_GATED_FEATURES[tab]} requires activation`) });
    panel.createEl("p", { text: tr("看板视图、数据记录、备份与导出不受影响，数据仍在照常记录；激活后可以看到全部历史。", "The dashboard, data recording, backups and exports are unaffected, and data is still being recorded. Activate to see your full history.") });
    if (hasCode && status && status.reason) {
      panel.createEl("p", { cls: "crisp-pulse-locked-reason", text: tr(`当前授权码未通过：${status.reason}`, `The current license code was not accepted: ${status.reason}`) });
    }
    const button = panel.createEl("button", { cls: "mod-cta", text: tr("前往激活", "Activate") });
    button.addEventListener("click", () => this.plugin.openLicenseSettings());
    return true;
  }

  currentBannerMode() {
    return this.containerEl.ownerDocument.body.classList.contains("theme-dark") ? "night" : "day";
  }

  /* 页脚：和顶部天空呼应的像素地平线。山脊是最近一段时间每天的贡献分，最右边的小灯杆是今天；
     白天灯杆上挂小旗。未激活时只画地形，不读统计。 */
  renderFooter(container, { locked = false } = {}) {
    const footer = container.createDiv({ cls: "crisp-pulse-footer" });
    const info = footer.createDiv({ cls: "crisp-pulse-footer-info" });
    const brand = info.createDiv({ cls: "crisp-pulse-footer-brand" });
    setIcon(brand.createSpan({ cls: "crisp-pulse-footer-icon" }), CRISP_PULSE_ICON_ID);
    brand.createSpan({ cls: "crisp-pulse-footer-name", text: "Crisp Pulse" });
    if (this.plugin.manifest?.version) brand.createSpan({ cls: "crisp-pulse-footer-version", text: this.plugin.manifest.version });
    const caption = info.createDiv({ cls: "crisp-pulse-footer-caption" });
    const links = info.createDiv({ cls: "crisp-pulse-footer-links" });
    const link = (text, fn) => {
      const a = links.createEl("button", { cls: "crisp-pulse-footer-link", text, attr: { type: "button" } });
      a.addEventListener("click", fn);
    };
    link(tr("速记", "Memos"), () => this.plugin.activateMemoView());
    link(tr("设置", "Settings"), () => { const setting = this.app.setting; if (setting?.open) { setting.open(); setting.openTabById?.(this.plugin.manifest.id); } });
    const ground = footer.createDiv({ cls: "crisp-pulse-footer-ground" });
    const canvas = ground.createEl("canvas", { attr: { "aria-hidden": "true" } });
    const tip = ground.createDiv({ cls: "crisp-pulse-footer-tip", attr: { "aria-hidden": "true" } });
    this.footerEls = { footer, ground, canvas, tip, caption, locked };
    this.observeFooterSize(ground);
    this.paintFooter();
    if (locked) return;
    const hide = () => tip.removeClass("is-visible");
    ground.addEventListener("pointermove", (event) => {
      const d = this.footerData;
      if (!d?.dates?.length) return hide();
      const rect = ground.getBoundingClientRect();
      const col = (event.clientX - rect.left) / rect.width * d.width;
      const index = Math.max(0, Math.min(d.dates.length - 1, Math.floor(col / ((d.width - PULSE_GROUND_MARGIN) / d.dates.length))));
      const x = groundDayX(index, d.dates.length, d.width);
      const row = groundRidgeRow(d.height, d.profile[Math.min(d.width - 1, x)] || 0);
      const [, m, day] = d.dates[index].split("-").map(Number);
      const score = d.values[index];
      tip.setText(`${pulseMonthDay(m, day)} · ${score > 0 ? `${Number(score).toLocaleString(PULSE_NUMBER_LOCALE, { maximumFractionDigits: 1 })} ${tr("分", "pts")}` : tr("没有记录", "no records")}`);
      tip.addClass("is-visible");
      // 提示框以那一天为中心，但不伸出面板两侧
      const half = tip.offsetWidth / 2 + 6;
      tip.style.left = `${Math.max(half, Math.min(rect.width - half, x / d.width * rect.width))}px`;
      tip.style.top = `${row / d.height * 100}%`;
    });
    ground.addEventListener("pointerleave", hide);
  }

  /* 页脚画布按地面元素的实际尺寸画：宽度或高度变了（拖动面板、样式晚到、容器查询切换高度）只重画页脚，
     像素才保持方形。观察器第一次画页脚时创建，开始观察时会立即回调一次。 */
  observeFooterSize(ground) {
    const win = ground.ownerDocument?.defaultView;
    if (!win?.ResizeObserver) return;
    if (!this.footerResizeObserver) {
      this.footerResizeObserver = new win.ResizeObserver(() => {
        const current = this.footerEls?.ground;
        if (!current?.isConnected) return;
        const rect = current.getBoundingClientRect();
        if (Math.abs(rect.width - (this.footerPaintedWidth || 0)) < 4 && Math.abs(rect.height - (this.footerPaintedHeight || 0)) < 2) return;
        this.paintFooter();
      });
    }
    if (this.footerObservedGround) this.footerResizeObserver.unobserve(this.footerObservedGround);
    this.footerResizeObserver.observe(ground);
    this.footerObservedGround = ground;
  }

  paintFooter() {
    const els = this.footerEls;
    if (!els?.canvas.isConnected) return;
    const rect = els.ground.getBoundingClientRect();
    const cssWidth = rect.width || PULSE_SKY_WIDTH * PULSE_GROUND_SCALE;
    // 横竖都按同一个倍数放大，像素保持方形
    const width = Math.max(120, Math.ceil(cssWidth / PULSE_GROUND_SCALE));
    const height = Math.max(32, Math.round((rect.height || PULSE_GROUND_HEIGHT * PULSE_GROUND_SCALE) / PULSE_GROUND_SCALE));
    const today = getTodayKey();
    const todayNumber = reviewDayNumber(today);
    let dates = [], values = [];
    if (!els.locked) {
      // 和看板一样按当前数据范围取分；天数也从这个范围里最早的一条算起
      const daily = this.plugin.store?.daily || {};
      const inScope = (d) => !!daily[d] && this.plugin.recordMatchesScope(daily[d], d, this.currentScope);
      const scored = Object.keys(daily).filter((k) => k <= today && daily[k]?.contribution?.score > 0 && inScope(k)).sort();
      const n = groundDayCount(width, scored.length ? todayNumber - reviewDayNumber(scored[0]) : 0);
      dates = Array.from({ length: n }, (_, i) => reviewDayKey(todayNumber - (n - 1 - i)));
      values = dates.map((d) => (inScope(d) ? Number(daily[d].contribution?.score) || 0 : 0));
    }
    const profile = buildGroundProfile(values, width);
    this.footerMode = this.currentBannerMode();
    els.canvas.width = width;
    els.canvas.height = height;
    paintPulseGround(els.canvas, this.footerMode, profile, dates.length ? groundDayX(dates.length - 1, dates.length, width) : -1);
    this.footerData = { dates, values, profile, width, height };
    this.footerPaintedWidth = cssWidth;
    this.footerPaintedHeight = rect.height;
    let peak = -1;
    values.forEach((v, i) => { if (v > 0 && (peak < 0 || v > values[peak])) peak = i; });
    const caption = els.locked ? "" : peak < 0 ? tr("开始写作后，这里会长出你的贡献山脊", "Start writing and your contribution ridge will grow here")
      : tr(`山脊是最近 ${dates.length} 天的贡献 · 峰值 ${Number(dates[peak].slice(5, 7))}月${Number(dates[peak].slice(8))}日 · ${this.footerMode === "night" ? "小灯" : "小旗"}是今天`,
        `The ridge shows the last ${dates.length} days of contributions · peak ${pulseMonthDay(Number(dates[peak].slice(5, 7)), Number(dates[peak].slice(8)))} · the ${this.footerMode === "night" ? "lamp" : "flag"} is today`);
    els.caption.setText(caption);
  }

  // Banner above the header: the user's image, else a pixel sky (night in dark themes, daytime in light ones).
  // The bottom fades into the view background.
  renderBanner(parent) {
    const file = this.plugin.getBannerImageFile();
    this.bannerMode = file ? "image" : this.currentBannerMode();
    const banner = parent.createDiv({ cls: "crisp-pulse-banner", attr: { "aria-hidden": "true" } });
    if (file) {
      banner.createEl("img", { attr: { src: this.app.vault.getResourcePath(file), alt: "" } });
      return;
    }
    const canvas = banner.createEl("canvas", { attr: { width: PULSE_SKY_WIDTH, height: PULSE_SKY_HEIGHT } });
    canvas.getContext("2d").drawImage(getPulseSky(parent.ownerDocument, this.bannerMode), 0, 0);
  }

  renderHeader(parent) {
    const header = parent.createDiv({ cls: "crisp-pulse-header" });

    const titleGroup = header.createDiv({ cls: "crisp-pulse-title-group" });
    const icon = titleGroup.createDiv({ cls: "crisp-pulse-title-icon" });
    icon.innerHTML = ICON_BLOCKS_WAVE_SVG;
    titleGroup.createEl("h2", { cls: "crisp-pulse-title", text: tr("Crisp Pulse 知识脉冲看板", "Crisp Pulse Dashboard") });

    // View Switcher (Dashboard vs Retrospective)
    const viewSwitch = titleGroup.createDiv({ cls: "crisp-pulse-actions" });
    const dashBtn = viewSwitch.createEl("button", {
      cls: `crisp-pulse-tab-btn ${this.activeViewTab === "dashboard" ? "is-active" : ""}`,
      text: tr("看板视图", "Dashboard")
    });
    dashBtn.addEventListener("click", () => {
      this.activeViewTab = "dashboard";
      this.containerEl.children[1].scrollTop = 0;
      this.render();
    });

    const reviewBtn = viewSwitch.createEl("button", {
      cls: `crisp-pulse-tab-btn ${this.activeViewTab === "review" ? "is-active" : ""}`,
      text: tr("知识复盘", "Review")
    });
    reviewBtn.addEventListener("click", () => {
      this.activeViewTab = "review";
      this.containerEl.children[1].scrollTop = 0;
      this.render();
    });

    const analyticsButton = viewSwitch.createEl("button", {
      cls: `crisp-pulse-tab-btn ${this.activeViewTab === "analytics" ? "is-active" : ""}`,
      text: tr("数据分析", "Analytics")
    });
    analyticsButton.addEventListener("click", () => { this.activeViewTab = "analytics"; this.containerEl.children[1].scrollTop = 0; this.render(); });
    const yearlyButton = viewSwitch.createEl("button", {
      cls: `crisp-pulse-tab-btn ${this.activeViewTab === "yearly" ? "is-active" : ""}`,
      text: tr("年度画像", "Year Portrait")
    });
    yearlyButton.addEventListener("click", () => { this.activeViewTab = "yearly"; this.containerEl.children[1].scrollTop = 0; this.render(); });
    if (!this.plugin?.isEntitled?.()) {
      for (const button of [reviewBtn, analyticsButton, yearlyButton]) {
        button.classList.add("is-locked");
        button.setAttr("title", tr("需要激活", "Requires activation"));
      }
    }
    for (const [button, key] of [[dashBtn, "dashboard"], [reviewBtn, "review"], [analyticsButton, "analytics"], [yearlyButton, "yearly"]]) button.setAttr("aria-pressed", String(this.activeViewTab === key));

    const actions = header.createDiv({ cls: "crisp-pulse-actions" });

    // 1.2 Date Range Selector
    const rangeSelect = actions.createEl("select", { cls: "crisp-pulse-scope-select" });
    rangeSelect.createEl("option", { text: tr("时间: 近 53 周", "Time: last 53 weeks"), value: "year" });
    rangeSelect.createEl("option", { text: tr("时间: 最近 90 天", "Time: last 90 days"), value: "90d" });
    rangeSelect.createEl("option", { text: tr("时间: 最近 30 天", "Time: last 30 days"), value: "30d" });
    rangeSelect.createEl("option", { text: tr("时间: 最近 7 天", "Time: last 7 days"), value: "7d" });
    rangeSelect.createEl("option", { text: tr("时间: 本年 (YTD)", "Time: year to date"), value: "ytd" });
    rangeSelect.hidden = this.activeViewTab !== "dashboard";
    rangeSelect.value = this.currentDateRange;
    rangeSelect.addEventListener("change", () => {
      this.currentDateRange = rangeSelect.value;
      this.render();
    });

    // Scope Selector Dropdown
    const scopeSelect = actions.createEl("select", { cls: "crisp-pulse-scope-select" });
    scopeSelect.createEl("option", { text: tr("范围: 可靠记录", "Scope: reliable records"), value: "reliable" });
    scopeSelect.createEl("option", { text: tr("范围: 仅实测记录", "Scope: measured only"), value: "recorded_only" });
    scopeSelect.createEl("option", { text: tr("范围: 全部历史", "Scope: all history"), value: "all" });
    scopeSelect.value = this.currentScope;
    scopeSelect.addEventListener("change", () => {
      this.currentScope = scopeSelect.value;
      this.render();
    });

    // Export Button
    const exportBtn = actions.createEl("button", {
      cls: "crisp-pulse-tab-btn",
      text: tr("导出全量 CSV", "Export full CSV")
    });
    exportBtn.addEventListener("click", () => {
      this.plugin.exportCSVFile();
    });

    // Refresh Button
    const refreshBtn = actions.createEl("button", {
      cls: "crisp-pulse-tab-btn",
      text: tr("刷新", "Refresh")
    });
    refreshBtn.addEventListener("click", () => {
      this.plugin.refreshViews();
      new Notice(tr("Crisp Pulse: 数据已刷新", "Crisp Pulse: data refreshed"));
    });
  }

  // Dashboard cards: a soft tray holding icon, title, subtitle and a status pill, with content on an inset card.
  trayCard(parent, { icon, title, subtitle, pill, pillMuted = false, cls = '', insetCls = '', wrap = false }) {
    const tray = parent.createDiv({ cls: `pulse-v2-tray ${cls}`.trim() });
    const head = tray.createDiv({ cls: 'pulse-v2-tray-head' });
    const iconEl = head.createDiv({ cls: 'pulse-v2-tray-icon' });
    setIcon(iconEl, icon);
    const text = head.createDiv({ cls: 'pulse-v2-tray-text' });
    text.createDiv({ cls: 'pulse-v2-tray-title', text: title });
    if (subtitle) text.createDiv({ cls: `pulse-v2-tray-sub${wrap ? ' is-wrap' : ''}`, text: subtitle });
    if (pill) head.createDiv({ cls: `pulse-v2-pill${pillMuted ? ' is-muted' : ''}`, text: pill });
    return tray.createDiv({ cls: `pulse-v2-inset ${insetCls}`.trim() });
  }

  // Review sections share the dashboard tray; the inset keeps the old class so its inner styles still apply.
  reviewSection(parent, icon, title, note) {
    return this.trayCard(parent, { icon, title, subtitle: note, wrap: true, insetCls: 'crisp-pulse-review-section' });
  }

  renderDashboardV2(wrapper) {
    const stats = this.plugin.calcStats(this.currentScope, this.currentDateRange);
    const scopeLabel = REVIEW_SCOPE_LABELS[this.currentScope] || this.currentScope;
    const rangeLabel = PULSE_RANGE_LABELS[this.currentDateRange] || PULSE_RANGE_LABELS.year;
    const overview = this.trayCard(wrapper, { icon: 'activity', title: tr('知识脉冲概览', 'Pulse overview'), subtitle: `${rangeLabel} · ${scopeLabel}`, pill: stats.currentStreak > 0 ? tr(`连续 ${stats.currentStreak} 天`, `Streak: ${plural(stats.currentStreak, 'day')}`) : tr('今天还没开始', 'Not started today'), pillMuted: !(stats.currentStreak > 0) });
    const strip = overview.createDiv({ cls: 'pulse-v2-strip' });
    const cells = [
      { label: tr('累计贡献分', 'Total score'), val: Number(stats.totalScore || 0).toLocaleString(PULSE_NUMBER_LOCALE, { maximumFractionDigits: 1 }), unit: tr('分', 'pts') },
      { label: tr('活跃天数', 'Active days'), val: stats.activeDays, unit: tr('天', 'days') },
      { label: tr('当前连续', 'Current streak'), val: stats.currentStreak, unit: tr('天', 'days'), accent: stats.currentStreak > 0 },
      { label: tr('最长连续', 'Longest streak'), val: stats.longestStreak, unit: tr('天', 'days') },
      { label: tr('交互活跃', 'Active time'), val: stats.totalActiveHours || '0.0', unit: tr('小时', 'h') }
    ];
    if (Number(stats.totalFocusHours) > 0) cells.push({ label: tr('深度专注', 'Focus time'), val: stats.totalFocusHours, unit: tr('小时', 'h') });
    strip.style.setProperty('--pulse-v2-cols', String(cells.length));
    for (const cell of cells) {
      const el = strip.createDiv({ cls: `pulse-v2-stat${cell.accent ? ' is-accent' : ''}` });
      el.createDiv({ cls: 'pulse-v2-stat-label', text: cell.label });
      const value = el.createDiv({ cls: 'pulse-v2-stat-value' });
      value.createSpan({ text: String(cell.val) });
      value.createSpan({ cls: 'pulse-v2-stat-unit', text: cell.unit });
    }

    const metricLabel = this.getMetricLabel(this.selectedMetric);
    const heat = this.trayCard(wrapper, { icon: 'calendar-days', title: tr('年度知识活跃脉冲', 'Yearly activity'), subtitle: tr(`${metricLabel} · 强度按个人近期分位数`, `${metricLabel} · intensity by your recent percentiles`), pill: tr(`${stats.activeDays} 天活跃`, `${plural(stats.activeDays, 'active day')}`), pillMuted: true, cls: 'pulse-v2-heat' });
    const seg = heat.createDiv({ cls: 'pulse-v2-seg' });
    seg.setAttr('role', 'tablist');
    // 「番茄」只在装了带番茄钟的 Crisp Focus、或者已经有番茄记录时出现
    const hasPomodoro = !!this.pomodoroFocus() || Object.values(this.plugin.store.daily || {}).some((r) => dayPomodoros(r).done > 0);
    for (const m of [['contribution', tr('贡献分', 'Score')], ['activity', tr('交互活跃', 'Active')], ['focus', tr('深度专注', 'Focus')], ...(hasPomodoro ? [['pomodoro', tr('番茄', 'Pomodoros')]] : []), ['words', tr('新增字数', 'Words')], ['notes', tr('新建笔记', 'Notes')], ['tasks', tr('完成任务', 'Tasks')]]) {
      const b = seg.createEl('button', { text: m[1] });
      b.setAttr('role', 'tab');
      b.setAttr('aria-selected', String(this.selectedMetric === m[0]));
      b.addEventListener('click', () => { this.selectedMetric = m[0]; this.render(); });
    }
    this.renderHeatmapCard(heat);
    // 热力图是看板的主角放在上面；番茄是今天的行动入口，紧跟其后
    this.renderPomodoroCard(wrapper);

    const rec = this.plugin.store.daily[this.selectedDate] || createEmptyDailyRecord(this.selectedDate, 'none');
    const quality = rec.quality === 'recorded' ? tr('真实记录', 'Recorded') : rec.quality === 'estimated' ? tr('历史估算', 'Historical estimate') : rec.quality === 'mixed' ? tr('含估算', 'Partly estimated') : tr('无记录', 'No records');
    const { map } = this.plugin.calculateIntensities(this.selectedMetric, this.currentScope);
    const info = map.get(this.selectedDate) || { level: 0, percentile: 0 };
    const detail = this.trayCard(wrapper, { icon: 'file-text', title: tr(`${formatDateDisplay(this.selectedDate)} 明细`, `${formatDateDisplay(this.selectedDate)} details`), subtitle: `${quality}${info.level > 0 ? tr(` · 强度第 ${info.percentile}% 分位`, ` · ${info.percentile}th percentile`) : ''}`, pill: `${(rec.contribution?.score || 0).toFixed(1)} ${tr('分', 'pts')}`, pillMuted: !(rec.contribution?.score > 0), cls: 'pulse-v2-detail' });
    this.renderDayDetailCard(detail);
  }

  /** 装了带番茄钟的 Crisp Focus（1.5.0 起）才有的接口。 */
  pomodoroFocus() {
    const focus = this.plugin.focusAdapter?.getFocusPlugin?.();
    return focus && Number(focus.focusApiVersion) >= 1 && typeof focus.getPomodoroSnapshot === "function" ? focus : null;
  }

  /* 今天的番茄：像素番茄排成一行（完成 / 中断 / 离目标还差几个），右边是正在进行的阶段和按钮。
     计时在 Crisp Focus 里，这里只读状态、调它的接口。两边都需要激活。 */
  renderPomodoroCard(wrapper) {
    if (this.pomodoroTicker) { window.clearInterval(this.pomodoroTicker); this.pomodoroTicker = null; }
    const focus = this.pomodoroFocus();
    if (!focus || !this.plugin.settings.enableCrispFocusSync) return;
    const snap = focus.getPomodoroSnapshot();
    const today = dayPomodoros(this.plugin.store.daily[getTodayKey()]);
    const card = this.trayCard(wrapper, {
      icon: "timer", title: tr("今天的番茄", "Today’s pomodoros"), cls: "pulse-v2-pomodoro",
      subtitle: tr(`专注 ${snap.focusMinutes} 分钟 · 短休 ${snap.shortBreakMinutes} · 每 ${snap.every} 个长休 ${snap.longBreakMinutes}`, `Focus ${snap.focusMinutes} min · short break ${snap.shortBreakMinutes} · long break ${snap.longBreakMinutes} every ${snap.every}`),
      pill: `${today.done} / ${snap.goal}`, pillMuted: today.done === 0,
    });
    const locked = (title, text, action, run) => {
      const box = card.createDiv({ cls: "pulse-pomo-locked" });
      box.createDiv({ cls: "pulse-pomo-locked-title", text: title });
      box.createDiv({ cls: "crisp-pulse-review-note", text });
      const b = box.createEl("button", { cls: "mod-cta", text: action });
      b.addEventListener("click", run);
    };
    if (!this.plugin.isEntitled()) return locked(tr("番茄记录需要激活 Crisp Pulse", "Pomodoro records require activating Crisp Pulse"), tr("激活后在看板上查看每天的番茄、中断和专注时长。番茄照常记录。", "Activate to see daily pomodoros, interruptions and focus time on the dashboard. Pomodoros are still recorded."), tr("前往激活", "Activate"), () => this.plugin.openLicenseSettings());
    if (!snap.entitled) return locked(tr("番茄钟需要激活 Crisp Focus", "The pomodoro timer requires activating Crisp Focus"), tr("激活 Crisp Focus 后，在这里开始番茄、查看进度。", "Activate Crisp Focus to start pomodoros and track progress here."), tr("打开 Crisp Focus 设置", "Open Crisp Focus settings"), () => focus.openSettings?.());

    const body = card.createDiv({ cls: "pulse-pomo" });
    const row = body.createDiv({ cls: "pulse-pomo-row", attr: { role: "img", "aria-label": tr(`今天完成 ${today.done} 个番茄，中断 ${today.interrupted} 个，目标 ${snap.goal} 个`, `${today.done} pomodoros done today, ${today.interrupted} interrupted, goal ${snap.goal}`) } });
    const focusing = snap.kind === "focus" && snap.pomodoro && snap.status !== "idle";
    const slots = Math.min(24, Math.max(snap.goal, today.done + today.interrupted + (focusing ? 1 : 0)));
    let current = null;
    const progressOf = (x) => (x.plannedMs > 0 ? 1 - x.remainingMs / x.plannedMs : 0);
    for (let i = 0; i < slots; i++) {
      const index = i - today.done - today.interrupted;
      const state = i < today.done ? "done" : index < 0 ? "missed" : index === 0 && focusing ? "current" : "todo";
      const svg = pixelTomato(row, state, progressOf(snap));
      if (state === "current") current = svg;
    }
    const live = body.createDiv({ cls: "pulse-pomo-live" });
    const status = live.createDiv({ cls: "pulse-pomo-status" });
    const pill = status.createSpan({ cls: "pulse-pomo-pill" });
    const time = status.createSpan({ cls: "pulse-pomo-time" });
    const sub = status.createSpan({ cls: "pulse-pomo-sub" });
    const actions = live.createDiv({ cls: "pulse-pomo-actions" });
    const act = (label, run, primary = false) => {
      const b = actions.createEl("button", { cls: `pulse-pomo-btn${primary ? " is-primary" : ""}`, text: label });
      b.addEventListener("click", async () => {
        try { await run(); } catch (error) { new Notice(tr(`Crisp Pulse：${error.message || error}`, `Crisp Pulse: ${error.message || error}`)); }
        this.render();
      });
    };
    const running = snap.status !== "idle";
    const paused = snap.status === "paused";
    const tone = snap.kind === "break" ? "break" : "focus";
    live.dataset.tone = tone;
    live.toggleClass("is-paused", paused);
    if (snap.kind === "break" && running) {
      pill.setText(paused ? tr("休息暂停", "Break paused") : snap.phase === "long-break" ? tr("长休", "Long break") : tr("短休", "Short break"));
      if (paused) act(tr("继续", "Resume"), () => focus.resumeFocusSession(), true);
      act(tr("记一条", "Add a memo"), () => this.plugin.activateMemoView(), !paused);
      act(tr("跳过休息", "Skip break"), () => focus.skipPomodoroBreak());
    } else if (running) {
      pill.setText(paused ? tr("已暂停", "Paused") : snap.pomodoro ? tr(`专注 · 第 ${((snap.round - 1) % snap.every) + 1} / ${snap.every} 个`, `Focus · ${((snap.round - 1) % snap.every) + 1} of ${snap.every}`) : tr("单次专注", "Single session"));
      act(paused ? tr("继续", "Resume") : tr("暂停", "Pause"), () => (paused ? focus.resumeFocusSession() : focus.pauseFocusSession()), true);
      act(tr("结束", "End"), () => (snap.pomodoro ? focus.endPomodoro() : focus.stopFocusSession()));
    } else if (snap.waiting) {
      pill.setText(tr("休息结束", "Break over"));
      act(tr("开始下一个", "Start next"), () => focus.startNextPomodoro(), true);
      act(tr("结束本轮", "End this set"), () => focus.endPomodoro());
    } else {
      pill.setText(today.done ? tr("继续下一个", "Ready for the next") : tr("还没开始", "Not started"));
      act(tr("开始番茄", "Start pomodoro"), () => focus.startPomodoro(), true);
    }
    let filledRows = -1;
    const tick = () => {
      if (!time.isConnected) { window.clearInterval(this.pomodoroTicker); this.pomodoroTicker = null; return; }
      const now = focus.getPomodoroSnapshot();
      // 正在做的番茄每填满一行像素才重画一次
      const rows = Math.round(Math.max(0, Math.min(1, progressOf(now))) * 10);
      if (current?.isConnected && rows !== filledRows) {
        filledRows = rows;
        const next = pixelTomato(row, "current", progressOf(now));
        current.replaceWith(next);
        current = next;
      }
      const ms = now.status === "idle" ? now.focusMinutes * 60000 : now.remainingMs;
      const total = Math.max(0, Math.ceil(ms / 1000));
      time.setText(`${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`);
      if (now.status === "running") {
        const end = new Date(Date.now() + now.remainingMs);
        sub.setText(now.kind === "break" ? tr("离开屏幕，站起来走走", "Step away from the screen and move around") : tr(`${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")} 结束`, `ends at ${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}`));
      } else sub.setText(now.status === "paused" ? tr("暂停中", "Paused") : now.waiting ? tr("准备好就开始", "Start when you’re ready") : tr("点开始进入第一个番茄", "Press start for your first pomodoro"));
    };
    tick();
    if (running && !paused) this.pomodoroTicker = window.setInterval(tick, 1000);
    const foot = body.createDiv({ cls: "pulse-pomo-foot" });
    const minutes = (this.plugin.store.daily[getTodayKey()]?.activity?.focusSessions || []).filter((x) => x.pomodoro && x.completed).reduce((sum, x) => sum + x.minutes, 0);
    foot.createSpan({ text: minutes ? tr(`今天番茄专注 ${minutes} 分钟${today.interrupted ? ` · 中断 ${today.interrupted} 个（只记录，不计分）` : ""}`, `${minutes} min of pomodoro focus today${today.interrupted ? ` · ${today.interrupted} interrupted (logged, not scored)` : ""}`) : tr("完成的番茄计入专注时长和贡献分；中途结束的只记录，不计分", "Completed pomodoros count toward focus time and score; ones ended early are logged but not scored") });
    const open = foot.createEl("button", { cls: "pulse-pomo-link", text: tr("打开番茄钟", "Open pomodoro timer") });
    open.addEventListener("click", () => focus.openPomodoroModal?.());
  }

  renderHeatmapCard(parent) {
    const card = parent.createDiv({ cls: "crisp-pulse-heatmap-card" });

    const header = card.createDiv({ cls: "crisp-pulse-heatmap-header" });
    header.createDiv({
      cls: "crisp-pulse-heatmap-title",
      text: tr(`年度知识活跃脉冲 (${this.getMetricLabel(this.selectedMetric)})`, `Yearly activity (${this.getMetricLabel(this.selectedMetric)})`)
    });

    const stats = this.plugin.calcStats(this.currentScope, this.currentDateRange);
    if (stats.activeDays === 0 && this.currentScope === "reliable") {
      const notice = card.createDiv({ cls: "crisp-pulse-empty-notice" });
      notice.createSpan({ cls: "crisp-pulse-empty-notice-icon", text: "💡" });
      notice.createSpan({
        text: tr("当前筛选为「可靠记录」，已自动隔离旧版异常历史数据。您可以切换上方范围为「全部历史」查看过往脉冲，或在今日编辑笔记开始点亮全新打卡。", "The current filter is “Reliable records”, which sets aside abnormal legacy data. Switch the scope above to “All history” to see past activity, or edit a note today to start a fresh streak.")
      });
    }

    const scrollContainer = card.createDiv({ cls: "crisp-pulse-heatmap-scroll" });
    const gridWrap = scrollContainer.createDiv({ cls: "crisp-pulse-heatmap-grid-wrap" });

    const now = new Date();
    const todayStr = getTodayKey();
    const weekStartsOnMonday = this.plugin.settings.weekStartsOn === "monday";

    const dayOfWeek = now.getDay();
    const daysUntilEndOfWeek = weekStartsOnMonday ? (7 - (dayOfWeek || 7)) : (6 - dayOfWeek);
    const endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysUntilEndOfWeek);

    const candidates = Array.from({ length: 371 }, (_, index) =>
      dateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 370 + index)));
    const visibleDates = new Set(filterDatesByRange(candidates, this.currentDateRange, now));
    // The annual context stays stable when the statistical interval changes.
    const totalWeeks = 53;
    const startDate = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate() - 370);

    const { map: intensityMap } = this.plugin.calculateIntensities(this.selectedMetric, this.currentScope);

    const weeks = [];
    const monthLabels = [];
    let currentMonth = -1;

    let cursor = new Date(startDate);
    for (let w = 0; w < totalWeeks; w++) {
      const weekDays = [];
      for (let d = 0; d < 7; d++) {
        const y = cursor.getFullYear();
        const m = cursor.getMonth();
        const dt = cursor.getDate();
        const dKey = `${y}-${String(m + 1).padStart(2, "0")}-${String(dt).padStart(2, "0")}`;

        if (d === 0 && m !== currentMonth) {
          currentMonth = m;
          monthLabels.push({ weekIndex: w, monthName: pulseMonthLabel(m + 1) });
        }

        const isFuture = cursor > now;
        weekDays.push({
          dateKey: dKey,
          isFuture,
          isToday: dKey === todayStr
        });

        cursor.setDate(cursor.getDate() + 1);
      }
      weeks.push(weekDays);
    }

    const monthsRow = gridWrap.createDiv({ cls: "crisp-pulse-months-row" });
    for (const ml of monthLabels) {
      const lbl = monthsRow.createDiv({ cls: "crisp-pulse-month-label", text: ml.monthName });
      lbl.style.gridColumn = String(ml.weekIndex + 1);
    }

    const body = gridWrap.createDiv({ cls: "crisp-pulse-heatmap-body" });

    const weekdaysCol = body.createDiv({ cls: "crisp-pulse-weekdays-col" });
    if (weekStartsOnMonday) {
      weekdaysCol.createDiv({ text: tr("一", "Mon") });
      weekdaysCol.createDiv({ text: tr("三", "Wed") });
      weekdaysCol.createDiv({ text: tr("五", "Fri") });
      weekdaysCol.createDiv({ text: tr("日", "Sun") });
    } else {
      weekdaysCol.createDiv({ text: tr("日", "Sun") });
      weekdaysCol.createDiv({ text: tr("二", "Tue") });
      weekdaysCol.createDiv({ text: tr("四", "Thu") });
      weekdaysCol.createDiv({ text: tr("六", "Sat") });
    }

    const weeksGrid = body.createDiv({ cls: "crisp-pulse-weeks-grid" });

    for (let w = 0; w < weeks.length; w++) {
      const week = weeks[w];
      const colEl = weeksGrid.createDiv({ cls: "crisp-pulse-week-col" });
      for (let d = 0; d < week.length; d++) {
        const day = week[d];
        const cell = colEl.createDiv({ cls: "crisp-pulse-cell" });

        if (day.isFuture) {
          cell.style.visibility = "hidden";
          continue;
        }

        const info = intensityMap.get(day.dateKey) || { level: 0, value: 0, percentile: 0 };
        const record = this.plugin.store.daily[day.dateKey];
        const isEstimated = record && record.quality === "estimated";

        cell.dataset.level = String(info.level);
        const inRange = visibleDates.has(day.dateKey);
        cell.dataset.inRange = String(inRange);
        if (!inRange) cell.classList.add("is-outside-range");
        if (isEstimated) cell.classList.add("is-estimated");
        if (day.isToday) cell.classList.add("is-today");
        if (day.dateKey === this.selectedDate) cell.classList.add("is-selected");

        cell.tabIndex = day.dateKey === this.selectedDate ? 0 : -1;
        cell.setAttr("role", "button");
        cell.dataset.date = day.dateKey;
        cell.dataset.week = String(w);
        cell.dataset.day = String(d);

        const tooltip = `${formatDateDisplay(day.dateKey)}${inRange ? "" : tr("（统计区间外，仅供参考）", " (outside the selected range, for reference)")}\n${this.getMetricLabel(this.selectedMetric)}: ${formatPulseMinutes(info.value)} ${info.level > 0 ? tr(`(${info.percentile}分位)`, `(${info.percentile}th percentile)`) : ""}${isEstimated ? tr(" [估算数据]", " [estimated]") : ""}`;
        cell.setAttr("aria-label", tooltip);

        const selectCell = () => {
          this.selectedDate = day.dateKey;
          this.render();
          const target = this.containerEl.children[1].querySelector(`[data-date="${day.dateKey}"]`);
          if (target) target.focus({ preventScroll: true });
        };

        cell.addEventListener("click", selectCell);
        cell.addEventListener("keydown", (event) => {
          let targetWeek = w;
          let targetDay = d;
          if (event.key === "ArrowLeft") { targetWeek--; event.preventDefault(); }
          else if (event.key === "ArrowRight") { targetWeek++; event.preventDefault(); }
          else if (event.key === "ArrowUp") { targetDay--; event.preventDefault(); }
          else if (event.key === "ArrowDown") { targetDay++; event.preventDefault(); }
          else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectCell(); return; }
          else { return; }

          const nextEl = gridWrap.querySelector(`[data-week="${targetWeek}"][data-day="${targetDay}"]`);
          if (nextEl && nextEl.style.visibility !== "hidden") {
            cell.tabIndex = -1;
            nextEl.tabIndex = 0;
            nextEl.focus();
          }
        });
      }
    }

    const footer = card.createDiv({ cls: "crisp-pulse-heatmap-footer" });
    const rangeLabel = PULSE_RANGE_LABELS[this.currentDateRange] || PULSE_RANGE_LABELS.year;
    footer.createDiv({ text: tr(`完整 53 周 · 统计：${rangeLabel} · 区间外淡化 · 范围: ${REVIEW_SCOPE_LABELS[this.currentScope] || REVIEW_SCOPE_LABELS.all} · 强度基于个人近期分位数`, `Full 53 weeks · stats: ${rangeLabel} · days outside are faded · scope: ${REVIEW_SCOPE_LABELS[this.currentScope] || REVIEW_SCOPE_LABELS.all} · intensity by your recent percentiles`) });

    const legend = footer.createDiv({ cls: "crisp-pulse-legend" });
    legend.createSpan({ text: tr("少 ", "Less ") });
    for (let l = 0; l <= 5; l++) {
      const legCell = legend.createDiv({ cls: "crisp-pulse-legend-cell crisp-pulse-cell" });
      legCell.dataset.level = String(l);
    }
    legend.createSpan({ text: tr(" 多", " More") });
  }

  renderDayDetailCard(parent) {
    const card = parent.createDiv({ cls: "crisp-pulse-detail-card" });
    const rec = this.plugin.store.daily[this.selectedDate] || createEmptyDailyRecord(this.selectedDate, "none");
    const isRecorded = rec.quality === "recorded";
    const isEstimated = rec.quality === "estimated";

    const { map } = this.plugin.calculateIntensities(this.selectedMetric, this.currentScope);
    const info = map.get(this.selectedDate) || { level: 0, value: 0, percentile: 0 };

    const header = card.createDiv({ cls: "crisp-pulse-detail-header" });
    header.createDiv({ cls: "crisp-pulse-detail-date", text: tr(`${formatDateDisplay(this.selectedDate)} 明细`, `${formatDateDisplay(this.selectedDate)} details`) });

    const badges = header.createDiv({ cls: "crisp-pulse-detail-badges" });
    if (isRecorded) {
      badges.createDiv({ cls: "crisp-pulse-badge crisp-pulse-badge-recorded", text: tr("真实记录 (Recorded)", "Recorded") });
    } else if (isEstimated) {
      badges.createDiv({ cls: "crisp-pulse-badge crisp-pulse-badge-estimated", text: tr("历史估算 (Estimated)", "Estimated") });
    } else if (rec.quality === "mixed") {
      badges.createDiv({ cls: "crisp-pulse-badge crisp-pulse-badge-estimated", text: tr("含估算 (Mixed)", "Mixed") });
    }
    if (rec.legacyUnverified) {
      badges.createDiv({ cls: "crisp-pulse-badge", text: tr("旧版未校验", "Legacy, unverified") });
    }
    if (info.level > 0) {
      badges.createDiv({
        cls: "crisp-pulse-badge crisp-pulse-badge-intensity",
        text: tr(`强度: 第 ${info.percentile}% 分位 (Level ${info.level})`, `Intensity: ${info.percentile}th percentile (Level ${info.level})`)
      });
    }

    const statsGrid = card.createDiv({ cls: "crisp-pulse-stats-grid" });

    const breakdown = getScoreBreakdown(rec, this.plugin.settings);

    const scoreBox = statsGrid.createDiv({ cls: "crisp-pulse-stat-box crisp-pulse-score-clickable" });
    scoreBox.setAttr("role", "button");
    scoreBox.tabIndex = 0;
    scoreBox.setAttr("aria-label", tr("贡献得分，展开或收起计分明细", "Contribution score; expand or collapse the breakdown"));
    scoreBox.setAttr("aria-expanded", String(this.showBreakdown));
    scoreBox.createDiv({ cls: "crisp-pulse-stat-label", text: tr("贡献得分", "Contribution score") });
    const scoreValue = scoreBox.createDiv({ cls: "crisp-pulse-stat-value" });
    scoreValue.createSpan({ text: (rec.contribution.score || 0).toFixed(1) });
    scoreValue.createSpan({ cls: "crisp-pulse-stat-unit", text: tr("分", "pts") });
    const toggleBreakdown = () => {
      this.showBreakdown = !this.showBreakdown;
      this.render();
      this.containerEl.querySelector(".crisp-pulse-score-clickable")?.focus({ preventScroll: true });
    };
    scoreBox.addEventListener("click", toggleBreakdown);
    scoreBox.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggleBreakdown(); }
    });

    const count = value => Number(value || 0).toLocaleString(PULSE_NUMBER_LOCALE);
    const statItems = [
      { label: tr("新增词数", "Words added"), val: `+${count(rec.contribution.wordsAdded)}`, unit: tr("词", "words") },
      { label: tr("深度改写/润色", "Rewrites/polishing"), val: `+${count(rec.contribution.rewrittenWords)}`, unit: tr("词", "words") },
      { label: tr("新建笔记", "Notes created"), val: count(rec.contribution.notesCreated), unit: tr("篇", "notes") },
      { label: tr("有效编辑会话", "Meaningful edit sessions"), val: count(rec.contribution.meaningfulEdits), unit: tr("次", "sessions") },
      { label: tr("完成任务", "Tasks completed"), val: count(rec.contribution.tasksCompleted), unit: tr("项", "tasks") },
      { label: tr("新建内链", "Links created"), val: count(rec.contribution.linksCreated), unit: tr("条", "links") },
      { label: tr("交互活跃时长", "Active time"), val: formatPulseMinutes(rec.activity.activeMinutes), unit: tr("分钟", "min") }
    ];

    if (this.plugin.settings.includeFocusInContribution || (rec.activity?.focusMinutes > 0)) {
      statItems.push({ label: tr("深度专注时长", "Focus time"), val: formatPulseMinutes(rec.activity?.focusMinutes), unit: tr("分钟", "min") });
    }

    for (const item of statItems) {
      const box = statsGrid.createDiv({ cls: "crisp-pulse-stat-box" });
      box.createDiv({ cls: "crisp-pulse-stat-label", text: item.label });
      const value = box.createDiv({ cls: "crisp-pulse-stat-value" });
      value.createSpan({ text: item.val });
      value.createSpan({ cls: "crisp-pulse-stat-unit", text: item.unit });
    }
    // Two even rows (4+4 or 5+4) instead of leaving one box alone on a third row.
    const columns = Math.ceil(statsGrid.children.length / 2);
    statsGrid.style.setProperty("--pulse-detail-cols", String(columns));
    [...statsGrid.children].forEach((box, index) => box.toggleClass("is-row-start", index % columns === 0));

    // Score Breakdown Drawer
    if (this.showBreakdown) {
      const bCard = card.createDiv({ cls: "crisp-pulse-breakdown-card" });
      const bTitle = bCard.createDiv({ cls: "crisp-pulse-breakdown-title" });
      const bTitleLeft = bTitle.createSpan({ cls: "crisp-pulse-breakdown-title-left" });
      const bIcon = bTitleLeft.createSpan({ cls: "crisp-pulse-breakdown-icon-wrap" });
      bIcon.innerHTML = ICON_COMPUTER_SVG;
      bTitleLeft.createSpan({ text: tr("贡献得分构成拆解", "Score breakdown") });
      bTitle.createSpan({ text: tr("分项相加严格等于总分", "The items add up exactly to the total"), cls: "crisp-pulse-kpi-sub" });

      const list = bCard.createDiv({ cls: "crisp-pulse-breakdown-list" });

      const rows = [
        { label: tr("新建笔记", "Notes created"), formula: tr(`${rec.contribution.notesCreated || 0} 篇 × ${this.plugin.settings.weightNoteCreated}分`, `${rec.contribution.notesCreated || 0} × ${this.plugin.settings.weightNoteCreated} pts`), val: `+${breakdown.notesCreatedScore.toFixed(1)}` },
        { label: tr("有效编辑会话", "Meaningful edit sessions"), formula: tr(`${rec.contribution.meaningfulEdits || 0} 次 × ${this.plugin.settings.weightMeaningfulEdit}分`, `${rec.contribution.meaningfulEdits || 0} × ${this.plugin.settings.weightMeaningfulEdit} pts`), val: `+${breakdown.meaningfulEditsScore.toFixed(1)}` },
        { label: tr("完成任务", "Tasks completed"), formula: tr(`${rec.contribution.tasksCompleted || 0} 项 × ${this.plugin.settings.weightTaskCompleted}分`, `${rec.contribution.tasksCompleted || 0} × ${this.plugin.settings.weightTaskCompleted} pts`), val: `+${breakdown.tasksCompletedScore.toFixed(1)}` },
        { label: tr("新建内链", "Links created"), formula: tr(`${rec.contribution.linksCreated || 0} 条 × ${this.plugin.settings.weightLinkCreated}分`, `${rec.contribution.linksCreated || 0} × ${this.plugin.settings.weightLinkCreated} pts`), val: `+${breakdown.linksCreatedScore.toFixed(1)}` },
        { label: tr("字数贡献 (边际递减)", "Words (diminishing returns)"), formula: tr(`非捕获新增 ${Math.max(0, (rec.contribution.wordsAdded||0)-(rec.contribution.captureWords||0))} 词 + 改写 ${rec.contribution.rewrittenWords||0} 词`, `${Math.max(0, (rec.contribution.wordsAdded||0)-(rec.contribution.captureWords||0))} words added (excl. captures) + ${rec.contribution.rewrittenWords||0} rewritten`), val: `+${breakdown.wordsTotalScore.toFixed(1)}` }
      ];

      if (this.plugin.settings.includeFocusInContribution) {
        rows.push({
          label: tr("深度专注加分", "Focus bonus"),
          formula: tr(`${Math.round(rec.activity?.focusMinutes || 0)} 分钟（计分取整） × ${this.plugin.settings.weightFocusMinute}分`, `${Math.round(rec.activity?.focusMinutes || 0)} min (rounded) × ${this.plugin.settings.weightFocusMinute} pts`),
          val: `+${breakdown.focusScore.toFixed(1)}`
        });
      }

      rows.push({
        label: tr("总计贡献分", "Total score"),
        formula: tr("公式求和", "Sum of the above"),
        val: `${breakdown.totalScore.toFixed(1)} ${tr("分", "pts")}`
      });

      for (const r of rows) {
        const rowEl = list.createDiv({ cls: "crisp-pulse-breakdown-row" });
        const left = rowEl.createSpan();
        left.createSpan({ text: r.label, cls: "crisp-pulse-breakdown-label" });
        left.createSpan({ text: ` (${r.formula})`, cls: "crisp-pulse-breakdown-formula" });
        rowEl.createSpan({ text: r.val, cls: "crisp-pulse-breakdown-val" });
      }
    }

    // Associated Files List
    const fileWrap = card.createDiv({ cls: "crisp-pulse-file-list-wrap" });
    fileWrap.createDiv({ cls: "crisp-pulse-file-list-title", text: tr("当日有贡献的笔记文件", "Notes that contributed this day") });

    const fileList = fileWrap.createDiv({ cls: "crisp-pulse-file-list" });
    const fileKeys = Object.keys(rec.files || {});

    if (fileKeys.length === 0) {
      fileList.createDiv({ cls: "crisp-pulse-empty-files", text: tr("该日期无文件变更记录。", "No file changes recorded on this date.") });
    } else {
      for (const fp of fileKeys) {
        const fInfo = rec.files[fp] || {};
        const item = fileList.createEl("button", { cls: "crisp-pulse-file-item" });
        item.type = "button";

        const nameSpan = item.createSpan({ cls: "crisp-pulse-file-name", text: fp });
        const metaSpan = item.createSpan({ cls: "crisp-pulse-file-meta" });
        // 以前的记录里，笔记后来被删了：记录保留，但不再像能点开的链接
        const deleted = !(this.app.vault.getAbstractFileByPath(fp) instanceof TFile);
        if (deleted) {
          item.addClass("is-deleted");
          item.setAttr("aria-label", tr(`${fp}（已删除）`, `${fp} (deleted)`));
        }

        const parts = deleted ? [tr("已删除", "deleted")] : [];
        if (fInfo.created) parts.push(tr("新建", "new"));
        if (fInfo.wordsAdded > 0) parts.push(tr(`+${fInfo.wordsAdded}词`, `+${fInfo.wordsAdded} words`));
        if (fInfo.rewrittenWords > 0) parts.push(tr(`改写${fInfo.rewrittenWords}词`, `${fInfo.rewrittenWords} rewritten`));
        if (fInfo.tasks > 0) parts.push(tr(`${fInfo.tasks}任务`, plural(fInfo.tasks, "task")));
        if (fInfo.links > 0) parts.push(tr(`${fInfo.links}内链`, plural(fInfo.links, "link")));
        metaSpan.textContent = parts.join(" · ") || tr("已编辑", "edited");

        item.addEventListener("click", () => {
          if (deleted) return;
          this.app.workspace.openLinkText(fp, "");
        });
      }
    }
  }

  // --- Knowledge review: period → clues → materials and charts on one side, the review itself on the other ---
  renderRetrospectivePanel(parent) {
    if (!this.reviewStart || !this.reviewEnd) {
      // 默认最近一个完整自然周：边界固定，同一周里哪天打开都是同一份草稿。
      const week = reviewWeekRange(getTodayKey(), this.plugin.settings.weekStartsOn, -1);
      this.reviewStart = week.start; this.reviewEnd = week.end;
    }
    const model = this.plugin.getReviewModel(this.reviewStart, this.reviewEnd, this.currentScope);
    const token = this.reviewMemoToken = {};
    const memoSummary = this.plugin.getReviewMemoSummary(model.period.start, model.period.end);
    const live = el => token === this.reviewMemoToken && el.isConnected;
    const workspace = parent.createDiv({ cls: 'crisp-pulse-review-workspace' });
    this.renderReviewPeriod(workspace, model);
    this.renderReviewClues(workspace, model, memoSummary, live);
    const grid = workspace.createDiv({ cls: 'crisp-pulse-review-grid' });
    const main = grid.createDiv({ cls: 'crisp-pulse-review-main' });
    const side = grid.createDiv({ cls: 'crisp-pulse-review-side' });
    this.renderReviewChanges(main, model);
    this.renderReviewMaterials(main, model);
    this.renderReviewMemos(main, model, memoSummary, live);
    this.renderReviewSources(main, model);
    this.renderReviewNotebook(side, model);
  }

  applyReviewPeriod(start, end) {
    try {
      getReviewPeriod(start, end);
      this.reviewStart = start; this.reviewEnd = end;
      this.reviewRangeInputs = { start, end };
      this.reviewFileLimit = 20; this.reviewShowAllFiles = false;
      this.render();
    } catch (error) { new Notice(error.message); }
  }

  scrollReviewTo(selector, focus = false) {
    const target = this.containerEl.querySelector(selector);
    if (!target) return;
    target.scrollIntoView({ block: focus ? 'center' : 'start', behavior: 'smooth' });
    if (focus) target.focus({ preventScroll: true });
  }

  renderReviewPeriod(parent, model) {
    const { start, end, days } = model.period;
    const today = getTodayKey();
    const weekStartsOn = this.plugin.settings.weekStartsOn;
    const written = reviewDraftSize(model);
    const card = this.trayCard(parent, { icon: 'notebook-pen', title: tr('知识复盘', 'Knowledge review'), subtitle: tr('从线索找到材料，写下认识和下一步。草稿按周期保存，下次打开还在。', 'Follow a clue to the material, then write down what you learned and what comes next. Drafts are saved per period and are there next time.'), wrap: true, pill: written ? tr(`已写 ${written} 项`, `${plural(written, 'item')} written`) : tr('还没开始', 'Not started'), pillMuted: !written, insetCls: 'crisp-pulse-review-period' });
    const bar = card.createDiv({ cls: 'crisp-pulse-review-period-bar' });

    // 自然周用整周翻页（本周进行中时，往前翻得到完整的上一周）；其他区间按等长平移。
    const week = reviewWeekRange(start, weekStartsOn, 0);
    const isWeek = week.start === start && (days === 7 || end === today);
    const prevRange = isWeek ? reviewWeekRange(start, weekStartsOn, -1) : { start: model.period.previousStart, end: model.period.previousEnd };
    const nextRange = isWeek ? (reviewDayNumber(start) + 7 <= reviewDayNumber(today) ? reviewWeekRange(reviewDayKey(reviewDayNumber(start) + 7), weekStartsOn, 0) : null)
      : (reviewDayNumber(end) + days <= reviewDayNumber(today) ? { start: reviewDayKey(reviewDayNumber(end) + 1), end: reviewDayKey(reviewDayNumber(end) + days) } : null);
    const nav = bar.createDiv({ cls: 'crisp-pulse-review-period-nav' });
    const arrow = (icon, label, range) => {
      const button = nav.createEl('button', { cls: 'crisp-pulse-review-icon-btn', attr: { type: 'button', 'aria-label': label, title: label } });
      setIcon(button, icon);
      button.disabled = !range;
      button.addEventListener('click', () => { if (range) this.applyReviewPeriod(range.start, range.end); });
    };
    arrow('chevron-left', tr('前一个周期', 'Previous period'), prevRange);
    const label = nav.createDiv({ cls: 'crisp-pulse-review-period-label' });
    const short = key => (start.slice(0, 4) !== end.slice(0, 4) || start.slice(0, 4) !== today.slice(0, 4) ? key : key.slice(5)).replace(/-/g, '.');
    label.createDiv({ cls: 'crisp-pulse-review-period-range', text: start === end ? short(start) : `${short(start)} — ${short(end)}` });
    const coverage = model.current.coverage;
    const facts = [REVIEW_SCOPE_LABELS[model.scope], tr(`${coverage.recorded}/${days} 天有记录`, `${coverage.recorded}/${days} days recorded`)];
    if (coverage.missing) facts.push(tr(`未记录 ${coverage.missing} 天`, `${coverage.missing} not recorded`));
    if (coverage.filtered) facts.push(tr(`筛除 ${coverage.filtered} 天`, `${coverage.filtered} filtered out`));
    if (end === today) facts.push(tr('今天还没结束', 'today is not over'));
    label.createDiv({ cls: 'crisp-pulse-review-note', text: facts.join(' · ') });
    arrow('chevron-right', tr('后一个周期', 'Next period'), nextRange);

    const tools = bar.createDiv({ cls: 'crisp-pulse-review-period-tools' });
    const seg = tools.createDiv({ cls: 'pulse-v2-seg crisp-pulse-review-presets' });
    seg.setAttr('role', 'tablist');
    const presets = [
      [tr('上周', 'Last week'), reviewWeekRange(today, weekStartsOn, -1)],
      [tr('本周', 'This week'), reviewWeekRange(today, weekStartsOn, 0)],
      [tr('近 30 天', '30 days'), { start: reviewDayKey(reviewDayNumber(today) - 29), end: today }],
      [tr('近 90 天', '90 days'), { start: reviewDayKey(reviewDayNumber(today) - 89), end: today }]
    ];
    for (const [text, range] of presets) {
      const button = seg.createEl('button', { text, attr: { type: 'button', role: 'tab' } });
      button.setAttr('aria-selected', String(range.start === start && range.end === end));
      button.addEventListener('click', () => this.applyReviewPeriod(range.start, range.end));
    }

    // 写过东西的同范围草稿都列出来，换了日期也能找回。
    const history = Object.entries(this.plugin.store.reviewDrafts || {}).map(([key, draft]) => {
      const [a, b, scope] = key.split(':');
      if (scope !== model.scope || !draft || typeof draft !== 'object') return null;
      const size = Object.keys(REVIEW_DRAFT_FIELDS).filter(field => typeof draft[field] === 'string' && draft[field].trim()).length + (Array.isArray(draft.actions) ? draft.actions.length : 0) + (Array.isArray(draft.evidence) ? draft.evidence.length : 0);
      return size ? { a, b, size } : null;
    }).filter(Boolean).sort((x, y) => y.a.localeCompare(x.a) || y.b.localeCompare(x.b));
    if (history.length) {
      const select = tools.createEl('select', { cls: 'crisp-pulse-scope-select crisp-pulse-review-history' });
      select.setAttr('aria-label', tr('历史复盘', 'Past reviews'));
      select.createEl('option', { text: tr(`历史复盘 · ${history.length}`, `Past reviews · ${history.length}`), value: '' });
      for (const item of history) select.createEl('option', { text: tr(`${item.a} — ${item.b} · ${item.size} 项`, `${item.a} — ${item.b} · ${plural(item.size, 'item')}`), value: `${item.a}:${item.b}` });
      select.value = history.some(item => item.a === start && item.b === end) ? `${start}:${end}` : '';
      select.addEventListener('change', () => { if (select.value) { const [a, b] = select.value.split(':'); this.applyReviewPeriod(a, b); } });
    }

    const custom = card.createEl('details', { cls: 'crisp-pulse-review-custom' });
    custom.createEl('summary', { text: tr('自定义日期', 'Custom dates') });
    const controls = custom.createDiv({ cls: 'crisp-pulse-review-controls' });
    const pending = this.reviewRangeInputs || { start, end };
    for (const [field, text] of [['start', tr('开始日期', 'Start date')], ['end', tr('结束日期', 'End date')]]) {
      const wrap = controls.createEl('label', { text });
      const input = wrap.createEl('input', { type: 'date' });
      input.value = pending[field]; input.max = today; input.setAttr('aria-label', text);
      input.dataset.reviewField = `period-${field}`;
      input.addEventListener('input', () => { this.reviewRangeInputs = { ...(this.reviewRangeInputs || { start, end }), [field]: input.value }; });
    }
    const apply = controls.createEl('button', { cls: 'crisp-pulse-tab-btn', text: tr('应用日期', 'Apply dates') });
    apply.addEventListener('click', () => { const range = this.reviewRangeInputs || { start, end }; this.applyReviewPeriod(range.start, range.end); });
  }

  renderReviewClues(parent, model, memoSummary, live) {
    const card = this.trayCard(parent, { icon: 'lightbulb', title: tr('值得回看的线索', 'Worth a second look'), subtitle: tr('从本期记录里挑出最多三条，每条都能点进原始内容。只是线索，判断留给你。', 'Up to three picks from this period’s records, each linking to the original material. They are pointers; the judgement is yours.'), wrap: true, insetCls: 'crisp-pulse-review-clue-inset' });
    const row = card.createDiv({ cls: 'crisp-pulse-review-clues' });
    const { start, end } = model.period;
    const carry = this.plugin.previousActionCandidates(start, end, model.scope).length;
    const draw = memos => {
      row.empty?.();
      const clues = getReviewClues(model, { memos, carry });
      if (!clues.length) row.createDiv({ cls: 'crisp-pulse-review-note', text: tr('这一期没有特别突出的记录，可以直接看下面的材料，或写下这期的认识。', 'Nothing in particular stands out this period; browse the material below or write down what you learned.') });
      for (const clue of clues) {
        const item = row.createDiv({ cls: 'crisp-pulse-review-clue' });
        item.createSpan({ cls: `crisp-pulse-review-clue-mark pulse-chart-fill-${clue.color}` });
        item.createDiv({ cls: 'crisp-pulse-review-clue-title', text: clue.title });
        item.createDiv({ cls: 'crisp-pulse-review-clue-detail', text: clue.detail });
        if (!clue.action) continue;
        const go = item.createEl('button', { cls: 'crisp-pulse-review-clue-go', text: `${clue.action.label} →`, attr: { type: 'button' } });
        go.addEventListener('click', () => {
          const { kind } = clue.action;
          if (kind === 'open') this.openReviewNote(clue.action.path);
          else if (kind === 'memos') this.scrollReviewTo('.crisp-pulse-review-memo-card');
          else if (kind === 'write') this.scrollReviewTo('textarea[data-review-field="learning"]', true);
          else if (kind === 'materials') { this.reviewMaterialMode = clue.action.mode; this.render(); this.scrollReviewTo('.crisp-pulse-review-materials'); }
          else if (kind === 'carry') {
            const count = this.plugin.importPreviousActions(start, end, model.scope);
            new Notice(count ? tr(`已带入 ${count} 项行动。`, `Carried over ${plural(count, 'action')}.`) : tr('没有新的未完成行动可带入。', 'No new unfinished actions to carry over.'));
            this.render();
          }
        });
      }
    };
    draw(null);
    void memoSummary.then(memos => { if (live(row) && memos.pending?.length) draw(memos); });
  }

  renderReviewChanges(parent, model) {
    const { period, previous } = model;
    const section = this.reviewSection(parent, 'git-compare', tr('和上一期比', 'Compared with last period'), tr(`上一期 ${period.previousStart} — ${period.previousEnd}，${previous.coverage.recorded}/${period.days} 天有记录。每项按自己的尺度画；点词数、笔记、任务，下面的材料会按它排序。`, `Last period ${period.previousStart} — ${period.previousEnd}, ${previous.coverage.recorded}/${period.days} days recorded. Each bar pair uses its own scale; click words, notes or tasks to sort the materials below by it.`));
    const colors = { wordsAdded: 'purple', rewrittenWords: 'green', notesCreated: 'rose', tasksCompleted: 'teal', focusMinutes: 'orange', totalScore: 'blue' };
    const modes = { wordsAdded: 'words', rewrittenWords: 'rewrittenWords', notesCreated: 'created', tasksCompleted: 'tasks' };
    const order = ['wordsAdded', 'rewrittenWords', 'notesCreated', 'tasksCompleted', 'focusMinutes', 'totalScore'];
    const list = section.createDiv({ cls: 'crisp-pulse-review-changes' });
    const usable = model.current.coverage.recorded && previous.coverage.recorded;
    for (const key of order) {
      const row = model.comparison.find(item => item.key === key);
      if (!row) continue;
      const mode = modes[key];
      const item = list.createEl(mode ? 'button' : 'div', { cls: 'crisp-pulse-review-change', attr: mode ? { type: 'button' } : {} });
      item.createDiv({ cls: 'crisp-pulse-review-change-name', text: row.label });
      const bars = item.createDiv({ cls: 'crisp-pulse-review-change-bars' });
      const max = Math.max(row.current, row.previous, 0);
      for (const [value, cls] of [[row.current, `pulse-chart-fill-${colors[key]}`], [row.previous, 'is-previous']]) {
        const track = bars.createDiv({ cls: 'crisp-pulse-review-change-track' });
        const fill = track.createDiv({ cls: `crisp-pulse-review-change-fill ${cls}` });
        fill.style.width = max > 0 && value > 0 ? `${Math.max(1.5, value / max * 100)}%` : '0';
      }
      const figures = item.createDiv({ cls: 'crisp-pulse-review-change-figures' });
      figures.createSpan({ cls: 'crisp-pulse-review-change-value', text: `${formatPulseMinutes(row.current)} ${row.unit}` });
      const delta = row.current - row.previous;
      const sign = delta > 0 ? '+' : delta < 0 ? '−' : '±';
      const deltaText = !usable ? row.changeLabel : row.previous > 0 ? `${sign}${formatPulseMinutes(Math.abs(delta))} · ${row.changeLabel}` : `${sign}${formatPulseMinutes(Math.abs(delta))}`;
      figures.createSpan({ cls: `crisp-pulse-review-change-delta${usable && delta > 0 ? ' is-up' : usable && delta < 0 ? ' is-down' : ''}`, text: deltaText });
      figures.createSpan({ cls: 'crisp-pulse-review-change-prev', text: tr(`上期 ${formatPulseMinutes(row.previous)}`, `last ${formatPulseMinutes(row.previous)}`) });
      item.setAttr('aria-label', tr(`${row.label}：本期 ${formatPulseMinutes(row.current)} ${row.unit}，上期 ${formatPulseMinutes(row.previous)} ${row.unit}，${row.changeLabel}`, `${row.label}: ${formatPulseMinutes(row.current)} ${row.unit} now, ${formatPulseMinutes(row.previous)} ${row.unit} last period, ${row.changeLabel}`));
      if (mode) item.addEventListener('click', () => { this.reviewMaterialMode = mode; this.reviewShowAllFiles = false; this.render(); this.scrollReviewTo('.crisp-pulse-review-materials'); });
    }
    const legend = section.createDiv({ cls: 'crisp-pulse-analytics-legend crisp-pulse-review-legend' });
    const now = legend.createSpan(); now.createSpan({ cls: 'pulse-chart-dot pulse-chart-fill-purple' }); now.createSpan({ text: tr('本期（每项各自的颜色）', 'This period (each in its own colour)') });
    const before = legend.createSpan(); before.createSpan({ cls: 'pulse-chart-dot crisp-pulse-review-dot-previous' }); before.createSpan({ text: tr('上一期', 'Last period') });
    legend.createSpan({ text: tr('贡献分不代表知识质量', 'The score does not reflect knowledge quality') });
  }

  renderReviewMaterials(parent, model) {
    const section = this.reviewSection(parent, 'folder-tree', tr('本期材料', 'Material from this period'), tr('先按目录看精力落在哪，再挑笔记回看。条形是“笔记 × 天”，不代表工时；点「引用」把笔记记为这次复盘的依据。', 'See which folders took your attention, then pick notes to revisit. Bars count “note × day”, not hours; click Cite to keep a note as evidence for this review.'));
    section.addClass?.('crisp-pulse-review-materials');
    const { start, end } = model.period;
    const files = model.current.allFiles || [];
    const folder = this.reviewFolder && files.some(file => file.path.startsWith(`${this.reviewFolder}/`)) ? this.reviewFolder : '';
    this.reviewFolder = folder;

    // 目录逐层进入：当前层级下每个子目录一根条。
    const crumbs = section.createDiv({ cls: 'crisp-pulse-review-crumbs' });
    const parts = folder ? folder.split('/') : [];
    const crumb = (text, path) => {
      const button = crumbs.createEl('button', { cls: 'crisp-pulse-review-crumb', text, attr: { type: 'button' } });
      button.disabled = path === folder;
      button.addEventListener('click', () => { this.reviewFolder = path; this.reviewShowAllFiles = false; this.render(); });
    };
    crumb(tr('全部目录', 'All folders'), '');
    parts.forEach((part, i) => { crumbs.createSpan({ cls: 'crisp-pulse-review-crumb-sep', text: '/' }); crumb(part, parts.slice(0, i + 1).join('/')); });
    const groups = new Map();
    let loose = 0;
    for (const file of files) {
      if (folder && !file.path.startsWith(`${folder}/`)) continue;
      const rest = folder ? file.path.slice(folder.length + 1) : file.path;
      const slash = rest.indexOf('/');
      if (slash < 0) { loose += file.days; continue; }
      const name = rest.slice(0, slash);
      const group = groups.get(name) || { name, count: 0, words: 0, notes: 0 };
      group.count += file.days; group.words += file.words; group.notes++;
      groups.set(name, group);
    }
    const sorted = [...groups.values()].sort((a, b) => b.count - a.count || b.words - a.words || a.name.localeCompare(b.name));
    const shown = sorted.slice(0, 6);
    const rest = sorted.slice(6).reduce((sum, group) => sum + group.count, 0) + loose;
    const peak = Math.max(1, ...shown.map(group => group.count), rest);
    if (shown.length) {
      const bars = section.createDiv({ cls: 'crisp-pulse-review-folders' });
      const palette = ['blue', 'purple', 'orange', 'green', 'rose', 'teal'];
      shown.forEach((group, i) => {
        const button = bars.createEl('button', { cls: 'crisp-pulse-review-folder', attr: { type: 'button', title: folder ? `${folder}/${group.name}` : group.name } });
        button.createSpan({ cls: 'crisp-pulse-review-folder-name', text: group.name });
        const track = button.createSpan({ cls: 'crisp-pulse-review-folder-track' });
        const fill = track.createSpan({ cls: `crisp-pulse-review-folder-fill pulse-chart-fill-${palette[i % palette.length]}` });
        fill.style.width = `${Math.max(2, group.count / peak * 100)}%`;
        button.createSpan({ cls: 'crisp-pulse-review-folder-meta', text: tr(`${group.count} · ${formatPulseMinutes(group.words)} 词`, `${group.count} · ${formatPulseMinutes(group.words)} words`) });
        button.setAttr('aria-label', tr(`进入 ${group.name}：${group.notes} 篇笔记，${group.count} 笔记×天，新增 ${group.words} 词`, `Open ${group.name}: ${plural(group.notes, 'note')}, ${group.count} note × day, ${group.words} words added`));
        button.addEventListener('click', () => { this.reviewFolder = folder ? `${folder}/${group.name}` : group.name; this.reviewShowAllFiles = false; this.render(); });
      });
      if (rest > 0) {
        const other = bars.createDiv({ cls: 'crisp-pulse-review-folder is-static' });
        other.createSpan({ cls: 'crisp-pulse-review-folder-name', text: sorted.length > 6 ? tr('其他', 'Other') : tr('此目录下的笔记', 'Notes in this folder') });
        const track = other.createSpan({ cls: 'crisp-pulse-review-folder-track' });
        track.createSpan({ cls: 'crisp-pulse-review-folder-fill pulse-chart-fill-gray' }).style.width = `${Math.max(2, rest / peak * 100)}%`;
        other.createSpan({ cls: 'crisp-pulse-review-folder-meta', text: String(rest) });
      }
    }

    const modes = [['words', tr('新增最多', 'Most added')], ['rewrittenWords', tr('改写最多', 'Most rewritten')], ['capture', tr('大段捕获', 'Large captures')], ['created', tr('新建', 'New')], ['tasks', tr('完成任务', 'Tasks done')], ['days', tr('出现天数', 'Days present')]];
    const mode = modes.some(([key]) => key === this.reviewMaterialMode) ? this.reviewMaterialMode : 'words';
    const chips = section.createDiv({ cls: 'pulse-v2-seg crisp-pulse-review-modes' });
    chips.setAttr('role', 'tablist');
    for (const [key, text] of modes) {
      const chip = chips.createEl('button', { text, attr: { type: 'button', role: 'tab' } });
      chip.setAttr('aria-selected', String(key === mode));
      chip.addEventListener('click', () => { this.reviewMaterialMode = key; this.reviewShowAllFiles = false; this.render(); });
    }
    const drill = getReviewDrilldown(model.current, folder, ['words', 'rewrittenWords', 'tasks', 'days'].includes(mode) ? mode : 'words');
    let picked = drill.files;
    if (mode === 'created') picked = picked.filter(file => file.created);
    else if (mode === 'capture') picked = picked.filter(file => file.captureWords > 0).sort((a, b) => b.captureWords - a.captureWords || a.path.localeCompare(b.path));
    else if (mode !== 'words' && mode !== 'days') picked = picked.filter(file => file[mode] > 0);
    const metric = file => mode === 'capture' ? file.captureWords : mode === 'created' ? file.words : file[mode];
    const top = Math.max(1, ...picked.map(metric));
    const limit = this.reviewShowAllFiles ? (this.reviewFileLimit || 20) : 5;
    const cited = new Set(model.evidence.map(item => item.path));
    const list = section.createDiv({ cls: 'crisp-pulse-review-files' });
    for (const file of picked.slice(0, limit)) {
      const row = list.createDiv({ cls: 'crisp-pulse-review-file' });
      const open = row.createEl('button', { cls: 'crisp-pulse-review-file-open', attr: { type: 'button', title: file.path } });
      const slash = file.path.lastIndexOf('/');
      const head = open.createSpan({ cls: 'crisp-pulse-review-file-head' });
      head.createSpan({ text: file.path.slice(slash + 1).replace(/\.md$/i, ''), cls: 'crisp-pulse-review-path' });
      if (file.created) head.createSpan({ cls: 'crisp-pulse-review-tag', text: tr('新建', 'New') });
      if (slash > 0) head.createSpan({ text: file.path.slice(0, slash), cls: 'crisp-pulse-review-dir' });
      const track = open.createSpan({ cls: 'crisp-pulse-review-file-track' });
      track.createSpan({ cls: 'crisp-pulse-review-file-fill' }).style.width = `${metric(file) > 0 ? Math.max(1.5, metric(file) / top * 100) : 0}%`;
      const meta = [tr(`新增 ${formatPulseMinutes(file.words)}`, `added ${formatPulseMinutes(file.words)}`), tr(`改写 ${formatPulseMinutes(file.rewrittenWords)}`, `rewritten ${formatPulseMinutes(file.rewrittenWords)}`)];
      if (file.captureWords) meta.push(tr(`捕获 ${formatPulseMinutes(file.captureWords)}`, `captured ${formatPulseMinutes(file.captureWords)}`));
      if (file.tasks) meta.push(tr(`任务 ${formatPulseMinutes(file.tasks)}`, `tasks ${formatPulseMinutes(file.tasks)}`));
      meta.push(tr(`${file.days} 天`, plural(file.days, 'day')));
      open.createSpan({ cls: 'crisp-pulse-review-note', text: meta.join(' · ') });
      open.addEventListener('click', () => {
        const target = this.app.vault.getAbstractFileByPath(file.path);
        if (target instanceof TFile) this.app.workspace.getLeaf('tab').openFile(target);
        else new Notice(tr('该笔记已不存在，统计记录仍保留。', 'This note no longer exists; its stats are kept.'));
      });
      const cite = row.createEl('button', { cls: 'crisp-pulse-review-cite', text: cited.has(file.path) ? tr('已引用', 'Cited') : tr('引用', 'Cite'), attr: { type: 'button' } });
      cite.disabled = cited.has(file.path);
      cite.setAttr('aria-label', tr(`把 ${file.path} 记为复盘依据`, `Keep ${file.path} as evidence`));
      cite.addEventListener('click', async () => {
        cite.disabled = true;
        try {
          await this.plugin.addReviewEvidence(start, end, model.scope, file.path, '');
          const saved = await this.plugin.savePluginData();
          if (!saved.success) new Notice(tr('已记下，但保存失败，请稍后点「保存草稿」。', 'Noted, but saving failed; click Save draft later.'));
          this.render();
        } catch (error) { new Notice(error.message); cite.disabled = false; }
      });
    }
    if (!picked.length) list.createDiv({ cls: 'crisp-pulse-review-note', text: files.length ? tr('这个目录和筛选下没有笔记。', 'No notes for this folder and filter.') : tr('这个区间没有文件记录。', 'No file records in this period.') });
    if (picked.length > limit) {
      const more = section.createEl('button', { cls: 'crisp-pulse-review-more', attr: { type: 'button' }, text: this.reviewShowAllFiles ? tr(`再显示 20 篇（${limit}/${picked.length}）`, `Show 20 more (${limit}/${picked.length})`) : tr(`显示全部 ${picked.length} 篇`, `Show all ${picked.length}`) });
      more.setAttr('aria-label', tr('显示更多复盘笔记', 'Show more review notes'));
      more.addEventListener('click', () => {
        if (this.reviewShowAllFiles) this.reviewFileLimit = limit + 20;
        else { this.reviewShowAllFiles = true; this.reviewFileLimit = 20; }
        this.render();
      });
    }
  }

  /** 速记走向：本期记下的速记，现在去了任务、笔记还是 Now；一条可以去几处，已转化按速记去重。 */
  renderReviewMemos(parent, model, memoSummary, live) {
    const section = this.reviewSection(parent, 'feather', tr('速记走到了哪里', 'Where your memos went'), tr('本期记下的速记，现在转成了什么。一条可以同时去几处，已转化按速记去重；状态截至现在，条数不代表知识质量。', 'What this period’s memos have turned into so far. One memo can go to several places; converted counts each memo once. Status is as of now, and counts do not reflect knowledge quality.'));
    section.addClass?.('crisp-pulse-review-memo-card');
    const body = section.createDiv({ cls: 'crisp-pulse-review-memos' });
    body.createDiv({ cls: 'crisp-pulse-review-note', text: tr('正在读取速记…', 'Loading memos…') });
    void memoSummary.then(r => {
      if (!live(body)) return;
      body.empty();
      if (r.error) { body.createDiv({ cls: 'crisp-pulse-review-note', text: tr(`速记读取失败：${r.error}`, `Failed to load memos: ${r.error}`) }); return; }
      if (!r.total) {
        body.createDiv({ cls: 'crisp-pulse-review-note', text: r.hasMemos ? tr('这段时间没有速记。', 'No memos in this period.') : tr('还没有速记。在速记面板里记下的想法，会在这里看到转成了什么。', 'No memos yet. Ideas you capture in the memo panel will show up here with what they turned into.') });
        return;
      }
      const flow = body.createDiv({ cls: 'crisp-pulse-review-flow' });
      const source = flow.createDiv({ cls: 'crisp-pulse-review-flow-source' });
      source.createDiv({ cls: 'crisp-pulse-analytics-label', text: tr('本期速记', 'Memos') });
      source.createDiv({ cls: 'crisp-pulse-review-flow-big', text: String(r.total) });
      if (r.transcribed) source.createDiv({ cls: 'crisp-pulse-review-note', text: tr(`${r.transcribed} 条有录音转写`, `${r.transcribed} with transcripts`) });
      const branches = flow.createDiv({ cls: 'crisp-pulse-review-flow-branches' });
      const taskNote = r.tempoFailed ? tr('Tempo 状态读取失败', 'Tempo status unavailable')
        : r.tasksUnknown ? (r.hasTempo ? '' : tr('启用 Crisp Tempo 后显示完成情况', 'Enable Crisp Tempo to see completion'))
          : [r.tasksDone ? tr(`完成 ${r.tasksDone}`, `${r.tasksDone} done`) : '', r.tasksOpen ? tr(`未完成 ${r.tasksOpen}`, `${r.tasksOpen} open`) : '', r.tasksMissing ? tr(`${r.tasksMissing} 条已删除`, `${r.tasksMissing} deleted`) : ''].filter(Boolean).join(' · ');
      for (const [text, count, color, note] of [[tr('任务', 'Tasks'), r.toTasks, 'teal', taskNote], [tr('笔记', 'Notes'), r.toNotes, 'purple', ''], [tr('Now 行动', 'Now actions'), r.toNow, 'orange', ''], [tr('还没去处', 'Not yet'), r.total - r.converted, 'faint', '']]) {
        const branch = branches.createDiv({ cls: `crisp-pulse-review-flow-branch${count ? '' : ' is-zero'}` });
        branch.createSpan({ cls: `pulse-chart-dot pulse-chart-fill-${color}` });
        branch.createSpan({ cls: 'crisp-pulse-review-flow-name', text });
        const track = branch.createSpan({ cls: 'crisp-pulse-review-flow-track' });
        track.createSpan({ cls: color === 'faint' ? 'crisp-pulse-review-flow-fill is-pending' : `crisp-pulse-review-flow-fill pulse-chart-fill-${color}` }).style.width = `${count ? Math.max(3, count / r.total * 100) : 0}%`;
        branch.createSpan({ cls: 'crisp-pulse-review-flow-count', text: String(count) });
        if (note) branch.createSpan({ cls: 'crisp-pulse-review-flow-note', text: note });
      }
      const summary = flow.createDiv({ cls: 'crisp-pulse-review-flow-summary' });
      summary.createDiv({ cls: 'crisp-pulse-analytics-label', text: tr('已转化', 'Converted') });
      const big = summary.createDiv({ cls: 'crisp-pulse-review-flow-big' });
      big.createSpan({ text: String(r.converted) }); big.createSpan({ cls: 'crisp-pulse-review-flow-of', text: ` / ${r.total}` });
      summary.createDiv({ cls: 'crisp-pulse-review-note', text: tr('按速记去重，不是各分支相加', 'Counted per memo, not the sum of branches') });

      const lists = body.createDiv({ cls: 'crisp-pulse-review-memo-lists' });
      if (r.pending.length) {
        const pending = lists.createDiv({ cls: 'crisp-pulse-review-memo-results' });
        pending.createDiv({ cls: 'crisp-pulse-stat-label', text: tr(`还没去处 · ${r.pending.length}`, `Not followed up · ${r.pending.length}`) });
        for (const memo of r.pending.slice(0, 5)) {
          const row = pending.createEl('button', { cls: 'crisp-pulse-review-memo-result', attr: { type: 'button' } });
          row.createSpan({ cls: 'crisp-pulse-review-memo-kind', text: memo.date.slice(5).replace('-', '.') });
          row.createSpan({ cls: 'crisp-pulse-review-memo-text', text: memoTaskTitle(memo.text) || tr('（空速记）', '(empty memo)') });
          row.addEventListener('click', async () => {
            try { await this.plugin.openMemoSource(memo); }
            catch (error) { new Notice(tr(`Crisp Pulse：${error.message || error}`, `Crisp Pulse: ${error.message || error}`)); }
          });
        }
        const open = pending.createEl('button', { cls: 'crisp-pulse-review-more', attr: { type: 'button' }, text: tr('在速记面板里回看全部', 'Review all in the memo panel') });
        open.addEventListener('click', () => this.plugin.activateMemoView());
      }
      if (r.results.length) {
        const list = lists.createDiv({ cls: 'crisp-pulse-review-memo-results' });
        list.createDiv({ cls: 'crisp-pulse-stat-label', text: `${tr('转化结果', 'Results')} · ${r.results.length}` });
        for (const item of r.results.slice(0, 5)) {
          const row = list.createEl('button', { cls: 'crisp-pulse-review-memo-result', attr: { type: 'button' } });
          row.createSpan({ cls: 'crisp-pulse-review-memo-kind', text: item.task ? tr('完成的任务', 'Completed task') : tr('笔记', 'Note') });
          row.createSpan({ cls: 'crisp-pulse-review-memo-text', text: item.task ? item.text : item.link });
          row.addEventListener('click', async () => {
            try {
              if (item.task) await this.plugin.memoTempo()?.revealTask(item.task.id);
              else await this.app.workspace.openLinkText(item.link, item.path);
            } catch (error) { new Notice(tr(`Crisp Pulse：${error.message || error}`, `Crisp Pulse: ${error.message || error}`)); }
          });
        }
        if (r.results.length > 5) list.createDiv({ cls: 'crisp-pulse-review-note', text: tr(`还有 ${r.results.length - 5} 项，可在速记面板用「已转化」筛选查看`, `${r.results.length - 5} more; filter by “Converted” in the memo panel to see them`) });
      }
    });
  }

  renderReviewSources(parent, model) {
    const section = this.reviewSection(parent, 'pen-line', tr('新增内容从哪里来', 'Where new words came from'), tr('系统目录按路径识别，大段捕获是估算，其他来源未确认；分不出人工和 AI 写作。点大段捕获，可以看对应的笔记。', 'System folders are matched by path, large captures are estimates, and other sources are unconfirmed; this cannot tell human from AI writing. Click Large captures to see those notes.'));
    const words = model.current.sourceWords;
    const total = Object.values(words).reduce((sum, value) => sum + (value || 0), 0);
    const parts = [['capture', 'orange'], ['unattributed', 'blue'], ['system', 'gray'], ['historical', 'faint']];
    const bar = section.createDiv({ cls: 'crisp-pulse-mix-bar crisp-pulse-review-mix' });
    bar.setAttr('role', 'img');
    bar.setAttr('aria-label', parts.map(([key]) => `${REVIEW_SOURCE_LABELS[key]} ${formatPulseMinutes(words[key])}`).join(tr('，', ', ')));
    if (!total) bar.addClass?.('is-empty');
    for (const [key, color] of parts) {
      if (!(words[key] > 0)) continue;
      bar.createDiv({ cls: `crisp-pulse-mix-segment pulse-chart-fill-${color}` }).style.flexGrow = String(words[key]);
    }
    const legend = section.createDiv({ cls: 'crisp-pulse-review-mix-legend' });
    for (const [key, color] of parts) {
      const clickable = key === 'capture' && words.capture > 0;
      const item = legend.createEl(clickable ? 'button' : 'div', { cls: `crisp-pulse-review-mix-item${words[key] > 0 ? '' : ' is-zero'}`, attr: clickable ? { type: 'button' } : {} });
      item.createSpan({ cls: `pulse-chart-dot pulse-chart-fill-${color}` });
      item.createSpan({ cls: 'crisp-pulse-review-mix-name', text: REVIEW_SOURCE_LABELS[key] });
      item.createSpan({ cls: 'crisp-pulse-review-mix-value', text: tr(`${formatPulseMinutes(words[key])} 词`, `${formatPulseMinutes(words[key])} words`) });
      item.createSpan({ cls: 'crisp-pulse-review-mix-pct', text: total ? `${Math.round(words[key] / total * 1000) / 10}%` : '—' });
      if (clickable) item.addEventListener('click', () => { this.reviewMaterialMode = 'capture'; this.reviewShowAllFiles = false; this.render(); this.scrollReviewTo('.crisp-pulse-review-materials'); });
    }
    const row = section.createDiv({ cls: 'crisp-pulse-review-controls crisp-pulse-review-system' });
    const toggle = row.createEl('button', { cls: 'crisp-pulse-tab-btn', text: this.plugin.settings.excludeSystemArtifacts ? tr('系统产物已排除', 'System output excluded') : tr('排除后续系统产物', 'Exclude future system output') });
    toggle.setAttr('aria-pressed', String(!!this.plugin.settings.excludeSystemArtifacts));
    toggle.addEventListener('click', async () => {
      toggle.disabled = true;
      try { await this.plugin.setSystemArtifactsExcluded(!this.plugin.settings.excludeSystemArtifacts);this.render(); }
      catch (error) { new Notice(tr(`设置未保存：${error.message}`, `Settings not saved: ${error.message}`));toggle.disabled = false; }
    });
    row.createSpan({ cls: 'crisp-pulse-review-note', text: tr('仅作用于 Sidecar/logs、Sidecar/backups、Sidecar/manifests。历史保留，现有目录黑白名单继续生效。', 'Only affects Sidecar/logs, Sidecar/backups and Sidecar/manifests. History is kept, and existing folder include/exclude lists still apply.') });
  }

  /** 右栏：这次复盘留下的东西——依据、认识、下一步，以及保存、复制、归档。 */
  renderReviewNotebook(parent, model) {
    const { start, end } = model.period;
    const args = [start, end, model.scope];
    const savedAt = this.plugin.store.reviewDrafts?.[`${start}:${end}:${model.scope}`]?.updatedAt;
    const section = this.trayCard(parent, { icon: 'scroll-text', title: tr('这次复盘留下什么', 'What this review keeps'), subtitle: savedAt ? tr(`草稿按周期保存 · 最近修改 ${savedAt.slice(5, 16).replace('T', ' ')}`, `Saved per period · last edited ${savedAt.slice(5, 16).replace('T', ' ')}`) : tr('草稿按周期保存，换了日期也能在「历史复盘」里找回。', 'Saved per period; find it again under Past reviews.'), wrap: true, insetCls: 'crisp-pulse-review-section crisp-pulse-review-notebook' });
    const step = (number, title, hint) => {
      const box = section.createDiv({ cls: 'crisp-pulse-review-step' });
      const head = box.createDiv({ cls: 'crisp-pulse-review-step-head' });
      head.createSpan({ cls: 'crisp-pulse-review-step-num', text: number });
      head.createSpan({ cls: 'crisp-pulse-review-step-title', text: title });
      if (hint) box.createDiv({ cls: 'crisp-pulse-review-note', text: hint });
      return box;
    };
    const textarea = (wrap, key, label, rows, placeholder) => {
      const input = wrap.createEl('textarea');
      input.value = model.draft[key]; input.rows = rows; input.placeholder = placeholder;
      input.setAttr('aria-label', label); input.dataset.reviewField = key;
      this.trackReviewComposition(input);
      input.addEventListener('input', () => this.plugin.updateReviewDraft(start, end, model.scope, key, input.value));
      return input;
    };

    // 01 依据
    const evidenceStep = step('01', tr('依据', 'Evidence'), tr('在左边材料里点「引用」，或从本期笔记里挑一段原文。摘录保存后不随原文变化。', 'Click Cite on a note on the left, or pick a passage from this period’s notes. Saved quotes do not change with the note.'));
    const evidenceList = evidenceStep.createDiv({ cls: 'crisp-pulse-review-evidence-list' });
    for (const evidence of model.evidence) {
      const item = evidenceList.createDiv({ cls: 'crisp-pulse-review-evidence' });
      const head = item.createDiv({ cls: 'crisp-pulse-review-evidence-head' });
      const open = head.createEl('button', { cls: 'crisp-pulse-review-evidence-link', text: evidence.path.slice(evidence.path.lastIndexOf('/') + 1).replace(/\.md$/i, ''), attr: { type: 'button', title: evidence.path } });
      open.addEventListener('click', () => this.openReviewNote(evidence.path));
      const remove = head.createEl('button', { cls: 'crisp-pulse-review-icon-btn is-small', attr: { type: 'button', 'aria-label': `${tr('移除引用', 'Remove')} ${evidence.id}`, title: tr('移除引用', 'Remove') } });
      setIcon(remove, 'x');
      remove.addEventListener('click', () => { this.plugin.removeReviewEvidence(start, end, model.scope, evidence.id);this.render(); });
      if (evidence.quote) item.createEl('blockquote', { text: evidence.quote, cls: 'crisp-pulse-review-quote' });
      item.createDiv({ cls: 'crisp-pulse-review-note', text: `${tr('摘录于', 'Captured')} ${typeof evidence.capturedAt === 'string' ? evidence.capturedAt.slice(0, 10) : tr('未知日期', 'unknown date')}${evidence.originalPath !== evidence.path ? ` · ${tr('原路径', 'original path')} ${evidence.originalPath}` : ''}` });
    }
    const addEvidence = evidenceStep.createEl('button', { cls: 'crisp-pulse-review-add', attr: { type: 'button' }, text: tr('＋ 从本期笔记摘一段', '+ Quote from this period’s notes') });
    addEvidence.disabled = !model.current.allFiles.length;
    addEvidence.addEventListener('click', () => new CrispPulseEvidenceModal(this.app, this.plugin, model, () => this.render()).open());

    // 02 认识
    const learning = step('02', tr('我的认识', 'What I learned'), '');
    textarea(learning, 'learning', REVIEW_DRAFT_FIELDS.learning, 4, tr('这一期哪些认识变了？一两句就够，可以写上依据。', 'What changed in your understanding this period? A sentence or two is enough; mention the evidence.'));
    const more = learning.createEl('details', { cls: 'crisp-pulse-review-more-fields' });
    more.open = ['progress', 'blockers', 'next'].some(key => model.draft[key].trim());
    more.createEl('summary', { text: tr('进展、阻塞与备注', 'Progress, blockers and notes') });
    const fields = more.createDiv({ cls: 'crisp-pulse-review-drafts' });
    for (const [key, placeholder] of [['progress', tr('完成了什么？对应哪些笔记或交付？', 'What got done? Which notes or deliverables?')], ['blockers', tr('还有什么未解决、需要验证？', 'What is still unresolved or needs checking?')], ['next', tr('其他想记下的下一步（结构化行动在下面）。', 'Other next steps to note (structured actions are below).')]]) {
      const wrap = fields.createEl('label', { text: REVIEW_DRAFT_FIELDS[key] });
      textarea(wrap, key, REVIEW_DRAFT_FIELDS[key], 3, placeholder);
    }

    // 03 下一步
    const next = step('03', tr('下一步', 'Next steps'), tr('下次打开复盘时，先看这些承诺推进了没有。', 'Next time you open a review, start by checking these.'));
    if (model.actions.length) {
      const counts = Object.fromEntries(Object.keys(REVIEW_ACTION_STATES).map(key => [key, model.actions.filter(a => (a.status || 'pending') === key).length]));
      const strip = next.createDiv({ cls: 'crisp-pulse-review-action-strip' });
      const colors = { pending: 'blue', done: 'green', deferred: 'orange', cancelled: 'gray' };
      const meter = strip.createDiv({ cls: 'crisp-pulse-mix-bar crisp-pulse-review-action-meter' });
      meter.setAttr('role', 'img');
      meter.setAttr('aria-label', Object.entries(counts).map(([key, n]) => `${REVIEW_ACTION_STATES[key]} ${n}`).join(tr('，', ', ')));
      for (const [key, n] of Object.entries(counts)) if (n) meter.createDiv({ cls: `crisp-pulse-mix-segment pulse-chart-fill-${colors[key]}` }).style.flexGrow = String(n);
      const legend = strip.createDiv({ cls: 'crisp-pulse-analytics-legend' });
      for (const [key, n] of Object.entries(counts)) { if (!n) continue; const span = legend.createSpan(); span.createSpan({ cls: `pulse-chart-dot pulse-chart-fill-${colors[key]}` }); span.createSpan({ text: `${REVIEW_ACTION_STATES[key]} ${n}` }); }
    }
    const carry = this.plugin.previousActionCandidates(...args).length;
    if (carry) {
      const inherit = next.createEl('button', { cls: 'crisp-pulse-review-add', attr: { type: 'button' }, text: tr(`带入上一期 ${carry} 项未完成行动`, `Carry over ${plural(carry, 'unfinished action')}`) });
      inherit.addEventListener('click', () => {
        const count = this.plugin.importPreviousActions(...args);new Notice(count ? tr(`已带入 ${count} 项行动。`, `Carried over ${plural(count, 'action')}.`) : tr('没有新的未完成行动可带入。', 'No new unfinished actions to carry over.'));this.render();
      });
    }
    const list = next.createDiv({ cls: 'crisp-pulse-review-action-list' });
    for (const action of model.actions) {
      const item = list.createDiv({ cls: `crisp-pulse-review-action${action.status === 'done' ? ' is-done' : action.status === 'cancelled' ? ' is-cancelled' : ''}` });
      const input = item.createEl('input', { type: 'text', cls: 'crisp-pulse-review-action-title' });input.value = action.title;input.maxLength = Math.max(500, action.title.length);
      input.dataset.reviewField = `action-${action.id}`;input.setAttr('aria-label', tr('行动内容', 'Action'));this.trackReviewComposition(input);
      input.addEventListener('input', () => {
        try { this.plugin.updateReviewAction(...args, action.id, { title: input.value }); }
        catch (error) { new Notice(error.message); }
      });
      const states = item.createDiv({ cls: 'pulse-v2-seg crisp-pulse-review-action-states' });
      states.setAttr('role', 'radiogroup'); states.setAttr('aria-label', `${tr('行动状态', 'Action status')} ${action.id}`);
      for (const [key, text] of Object.entries(REVIEW_ACTION_STATES)) {
        const button = states.createEl('button', { text, attr: { type: 'button', role: 'radio' } });
        button.setAttr('aria-checked', String((action.status || 'pending') === key));
        button.setAttr('aria-selected', String((action.status || 'pending') === key));
        button.addEventListener('click', () => { this.plugin.updateReviewAction(...args, action.id, { status: key }); this.render(); });
      }
      const outcome = item.createDiv({ cls: 'crisp-pulse-review-outcome' });
      if (action.sourcePeriod) outcome.createSpan({ cls: 'crisp-pulse-review-note', text: `${tr('继承自', 'Carried over from')} ${action.sourcePeriod.split(':').slice(0, 2).join(' — ')}` });
      if (action.outcomePath) {
        const open = outcome.createEl('button', { cls: 'crisp-pulse-review-outcome-link', attr: { type: 'button', title: action.outcomePath } });
        setIcon(open.createSpan({ cls: 'crisp-pulse-review-outcome-icon' }), 'file-check');
        open.createSpan({ text: action.outcomePath.slice(action.outcomePath.lastIndexOf('/') + 1).replace(/\.md$/i, '') });
        open.addEventListener('click', () => this.openReviewNote(action.outcomePath));
        const clear = outcome.createEl('button', { cls: 'crisp-pulse-review-icon-btn is-small', attr: { type: 'button', 'aria-label': tr('清除结果关联', 'Clear outcome link'), title: tr('清除结果关联', 'Clear outcome link') } });
        setIcon(clear, 'x');
        clear.addEventListener('click', () => { this.plugin.updateReviewAction(...args, action.id, { outcomePath: '' }); this.render(); });
      } else {
        const link = outcome.createEl('button', { cls: 'crisp-pulse-review-outcome-pick', attr: { type: 'button' }, text: tr('关联结果笔记', 'Link outcome note') });
        link.setAttr('aria-label', `${tr('关联结果', 'Link outcome')} ${action.id}`);
        link.addEventListener('click', () => new CrispPulseNotePickerModal(this.app, model.current.allFiles.map(file => file.path), path => {
          try { this.plugin.updateReviewAction(...args, action.id, { outcomePath: path }); new Notice(tr('结果笔记已关联。', 'Outcome note linked.')); this.render(); }
          catch (error) { new Notice(error.message); }
        }).open());
      }
    }
    const add = next.createDiv({ cls: 'crisp-pulse-review-new-action' });
    const title = add.createEl('input', { type: 'text', placeholder: tr('新增一项可执行的行动', 'Add an actionable step') });
    title.maxLength = 500;title.setAttr('aria-label', tr('新行动', 'New action'));title.dataset.reviewField = 'new-action';const newActionKey = getReviewDraftKey(...args);this.reviewNewActions ||= {};title.value = this.reviewNewActions[newActionKey] || '';
    this.trackReviewComposition(title);
    title.addEventListener('input', () => { this.reviewNewActions[newActionKey] = title.value; });
    const addButton = add.createEl('button', { cls: 'crisp-pulse-tab-btn', text: tr('添加', 'Add') });
    const submit = () => {
      try { this.plugin.addReviewAction(...args, title.value);delete this.reviewNewActions[newActionKey];this.render(); }
      catch (error) { new Notice(error.message); }
    };
    addButton.addEventListener('click', submit);title.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault();submit(); } });

    // 保存与导出：报告带上速记摘要，和页面看到的一致。
    const footer = section.createDiv({ cls: 'crisp-pulse-review-footer' });
    const buttons = footer.createDiv({ cls: 'crisp-pulse-review-controls' });
    const status = footer.createDiv({ cls: 'crisp-pulse-review-note' });
    status.setAttr('role', 'status');
    const fresh = async () => {
      const report = this.plugin.getReviewModel(start, end, model.scope);
      report.memos = await this.plugin.getReviewMemoSummary(start, end);
      return report;
    };
    const archive = buttons.createEl('button', { cls: 'crisp-pulse-tab-btn is-active', text: tr('归档至知识库', 'Archive to vault') });
    archive.addEventListener('click', async () => {
      archive.disabled = true;
      try {
        const result = await this.plugin.archiveReviewReport(await fresh());
        status.setText(result.success ? tr(`已归档：${result.path}`, `Archived: ${result.path}`) : result.reason === 'exists' ? tr('同区间、同范围报告已存在，原文已保留。', 'A report for the same period and scope already exists; the original was kept.') : tr('归档失败，请检查目录或控制台后重试。', 'Archiving failed. Check the folder or the console and try again.'));
      } catch (error) { status.setText(tr(`归档失败：${error.message}`, `Archiving failed: ${error.message}`)); }
      finally { archive.disabled = false; }
    });
    const copy = buttons.createEl('button', { cls: 'crisp-pulse-tab-btn', text: tr('复制 Markdown', 'Copy Markdown') });
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(generateReviewReport(await fresh())); status.setText(tr('报告已复制。', 'Report copied.')); }
      catch (error) { status.setText(tr('复制失败，请检查剪贴板权限后重试。', 'Copy failed. Check clipboard permissions and try again.')); }
    });
    const save = buttons.createEl('button', { cls: 'crisp-pulse-tab-btn', text: tr('保存草稿', 'Save draft') });
    save.addEventListener('click', async () => {
      save.disabled = true;
      const result = await this.plugin.savePluginData();
      save.disabled = false; status.setText(result.success ? tr('草稿已保存到本地。', 'Draft saved locally.') : tr('保存失败，草稿仍在内存中，请重试。', 'Save failed; the draft is still in memory. Please try again.'));
    });
    if (this.plugin.focusAdapter?.isAvailable()) {
      const focus = buttons.createEl('button', { cls: 'crisp-pulse-tab-btn', text: tr('专注 25 分钟', 'Focus 25 min') });
      focus.addEventListener('click', () => this.plugin.focusAdapter.startFocusSession(25));
    }
  }

  trackReviewComposition(input) {
    input.addEventListener('compositionstart', () => { this.reviewComposing = true; });
    input.addEventListener('compositionend', () => { this.reviewComposing = false; });
  }

  openReviewNote(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) this.app.workspace.getLeaf('tab').openFile(file);
    else new Notice(tr('原笔记已不存在，保留的证据摘录仍可查阅。', 'The original note no longer exists; the saved quote is still available.'));
  }

  getMetricLabel(m) {
    switch (m) {
      case "activity":
        return tr("交互活跃分钟", "Active minutes");
      case "focus":
        return tr("深度专注分钟", "Focus minutes");
      case "pomodoro":
        return tr("完成的番茄", "Pomodoros completed");
      case "words":
        return tr("新增词数", "Words added");
      case "notes":
        return tr("新建笔记", "Notes created");
      case "tasks":
        return tr("完成任务", "Tasks completed");
      case "contribution":
      default:
        return tr("贡献得分", "Contribution score");
    }
  }
}

/* ==========================================================================
   Settings Tab (v1.3.0)
   ========================================================================== */

/** 选一篇已有笔记：本期出现过的排在前面，也能搜全库。 */
class CrispPulseNotePickerModal extends Modal {
  constructor(app, preferred, onChoose) { super(app);this.preferred = preferred || [];this.onChoose = onChoose; }
  onOpen() {
    const root = this.contentEl;root.empty();root.addClass('crisp-pulse-evidence-modal');
    root.createEl('h2', { text: tr('关联结果笔记', 'Link an outcome note') });
    root.createEl('p', { text: tr('本期出现过的笔记排在前面，也可以搜索全库。', 'Notes from this period come first; you can also search the whole vault.'), cls: 'crisp-pulse-review-note' });
    const search = root.createEl('input', { type: 'search', placeholder: tr('按笔记路径搜索', 'Search by note path') });search.setAttr('aria-label', tr('搜索笔记', 'Search notes'));
    const choices = root.createDiv({ cls: 'crisp-pulse-evidence-choices' });
    const preferred = new Set(this.preferred);
    const all = [...this.preferred.filter(path => this.app.vault.getAbstractFileByPath(path)), ...this.app.vault.getMarkdownFiles().map(file => file.path).filter(path => !preferred.has(path)).sort()];
    const render = () => {
      choices.empty();const query = search.value.trim().toLocaleLowerCase();
      const files = all.filter(path => path.toLocaleLowerCase().includes(query));
      for (const path of files.slice(0, 30)) { const button = choices.createEl('button', { text: path });button.addEventListener('click', () => { this.close();this.onChoose(path); }); }
      if (files.length > 30) choices.createDiv({ cls: 'crisp-pulse-review-note', text: tr(`匹配 ${files.length} 篇，仅显示前 30 篇，请继续缩小搜索。`, `${files.length} matches; showing the first 30. Narrow your search.`) });
      if (!files.length) choices.createDiv({ cls: 'crisp-pulse-review-note', text: tr('没有匹配的笔记。', 'No matching notes.') });
    };
    search.addEventListener('input', render);render();
    window.setTimeout(() => search.focus(), 0);
  }
  onClose() { this.contentEl.empty(); }
}

class CrispPulseEvidenceModal extends Modal {
  constructor(app, plugin, model, onAdded) { super(app);this.plugin = plugin;this.model = model;this.onAdded = onAdded;this.readVersion = 0; }
  onOpen() {
    const root = this.contentEl;root.empty();root.addClass('crisp-pulse-evidence-modal');
    root.createEl('h2', { text: tr('关联洞见证据', 'Link evidence') });
    root.createEl('p', { text: tr('搜索本期笔记。选中原文可添加摘录，也可只保留来源链接。', 'Search this period’s notes. Select text to add a quote, or keep just the source link.'), cls: 'crisp-pulse-review-note' });
    const search = root.createEl('input', { type: 'search', placeholder: tr('按笔记路径搜索', 'Search by note path') });search.setAttr('aria-label', tr('搜索证据笔记', 'Search evidence notes'));
    const choices = root.createDiv({ cls: 'crisp-pulse-evidence-choices' });
    const chosen = root.createDiv({ cls: 'crisp-pulse-review-note', text: tr('尚未选择笔记', 'No note selected') });
    const preview = root.createEl('textarea');preview.readOnly = true;preview.rows = 7;preview.setAttr('aria-label', tr('证据原文预览', 'Evidence preview'));
    const quote = root.createEl('textarea');quote.rows = 3;quote.maxLength = 2000;quote.placeholder = tr('原文摘录（可留空，最多 2000 字）', 'Quote (optional, up to 2000 characters)');quote.setAttr('aria-label', tr('保留的原文摘录', 'Saved quote'));
    const status = root.createDiv({ cls: 'crisp-pulse-review-note' });status.setAttr('role', 'status');
    const actions = root.createDiv({ cls: 'crisp-pulse-review-controls' });
    const use = actions.createEl('button', { text: tr('使用选中文本', 'Use selected text') });
    use.addEventListener('click', () => {
      const selected = preview.value.slice(preview.selectionStart, preview.selectionEnd);
      if (!selected) { status.setText(tr('请先在原文预览中选择文字。', 'Select some text in the preview first.'));return; }
      if (selected.length > 2000) { status.setText(tr('选中文字超过 2000 字，请缩小范围。', 'The selection is over 2000 characters; select less.'));return; }
      quote.value = selected;status.setText(tr('已填入选中的原文。', 'Selected text filled in.'));
    });
    const save = actions.createEl('button', { text: tr('保存证据', 'Save evidence') });save.disabled = true;
    const select = async path => {
      const token = ++this.readVersion;this.selectedPath = null;save.disabled = true;preview.value = '';quote.value = '';chosen.setText(tr(`读取：${path}`, `Loading: ${path}`));
      try {
        const file = this.app.vault.getAbstractFileByPath(path);if (!file || file.extension !== 'md') throw new Error(tr('原笔记已不存在。', 'The original note no longer exists.'));
        const content = await this.app.vault.read(file);if (token !== this.readVersion) return;
        this.selectedPath = file.path;preview.value = content.slice(0, 12000);chosen.setText(file.path);save.disabled = false;
        status.setText(content.length > 12000 ? tr('预览前 12000 字；保存时会核对完整原文。', 'Previewing the first 12000 characters; the full note is checked when saving.') : tr('可选择原文，或直接保存来源链接。', 'Select text, or just save the source link.'));
      } catch (error) { if (token === this.readVersion) { chosen.setText(path);status.setText(error.message); } }
    };
    const renderChoices = () => {
      choices.empty();const query = search.value.trim().toLocaleLowerCase();
      const files = this.model.current.allFiles.filter(file => file.path.toLocaleLowerCase().includes(query));
      for (const file of files.slice(0, 20)) { const button = choices.createEl('button', { text: file.path });button.addEventListener('click', () => select(file.path)); }
      if (files.length > 20) choices.createDiv({ cls: 'crisp-pulse-review-note', text: tr(`匹配 ${files.length} 篇，仅显示前 20 篇，请继续缩小搜索。`, `${files.length} matches; showing the first 20. Narrow your search.`) });
      if (!files.length) choices.createDiv({ cls: 'crisp-pulse-review-note', text: tr('没有匹配的本期笔记。', 'No matching notes in this period.') });
    };
    search.addEventListener('input', renderChoices);renderChoices();
    save.addEventListener('click', async () => {
      if (!this.selectedPath) return;save.disabled = true;
      try {
        const added = await this.plugin.addReviewEvidence(this.model.period.start, this.model.period.end, this.model.scope, this.selectedPath, quote.value);
        const result = await this.plugin.savePluginData();
        if (!result.success) { status.setText(tr('证据已保留在内存，但保存失败，请重试。', 'The evidence is kept in memory, but saving failed. Please try again.'));return; }
        this.onAdded();this.close();new Notice(added ? tr('证据已关联。', 'Evidence linked.') : tr('相同证据已存在。', 'The same evidence already exists.'));
      } catch (error) { status.setText(error.message); }
      finally { save.disabled = !this.selectedPath; }
    });
    search.focus();
  }
  onClose() { this.readVersion++;this.contentEl.empty(); }
}

/* ==========================================================================
   速记（flomo 式）
   通用模式：追加到当天日笔记的速记段落；ANKS 模式：每天一个 raw 采集件，
   字段取自库内 ANKS 采集合约（pulse-memo）。两种来源都按 `> [!memo] HH:MM` 解析。
   速记属于数据采集，永不上锁。
   ========================================================================== */

const VIEW_TYPE_MEMO = "crisp-pulse-memo-view";
const MEMO_PAGE_SIZE = 30;
const MEMO_HEADER_RE = /^>\s*\[!memo\][+-]?\s*(\d{1,2}:\d{2})?\s*$/i;
const MEMO_LINK_RE = /^→\s*\[\[([^\]]+)\]\]\s*$/;
const MEMO_ID_RE = /^<!-- crisp-pulse-memo-id: ([a-zA-Z0-9-]+) -->$/;
const MEMO_RESTORE_RE = /^<!-- crisp-pulse-memo-restored: ([a-zA-Z0-9-]+) -->$/;
const MEMO_ASR_RE = /^<!-- crisp-pulse-asr: ([a-zA-Z0-9-]+)(?: audio: ([^\s]+))? -->$/;
const MEMO_TEMPO_RE = /^<!-- crisp-pulse-tempo: ([A-Za-z0-9_-]+) -->$/;
const MEMO_SOURCE_RE = /^<!-- crisp-pulse-source: ([a-z][a-z0-9-]*:[A-Za-z0-9_-]{1,128})(?: rev: ([A-Za-z0-9_-]{1,64}))? -->$/;
// 其他插件把内容记成速记的接口版本；不兼容的改动才加一
const MEMO_CAPTURE_API_VERSION = 1;
const ANKS_CAPTURE_CONTRACT_PATH = "Sidecar/tools/capture-metadata/contract.json";
const ANKS_ROUTE_CONTRACT_PATH = ".runtime/snapshot/route-contract.json";
const ANKS_NOW_FILE = "Now/行动.md";
const MEMO_CAPTURE_TYPE = "pulse-memo";
const MEMO_WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

function memoPad(n) {
  return String(n).padStart(2, "0");
}

function memoClock(date) {
  return `${memoPad(date.getHours())}:${memoPad(date.getMinutes())}`;
}

/** 别处来的一行文字放进速记前转义：不能被当成下一条速记、转化回链或隐藏凭据。
    keepLinks：输入框里自己写的「→ [[笔记]]」回链照常保留。 */
function memoSafeLine(line, { keepLinks = false } = {}) {
  let safe = MEMO_HEADER_RE.test(`> ${line}`) ? line.replace("[", "\\[") : line;
  if (!keepLinks && MEMO_LINK_RE.test(safe.trim())) safe = safe.replace("[[", "\\[\\[");
  const t = line.trim();
  if (MEMO_ID_RE.test(t) || MEMO_RESTORE_RE.test(t) || MEMO_ASR_RE.test(t) || MEMO_TEMPO_RE.test(t) || MEMO_SOURCE_RE.test(t)) safe = safe.replace("<", "&lt;");
  return safe;
}

/** 来自其他插件的速记正文：用户自己的话在前，原文摘录单独成引用块，最后是出处。 */
function buildSourceMemoText({ note = "", quote = "", link = "" }) {
  const clean = (text) => String(text ?? "").replace(/\r\n?/g, "\n").trim();
  const parts = [];
  const own = clean(note);
  if (own) {
    const lines = own.split("\n");
    const fenced = memoFencedLines(lines);
    parts.push(lines.map((line, i) => (fenced.has(i) ? line : memoSafeLine(line))).join("\n"));
  }
  const quoted = clean(quote);
  if (quoted) parts.push(quoted.split("\n").map((line) => (line.trim() ? `> ${line}` : ">")).join("\n"));
  if (link) parts.push(tr(`出处：${link}`, `Source: ${link}`));
  return parts.join("\n\n");
}

function buildMemoBlock(text, date) {
  const body = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  // 正文里的「[!memo] 12:00」、隐藏标识行要转义：否则一条速记被拆成两条，或伪造出标识 / 来源凭据。
  // 闭合围栏代码块里的读取时本来就跳过，原样保留；没闭合的围栏不算，照常转义
  const raw = body.split("\n");
  const fenced = memoFencedLines(raw);
  const lines = raw.map((line, i) => {
    if (!line.trim()) return ">";
    const trimmed = line.replace(/\s+$/, "");
    return `> ${fenced.has(i) ? trimmed : memoSafeLine(trimmed, { keepLinks: true })}`;
  });
  return [`> [!memo] ${memoClock(date)}`, ...lines].join("\n");
}

function extractMemoTags(text) {
  // 围栏代码块里的 #xxx 是代码示例，不是标签（标签改名也按同样规则跳过）
  const lines = String(text ?? "").split("\n");
  const fenced = memoFencedLines(lines);
  const clean = lines.filter((_, k) => !fenced.has(k)).join("\n").replace(/`[^`]*`/g, " ");
  const tags = [];
  const re = /(^|\s)#([^\s#`]+)/g;
  let match;
  while ((match = re.exec(clean))) {
    const tag = match[2].replace(/[，。,.;；:：!！?？)）\]]+$/, "");
    if (!tag || /^\d+$/.test(tag) || tags.includes(tag)) continue;
    tags.push(tag);
  }
  return tags;
}

/** 一组行里被成对围栏包住的行号（含围栏行本身）。没闭合的围栏不算：免得吞掉后面的速记和隐藏凭据。 */
function memoFencedLines(lines) {
  const inside = new Set();
  let fence = null;
  let open = -1;
  for (let k = 0; k < lines.length; k++) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[k]);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
        for (let x = open; x <= k; x++) inside.add(x);
        fence = null;
      }
    } else if (marker && (marker[1][0] !== "`" || !marker[2].includes("`"))) { fence = marker[1]; open = k; }
  }
  return inside;
}

function parseMemoBlocks(content) {
  const lines = String(content ?? "").split("\n");
  const memos = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }
    if (marker && (marker[1][0] !== "`" || !marker[2].includes("`"))) { fence = marker[1]; continue; }
    const header = MEMO_HEADER_RE.exec(lines[i]);
    if (!header) continue;
    // 速记里的代码块（行首带 >）中的 [!memo] 是示例，不是下一条速记
    let last = i;
    while (last + 1 < lines.length && /^>/.test(lines[last + 1])) last++;
    const fenced = memoFencedLines(lines.slice(i + 1, last + 1).map((line) => line.replace(/^>\s?/, "")));
    let end = i;
    while (end < last && !(MEMO_HEADER_RE.test(lines[end + 1]) && !fenced.has(end - i))) end++;
    const body = lines.slice(i + 1, end + 1).map((line) => line.replace(/^>\s?/, ""));
    const links = [];
    const textLines = [];
    let id;
    let restoredId;
    const transcriptJobs = [];
    const transcriptAudio = [];
    const tempoTasks = [];
    const sources = [];
    for (const [k, line] of body.entries()) {
      if (fenced.has(k)) { textLines.push(line); continue; }
      const source = MEMO_SOURCE_RE.exec(line.trim());
      if (source) { if (!sources.some((s) => s.id === source[1])) sources.push({ id: source[1], revision: source[2] || "" }); continue; }
      const tempo = MEMO_TEMPO_RE.exec(line.trim());
      if (tempo) { if (!tempoTasks.includes(tempo[1])) tempoTasks.push(tempo[1]); continue; }
      const transcript = MEMO_ASR_RE.exec(line.trim());
      if (transcript) {
        transcriptJobs.push(transcript[1]);
        if (transcript[2]) { try { transcriptAudio.push(decodeURIComponent(transcript[2])); } catch (_) { /* damaged receipt is not proof */ } }
        continue;
      }
      const restored = MEMO_RESTORE_RE.exec(line.trim());
      if (restored) { restoredId = restored[1]; continue; }
      const identity = MEMO_ID_RE.exec(line.trim());
      if (identity) { id = identity[1]; continue; }
      const link = MEMO_LINK_RE.exec(line.trim());
      if (link) links.push(link[1]);
      else textLines.push(line);
    }
    const text = textLines.join("\n").trim();
    memos.push({
      ...(id ? { id } : {}),
      ...(restoredId ? { restoredId } : {}),
      ...(transcriptJobs.length ? { transcriptJobs } : {}),
      ...(transcriptAudio.length ? { transcriptAudio } : {}),
      ...(tempoTasks.length ? { tempoTasks } : {}),
      ...(sources.length ? { sources } : {}),
      time: header[1] ? header[1].padStart(5, "0") : "",
      text,
      tags: extractMemoTags(text),
      links,
      startLine: i,
      endLine: end,
      raw: lines.slice(i, end + 1).join("\n"),
    });
    i = end;
  }
  return memos;
}

/** 按键在写作证据里算什么：text 直接产生文字；shortcut 带 Cmd/Ctrl 的组合键或移动行，要编辑器随后真的变了才算；null 只移动光标或界面操作。 */
function writingKeyKind(event) {
  const key = String(event?.key ?? "");
  if (event?.isComposing || key === "Process" || event?.keyCode === 229) return "text";
  if (["Shift", "Control", "Meta", "Alt", "CapsLock", "Fn"].includes(key)) return null;
  if (event?.ctrlKey || event?.metaKey) return "shortcut";
  if (event?.altKey && /^Arrow(Up|Down)$/.test(key)) return "shortcut";
  if (key.length === 1) return "text";
  if (["Backspace", "Delete", "Enter", "Tab"].includes(key)) return "text";
  return null;
}

function memoHeadingLevel(line) {
  const match = /^(#{1,6})\s/.exec(line);
  return match ? match[1].length : 0;
}

function insertMemoBlock(content, block, heading) {
  const text = String(content ?? "");
  const trimmedEnd = text.replace(/\s+$/, "");
  const headingLine = String(heading ?? "").trim();
  if (!headingLine) return trimmedEnd ? `${trimmedEnd}\n\n${block}\n` : `${block}\n`;
  const lines = text.split("\n");
  // 代码块里的示例标题（模板里贴的速记格式说明）不算，免得速记写进代码块
  const fenced = memoFencedLines(lines);
  const at = lines.findIndex((line, i) => !fenced.has(i) && line.trim() === headingLine);
  if (at < 0) return trimmedEnd ? `${trimmedEnd}\n\n${headingLine}\n\n${block}\n` : `${headingLine}\n\n${block}\n`;
  const level = memoHeadingLevel(headingLine) || 6;
  let next = lines.length;
  for (let i = at + 1; i < lines.length; i++) {
    if (fenced.has(i)) continue;
    const lv = memoHeadingLevel(lines[i]);
    if (lv && lv <= level) { next = i; break; }
  }
  let last = next - 1;
  while (last > at && !lines[last].trim()) last--;
  const before = lines.slice(0, last + 1);
  const after = lines.slice(next);
  const merged = [...before, "", ...block.split("\n")];
  if (after.length) return [...merged, "", ...after].join("\n");
  return `${merged.join("\n")}\n`;
}

function locateMemo(lines, memo) {
  // Match an entire parsed block, never a prefix or a fenced example.
  const hits = parseMemoBlocks(lines.join("\n")).filter((m) => m.raw === memo.raw);
  const atLine = hits.find((m) => m.startLine === memo.startLine);
  if (atLine) return atLine.startLine;
  if (hits.length === 1) return hits[0].startLine;
  throw new Error(tr("这条速记已被修改或找不到，请刷新后再试", "This memo was changed or cannot be found. Refresh and try again"));
}

function removeMemoBlock(content, memo) {
  const lines = String(content ?? "").split("\n");
  const start = locateMemo(lines, memo);
  const end = start + memo.raw.split("\n").length - 1;
  let from = start;
  let to = end;
  if (to + 1 < lines.length && !lines[to + 1].trim()) to++;
  else if (from > 0 && !lines[from - 1].trim()) from--;
  lines.splice(from, to - from + 1);
  return lines.join("\n");
}

function appendMemoLink(content, memo, linkText) {
  const lines = String(content ?? "").split("\n");
  const start = locateMemo(lines, memo);
  const end = start + memo.raw.split("\n").length - 1;
  lines.splice(end + 1, 0, `> → [[${linkText}]]`);
  return lines.join("\n");
}

function memoKeyToDay(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// 深浅按条数分 4 档；刻度至少按 8 条算，零星几条保持浅色，不会因为只有一天有数据就直接最深。
function memoHeatLevel(count, max) {
  if (!(count > 0)) return 0;
  return Math.min(4, Math.max(1, Math.ceil((count / Math.max(8, max || 0)) * 4)));
}

function memoStats(memos, todayKey, { weeks = 12, weekStartsOn = "sunday" } = {}) {
  const byDate = new Map();
  for (const m of memos) byDate.set(m.date, (byDate.get(m.date) || 0) + 1);
  const today = memoKeyToDay(todayKey);
  const firstDow = weekStartsOn === "monday" ? 1 : 0;
  const end = new Date(today);
  end.setDate(end.getDate() + ((firstDow + 6 - today.getDay() + 7) % 7));
  const start = new Date(end);
  start.setDate(start.getDate() - weeks * 7 + 1);
  const cells = [];
  let recent = 0;
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const key = dateKey(d);
    const count = byDate.get(key) || 0;
    if (key <= todayKey) recent += count;
    cells.push({ date: key, count, future: key > todayKey });
  }
  let streak = 0;
  const cursor = new Date(today);
  if (!byDate.get(todayKey)) cursor.setDate(cursor.getDate() - 1);
  while (byDate.get(dateKey(cursor))) { streak++; cursor.setDate(cursor.getDate() - 1); }
  const monthPrefix = todayKey.slice(0, 7);
  const month = memos.filter((m) => m.date.startsWith(monthPrefix)).length;
  return { cells, recent, streak, month, total: memos.length, byDate };
}

function formatMemoDate(date, format, momentFn) {
  if (momentFn) return momentFn(date).format(format);
  const tokens = { YYYY: String(date.getFullYear()), YY: String(date.getFullYear()).slice(-2), MM: memoPad(date.getMonth() + 1), M: String(date.getMonth() + 1), DD: memoPad(date.getDate()), D: String(date.getDate()) };
  return String(format).replace(/\[([^\]]*)\]|YYYY|YY|MM|M|DD|D/g, (token, literal) => (literal !== undefined ? literal : tokens[token]));
}

function dailyNotePath(date, { folder = "", format = "YYYY-MM-DD" } = {}, momentFn = null) {
  const dir = String(folder || "").replace(/^\/+|\/+$/g, "");
  const name = formatMemoDate(date, format || "YYYY-MM-DD", momentFn);
  return `${dir ? `${dir}/` : ""}${name}.md`;
}

function dailyDateFromPath(path, { folder = "", format = "YYYY-MM-DD" } = {}, momentFn = null) {
  const dir = String(folder || "").replace(/^\/+|\/+$/g, "");
  if (!path.endsWith(".md")) return null;
  if (dir && !path.startsWith(`${dir}/`)) return null;
  const rel = path.slice(dir ? dir.length + 1 : 0, -3);
  const fmt = format || "YYYY-MM-DD";
  if (momentFn) {
    const parsed = momentFn(rel, fmt, true);
    return parsed.isValid() ? parsed.format("YYYY-MM-DD") : null;
  }
  const groups = [];
  const pattern = fmt.replace(/\[([^\]]*)\]|YYYY|YY|MM|M|DD|D|[.*+?^${}()|\\]/g, (token, literal) => {
    if (literal !== undefined) return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (/^[.*+?^${}()|\\]$/.test(token)) return `\\${token}`;
    groups.push(token);
    return { YYYY: "(\\d{4})", YY: "(\\d{2})", MM: "(\\d{2})", M: "(\\d{1,2})", DD: "(\\d{2})", D: "(\\d{1,2})" }[token];
  });
  const match = new RegExp(`^${pattern}$`).exec(rel);
  if (!match) return null;
  const parts = {};
  groups.forEach((token, k) => { parts[token[0]] = token === "YY" ? `20${match[k + 1]}` : match[k + 1]; });
  if (!parts.Y || !parts.M || !parts.D) return null;
  const key = `${parts.Y}-${memoPad(parts.M)}-${memoPad(parts.D)}`;
  return dateKey(memoKeyToDay(key)) === key ? key : null;
}

function memoYaml(value) {
  return JSON.stringify(String(value));
}

function buildAnksMemoFile({ date, topic, contract, now = new Date() }) {
  const routing = contract?.routing?.[MEMO_CAPTURE_TYPE];
  if (!contract?.contract || !routing) throw new Error(tr(`ANKS 采集合约里没有 ${MEMO_CAPTURE_TYPE} 类型，请先在 ${ANKS_CAPTURE_CONTRACT_PATH} 登记`, `The ANKS capture contract has no ${MEMO_CAPTURE_TYPE} type. Register it in ${ANKS_CAPTURE_CONTRACT_PATH} first`));
  const hex = Math.floor(Math.random() * 0x10000).toString(16).toUpperCase().padStart(4, "0");
  const lines = [
    "---",
    `id: ${memoYaml(`RAW-${date.replace(/-/g, "")}-MEMO-${hex}`)}`,
    "type: raw",
    `topic: ${memoYaml(topic)}`,
    `owner: ${memoYaml(`topic:${topic}`)}`,
    `capture_type: ${MEMO_CAPTURE_TYPE}`,
    `capture_contract: ${contract.contract}`,
    `source_title: ${memoYaml(`${date} 速记`)}`,
    `clipped_at: ${memoYaml(now.toISOString())}`,
    ...Object.entries(routing).map(([k, v]) => `${k}: ${v}`),
    `memo_date: ${memoYaml(date)}`,
    "---",
    "",
    `# ${date} 速记`,
    "",
  ];
  return lines.join("\n");
}

/** 把一行拆成普通文本与可点击标签，只认 extractMemoTags 认可的标签。 */
function splitMemoLine(line, tags) {
  const pieces = [];
  const re = /(^|\s)#([^\s#`]+)/g;
  let last = 0;
  let match;
  while ((match = re.exec(line))) {
    const name = match[2].replace(/[，。,.;；:：!！?？)）\]]+$/, "");
    if (!tags.includes(name)) continue;
    const at = match.index + match[1].length;
    if (at > last) pieces.push({ text: line.slice(last, at) });
    pieces.push({ tag: name });
    last = at + 1 + name.length;
  }
  if (last < line.length) pieces.push({ text: line.slice(last) });
  return pieces;
}

function buildMemoQuestionNote({ memo, topic, folder, now = new Date() }) {
  const title = memoSafeTitle(memo.text);
  const date = dateKey(now);
  const id = `QST-${date.replace(/-/g, "")}-${memoPad(now.getHours())}${memoPad(now.getMinutes())}${memoPad(now.getSeconds())}`;
  const source = memo.path.replace(/\.md$/, "");
  const content = [
    "---",
    "type: question",
    `id: ${memoYaml(id)}`,
    `topic: ${memoYaml(topic)}`,
    "status: backlog",
    `created: ${date}`,
    `updated: ${date}`,
    `owner: ${memoYaml(`topic:${topic}`)}`,
    "confidence: n/a",
    "priority: medium",
    "related_ids: []",
    "---",
    "",
    `# ${title}`,
    "",
    `> [!quote] 来自速记 [[${source}]] ${memo.date} ${memo.time}`,
    ...memo.text.split("\n").map((l) => `> ${l}`),
    "",
    "## 为什么重要",
    "",
    "## 当前理解",
    "",
    "## 什么证据可以解决它",
    "",
    "## 研究日志",
    "",
  ].join("\n");
  return { path: `${folder}/${title}.md`, title, id, content };
}

function buildMemoNote({ memo, folder }) {
  const title = memoSafeTitle(memo.text);
  const source = memo.path.replace(/\.md$/, "");
  const content = [
    tr(`> [!quote] 来自速记 [[${source}]] ${memo.date} ${memo.time}`, `> [!quote] From memo [[${source}]] ${memo.date} ${memo.time}`),
    ...memo.text.split("\n").map((l) => `> ${l}`),
    "",
    "",
  ].join("\n");
  const dir = String(folder || "").replace(/^\/+|\/+$/g, "");
  return { path: `${dir ? `${dir}/` : ""}${title}.md`, title, content };
}

/** 从 dir 文件夹出发解析 ./、../ 开头的相对路径，得到库内路径；跳出库根返回 null。 */
function memoResolveRelative(dir, linkpath) {
  const parts = dir ? dir.split("/") : [];
  for (const seg of linkpath.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { if (!parts.length) return null; parts.pop(); } else parts.push(seg);
  }
  return parts.join("/") || null;
}

/** 相对路径：从 fromDir 文件夹到 toPath。 */
function memoRelativePath(fromDir, toPath) {
  const from = fromDir ? fromDir.split("/") : [];
  const to = toPath.split("/");
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  return [...from.slice(i).map(() => ".."), ...to.slice(i)].join("/");
}

/** 速记正文搬进别的笔记时，相对路径的链接（附件位置设为「相对当前笔记」时生成的）从新位置解析不到：改成从新位置出发的相对路径。
    最短路径、库内完整路径这类到哪都能解析的链接，以及网址和行内代码里的示例，保持原样。
    resolve(linkpath, fromPath) 返回链接解析到的文件路径，解析不到返回 null。 */
function memoRelinkText(text, sourcePath, targetPath, resolve) {
  const dir = targetPath.includes("/") ? targetPath.slice(0, targetPath.lastIndexOf("/")) : "";
  const moved = (linkpath) => {
    const hit = linkpath && resolve(linkpath, sourcePath);
    if (!hit || resolve(linkpath, targetPath) === hit) return null;
    return memoRelativePath(dir, hit);
  };
  const relinkLine = (line) => line.split(/(`[^`\n]*`)/).map((part, i) => (i % 2 ? part : part
    .replace(/(!?\[\[)([^\]|#\n]+)([^\]\n]*\]\])/g, (all, open, linkpath, rest) => {
      const next = moved(linkpath.trim());
      return next ? `${open}${next}${rest}` : all;
    })
    .replace(/(!?\[[^\]\n]*\]\()(<[^>\n]+>|[^)\s]+)((?:\s+"[^"\n]*")?\))/g, (all, open, raw, rest) => {
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return all;
      const wrapped = raw.startsWith("<");
      let target = wrapped ? raw.slice(1, -1) : raw;
      const hashAt = target.indexOf("#");
      const sub = hashAt >= 0 ? target.slice(hashAt) : "";
      if (hashAt >= 0) target = target.slice(0, hashAt);
      let decoded = target;
      try { decoded = decodeURI(target); } catch (_) { /* 不是合法编码，按原文解析 */ }
      const next = moved(decoded);
      if (!next) return all;
      return `${open}${wrapped ? `<${next}${sub}>` : `${next.replace(/ /g, "%20")}${sub}`}${rest}`;
    }))).join("");
  // 围栏代码块里的示例保持原样（引用块里的围栏也算）
  const lines = String(text ?? "").split("\n");
  const fenced = memoFencedLines(lines.map((line) => line.replace(/^(?:[ \t]*>)*[ \t]?/, "")));
  return lines.map((line, k) => (fenced.has(k) ? line : relinkLine(line))).join("\n");
}

function buildMemoNowLine(memo) {
  const first = memo.text.split("\n").map((l) => l.trim()).find(Boolean) || "速记";
  return `- [ ] ${first} [[${memo.path.replace(/\.md$/, "")}]]`;
}

/* ---------- flomo 核心：搜索筛选、标签树、标签改名、每日回顾、去年今日、URL 入口 ---------- */

const MEMO_TAG_TAIL = "(?=$|[\\s/，。,.;；:：!！?？)）\\]])";

/** 正文里还没有这个标签就接在末尾。 */
function memoWithTag(text, tag) {
  if (new RegExp(`(^|\\s)#${escapeRegExp(tag)}${MEMO_TAG_TAIL}`).test(text)) return text;
  return `${text.replace(/\s+$/, "")} #${tag}`;
}

function memoHasTag(memo, tag) {
  return memo.tags.some((t) => t === tag || t.startsWith(`${tag}/`));
}

const MEMO_IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|heic|heif|tiff?)$/i;
const MEMO_WIKI_EMBED_RE = /!\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;
const MEMO_MD_IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g;

/** 速记里是否有图片：wiki 嵌入的图片文件或 Markdown 图片。 */
function memoHasImage(text) {
  const s = memoStripCode(text);
  for (const m of s.matchAll(MEMO_WIKI_EMBED_RE)) if (MEMO_IMAGE_EXT_RE.test(m[1].trim())) return true;
  return new RegExp(MEMO_MD_IMAGE_RE.source).test(s);
}

/** 速记正文里是否有链接：双链、网址或 Markdown 链接；图片、语音嵌入和代码里的不算，转化回链不在正文里。 */
function memoHasLink(text) {
  const s = memoStripCode(text)
    .replace(MEMO_WIKI_EMBED_RE, (all, target) => (MEMO_IMAGE_EXT_RE.test(target.trim()) || MEMO_AUDIO_EXT_RE.test(target.trim()) ? "" : all))
    .replace(MEMO_MD_IMAGE_RE, "");
  return /\[\[[^\]]+\]\]|https?:\/\/\S|\[[^\]]+\]\([^)]+\)/.test(s);
}

const MEMO_AUDIO_EXT_RE = /\.(webm|m4a|mp3|wav|ogg|oga|aac|flac|3gp)$/i;

/** 速记里是否有语音：嵌入的音频文件。 */
function memoHasAudio(text) {
  return memoAudioLinks(text).length > 0;
}

/** 去掉围栏代码块和行内代码：里面的嵌入、链接是示例。 */
function memoStripCode(text) {
  return String(text ?? "").replace(/(`{3,}|~{3,})[^\n]*\n[\s\S]*?\1/g, "").replace(/`[^`\n]*`/g, "");
}

function memoAudioLinks(text) {
  const clean = memoStripCode(text);
  const links = [...clean.matchAll(MEMO_WIKI_EMBED_RE)].map((m) => m[1].trim());
  for (const m of clean.matchAll(/!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\s*\)/g)) {
    let link = m[1] || m[2];
    try { link = decodeURIComponent(link); } catch (_) { /* preserve invalid escapes */ }
    if (!/^[a-z]+:\/\//i.test(link)) links.push(link.split("#")[0]);
  }
  return [...new Set(links.filter((link) => MEMO_AUDIO_EXT_RE.test(link)))];
}

/**
 * 轻点 / 长按区分：按住超过 delay 触发 onHoldStart（返回 false 表示不接管，松开后照常当轻点），
 * 松开、系统打断触摸或丢失指针捕获时 onHoldEnd；长按后浏览器补发的 click 被吞掉，不会再触发轻点。
 */
function bindHoldPress(el, { delay = 350, onTap, onHoldStart, onHoldEnd, setTimeout: later = (fn, ms) => window.setTimeout(fn, ms), clearTimeout: cancel = (id) => window.clearTimeout(id) }) {
  let timer = null;
  let pressed = false;
  let holding = false;
  let swallowClick = false;
  const end = () => {
    if (timer !== null) { cancel(timer); timer = null; }
    pressed = false;
    if (!holding) return;
    holding = false;
    swallowClick = true;
    onHoldEnd();
  };
  el.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    pressed = true;
    swallowClick = false;
    // 手指滑出按钮也要收到松开
    try { el.setPointerCapture?.(event.pointerId); } catch (_) { /* 不支持指针捕获时照常工作 */ }
    timer = later(() => {
      timer = null;
      if (pressed) holding = onHoldStart() !== false;
    }, delay);
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) el.addEventListener(type, end);
  el.addEventListener("click", (event) => {
    if (swallowClick) { swallowClick = false; event.preventDefault?.(); return; }
    onTap(event);
  });
  // 长按不弹 iOS 的系统菜单，也不弹右键菜单
  el.addEventListener("contextmenu", (event) => event.preventDefault());
}

/** Tempo 任务标题：取第一行有内容的文字，去掉图片 / 录音嵌入、标签和 Markdown 标记；空的就用速记时间。 */
function memoTaskTitle(text, { date = "", time = "" } = {}) {
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw
      .replace(/!\[\[[^\]]*\]\]/g, "").replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2").replace(/\[\[([^\]]+)\]\]/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/(^|\s)#[^\s#]+/g, "$1")
      .replace(/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|#{1,6}\s+|>\s*)/, "")
      .replace(/(\*\*|__|~~|==|`)/g, "")
      .replace(/\s+/g, " ").trim();
    if (line) return line.length > 60 ? `${line.slice(0, 60)}…` : line;
  }
  return tr(`速记 ${date} ${time}`, `Memo ${date} ${time}`).trim();
}

/** 卡片上 Tempo 任务的状态文字；任务在 Tempo 里删掉了也要说清楚。 */
function memoTempoLabel(task) {
  if (!task) return tr("任务已删除", "Task deleted");
  return { todo: tr("待办", "To do"), in_progress: tr("进行中", "In progress"), waiting: tr("等待中", "Waiting"), done: tr("已完成", "Done"), canceled: tr("已取消", "Canceled") }[task.status] || tr("待办", "To do");
}

/** 速记里是否已有这段录音的转写。路径一致才算；录音被资产整理挪到别的文件夹时，凭据里的旧路径已不存在，
    且速记里只有这一段同名、还没有凭据的录音，才按文件名认。不同目录的同名录音各算各的。
    audioPaths：速记里现有录音的路径；exists：库里是否还有这个路径。 */
function memoHasTranscriptFor(memo, filePath, { audioPaths = null, exists = null } = {}) {
  const receipts = memo.transcriptAudio || [];
  if (receipts.includes(filePath)) return true;
  const name = String(filePath || "").split("/").pop();
  const current = audioPaths || [filePath];
  const moved = receipts.some((p) => p.split("/").pop() === name && !current.includes(p) && !(exists ? exists(p) : true));
  if (!moved) return false;
  return current.filter((p) => p.split("/").pop() === name && !receipts.includes(p)).length === 1;
}

/** ASR 给出的失败原因：已知的服务商错误换成能照着做的说明，原文放进「详细错误」。
    已经是说明文字的（比如 ASR 自己的中文提示）原样显示。 */
function memoAsrErrorInfo(raw) {
  const detail = String(raw || "").trim();
  if (!detail) return { text: "", detail: "" };
  const rules = [
    [/20000003|no valid speech|no speech|silence audio|服务返回了空结果/i, tr("录音里没有识别到说话声，录音已保留。如果录的时候说了话，请检查麦克风权限和输入设备后重试", "No speech was detected in the recording; the recording was kept. If you did speak, check microphone permissions and the input device, then try again")],
    [/\b(401|403)\b|unauthori[sz]ed|forbidden|invalid[ _-]?(api[ _-]?key|token|credential)/i, tr("语音识别服务拒绝了请求，请在 Crisp ASR 设置里检查 API Key 是否正确、是否过期", "The speech recognition service rejected the request. Check in Crisp ASR settings that the API key is correct and has not expired")],
    [/\b429\b|quota|rate[ _-]?limit|too many requests|insufficient[ _-]?balance/i, tr("语音识别服务额度不足或请求太频繁，请稍后重试，或到服务商后台查看额度", "The speech recognition quota ran out or requests were too frequent. Try again later, or check your quota with the provider")],
    [/timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|network error|fetch failed|socket hang up/i, tr("连不上语音识别服务，请检查网络后重试", "Cannot reach the speech recognition service. Check your network and try again")],
  ];
  for (const [re, text] of rules) if (re.test(detail)) return { text, detail };
  return { text: detail, detail: "" };
}

/** 复盘里的速记转化：这段时间记了多少，有多少转成了任务、笔记或行动，任务完成了多少。
    同一条速记（按隐藏标识）只算一次；重新转过的任务按 Tempo 里现在的那条算。条数只用来找值得回看的内容，不代表知识质量。 */
function memoConversionReview(memos, start, end, tempoSnapshots = null) {
  const seen = new Set();
  const inPeriod = [];
  for (const m of memos || []) {
    if (!m?.date || m.date < start || m.date > end) continue;
    const key = m.id || `${m.path}:${m.date} ${m.time}:${m.startLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    inPeriod.push(m);
  }
  const nowPrefix = `${ANKS_NOW_FILE.replace(/\.md$/, "")}#`;
  const out = { total: inPeriod.length, converted: 0, toTasks: 0, tasksDone: 0, tasksOpen: 0, tasksMissing: 0, tasksUnknown: 0, toNotes: 0, toNow: 0, transcribed: 0, results: [], pending: [] };
  const results = new Map();
  for (const m of inPeriod) {
    const notes = (m.links || []).filter((link) => !link.startsWith(nowPrefix));
    const now = (m.links || []).some((link) => link.startsWith(nowPrefix));
    const task = m.tempoTasks?.length ? (tempoSnapshots ? tempoSnapshots[`crisp-pulse:${m.id}`] || null : undefined) : undefined;
    if (m.tempoTasks?.length) {
      out.toTasks++;
      if (task === undefined) out.tasksUnknown++;
      else if (task === null) out.tasksMissing++;
      else if (task.status === "done") out.tasksDone++;
      else if (task.status !== "canceled") out.tasksOpen++;
    }
    if (notes.length) out.toNotes++;
    if (now) out.toNow++;
    if (m.transcriptJobs?.length) out.transcribed++;
    if (notes.length || now || m.tempoTasks?.length) out.converted++;
    else out.pending.push(m);
    for (const link of notes) if (!results.has(link)) results.set(link, { link, path: m.path, date: m.date, text: memoTaskTitle(m.text) });
    if (task?.status === "done") results.set(`tempo:${task.id}`, { task, path: m.path, date: m.date, text: task.title || memoTaskTitle(m.text) });
  }
  out.results = [...results.values()].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  out.pending.sort((a, b) => `${b.date} ${b.time || ''}`.localeCompare(`${a.date} ${a.time || ''}`));
  return out;
}

/** 录音卡片上转写按钮的状态。「已转写」只认速记里的隐藏凭据：用户删掉转写段落后可以重新转。 */
function memoTranscriptionState({ memo, job, starting = false, hasAsr = true, filePath, audioPaths = null, exists = null }) {
  const complete = memoHasTranscriptFor(memo, filePath, { audioPaths, exists }) || !!(job && memo.transcriptJobs?.includes(job.id));
  const live = job && job.status !== "completed" && job.status !== "failed";
  const labels = { queued: tr("排队中", "Queued"), preparing: tr("准备中", "Preparing"), transcribing: job?.transcriptText ? tr("写回中", "Writing back") : tr("转写中", "Transcribing"), "retry-wait": tr("等待重试", "Waiting to retry"), failed: job?.transcriptText ? tr("重试写回", "Retry write-back") : tr("重试转写", "Retry transcription") };
  const label = complete ? tr("已转写", "Transcribed") : starting ? tr("提交中", "Submitting") : (live || job?.status === "failed") ? labels[job.status] || tr("转写中", "Transcribing") : tr("转文字", "Transcribe");
  const failure = !complete && job?.status === "failed" ? memoAsrErrorInfo(job.lastError || tr("转写失败", "Transcription failed")) : { text: "", detail: "" };
  return { label, complete, disabled: !hasAsr || starting || complete || !!live, error: failure.text, errorDetail: failure.detail };
}

function memoAudioFiles(memo, app) {
  const files = new Map();
  for (const link of memoAudioLinks(memo.text)) {
    const file = app.metadataCache.getFirstLinkpathDest?.(link, memo.path) || app.vault.getAbstractFileByPath(link);
    if (file && MEMO_AUDIO_EXT_RE.test(file.path)) files.set(file.path, file);
  }
  return [...files.values()];
}

function memoStamp(now) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** 录音文件名：扩展名跟随浏览器实际录出的格式（桌面多为 webm，iOS 为 m4a）。 */
function memoRecordingName(mime, now = new Date()) {
  const ext = /mp4|aac|m4a/.test(mime || "") ? "m4a" : /ogg/.test(mime || "") ? "ogg" : "webm";
  return `录音 ${memoStamp(now)}.${ext}`;
}

/** 附件文件名：剪贴板截图没有像样的名字，按 Obsidian 的习惯命名为 Pasted image 时间戳。 */
function memoAttachmentName(name, type, now = new Date()) {
  const clean = String(name || "").replace(/[\\/:*?"<>|#^\[\]]/g, "-").trim();
  if (clean && !/^image\.\w+$/i.test(clean)) return clean;
  const ext = (/image\/(\w+)/.exec(type || "")?.[1] || "png").replace("jpeg", "jpg").replace("svg+xml", "svg");
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `Pasted image ${stamp}.${ext}`;
}

function filterMemos(memos, { query = "", from = "", to = "", includeTags = [], excludeTags = [], untagged = false, converted = null, hasLink = false, hasImage = false, hasAudio = false, onThisDay = "" } = {}) {
  const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  return memos.filter((m) => {
    if (from && m.date < from) return false;
    if (to && m.date > to) return false;
    if (untagged && m.tags.length) return false;
    if (includeTags.length && !includeTags.some((t) => memoHasTag(m, t))) return false;
    if (excludeTags.some((t) => memoHasTag(m, t))) return false;
    const isConverted = m.links.length > 0 || !!m.tempoTasks?.length;
    if (converted === true && !isConverted) return false;
    if (converted === false && isConverted) return false;
    if (hasLink && !memoHasLink(m.text)) return false;
    if (hasImage && !memoHasImage(m.text)) return false;
    if (hasAudio && !memoHasAudio(m.text)) return false;
    // 那年今日：往年的同月同日
    if (onThisDay && !(m.date.slice(5) === onThisDay.slice(5) && m.date < onThisDay.slice(0, 4))) return false;
    if (terms.length) {
      const text = m.text.toLowerCase();
      if (!terms.every((term) => text.includes(term))) return false;
    }
    return true;
  });
}

function buildTagTree(memos) {
  const root = { children: new Map() };
  for (const m of memos) {
    const touched = new Set();
    for (const tag of m.tags) {
      const parts = tag.split("/").filter(Boolean);
      for (let i = 1; i <= parts.length; i++) touched.add(parts.slice(0, i).join("/"));
    }
    for (const path of touched) {
      let node = root;
      const parts = path.split("/");
      parts.forEach((name, i) => {
        const key = parts.slice(0, i + 1).join("/");
        if (!node.children.has(name)) node.children.set(name, { name, path: key, count: 0, children: new Map() });
        node = node.children.get(name);
      });
      node.count++;
    }
  }
  const finish = (map) => [...map.values()]
    .map((n) => ({ name: n.name, path: n.path, count: n.count, children: finish(n.children) }))
    .sort((a, b) => b.count - a.count);
  return finish(root.children);
}

function validTagName(tag) {
  return typeof tag === "string" && /^[^\s#`]+$/.test(tag) && !/^\d+$/.test(tag) && !tag.startsWith("/") && !tag.endsWith("/");
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renameTagInText(text, from, to) {
  if (!validTagName(from) || !validTagName(to)) throw new Error(tr("标签名不能为空，也不能包含空格、# 或反引号", "Tag names cannot be empty or contain spaces, # or backticks"));
  const re = new RegExp(`(^|\\s)#${escapeRegExp(from)}${MEMO_TAG_TAIL}`, "g");
  // 行内代码里的 # 不是标签：只改反引号外面的片段
  return String(text).split(/(`[^`]*`)/).map((part) => (part.startsWith("`") ? part : part.replace(re, (_, lead) => `${lead}#${to}`))).join("");
}

function renameTagInContent(content, from, to) {
  const lines = String(content ?? "").split("\n");
  let changed = 0;
  for (const m of parseMemoBlocks(content)) {
    let touched = false;
    // 速记里的围栏代码块原样保留：和 extractMemoTags 一样只认代码块外面的标签
    const fenced = memoFencedLines(lines.slice(m.startLine + 1, m.endLine + 1).map((line) => line.replace(/^>\s?/, "")));
    for (let i = m.startLine + 1; i <= m.endLine; i++) {
      if (fenced.has(i - m.startLine - 1)) continue;
      const match = /^(>\s?)(.*)$/.exec(lines[i]);
      if (!match || MEMO_LINK_RE.test(match[2].trim())) continue;
      const next = renameTagInText(match[2], from, to);
      if (next !== match[2]) { lines[i] = match[1] + next; touched = true; }
    }
    if (touched) changed++;
  }
  return { content: lines.join("\n"), changed };
}

function memoHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function memoDaysBefore(todayKey, days) {
  const d = memoKeyToDay(todayKey);
  d.setDate(d.getDate() - days);
  return dateKey(d);
}

/** 每日回顾：以日期为种子挑选，同一天打开结果不变；不含今天的速记。 */
function selectDailyReview(memos, todayKey, { count = 6, tags = [], withinDays = 0, batch = 0 } = {}) {
  const n = Math.max(1, Math.min(24, Number(count) || 6));
  const earliest = withinDays > 0 ? memoDaysBefore(todayKey, withinDays) : "";
  return memos
    .filter((m) => m.date < todayKey && (!earliest || m.date >= earliest) && (!tags.length || tags.some((t) => memoHasTag(m, t))))
    .map((m) => ({ m, score: memoHash(`${todayKey}#${batch}|${m.path}|${m.date} ${m.time}|${m.text}`) }))
    .sort((a, b) => a.score - b.score)
    .slice(0, n)
    .map((x) => x.m);
}

function onThisDay(memos, todayKey) {
  const groups = [];
  const today = memoKeyToDay(todayKey);
  const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, today.getDate());
  if (lastMonth.getDate() === today.getDate()) {
    const key = dateKey(lastMonth);
    const list = memos.filter((m) => m.date === key);
    if (list.length) groups.push({ label: tr("上月今日", "A month ago today"), date: key, memos: list });
  }
  const md = todayKey.slice(5);
  const years = new Map();
  for (const m of memos) {
    if (m.date.slice(5) !== md || m.date >= todayKey) continue;
    const ago = today.getFullYear() - Number(m.date.slice(0, 4));
    if (!years.has(ago)) years.set(ago, []);
    years.get(ago).push(m);
  }
  for (const ago of [...years.keys()].sort((a, b) => a - b)) {
    groups.push({ label: tr(`${ago} 年前`, `${plural(ago, "year")} ago`), date: years.get(ago)[0].date, memos: years.get(ago) });
  }
  return groups;
}

function parseMemoUrlParams(params = {}) {
  let text = String(params.text ?? "").replace(/\r\n?/g, "\n").trim();
  const open = ["1", "true", "yes"].includes(String(params.open ?? "").toLowerCase());
  if (!text) return { text: "", open: true };
  const existing = extractMemoTags(text);
  const extra = String(params.tags ?? "").split(/[,，\s]+/).map((t) => t.replace(/^#+/, "").trim()).filter((t) => validTagName(t) && !existing.includes(t));
  if (extra.length) text = `${text} ${extra.map((t) => `#${t}`).join(" ")}`;
  return { text, open };
}

/* ---------- 相关笔记与随机漫步：纯本地 TF-IDF，中文双字切分；不联网、不接 AI ---------- */

const MEMO_CJK_RUN = /[㐀-鿿豈-﫿]+/g;

function tokenizeMemo(memo) {
  const body = String(memo.text || "")
    .replace(/(^|\s)#[^\s#`]+/g, " ")
    .replace(/\[\[[^\]]*\]\]/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .toLowerCase();
  const tokens = [];
  for (const run of body.match(MEMO_CJK_RUN) || []) {
    for (let i = 0; i + 1 < run.length; i++) tokens.push(run.slice(i, i + 2));
  }
  for (const word of body.replace(MEMO_CJK_RUN, " ").match(/[a-z0-9][a-z0-9_-]+/g) || []) tokens.push(word);
  for (const tag of memo.tags || []) {
    const parts = tag.split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) tokens.push(`#${parts.slice(0, i).join("/")}`);
  }
  return tokens;
}

function buildMemoIndex(memos) {
  const docs = memos.map((m) => {
    const tf = new Map();
    for (const t of tokenizeMemo(m)) tf.set(t, (tf.get(t) || 0) + 1);
    return tf;
  });
  const df = new Map();
  for (const tf of docs) for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const n = memos.length || 1;
  const vectors = docs.map((tf) => {
    const v = new Map();
    let norm = 0;
    for (const [t, c] of tf) {
      const w = (1 + Math.log(c)) * Math.log(1 + n / df.get(t)) * (t.startsWith("#") ? 2 : 1);
      v.set(t, w);
      norm += w * w;
    }
    return { v, norm: Math.sqrt(norm) || 1 };
  });
  return { memos, vectors, pos: new Map(memos.map((m, i) => [m, i])) };
}

function relatedMemos(memo, index, { limit = 5, minScore = 0.1 } = {}) {
  const i = index.pos.get(memo);
  if (i === undefined) return [];
  const a = index.vectors[i];
  const out = [];
  index.vectors.forEach((b, j) => {
    if (j === i) return;
    let dot = 0;
    const shared = [];
    const [small, large] = a.v.size <= b.v.size ? [a.v, b.v] : [b.v, a.v];
    for (const [t, w] of small) {
      const other = large.get(t);
      if (other === undefined) continue;
      dot += w * other;
      shared.push([t, w * other]);
    }
    const score = dot / (a.norm * b.norm);
    if (score >= minScore) out.push({ memo: index.memos[j], score, shared: explainShared(memo, shared.sort((x, y) => y[1] - x[1]).slice(0, 8).map((s) => s[0])) });
  });
  return out.sort((x, y) => y.score - x.score).slice(0, limit);
}

/** 把共同的中文双字按原文拼回完整片段（卡片/片笔/笔记 → 卡片笔记），标签与英文词原样保留，最多 3 个。 */
function explainShared(memo, tokens, limit = 3) {
  const set = new Set(tokens);
  const phraseOf = new Map();
  const body = String(memo.text || "").replace(/(^|\s)#[^\s#`]+/g, " ").toLowerCase();
  for (const run of body.match(MEMO_CJK_RUN) || []) {
    let start = -1;
    for (let i = 0; i <= run.length - 1; i++) {
      const hit = i + 1 < run.length && set.has(run.slice(i, i + 2));
      if (hit && start < 0) start = i;
      if (!hit && start >= 0) {
        const phrase = run.slice(start, i + 1);
        for (let k = start; k < i; k++) if (!phraseOf.has(run.slice(k, k + 2))) phraseOf.set(run.slice(k, k + 2), phrase);
        start = -1;
      }
    }
  }
  const out = [];
  for (const t of tokens) {
    const label = phraseOf.get(t) || t;
    if (!out.includes(label)) out.push(label);
    if (out.length >= limit) break;
  }
  return out;
}

/** 漫步一步：在前三条未走过的相关速记里随机挑一条；没有相关的就随机跳到一条没走过的。 */
function walkStep(current, index, visited, rng = Math.random) {
  const related = relatedMemos(current, index, { limit: 10 }).filter((r) => !visited.has(r.memo));
  if (related.length) {
    const pick = related[Math.min(related.length, 3) > 1 ? Math.floor(rng() * Math.min(related.length, 3)) : 0];
    return { memo: pick.memo, via: "related", shared: pick.shared, score: pick.score };
  }
  const rest = index.memos.filter((m) => !visited.has(m));
  if (!rest.length) return null;
  return { memo: rest[Math.min(rest.length - 1, Math.floor(rng() * rest.length))], via: "random", shared: [], score: 0 };
}

function pickRandomMemo(memos, rng = Math.random) {
  if (!memos.length) return null;
  return memos[Math.min(memos.length - 1, Math.floor(rng() * memos.length))];
}

function memoSafeTitle(text) {
  const first = String(text ?? "").split("\n").map((l) => l.trim()).find(Boolean) || tr("速记", "Memo");
  return first.replace(/#[^\s#]+/g, "").replace(/[\\/:*?"<>|#^\[\]]/g, "-").replace(/\s+/g, " ").trim().slice(0, 40) || tr("速记", "Memo");
}

const MEMO_TRASH_DAYS = 30;
const MEMO_DRAFT_SAVE_DELAY = 500;
// 松开听写后识别服务一直不回定稿：等这么久就按已识别的文字结束，输入框不再一直锁着
const MEMO_DICTATION_FINALIZE_TIMEOUT = 10000;

/** 输入框里还没提交的草稿和没存进库的录音，存在插件目录（memo-drafts.json、memo-pending/）。
    关闭面板、停用重载、退出重开后能找回；每个速记面板按自己的标签页分开存，不互相覆盖。
    文件损坏时只读不写，免得把能修复的内容覆盖掉。 */
// 同一个草稿文件在所有插件实例之间共用一条写入队列（挂在 vault adapter 上，插件重载后仍是同一个对象）：
// 卸载前已经开始的写入落盘之后，新实例才读取和写入
const MEMO_DRAFT_WRITES = Symbol.for("crisp-pulse.memo-drafts.writes");
// 草稿归属（哪个面板接手了哪份草稿）和还在存进库的附件，同样挂在 adapter 上跨实例共用：
// 插件重载后，新面板仍知道旧面板的附件没存好，提交照样要等
const MEMO_DRAFT_SHARED = Symbol.for("crisp-pulse.memo-drafts.shared");

class MemoDraftStore {
  constructor(adapter, dir) {
    this.adapter = adapter;
    this.path = dir ? `${dir}/memo-drafts.json` : null;
    this.pendingDir = dir ? `${dir}/memo-pending` : null;
    this.drafts = {};
    this.recordings = [];
    this.listeners = new Set();
    this.broken = false;
    this.timer = null;
    this.writing = Promise.resolve();
    this.lastPayload = null;
    const shared = this.sharedState();
    // 关掉的面板 → 接手它草稿的面板；面板关掉后才存好的附件链接据此找到去处
    this.claimedBy = shared?.claimedBy || new Map();
    // 还在存进库的附件（录音从开始录到存好、重试保存、图片），按发起的面板记：接手草稿的面板也要等它们存好再提交
    this.pendingAttachments = shared?.pending || new Map();
    shared?.stores.add(this);
  }

  sharedState() {
    const adapter = this.adapter;
    if (!adapter || typeof adapter !== "object" || !this.path) return null;
    try {
      const all = adapter[MEMO_DRAFT_SHARED] ||= new Map();
      if (!all.has(this.path)) all.set(this.path, { claimedBy: new Map(), pending: new Map(), stores: new Set() });
      return all.get(this.path);
    } catch (_) { return null; }
  }

  beginAttachment(key) {
    this.pendingAttachments.set(key, (this.pendingAttachments.get(key) || 0) + 1);
    this.attachmentsChanged();
  }

  endAttachment(key) {
    const n = (this.pendingAttachments.get(key) || 0) - 1;
    if (n > 0) this.pendingAttachments.set(key, n); else this.pendingAttachments.delete(key);
    this.attachmentsChanged();
  }

  /** 附件状态是共用的：重载前旧实例的附件存好了，新实例的面板也要刷新提交按钮。 */
  attachmentsChanged() {
    for (const store of new Set([this, ...(this.sharedState()?.stores || [])])) store.changed();
  }

  /** 草稿现归这个面板的附件（不论哪个面板、哪个插件实例发起）还有几个没存好。 */
  pendingFor(key) {
    let n = 0;
    for (const [origin, count] of this.pendingAttachments) if (this.currentKey(origin) === key) n += count;
    return n;
  }

  /** 这份草稿现在归哪个面板（被接手过就顺着找到最后接手的那个）。 */
  currentKey(key) {
    const seen = new Set();
    while (this.claimedBy.has(key) && !seen.has(key)) { seen.add(key); key = this.claimedBy.get(key); }
    return key;
  }

  /** 接到某份草稿末尾（那个面板已经关了）。重载后新实例可能还没读过恢复文件，先读再接，免得拿空草稿覆盖。 */
  appendDraft(key, text) {
    if (!this.loaded) return this.load().then(() => this.appendDraft(key, text));
    const prev = this.drafts[key]?.text || "";
    this.setDraft(key, `${prev ? `${prev.replace(/\s+$/, "")}\n` : ""}${text}\n`);
    return this.flush();
  }

  writeQueue() {
    const adapter = this.adapter;
    if (!adapter || typeof adapter !== "object") return null;
    try { return adapter[MEMO_DRAFT_WRITES] ||= new Map(); } catch (_) { return null; }
  }

  load() {
    this.ready ||= (async () => {
      await this.writeQueue()?.get(this.path);
      try {
        if (!this.path || !this.adapter || !(await this.adapter.exists(this.path))) return;
        const raw = await this.adapter.read(this.path);
        const data = JSON.parse(raw);
        if (data?.version !== 1 || typeof data.drafts !== "object" || !data.drafts || Array.isArray(data.drafts) || !Array.isArray(data.recordings)) throw new Error(tr("格式不对", "Invalid format"));
        for (const [key, entry] of Object.entries(data.drafts)) {
          const updatedAt = Number(entry?.updatedAt) || 0;
          // 读完之前内存里已经有的草稿（比文件里的新）保留，不被旧内容盖掉
          if (typeof entry?.text === "string" && entry.text.trim() && !((this.drafts[key]?.updatedAt || 0) > updatedAt)) this.drafts[key] = { text: entry.text, updatedAt };
        }
        for (const r of data.recordings) {
          if (this.recordings.some((x) => x.id === r?.id)) continue;
          if (!r || !/^[a-zA-Z0-9-]+$/.test(r.id || "") || typeof r.name !== "string" || r.name.includes("/") || typeof r.stash !== "string" || !r.stash.startsWith(`${this.pendingDir}/`)) continue;
          if (!(await this.adapter.exists(r.stash))) continue;
          this.recordings.push({ id: r.id, name: r.name, type: String(r.type || ""), startedAt: String(r.startedAt || ""), stash: r.stash, error: String(r.error || "") });
        }
        this.lastPayload = raw;
      } catch (error) {
        this.broken = true;
        console.warn(`[Crisp Pulse] 速记草稿文件无法读取（${this.path}），本次不再写入草稿`, error);
      } finally {
        this.loaded = true;
      }
    })();
    return this.ready;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  changed() {
    for (const fn of [...this.listeners]) { try { fn(); } catch (error) { console.error(error); } }
  }

  /** 这个面板的草稿；没有就认领一份已关闭面板留下的（最近的那份）。 */
  claimDraft(key, liveKeys = []) {
    if (this.drafts[key]?.text) return this.drafts[key].text;
    const orphan = Object.entries(this.drafts)
      .filter(([k, v]) => k !== key && !liveKeys.includes(k) && v?.text?.trim())
      .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0))[0];
    if (!orphan) return "";
    delete this.drafts[orphan[0]];
    this.drafts[key] = orphan[1];
    this.claimedBy.set(orphan[0], key);
    this.schedule();
    return orphan[1].text;
  }

  setDraft(key, text) {
    if (!key) return;
    if (String(text || "").trim()) this.drafts[key] = { text, updatedAt: Date.now() };
    else if (this.drafts[key]) delete this.drafts[key];
    else return;
    this.schedule();
  }

  /** 插件卸载：把手上的草稿写完，之后不再写入。重载后由新实例的草稿存储接管同一个文件，旧实例迟到的写入会覆盖新草稿。 */
  retire() {
    if (this.retired) return this.writing;
    // 恢复文件还没读完时，读完后的最后一次写入也要落盘，不能被下面的 retired 拦掉
    const done = this.flush({ retiring: true });
    this.retired = true;
    this.sharedState()?.stores.delete(this);
    clearTimeout(this.timer);
    return done;
  }

  schedule() {
    if (this.broken || this.retired || !this.path) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush(); }, MEMO_DRAFT_SAVE_DELAY);
  }

  flush({ retiring = false } = {}) {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.broken || (this.retired && !retiring) || !this.path) return this.writing;
    // 还没读过恢复文件（插件重载后速记面板没打开过）：先读进来再写，否则会拿空壳覆盖整份文件
    if (!this.loaded) return this.load().then(() => this.flush({ retiring }));
    const payload = JSON.stringify({
      version: 1,
      drafts: this.drafts,
      recordings: this.recordings.filter((r) => r.stash).map(({ id, name, type, startedAt, stash, error }) => ({ id, name, type, startedAt, stash, error })),
    }, null, 2);
    if (payload === this.lastPayload) return this.writing;
    this.lastPayload = payload;
    const queue = this.writeQueue();
    this.writing = (queue?.get(this.path) || this.writing).then(async () => {
      await this.adapter.write(this.path, payload);
      if (await this.adapter.read(this.path) !== payload) throw new Error(tr("写入后读回不一致", "Read-back after writing did not match"));
    }).catch((error) => {
      this.lastPayload = null;
      console.warn("[Crisp Pulse] 速记草稿保存失败", error);
      if (!this.warned) { this.warned = true; new Notice(tr(`Crisp Pulse 速记：草稿恢复文件保存失败（${error.message || error}），关闭面板前请先提交或复制草稿`, `Crisp Pulse memos: failed to save the draft recovery file (${error.message || error}). Submit or copy your draft before closing the panel`), 8000); }
    });
    queue?.set(this.path, this.writing);
    return this.writing;
  }

  /** 录音没能存进附件：留在待保存列表，并尽量在插件目录存一份，重载后也能重试。 */
  async keepRecording(rec) {
    await this.load();
    if (!this.recordings.includes(rec)) this.recordings.push(rec);
    if (!rec.stash && this.pendingDir && !this.broken) {
      try {
        if (!(await this.adapter.exists(this.pendingDir))) await this.adapter.mkdir(this.pendingDir);
        const stash = `${this.pendingDir}/${rec.id}-${rec.name}`;
        await this.adapter.writeBinary(stash, rec.data);
        rec.stash = stash;
      } catch (error) {
        console.warn("[Crisp Pulse] 待保存录音暂存失败，只保留在内存里", error);
      }
    }
    await this.flush();
    this.changed();
  }

  async recordingData(rec) {
    if (!rec.data) rec.data = await this.adapter.readBinary(rec.stash);
    return rec.data;
  }

  async dropRecording(rec) {
    await this.load();
    // 重载后新实例读出的是另一个对象，按 id 认
    this.recordings = this.recordings.filter((r) => r !== rec && !(rec.id && r.id === rec.id));
    if (rec.stash) { try { await this.adapter.remove(rec.stash); } catch (_) { /* 暂存文件已不在 */ } }
    await this.flush();
    this.changed();
  }
}


class MemoStore {
  constructor(app, getSettings, momentFn = null, { trashPath = null, onOwnWrite = null } = {}) {
    this.onOwnWrite = onOwnWrite;
    this.app = app;
    this.trashPath = trashPath;
    this.getSettings = getSettings;
    this.momentFn = momentFn;
    // 刚写过的采集件：Obsidian 异步解析 frontmatter，解析完成前靠这里认出 memo_date
    this.capturedSources = new Map();
  }

  settings() {
    return this.getSettings() || {};
  }

  dailyOptions() {
    const s = this.settings();
    const core = this.app.internalPlugins?.getPluginById?.("daily-notes");
    const options = (core?.enabled !== false && core?.instance?.options) || {};
    return {
      folder: s.memoDailyFolder || options.folder || "",
      format: s.memoDailyFormat || options.format || "YYYY-MM-DD",
      template: options.template || "",
    };
  }

  async exists(path) {
    try { return await this.app.vault.adapter.exists(path); } catch (_) { return false; }
  }

  async anksAvailable() {
    if (!(await this.exists("Sidecar/bin/anks"))) return false;
    return this.app.vault.getMarkdownFiles().some((f) => f.path.startsWith("Topics/"));
  }

  async resolveMode() {
    const mode = this.settings().memoMode || "auto";
    if (mode === "general" || mode === "anks") return mode;
    return (await this.anksAvailable()) ? "anks" : "general";
  }

  anksTopics() {
    const topics = new Set();
    for (const f of this.app.vault.getMarkdownFiles()) {
      const m = /^Topics\/([^/]+)\//.exec(f.path);
      if (m) topics.add(m[1]);
    }
    return [...topics].sort();
  }

  /** 用户选的 Topic；只有一个 Topic 时直接用它；多个且没选时返回 null，不替用户挑。 */
  anksTopic() {
    const chosen = String(this.settings().memoAnksTopic || "").trim();
    if (chosen) return chosen;
    const topics = this.anksTopics();
    return topics.length === 1 ? topics[0] : null;
  }

  async readJson(path) {
    if (!(await this.exists(path))) return null;
    try { return JSON.parse(await this.app.vault.adapter.read(path)); } catch (_) { return null; }
  }

  async anksTarget(date, topic = this.anksTopic()) {
    if (!topic) {
      throw new Error(this.anksTopics().length
        ? tr("库里有多个 Topic，请先在速记输入框下方或设置里选择写入哪个 Topic", "The vault has several Topics. Choose which Topic to write to below the memo box or in Settings")
        : tr("库里没有 Topics/<topic>，无法使用 ANKS 模式", "The vault has no Topics/<topic>, so ANKS mode cannot be used"));
    }
    const contract = await this.readJson(ANKS_CAPTURE_CONTRACT_PATH);
    if (!contract) throw new Error(tr(`找不到 ANKS 采集合约 ${ANKS_CAPTURE_CONTRACT_PATH}`, `Cannot find the ANKS capture contract ${ANKS_CAPTURE_CONTRACT_PATH}`));
    const routing = contract.routing?.[MEMO_CAPTURE_TYPE];
    if (!routing) throw new Error(tr(`ANKS 采集合约里没有 ${MEMO_CAPTURE_TYPE} 类型，请先在 ${ANKS_CAPTURE_CONTRACT_PATH} 登记`, `The ANKS capture contract has no ${MEMO_CAPTURE_TYPE} type. Register it in ${ANKS_CAPTURE_CONTRACT_PATH} first`));
    let folder = `Topics/${topic}/raw/inbox/scratch`;
    const route = await this.readJson(ANKS_ROUTE_CONTRACT_PATH);
    const rules = (route?.data || route)?.rules || [];
    const rule = rules.find((r) => r.group === "rules" && r.match?.type === "raw" && Object.entries(routing).every(([k, v]) => r.match?.[k] === v) && Object.keys(r.match).length === Object.keys(routing).length + 1);
    if (rule?.target) folder = rule.target.replace("{topic}", topic);
    return { path: `${folder}/${date} 速记.md`, folder, topic, contract };
  }

  async ensureFolder(folder) {
    const parts = folder.split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join("/");
      if (!this.app.vault.getAbstractFileByPath(p)) {
        try { await this.app.vault.createFolder(p); } catch (_) { /* 并发创建 */ }
      }
    }
  }

  async newDailyContent(date) {
    const { template } = this.dailyOptions();
    if (!template) return "";
    const tplPath = template.endsWith(".md") ? template : `${template}.md`;
    const file = this.app.vault.getAbstractFileByPath(tplPath);
    if (!file || typeof this.app.vault.cachedRead !== "function") return "";
    const raw = await this.app.vault.cachedRead(file);
    const { format } = this.dailyOptions();
    return raw
      .replace(/{{\s*title\s*}}/gi, formatMemoDate(date, format, this.momentFn))
      .replace(/{{\s*date(?::([^}]+))?\s*}}/gi, (_, f) => formatMemoDate(date, (f || format).trim(), this.momentFn))
      .replace(/{{\s*time(?::([^}]+))?\s*}}/gi, (_, f) => (f ? formatMemoDate(date, f.trim(), this.momentFn) : memoClock(date)));
  }

  async capture(text, now = new Date()) {
    if (!String(text ?? "").trim()) throw new Error(tr("速记内容为空", "The memo is empty"));
    return this.writeBlock(buildMemoBlock(text, now), now, (path) => this.onOwnWrite?.(path));
  }

  /** 把一整块速记写进 now 那天的速记文件（没有就按当前模式新建）。 */
  async writeBlock(block, now, beforeWrite = null) {
    const date = dateKey(now);
    const mode = await this.resolveMode();
    const heading = mode === "anks" ? "" : (this.settings().memoHeading ?? MEMO_DEFAULT_HEADING);
    let path;
    let initial;
    if (mode === "anks") {
      const target = await this.anksTarget(date);
      path = target.path;
      if (!this.app.vault.getAbstractFileByPath(path)) {
        await this.ensureFolder(target.folder);
        initial = buildAnksMemoFile({ date, topic: target.topic, contract: target.contract, now });
      }
    } else {
      const options = this.dailyOptions();
      path = dailyNotePath(now, options, this.momentFn);
      if (!this.app.vault.getAbstractFileByPath(path)) {
        const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        if (folder) await this.ensureFolder(folder);
        initial = await this.newDailyContent(now);
      }
    }
    if (beforeWrite) await beforeWrite(path, initial || "", heading);
    if (mode === "anks") this.capturedSources.set(path, date);
    let file = this.app.vault.getAbstractFileByPath(path);
    if (!file) {
      try {
        file = await this.app.vault.create(path, insertMemoBlock(initial || "", block, heading));
        return { path, mode, date };
      } catch (error) {
        file = this.app.vault.getAbstractFileByPath(path);
        if (!file) throw error;
      }
    }
    await this.app.vault.process(file, (content) => insertMemoBlock(content, block, heading));
    return { path, mode, date };
  }

  /** 这一刻记下的速记会写进哪个文件；附件按它算相对位置。 */
  async memoFilePath(now = new Date()) {
    if ((await this.resolveMode()) === "anks") return (await this.anksTarget(dateKey(now))).path;
    return dailyNotePath(now, this.dailyOptions(), this.momentFn);
  }

  /** 图片存进库里（跟随 Obsidian 的附件位置设置），返回可插入速记的嵌入链接。 */
  async saveAttachment(name, data, now = new Date()) {
    const source = await this.memoFilePath(now);
    const fm = this.app.fileManager;
    const path = await fm.getAvailablePathForAttachment(name, source);
    const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (folder) await this.ensureFolder(folder);
    const file = await this.app.vault.createBinary(path, data);
    return `!${fm.generateMarkdownLink(file, source)}`;
  }

  sourceFiles() {
    const options = this.dailyOptions();
    const out = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      const memoDate = fm?.memo_date ? String(fm.memo_date) : null;
      const date = memoDate || dailyDateFromPath(f.path, options, this.momentFn) || this.capturedSources.get(f.path);
      if (date) out.push({ file: f, date });
    }
    return out;
  }

  /** 所有速记。按文件缓存解析结果：文件的修改时间、大小和日期都没变就不再读取和解析，只处理变了的文件。 */
  async list() {
    this.parsed ||= new Map();
    const memos = [];
    const seen = new Set();
    for (const { file, date } of this.sourceFiles()) {
      seen.add(file.path);
      const stat = file.stat;
      const version = Number.isFinite(stat?.mtime) && Number.isFinite(stat?.size) ? `${stat.mtime}:${stat.size}` : null;
      let entry = this.parsed.get(file.path);
      if (!entry || !version || entry.version !== version || entry.date !== date) {
        const content = await this.app.vault.cachedRead(file);
        entry = { version, date, memos: content.includes("[!memo]") ? parseMemoBlocks(content).map((m) => ({ ...m, date, path: file.path })) : [] };
        if (version) this.parsed.set(file.path, entry); else this.parsed.delete(file.path);
      }
      for (const m of entry.memos) memos.push({ ...m });
    }
    for (const path of [...this.parsed.keys()]) if (!seen.has(path)) this.parsed.delete(path);
    return memos.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time) || b.startLine - a.startLine);
  }

  /** 速记正文放进 targetPath 前，把从那里解析不到的相对链接改好。
      ./、../ 开头的明确相对路径按路径计算：原笔记已经删掉、附件暂时不在时也保持指向原来那个位置；其余交给 Obsidian 解析。 */
  relinkFor(text, sourcePath, targetPath) {
    const cache = this.app.metadataCache;
    const resolve = (linkpath, from) => {
      if (/^\.{1,2}\//.test(linkpath)) return memoResolveRelative(from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "", linkpath);
      return typeof cache?.getFirstLinkpathDest === "function" ? cache.getFirstLinkpathDest(linkpath, from)?.path || null : null;
    };
    return memoRelinkText(text, sourcePath, targetPath, resolve);
  }

  /** 文件被改、删或改名时丢掉它的解析缓存（修改时间精度不够时的保险）。返回它原来是否有速记。 */
  forgetParsed(path) {
    const had = !!this.parsed?.get(path)?.memos?.length;
    this.parsed?.delete(path);
    return had;
  }

  async previewTagRename(from) {
    const hits = (await this.list()).filter((m) => memoHasTag(m, from));
    return { memos: hits.length, files: new Set(hits.map((m) => m.path)).size };
  }

  /** 只改写速记块里的标签；日笔记其他段落里的同名标签保持原样。 */
  async renameTag(from, to) {
    if (!validTagName(from) || !validTagName(to)) throw new Error(tr("标签名不能为空，也不能包含空格、# 或反引号", "Tag names cannot be empty or contain spaces, # or backticks"));
    const paths = [...new Set((await this.list()).filter((m) => memoHasTag(m, from)).map((m) => m.path))];
    let memos = 0;
    for (const path of paths) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!file) continue;
      await this.app.vault.process(file, (content) => {
        const result = renameTagInContent(content, from, to);
        memos += result.changed;
        return result.content;
      });
    }
    return { memos, files: paths.length };
  }

  // 同一个插件的所有面板共用队列，整个读改写事务（含失败回滚）按顺序完成。
  queueTrash(operation) {
    const job = (this.trashQueue || Promise.resolve()).then(operation);
    this.trashQueue = job.catch(() => {});
    return job;
  }

  remove(memo, now = new Date()) {
    return this.queueTrash(() => this.removeToTrash(memo, now));
  }

  async removeToTrash(memo, now) {
    const file = this.app.vault.getAbstractFileByPath(memo.path);
    if (!file) throw new Error(tr("速记所在的文件已不存在", "The file containing this memo no longer exists"));
    if (!this.trashPath) {
      await this.app.vault.process(file, (content) => removeMemoBlock(content, memo));
      return;
    }
    // 先进回收站再从笔记里移除；移除失败就把回收站这条撤回
    const items = await this.readTrash();
    const entry = { id: reviewEntryId(), deletedAt: now.toISOString(), path: memo.path, date: memo.date, time: memo.time, text: memo.text, raw: memo.raw };
    await this.writeTrash([...items, entry]);
    try {
      await this.app.vault.process(file, (content) => removeMemoBlock(content, memo));
    } catch (error) {
      await this.writeTrash(items);
      throw error;
    }
  }

  async readTrash() {
    if (!this.trashPath) throw new Error(tr("速记回收站不可用", "The memo trash is unavailable"));
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(this.trashPath))) return [];
    try {
      const data = JSON.parse(await adapter.read(this.trashPath));
      if (data?.version !== 1 || !Array.isArray(data.items)) throw new Error(tr("格式不对", "Invalid format"));
      const ids = new Set();
      for (const entry of data.items) {
        if (!entry || typeof entry.id !== "string" || !/^[a-zA-Z0-9-]+$/.test(entry.id) || ids.has(entry.id)
          || typeof entry.deletedAt !== "string" || !Number.isFinite(Date.parse(entry.deletedAt))
          || typeof entry.path !== "string" || !entry.path.endsWith(".md")
          || typeof entry.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)
          || typeof entry.time !== "string" || typeof entry.text !== "string" || typeof entry.raw !== "string"
          || parseMemoBlocks(entry.raw).length !== 1
          || (entry.restorePath !== undefined && (typeof entry.restorePath !== "string" || !entry.restorePath.endsWith(".md")))
          || (entry.restoreInitial !== undefined && typeof entry.restoreInitial !== "string")
          || (entry.restoreHeading !== undefined && typeof entry.restoreHeading !== "string")) throw new Error(tr("条目损坏", "Corrupted entry"));
        ids.add(entry.id);
      }
      return data.items;
    } catch (_) {
      throw new Error(tr(`速记回收站文件已损坏（${this.trashPath}），为避免丢失速记，暂停删除`, `The memo trash file is corrupted (${this.trashPath}); deleting is paused to avoid losing memos`));
    }
  }

  async writeTrash(items) {
    const adapter = this.app.vault.adapter;
    const payload = JSON.stringify({ version: 1, items }, null, 2);
    await adapter.write(this.trashPath, payload);
    if (await adapter.read(this.trashPath) !== payload) throw new Error(tr("速记回收站保存未通过读回核对，已暂停本次操作", "Saving the memo trash failed the read-back check; this operation was stopped"));
  }

  /** 回收站里 30 天内的速记，新删的在前；过期的顺手清掉。 */
  listTrash(now = new Date()) {
    return this.queueTrash(async () => {
      const items = await this.readTrash();
      const cutoff = now.getTime() - MEMO_TRASH_DAYS * 86400000;
      // 部分恢复还没确认完成时保留凭据，不能由自动过期清理抹掉重试入口。
      const kept = items.filter((t) => t.restorePath || Date.parse(t.deletedAt) >= cutoff);
      if (kept.length !== items.length) await this.writeTrash(kept);
      return kept.sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
    });
  }

  /** 恢复到原来的笔记；原笔记不在了，就写回那一天的速记文件。 */
  restore(id) {
    return this.queueTrash(() => this.restoreFromTrash(id));
  }

  async restoreFromTrash(id) {
    const items = await this.readTrash();
    const entry = items.find((t) => t.id === id);
    if (!entry) throw new Error(tr("回收站里已经没有这条速记", "This memo is no longer in the trash"));
    const restored = parseMemoBlocks(entry.raw)[0];
    // 去掉旧的恢复凭据再盖上新的；代码块里的同形示例是正文，原样保留
    const rawLines = entry.raw.split("\n");
    const fenced = memoFencedLines(rawLines.map((line) => line.replace(/^>\s?/, "")));
    const body = rawLines.filter((line, k) => fenced.has(k) || !MEMO_RESTORE_RE.test(line.replace(/^>\s?/, "").trim())).join("\n");
    // 恢复到别的笔记（原笔记已不在、写回当天速记文件）时，相对路径的附件链接从新位置重新指向原文件
    const blockFor = (targetPath) => `${targetPath && targetPath !== entry.path ? this.relinkFor(body, entry.path, targetPath) : body}\n> <!-- crisp-pulse-memo-restored: ${entry.id} -->`;
    const rememberTarget = async (path, initial, heading) => {
      entry.restorePath = path;
      if (initial !== undefined) {
        entry.restoreInitial = initial;
        entry.restoreHeading = heading;
      }
      await this.writeTrash(items);
    };
    let file = this.app.vault.getAbstractFileByPath(entry.restorePath || entry.path);
    if (!file && entry.restorePath && entry.restoreInitial !== undefined) {
      // 首次回写的新文件创建失败：按已落盘的目标与模板重试，不跟随后来改动的设置。
      const folder = entry.restorePath.includes("/") ? entry.restorePath.slice(0, entry.restorePath.lastIndexOf("/")) : "";
      if (folder) await this.ensureFolder(folder);
      try {
        await this.app.vault.create(entry.restorePath, insertMemoBlock(entry.restoreInitial, blockFor(entry.restorePath), entry.restoreHeading));
      } catch (error) {
        file = this.app.vault.getAbstractFileByPath(entry.restorePath);
        if (!file) throw error;
      }
      file = this.app.vault.getAbstractFileByPath(entry.restorePath);
    }
    if (file) {
      if (!entry.restorePath) await rememberTarget(file.path);
      const daily = dailyDateFromPath(file.path, this.dailyOptions(), this.momentFn);
      const heading = entry.restoreHeading ?? (daily ? (this.settings().memoHeading ?? MEMO_DEFAULT_HEADING) : "");
      await this.app.vault.process(file, (content) => {
        const blocks = parseMemoBlocks(content);
        const hits = blocks.filter((m) => m.restoredId === entry.id || (restored.id && m.id === restored.id));
        if (hits.length > 1) throw new Error(tr("恢复标识重复，请先检查原笔记", "Duplicate restore ID; check the original note first"));
        return hits.length ? content : insertMemoBlock(content, blockFor(file.path), heading);
      });
    } else {
      if (entry.restorePath) throw new Error(tr("上次恢复的目标笔记已不存在，请先检查回收站中的来源", "The note it was last restored to no longer exists; check the source in the trash first"));
      const [h, m] = String(entry.time || "00:00").split(":").map(Number);
      const day = memoKeyToDay(entry.date);
      day.setHours(h || 0, m || 0);
      await this.writeBlock(blockFor(await this.memoFilePath(day)), day, rememberTarget);
    }
    await this.writeTrash(items.filter((t) => t.id !== id));
  }

  purge(id) {
    return this.queueTrash(async () => {
      const items = await this.readTrash();
      await this.writeTrash(items.filter((t) => t.id !== id));
    });
  }

  async ensureIdentity(memo) {
    const file = this.app.vault.getAbstractFileByPath(memo.path);
    if (!file) throw new Error(tr("速记所在的文件已不存在", "The file containing this memo no longer exists"));
    let current;
    let identityCreated = false;
    await this.app.vault.process(file, (content) => {
      const blocks = parseMemoBlocks(content);
      if (memo.id) {
        const hits = blocks.filter((m) => m.id === memo.id);
        if (hits.length !== 1) throw new Error(tr("速记标识已不存在或重复，请检查来源后再试", "The memo ID is missing or duplicated; check the source and try again"));
        current = hits[0];
        return content;
      }
      const lines = content.split("\n");
      const start = locateMemo(lines, memo);
      current = blocks.find((m) => m.startLine === start);
      const id = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
      lines.splice(current.endLine + 1, 0, `> <!-- crisp-pulse-memo-id: ${id} -->`);
      identityCreated = true;
      const next = lines.join("\n");
      current = parseMemoBlocks(next).find((m) => m.id === id);
      return next;
    });
    Object.assign(memo, current);
    return { ...current, path: memo.path, date: memo.date, identityCreated };
  }

  async findMemoIdentity(id, preferredPath) {
    if (!/^[a-zA-Z0-9-]+$/.test(id || "")) throw new Error(tr("速记标识无效", "Invalid memo ID"));
    const preferred = this.app.vault.getAbstractFileByPath(preferredPath);
    if (preferred) {
      const hits = parseMemoBlocks(await this.app.vault.read(preferred)).filter((memo) => memo.id === id);
      if (hits.length > 1) throw new Error(tr("速记标识重复，请先检查来源", "Duplicate memo ID; check the source first"));
      if (hits.length === 1) return { file: preferred, memo: hits[0] };
    }
    // 笔记重命名或路由后按隐藏标识定位，不依赖当前页面或原来的行号。
    const hits = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (file === preferred) continue;
      // 先用缓存粗筛，命中的文件再读磁盘最新内容
      if (!(await this.app.vault.cachedRead(file)).includes(`crisp-pulse-memo-id: ${id}`)) continue;
      const content = await this.app.vault.read(file);
      for (const memo of parseMemoBlocks(content)) if (memo.id === id) hits.push({ file, memo });
    }
    if (hits.length !== 1) throw new Error(hits.length ? tr("速记标识重复，请先检查来源", "Duplicate memo ID; check the source first") : tr("原速记已不存在，转写结果已保留在 ASR 队列，请检查后重试", "The original memo no longer exists; the transcript was kept in the ASR queue. Check and try again"));
    return hits[0];
  }

  /** 在速记块末尾记下 Tempo 任务凭据；已有就不重复写。 */
  async attachTempoTask(memoId, preferredPath, taskId) {
    if (!/^[A-Za-z0-9_-]+$/.test(taskId || "")) throw new Error(tr("Tempo 任务标识无效", "Invalid Tempo task ID"));
    const { file } = await this.findMemoIdentity(memoId, preferredPath);
    await this.app.vault.process(file, (content) => {
      const hits = parseMemoBlocks(content).filter((memo) => memo.id === memoId);
      if (hits.length !== 1) throw new Error(tr("原速记已不存在或标识重复，无法记下任务", "The original memo is missing or its ID is duplicated, so the task cannot be recorded"));
      if (hits[0].tempoTasks?.includes(taskId)) return content;
      const lines = content.split("\n");
      lines.splice(hits[0].endLine + 1, 0, `> <!-- crisp-pulse-tempo: ${taskId} -->`);
      return lines.join("\n");
    });
    const stored = parseMemoBlocks(await this.app.vault.read(file)).filter((memo) => memo.id === memoId && memo.tempoTasks?.includes(taskId));
    if (stored.length !== 1) throw new Error(tr("任务凭据未通过写回核对，请重试", "The task receipt failed the write-back check; please try again"));
    return { path: file.path };
  }

  /** 带某个来源凭据的速记，按隐藏凭据在全库找：速记被挪到别的笔记后也能找到。 */
  async findSourceMemos(sourceId) {
    const hits = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!(await this.app.vault.cachedRead(file)).includes(`crisp-pulse-source: ${sourceId}`)) continue;
      for (const memo of parseMemoBlocks(await this.app.vault.read(file))) {
        const source = memo.sources?.find((s) => s.id === sourceId);
        if (source) hits.push({ ...memo, path: file.path, revision: source.revision });
      }
    }
    return hits;
  }

  /** 写一条来自其他插件的速记，标识和来源凭据随速记一起写入。不经 onOwnWrite：引用和导入不算本人写作。 */
  async captureFromSource({ sourceId, revision, text }, now = new Date()) {
    if (!String(text ?? "").trim()) throw new Error(tr("速记内容为空", "The memo is empty"));
    const id = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    const block = [
      buildMemoBlock(text, now),
      `> <!-- crisp-pulse-memo-id: ${id} -->`,
      `> <!-- crisp-pulse-source: ${sourceId}${revision ? ` rev: ${revision}` : ""} -->`,
    ].join("\n");
    const { path } = await this.writeBlock(block, now);
    const file = this.app.vault.getAbstractFileByPath(path);
    const stored = file ? parseMemoBlocks(await this.app.vault.read(file)).filter((m) => m.id === id && m.sources?.some((s) => s.id === sourceId)) : [];
    if (stored.length !== 1) throw new Error(tr("速记未通过写回核对，请重试", "The memo failed the write-back check; please try again"));
    return { id, path };
  }

  /** 判断「已转写」用的上下文：速记里现有的录音，以及凭据里的旧路径是否还在库里。 */
  transcriptMatch(memo, notePath = memo.path) {
    return {
      audioPaths: memoAudioFiles({ ...memo, path: notePath }, this.app).map((f) => f.path),
      exists: (p) => !!this.app.vault.getAbstractFileByPath(p),
    };
  }

  async applyTranscript({ memoId, path, sourcePath, jobId, text }) {
    if (!/^[a-zA-Z0-9-]+$/.test(jobId || "") || !String(text || "").trim()) throw new Error(tr("转写结果为空或任务标识无效", "The transcript is empty or the job ID is invalid"));
    const { file } = await this.findMemoIdentity(memoId, path);
    const receipt = `> <!-- crisp-pulse-asr: ${jobId} audio: ${encodeURIComponent(sourcePath)} -->`;
    await this.app.vault.process(file, (content) => {
      const hits = parseMemoBlocks(content).filter((memo) => memo.id === memoId);
      if (hits.length !== 1) throw new Error(tr("原速记已不存在或标识重复，无法写回转写", "The original memo is missing or its ID is duplicated, so the transcript cannot be written back"));
      const current = hits[0];
      // 同一段录音已经有转写（含被挪动过的录音）就不再插入第二段
      if (current.transcriptJobs?.includes(jobId) || memoHasTranscriptFor(current, sourcePath, this.transcriptMatch(current, file.path))) return content;
      if (!memoAudioFiles({ ...current, path: file.path }, this.app).some((audio) => audio.path === sourcePath)) throw new Error(tr("原速记中的录音已被移除，转写结果已保留在 ASR 队列", "The recording was removed from the original memo; the transcript was kept in the ASR queue"));
      const transcript = String(text).replace(/\r\n?/g, "\n").trim().split("\n").map((line) => {
        // 识别文字恰好是 callout 标题、「→ [[笔记]]」或隐藏凭据时，原样留作文字
        const safe = memoSafeLine(line);
        return safe ? `> ${safe}` : ">";
      });
      const lines = content.split("\n");
      lines.splice(current.endLine + 1, 0, ">", tr("> **录音转写**", "> **Transcript**"), ...transcript, receipt);
      return lines.join("\n");
    });
    const stored = parseMemoBlocks(await this.app.vault.read(file)).filter((memo) => memo.id === memoId && (memo.transcriptJobs?.includes(jobId) || memoHasTranscriptFor(memo, sourcePath, this.transcriptMatch(memo, file.path))));
    if (stored.length !== 1) throw new Error(tr("转写未通过写回核对，请重试", "The transcript failed the write-back check; please try again"));
    return { path: file.path };
  }

  async linkBack(memo, linkText) {
    const file = this.app.vault.getAbstractFileByPath(memo.path);
    if (!file) throw new Error(tr("速记所在的文件已不存在", "The file containing this memo no longer exists"));
    await this.app.vault.process(file, (content) => {
      let current = memo;
      if (memo.id) {
        const hits = parseMemoBlocks(content).filter((m) => m.id === memo.id);
        if (hits.length !== 1) throw new Error(tr("速记标识已不存在或重复，请检查来源后再试", "The memo ID is missing or duplicated; check the source and try again"));
        current = hits[0];
      }
      if (current.links.includes(linkText)) return content;
      return appendMemoLink(content, current, linkText);
    });
  }
}

class CrispPulseMemoInputModal extends Modal {
  constructor(app, title, placeholder, initial, onSubmit) {
    super(app);
    this.titleText = title;
    this.placeholder = placeholder;
    this.initial = initial;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("crisp-pulse-memo-modal");
    contentEl.createEl("h3", { text: this.titleText });
    const input = contentEl.createEl("textarea", { cls: "crisp-pulse-memo-modal-input", attr: { placeholder: this.placeholder, rows: "3" } });
    input.value = this.initial || "";
    const row = contentEl.createDiv({ cls: "crisp-pulse-memo-modal-row" });
    const ok = row.createEl("button", { cls: "mod-cta", text: tr("确定", "OK") });
    const errorEl = contentEl.createDiv({ cls: "crisp-pulse-memo-error", attr: { role: "alert" } });
    const submit = async () => {
      if (this.submitting) return;
      const value = input.value.trim();
      if (!value) return;
      this.submitting = true;
      ok.disabled = true;
      input.readOnly = true;
      errorEl.textContent = "";
      try {
        await this.onSubmit(value);
        this.close();
      } catch (error) {
        errorEl.textContent = tr(`未保存：${error.message || error}。内容已保留，请重试。`, `Not saved: ${error.message || error}. Your text was kept; please try again.`);
      } finally {
        this.submitting = false;
        ok.disabled = false;
        input.readOnly = false;
      }
    };
    ok.addEventListener("click", submit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(); }
    });
    window.setTimeout(() => { input.focus(); input.select?.(); }, 0);
  }

  onClose() {
    this.contentEl.empty();
  }
}

class CrispPulseMemoView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.memos = [];
    this.index = null;
    // 像 flomo 一样按条数分批显示，滑到底再接着加载更早的
    this.shown = MEMO_PAGE_SIZE;
    this.listSignature = "";
    this.expandedMemos = new Set();
    this.draft = "";
    this.draftRevision = 0;
    this.memoSubmitting = false;
    this.memoMarkdownComponents = new Map();
    this.mode = "general";
    this.tab = "all";
    this.showAdvanced = false;
    this.searchOpen = false;
    this.reviewBatch = 0;
    this.expanded = null;
    this.walk = { trail: [], step: null };
    this.resetFilters();
  }

  getViewType() { return VIEW_TYPE_MEMO; }
  getDisplayText() { return tr("Crisp Pulse 速记", "Crisp Pulse Memos"); }
  getIcon() { return "feather"; }

  async onOpen() {
    this.memoClosed = false;
    const drafts = this.plugin.memoDrafts;
    if (drafts) {
      await drafts.load();
      this.draftKey = this.leaf?.id || reviewEntryId();
      const live = this.app.workspace.getLeavesOfType?.(VIEW_TYPE_MEMO)?.map((leaf) => leaf.id) || [];
      const restored = drafts.claimDraft(this.draftKey, live);
      if (restored && !this.draft) { this.draft = restored; this.draftRestored = true; }
      this.register(drafts.onChange(() => { this.renderPendingRecordings(); this.updateRecordingUi(); }));
    }
    this.registerEvent(this.app.workspace.on("crisp-asr:state", () => this.refreshMemoTranscriptionControls()));
    this.registerEvent(this.app.workspace.on("crisp-tempo:state", () => this.refreshTempoChips()));
    this.registerDomEvent(this.containerEl.ownerDocument, "pointerdown", (event) => {
      const box = this.dockedComposer;
      if (!box?.isConnected || box.contains(event.target)) return;
      if (!this.draft.trim() && !this.recording) box.removeClass("is-open");
    });
    await this.reload();
  }

  async onClose() {
    this.memoClosed = true;
    this.memoTranscriptionControls?.clear();
    if (this.dictation) void this.stopDictation();
    // 关掉视图时正在录的音照常保存，链接留在草稿里；草稿存进恢复文件，下次打开速记面板时找回
    if (this.recording) {
      (this.containerEl.win || window).clearInterval(this.recording.timer);
      if (this.recording.recorder.state !== "inactive") this.recording.recorder.stop();
    }
    this.persistDraft();
    void this.plugin?.memoDrafts?.flush();
    this.moreObserver?.disconnect();
    this.clearMemoMarkdown();
  }

  persistDraft() {
    const drafts = this.plugin?.memoDrafts;
    if (drafts?.retired) return;
    // 面板已关、草稿已被新打开的面板接手：迟到的听写定稿等不再写回，免得恢复文件里多出一份旧草稿
    if (this.memoClosed && drafts?.currentKey && drafts.currentKey(this.draftKey) !== this.draftKey) return;
    drafts?.setDraft(this.draftKey, this.draft);
  }

  clearMemoMarkdown(parent = null) {
    for (const [el, component] of this.memoMarkdownComponents || []) {
      if (!parent || parent.contains(el)) {
        component.unload();
        this.memoMarkdownComponents.delete(el);
      }
    }
  }

  /** 重新读取速记。几次刷新同时进行时只让最后发起的那次落到界面上，晚返回的旧结果直接丢掉，
      免得刚删掉的卡片又冒出来。 */
  async reload() {
    const generation = (this.reloadGeneration || 0) + 1;
    this.reloadGeneration = generation;
    let mode, memos, error = null;
    try {
      mode = await this.plugin.memoStore.resolveMode();
      memos = await this.plugin.memoStore.list();
    } catch (err) {
      error = err.message || String(err);
    }
    if (generation !== this.reloadGeneration || this.memoClosed) return;
    if (error) this.error = error;
    else {
      this.mode = mode;
      this.memos = memos;
      this.index = null;
      this.error = null;
    }
    this.render();
  }

  memoKey(m) {
    return `${m.path}:${m.date} ${m.time}:${m.startLine}`;
  }

  getIndex() {
    if (!this.index) this.index = buildMemoIndex(this.memos);
    return this.index;
  }

  /** 列表刷新后旧对象失效，按键找回当前列表里的同一条速记。 */
  findSame(m) {
    if (!m) return null;
    if (m.id) return this.memos.find((x) => x.id === m.id) || null;
    const key = this.memoKey(m);
    return this.memos.find((x) => this.memoKey(x) === key) || this.memos.find((x) => x.path === m.path && x.date === m.date && x.time === m.time && x.text === m.text) || null;
  }

  render() {
    const root = this.containerEl.children[1];
    const doc = root.ownerDocument;
    const active = doc?.activeElement;
    if (this.composerComposing && root.contains(active)) { this.memoRenderPending = true; return; }
    const refocusComposer = root.contains(active) && active.classList?.contains("crisp-pulse-memo-input")
      ? { start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection, scroll: active.scrollTop } : null;
    const searchFocus = root.contains(active) && active.classList?.contains("crisp-pulse-memo-search") ? { start: active.selectionStart, end: active.selectionEnd } : null;
    const scroll = root.scrollTop;
    this.clearMemoMarkdown();
    this.memoTranscriptionControls = new Map();
    this.memoAsrSignature = null;
    this.memoTempoRows = new Map();
    root.empty();
    root.addClass("crisp-pulse-memo-view");
    this.renderNavHeader(root);
    const body = root.createDiv({ cls: "crisp-pulse-memo-body" });
    // 手机上输入栏停在底部，拇指够得着，滑动列表也不会消失；桌面端仍在顶部
    const docked = !!(Platform.isPhone || doc?.body?.classList?.contains("is-phone"));
    if (!docked) this.renderComposer(body, refocusComposer);
    if (this.error) body.createDiv({ cls: "crisp-pulse-memo-error", text: this.error });
    this.renderStats(body, memoStats(this.memos, getTodayKey(), { weeks: 12, weekStartsOn: this.plugin.settings.weekStartsOn }));
    this.listEl = null;
    this.renderTabs(body, searchFocus);
    if (docked) {
      this.renderComposer(root, refocusComposer, { docked: true });
      // Obsidian 给侧栏视图最后一个 div 加了底部留白；交给这个占位块，不撑高输入栏
      root.createDiv({ cls: "crisp-pulse-memo-dock-spacer" });
    }
    root.scrollTop = scroll;
  }

  /* 顶部沿用 Obsidian 原生 nav-header 按钮行，与左侧文件列表同高同样式；搜索在页签行右侧 */
  renderNavHeader(root) {
    const header = root.createDiv({ cls: "nav-header crisp-pulse-memo-nav" });
    const buttons = header.createDiv({ cls: "nav-buttons-container" });
    const navButton = (icon, label, onClick, isActive = false) => {
      const b = buttons.createDiv({ cls: `clickable-icon nav-action-button${isActive ? " is-active" : ""}`, attr: { "aria-label": label, role: "button", tabindex: "0" } });
      setIcon(b, icon);
      b.addEventListener("click", onClick);
      b.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(e); } });
      return b;
    };
    navButton("refresh-cw", tr("刷新速记", "Refresh memos"), () => this.reload());
    navButton("filter", MEMO_FILTER_LABEL, () => { this.showAdvanced = !this.showAdvanced; this.tab = "all"; this.render(); }, this.showAdvanced || this.isFiltered());
    navButton("shuffle", tr("随机漫步", "Random walk"), () => { this.startWalk(); this.tab = "walk"; this.render(); }, this.tab === "walk");
    navButton("trash-2", tr("速记回收站", "Memo trash"), () => { this.tab = this.tab === "trash" ? "all" : "trash"; this.render(); }, this.tab === "trash");
    navButton("settings", tr("速记设置", "Memo settings"), () => {
      const setting = this.app.setting;
      if (setting?.open) { setting.open(); setting.openTabById?.(this.plugin.manifest.id); }
    });
  }

  /** 现在负责草稿的存储：插件重载后旧实例的已停用，换成新实例的。 */
  liveDrafts() {
    const own = this.plugin?.memoDrafts;
    if (!own?.retired) return own || null;
    const id = this.plugin?.manifest?.id || "crisp-pulse";
    const live = this.app?.plugins?.plugins?.[id]?.memoDrafts;
    return live && !live.retired ? live : null;
  }

  /** 把文字插到输入框光标处（输入框不在了就接到草稿末尾），并同步草稿。 */
  insertIntoComposer(text) {
    // 面板关掉后才存好的附件：草稿已被新打开的面板（或重载后的新实例）接手时，链接跟着草稿走，不再把旧草稿写回恢复文件
    const own = this.plugin?.memoDrafts;
    const drafts = this.memoClosed ? this.liveDrafts() : own;
    if (this.memoClosed && own?.retired && !drafts) {
      new Notice(tr(`Crisp Pulse 速记：插件已重新加载，附件已存进库但没能放回草稿，请手动插入：${text}`, `Crisp Pulse memos: the plugin was reloaded. The attachment was saved to the vault but could not be put back into the draft; insert it manually: ${text}`), 12000);
      return;
    }
    if (this.memoClosed && drafts) {
      const key = drafts.currentKey(this.draftKey);
      if (key !== this.draftKey || drafts !== own) {
        const heir = (this.app?.workspace?.getLeavesOfType?.(VIEW_TYPE_MEMO) || []).map((leaf) => leaf.view).find((v) => v && v !== this && !v.memoClosed && v.draftKey === key);
        if (heir) heir.insertIntoComposer(text);
        else void drafts.appendDraft(key, text);
        return;
      }
    }
    const input = this.composerInput();
    if (!input) {
      this.setDraft(`${this.draft ? `${this.draft.replace(/\s+$/, "")}\n` : ""}${text}\n`);
      return;
    }
    const before = input.value.slice(0, input.selectionStart);
    input.setRangeText(`${before && !/\s$/.test(before) ? "\n" : ""}${text}\n`, input.selectionStart, input.selectionEnd, "end");
    this.setDraft(input.value, input.selectionEnd);
    input.closest(".crisp-pulse-memo-composer")?.addClass("is-open");
    input.focus();
  }

  composerInput() {
    return this.containerEl.children[1]?.querySelector(".crisp-pulse-memo-input") || null;
  }

  /** 草稿变了（键入、粘贴、工具按钮、插入附件、听写）：同步草稿和修订号，听写占用的那一段跟着挪，并存一份恢复用的草稿。 */
  setDraft(next, caret = null) {
    if (this.dictation && next !== this.draft) this.mapDictationRange(this.dictation, this.draft, next, caret);
    if (this.draftRestored && next !== this.draft) { this.draftRestored = false; this.updateRecordingUi(); }
    this.draft = next;
    this.draftRevision = (this.draftRevision || 0) + 1;
    this.persistDraft();
  }

  /** 听写期间输入框被别的方式改动：改在那一段之前就跟着挪，之后不受影响；改到那一段里面，听写不再覆盖。 */
  mapDictationRange(d, prev, next, caret) {
    if (d.detached) return;
    const max = Math.min(prev.length, next.length);
    let p = 0;
    while (p < max && prev[p] === next[p]) p++;
    let tail = 0;
    while (tail < max - p && prev[prev.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
    let oldEnd = prev.length - tail;
    let newEnd = next.length - tail;
    // 插入或删除相同的字时位置有歧义，按光标往前挪到真正改动的地方
    if (caret != null && oldEnd === p) {
      while (p > 0 && newEnd > caret && next[p - 1] === next[newEnd - 1]) { p--; newEnd--; oldEnd--; }
    } else if (caret != null && newEnd === p) {
      while (p > caret && prev[p - 1] === prev[oldEnd - 1]) { p--; oldEnd--; newEnd--; }
    }
    const end = d.start + d.shown.length;
    if (oldEnd <= d.start) d.start += (newEnd - p) - (oldEnd - p);
    else if (p < end) this.detachDictation(d);
  }

  detachDictation(d) {
    if (d.detached) return;
    d.detached = true;
    if (this.dictation === d) void this.stopDictation();
  }

  /** 长按麦克风：通过 Crisp ASR 实时听写，文字边说边出现在开始时的光标处，松开结束。
      听写只改写自己写入的那一段；那段之外的手动输入和插入的附件都保留。 */
  async startDictation({ held = false } = {}) {
    const asr = this.plugin.memoDictationAsr?.();
    if (!asr || this.dictation || this.memoClosed) return;
    const input = this.composerInput();
    const value = input ? input.value : this.draft;
    if (value !== this.draft) this.setDraft(value);
    const start = input ? input.selectionStart : value.length;
    const end = input ? input.selectionEnd : value.length;
    // 选中的文字由听写结果替换；什么都没听到时原样保留
    const d = { start, shown: value.slice(start, end), text: "", preview: "", state: "connecting", stopRequested: false, done: false, detached: false, held };
    this.dictation = d;
    this.updateRecordingUi();
    const sink = {
      onState: (state) => { if (this.dictation !== d) return; d.state = state; this.updateRecordingUi(); },
      onText: (text, preview) => {
        if (this.dictation !== d || d.done) return;
        d.text = text;
        d.preview = preview;
        this.applyDictation(d, `${text}${preview}`);
      },
      onDone: ({ text, error }) => {
        if (d.done) return;
        d.done = true;
        (this.containerEl?.win || window).clearTimeout(d.watchdog);
        const heard = d.state !== "connecting";
        // 定稿文字取代过程中的预览；没有定稿时保留已经显示的定稿部分
        const final = text || d.text;
        if (!d.detached && (final || d.preview)) this.applyDictation(d, final);
        if (this.dictation === d) this.dictation = null;
        this.updateRecordingUi();
        if (d.detached) new Notice(tr("Crisp Pulse 速记：你改动了正在听写的文字，听写已结束，之后识别的内容没有写入输入框", "Crisp Pulse memos: you edited the text being dictated, so dictation ended; anything recognized afterwards was not added to the input box"), 8000);
        else if (error) new Notice(tr(`Crisp Pulse 速记：实时听写中断：${memoAsrErrorInfo(error).text}${final ? "。已识别的文字已保留" : ""}`, `Crisp Pulse memos: live dictation stopped: ${memoAsrErrorInfo(error).text}${final ? ". The recognized text was kept" : ""}`), 8000);
        else if (!final && heard) new Notice(tr("Crisp Pulse 速记：这次没有识别到文字", "Crisp Pulse memos: no text was recognized this time"));
      },
    };
    d.finish = sink.onDone;
    try {
      await asr.startMemoDictation(sink);
      // 连接期间已经松开：连上后立即结束（等不及已按超时结束的，也要让识别服务停下）
      if (d.stopRequested && (!d.done || d.timedOut)) await asr.stopMemoDictation();
    } catch (error) {
      // 启动失败后不再接受这一轮的任何回调，免得改到之后的草稿
      d.done = true;
      if (this.dictation === d) this.dictation = null;
      this.updateRecordingUi();
      new Notice(tr(`Crisp Pulse 速记：无法开始实时听写：${error.message || error}`, `Crisp Pulse memos: cannot start live dictation: ${error.message || error}`), 8000);
    }
  }

  async stopDictation() {
    const d = this.dictation;
    if (!d) return;
    d.stopRequested = true;
    const win = this.containerEl?.win || window;
    d.watchdog ||= win.setTimeout(() => {
      if (d.done) return;
      d.timedOut = true;
      d.finish?.({ text: d.text, error: new Error(tr("识别服务没有返回定稿", "The recognition service did not return a final result")) });
    }, MEMO_DICTATION_FINALIZE_TIMEOUT);
    try {
      await this.plugin.memoDictationAsr?.()?.stopMemoDictation();
    } catch (error) {
      if (!d.done) d.finish?.({ text: d.text, error });
    }
  }

  applyDictation(d, middle) {
    if (d.detached) return;
    const value = this.draft;
    const end = d.start + d.shown.length;
    // 那一段已经不是听写写进去的样子（不该发生，兜底）：不再覆盖
    if (value.slice(d.start, end) !== d.shown) { this.detachDictation(d); return; }
    const next = `${value.slice(0, d.start)}${middle}${value.slice(end)}`;
    const delta = middle.length - d.shown.length;
    const input = this.composerInput();
    // 光标在听写那段末尾（或里面）就跟着走；在用户自己的文字里就留在原处
    const map = (pos) => (pos >= end ? pos + delta : pos <= d.start ? pos : d.start + middle.length);
    const selection = input ? [map(input.selectionStart), map(input.selectionEnd)] : null;
    d.shown = middle;
    this.draft = next;
    this.draftRevision = (this.draftRevision || 0) + 1;
    this.persistDraft();
    if (!input) return;
    input.value = next;
    input.setSelectionRange?.(selection[0], selection[1]);
    input.closest?.(".crisp-pulse-memo-composer")?.addClass("is-open");
  }

  /** 录音：再点一次结束；音频存进库（跟随附件位置），在速记里插入嵌入链接，卡片上可直接播放。 */
  async toggleRecording() {
    if (this.memoClosed || this.recordingStarting || this.recordingSaving || this.dictation) return;
    if (this.recording) {
      if (this.recording.recorder.state !== "inactive") this.recording.recorder.stop();
      return;
    }
    const win = this.containerEl.win || window;
    const Recorder = win.MediaRecorder;
    if (!win.navigator?.mediaDevices?.getUserMedia || typeof Recorder !== "function") {
      new Notice(tr("Crisp Pulse 速记：当前环境不支持录音", "Crisp Pulse memos: recording is not supported here"));
      return;
    }
    let stream;
    this.recordingStarting = true;
    this.updateRecordingUi();
    try {
      stream = await win.navigator.mediaDevices.getUserMedia({ audio: true });
      // 权限弹窗可能停留很久；视图已关闭时不启动录音，也不遗留麦克风。
      if (this.memoClosed) { stream.getTracks().forEach((t) => t.stop()); return; }
      const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((t) => Recorder.isTypeSupported?.(t)) || "";
      const recorder = new Recorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks = [];
      const startedAt = new Date();
      const session = { recorder, startedAt, timer: null };
      recorder.addEventListener("dataavailable", (e) => { if (e.data?.size) chunks.push(e.data); });
      // 设备出错或被拔掉：停下录音，已录到的部分照常走 stop 里的保存 / 保留流程，不让面板一直停在「录音中」
      const halt = () => { try { if (recorder.state !== "inactive") recorder.stop(); } catch (_) { /* 已经停了 */ } };
      recorder.addEventListener("error", (e) => {
        console.warn("[Crisp Pulse] 录音出错", e?.error || e);
        new Notice(tr(`Crisp Pulse 速记：录音出错（${e?.error?.message || "设备异常"}），已停止录音`, `Crisp Pulse memos: recording error (${e?.error?.message || "device problem"}); recording stopped`), 8000);
        halt();
      });
      stream.getTracks().forEach((t) => t.addEventListener?.("ended", halt));
      const draftsAtStart = this.plugin?.memoDrafts;
      const draftKey = this.draftKey;
      recorder.addEventListener("stop", async () => {
        stream.getTracks().forEach((t) => t.stop());
        win.clearInterval(session.timer);
        if (this.recording === session) this.recording = null;
        this.recordingSaving = true;
        this.updateRecordingUi();
        const type = recorder.mimeType || mime || "audio/webm";
        let rec = null;
        try {
          if (!chunks.length) return;
          rec = { id: reviewEntryId(), name: memoRecordingName(type, startedAt), type, startedAt: startedAt.toISOString(), data: await new Blob(chunks, { type }).arrayBuffer(), error: "" };
          const link = await this.plugin.memoStore.saveAttachment(rec.name, rec.data, startedAt);
          this.insertIntoComposer(link);
        } catch (error) {
          const message = error.message || String(error);
          const keeper = this.memoClosed ? this.liveDrafts() : this.plugin?.memoDrafts;
          if (rec && keeper) {
            // 录音留着：输入框下方可以重试、另存或丢弃，不用重录
            rec.error = message;
            await keeper.keepRecording(rec);
            new Notice(tr(`Crisp Pulse 速记：录音没能存进库（${message}）。录音已保留，可在输入框下方重试或另存`, `Crisp Pulse memos: the recording could not be saved to the vault (${message}). It was kept; retry or save it elsewhere below the input box`), 10000);
          } else {
            new Notice(tr(`Crisp Pulse 速记：录音保存失败：${message}`, `Crisp Pulse memos: failed to save the recording: ${message}`), 8000);
          }
        } finally {
          this.recordingSaving = false;
          draftsAtStart?.endAttachment?.(draftKey);
          this.updateRecordingUi();
        }
      });
      recorder.start();
      // 从开始录到存好算一个附件：录音中关掉面板、重载插件，接手草稿的面板也要等它存好再提交
      draftsAtStart?.beginAttachment?.(draftKey);
      session.timer = win.setInterval(() => this.updateRecordingUi(), 1000);
      this.recording = session;
    } catch (error) {
      stream?.getTracks().forEach((t) => t.stop());
      new Notice(tr(`Crisp Pulse 速记：无法开始录音：${error.message || error}`, `Crisp Pulse memos: cannot start recording: ${error.message || error}`), 8000);
    } finally {
      this.recordingStarting = false;
      this.updateRecordingUi();
    }
  }

  /** 没能存进库的录音：留在输入框下方，可重试、另存为文件或丢弃。 */
  renderPendingRecordings() {
    const el = this.pendingEl;
    if (!el?.isConnected) return;
    el.empty();
    const store = this.plugin.memoDrafts;
    for (const rec of store?.recordings || []) {
      const row = el.createDiv({ cls: "crisp-pulse-memo-pending-row", attr: { role: "alert" } });
      const at = Number.isFinite(Date.parse(rec.startedAt)) ? memoClock(new Date(rec.startedAt)) : "";
      row.createDiv({ cls: "crisp-pulse-memo-pending-text", text: tr(`${at ? `${at} 的` : ""}录音还没存进库${rec.error ? `：${rec.error}` : ""}`, `${at ? `The ${at} recording` : "A recording"} has not been saved to the vault yet${rec.error ? `: ${rec.error}` : ""}`) });
      const actions = row.createDiv({ cls: "crisp-pulse-memo-pending-actions" });
      const action = (text, fn) => {
        const b = actions.createEl("button", { cls: "crisp-pulse-memo-chip", text, attr: { type: "button" } });
        b.disabled = !!rec.busy;
        b.addEventListener("click", fn);
        return b;
      };
      action(rec.busy ? tr("保存中…", "Saving…") : tr("重试保存", "Retry save"), () => this.retryRecording(rec));
      action(tr("另存为文件", "Save as file"), () => this.exportRecording(rec));
      const drop = action(rec.confirmDrop ? tr("确认丢弃", "Confirm discard") : tr("丢弃", "Discard"), async () => {
        if (!rec.confirmDrop) { rec.confirmDrop = true; drop.setText(tr("确认丢弃", "Confirm discard")); return; }
        await store.dropRecording(rec);
      });
      if (rec.confirmDrop) drop.addClass("mod-warning");
    }
    el.toggleClass("is-empty", !store?.recordings?.length);
  }

  async retryRecording(rec) {
    const store = this.plugin.memoDrafts;
    if (rec.busy || !store) return;
    rec.busy = true;
    const draftKey = this.draftKey;
    // 和首次保存一样登记附件：重试中关掉再打开面板，接手的面板也要等链接进草稿
    store.beginAttachment(draftKey);
    this.recordingRetries = (this.recordingRetries || 0) + 1;
    this.updateRecordingUi();
    try {
      const data = await store.recordingData(rec);
      const startedAt = Number.isFinite(Date.parse(rec.startedAt)) ? new Date(rec.startedAt) : new Date();
      const link = await this.plugin.memoStore.saveAttachment(rec.name, data, startedAt);
      rec.busy = false;
      await store.dropRecording(rec);
      // 重试期间插件重载过：新实例从恢复文件读到的同一条录音也要清掉，否则留下点了必报错的待保存条
      const live = this.liveDrafts();
      if (live && live !== store) await live.dropRecording(rec);
      this.insertIntoComposer(link);
      new Notice(tr("Crisp Pulse 速记：录音已存进库", "Crisp Pulse memos: recording saved to the vault"));
    } catch (error) {
      rec.error = error.message || String(error);
      new Notice(tr(`Crisp Pulse 速记：录音仍没能保存：${rec.error}`, `Crisp Pulse memos: the recording still could not be saved: ${rec.error}`), 8000);
    } finally {
      rec.busy = false;
      this.recordingRetries -= 1;
      store.endAttachment(draftKey);
      this.updateRecordingUi();
    }
  }

  async exportRecording(rec) {
    try {
      const data = await this.plugin.memoDrafts.recordingData(rec);
      const doc = this.containerEl.ownerDocument || document;
      const win = doc.defaultView || window;
      const url = win.URL.createObjectURL(new win.Blob([data], { type: rec.type || "audio/webm" }));
      const a = doc.createElement("a");
      a.href = url;
      a.download = rec.name;
      doc.body.appendChild(a);
      a.click();
      a.remove();
      win.setTimeout(() => win.URL.revokeObjectURL(url), 60000);
    } catch (error) {
      new Notice(tr(`Crisp Pulse 速记：录音另存失败：${error.message || error}`, `Crisp Pulse memos: failed to save the recording as a file: ${error.message || error}`), 8000);
    }
  }

  /** 点击式听写：开始 / 结束都是一次点击。 */
  async toggleDictation() {
    if (this.dictation) return this.stopDictation();
    if (this.recording || this.recordingStarting || this.recordingSaving) {
      new Notice(tr("Crisp Pulse 速记：正在录音，结束录音后再听写", "Crisp Pulse memos: recording in progress; stop recording before dictating"));
      return;
    }
    this.composerInput()?.focus();
    return this.startDictation();
  }

  /** 输入框下方的状态行：现在在做什么（连接、听写、定稿、录音、保存），以及结束、取消或处理恢复草稿的按钮。 */
  composerStatus() {
    const d = this.dictation;
    if (d) {
      if (d.state === "connecting") return { text: tr("正在连接实时听写…", "Connecting live dictation…"), actions: [[tr("取消", "Cancel"), () => this.stopDictation()]] };
      if (d.state === "finishing" || d.stopRequested) return { text: tr("正在定稿，完成后可以提交…", "Finalizing; you can submit when it’s done…"), actions: [] };
      return { text: d.held ? tr("听写中，松开麦克风结束", "Dictating; release the mic to stop") : tr("听写中，说完点「结束」", "Dictating; press “Stop” when you’re done"), actions: [[tr("结束", "Stop"), () => this.stopDictation()]] };
    }
    if (this.recordingStarting) return { text: tr("等待麦克风权限…", "Waiting for microphone permission…"), actions: [] };
    if (this.recording) {
      const sec = Math.floor((Date.now() - this.recording.startedAt.getTime()) / 1000);
      return { text: `${tr("录音中", "Recording")} ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`, actions: [[tr("结束录音", "Stop recording"), () => this.toggleRecording()]] };
    }
    if (this.recordingSaving || this.recordingRetries) return { text: tr("正在保存录音…", "Saving recording…"), actions: [] };
    if (this.imagesSaving) return { text: tr("正在保存图片…", "Saving image…"), actions: [] };
    if (this.liveDrafts()?.pendingFor?.(this.draftKey)) return { text: tr("上一个面板的附件还在保存…", "Attachments from the previous panel are still saving…"), actions: [] };
    const pomodoroBreak = this.plugin.pomodoroBreak;
    if (pomodoroBreak && !pomodoroBreak.dismissed && this.plugin.settings.memoPomodoroPrompt !== false) {
      return { text: tr(`记一下这一轮做了什么（带 #${MEMO_POMODORO_TAG}）`, `Note what you did this round (tagged #${MEMO_POMODORO_TAG})`), actions: [
        [tr("不用了", "Skip"), () => { pomodoroBreak.dismissed = true; this.plugin.refreshMemoComposerStatus(); }],
      ] };
    }
    if (this.draftRestored && this.draft.trim()) {
      return { text: tr("已恢复上次没提交的草稿", "Restored your last unsubmitted draft"), actions: [
        [tr("清空", "Clear"), () => { const input = this.composerInput(); if (input) input.value = ""; this.setDraft(""); this.draftRestored = false; this.updateRecordingUi(); }],
        [tr("知道了", "Got it"), () => { this.draftRestored = false; this.updateRecordingUi(); }],
      ] };
    }
    return null;
  }

  renderComposerStatus() {
    const el = this.statusEl;
    if (!el?.isConnected) return;
    const status = this.composerStatus();
    // 空状态和「只有文字、没有按钮」的状态要区分开，否则从空闲切到「正在保存…」时文字不出现
    const signature = status ? `status|${status.actions.map((a) => a[0]).join("|")}` : "";
    el.toggleClass("is-empty", !status);
    if (signature === this.statusSignature && status) { el.querySelector(".crisp-pulse-memo-status-text")?.setText(status.text); return; }
    this.statusSignature = signature;
    el.empty();
    if (!status) return;
    el.createSpan({ cls: "crisp-pulse-memo-status-text", text: status.text });
    for (const [label, fn] of status.actions) {
      const b = el.createEl("button", { cls: "crisp-pulse-memo-chip", text: label, attr: { type: "button" } });
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", () => { void fn(); });
    }
  }

  /** 正在录音（含等麦克风权限）或图片、录音还在存进库：存好后链接才插进输入框，这期间提交会让链接落到下一条。 */
  attachmentSaving() {
    return !!(this.recording || this.recordingStarting || this.recordingSaving || this.recordingRetries || this.imagesSaving || this.liveDrafts()?.pendingFor?.(this.draftKey));
  }

  updateRecordingUi() {
    const send = this.containerEl.children[1]?.querySelector(".crisp-pulse-memo-send");
    if (send) send.disabled = !!(this.memoSubmitting || this.dictation || this.attachmentSaving());
    this.renderComposerStatus();
    const dictate = this.containerEl.children[1]?.querySelector(".crisp-pulse-memo-dictate");
    if (dictate) {
      dictate.toggleClass("is-dictating", !!this.dictation);
      dictate.disabled = !!(this.recording || this.recordingStarting || this.recordingSaving || this.dictation?.held);
      dictate.setAttribute("aria-label", this.dictation ? tr("结束实时听写", "Stop live dictation") : MEMO_DICTATE_LABEL);
    }
    const button = this.containerEl.children[1]?.querySelector(".crisp-pulse-memo-mic");
    if (!button) return;
    const rec = this.recording;
    const d = this.dictation;
    button.disabled = !!(this.recordingStarting || this.recordingSaving);
    button.toggleClass("is-recording", !!rec);
    button.toggleClass("is-dictating", !!d);
    const canDictate = !!this.plugin.memoDictationAsr?.();
    button.setAttribute("aria-label", rec ? tr("结束录音", "Stop recording") : d ? tr("实时听写中，松开结束", "Dictating; release to stop") : canDictate ? tr("录音（长按：实时听写）", "Record (hold: live dictation)") : tr("录音", "Record"));
    // 时长和听写状态显示在输入框下方的状态行里，按钮只变色
  }

  renderComposer(root, refocus, { docked = false } = {}) {
    const box = root.createDiv({ cls: `crisp-pulse-memo-composer${docked ? " is-docked" : ""}` });
    if (docked) {
      // 收起时只占一行；点进来、有草稿或正在录音时展开，点到别处且没写东西就收起
      box.toggleClass("is-open", !!(refocus || this.draft.trim() || this.recording || this.dictation || this.plugin.memoDrafts?.recordings?.length));
      box.addEventListener("focusin", () => box.addClass("is-open"));
      this.dockedComposer = box;
    } else {
      this.dockedComposer = null;
    }
    const input = box.createEl("textarea", { cls: "crisp-pulse-memo-input", attr: { placeholder: tr("现在的想法是…", "What’s on your mind…"), rows: "3", "aria-label": tr("速记内容", "Memo text") } });
    input.value = this.draft;
    input.addEventListener("input", () => this.setDraft(input.value, input.selectionEnd));
    input.addEventListener("compositionstart", () => { this.composerComposing = true; });
    input.addEventListener("compositionend", () => {
      this.composerComposing = false;
      if (input.value !== this.draft) this.setDraft(input.value, input.selectionEnd);
      if (this.memoRenderPending) { this.memoRenderPending = false; this.render(); }
    });
    const bar = box.createDiv({ cls: "crisp-pulse-memo-toolbar" });
    const tool = (icon, label, fn) => {
      const b = bar.createEl("button", { cls: "clickable-icon crisp-pulse-memo-tool", attr: { "aria-label": label, type: "button" } });
      setIcon(b, icon);
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", () => { fn(); this.setDraft(input.value, input.selectionEnd); input.focus(); });
    };
    const insertAt = (text, wrap = "") => {
      const { selectionStart: s, selectionEnd: e, value } = input;
      const selected = value.slice(s, e);
      const next = wrap ? `${wrap}${selected}${wrap}` : text;
      input.setRangeText(next, s, e, "end");
      if (wrap && !selected) input.setSelectionRange(s + wrap.length, s + wrap.length);
    };
    tool("hash", tr("插入标签 #", "Insert tag #"), () => {
      const before = input.value.slice(0, input.selectionStart);
      insertAt(before && !/\s$/.test(before) ? " #" : "#");
    });
    tool("list", tr("列表", "List"), () => {
      const { selectionStart: s, value } = input;
      const lineStart = value.lastIndexOf("\n", s - 1) + 1;
      input.setRangeText("- ", lineStart, lineStart, "end");
    });
    tool("bold", tr("加粗", "Bold"), () => insertAt("", "**"));
    // 图片：粘贴、拖入或从按钮选择，先存进库里，再在光标处插入嵌入链接
    const addImages = async (files) => {
      const images = [...files].filter((f) => /^image\//.test(f.type) || MEMO_IMAGE_EXT_RE.test(f.name || ""));
      if (!images.length) return false;
      const links = [];
      // 保存完成前不让提交：否则链接会插进下一条草稿，这一条缺图
      this.imagesSaving = (this.imagesSaving || 0) + 1;
      const draftsAtStart = this.plugin?.memoDrafts;
      draftsAtStart?.beginAttachment?.(this.draftKey);
      this.updateRecordingUi();
      try {
        for (const file of images) {
          links.push(await this.plugin.memoStore.saveAttachment(memoAttachmentName(file.name, file.type, new Date()), await file.arrayBuffer()));
        }
      } catch (error) {
        new Notice(tr(`Crisp Pulse 速记：图片保存失败：${error.message || error}`, `Crisp Pulse memos: failed to save the image: ${error.message || error}`), 8000);
      } finally {
        this.imagesSaving -= 1;
      }
      if (links.length) this.insertIntoComposer(links.join("\n"));
      draftsAtStart?.endAttachment?.(this.draftKey);
      this.updateRecordingUi();
      return true;
    };
    input.addEventListener("paste", (event) => {
      const files = event.clipboardData?.files;
      if (files?.length && [...files].some((f) => /^image\//.test(f.type))) { event.preventDefault(); addImages(files); }
    });
    input.addEventListener("dragover", (event) => { if (event.dataTransfer?.types?.includes("Files")) event.preventDefault(); });
    input.addEventListener("drop", (event) => {
      const files = event.dataTransfer?.files;
      if (files?.length && [...files].some((f) => /^image\//.test(f.type) || MEMO_IMAGE_EXT_RE.test(f.name || ""))) { event.preventDefault(); addImages(files); }
    });
    const picker = box.createEl("input", { cls: "crisp-pulse-memo-file", attr: { type: "file", accept: "image/*", multiple: "", tabindex: "-1", "aria-hidden": "true" } });
    picker.addEventListener("change", async () => { const files = [...picker.files]; picker.value = ""; await addImages(files); });
    const imageButton = bar.createEl("button", { cls: "clickable-icon crisp-pulse-memo-tool", attr: { "aria-label": tr("插入图片（也可粘贴或拖入）", "Insert image (or paste / drop one)"), type: "button" } });
    setIcon(imageButton, "image");
    imageButton.addEventListener("mousedown", (e) => e.preventDefault());
    imageButton.addEventListener("click", () => picker.click());
    const mic = bar.createEl("button", { cls: "clickable-icon crisp-pulse-memo-tool crisp-pulse-memo-mic", attr: { "aria-label": tr("录音", "Record"), type: "button" } });
    setIcon(mic, "mic");
    mic.addEventListener("mousedown", (e) => e.preventDefault());
    bindHoldPress(mic, {
      onTap: () => this.toggleRecording(),
      onHoldStart: () => {
        if (!this.plugin.memoDictationAsr() || this.dictation || this.recording || this.recordingStarting || this.recordingSaving) return false;
        void this.startDictation({ held: true });
      },
      onHoldEnd: () => { if (this.dictation?.held) void this.stopDictation(); },
    });
    // 点一下开始、再点一下结束的听写入口：键盘可用，也适合没法一直按住的时候
    if (this.plugin.memoDictationAsr?.()) {
      const dictate = bar.createEl("button", { cls: "clickable-icon crisp-pulse-memo-tool crisp-pulse-memo-dictate", attr: { "aria-label": MEMO_DICTATE_LABEL, type: "button" } });
      setIcon(dictate, "audio-lines");
      dictate.addEventListener("mousedown", (e) => e.preventDefault());
      dictate.addEventListener("click", () => { void this.toggleDictation(); });
    }
    this.statusEl = box.createDiv({ cls: "crisp-pulse-memo-status", attr: { role: "status", "aria-live": "polite" } });
    this.statusSignature = null;
    this.updateRecordingUi();
    this.pendingEl = box.createDiv({ cls: "crisp-pulse-memo-pending" });
    this.renderPendingRecordings();
    const topics = this.mode === "anks" ? this.plugin.memoStore.anksTopics() : [];
    const meta = bar.createDiv({ cls: "crisp-pulse-memo-toolbar-meta" });
    if (topics.length > 1) {
      const select = meta.createEl("select", { cls: "crisp-pulse-memo-topic dropdown", attr: { "aria-label": tr("写入的 Topic", "Topic to write to") } });
      select.createEl("option", { text: tr("选择 Topic", "Choose a Topic"), attr: { value: "" } });
      for (const t of topics) select.createEl("option", { text: t, attr: { value: t } });
      select.value = this.plugin.settings.memoAnksTopic || "";
      select.addEventListener("change", async () => {
        this.plugin.settings.memoAnksTopic = select.value;
        await this.plugin.savePluginData();
      });
    } else {
      meta.createSpan({ cls: "crisp-pulse-memo-mode", text: this.mode === "anks" ? `ANKS · ${topics[0] || ""}` : tr("日笔记", "Daily note") });
    }
    const send = bar.createEl("button", { cls: "crisp-pulse-memo-send", attr: { "aria-label": tr("记录（⏎）· 换行（⇧⏎）", "Save (⏎) · New line (⇧⏎)"), type: "button" } });
    setIcon(send, "send");
    send.disabled = !!(this.memoSubmitting || this.dictation || this.attachmentSaving());
    const submit = async () => {
      if (this.memoSubmitting || !input.value.trim()) return;
      // 听写还没定稿就提交，会存下未定稿的文字，迟到的定稿又会改到下一条草稿
      if (this.dictation) { new Notice(tr("Crisp Pulse 速记：实时听写还没结束，等文字定稿后再记录", "Crisp Pulse memos: live dictation is still running; save once the text is final")); return; }
      if (this.recording || this.recordingStarting) { new Notice(tr("Crisp Pulse 速记：正在录音，结束录音后再记录", "Crisp Pulse memos: recording in progress; stop recording before saving")); return; }
      if (this.attachmentSaving()) { new Notice(tr("Crisp Pulse 速记：附件还在保存，存好后再记录", "Crisp Pulse memos: attachments are still saving; save once they are done")); return; }
      const submitted = input.value;
      const revision = this.draftRevision;
      this.memoSubmitting = true;
      send.disabled = true;
      try {
        // 番茄钟休息时记下的速记带上 #番茄，方便以后回看每一轮做了什么
        const pomodoroBreak = this.plugin.pomodoroBreak;
        const tagged = pomodoroBreak && !pomodoroBreak.dismissed && this.plugin.settings.memoPomodoroPrompt !== false ? memoWithTag(submitted, MEMO_POMODORO_TAG) : submitted;
        await this.plugin.memoStore.capture(tagged, new Date());
        if (!this.composerComposing && this.draftRevision === revision && this.draft === submitted) this.setDraft("");
        await this.reload();
        this.containerEl.children[1].querySelector(".crisp-pulse-memo-input")?.focus();
      } catch (error) {
        new Notice(tr(`Crisp Pulse 速记：${error.message || error}`, `Crisp Pulse memos: ${error.message || error}`), 8000);
      } finally {
        this.memoSubmitting = false;
        const button = this.containerEl.children[1].querySelector(".crisp-pulse-memo-send");
        if (button) button.disabled = !!(this.dictation || this.attachmentSaving());
      }
    };
    send.addEventListener("click", submit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(); }
    });
    if (refocus) window.setTimeout(() => {
      if (!input.isConnected) return;
      input.focus();
      input.setSelectionRange(refocus.start, refocus.end, refocus.direction);
      input.scrollTop = refocus.scroll;
    }, 0);
  }

  renderStats(root, stats) {
    const card = root.createDiv({ cls: "crisp-pulse-memo-stats" });
    const big = card.createDiv({ cls: "crisp-pulse-memo-bignums" });
    const tagCount = new Set(this.memos.flatMap((m) => m.tags)).size;
    for (const [value, label] of [[stats.total, tr("速记", "Memos")], [tagCount, tr("标签", "Tags")], [stats.byDate.size, tr("天", "Days")]]) {
      const k = big.createDiv({ cls: "crisp-pulse-memo-bignum" });
      k.createDiv({ cls: "crisp-pulse-memo-bignum-value", text: value.toLocaleString(PULSE_NUMBER_LOCALE) });
      k.createDiv({ cls: "crisp-pulse-memo-bignum-label", text: label });
    }
    const weeks = stats.cells.length / 7;
    const todayKey = getTodayKey();
    const grid = card.createDiv({ cls: "crisp-pulse-memo-heat", attr: { role: "grid", "aria-label": tr("近 12 周速记热力", "Memo activity, last 12 weeks") } });
    const max = Math.max(1, ...stats.cells.map((c) => c.count));
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < weeks; col++) {
        const cell = stats.cells[col * 7 + row];
        const level = memoHeatLevel(cell.count, max);
        const el = grid.createDiv({ cls: `crisp-pulse-memo-heat-cell level-${level}${cell.future ? " is-future" : ""}${cell.date === todayKey ? " is-today" : ""}${this.filterDate === cell.date ? " is-selected" : ""}` });
        el.setAttribute("title", tr(`${cell.date} · ${cell.count} 条`, `${cell.date} · ${plural(cell.count, "memo")}`));
        if (!cell.future) el.addEventListener("click", () => { this.filterDate = this.filterDate === cell.date ? null : cell.date; this.tab = "all"; this.render(); });
      }
    }
    const months = card.createDiv({ cls: "crisp-pulse-memo-heat-months", attr: { "aria-hidden": "true" } });
    let lastMonth = null;
    for (let col = 0; col < weeks; col++) {
      const week = stats.cells.slice(col * 7, col * 7 + 7);
      // 只在真正包含 1 号的那一列标月份，避免开头两个月挤在一起
      const first = week.find((c) => c.date.endsWith("-01"));
      const month = first ? Number(first.date.slice(5, 7)) : null;
      months.createSpan({ text: month && month !== lastMonth ? pulseMonthLabel(month) : "" });
      if (month) lastMonth = month;
    }
    const foot = card.createDiv({ cls: "crisp-pulse-memo-heat-foot" });
    foot.createDiv({ cls: "crisp-pulse-memo-statline", text: tr(`连续 ${stats.streak} 天 · 本月 ${stats.month} 条 · 近 12 周 ${stats.recent} 条`, `Streak: ${plural(stats.streak, "day")} · ${stats.month} this month · ${stats.recent} in the last 12 weeks`) });
    const legend = foot.createDiv({ cls: "crisp-pulse-memo-heat-legend", attr: { "aria-hidden": "true" } });
    legend.createSpan({ text: tr("少", "Less") });
    for (let level = 0; level <= 4; level++) legend.createSpan({ cls: `crisp-pulse-memo-heat-cell level-${level}` });
    legend.createSpan({ text: tr("多", "More") });
  }

  renderTabs(root, searchFocus) {
    const row = root.createDiv({ cls: "crisp-pulse-memo-tabs" });
    const tabs = row.createDiv({ cls: "crisp-pulse-memo-tablist", attr: { role: "tablist", "aria-label": tr("速记视图", "Memo views") } });
    for (const [id, label] of [["all", tr("全部", "All")], ["review", tr("回顾", "Review")], ["walk", tr("漫步", "Walk")], ["tags", tr("标签", "Tags")]]) {
      const tab = tabs.createEl("button", { cls: `crisp-pulse-memo-tab${this.tab === id ? " is-active" : ""}`, text: label, attr: { role: "tab", "aria-selected": String(this.tab === id) } });
      tab.addEventListener("click", () => {
        if (id === "walk" && !this.walk.trail.length) this.startWalk();
        this.tab = id;
        this.render();
      });
    }
    const searchShown = this.searchOpen || !!this.filters.query;
    const toggle = row.createDiv({ cls: `clickable-icon crisp-pulse-memo-search-toggle${searchShown ? " is-active" : ""}`, attr: { "aria-label": tr("搜索速记", "Search memos"), role: "button", tabindex: "0", "aria-expanded": String(searchShown) } });
    setIcon(toggle, "search");
    const flip = () => {
      // 收起时一并清空搜索词，免得列表停在看不见的筛选上
      if (searchShown) { this.searchOpen = false; this.filters.query = ""; this.render(); return; }
      this.searchOpen = true;
      this.render();
      this.containerEl.children[1].querySelector(".crisp-pulse-memo-search")?.focus();
    };
    toggle.addEventListener("click", flip);
    toggle.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(); } });
    if (searchShown) this.renderSearch(root, searchFocus);
    if (this.tab === "trash") return this.renderTrash(root);
    if (this.tab === "review") return this.renderReview(root);
    if (this.tab === "walk") return this.renderWalk(root);
    if (this.tab === "tags") return this.renderTags(root);
    if (this.showAdvanced) this.renderAdvanced(root);
    this.activeChips = root.createDiv({ cls: "crisp-pulse-memo-filters" });
    this.listEl = root.createDiv({ cls: "crisp-pulse-memo-timeline" });
    this.renderList();
  }

  renderTrash(root) {
    const head = root.createDiv({ cls: "crisp-pulse-memo-section-head" });
    const title = head.createSpan({ cls: "crisp-pulse-memo-section-title", text: tr("回收站", "Trash") });
    const back = head.createEl("button", { cls: "crisp-pulse-memo-chip", text: tr("返回全部", "Back to all") });
    back.addEventListener("click", () => { this.tab = "all"; this.render(); });
    root.createDiv({ cls: "crisp-pulse-memo-muted", text: tr(`删除的速记在这里保留 ${MEMO_TRASH_DAYS} 天，可以恢复到原来的笔记。`, `Deleted memos stay here for ${MEMO_TRASH_DAYS} days and can be restored to their original notes.`) });
    const box = root.createDiv({ cls: "crisp-pulse-memo-timeline" });
    const store = this.plugin.memoStore;
    store.listTrash().then((items) => {
      if (!box.isConnected) return;
      title.setText(tr(`回收站 · ${items.length} 条`, `Trash · ${items.length}`));
      if (!items.length) box.createDiv({ cls: "crisp-pulse-memo-empty", text: tr("回收站是空的。", "The trash is empty.") });
      for (const t of items) {
        const card = box.createDiv({ cls: "crisp-pulse-memo-item is-trashed" });
        const meta = card.createDiv({ cls: "crisp-pulse-memo-item-head" });
        meta.createSpan({ cls: "crisp-pulse-memo-time", text: `${t.date} ${t.time}` });
        const left = Math.max(0, MEMO_TRASH_DAYS - Math.floor((Date.now() - Date.parse(t.deletedAt)) / 86400000));
        meta.createSpan({ cls: "crisp-pulse-memo-muted", text: tr(`${left} 天后清除`, `cleared in ${plural(left, "day")}`) });
        card.createDiv({ cls: "crisp-pulse-memo-text", text: t.text });
        card.createDiv({ cls: "crisp-pulse-memo-muted", text: t.path });
        const row = card.createDiv({ cls: "crisp-pulse-memo-trash-actions" });
        const act = (label, cls, fn) => {
          const b = row.createEl("button", { cls: `crisp-pulse-memo-chip ${cls}`, text: label });
          b.addEventListener("click", async () => {
            b.disabled = true;
            try { await fn(); await this.reload(); }
            catch (error) { new Notice(tr(`Crisp Pulse 速记：${error.message || error}`, `Crisp Pulse memos: ${error.message || error}`), 8000); b.disabled = false; }
          });
        };
        act(tr("恢复", "Restore"), "", () => store.restore(t.id));
        act(tr("彻底删除", "Delete forever"), "mod-warning", () => new Promise((resolve, reject) => {
          this.plugin.confirmAction(tr("彻底删除这条速记？", "Delete this memo forever?"), tr("删除后无法恢复。", "This cannot be undone."), tr("彻底删除", "Delete forever"), () => store.purge(t.id).then(resolve, reject), () => resolve());
        }));
      }
    }).catch((error) => {
      if (box.isConnected) box.createDiv({ cls: "crisp-pulse-memo-error", text: error.message || String(error) });
    });
  }

  renderSearch(root, searchFocus) {
    const container = root.createDiv({ cls: "search-input-container crisp-pulse-memo-searchbox" });
    const search = container.createEl("input", { cls: "crisp-pulse-memo-search", attr: { type: "search", enterkeyhint: "search", spellcheck: "false", placeholder: tr("搜索速记…", "Search memos…"), "aria-label": tr("搜索速记（空格分隔多个词）", "Search memos (separate words with spaces)") } });
    search.value = this.filters.query;
    const clear = container.createDiv({ cls: "search-input-clear-button", attr: { "aria-label": tr("清空搜索", "Clear search") } });
    clear.toggleClass("is-hidden", !this.filters.query);
    clear.addEventListener("click", () => { this.filters.query = ""; this.render(); this.containerEl.children[1].querySelector(".crisp-pulse-memo-search")?.focus(); });
    search.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); this.searchOpen = false; this.filters.query = ""; this.render(); }
    });
    search.addEventListener("input", () => {
      this.filters.query = search.value;
      clear.toggleClass("is-hidden", !search.value);
      if (this.tab !== "all") {
        this.tab = "all";
        const pos = search.selectionStart;
        this.render();
        const again = this.containerEl.children[1].querySelector(".crisp-pulse-memo-search");
        again?.focus();
        again?.setSelectionRange?.(pos, pos);
      } else {
        this.renderList();
      }
    });
    if (searchFocus) {
      window.setTimeout(() => { search.focus(); search.setSelectionRange?.(searchFocus.start, searchFocus.end); }, 0);
    }
    // 快捷筛选：一点就用，再点取消；日期和标签条件留在高级筛选
    const quick = root.createDiv({ cls: "crisp-pulse-memo-quick", attr: { role: "group", "aria-label": tr("快捷筛选", "Quick filters") } });
    const f = this.filters;
    const todayKey = getTodayKey();
    for (const [icon, label, active, flip] of [
      ["tag", tr("无标签", "Untagged"), f.untagged, () => { f.untagged = !f.untagged; }],
      ["link", tr("有链接", "Has links"), f.hasLink, () => { f.hasLink = !f.hasLink; }],
      ["image", tr("有图片", "Has images"), f.hasImage, () => { f.hasImage = !f.hasImage; }],
      ["audio-lines", tr("有语音", "Has audio"), f.hasAudio, () => { f.hasAudio = !f.hasAudio; }],
      ["calendar-days", tr("那年今日", "On this day"), !!f.onThisDay, () => { f.onThisDay = f.onThisDay ? "" : todayKey; }],
    ]) {
      const b = quick.createEl("button", { cls: `crisp-pulse-memo-quick-chip${active ? " is-active" : ""}`, attr: { type: "button", "aria-pressed": String(!!active) } });
      setIcon(b.createSpan({ cls: "crisp-pulse-memo-quick-icon" }), icon);
      b.createSpan({ text: label });
      b.addEventListener("click", () => { flip(); this.tab = "all"; this.render(); });
    }
  }

  renderAdvanced(root) {
    const f = this.filters;
    const panel = root.createDiv({ cls: "crisp-pulse-memo-advanced" });
    const row = (label) => {
      const r = panel.createDiv({ cls: "crisp-pulse-memo-advanced-row" });
      r.createDiv({ cls: "crisp-pulse-memo-advanced-label", text: label });
      return r.createDiv({ cls: "crisp-pulse-memo-advanced-fields" });
    };
    const dates = row(tr("日期", "Dates"));
    const from = dates.createEl("input", { attr: { type: "date", "aria-label": tr("开始日期", "Start date") } });
    from.value = f.from;
    dates.createSpan({ cls: "crisp-pulse-memo-muted", text: tr("至", "to") });
    const to = dates.createEl("input", { attr: { type: "date", "aria-label": tr("结束日期", "End date") } });
    to.value = f.to;
    from.addEventListener("change", () => { f.from = from.value; this.renderList(); });
    to.addEventListener("change", () => { f.to = to.value; this.renderList(); });
    const tagInput = (label, key, placeholder) => {
      const input = row(label).createEl("input", { attr: { type: "text", placeholder, "aria-label": label } });
      input.value = f[key].join(" ");
      input.addEventListener("change", () => {
        f[key] = input.value.split(/[,，\s]+/).map((t) => t.replace(/^#+/, "").trim()).filter(Boolean);
        this.renderList();
      });
    };
    tagInput(tr("包含标签", "Include tags"), "includeTags", tr("#阅读 #工作（含子标签）", "#reading #work (incl. nested tags)"));
    tagInput(tr("排除标签", "Exclude tags"), "excludeTags", tr("#日常", "#daily"));
    const flags = row(tr("其他", "Other"));
    const untagged = flags.createEl("label", { cls: "crisp-pulse-memo-check" });
    const untaggedBox = untagged.createEl("input", { attr: { type: "checkbox" } });
    untaggedBox.checked = f.untagged;
    untagged.appendText(tr(" 只看无标签", " Untagged only"));
    untaggedBox.addEventListener("change", () => { f.untagged = untaggedBox.checked; this.renderList(); });
    for (const [key, label] of [["hasLink", tr("有链接", "Has links")], ["hasImage", tr("有图片", "Has images")], ["hasAudio", tr("有语音", "Has audio")]]) {
      const check = flags.createEl("label", { cls: "crisp-pulse-memo-check" });
      const box = check.createEl("input", { attr: { type: "checkbox" } });
      box.checked = !!f[key];
      check.appendText(` ${label}`);
      box.addEventListener("change", () => { f[key] = box.checked; this.renderList(); });
    }
    const converted = flags.createEl("select", { cls: "dropdown", attr: { "aria-label": tr("转化状态", "Conversion status") } });
    for (const [value, label] of [["", tr("转化状态不限", "Any conversion status")], ["yes", tr("已转化", "Converted")], ["no", tr("未转化", "Not converted")]]) converted.createEl("option", { text: label, attr: { value } });
    converted.value = f.converted === true ? "yes" : f.converted === false ? "no" : "";
    converted.addEventListener("change", () => { f.converted = converted.value === "yes" ? true : converted.value === "no" ? false : null; this.renderList(); });
    const clear = panel.createEl("button", { cls: "crisp-pulse-memo-chip", text: tr("清空筛选", "Clear filters") });
    clear.addEventListener("click", () => { this.resetFilters(); this.render(); });
  }

  resetFilters() {
    this.filters = { query: "", from: "", to: "", includeTags: [], excludeTags: [], untagged: false, converted: null, hasLink: false, hasImage: false, hasAudio: false, onThisDay: "" };
    this.filterDate = null;
    this.filterTag = null;
    this.filterMemoId = null;
  }

  /** 只看某一条速记（从其他插件跳过来时用）。 */
  focusMemo(id) {
    this.resetFilters();
    this.filterMemoId = id;
    this.tab = "all";
    this.showAdvanced = false;
    void this.reload();
  }

  isFiltered() {
    const f = this.filters;
    return !!(this.filterMemoId || this.filterDate || this.filterTag || f.query.trim() || f.from || f.to || f.includeTags.length || f.excludeTags.length || f.untagged || f.converted !== null || f.hasLink || f.hasImage || f.hasAudio || f.onThisDay);
  }

  visibleMemos() {
    const f = this.filters;
    let list = filterMemos(this.memos, { ...f, includeTags: this.filterTag ? [...f.includeTags, this.filterTag] : f.includeTags });
    if (this.filterDate) list = list.filter((m) => m.date === this.filterDate);
    if (this.filterMemoId) list = list.filter((m) => m.id === this.filterMemoId);
    return list;
  }

  renderList() {
    if (!this.listEl) return;
    const chips = this.activeChips;
    chips.empty();
    const chip = (text, clear) => {
      const c = chips.createEl("button", { cls: "crisp-pulse-memo-chip is-active", text: `${text} ×` });
      c.addEventListener("click", () => { clear(); this.render(); });
    };
    if (this.filterMemoId) chip(tr("这一条", "This memo"), () => { this.filterMemoId = null; });
    if (this.filterDate) chip(this.filterDate, () => { this.filterDate = null; });
    if (this.filterTag) chip(`#${this.filterTag}`, () => { this.filterTag = null; });
    const f = this.filters;
    if (f.from) chip(tr(`从 ${f.from}`, `From ${f.from}`), () => { f.from = ""; });
    if (f.to) chip(tr(`至 ${f.to}`, `To ${f.to}`), () => { f.to = ""; });
    for (const tag of f.includeTags) chip(tr(`包含 #${tag}`, `Include #${tag}`), () => { f.includeTags = f.includeTags.filter((t) => t !== tag); });
    for (const tag of f.excludeTags) chip(tr(`排除 #${tag}`, `Exclude #${tag}`), () => { f.excludeTags = f.excludeTags.filter((t) => t !== tag); });
    if (f.untagged) chip(tr("无标签", "Untagged"), () => { f.untagged = false; });
    if (f.converted !== null) chip(f.converted ? tr("已转化", "Converted") : tr("未转化", "Not converted"), () => { f.converted = null; });
    if (f.hasLink) chip(tr("有链接", "Has links"), () => { f.hasLink = false; });
    if (f.hasImage) chip(tr("有图片", "Has images"), () => { f.hasImage = false; });
    if (f.hasAudio) chip(tr("有语音", "Has audio"), () => { f.hasAudio = false; });
    if (f.onThisDay) chip(tr("那年今日", "On this day"), () => { f.onThisDay = ""; });
    this.containerEl.querySelector(`[aria-label="${MEMO_FILTER_LABEL}"]`)?.toggleClass("is-active", this.showAdvanced || this.isFiltered());
    const list = this.visibleMemos();
    if (this.isFiltered()) chips.createSpan({ cls: "crisp-pulse-memo-muted", text: tr(`找到 ${list.length} 条`, `${plural(list.length, "match", "matches")}`) });
    // 换了筛选条件就从第一批重新开始
    const signature = JSON.stringify([this.filters, this.filterDate, this.filterTag, this.filterMemoId]);
    if (signature !== this.listSignature) { this.listSignature = signature; this.shown = MEMO_PAGE_SIZE; }
    this.moreObserver?.disconnect();
    this.clearMemoMarkdown(this.listEl);
    this.listEl.empty();
    if (!list.length) {
      this.listEl.createDiv({ cls: "crisp-pulse-memo-empty", text: this.memos.length ? tr("这个范围里没有速记", "No memos match") : tr("还没有速记。在上面写下第一条吧。", "No memos yet. Write your first one above.") });
    }
    this.appendMemoPage(list, 0);
  }

  /** 从 start 起接着渲染到 this.shown 条；底部按钮进入视野时自动再加一批，也可以点。 */
  appendMemoPage(list, start) {
    const end = Math.min(list.length, this.shown);
    for (const m of list.slice(start, end)) this.renderMemoCard(this.listEl, m);
    if (end >= list.length) {
      if (list.length > MEMO_PAGE_SIZE) this.listEl.createDiv({ cls: "crisp-pulse-memo-end", text: tr(`共 ${list.length} 条，已经到底了`, `That’s all ${list.length}`) });
      return;
    }
    const more = this.listEl.createEl("button", { cls: "crisp-pulse-memo-more", text: tr(`加载更早的速记（还有 ${list.length - end} 条）`, `Load earlier memos (${list.length - end} more)`) });
    const next = () => {
      if (!more.isConnected) return;
      this.moreObserver?.disconnect();
      more.remove();
      this.shown = end + MEMO_PAGE_SIZE;
      this.appendMemoPage(list, end);
    };
    more.addEventListener("click", next);
    const Observer = this.containerEl.win?.IntersectionObserver || (typeof IntersectionObserver === "function" ? IntersectionObserver : null);
    if (Observer) {
      this.moreObserver = new Observer((entries) => { if (entries.some((e) => e.isIntersecting)) next(); }, { root: this.containerEl.children[1], rootMargin: "0px 0px 240px 0px" });
      this.moreObserver.observe(more);
    }
  }

  /** 长速记只露出前几行，点「展开」看全文；展开状态在重绘后保留。 */
  clampLongMemo(card, body, key) {
    const win = body.win || window;
    win.requestAnimationFrame(() => {
      if (!body.isConnected || card.querySelector(".crisp-pulse-memo-expand")) return;
      body.addClass("is-clamped");
      const overflow = body.scrollHeight - body.clientHeight;
      body.removeClass("is-clamped");
      // 只多出一两行就不折叠，折了反而更麻烦
      if (overflow < 48) {
        // 图片加载完才有高度，等它撑开后再量一次
        for (const img of body.querySelectorAll("img")) if (!img.complete) img.addEventListener("load", () => this.clampLongMemo(card, body, key), { once: true });
        if (!body.dataset.clampRetried) { body.dataset.clampRetried = "1"; win.setTimeout(() => this.clampLongMemo(card, body, key), 400); }
        return;
      }
      const expanded = this.expandedMemos.has(key);
      body.toggleClass("is-clamped", !expanded);
      const toggle = createEl("button", { cls: "crisp-pulse-memo-expand", text: expanded ? tr("收起", "Collapse") : tr("展开", "Expand") });
      body.insertAdjacentElement("afterend", toggle);
      toggle.addEventListener("click", () => {
        const open = body.hasClass("is-clamped");
        body.toggleClass("is-clamped", !open);
        toggle.setText(open ? tr("收起", "Collapse") : tr("展开", "Expand"));
        if (open) this.expandedMemos.add(key); else this.expandedMemos.delete(key);
      });
    });
  }

  renderReview(root) {
    const s = this.plugin.settings;
    const todayKey = getTodayKey();
    const tags = String(s.memoReviewTags || "").split(/[,，\s]+/).map((t) => t.replace(/^#+/, "").trim()).filter(Boolean);
    const review = selectDailyReview(this.memos, todayKey, { count: s.memoReviewCount, tags, withinDays: Number(s.memoReviewWithinDays) || 0, batch: this.reviewBatch || 0 });
    const head = root.createDiv({ cls: "crisp-pulse-memo-section-head" });
    head.createSpan({ cls: "crisp-pulse-memo-section-title", text: tr(`今日回顾 · ${review.length} 条`, `Today’s review · ${review.length}`) });
    const again = head.createEl("button", { cls: "crisp-pulse-memo-chip", text: tr("换一批", "Shuffle") });
    again.addEventListener("click", () => { this.reviewBatch = (this.reviewBatch || 0) + 1; this.render(); });
    const scope = [tags.length ? tags.map((t) => `#${t}`).join(" ") : tr("全部标签", "All tags"), Number(s.memoReviewWithinDays) ? tr(`近 ${s.memoReviewWithinDays} 天`, `last ${plural(Number(s.memoReviewWithinDays), "day")}`) : tr("全部时间", "All time")].join(" · ");
    root.createDiv({ cls: "crisp-pulse-memo-muted", text: tr(`范围：${scope}（在设置里调整）。同一天打开看到的是同一组。`, `Scope: ${scope} (change it in Settings). You see the same set all day.`) });
    const box = root.createDiv({ cls: "crisp-pulse-memo-timeline" });
    if (!review.length) box.createDiv({ cls: "crisp-pulse-memo-empty", text: tr("还没有可回顾的旧速记。今天记下的内容，从明天起会出现在这里。", "No older memos to review yet. What you capture today will show up here from tomorrow.") });
    for (const m of review) this.renderMemoCard(box, m);
    const groups = onThisDay(this.memos, todayKey);
    const past = root.createDiv({ cls: "crisp-pulse-memo-section-head" });
    past.createSpan({ cls: "crisp-pulse-memo-section-title", text: tr("去年今日", "On this day") });
    const pastBox = root.createDiv({ cls: "crisp-pulse-memo-timeline" });
    if (!groups.length) pastBox.createDiv({ cls: "crisp-pulse-memo-empty", text: tr("往年和上个月的今天还没有速记。", "No memos from this day last month or in past years yet.") });
    for (const g of groups) {
      pastBox.createDiv({ cls: "crisp-pulse-memo-group-label", text: `${g.label} · ${g.date}` });
      for (const m of g.memos) this.renderMemoCard(pastBox, m);
    }
  }

  startWalk(from = null) {
    const first = from || pickRandomMemo(this.memos);
    this.walk = { trail: first ? [first] : [], step: null };
  }

  stepWalk() {
    const current = this.findSame(this.walk.trail.at(-1));
    if (!current) { this.startWalk(); return; }
    const visited = new Set(this.walk.trail.map((m) => this.findSame(m)).filter(Boolean));
    const step = walkStep(current, this.getIndex(), visited);
    if (!step) { new Notice(tr("这一路已经走遍了，重新开始吧", "You’ve walked this whole path. Start again")); return; }
    this.walk.trail.push(step.memo);
    this.walk.step = step;
  }

  renderWalk(root) {
    const head = root.createDiv({ cls: "crisp-pulse-memo-section-head" });
    head.createSpan({ cls: "crisp-pulse-memo-section-title", text: tr("随机漫步", "Random walk") });
    const actions = head.createDiv({ cls: "crisp-pulse-memo-head-actions" });
    const btn = (text, fn, disabled = false) => {
      const b = actions.createEl("button", { cls: "crisp-pulse-memo-chip", text });
      b.disabled = disabled;
      b.addEventListener("click", () => { fn(); this.render(); });
    };
    btn(tr("后退", "Back"), () => { this.walk.trail.pop(); this.walk.step = null; }, this.walk.trail.length < 2);
    btn(tr("重新开始", "Start over"), () => this.startWalk());
    const current = this.findSame(this.walk.trail.at(-1));
    root.createDiv({ cls: "crisp-pulse-memo-muted", text: tr("从一条速记出发，沿着内容相近的速记一条条走下去；相近度按本地文字与标签计算，不联网。", "Start from one memo and keep walking to similar ones. Similarity is computed locally from text and tags, with no network.") });
    if (!current) {
      root.createDiv({ cls: "crisp-pulse-memo-empty", text: this.memos.length ? tr("点「重新开始」随机选一个起点。", "Press “Start over” to pick a random starting point.") : tr("还没有速记，先记几条再来漫步。", "No memos yet. Capture a few before walking.") });
      return;
    }
    if (this.walk.trail.length > 1) {
      const trail = root.createDiv({ cls: "crisp-pulse-memo-trail" });
      this.walk.trail.forEach((m, i) => {
        if (i) trail.createSpan({ cls: "crisp-pulse-memo-muted", text: "›" });
        const dot = trail.createEl("button", { cls: `crisp-pulse-memo-trail-step${i === this.walk.trail.length - 1 ? " is-current" : ""}`, text: memoSafeTitle(m.text).slice(0, 10) });
        dot.setAttribute("title", m.text);
        dot.addEventListener("click", () => { this.walk.trail = this.walk.trail.slice(0, i + 1); this.walk.step = null; this.render(); });
      });
    }
    const step = this.walk.step;
    if (step) {
      root.createDiv({ cls: "crisp-pulse-memo-why", text: step.via === "related" ? tr(`因为共同的：${step.shared.join("、")}`, `Shared: ${step.shared.join(", ")}`) : tr("附近没有相近的了，随机跳到一条没走过的", "Nothing similar nearby, so jumped to a random unvisited memo") });
    }
    const box = root.createDiv({ cls: "crisp-pulse-memo-timeline" });
    this.renderMemoCard(box, current, { related: true, walk: true });
    const next = root.createEl("button", { cls: "crisp-pulse-memo-walk-next mod-cta", text: tr("继续漫步 →", "Keep walking →") });
    next.addEventListener("click", () => { this.stepWalk(); this.render(); });
  }

  renderTags(root) {
    const tree = buildTagTree(this.memos);
    const untagged = this.memos.filter((m) => !m.tags.length).length;
    const box = root.createDiv({ cls: "crisp-pulse-memo-tagtree", attr: { role: "tree", "aria-label": tr("标签", "Tags") } });
    if (!tree.length) box.createDiv({ cls: "crisp-pulse-memo-empty", text: tr("还没有标签。在速记里写 #主题/子主题 就会出现在这里。", "No tags yet. Write #topic/subtopic in a memo and it will show up here.") });
    this.collapsedTags = this.collapsedTags || new Set();
    const renderNode = (node, depth) => {
      const row = box.createDiv({ cls: "crisp-pulse-memo-tagrow", attr: { role: "treeitem" } });
      row.style.paddingLeft = `${depth * 14}px`;
      const collapsed = this.collapsedTags.has(node.path);
      const twisty = row.createEl("button", { cls: "crisp-pulse-memo-twisty", text: node.children.length ? (collapsed ? "▸" : "▾") : "", attr: { "aria-label": collapsed ? tr("展开", "Expand") : tr("折叠", "Collapse") } });
      if (node.children.length) twisty.addEventListener("click", () => { if (collapsed) this.collapsedTags.delete(node.path); else this.collapsedTags.add(node.path); this.render(); });
      const name = row.createEl("button", { cls: "crisp-pulse-memo-tagname", text: `# ${node.name}` });
      name.setAttribute("title", tr(`看 #${node.path}（含子标签）`, `Show #${node.path} (incl. nested tags)`));
      name.addEventListener("click", () => { this.resetFilters(); this.filterTag = node.path; this.tab = "all"; this.render(); });
      row.createSpan({ cls: "crisp-pulse-memo-muted", text: String(node.count) });
      const rename = row.createEl("button", { cls: "crisp-pulse-memo-action", text: tr("改名", "Rename") });
      rename.addEventListener("click", () => this.plugin.promptRenameTag(node.path, () => this.reload()));
      if (!collapsed) for (const child of node.children) renderNode(child, depth + 1);
    };
    for (const node of tree) renderNode(node, 0);
    if (untagged) {
      const row = box.createDiv({ cls: "crisp-pulse-memo-tagrow" });
      const name = row.createEl("button", { cls: "crisp-pulse-memo-tagname is-muted", text: tr("无标签", "Untagged") });
      name.addEventListener("click", () => { this.resetFilters(); this.filters.untagged = true; this.showAdvanced = true; this.tab = "all"; this.render(); });
      row.createSpan({ cls: "crisp-pulse-memo-muted", text: String(untagged) });
    }
  }

  memoTimeLabel(m) {
    const diff = Math.round((memoKeyToDay(getTodayKey()) - memoKeyToDay(m.date)) / 86400000);
    const day = diff === 0 ? tr("今天", "Today") : diff === 1 ? tr("昨天", "Yesterday") : m.date;
    return `${day} ${m.time || ""}`.trim();
  }

  openCardMenu(m, event) {
    if (!Menu) return;
    const menu = new Menu();
    const done = () => this.reload();
    const run = (fn) => async () => {
      try { await fn(); done(); } catch (error) { new Notice(tr(`Crisp Pulse 速记：${error.message || error}`, `Crisp Pulse memos: ${error.message || error}`), 8000); }
    };
    const key = this.memoKey(m);
    menu.addItem((i) => i.setTitle(this.expanded === key ? tr("收起相关笔记", "Hide related memos") : tr("相关笔记", "Related memos")).setIcon("sparkles").onClick(() => { this.expanded = this.expanded === key ? null : key; this.render(); }));
    menu.addItem((i) => i.setTitle(tr("从这里漫步", "Walk from here")).setIcon("shuffle").onClick(() => { this.startWalk(m); this.tab = "walk"; this.render(); }));
    menu.addSeparator();
    menu.addItem((i) => i.setTitle(tr("转为笔记", "Convert to note")).setIcon("file-plus").onClick(run(() => this.plugin.convertMemoToNote(m))));
    // 装了 Tempo 才出现；已经转过的速记点它是打开那条任务
    const tempo = this.plugin.memoTempo();
    if (tempo) {
      const live = m.id ? this.tempoSnapshots?.[`crisp-pulse:${m.id}`] : null;
      const taskId = live?.id;
      menu.addItem((i) => i.setTitle(taskId ? tr("在 Tempo 中打开任务", "Open task in Tempo") : m.tempoTasks?.length ? tr("重新转为 Tempo 任务", "Convert to a Tempo task again") : tr("转为 Tempo 任务", "Convert to a Tempo task")).setIcon("list-checks").onClick(async () => {
        try {
          if (taskId) await tempo.revealTask(taskId);
          else { await this.plugin.convertMemoToTempo(m); new Notice(tr("已转为 Tempo 任务", "Converted to a Tempo task")); done(); }
        } catch (error) { new Notice(tr(`Crisp Pulse 速记：${error.message || error}`, `Crisp Pulse memos: ${error.message || error}`), 8000); }
      }));
    }
    if (this.mode === "anks") {
      menu.addItem((i) => i.setTitle(tr("转为 ANKS 问题", "Convert to an ANKS question")).setIcon("help-circle").onClick(run(() => this.plugin.convertMemoToQuestion(m))));
      const inNow = m.links.some((link) => link.startsWith(`${ANKS_NOW_FILE.replace(/\.md$/, "")}#^pulse-memo-`));
      menu.addItem((i) => i.setTitle(inNow ? tr("已加入 Now 行动", "Added to Now actions") : tr("加入 Now 行动", "Add to Now actions")).setIcon("check-square").onClick(run(() => this.plugin.convertMemoToNow(m))));
    }
    menu.addSeparator();
    menu.addItem((i) => i.setTitle(tr("复制", "Copy")).setIcon("copy").onClick(async () => { await navigator.clipboard.writeText(m.text); new Notice(tr("已复制速记", "Memo copied")); }));
    menu.addItem((i) => i.setTitle(tr("打开所在笔记", "Open source note")).setIcon("file-text").onClick(() => this.plugin.openMemoSource(m)));
    menu.addItem((i) => i.setTitle(tr("删除", "Delete")).setIcon("trash-2").onClick(() => this.plugin.confirmDeleteMemo(m, done)));
    menu.showAtMouseEvent(event);
  }

  renderMemoCard(parent, m, { related = false, walk = false } = {}) {
    const key = this.memoKey(m);
    const card = parent.createDiv({ cls: `crisp-pulse-memo-item${walk ? " is-walk" : ""}` });
    const head = card.createDiv({ cls: "crisp-pulse-memo-item-head" });
    const time = head.createEl("button", { cls: "crisp-pulse-memo-time", text: this.memoTimeLabel(m) });
    time.setAttribute("aria-label", tr(`打开 ${m.path}`, `Open ${m.path}`));
    time.addEventListener("click", () => this.plugin.openMemoSource(m));
    const more = head.createEl("button", { cls: "clickable-icon crisp-pulse-memo-more-btn", attr: { "aria-label": tr("更多操作", "More actions") } });
    setIcon(more, "more-horizontal");
    more.addEventListener("click", (event) => this.openCardMenu(m, event));
    const body = card.createDiv({ cls: "crisp-pulse-memo-text" });
    if (MarkdownRenderer && Component) {
      const component = new Component();
      this.memoMarkdownComponents ||= new Map();
      this.memoMarkdownComponents.set(body, component);
      component.load();
      MarkdownRenderer.render(this.app, m.text, body, m.path, component).then(() => {
        if (this.memoMarkdownComponents.get(body) !== component) { component.unload(); return; }
        for (const tag of body.querySelectorAll("a.tag")) tag.addClass("crisp-pulse-memo-tag");
        this.clampLongMemo(card, body, key);
      }).catch((error) => {
        if (this.memoMarkdownComponents.get(body) !== component) return;
        component.unload();
        this.memoMarkdownComponents.delete(body);
        body.setText(m.text);
        body.createDiv({ cls: "crisp-pulse-memo-error", text: tr(`显示格式失败：${error.message || error}`, `Failed to render formatting: ${error.message || error}`) });
      });
      body.addEventListener("click", (event) => {
        const link = event.target.closest?.("a");
        if (!link || !body.contains(link)) return;
        if (link.classList.contains("tag")) {
          event.preventDefault(); event.stopPropagation();
          this.resetFilters(); this.filterTag = (link.getAttribute("href") || link.textContent).replace(/^#/, ""); this.tab = "all"; this.render();
        } else if (link.classList.contains("internal-link")) {
          event.preventDefault(); event.stopPropagation();
          this.app.workspace.openLinkText(link.getAttribute("data-href") || link.getAttribute("href"), m.path, event.metaKey || event.ctrlKey);
        }
      });
    } else {
      body.setText(m.text);
      this.clampLongMemo(card, body, key);
    }
    if (m.tempoTasks?.length && m.id) {
      const row = card.createDiv({ cls: "crisp-pulse-memo-tempo" });
      this.memoTempoRows ||= new Map();
      this.memoTempoRows.set(row, m);
      this.renderTempoChip(row, m);
      this.scheduleTempoRefresh();
    }
    if (memoAudioLinks(m.text).length) {
      const row = card.createDiv({ cls: "crisp-pulse-memo-audio-actions" });
      this.memoTranscriptionControls ||= new Map();
      this.memoTranscriptionControls.set(row, m);
      this.renderMemoTranscriptionControls(row, m);
    }
    for (const link of m.links) {
      const l = card.createDiv({ cls: "crisp-pulse-memo-link" });
      setIcon(l.createSpan({ cls: "crisp-pulse-memo-link-icon" }), "corner-down-right");
      l.createSpan({ text: link });
      l.addEventListener("click", () => this.app.workspace.openLinkText(link, m.path));
    }
    if (related || this.expanded === key) this.renderRelated(card, m, walk);
  }

  scheduleTempoRefresh() {
    if (this.tempoRefreshQueued) return;
    this.tempoRefreshQueued = true;
    window.setTimeout(() => { this.tempoRefreshQueued = false; this.refreshTempoChips(); }, 0);
  }

  /** 向 Tempo 一次性查回所有可见卡片的任务状态。 */
  /** 并发刷新时只让最新一次请求落到界面；读取失败时保留上次读到的状态，不当成任务被删。 */
  async refreshTempoChips() {
    if (this.memoClosed || !this.memoTempoRows?.size) return;
    const rows = this.memoTempoRows;
    const generation = (this.tempoRefreshGeneration || 0) + 1;
    this.tempoRefreshGeneration = generation;
    for (const row of [...rows.keys()]) if (!row.isConnected) rows.delete(row);
    const tempo = this.plugin.memoTempo();
    let snapshots = null;
    let failed = false;
    if (tempo) {
      try { snapshots = await tempo.getTasksBySource([...rows.values()].map((m) => `crisp-pulse:${m.id}`)); }
      catch (error) { failed = true; console.warn("[Crisp Pulse] Tempo 任务状态读取失败", error); }
    }
    if (generation !== this.tempoRefreshGeneration || this.memoClosed || rows !== this.memoTempoRows) return;
    if (failed) {
      for (const [row, m] of rows) if (row.isConnected) this.renderTempoChip(row, m, this.tempoSnapshots || null, { stale: true });
      return;
    }
    this.tempoSnapshots = snapshots || {};
    for (const [row, m] of rows) if (row.isConnected) this.renderTempoChip(row, m, tempo ? snapshots : undefined);
  }

  renderTempoChip(row, m, snapshots = null, { stale = false } = {}) {
    row.empty();
    const chip = row.createEl("button", { cls: "crisp-pulse-memo-chip crisp-pulse-memo-tempo-chip", attr: { type: "button" } });
    setIcon(chip.createSpan({ cls: "crisp-pulse-memo-quick-icon" }), "list-checks");
    if (snapshots === undefined) { chip.createSpan({ text: tr("Tempo 任务（Tempo 未启用）", "Tempo task (Tempo not enabled)") }); chip.disabled = true; return; }
    const key = `crisp-pulse:${m.id}`;
    if (snapshots === null || (stale && !(key in snapshots))) {
      chip.createSpan({ text: stale ? tr("Tempo 任务（状态读取失败）", "Tempo task (failed to read status)") : tr("Tempo 任务", "Tempo task") });
      chip.disabled = true;
      return;
    }
    const task = snapshots[key];
    const label = memoTempoLabel(task);
    chip.createSpan({ text: `Tempo · ${label}${stale ? tr("（读取失败，显示上次状态）", " (read failed, showing last status)") : ""}` });
    chip.toggleClass("is-done", task?.status === "done");
    chip.setAttribute("aria-label", task ? tr(`在 Tempo 中打开：${task.title}`, `Open in Tempo: ${task.title}`) : tr("这条任务在 Tempo 里已删除，可以从菜单重新转为任务", "This task was deleted in Tempo; convert it again from the menu"));
    chip.disabled = !task;
    chip.addEventListener("click", async () => {
      try { await this.plugin.memoTempo()?.revealTask(task.id); }
      catch (error) { new Notice(tr(`Crisp Pulse 速记：${error.message || error}`, `Crisp Pulse memos: ${error.message || error}`), 8000); }
    });
  }

  refreshMemoTranscriptionControls() {
    if (this.memoClosed) return;
    const asr = this.plugin.memoAsr();
    const signature = JSON.stringify([!!asr, [...(this.plugin.memoTranscriptionStarting || [])], (asr?.getMemoTranscriptionJobs() || []).map((j) => [j.id, j.status, j.lastError || "", !!j.transcriptText])]);
    if (signature === this.memoAsrSignature) return;
    this.memoAsrSignature = signature;
    for (const [row, memo] of this.memoTranscriptionControls || []) {
      if (!row.isConnected) { this.memoTranscriptionControls.delete(row); continue; }
      this.renderMemoTranscriptionControls(row, memo);
    }
  }

  renderMemoTranscriptionControls(row, memo) {
    row.empty();
    const asr = this.plugin.memoAsr();
    const files = memoAudioFiles(memo, this.app);
    if (!files.length) { row.createSpan({ cls: "crisp-pulse-memo-muted", text: tr("录音文件已不存在", "The recording file no longer exists") }); return; }
    const jobs = asr?.getMemoTranscriptionJobs() || [];
    for (const file of files) {
      const item = row.createDiv({ cls: "crisp-pulse-memo-audio-action" });
      if (files.length > 1) item.createSpan({ cls: "crisp-pulse-memo-audio-name", text: file.name || file.path });
      const job = [...jobs].reverse().find((job) => job.memoId === memo.id && job.sourcePath === file.path);
      const starting = !!this.plugin.memoTranscriptionStarting?.has(`${memo.path}:${memo.id || memo.startLine}:${file.path}`);
      const state = memoTranscriptionState({ memo, job, starting, hasAsr: !!asr, filePath: file.path, ...this.plugin.memoStore.transcriptMatch(memo) });
      const button = item.createEl("button", { cls: "crisp-pulse-memo-chip", text: state.label, attr: { type: "button", "aria-label": `${state.label}${tr("：", ": ")}${file.name || file.path}` } });
      button.disabled = state.disabled;
      button.title = !asr ? tr("请启用 Crisp ASR 0.8.0 或更高版本", "Enable Crisp ASR 0.8.0 or later") : tr("通过 Crisp ASR 转写，使用其语音识别服务设置", "Transcribe with Crisp ASR, using its speech recognition settings");
      if (state.error) {
        const error = item.createDiv({ cls: "crisp-pulse-memo-audio-error" });
        error.createSpan({ text: state.error });
        if (state.errorDetail) {
          const more = error.createEl("details", { cls: "crisp-pulse-memo-error-detail" });
          more.createEl("summary", { text: tr("详细错误", "Error details") });
          more.createDiv({ text: state.errorDetail });
        }
      }
      if (!asr) item.createSpan({ cls: "crisp-pulse-memo-muted", text: tr("转文字需要 Crisp ASR 0.8.0 或更高版本", "Transcription requires Crisp ASR 0.8.0 or later") });
      button.addEventListener("click", async () => {
        button.disabled = true;
        try { await this.plugin.transcribeMemoAudio(memo, file.path); }
        catch (error) { new Notice(tr(`Crisp Pulse 速记：${error.message || error}`, `Crisp Pulse memos: ${error.message || error}`), 8000); }
        finally { if (row.isConnected) this.renderMemoTranscriptionControls(row, memo); }
      });
    }
  }

  renderRelated(card, m, walk) {
    const box = card.createDiv({ cls: "crisp-pulse-memo-related" });
    const visited = walk ? new Set(this.walk.trail.map((x) => this.findSame(x)).filter(Boolean)) : null;
    const list = relatedMemos(m, this.getIndex(), { limit: walk ? 10 : 5 }).filter((r) => !visited || !visited.has(r.memo)).slice(0, 5);
    box.createDiv({ cls: "crisp-pulse-memo-related-title", text: list.length ? `${tr("相关速记", "Related memos")} · ${list.length}` : tr("没有找到内容相近的速记", "No similar memos found") });
    for (const r of list) {
      const row = box.createEl("button", { cls: "crisp-pulse-memo-related-row" });
      row.createSpan({ cls: "crisp-pulse-memo-related-text", text: r.memo.text.replace(/\n+/g, " ") });
      row.createSpan({ cls: "crisp-pulse-memo-related-why", text: `${r.memo.date} · ${r.shared.join(tr("、", ", "))}` });
      row.addEventListener("click", () => {
        if (walk) {
          this.walk.trail.push(r.memo);
          this.walk.step = { memo: r.memo, via: "related", shared: r.shared, score: r.score };
        } else {
          this.startWalk(m);
          this.walk.trail.push(r.memo);
          this.walk.step = { memo: r.memo, via: "related", shared: r.shared, score: r.score };
          this.tab = "walk";
        }
        this.render();
      });
    }
  }
}

class CrispPulseSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: `${tr("Crisp Pulse 知识脉冲设置", "Crisp Pulse Settings")}${this.plugin.manifest?.version ? ` (v${this.plugin.manifest.version})` : ""}` });

    // 0. Software License & Activation
    containerEl.createEl("h3", { text: tr("软件授权", "License") });

    const statusSetting = new Setting(containerEl)
      .setName(tr("当前激活状态", "Activation status"))
      .setDesc(tr("正在验证授权状态...", "Verifying license..."));

    const updateStatusDesc = (status) => {
      if (status && status.valid && status.payload) {
        const owner = status.payload.userName || tr("Crisp 用户", "Crisp user");
        const expiry = status.payload.expiresAt
          ? tr(`，到期时间: ${String(status.payload.expiresAt).split("T")[0]}`, `, expires ${String(status.payload.expiresAt).split("T")[0]}`)
          : "";
        const verification = status.source === "offline" ? tr("离线验证", "verified offline") : tr("在线验证", "verified online");
        statusSetting.setDesc(tr(`✅ 已激活（授权给: ${owner}${expiry}，${verification}）`, `✅ Activated (licensed to ${owner}${expiry}, ${verification})`));
      } else if (this.plugin.settings.licenseCode) {
        statusSetting.setDesc(tr(`❌ 未激活（${status?.reason || "授权码无效"}）`, `❌ Not activated (${status?.reason || "invalid license code"})`));
      } else {
        statusSetting.setDesc(tr(`❌ 未激活。看板视图、数据记录、备份与导出照常可用；${Object.values(PULSE_GATED_FEATURES).join("、")}需要激活。`, `❌ Not activated. The dashboard, data recording, backups and exports work as usual; ${Object.values(PULSE_GATED_FEATURES).join(", ")} require activation.`));
      }
    };

    updateStatusDesc(this.plugin.licenseManager?.getStatus());

    new Setting(containerEl)
      .setName(tr("输入授权码", "License code"))
      .setDesc(tr("粘贴购买获取的 Crisp Suite 授权字符串进行离线/在线激活。", "Paste the Crisp Suite license string you received after purchase to activate offline or online."))
      .addText((text) => {
        text
          .setPlaceholder(tr("粘贴 Crisp 授权码...", "Paste your Crisp license code..."))
          .setValue(this.licenseDraft !== undefined ? this.licenseDraft : (this.plugin.settings.licenseCode || ""))
          .onChange((value) => {
            this.licenseDraft = value.trim();
          });
      })
      .addButton((button) =>
        button
          .setButtonText(tr("激活 / 重新验证", "Activate / re-verify"))
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText(tr("正在验证...", "Verifying..."));
            const codeToVerify = this.licenseDraft !== undefined ? this.licenseDraft : (this.plugin.settings.licenseCode || "");
            const result = await this.plugin.activateLicense(codeToVerify);
            if (result.valid && result.payload) {
              new Notice(tr(`🎉 Crisp Pulse 激活成功！欢迎使用，${result.payload.userName || "Crisp 用户"}`, `🎉 Crisp Pulse activated. Welcome, ${result.payload.userName || "Crisp user"}`));
            } else {
              new Notice(tr(`❌ 激活失败: ${result.reason || "未知错误"}`, `❌ Activation failed: ${result.reason || "unknown error"}`));
            }
            this.display();
          })
      );

    // 1. Scope & Cycles
    containerEl.createEl("h3", { text: tr("统计周期与范围", "Tracking period and scope") });

    new Setting(containerEl)
      .setName(tr("默认数据质量范围", "Default data scope"))
      .setDesc(tr("控制统计时包含的数据类型", "Which kinds of data the stats include"))
      .addDropdown((drop) =>
        drop
          .addOption("reliable", tr("可靠记录 (排除旧版异常数据与估算打卡)", "Reliable records (excludes abnormal legacy data and estimated days)"))
          .addOption("recorded_only", tr("仅实测记录 (彻底忽略历史估算)", "Measured only (ignores all historical estimates)"))
          .addOption("all", tr("全部历史 (包含历史估算与旧版数据)", "All history (includes historical estimates and legacy data)"))
          .setValue(this.plugin.settings.dataQualityScope || "reliable")
          .onChange(async (val) => {
            this.plugin.settings.dataQualityScope = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(tr("默认看板时间跨度", "Default dashboard time range"))
      .setDesc(tr("打开 Pulse View 时默认统计的日期范围", "The date range shown when Pulse View opens"))
      .addDropdown((drop) =>
        drop
          .addOption("year", tr("近 53 周 (全年)", "Last 53 weeks (full year)"))
          .addOption("90d", tr("最近 90 天", "Last 90 days"))
          .addOption("30d", tr("最近 30 天", "Last 30 days"))
          .addOption("7d", tr("本周 (最近 7 天)", "This week (last 7 days)"))
          .addOption("ytd", tr("本自然年 (YTD)", "This calendar year (YTD)"))
          .setValue(this.plugin.settings.defaultDateRange || "year")
          .onChange(async (val) => {
            this.plugin.settings.defaultDateRange = val;
            await this.plugin.saveSettings();
          })
      );

    const cycleDesc = this.plugin.settings.trackingStartDate
      ? tr(`当前统计周期从 ${this.plugin.settings.trackingStartDate} 开始计算`, `The current tracking period starts on ${this.plugin.settings.trackingStartDate}`)
      : tr("尚未设定新周期（从历史首日开始计算）", "No new period set (counting from the first recorded day)");

    new Setting(containerEl)
      .setName(tr("开启新统计周期", "Start a new tracking period"))
      .setDesc(tr(`重设打卡与总分的计算起始日。历史数据将被完整保留，但早于此日期的异常数据不再影响连续打卡天数。\n${cycleDesc}`, `Reset the start date for streaks and the total score. All history is kept, but abnormal data before this date no longer affects your streak.\n${cycleDesc}`))
      .addButton((btn) =>
        btn.setButtonText(tr("设今天为起始日", "Start from today")).onClick(async () => {
          const today = getTodayKey();
          this.plugin.settings.trackingStartDate = today;
          await this.plugin.saveSettings();
          new Notice(tr(`已设置新统计周期起始日为：${today}`, `New tracking period starts on ${today}`));
          this.display();
        })
      )
      .addButton((btn) =>
        btn.setButtonText(tr("清除起始日限制", "Clear start date")).onClick(async () => {
          this.plugin.settings.trackingStartDate = null;
          await this.plugin.saveSettings();
          new Notice(tr("已清除统计周期起始日限制", "Tracking period start date cleared"));
          this.display();
        })
      );

    // 2. Folder Filtering & Presets
    containerEl.createEl("h3", { text: tr("目录范围与黑白名单", "Folders to include and exclude") });

    new Setting(containerEl)
      .setName(tr("知识库预设模式", "Vault preset"))
      .setDesc(tr("一键快速配置目标目录范围", "Set up the folders to track in one click"))
      .addDropdown((drop) =>
        drop
          .addOption("all", tr("全库统计 (默认)", "Whole vault (default)"))
          .addOption("anks-knowledge", tr("ANKS 专属预设 (聚焦 Core、Topics，排除 Sidecar/附件/模板)", "ANKS preset (Core and Topics; excludes Sidecar, attachments and templates)"))
          .addOption("custom", tr("自定义目录", "Custom folders"))
          .setValue(this.plugin.settings.activeFolderPreset || "all")
          .onChange(async (val) => {
            this.plugin.settings.activeFolderPreset = val;
            if (val === "anks-knowledge") {
              this.plugin.settings.includedFolders = ["Core", "Topics"];
              this.plugin.settings.excludedFolders = [".obsidian", ".trash", "Sidecar", "templates"];
            } else if (val === "all") {
              this.plugin.settings.includedFolders = [];
              this.plugin.settings.excludedFolders = [".obsidian", ".trash", "templates"];
            }
            await this.plugin.saveSettings();
            this.plugin.scheduleSnapshotSync(0);
            this.display();
          })
      );

    new Setting(containerEl)
      .setName(tr("排除目录 (Excluded Folders)", "Excluded folders"))
      .setDesc(tr("这些目录下的笔记变动不会计入统计（逗号分隔）", "Changes to notes in these folders are not counted (comma-separated)"))
      .addText((text) =>
        text
          .setValue((this.plugin.settings.excludedFolders || []).join(", "))
          .onChange(async (val) => {
            this.plugin.settings.excludedFolders = val.split(",").map((s) => s.trim()).filter(Boolean);
            this.plugin.settings.activeFolderPreset = "custom";
            await this.plugin.saveSettings();
            this.plugin.scheduleSnapshotSync();
          })
      );

    new Setting(containerEl)
      .setName(tr("仅包含目录 (Included Folders)", "Included folders"))
      .setDesc(tr("若指定，则仅这些目录下的笔记计入统计；留空表示全库（逗号分隔）", "If set, only notes in these folders are counted; leave empty for the whole vault (comma-separated)"))
      .addText((text) =>
        text
          .setValue((this.plugin.settings.includedFolders || []).join(", "))
          .onChange(async (val) => {
            this.plugin.settings.includedFolders = val.split(",").map((s) => s.trim()).filter(Boolean);
            this.plugin.settings.activeFolderPreset = "custom";
            await this.plugin.saveSettings();
            this.plugin.scheduleSnapshotSync();
          })
      );

    new Setting(containerEl)
      .setName(tr("排除后续系统产物", "Exclude future system output"))
      .setDesc(tr("排除 Sidecar/logs、Sidecar/backups、Sidecar/manifests 的后续文件采集；不改历史记录和目录黑白名单。", "Stop collecting future files from Sidecar/logs, Sidecar/backups and Sidecar/manifests; history and folder lists are unchanged."))
      .addToggle(toggle => toggle.setValue(!!this.plugin.settings.excludeSystemArtifacts).onChange(async value => {
        try { await this.plugin.setSystemArtifactsExcluded(value); }
        catch (error) { new Notice(tr(`设置未保存：${error.message}`, `Settings not saved: ${error.message}`));this.display(); }
      }));

    // 3. Basic Settings
    containerEl.createEl("h3", { text: tr("速记", "Memos") });
    const memoModeSetting = new Setting(containerEl)
      .setName(tr("速记存储方式", "Memo storage"))
      .setDesc(tr("自动：库里有 ANKS（Sidecar/bin/anks 与 Topics/）时进 ANKS，否则写日笔记。", "Auto: use ANKS when the vault has it (Sidecar/bin/anks and Topics/); otherwise write to daily notes."))
      .addDropdown((dd) => dd
        .addOption("auto", tr("自动", "Auto"))
        .addOption("general", tr("通用：追加到日笔记", "General: append to daily notes"))
        .addOption("anks", tr("ANKS：每天一个 raw 采集件", "ANKS: one raw capture file per day"))
        .setValue(this.plugin.settings.memoMode || "auto")
        .onChange(async (value) => {
          this.plugin.settings.memoMode = value;
          await this.plugin.savePluginData();
          this.plugin.refreshMemoViews();
          this.display();
        }));
    this.plugin.memoStore?.resolveMode().then((mode) => {
      memoModeSetting.descEl?.createDiv({ cls: "crisp-pulse-memo-muted", text: tr(`当前生效：${mode === "anks" ? "ANKS" : "日笔记"}`, `In effect: ${mode === "anks" ? "ANKS" : "daily notes"}`) });
    });

    const topics = this.plugin.memoStore?.anksTopics() || [];
    new Setting(containerEl)
      .setName("ANKS Topic")
      .setDesc(tr("ANKS 模式下写入 Topics/<topic>/raw/inbox/scratch/，字段取自库内采集合约 pulse-memo。", "In ANKS mode, memos go to Topics/<topic>/raw/inbox/scratch/, with fields from the vault's pulse-memo capture contract."))
      .addDropdown((dd) => {
        dd.addOption("", topics.length === 1 ? tr(`默认（${topics[0]}）`, `Default (${topics[0]})`) : topics.length ? tr("未选择（记录前必须选）", "Not selected (required before capturing)") : tr("（库里没有 Topic）", "(no Topics in this vault)"));
        for (const t of topics) dd.addOption(t, t);
        dd.setValue(this.plugin.settings.memoAnksTopic || "").onChange(async (value) => {
          this.plugin.settings.memoAnksTopic = value;
          await this.plugin.savePluginData();
          this.plugin.refreshMemoViews();
        });
      });

    new Setting(containerEl)
      .setName(tr("日笔记里的速记段落", "Memo section in daily notes"))
      .setDesc(tr("通用模式下速记追加到这个标题下面；没有这个标题时会在文末补上。留空则直接追加到文末。只认顶层标题，写在引用块或 Callout 里的不算。", "In general mode, memos are appended under this heading; if it is missing, it is added at the end. Leave empty to append to the end. Only top-level headings count, not ones inside quotes or callouts."))
      .addText((text) => text
        .setPlaceholder(MEMO_DEFAULT_HEADING)
        .setValue(this.plugin.settings.memoHeading ?? MEMO_DEFAULT_HEADING)
        .onChange(async (value) => {
          this.plugin.settings.memoHeading = value.trim();
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName(tr("日笔记文件夹与日期格式", "Daily note folder and date format"))
      .setDesc(tr("留空跟随 Obsidian 核心「日记」插件。格式用 moment 语法，例如 YYYY-MM-DD 或 YYYY/MM/YYYY-MM-DD。", "Leave empty to follow Obsidian's core Daily notes plugin. Use moment syntax for the format, e.g. YYYY-MM-DD or YYYY/MM/YYYY-MM-DD."))
      .addText((text) => text
        .setPlaceholder(tr("文件夹", "Folder"))
        .setValue(this.plugin.settings.memoDailyFolder || "")
        .onChange(async (value) => {
          this.plugin.settings.memoDailyFolder = value.trim();
          await this.plugin.savePluginData();
          this.plugin.refreshMemoViews();
        }))
      .addText((text) => text
        .setPlaceholder("YYYY-MM-DD")
        .setValue(this.plugin.settings.memoDailyFormat || "")
        .onChange(async (value) => {
          this.plugin.settings.memoDailyFormat = value.trim();
          await this.plugin.savePluginData();
          this.plugin.refreshMemoViews();
        }));

    new Setting(containerEl)
      .setName(tr("「转为笔记」的文件夹", "Folder for “Convert to note”"))
      .setDesc(tr("留空使用 Obsidian「新笔记的存放位置」。", "Leave empty to use Obsidian's “Default location for new notes”."))
      .addText((text) => text
        .setValue(this.plugin.settings.memoNoteFolder || "")
        .onChange(async (value) => {
          this.plugin.settings.memoNoteFolder = value.trim();
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName(tr("每日回顾条数", "Daily review count"))
      .setDesc(tr("「回顾」页每天挑出的旧速记数量，同一天内结果不变，可点「换一批」。", "How many older memos the Review tab picks each day. The set stays the same all day; click “Shuffle” for another."))
      .addDropdown((dd) => {
        for (const n of [4, 6, 8, 12, 16, 24]) dd.addOption(String(n), tr(`${n} 条`, String(n)));
        dd.setValue(String(this.plugin.settings.memoReviewCount || 6)).onChange(async (value) => {
          this.plugin.settings.memoReviewCount = Number(value);
          await this.plugin.savePluginData();
          this.plugin.refreshMemoViews();
        });
      });

    new Setting(containerEl)
      .setName(tr("回顾范围", "Review scope"))
      .setDesc(tr("只回顾这些标签（含子标签），空格分隔，留空为全部；时间范围限定回顾多久以内的速记。", "Only review these tags (including nested tags), separated by spaces; leave empty for all. The time range limits how far back memos are reviewed."))
      .addText((text) => text
        .setPlaceholder(tr("#阅读 #工作", "#reading #work"))
        .setValue(this.plugin.settings.memoReviewTags || "")
        .onChange(async (value) => {
          this.plugin.settings.memoReviewTags = value.trim();
          await this.plugin.savePluginData();
          this.plugin.refreshMemoViews();
        }))
      .addDropdown((dd) => {
        for (const [v, label] of [["0", tr("全部时间", "All time")], ["30", tr("近 30 天", "Last 30 days")], ["90", tr("近 90 天", "Last 90 days")], ["365", tr("近 1 年", "Last year")]]) dd.addOption(v, label);
        dd.setValue(String(this.plugin.settings.memoReviewWithinDays || 0)).onChange(async (value) => {
          this.plugin.settings.memoReviewWithinDays = Number(value);
          await this.plugin.savePluginData();
          this.plugin.refreshMemoViews();
        });
      });

    new Setting(containerEl)
      .setName(tr("每日回顾提醒", "Daily review reminder"))
      .setDesc(tr("到这个时间提醒一次（例如 21:30），留空不提醒。只在 Obsidian 开着时生效；允许系统通知时弹系统通知，否则在 Obsidian 内提示。", "Remind once at this time (e.g. 21:30); leave empty for no reminder. Only works while Obsidian is open; uses a system notification if allowed, otherwise an in-app notice."))
      .addText((text) => text
        .setPlaceholder("21:30")
        .setValue(this.plugin.settings.memoReviewTime || "")
        .onChange(async (value) => {
          const v = value.trim();
          if (v && !/^\d{1,2}:\d{2}$/.test(v)) return;
          this.plugin.settings.memoReviewTime = v;
          await this.plugin.savePluginData();
          const N = typeof window !== "undefined" ? window.Notification : null;
          if (v && N && N.permission === "default") N.requestPermission?.();
        }));

    const vaultName = this.app.vault?.getName?.() || tr("你的库", "your vault");
    new Setting(containerEl)
      .setName(tr("外部快捷入口（URL）", "External shortcut (URL)"))
      .setDesc(tr(`在 iOS 快捷指令、Raycast、Alfred、PopClip 里打开这个链接即可记一条：obsidian://crisp-pulse-memo?vault=${encodeURIComponent(vaultName)}&text=内容 。可选参数 tags=阅读,工作（自动补成 #标签）、open=1（记完打开速记）；不带 text 时只打开速记。`,
   `Open this link from iOS Shortcuts, Raycast, Alfred or PopClip to capture a memo: obsidian://crisp-pulse-memo?vault=${encodeURIComponent(vaultName)}&text=your-text . Optional parameters: tags=reading,work (turned into #tags) and open=1 (open memos afterwards). Without text it just opens memos.`))
      .addButton((button) => button.setButtonText(tr("复制示例链接", "Copy example link")).onClick(async () => {
        await navigator.clipboard.writeText(`obsidian://crisp-pulse-memo?vault=${encodeURIComponent(vaultName)}&text=${encodeURIComponent(tr("在这里写想法", "Write your idea here"))}`);
        new Notice(tr("已复制示例链接", "Example link copied"));
      }));

    containerEl.createEl("h3", { text: tr("常规偏好", "General") });

    new Setting(containerEl)
      .setName(tr("显示底部状态栏指示器", "Show status bar indicator"))
      .setDesc(tr("在 Obsidian 底部状态栏显示今日脉冲贡献分与连续天数", "Show today's score and streak in Obsidian's status bar"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showStatusBarItem).onChange(async (val) => {
          this.plugin.settings.showStatusBarItem = val;
          await this.plugin.savePluginData();
          if (val && !this.plugin.statusBarEl) {
            this.plugin.initStatusBar();
          } else if (!val && this.plugin.statusBarEl) {
            this.plugin.statusBarEl.remove();
            this.plugin.statusBarEl = null;
          }
        })
      );

    new Setting(containerEl)
      .setName(tr("看板顶部横幅", "Dashboard banner"))
      .setDesc(tr("在 Pulse 视图顶部显示横幅。默认是本地绘制的像素风天空（深色主题为夜景，浅色主题为白天），也可以换成下面的自定义图片。", "Show a banner at the top of Pulse View. By default it is a locally drawn pixel-art sky (night in dark themes, day in light themes); you can replace it with a custom image below."))
      .addToggle(toggle => toggle.setValue(!!this.plugin.settings.showHeaderBanner).onChange(async value => {
        this.plugin.settings.showHeaderBanner = value;
        await this.plugin.savePluginData();
        this.plugin.refreshViews();
      }));

    const bannerImage = new Setting(containerEl)
      .setName(tr("自定义横幅图片", "Custom banner image"))
      .setDesc(tr(`用库内的一张图片代替像素天空，留空则用像素天空。${PULSE_BANNER_IMAGE_HINT}`, `Use an image from your vault instead of the pixel sky; leave empty for the pixel sky. ${PULSE_BANNER_IMAGE_HINT}`));
    const bannerStatus = bannerImage.descEl.createDiv({ cls: "crisp-pulse-banner-status" });
    const showBannerStatus = () => {
      const path = this.plugin.settings.headerBannerImage;
      bannerStatus.removeClass("is-warning");
      if (!path) { bannerStatus.setText(""); return; }
      const file = this.plugin.getBannerImageFile();
      if (!file) { bannerStatus.addClass("is-warning");bannerStatus.setText(tr("找不到这张图片，或格式不支持（png / jpg / webp / gif / avif），暂时显示像素天空。", "Image not found or format not supported (png / jpg / webp / gif / avif); showing the pixel sky for now."));return; }
      const probe = new Image();
      probe.onload = () => {
        if (this.plugin.settings.headerBannerImage !== path) return;
        const issues = checkBannerImageSize(probe.naturalWidth, probe.naturalHeight);
        bannerStatus.toggleClass("is-warning", issues.length > 0);
        bannerStatus.setText(issues.length
          ? tr(`当前图片：${issues.join("；")}。`, `Current image: ${issues.join("; ")}.`)
          : tr(`当前图片 ${probe.naturalWidth}×${probe.naturalHeight}，尺寸合适。`, `Current image is ${probe.naturalWidth}×${probe.naturalHeight}, a good size.`));
      };
      probe.src = this.app.vault.getResourcePath(file);
    };
    const saveBannerImage = async value => {
      this.plugin.settings.headerBannerImage = value.trim();
      await this.plugin.savePluginData();
      this.plugin.refreshViews();
      showBannerStatus();
    };
    bannerImage.addText(text => {
      text.setPlaceholder(tr("例如 Assets/banner.jpg", "e.g. Assets/banner.jpg")).setValue(this.plugin.settings.headerBannerImage || "").onChange(saveBannerImage);
      createBannerImageSuggest(this.app, text.inputEl, saveBannerImage);
    });
    bannerImage.addExtraButton(button => button.setIcon("x").setTooltip(tr("清除，改用像素天空", "Clear and use the pixel sky")).onClick(async () => {
      await saveBannerImage("");
      this.display();
    }));
    showBannerStatus();

    new Setting(containerEl)
      .setName(tr("看板底部地平线", "Dashboard horizon"))
      .setDesc(tr("在 Pulse 视图底部显示和横幅呼应的像素地平线，山脊是最近一段时间每天的贡献分，最右边的小灯（白天是小旗）是今天。鼠标移上去可以看某天的分数。", "Show a pixel horizon at the bottom of Pulse View that matches the banner. The ridge is your daily score over recent days, and the lamp on the far right (a flag in daytime) is today. Hover to see a day's score."))
      .addToggle(toggle => toggle.setValue(this.plugin.settings.showFooterLandscape !== false).onChange(async value => {
        this.plugin.settings.showFooterLandscape = value;
        await this.plugin.savePluginData();
        this.plugin.refreshViews();
      }));

    new Setting(containerEl)
      .setName(tr("周起始日", "Week starts on"))
      .setDesc(tr("年度热力图周起始日", "First day of the week in the yearly heatmap"))
      .addDropdown((drop) =>
        drop
          .addOption("sunday", tr("周日 (Sunday)", "Sunday"))
          .addOption("monday", tr("周一 (Monday)", "Monday"))
          .setValue(this.plugin.settings.weekStartsOn)
          .onChange(async (val) => {
            this.plugin.settings.weekStartsOn = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(tr("默认看板指标", "Default dashboard metric"))
      .setDesc(tr("打开 Pulse View 时默认激活的指标", "The metric selected when Pulse View opens"))
      .addDropdown((drop) =>
        drop
          .addOption("contribution", tr("贡献得分 (Contribution)", "Contribution score"))
          .addOption("activity", tr("交互活跃 (Active Time)", "Active time"))
          .addOption("focus", tr("深度专注 (Focus Time)", "Focus time"))
          .addOption("words", tr("新增字数 (Words)", "Words added"))
          .addOption("notes", tr("新建笔记 (Notes)", "Notes created"))
          .addOption("tasks", tr("完成任务 (Tasks)", "Tasks completed"))
          .setValue(this.plugin.settings.defaultMetric)
          .onChange(async (val) => {
            this.plugin.settings.defaultMetric = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(tr("会话空闲超时 (分钟)", "Session idle timeout (minutes)"))
      .setDesc(tr("判定单次有效编辑会话结束的无操作时长", "How long without activity ends an edit session"))
      .addSlider((slider) =>
        slider
          .setLimits(1, 10, 1)
          .setValue(this.plugin.settings.sessionIdleTimeoutMinutes)
          .setDynamicTooltip()
          .onChange(async (val) => {
            this.plugin.settings.sessionIdleTimeoutMinutes = val;
            await this.plugin.saveSettings();
          })
      );

    // 4. Advanced Contribution Weights
    containerEl.createEl("h3", { text: tr("贡献得分权重配置", "Contribution score weights") });

    const createWeightSetting = (name, desc, prop) => {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((text) =>
          text.setValue(String(this.plugin.settings[prop])).onChange(async (val) => {
            const num = parseFloat(val);
            if (Number.isFinite(num) && num >= 0) {
              this.plugin.settings[prop] = num;
              await this.plugin.saveSettings();
            }
          })
        );
    };

    createWeightSetting(tr("新建笔记得分", "Points per new note"), tr("每新建一篇 Markdown 笔记的得分加成", "Points for each new Markdown note"), "weightNoteCreated");
    createWeightSetting(tr("有意义编辑会话得分", "Points per meaningful edit session"), tr("单次产生实质变化的编辑会话得分加成", "Points for each edit session that makes a real change"), "weightMeaningfulEdit");
    createWeightSetting(tr("完成任务得分", "Points per completed task"), tr("每勾选完成一个 Markdown 复选框任务的得分", "Points for each Markdown checkbox task you complete"), "weightTaskCompleted");
    createWeightSetting(tr("新建内链得分", "Points per new link"), tr("每新建一个 [[双向链接]] 的得分", "Points for each new [[internal link]]"), "weightLinkCreated");
    createWeightSetting(tr("深度专注每分钟得分", "Points per focus minute"), tr("Crisp Focus 专注计时每分钟折算的贡献分（默认 0.05 分/分钟）", "Points per minute of Crisp Focus time (default 0.05 per minute)"), "weightFocusMinute");

    new Setting(containerEl)
      .setName(tr("捕获/大段粘贴折算系数", "Capture / large paste multiplier"))
      .setDesc(tr("识别为网页剪藏或瞬间大段粘贴时的字数得分折扣", "Discount on word points for web clips or large instant pastes"))
      .addSlider((slider) =>
        slider
          .setLimits(0, 1, 0.1)
          .setValue(this.plugin.settings.captureMultiplier)
          .setDynamicTooltip()
          .onChange(async (val) => {
            this.plugin.settings.captureMultiplier = val;
            await this.plugin.saveSettings();
          })
      );

    // 5. Ecosystem & Knowledge Integration
    containerEl.createEl("h3", { text: tr("生态与知识库协同 (v1.3.0)", "Integrations") });

    const focusAvailable = this.plugin.focusAdapter?.isAvailable();
    const focusStatusDesc = focusAvailable
      ? tr("✅ 已成功检测到 Crisp Focus 插件，可自动监听专注完成并计分", "✅ Crisp Focus detected; completed focus sessions are scored automatically")
      : tr("未检测到 Crisp Focus 插件（可在插件管理中启用 Crisp Focus 体验专注联动）", "Crisp Focus not detected (enable it under Community plugins to link focus sessions)");

    new Setting(containerEl)
      .setName(tr("Crisp Focus 专注计时联动", "Crisp Focus integration"))
      .setDesc(tr(`当 Crisp Focus 专注会话完成时，自动将专注时长累加至今日知识脉冲。\n${focusStatusDesc}`, `When a Crisp Focus session completes, its focus time is added to today’s Pulse.\n${focusStatusDesc}`))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableCrispFocusSync).onChange(async (val) => {
          this.plugin.settings.enableCrispFocusSync = val;
          if (val) {
            this.plugin.focusAdapter?.attach();
          } else {
            this.plugin.focusAdapter?.detach();
          }
          await this.plugin.saveSettings();
          this.display();
        })
      );

    new Setting(containerEl)
      .setName(tr("番茄钟休息时提示记速记", "Prompt for a memo during pomodoro breaks"))
      .setDesc(tr(`Crisp Focus 1.5.0 起的番茄钟进入休息时，速记输入框下方提示「这一轮做了什么」，休息期间记下的速记自动带上 #${MEMO_POMODORO_TAG}。`, `When a Crisp Focus 1.5.0+ pomodoro goes on break, a prompt below the memo box asks what you did this round; memos captured during the break are tagged #${MEMO_POMODORO_TAG}.`))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.memoPomodoroPrompt !== false).onChange(async (val) => {
          this.plugin.settings.memoPomodoroPrompt = val;
          await this.plugin.saveSettings();
          this.plugin.refreshMemoComposerStatus();
        })
      );

    new Setting(containerEl)
      .setName(tr("专注时长计入贡献总分", "Count focus time toward the score"))
      .setDesc(tr("开启后，完成的专注分钟数按设定权重折算为贡献得分；番茄钟中途结束的只记录，不计分。", "When on, completed focus minutes are converted to points using the weight above; pomodoros ended early are logged but not scored."))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.includeFocusInContribution).onChange(async (val) => {
          this.plugin.settings.includeFocusInContribution = val;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        })
      );

    new Setting(containerEl)
      .setName(tr("周报默认归档目录", "Default report archive folder"))
      .setDesc(tr("在周复盘点击「归档至知识库」时生成 Markdown 文件的目标路径", "Where the Markdown file goes when you click “Archive to vault” in a review"))
      .addText((text) =>
        text
          .setValue(this.plugin.settings.reviewArchiveFolder || "Topics/self-media/outputs/reviews")
          .onChange(async (val) => {
            this.plugin.settings.reviewArchiveFolder = val.trim();
            await this.plugin.saveSettings();
          })
      );

    if (focusAvailable) {
      new Setting(containerEl)
        .setName(tr("测试开启 25 分钟专注", "Test a 25-minute focus session"))
        .setDesc(tr("立即委托 Crisp Focus 启动一个 25 分钟番茄钟会话", "Ask Crisp Focus to start a 25-minute pomodoro now"))
        .addButton((btn) =>
          btn.setButtonText(tr("立即开启专注", "Start focus now")).onClick(async () => {
            await this.plugin.focusAdapter.startFocusSession(25);
            new Notice(tr("已启动 Crisp Focus 25 分钟专注会话", "Started a 25-minute Crisp Focus session"));
          })
        );
    }

    // 6. Data Controls, Export & Backups
    containerEl.createEl("h3", { text: tr("数据维护与导出", "Data maintenance and export") });

    new Setting(containerEl)
      .setName(tr("导出统计数据", "Export stats"))
      .setDesc(tr("下载当前全部统计记录为 CSV 或 JSON 格式", "Download all current stats as CSV or JSON"))
      .addButton((btn) =>
        btn.setButtonText(tr("导出 CSV", "Export CSV")).onClick(() => {
          this.plugin.exportCSVFile();
        })
      )
      .addButton((btn) =>
        btn.setButtonText(tr("导出 JSON 备份", "Export JSON backup")).onClick(() => {
          this.plugin.exportJSONFile();
        })
      );

    new Setting(containerEl)
      .setName(tr("手动创建备份快照", "Create a backup snapshot"))
      .setDesc(tr("将当前脉冲数据完整复制到插件 backups/ 目录下", "Copy all current Pulse data into the plugin's backups/ folder"))
      .addButton((btn) =>
        btn.setButtonText(tr("立即备份", "Back up now")).onClick(async () => {
          btn.setDisabled(true);
          const res = await this.plugin.createBackup("manual");
          if (res.success) {
            new Notice(tr(`备份成功：${res.fileName}`, `Backup created: ${res.fileName}`));
          } else {
            new Notice(tr("备份失败：", "Backup failed: ") + (res.error?.message || res.error));
          }
          btn.setDisabled(false);
        })
      );

    new Setting(containerEl)
      .setName(tr("重新扫描并估算历史数据", "Rescan and estimate history"))
      .setDesc(tr("基于当前 Vault 符合目录规则的文件的创建和修改时间重新生成历史底图", "Rebuild the historical baseline from the creation and modification times of files that match your folder rules"))
      .addButton((btn) =>
        btn.setButtonText(tr("开始重构", "Rebuild")).onClick(async () => {
          btn.setDisabled(true);
          new Notice(tr("正在扫描 Vault 重构历史脉冲...", "Scanning the vault to rebuild history..."));
          await this.plugin.runHistoricalBackfill(true);
          new Notice(tr("历史数据估算完成！", "Historical data estimated."));
          btn.setDisabled(false);
          this.plugin.refreshViews();
        })
      );

    new Setting(containerEl)
      .setName(tr("重置全部脉冲数据", "Reset all Pulse data"))
      .setDesc(tr("清空所有已记录的脉冲数据（系统将在执行前自动创建备份快照）", "Clear all recorded Pulse data (a backup snapshot is created first)"))
      .addButton((btn) =>
        btn
          .setButtonText(tr("重置数据", "Reset data"))
          .setWarning()
          .onClick(() => {
            const modal = new Modal(this.app);
            modal.setTitle(tr("确认重置 Crisp Pulse 数据", "Confirm resetting Crisp Pulse data"));
            modal.contentEl.createEl("p", {
              text: tr("将清空全部统计记录。系统将在清空前自动创建备份至 backups/ 目录。输入 RESET 后才能确认；笔记文件不会被删除。", "All stats will be cleared. A backup is created in backups/ first. Type RESET to confirm; your notes are not deleted.")
            });
            let confirmation = "";
            new Setting(modal.contentEl).setName(tr("输入 RESET", "Type RESET")).addText((text) =>
              text.onChange((value) => {
                confirmation = value;
              })
            );
            new Setting(modal.contentEl)
              .addButton((button) => button.setButtonText(tr("取消", "Cancel")).onClick(() => modal.close()))
              .addButton((button) =>
                button
                  .setButtonText(tr("确认重置", "Confirm reset"))
                  .setWarning()
                  .onClick(async () => {
                    if (confirmation !== "RESET") {
                      new Notice(tr("请输入 RESET 确认。", "Type RESET to confirm."));
                      return;
                    }
                    button.setDisabled(true);

                    const backupRes = await this.plugin.createBackup("pre-reset");
                    if (!backupRes.success) {
                      new Notice(tr("自动备份失败，已取消重置以保护数据：", "Automatic backup failed, so the reset was cancelled to protect your data: ") + (backupRes.error?.message || backupRes.error));
                      button.setDisabled(false);
                      return;
                    }

                    await Promise.all([...(this.plugin.fileQueues?.values() || [])]);
                    this.plugin.activeSessions.clear();
                    this.plugin.lastInteractionTime = null;
                    this.plugin.store.daily = {};
                    this.plugin.settings.hasRunBackfill = true;

                    try {
                      await this.plugin.savePluginData({ throwOnError: true });
                      this.plugin.refreshViews();
                      modal.close();
                      new Notice(tr(`Crisp Pulse: 数据已重置（已备份至 backups/${backupRes.fileName}）`, `Crisp Pulse: data reset (backed up to backups/${backupRes.fileName})`));
                    } catch (saveErr) {
                      new Notice(tr("Crisp Pulse：数据保存失败，请检查文件权限。", "Crisp Pulse: failed to save data. Check file permissions."));
                      button.setDisabled(false);
                    }
                  })
              );
            modal.open();
          })
      );

    renderAboutCard(
      containerEl,
      "Crisp Pulse",
      tr("基于知识沉淀与有效编辑算法的知识脉冲热力图与工作复盘看板。", "A knowledge-work heatmap and review dashboard, based on what you write and meaningful edits.")
    );
  }
}

module.exports = CrispPulsePlugin;
module.exports.validateAndRepairStore = validateAndRepairStore;
module.exports.isPathIncluded = isPathIncluded;
module.exports.getScoreBreakdown = getScoreBreakdown;
module.exports.generateDailyCSV = generateDailyCSV;
module.exports.filterDatesByRange = filterDatesByRange;
module.exports.generateReviewData = generateReviewData;
module.exports.generateWeeklyMarkdown = generateWeeklyMarkdown;
module.exports.getLineSet = getLineSet;
module.exports.getCompletedTaskSet = getCompletedTaskSet;
module.exports.getIsoWeekString = getIsoWeekString;
module.exports.generateAnksWeeklyReviewFileContent = generateAnksWeeklyReviewFileContent;
module.exports.CrispFocusAdapter = CrispFocusAdapter;
module.exports.CRISP_PUBLIC_KEY_PEM = CRISP_PUBLIC_KEY_PEM;
module.exports.CRISP_LICENSE_PRODUCTS = CRISP_LICENSE_PRODUCTS;
module.exports.verifyLicenseCode = verifyLicenseCode;
module.exports.CrispPulseLicenseManager = CrispPulseLicenseManager;
module.exports.discoverVaultCrispLicense = discoverVaultCrispLicense;
module.exports.renderAboutCard = renderAboutCard;
module.exports.ICON_COMPUTER_SVG = ICON_COMPUTER_SVG;
module.exports.ICON_BLOCKS_WAVE_SVG = ICON_BLOCKS_WAVE_SVG;
module.exports.ICON_BLOCKS_WAVE_REGISTERED_SVG = ICON_BLOCKS_WAVE_REGISTERED_SVG;
module.exports.CRISP_PULSE_ICON_ID = CRISP_PULSE_ICON_ID;
module.exports.CrispPulseView = CrispPulseView;

module.exports.getReviewDrilldown = getReviewDrilldown;
module.exports.generateReviewReport = generateReviewReport;
module.exports.getReviewClues = getReviewClues;
module.exports.reviewWeekRange = reviewWeekRange;

module.exports.CrispPulseEvidenceModal = CrispPulseEvidenceModal;
module.exports.CrispPulseMemoView = CrispPulseMemoView;
module.exports.memoHelpers = {
  buildMemoBlock, buildSourceMemoText, parseMemoBlocks, extractMemoTags, insertMemoBlock, removeMemoBlock, appendMemoLink,
  memoStats, memoHeatLevel, memoHasImage, memoHasLink, memoHasAudio, memoTranscriptionState, memoHasTranscriptFor, memoAsrErrorInfo, memoConversionReview, memoWithTag, memoResolveRelative, writingKeyKind, memoTaskTitle, memoTempoLabel, bindHoldPress, memoAttachmentName, memoRecordingName, dailyNotePath, dailyDateFromPath, buildAnksMemoFile, pickRandomMemo, splitMemoLine,
  buildMemoQuestionNote, buildMemoNote, buildMemoNowLine, memoRelinkText, MemoStore,
  filterMemos, buildTagTree, renameTagInText, renameTagInContent, selectDailyReview, onThisDay, parseMemoUrlParams,
  tokenizeMemo, buildMemoIndex, relatedMemos, walkStep, explainShared,
};
