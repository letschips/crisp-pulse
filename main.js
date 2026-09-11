/* ==========================================================================
   Crisp Pulse — Knowledge Work Analytics Plugin for Obsidian
   Crafted for the Crisp Plugin Suite (v1.4.0)
   ========================================================================== */

const { Plugin, ItemView, Setting, PluginSettingTab, Notice, TFile, Modal } = require("obsidian");

const VIEW_TYPE_PULSE = "crisp-pulse-view";

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
    throw new Error("当前环境不支持 WebCrypto Ed25519");
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

function discoverVaultCrispLicense(app) {
  if (!app) return null;
  // 1. Check in-memory active plugins
  const crispPlugins = [
    "crisp-focus",
    "crisp-file-explorer",
    "crisp-base",
    "crisp-recall",
    "crisp-annotations",
    "crisp-reading-rail",
    "crisp-asr",
    "crisp-visual"
  ];
  for (const pid of crispPlugins) {
    const p = app.plugins?.plugins?.[pid];
    if (p?.settings?.licenseCode && typeof p.settings.licenseCode === "string" && p.settings.licenseCode.includes(".")) {
      return p.settings.licenseCode.trim();
    }
  }
  // 2. Check plugin data.json files on disk
  try {
    const pathMod = typeof require === "function" ? require("path") : null;
    const fsMod = typeof require === "function" ? require("fs") : null;
    if (pathMod && fsMod) {
      const basePath = app.vault?.adapter?.basePath || (app.vault?.adapter?.getBasePath ? app.vault.adapter.getBasePath() : "");
      const pluginsDir = basePath ? pathMod.join(basePath, ".obsidian", "plugins") : "";
      if (pluginsDir && fsMod.existsSync(pluginsDir)) {
        const dirs = fsMod.readdirSync(pluginsDir);
        for (const d of dirs) {
          if (d.startsWith("crisp-") && d !== "crisp-pulse") {
            const dataPath = pathMod.join(pluginsDir, d, "data.json");
            if (fsMod.existsSync(dataPath)) {
              const raw = fsMod.readFileSync(dataPath, "utf-8");
              const data = JSON.parse(raw);
              const code = data?.licenseCode || data?.settings?.licenseCode;
              if (code && typeof code === "string" && code.includes(".")) {
                return code.trim();
              }
            }
          }
        }
      }
    }
  } catch (e) {}
  return null;
}

async function verifyLicenseCode(licenseCode, targetPluginId = "crisp-pulse", app = null, windowObj = null) {
  const trimmed = (licenseCode || "").trim();
  if (!trimmed) return { valid: false, reason: "授权码为空" };
  const parts = trimmed.split(".");
  if (parts.length !== 2) return { valid: false, reason: "授权码格式无效" };
  const [payloadBase64, signatureBase64] = parts;
  try {
    const Decoder = typeof TextDecoder !== "undefined" ? TextDecoder : require("util").TextDecoder;
    const payloadJson = new Decoder().decode(base64UrlToUint8Array(payloadBase64));
    const payload = JSON.parse(payloadJson);
    if (!payload || typeof payload !== "object") {
      return { valid: false, reason: "授权数据无效" };
    }
    if (!CRISP_LICENSE_PRODUCTS.includes(payload.product)) {
      return { valid: false, reason: "授权码不属于 Crisp 系列插件" };
    }
    const features = Array.isArray(payload.features) ? payload.features : [];
    if (!features.includes("all") && !features.includes(targetPluginId)) {
      return { valid: false, reason: `该授权码未包含 ${targetPluginId} 权限` };
    }
    if (payload.expiresAt) {
      const expiresAt = new Date(payload.expiresAt).getTime();
      if (!Number.isFinite(expiresAt)) {
        return { valid: false, reason: "授权到期时间无效" };
      }
      if (expiresAt < Date.now()) {
        return { valid: false, reason: `授权已于 ${String(payload.expiresAt).split("T")[0]} 到期` };
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
    if (!isValid) return { valid: false, reason: "授权签名无效" };

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
            reason: cloudResult?.reason || "授权已被服务端拒绝或设备数已达上限"
          };
        }

        if (res.status === 200 && cloudResult && cloudResult.valid === true) {
          return { valid: true, payload, message: cloudResult.message, source: "online" };
        }

        if (res.status >= 400) {
          console.warn(`[Crisp Pulse] License server unavailable (status ${res.status}), offline fallback`);
        }
      } catch (netErr) {
        return { valid: true, payload, message: "离线验证成功", source: "offline" };
      }
    }

    return { valid: true, payload, message: "离线验证成功", source: "offline" };
  } catch (e) {
    return { valid: false, reason: `解析授权码失败: ${e.message}` };
  }
}

class CrispPulseLicenseManager {
  constructor(app, settings, options = {}) {
    this.app = app;
    this.settings = settings;
    this.verifier = options.verifier || verifyLicenseCode;
    this.now = options.now || (() => Date.now());
    this.windowObj = options.windowObj || (typeof window !== "undefined" ? window : null);
    this.status = { valid: false, reason: "尚未验证" };

    const initialCode = (this.settings && this.settings.licenseCode) || discoverVaultCrispLicense(this.app);
    if (initialCode && typeof initialCode === "string" && initialCode.includes(".")) {
      try {
        const payloadBase64 = initialCode.split(".")[0];
        const Decoder = typeof TextDecoder !== "undefined" ? TextDecoder : require("util").TextDecoder;
        const payloadJson = new Decoder().decode(base64UrlToUint8Array(payloadBase64));
        const payload = JSON.parse(payloadJson);
        if (CRISP_LICENSE_PRODUCTS.includes(payload.product)) {
          this.status = { valid: true, payload, message: "本地验证成功", source: "offline" };
          if (this.settings && !this.settings.licenseCode) {
            this.settings.licenseCode = initialCode;
          }
        }
      } catch (e) {}
    }
  }

  isEntitled() {
    return this.status.valid === true;
  }

  getStatus() {
    return this.status;
  }

  async verify(code = this.settings?.licenseCode) {
    let targetCode = (code || "").trim();
    if (!targetCode) {
      const discovered = discoverVaultCrispLicense(this.app);
      if (discovered) targetCode = discovered;
    }
    let result;
    try {
      result = await this.verifier(targetCode, "crisp-pulse", this.app, this.windowObj);
    } catch (error) {
      result = { valid: false, reason: `授权验证失败: ${error.message || error}` };
    }

    if (result.valid) {
      if (this.settings) {
        this.settings.licenseCode = targetCode;
        if (result.source === "online") {
          this.settings.licenseLastOnlineAt = this.now();
        }
      }
    }
    this.status = result;
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
  title.textContent = `关于 ${pluginName}`;

  const copy = document.createElement("p");
  copy.className = "crisp-pulse-about__description";
  copy.textContent = description;

  const byline = document.createElement("p");
  byline.className = "crisp-pulse-about__author";
  const label = document.createElement("span");
  label.textContent = "作者：";
  const author = document.createElement("a");
  author.className = "crisp-pulse-about__author-link";
  author.textContent = "小红书 letschips";
  author.href = "https://xhslink.cn/m/3MwtKu4822b";
  author.target = "_blank";
  author.rel = "noopener noreferrer";
  byline.append(label, author);

  card.append(title, copy, byline);
  container.append(card);
}

const ICON_COMPUTER_SVG = `<svg viewBox="0 0 281.25 281.25" class="crisp-pulse-breakdown-icon" aria-hidden="true"><g transform="translate(6402.3564,-4296.9987)"><path d="m -6251.0783,4337.2868 a 4.6879687,4.6879687 0 0 0 -4.6875,4.6875 v 128.7945 a 4.6879687,4.6879687 0 0 0 0.9814,2.8674 l 19.4129,25.0965 a 4.6879687,4.6879687 0 0 0 7.4157,0 l 19.4147,-25.0965 a 4.6879687,4.6879687 0 0 0 0.9778,-2.8674 v -128.7945 a 4.6879687,4.6879687 0 0 0 -4.6875,-4.6875 z m 4.6875,9.375 h 29.4525 v 122.5067 l -14.7235,19.0338 -14.729,-19.0357 z m -109.3323,64.0191 a 4.6879687,4.6879687 0 0 0 -4.6875,4.6875 v 117.9053 a 4.6879687,4.6879687 0 0 0 4.6875,4.6875 h 187.9834 a 4.6879687,4.6879687 0 0 0 4.6875,-4.6875 v -117.9053 a 4.6879687,4.6879687 0 0 0 -4.6875,-4.6875 h -21.308 a 4.6875,4.6875 0 0 0 -4.6875,4.6875 4.6875,4.6875 0 0 0 4.6875,4.6875 h 16.6205 v 108.5303 h -178.6084 v -108.5303 h 74.3884 a 4.6875,4.6875 0 0 0 4.6875,-4.6875 4.6875,4.6875 0 0 0 -4.6875,-4.6875 z m 25.0964,78.1293 a 4.6875,4.6875 0 0 0 -4.6875,4.6875 4.6875,4.6875 0 0 0 4.6875,4.6875 h 50.6653 a 4.6875,4.6875 0 0 0 4.6875,-4.6875 4.6875,4.6875 0 0 0 -4.6875,-4.6875 z" fill="currentColor"/></g></svg>`;

const ICON_BLOCKS_WAVE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="crisp-pulse-title-icon-svg" aria-hidden="true"><rect width="7.33" height="7.33" x="1" y="1" fill="currentColor"><animate id="SVGzjrPLenI" attributeName="x" begin="0;SVGXAURnSRI.end+0.2s" dur="0.6s" values="1;4;1"/><animate attributeName="y" begin="0;SVGXAURnSRI.end+0.2s" dur="0.6s" values="1;4;1"/><animate attributeName="width" begin="0;SVGXAURnSRI.end+0.2s" dur="0.6s" values="7.33;1.33;7.33"/><animate attributeName="height" begin="0;SVGXAURnSRI.end+0.2s" dur="0.6s" values="7.33;1.33;7.33"/></rect><rect width="7.33" height="7.33" x="8.33" y="1" fill="currentColor"><animate attributeName="x" begin="SVGzjrPLenI.begin+0.1s" dur="0.6s" values="8.33;11.33;8.33"/><animate attributeName="y" begin="SVGzjrPLenI.begin+0.1s" dur="0.6s" values="1;4;1"/><animate attributeName="width" begin="SVGzjrPLenI.begin+0.1s" dur="0.6s" values="7.33;1.33;7.33"/><animate attributeName="height" begin="SVGzjrPLenI.begin+0.1s" dur="0.6s" values="7.33;1.33;7.33"/></rect><rect width="7.33" height="7.33" x="1" y="8.33" fill="currentColor"><animate attributeName="x" begin="SVGzjrPLenI.begin+0.1s" dur="0.6s" values="1;4;1"/><animate attributeName="y" begin="SVGzjrPLenI.begin+0.1s" dur="0.6s" values="8.33;11.33;8.33"/><animate attributeName="width" begin="SVGzjrPLenI.begin+0.1s" dur="0.6s" values="7.33;1.33;7.33"/><animate attributeName="height" begin="SVGzjrPLenI.begin+0.1s" dur="0.6s" values="7.33;1.33;7.33"/></rect><rect width="7.33" height="7.33" x="15.66" y="1" fill="currentColor"><animate attributeName="x" begin="SVGzjrPLenI.begin+0.2s" dur="0.6s" values="15.66;18.66;15.66"/><animate attributeName="y" begin="SVGzjrPLenI.begin+0.2s" dur="0.6s" values="1;4;1"/><animate attributeName="width" begin="SVGzjrPLenI.begin+0.2s" dur="0.6s" values="7.33;1.33;7.33"/><animate attributeName="height" begin="SVGzjrPLenI.begin+0.2s" dur="0.6s" values="7.33;1.33;7.33"/></rect><rect width="7.33" height="7.33" x="8.33" y="8.33" fill="currentColor"><animate attributeName="x" begin="SVGzjrPLenI.begin+0.2s" dur="0.6s" values="8.33;11.33;8.33"/><animate attributeName="y" begin="SVGzjrPLenI.begin+0.2s" dur="0.6s" values="8.33;11.33;8.33"/><animate attributeName="width" begin="SVGzjrPLenI.begin+0.2s" dur="0.6s" values="7.33;1.33;7.33"/><animate attributeName="height" begin="SVGzjrPLenI.begin+0.2s" dur="0.6s" values="7.33;1.33;7.33"/></rect><rect width="7.33" height="7.33" x="1" y="15.66" fill="currentColor"><animate attributeName="x" begin="SVGzjrPLenI.begin+0.2s" dur="0.6s" values="1;4;1"/><animate attributeName="y" begin="SVGzjrPLenI.begin+0.2s" dur="0.6s" values="15.66;18.66;15.66"/><animate attributeName="width" begin="SVGzjrPLenI.begin+0.2s" dur="0.6s" values="7.33;1.33;7.33"/><animate attributeName="height" begin="SVGzjrPLenI.begin+0.2s" dur="0.6s" values="7.33;1.33;7.33"/></rect><rect width="7.33" height="7.33" x="15.66" y="8.33" fill="currentColor"><animate attributeName="x" begin="SVGzjrPLenI.begin+0.3s" dur="0.6s" values="15.66;18.66;15.66"/><animate attributeName="y" begin="SVGzjrPLenI.begin+0.3s" dur="0.6s" values="8.33;11.33;8.33"/><animate attributeName="width" begin="SVGzjrPLenI.begin+0.3s" dur="0.6s" values="7.33;1.33;7.33"/><animate attributeName="height" begin="SVGzjrPLenI.begin+0.3s" dur="0.6s" values="7.33;1.33;7.33"/></rect><rect width="7.33" height="7.33" x="8.33" y="15.66" fill="currentColor"><animate attributeName="x" begin="SVGzjrPLenI.begin+0.3s" dur="0.6s" values="8.33;11.33;8.33"/><animate attributeName="y" begin="SVGzjrPLenI.begin+0.3s" dur="0.6s" values="15.66;18.66;15.66"/><animate attributeName="width" begin="SVGzjrPLenI.begin+0.3s" dur="0.6s" values="7.33;1.33;7.33"/><animate attributeName="height" begin="SVGzjrPLenI.begin+0.3s" dur="0.6s" values="7.33;1.33;7.33"/></rect><rect width="7.33" height="7.33" x="15.66" y="15.66" fill="currentColor"><animate id="SVGXAURnSRI" attributeName="x" begin="SVGzjrPLenI.begin+0.4s" dur="0.6s" values="15.66;18.66;15.66"/><animate attributeName="y" begin="SVGzjrPLenI.begin+0.4s" dur="0.6s" values="15.66;18.66;15.66"/><animate attributeName="width" begin="SVGzjrPLenI.begin+0.4s" dur="0.6s" values="7.33;1.33;7.33"/><animate attributeName="height" begin="SVGzjrPLenI.begin+0.4s" dur="0.6s" values="7.33;1.33;7.33"/></rect></svg>`;

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

  // --- 1.1 Credible Analytics Settings ---
  trackingStartDate: null, // "YYYY-MM-DD" or null
  dataQualityScope: "reliable", // "reliable" | "all" | "recorded_only"
  includedFolders: [], // string[]: empty means all
  excludedFolders: [".obsidian", ".trash", "templates"], // string[]
  activeFolderPreset: "all", // "all" | "anks-knowledge" | "custom"

  // --- 1.2.0 Work Review Settings ---
  defaultDateRange: "year", // "year" | "90d" | "30d" | "7d" | "ytd"

  // --- 1.3.0 Ecosystem Integration Settings ---
  enableCrispFocusSync: true,
  reviewArchiveFolder: "Topics/self-media/outputs/reviews",

  // --- 1.4.0 Software License ---
  licenseCode: "",
  licenseLastOnlineAt: 0
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
  return minutes.toLocaleString("zh-CN", { maximumFractionDigits: 1 });
}

function formatDateDisplay(dateStr) {
  if (!dateStr) return "";
  const parts = dateStr.split("-");
  if (parts.length !== 3) return dateStr;
  return `${parts[0]}年${parseInt(parts[1], 10)}月${parseInt(parts[2], 10)}日`;
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
      rewrittenWords: 0 // 1.2 additions
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
  const matchedDates = sortedDates.filter(d => (!startDateStr || d >= startDateStr) && (!endDateStr || d <= endDateStr));

  let totalScore = 0;
  let notesCreated = 0;
  let wordsAdded = 0;
  let rewrittenWords = 0;
  let tasksCompleted = 0;
  let totalActiveMins = 0;
  let totalFocusMins = 0;

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
      // Extract top level dir
      const parts = fp.split("/");
      const dir = parts.length > 1 ? parts[0] : "(根目录)";
      if (!dirCounts.has(dir)) dirCounts.set(dir, { count: 0, words: 0 });
      const dc = dirCounts.get(dir);
      dc.count += 1;
      dc.words += (finfo.wordsAdded || 0);

      if (!fileStats.has(fp)) fileStats.set(fp, { words: 0, created: false, tasks: 0 });
      const fs = fileStats.get(fp);
      fs.words += (finfo.wordsAdded || 0);
      if (finfo.created) fs.created = true;
      fs.tasks += (finfo.tasks || 0);
    }
  }

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
    topFiles.push({ path, words: s.words, created: s.created, tasks: s.tasks });
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
    topFiles: topFiles.slice(0, 5)
  };
}

// 1.2 Weekly Markdown Generator
function generateWeeklyMarkdown(reviewData, weekTitle = "知识工作周报 (Week Review)") {
  const { totalScore, notesCreated, wordsAdded, rewrittenWords, tasksCompleted, activeHours, focusHours, dirBreakdown, topFiles } = reviewData;

  const lines = [
    `# ${weekTitle}`,
    "",
    "## 📊 本周总览",
    `- **总贡献得分**: ${totalScore} 分`,
    `- **新建笔记**: ${notesCreated} 篇`,
    `- **沉淀文字量**: +${wordsAdded} 词${rewrittenWords > 0 ? ` (深度改写/润色: +${rewrittenWords} 词)` : ""}`,
    `- **完成任务**: ${tasksCompleted} 项`,
    `- **交互活跃时长**: ${activeHours} 小时`,
  ];

  if (focusHours && Number(focusHours) > 0) {
    lines.push(`- **深度专注时长**: ${focusHours} 小时`);
  }

  lines.push("");
  lines.push("## 🗂️ 核心目录分布");

  if (dirBreakdown.length === 0) {
    lines.push("- *本周无明确目录变动*");
  } else {
    for (const d of dirBreakdown) {
      lines.push(`- \`${d.dir}\`: ${d.percent}% (变动 ${d.count} 次 / +${d.words} 词)`);
    }
  }

  lines.push("");
  lines.push("## 📝 深度推进笔记 Top 5");
  if (topFiles.length === 0) {
    lines.push("- *无重点笔记记录*");
  } else {
    topFiles.forEach((f, i) => {
      const tags = [];
      if (f.created) tags.push("新建");
      if (f.words > 0) tags.push(`+${f.words}词`);
      if (f.tasks > 0) tags.push(`${f.tasks}任务`);
      lines.push(`${i + 1}. [[${f.path}]] (${tags.join(" · ") || "已编辑"})`);
    });
  }

  return lines.join("\n");
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
function generateAnksWeeklyReviewFileContent(reviewData, weekTitle = "知识工作周报", dateRangeStr = "") {
  const todayKey = getTodayKey();
  const isoWeek = getIsoWeekString(new Date());

  const coreItem = (reviewData.dirBreakdown || []).find(d => d.dir === "Core");
  const topicsItem = (reviewData.dirBreakdown || []).find(d => d.dir === "Topics");
  const corePct = coreItem ? coreItem.percent : 0;
  const topicsPct = topicsItem ? topicsItem.percent : 0;

  let anksInsight = "";
  if (topicsPct >= 60) {
    anksInsight = `> [!TIP] **ANKS 知识沉淀建议**\n> 本周精力主要集中在业务/前线实践（Topics 占比 ${topicsPct}%）。建议周复盘时回看是否有高频验证、具有跨项目复用价值的概念、方法或框架，及时提炼萃取至 \`Core/\` 目录。`;
  } else if (corePct >= 40) {
    anksInsight = `> [!NOTE] **ANKS 底层建设反馈**\n> 本周深度投入了底层核心体系建设（Core 占比 ${corePct}%），基础心智与方法论沉淀扎实。后续可结合业务课题在 Topics 中开展实证。`;
  } else {
    anksInsight = `> [!NOTE] **ANKS 均衡度反馈**\n> 本周底层体系（Core: ${corePct}%）与业务实践（Topics: ${topicsPct}%）节奏均衡，保持了良好的输入-沉淀-输出节奏。`;
  }

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
    "## 📊 脉冲总览 (Pulse Overview)",
    `- **总贡献得分**: ${reviewData.totalScore} 分`,
    `- **新建笔记**: ${reviewData.notesCreated} 篇`,
    `- **沉淀文字量**: +${reviewData.wordsAdded} 词${reviewData.rewrittenWords > 0 ? ` (深度改写/润色: +${reviewData.rewrittenWords} 词)` : ""}`,
    `- **完成关键任务**: ${reviewData.tasksCompleted} 项`,
    `- **交互活跃时长**: ${reviewData.activeHours} 小时`,
  ];

  if (reviewData.focusHours && Number(reviewData.focusHours) > 0) {
    lines.push(`- **深度专注时长**: ${reviewData.focusHours} 小时`);
  }

  lines.push("", "## 🗂️ 核心知识目录精力分布", anksInsight, "");

  if (!reviewData.dirBreakdown || reviewData.dirBreakdown.length === 0) {
    lines.push("- *本周无明确目录变动*");
  } else {
    for (const d of reviewData.dirBreakdown) {
      lines.push(`- \`${d.dir}\`: **${d.percent}%** (变动 ${d.count} 次 / 沉淀 +${d.words} 词)`);
    }
  }

  lines.push("");
  lines.push("## 📝 深度推进笔记 Top 5");
  if (!reviewData.topFiles || reviewData.topFiles.length === 0) {
    lines.push("- *无重点笔记记录*");
  } else {
    reviewData.topFiles.forEach((f, i) => {
      const tags = [];
      if (f.created) tags.push("新建");
      if (f.words > 0) tags.push(`+${f.words}词`);
      if (f.tasks > 0) tags.push(`${f.tasks}任务`);
      lines.push(`${i + 1}. [[${f.path}]] (${tags.join(" · ") || "已编辑"})`);
    });
  }

  lines.push("");
  lines.push("## 💡 复盘反思与下周计划");
  lines.push("- **本周最重要的进展**：");
  lines.push("- **遇到的阻塞或卡点**：");
  lines.push("- **下周优先推进的 1~3 个核心事项**：");
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
    const self = this;
    this.attachedPlugin = focusPlugin;
    this.originalComplete = focusPlugin.completeFocusSession;

    const originalComplete = this.originalComplete;
    this.completeWrapper = async function(...args) {
      const duration = focusPlugin.settings?.sessionDurationMinutes || 25;
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
      new Notice("未检测到 Crisp Focus 插件或该插件尚未加载。");
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
  if (!store || typeof store !== "object") store = {};
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

  if (!store.daily || typeof store.daily !== "object") store.daily = {};

  let repairedCount = 0;
  for (const [dKey, rec] of Object.entries(store.daily)) {
    if (!rec || typeof rec !== "object") {
      store.daily[dKey] = createEmptyDailyRecord(dKey, "recorded");
      repairedCount++;
      continue;
    }

    rec.date = dKey;
    if (!["recorded", "estimated", "mixed"].includes(rec.quality)) {
      rec.quality = "recorded";
      repairedCount++;
    }

    if (!rec.activity || typeof rec.activity !== "object") {
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
    }

    if (!rec.contribution || typeof rec.contribution !== "object") {
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

    if (!rec.files || typeof rec.files !== "object") {
      rec.files = {};
      repairedCount++;
    } else {
      for (const [fp, fileMeta] of Object.entries(rec.files)) {
        if (!fileMeta || typeof fileMeta !== "object") {
          rec.files[fp] = { wordsAdded: 0, created: false, tasks: 0, links: 0 };
          repairedCount++;
        } else {
          if (!Number.isFinite(fileMeta.wordsAdded)) fileMeta.wordsAdded = 0;
          if (typeof fileMeta.created !== "boolean") fileMeta.created = false;
          if (!Number.isFinite(fileMeta.tasks)) fileMeta.tasks = 0;
          if (!Number.isFinite(fileMeta.links)) fileMeta.links = 0;
        }
      }
    }

    if (!Number.isFinite(rec.intensity) || rec.intensity < 0) {
      rec.intensity = 0;
    }
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

    this.licenseManager = new CrispPulseLicenseManager(this.app, this.settings);
    void this.licenseManager.verify();

    if (this.settings.showStatusBarItem) {
      this.initStatusBar();
    }

    this.registerView(VIEW_TYPE_PULSE, (leaf) => new CrispPulseView(leaf, this));

    this.addRibbonIcon("activity", "打开 Crisp Pulse 年度知识看板", () => {
      this.activatePulseView();
    });

    this.addCommand({
      id: "open-crisp-pulse-view",
      name: "打开年度知识工作看板 (Pulse View)",
      callback: () => this.activatePulseView()
    });

    this.addCommand({
      id: "copy-pulse-weekly-markdown",
      name: "复制本周工作复盘 Markdown 周报",
      callback: () => {
        const today = new Date();
        const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6);
        const data = this.getReviewData(dateKey(start), dateKey(today), this.settings.dataQualityScope);
        const md = generateWeeklyMarkdown(data, `知识工作周报 (${dateKey(start)} ~ ${dateKey(today)})`);
        navigator.clipboard.writeText(md).then(() => {
          new Notice("已成功复制本周工作复盘周报至剪贴板！");
        });
      }
    });

    this.addCommand({
      id: "export-pulse-csv",
      name: "导出知识脉冲数据 (CSV)",
      callback: () => this.exportCSVFile()
    });

    this.addCommand({
      id: "export-pulse-json",
      name: "导出知识脉冲数据 (JSON 备份)",
      callback: () => this.exportJSONFile()
    });

    this.addCommand({
      id: "retry-save-pulse-data",
      name: "立即重试保存知识脉冲数据",
      callback: async () => {
        new Notice("Crisp Pulse：正在保存数据...");
        const res = await this.savePluginData({ throwOnError: false });
        if (res.success) {
          new Notice("Crisp Pulse：数据已成功保存！");
        } else {
          new Notice("Crisp Pulse：保存依然失败，请查看控制台日志。");
        }
      }
    });

    this.addCommand({
      id: "create-pulse-backup",
      name: "创建知识脉冲数据备份快照",
      callback: async () => {
        new Notice("Crisp Pulse：正在创建备份...");
        const res = await this.createBackup("manual");
        if (res.success) {
          new Notice(`Crisp Pulse：备份成功（${res.fileName}）`);
        } else {
          new Notice("Crisp Pulse：备份失败：" + (res.error?.message || res.error));
        }
      }
    });

    this.addCommand({
      id: "rebuild-estimated-history",
      name: "重新估算历史知识脉冲数据",
      callback: async () => {
        await this.runHistoricalBackfill(true);
        new Notice("Crisp Pulse: 历史数据重新估算完成");
        this.refreshViews();
      }
    });

    this.addCommand({
      id: "archive-weekly-review",
      name: "归档本周工作复盘至知识库 (ANKS Review)",
      callback: async () => {
        const today = new Date();
        const startWeek = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6);
        const reviewData = this.getReviewData(dateKey(startWeek), dateKey(today), this.settings.dataQualityScope);
        await this.archiveWeeklyReviewToVault(reviewData, dateKey(startWeek), dateKey(today));
      }
    });

    this.addCommand({
      id: "start-crisp-focus-session",
      name: "开启 25 分钟 Crisp Focus 专注",
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
    this.focusAdapter?.detach();
    this.flushAllSessions();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_PULSE);
  }

  async loadPluginData() {
    const raw = await this.loadData();
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
    this.store.settings = this.settings;
    this.saveStatus = "saving";
    this.dirty = false;
    const payload = JSON.parse(JSON.stringify(this.store));

    const currentSave = (this.saveQueue || Promise.resolve())
      .catch(() => {})
      .then(async () => {
        await this.saveData(payload);
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
          new Notice("Crisp Pulse：统计保存失败，将在下一次检查重试。");
          this.saveErrorShown = true;
        }
        if (throwOnError) {
          throw error;
        }
        return { success: false, error };
      });

    this.saveQueue = currentSave;
    const result = await currentSave;
    this.updateStatusBar();
    return result;
  }

  async saveSettings() {
    for (const record of Object.values(this.store.daily)) this.recomputeScore(record);
    await this.savePluginData({ throwOnError: true });
    this.refreshViews();
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
        throw new Error("备份存储不可用，已取消操作。");
      }

      console.log(`[Crisp Pulse] Backup created: ${filePath}`);
      return { success: true, path: filePath, fileName };
    } catch (err) {
      console.error("[Crisp Pulse] Backup creation failed:", err);
      return { success: false, error: err };
    }
  }

  exportCSVFile() {
    const csv = generateDailyCSV(this.store.daily || {});
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `crisp-pulse-export-${getTodayKey()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    new Notice("已导出 CSV 数据");
  }

  exportJSONFile() {
    const json = JSON.stringify(this.store, null, 2);
    const blob = new Blob([json], { type: "application/json;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `crisp-pulse-backup-${getTodayKey()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    new Notice("已导出 JSON 备份");
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
    this.statusBarEl.setAttr("aria-label", "Crisp Pulse 知识脉冲");
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

    let tooltip = `Crisp Pulse 今日知识脉冲\n今日贡献: ${score.toFixed(1)} 分\n连续活跃: ${streak} 天 (范围: ${this.settings.dataQualityScope})\n新建笔记: ${todayRecord.contribution.notesCreated} 篇\n新增字数: ${todayRecord.contribution.wordsAdded} 词`;
    if (isFocusing) {
      const remainingMs = this.focusAdapter.getFocusRemainingMs();
      const mins = Math.ceil(remainingMs / 60000);
      tooltip += `\n🎯 Crisp Focus 正在专注中 (剩余约 ${mins} 分钟)`;
    }
    tooltip += `\n点击打开年度知识看板`;
    if (this.saveStatus === "error") {
      tooltip += `\n\n⚠️ 警告：统计数据最近一次写盘失败，将在30秒后自动重试，或可在命令面板执行“立即重试保存知识脉冲数据”。`;
    }
    this.statusBarEl.setAttr("aria-label", tooltip);
  }

  // 1.3.0 Ecosystem: Handle Crisp Focus completed session
  async handleFocusSessionCompleted(minutes) {
    if (!this.settings.enableCrispFocusSync) return;
    const mins = Math.max(1, Math.round(Number(minutes) || 25));
    const today = this.getOrCreateTodayRecord();
    today.activity.focusMinutes = (today.activity.focusMinutes || 0) + mins;
    this.dirty = true;
    this.recomputeScore(today);
    await this.savePluginData();
    this.updateStatusBar();
    this.refreshViews();

    const bonus = this.settings.includeFocusInContribution
      ? `（+${(mins * (this.settings.weightFocusMinute ?? 0.05)).toFixed(1)} 贡献分）`
      : "";
    new Notice(`Crisp Focus: 专注 ${mins} 分钟已计入今日知识脉冲！${bonus}`);
  }

  // 1.3.0 ANKS Vault: Archive Weekly Review note
  async archiveWeeklyReviewToVault(reviewData, startKey, endKey) {
    const rawFolder = (this.settings.reviewArchiveFolder || "Topics/self-media/outputs/reviews").trim();
    if (/(?:^|\/)\.\.(?:\/|$)/.test(rawFolder) || rawFolder.startsWith("/") || rawFolder.includes("\\")) {
      return { success: false, reason: "invalid_path", error: new Error("Invalid archive path escaping vault") };
    }
    const targetFolder = rawFolder.replace(/^\/+|\/+$/g, "");
    const isoWeek = getIsoWeekString(new Date());
    const fileName = `${isoWeek}-知识工作周报.md`;
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

    const title = `${isoWeek} 知识工作周报 (${startKey} ~ ${endKey})`;
    const content = generateAnksWeeklyReviewFileContent(reviewData, title, `${startKey} ~ ${endKey}`);

    try {
      const fileExists = this.app?.vault?.adapter?.exists ? await this.app.vault.adapter.exists(fullPath) : false;
      let targetFile;
      if (fileExists) {
        new Notice(`周报已存在，保留原文：${fullPath}`);
        return { success: false, reason: "exists", path: fullPath };
      } else {
        targetFile = await this.app.vault.create(fullPath, content);
      }

      new Notice(`Crisp Pulse: 周报已成功归档至 ${fullPath}`);
      if (targetFile) {
        this.app.workspace.openLinkText(targetFile.path, "");
      }
      return { success: true, path: fullPath };
    } catch (err) {
      console.error("[Crisp Pulse] Archive weekly review failed:", err);
      new Notice("周报归档失败：" + (err?.message || err));
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

  refreshViews() {
    this.updateStatusBar();
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_PULSE);
    for (const leaf of leaves) {
      if (leaf.view instanceof CrispPulseView) {
        leaf.view.render();
      }
    }
  }

  async initializeSnapshots() {
    const files = this.app.vault.getMarkdownFiles();
    const concurrency = 16;
    let index = 0;
    const worker = async () => {
      while (index < files.length && !this.stopped) {
        const file = files[index++];
        if (!isPathIncluded(file.path, this.settings.includedFolders, this.settings.excludedFolders)) {
          continue;
        }
        try {
          const content = await this.app.vault.read(file);
          if (this.stopped) return;
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
        if (!isPathIncluded(file.path, this.settings.includedFolders, this.settings.excludedFolders)) {
          return;
        }

        return this.handleFileCreation(file);
      })
    );

    this.registerEvent(
      this.app.vault.on("modify", async (file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        if (!isPathIncluded(file.path, this.settings.includedFolders, this.settings.excludedFolders)) {
          return;
        }
        await this.handleFileModification(file);
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        this.fileSnapshots.delete(file.path);
        const session = this.activeSessions.get(file.path);
        if (session) {
          if (session.isMeaningful) {
            const targetDate = session.date || getTodayKey();
            const record = this.getOrCreateRecord(targetDate);
            record.contribution.meaningfulEdits += 1;
            record.activity.editingSessions += 1;
            this.recomputeScore(record);
            this.dirty = true;
          }
          this.activeSessions.delete(file.path);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        const isFolder = !file.extension;
        const migratePath = path => path === oldPath || (isFolder && path.startsWith(`${oldPath}/`))
          ? file.path + path.slice(oldPath.length) : path;

        for (const [key, snap] of Array.from(this.fileSnapshots.entries())) {
          const next = migratePath(key);
          if (next !== key) {
            this.fileSnapshots.delete(key);
            this.fileSnapshots.set(next, snap);
          }
        }
        for (const [key, sess] of Array.from(this.activeSessions.entries())) {
          const next = migratePath(key);
          if (next !== key) {
            this.activeSessions.delete(key);
            this.activeSessions.set(next, sess);
          }
        }
        for (const record of Object.values(this.store.daily)) {
          if (!record.files) continue;
          for (const key of Object.keys(record.files)) {
            const next = migratePath(key);
            if (next !== key) {
              record.files[next] = record.files[key];
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

      const prevDay = dateKey(new Date(previous));
      const currDay = dateKey(new Date(now));
      if (prevDay === currDay) {
        const mins = (now - previous) / 60000;
        const rec = this.getOrCreateRecord(currDay);
        rec.activity.activeMinutes += mins;
      } else {
        const splitTime = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), new Date(now).getDate()).getTime();
        const prevMins = Math.max(0, (splitTime - previous) / 60000);
        const currMins = Math.max(0, (now - splitTime) / 60000);
        const prevRec = this.getOrCreateRecord(prevDay);
        prevRec.activity.activeMinutes += prevMins;
        const currRec = this.getOrCreateRecord(currDay);
        currRec.activity.activeMinutes += currMins;
      }
      this.dirty = true;
    };

    this.registerDomEvent(window, "blur", () => { this.lastInteractionTime = null; });
    this.registerDomEvent(window, "keydown", recordActivity, { passive: true });
    this.registerDomEvent(window, "mousedown", recordActivity, { passive: true });
  }

  handleFileCreation(file) {
    return this.queueFileOperation(file, async () => {
      if (this.fileSnapshots.has(file.path)) return;
        const today = this.getOrCreateTodayRecord();
        today.contribution.notesCreated += 1;
        if (!today.files[file.path]) {
          today.files[file.path] = { wordsAdded: 0, created: true, tasks: 0, links: 0 };
        } else {
          today.files[file.path].created = true;
        }

        try {
          const content = await this.app.vault.read(file);
          if (this.stopped) return;
          const words = countWords(content);
          this.fileSnapshots.set(file.path, {
            words,
            tasks: countTasks(content),
            links: countLinks(content),
            lineSet: getLineSet(content),
            completedTaskSet: getCompletedTaskSet(content),
            lastTime: Date.now()
          });
          if (words > 0) {
            today.contribution.wordsAdded += words;
            today.files[file.path].wordsAdded = words;
            if (words >= 500) today.contribution.captureWords = (today.contribution.captureWords || 0) + words;
          }
        } catch (e) {
          console.error("[Crisp Pulse] Error reading created file:", e);
        }

        this.dirty = true;
        this.recomputeScore(today);
        await this.savePluginData();
        this.updateStatusBar();
    });
  }

  handleFileModification(file) {
    return this.queueFileOperation(file, () => this.processFileModification(file));
  }

  async queueFileOperation(file, operation) {
    if (this.stopped) return;
    if (!this.fileQueues) this.fileQueues = new Map();
    const queuedPath = file.path;
    const queue = (this.fileQueues.get(queuedPath) || Promise.resolve())
      .catch(() => {})
      .then(() => { if (!this.stopped) return operation(); });
    this.fileQueues.set(queuedPath, queue);
    try {
      await queue;
    } finally {
      if (this.fileQueues.get(queuedPath) === queue) this.fileQueues.delete(queuedPath);
    }
  }

  async processFileModification(file) {
    if (this.stopped) return;
    try {
      const content = await this.app.vault.read(file);
      if (this.stopped) return;
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
      const timeDeltaMs = now - snapshot.lastTime;

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

      const today = this.getOrCreateTodayRecord();
      if (!today.files[file.path]) {
        today.files[file.path] = { wordsAdded: 0, created: false, tasks: 0, links: 0 };
      }
      const fileRecord = today.files[file.path];

      if (wordsDelta >= 500 && timeDeltaMs < 2000) {
        today.contribution.captureWords = (today.contribution.captureWords || 0) + wordsDelta;
      }

      if (wordsDelta > 0) {
        today.contribution.wordsAdded += wordsDelta;
        fileRecord.wordsAdded += wordsDelta;
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
        if (session.isMeaningful) {
          const targetDate = session.date || getTodayKey();
          const targetRecord = this.getOrCreateRecord(targetDate);
          targetRecord.contribution.meaningfulEdits += 1;
          targetRecord.activity.editingSessions += 1;
          this.recomputeScore(targetRecord);
        }
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
          const targetDate = session.date || getTodayKey();
          const targetRecord = this.getOrCreateRecord(targetDate);
          targetRecord.contribution.meaningfulEdits += 1;
          targetRecord.activity.editingSessions += 1;
          this.recomputeScore(targetRecord);
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
    for (const [_, session] of this.activeSessions.entries()) {
      if (session.isMeaningful) {
        const targetDate = session.date || getTodayKey();
        const targetRecord = this.getOrCreateRecord(targetDate);
        targetRecord.contribution.meaningfulEdits += 1;
        targetRecord.activity.editingSessions += 1;
        this.recomputeScore(targetRecord);
      }
    }
    this.activeSessions.clear();
    await this.savePluginData();
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

    for (const dStr of filteredDates) {
      const rec = daily[dStr];
      if (!this.recordMatchesScope(rec, dStr, scope)) continue;

      const score = rec.contribution.score || 0;
      const edits = rec.contribution.meaningfulEdits || 0;

      totalScore += score;
      totalActiveMins += (rec.activity?.activeMinutes || 0);
      totalFocusMins += (rec.activity?.focusMinutes || 0);

      const canCountActive = scope !== "reliable" || rec.quality !== "estimated";
      if (canCountActive && (score > 0 || edits >= 1)) {
        activeDays += 1;
        activeDateSet.add(dStr);
      }
    }

    let currentStreak = 0;
    let longestStreak = 0;
    let tempStreak = 0;

    const now = new Date();
    let checkDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const checkKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    let curr = new Date(checkDate);
    if (!activeDateSet.has(checkKey(curr))) {
      curr.setDate(curr.getDate() - 1);
    }
    while (activeDateSet.has(checkKey(curr))) {
      currentStreak++;
      curr.setDate(curr.getDate() - 1);
    }

    if (filteredDates.length > 0) {
      let prevDate = null;
      for (const dStr of filteredDates) {
        if (!activeDateSet.has(dStr)) continue;
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
}

/* ==========================================================================
   Crisp Pulse View (ItemView)
   ========================================================================== */

// Analytics uses daily aggregates only; a missing/excluded day is never invented as zero.
function buildAnalyticsData(daily, dates, includeRecord) {
  const fields = { score: 'contribution', wordsAdded: 'contribution', wordsRemoved: 'contribution', rewrittenWords: 'contribution', activeMinutes: 'activity', focusMinutes: 'activity' };
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

class CrispPulseView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.selectedMetric = plugin.settings.defaultMetric || "contribution";
    this.selectedDate = getTodayKey();
    this.currentScope = plugin.settings.dataQualityScope || "reliable";
    this.currentDateRange = plugin.settings.defaultDateRange || "year";
    this.showBreakdown = true;
    this.analyticsDays = 7;
    this.activeViewTab = "dashboard"; // "dashboard" | "review"
  }

  getViewType() {
    return VIEW_TYPE_PULSE;
  }

  getDisplayText() {
    return "Crisp Pulse 知识脉冲";
  }

  getIcon() {
    return "activity";
  }

  async onOpen() {
    this.render();
    const container = this.containerEl.children[1];
    const win = container.ownerDocument.defaultView;
    this.analyticsResizeObserver = new win.ResizeObserver(() => {
      if (this.activeViewTab !== "analytics" || Math.abs(container.clientWidth - (this.analyticsLastWidth || 0)) < 2) return;
      if (this.analyticsResizeFrame) win.cancelAnimationFrame(this.analyticsResizeFrame);
      this.analyticsResizeFrame = win.requestAnimationFrame(() => {
        this.analyticsResizeFrame = null;
        if (container.isConnected && this.activeViewTab === "analytics") this.render();
      });
    });
    this.analyticsResizeObserver.observe(container);
  }

  async onClose() {
    this.analyticsResizeObserver?.disconnect();
    if (this.analyticsResizeFrame) this.containerEl.ownerDocument.defaultView.cancelAnimationFrame(this.analyticsResizeFrame);
  }

  render() {
    const container = this.containerEl.children[1];
    const previousScroll = container?.scrollTop || 0;
    const previousHorizontal = container.querySelector(".crisp-pulse-heatmap-scroll")?.scrollLeft || 0;
    const active = container.ownerDocument.activeElement;
    const focusedDate = active?.dataset?.date;
    const chartFocus = active?.dataset?.analyticsDate ? { date: active.dataset.analyticsDate, chart: active.closest("svg")?.getAttribute("aria-label") } : null;
    const controlFocus = container.contains(active) && active.matches("button, select, [role=button]")
      ? { tag: active.tagName, label: active.getAttribute("aria-label"), text: active.textContent } : null;
    container.empty();
    container.classList.add("crisp-pulse-view");

    const wrapper = container.createDiv({ cls: "crisp-pulse-wrapper" });

    // 1. Header with View Tabs, Scope and DateRange Selectors
    this.renderHeader(wrapper);

    if (this.activeViewTab === "dashboard") {
      // 2. KPI Row
      this.renderKPIRow(wrapper);

      // 3. Metric Tabs
      this.renderMetricTabs(wrapper);

      // 4. Annual Heatmap Card
      this.renderHeatmapCard(wrapper);

      // 5. Day Detail Card with Score Breakdown
      this.renderDayDetailCard(wrapper);
    } else if (this.activeViewTab === "analytics") {
      this.renderAnalytics(wrapper);
    } else {
      // Retrospective View
      this.renderRetrospectivePanel(wrapper);
    }

    container.scrollTop = previousScroll;
    const heatmap = container.querySelector(".crisp-pulse-heatmap-scroll");
    if (heatmap) heatmap.scrollLeft = previousHorizontal;
    if (focusedDate) container.querySelector(`[data-date="${focusedDate}"]`)?.focus({ preventScroll: true });
    else if (chartFocus) {
      const chart = [...container.querySelectorAll("svg")].find(el => el.getAttribute("aria-label") === chartFocus.chart);
      chart?.querySelector(`[data-analytics-date="${chartFocus.date}"]`)?.focus({ preventScroll: true });
    } else if (controlFocus) {
      [...container.querySelectorAll("button, select, [role=button]")].find(el => el.tagName === controlFocus.tag && el.getAttribute("aria-label") === controlFocus.label && (controlFocus.label || el.textContent === controlFocus.text))?.focus({ preventScroll: true });
    }
  }

  renderAnalytics(parent) {
    this.analyticsLastWidth = this.containerEl.children[1].clientWidth;
    const section = parent.createDiv({ cls: 'crisp-pulse-analytics' });
    const heading = section.createDiv({ cls: 'crisp-pulse-analytics-heading' });
    const text = heading.createDiv();
    text.createEl('h2', { text: '数据分析' });
    text.createEl('p', { text: '把每天的记录连起来，看看写作与投入如何变化。' });
    const ranges = heading.createDiv({ cls: 'crisp-pulse-analytics-segments' });
    ranges.setAttr('aria-label', '分析时间范围');
    for (const days of [7, 30, 90]) {
      const button = ranges.createEl('button', { text: `${days} 天` });
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
    const scopeLabel = { reliable: '可靠记录', recorded_only: '仅实测记录', all: '全部历史' }[this.currentScope];
    section.createDiv({ cls: 'crisp-pulse-analytics-coverage', text: `${dates[0]} — ${dates.at(-1)} · ${scopeLabel} · 已纳入 ${data.recordedDays} / ${dates.length} 天。未记录或被筛选的日期留空，不视作零。` });
    const configs = [
      { title: '每日贡献', description: '查看记录下来的工作节奏；分数依照当前插件计分口径，不代表知识质量。', type: 'bar', unit: '分', total: 'score', totalLabel: '区间贡献', series: [{ key: 'score', label: '贡献得分', color: 'blue' }] },
      { title: '写作变化', description: '新增与删除来自保存前后的词数变化，改写为现有算法估算。三条曲线分别展示，不相加。', type: 'line', unit: '词', total: 'wordsAdded', totalLabel: '新增词数', series: [{ key: 'wordsAdded', label: '新增', color: 'blue' }, { key: 'wordsRemoved', label: '删除', color: 'orange' }, { key: 'rewrittenWords', label: '改写估算', color: 'green' }] },
      { title: '时间投入', description: '交互时长按操作间隔估算，专注时长来自已有 Focus 记录。两者可能重叠，不合并计算。', type: 'line', unit: '分钟', total: 'activeMinutes', totalLabel: '交互活跃', series: [{ key: 'activeMinutes', label: '交互活跃', color: 'blue' }, { key: 'focusMinutes', label: 'Focus 记录', color: 'orange' }] }
    ];
    for (const config of configs) this.renderAnalyticsChart(section, data, config);
  }

  renderAnalyticsChart(parent, data, config) {
    const section = parent.createDiv({ cls: 'crisp-pulse-analytics-section' });
    section.createEl('h3', { text: config.title });
    section.createEl('p', { cls: 'crisp-pulse-analytics-description', text: config.description });
    const card = section.createDiv({ cls: 'crisp-pulse-analytics-card' });
    const summary = card.createDiv({ cls: 'crisp-pulse-analytics-summary' });
    const number = value => Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 1 });
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
    if (!hasValues) card.createDiv({ cls: 'crisp-pulse-analytics-empty', text: '所选范围暂无可用记录。开始记录后，曲线会从真实数据出现的位置绘制。' });
    const scroll = card.createDiv({ cls: 'crisp-pulse-analytics-chart-scroll' });
    const doc = card.ownerDocument;
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const chartWidth = Math.max(280, Math.min(960, card.clientWidth - 48));
    svg.setAttribute('viewBox', `0 0 ${chartWidth} 270`);
    svg.setAttribute('class', 'crisp-pulse-analytics-chart');
    svg.setAttribute('role', 'group');
    svg.setAttribute('aria-label', `${config.title}，单位${config.unit}。左右方向键查看日期，Enter 打开日明细。`);
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
      draw('text', { x: left - 13, y: y(tick) + 4, 'text-anchor': 'end', class: 'pulse-chart-axis' }, Number(tick.toPrecision(6)).toLocaleString('zh-CN', { maximumFractionDigits: 6 }));
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
    const readout = card.createDiv({ cls: 'crisp-pulse-analytics-readout', text: '悬停或用方向键查看每日数值；点击可打开该日明细。' });
    readout.setAttr('aria-live', 'polite');
    const description = point => {
      if (point.status === 'missing') return `${point.date} · 未记录`;
      if (point.status === 'excluded') return `${point.date} · 已被当前数据范围排除`;
      const quality = point.legacy ? '旧版未校验' : point.quality === 'estimated' ? '历史估算' : point.quality === 'mixed' ? '含估算' : '实际记录';
      return `${point.date} · ${quality} · ` + config.series.map(s => `${s.label} ${point[s.key] === null ? '未记录' : number(point[s.key]) + ' ' + config.unit}`).join(' · ');
    };
    const targets = [];
    points.forEach((point, index) => {
      const target = draw('rect', { x: left + index * width, y: top, width, height: bottom - top, class: 'pulse-chart-target', role: 'button', tabindex: index === points.length - 1 ? 0 : -1, 'aria-label': description(point) + '，打开日明细', 'data-analytics-date': point.date });
      targets.push(target);
      const show = () => {
        marker.setAttribute('x1', x(index)); marker.setAttribute('x2', x(index)); marker.setAttribute('visibility', 'visible');
        readout.textContent = description(point);
      };
      target.addEventListener('pointerenter', show);
      target.addEventListener('focus', show);
      const open = () => {
        this.selectedDate = point.date;
        this.activeViewTab = 'dashboard';
        this.render();
        this.containerEl.querySelector('.crisp-pulse-detail-card')?.scrollIntoView({ block: 'start', behavior: 'auto' });
      };
      target.addEventListener('click', open);
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

  renderHeader(parent) {
    const header = parent.createDiv({ cls: "crisp-pulse-header" });

    const titleGroup = header.createDiv({ cls: "crisp-pulse-title-group" });
    const icon = titleGroup.createDiv({ cls: "crisp-pulse-title-icon" });
    icon.innerHTML = ICON_BLOCKS_WAVE_SVG;
    titleGroup.createEl("h2", { cls: "crisp-pulse-title", text: "Crisp Pulse 知识脉冲看板" });

    // View Switcher (Dashboard vs Retrospective)
    const viewSwitch = titleGroup.createDiv({ cls: "crisp-pulse-actions" });
    const dashBtn = viewSwitch.createEl("button", {
      cls: `crisp-pulse-tab-btn ${this.activeViewTab === "dashboard" ? "is-active" : ""}`,
      text: "看板视图"
    });
    dashBtn.addEventListener("click", () => {
      this.activeViewTab = "dashboard";
      this.containerEl.children[1].scrollTop = 0;
      this.render();
    });

    const reviewBtn = viewSwitch.createEl("button", {
      cls: `crisp-pulse-tab-btn ${this.activeViewTab === "review" ? "is-active" : ""}`,
      text: "工作周复盘"
    });
    reviewBtn.addEventListener("click", () => {
      this.activeViewTab = "review";
      this.containerEl.children[1].scrollTop = 0;
      this.render();
    });

    const analyticsButton = viewSwitch.createEl("button", {
      cls: `crisp-pulse-tab-btn ${this.activeViewTab === "analytics" ? "is-active" : ""}`,
      text: "数据分析"
    });
    analyticsButton.addEventListener("click", () => { this.activeViewTab = "analytics"; this.containerEl.children[1].scrollTop = 0; this.render(); });
    for (const [button, key] of [[dashBtn, "dashboard"], [reviewBtn, "review"], [analyticsButton, "analytics"]]) button.setAttr("aria-pressed", String(this.activeViewTab === key));

    const actions = header.createDiv({ cls: "crisp-pulse-actions" });

    // 1.2 Date Range Selector
    const rangeSelect = actions.createEl("select", { cls: "crisp-pulse-scope-select" });
    rangeSelect.createEl("option", { text: "时间: 近 53 周", value: "year" });
    rangeSelect.createEl("option", { text: "时间: 最近 90 天", value: "90d" });
    rangeSelect.createEl("option", { text: "时间: 最近 30 天", value: "30d" });
    rangeSelect.createEl("option", { text: "时间: 本周 (7天)", value: "7d" });
    rangeSelect.createEl("option", { text: "时间: 本年 (YTD)", value: "ytd" });
    rangeSelect.hidden = this.activeViewTab === "analytics";
    rangeSelect.value = this.currentDateRange;
    rangeSelect.addEventListener("change", () => {
      this.currentDateRange = rangeSelect.value;
      this.render();
    });

    // Scope Selector Dropdown
    const scopeSelect = actions.createEl("select", { cls: "crisp-pulse-scope-select" });
    scopeSelect.createEl("option", { text: "范围: 可靠记录", value: "reliable" });
    scopeSelect.createEl("option", { text: "范围: 仅实测记录", value: "recorded_only" });
    scopeSelect.createEl("option", { text: "范围: 全部历史", value: "all" });
    scopeSelect.value = this.currentScope;
    scopeSelect.addEventListener("change", () => {
      this.currentScope = scopeSelect.value;
      this.render();
    });

    // Export Button
    const exportBtn = actions.createEl("button", {
      cls: "crisp-pulse-tab-btn",
      text: "导出 CSV"
    });
    exportBtn.addEventListener("click", () => {
      this.plugin.exportCSVFile();
    });

    // Refresh Button
    const refreshBtn = actions.createEl("button", {
      cls: "crisp-pulse-tab-btn",
      text: "刷新"
    });
    refreshBtn.addEventListener("click", () => {
      this.plugin.refreshViews();
      new Notice("Crisp Pulse: 数据已刷新");
    });
  }

  renderKPIRow(parent) {
    const stats = this.plugin.calcStats(this.currentScope, this.currentDateRange);
    const kpiRow = parent.createDiv({ cls: "crisp-pulse-kpi-row" });

    const cards = [
      { label: "累计贡献分", val: stats.totalScore, sub: "Total Contribution" },
      { label: "活跃天数", val: `${stats.activeDays} 天`, sub: "Active Days" },
      { label: "当前连续天数", val: `${stats.currentStreak} 天`, sub: "Current Streak" },
      { label: "最长连续天数", val: `${stats.longestStreak} 天`, sub: "Longest Streak" },
      { label: "交互活跃时长", val: `${stats.totalActiveHours || "0.0"} 小时`, sub: "Interactive Time" }
    ];

    if (Number(stats.totalFocusHours) > 0) {
      cards.push({ label: "深度专注时长", val: `${stats.totalFocusHours} 小时`, sub: "Focus Time" });
    }

    for (const card of cards) {
      const cardEl = kpiRow.createDiv({ cls: "crisp-pulse-kpi-card" });
      cardEl.createDiv({ cls: "crisp-pulse-kpi-label", text: card.label });
      cardEl.createDiv({ cls: "crisp-pulse-kpi-val", text: String(card.val) });
      cardEl.createDiv({ cls: "crisp-pulse-kpi-sub", text: card.sub });
    }
  }

  renderMetricTabs(parent) {
    const tabsRow = parent.createDiv({ cls: "crisp-pulse-metric-tabs" });

    const metrics = [
      { id: "contribution", label: "贡献分 (Contribution)" },
      { id: "activity", label: "交互活跃 (Active Time)" },
      { id: "focus", label: "深度专注 (Focus Time)" },
      { id: "words", label: "新增字数 (Words)" },
      { id: "notes", label: "新建笔记 (Notes)" },
      { id: "tasks", label: "完成任务 (Tasks)" }
    ];

    for (const m of metrics) {
      const btn = tabsRow.createEl("button", {
        cls: `crisp-pulse-tab-btn ${this.selectedMetric === m.id ? "is-active" : ""}`,
        text: m.label
      });
      btn.addEventListener("click", () => {
        this.selectedMetric = m.id;
        this.render();
      });
    }
  }

  renderHeatmapCard(parent) {
    const card = parent.createDiv({ cls: "crisp-pulse-heatmap-card" });

    const header = card.createDiv({ cls: "crisp-pulse-heatmap-header" });
    header.createDiv({
      cls: "crisp-pulse-heatmap-title",
      text: `年度知识活跃脉冲 (${this.getMetricLabel(this.selectedMetric)})`
    });

    const stats = this.plugin.calcStats(this.currentScope, this.currentDateRange);
    if (stats.activeDays === 0 && this.currentScope === "reliable") {
      const notice = card.createDiv({ cls: "crisp-pulse-empty-notice" });
      notice.createSpan({ cls: "crisp-pulse-empty-notice-icon", text: "💡" });
      notice.createSpan({
        text: "当前筛选为「可靠记录」，已自动隔离旧版异常历史数据。您可以切换上方范围为「全部历史」查看过往脉冲，或在今日编辑笔记开始点亮全新打卡。"
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
          monthLabels.push({ weekIndex: w, monthName: `${m + 1}月` });
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
      weekdaysCol.createDiv({ text: "一" });
      weekdaysCol.createDiv({ text: "三" });
      weekdaysCol.createDiv({ text: "五" });
      weekdaysCol.createDiv({ text: "日" });
    } else {
      weekdaysCol.createDiv({ text: "日" });
      weekdaysCol.createDiv({ text: "二" });
      weekdaysCol.createDiv({ text: "四" });
      weekdaysCol.createDiv({ text: "六" });
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

        const tooltip = `${formatDateDisplay(day.dateKey)}${inRange ? "" : "（统计区间外，仅供参考）"}\n${this.getMetricLabel(this.selectedMetric)}: ${info.value} ${info.level > 0 ? `(${info.percentile}分位)` : ""}${isEstimated ? " [估算数据]" : ""}`;
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
    const rangeLabel = { year: "近 53 周", "90d": "最近 90 天", "30d": "最近 30 天", "7d": "最近 7 天", ytd: "本年" }[this.currentDateRange] || "近 53 周";
    footer.createDiv({ text: `完整 53 周 · 统计：${rangeLabel} · 区间外淡化 · 范围: ${this.currentScope === "reliable" ? "可靠记录" : this.currentScope === "recorded_only" ? "仅实测记录" : "全部历史"} · 强度基于个人近期分位数` });

    const legend = footer.createDiv({ cls: "crisp-pulse-legend" });
    legend.createSpan({ text: "少 " });
    for (let l = 0; l <= 5; l++) {
      const legCell = legend.createDiv({ cls: "crisp-pulse-legend-cell crisp-pulse-cell" });
      legCell.dataset.level = String(l);
    }
    legend.createSpan({ text: " 多" });
  }

  renderDayDetailCard(parent) {
    const card = parent.createDiv({ cls: "crisp-pulse-detail-card" });
    const rec = this.plugin.store.daily[this.selectedDate] || createEmptyDailyRecord(this.selectedDate, "none");
    const isRecorded = rec.quality === "recorded";
    const isEstimated = rec.quality === "estimated";

    const { map } = this.plugin.calculateIntensities(this.selectedMetric, this.currentScope);
    const info = map.get(this.selectedDate) || { level: 0, value: 0, percentile: 0 };

    const header = card.createDiv({ cls: "crisp-pulse-detail-header" });
    header.createDiv({ cls: "crisp-pulse-detail-date", text: `${formatDateDisplay(this.selectedDate)} 明细` });

    const badges = header.createDiv({ cls: "crisp-pulse-detail-badges" });
    if (isRecorded) {
      badges.createDiv({ cls: "crisp-pulse-badge crisp-pulse-badge-recorded", text: "真实记录 (Recorded)" });
    } else if (isEstimated) {
      badges.createDiv({ cls: "crisp-pulse-badge crisp-pulse-badge-estimated", text: "历史估算 (Estimated)" });
    }
    if (rec.legacyUnverified) {
      badges.createDiv({ cls: "crisp-pulse-badge", text: "旧版未校验" });
    }
    if (info.level > 0) {
      badges.createDiv({
        cls: "crisp-pulse-badge crisp-pulse-badge-intensity",
        text: `强度: 第 ${info.percentile}% 分位 (Level ${info.level})`
      });
    }

    const statsGrid = card.createDiv({ cls: "crisp-pulse-stats-grid" });

    const breakdown = getScoreBreakdown(rec, this.plugin.settings);

    const scoreBox = statsGrid.createDiv({ cls: "crisp-pulse-stat-box crisp-pulse-score-clickable" });
    scoreBox.setAttr("role", "button");
    scoreBox.tabIndex = 0;
    scoreBox.setAttr("aria-label", "贡献得分，展开或收起计分明细");
    scoreBox.setAttr("aria-expanded", String(this.showBreakdown));
    scoreBox.createDiv({ cls: "crisp-pulse-stat-label", text: "贡献得分" });
    scoreBox.createDiv({ cls: "crisp-pulse-stat-value", text: (rec.contribution.score || 0).toFixed(1) });
    const toggleBreakdown = () => {
      this.showBreakdown = !this.showBreakdown;
      this.render();
      this.containerEl.querySelector(".crisp-pulse-score-clickable")?.focus({ preventScroll: true });
    };
    scoreBox.addEventListener("click", toggleBreakdown);
    scoreBox.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggleBreakdown(); }
    });

    const statItems = [
      { label: "新增词数", val: `+${rec.contribution.wordsAdded || 0}` },
      { label: "深度改写/润色", val: `+${rec.contribution.rewrittenWords || 0} 词` },
      { label: "新建笔记", val: `${rec.contribution.notesCreated || 0} 篇` },
      { label: "有效编辑会话", val: `${rec.contribution.meaningfulEdits || 0} 次` },
      { label: "完成任务", val: `${rec.contribution.tasksCompleted || 0} 项` },
      { label: "新建内链", val: `${rec.contribution.linksCreated || 0} 条` },
      { label: "交互活跃时长", val: `${formatPulseMinutes(rec.activity.activeMinutes)} 分钟` }
    ];

    if (this.plugin.settings.includeFocusInContribution || (rec.activity?.focusMinutes > 0)) {
      statItems.push({ label: "深度专注时长", val: `${formatPulseMinutes(rec.activity?.focusMinutes)} 分钟` });
    }

    for (const item of statItems) {
      const box = statsGrid.createDiv({ cls: "crisp-pulse-stat-box" });
      box.createDiv({ cls: "crisp-pulse-stat-label", text: item.label });
      box.createDiv({ cls: "crisp-pulse-stat-value", text: item.val });
    }

    // Score Breakdown Drawer
    if (this.showBreakdown) {
      const bCard = card.createDiv({ cls: "crisp-pulse-breakdown-card" });
      const bTitle = bCard.createDiv({ cls: "crisp-pulse-breakdown-title" });
      const bTitleLeft = bTitle.createSpan({ cls: "crisp-pulse-breakdown-title-left" });
      const bIcon = bTitleLeft.createSpan({ cls: "crisp-pulse-breakdown-icon-wrap" });
      bIcon.innerHTML = ICON_COMPUTER_SVG;
      bTitleLeft.createSpan({ text: "贡献得分构成拆解 (Score Breakdown)" });
      bTitle.createSpan({ text: "分项相加严格等于总分", cls: "crisp-pulse-kpi-sub" });

      const list = bCard.createDiv({ cls: "crisp-pulse-breakdown-list" });

      const rows = [
        { label: "新建笔记", formula: `${rec.contribution.notesCreated || 0} 篇 × ${this.plugin.settings.weightNoteCreated}分`, val: `+${breakdown.notesCreatedScore.toFixed(1)}` },
        { label: "有效编辑会话", formula: `${rec.contribution.meaningfulEdits || 0} 次 × ${this.plugin.settings.weightMeaningfulEdit}分`, val: `+${breakdown.meaningfulEditsScore.toFixed(1)}` },
        { label: "完成任务", formula: `${rec.contribution.tasksCompleted || 0} 项 × ${this.plugin.settings.weightTaskCompleted}分`, val: `+${breakdown.tasksCompletedScore.toFixed(1)}` },
        { label: "新建内链", formula: `${rec.contribution.linksCreated || 0} 条 × ${this.plugin.settings.weightLinkCreated}分`, val: `+${breakdown.linksCreatedScore.toFixed(1)}` },
        { label: "字数贡献 (边际递减)", formula: `原创 ${Math.max(0, (rec.contribution.wordsAdded||0)-(rec.contribution.captureWords||0))} 词 + 改写 ${rec.contribution.rewrittenWords||0} 词`, val: `+${breakdown.wordsTotalScore.toFixed(1)}` }
      ];

      if (this.plugin.settings.includeFocusInContribution) {
        rows.push({
          label: "深度专注加分",
          formula: `${Math.round(rec.activity?.focusMinutes || 0)} 分钟（计分取整） × ${this.plugin.settings.weightFocusMinute}分`,
          val: `+${breakdown.focusScore.toFixed(1)}`
        });
      }

      rows.push({
        label: "总计贡献分 (Total Score)",
        formula: "公式求和",
        val: `${breakdown.totalScore.toFixed(1)} 分`
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
    fileWrap.createDiv({ cls: "crisp-pulse-file-list-title", text: "当日有贡献的笔记文件" });

    const fileList = fileWrap.createDiv({ cls: "crisp-pulse-file-list" });
    const fileKeys = Object.keys(rec.files || {});

    if (fileKeys.length === 0) {
      fileList.createDiv({ cls: "crisp-pulse-empty-files", text: "该日期无文件变更记录。" });
    } else {
      for (const fp of fileKeys) {
        const fInfo = rec.files[fp] || {};
        const item = fileList.createEl("button", { cls: "crisp-pulse-file-item" });
        item.type = "button";

        const nameSpan = item.createSpan({ cls: "crisp-pulse-file-name", text: fp });
        const metaSpan = item.createSpan({ cls: "crisp-pulse-file-meta" });

        const parts = [];
        if (fInfo.created) parts.push("新建");
        if (fInfo.wordsAdded > 0) parts.push(`+${fInfo.wordsAdded}词`);
        if (fInfo.rewrittenWords > 0) parts.push(`改写${fInfo.rewrittenWords}词`);
        if (fInfo.tasks > 0) parts.push(`${fInfo.tasks}任务`);
        if (fInfo.links > 0) parts.push(`${fInfo.links}内链`);
        metaSpan.textContent = parts.join(" · ") || "已编辑";

        item.addEventListener("click", () => {
          const file = this.app.vault.getAbstractFileByPath(fp);
          if (file instanceof TFile) {
            this.app.workspace.openLinkText(fp, "");
          } else {
            new Notice(`无法打开：文件 "${fp}" 已不存在。`);
          }
        });
      }
    }
  }

  // --- 1.2.0 Work Review Panel ---
  renderRetrospectivePanel(parent) {
    const today = new Date();
    const startWeek = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6);
    const reviewData = this.plugin.getReviewData(dateKey(startWeek), dateKey(today), this.currentScope);

    const card = parent.createDiv({ cls: "crisp-pulse-review-card" });

    const header = card.createDiv({ cls: "crisp-pulse-review-header" });
    header.createDiv({ cls: "crisp-pulse-review-title", text: `🗓️ 本周工作复盘 (${dateKey(startWeek)} ~ ${dateKey(today)})` });

    const actions = header.createDiv({ cls: "crisp-pulse-actions" });

    if (this.plugin.focusAdapter?.isAvailable()) {
      const focusBtn = actions.createEl("button", {
        cls: "crisp-pulse-tab-btn",
        text: "🎯 开启 25m 专注"
      });
      focusBtn.addEventListener("click", async () => {
        await this.plugin.focusAdapter.startFocusSession(25);
      });
    }

    const copyBtn = actions.createEl("button", {
      cls: "crisp-pulse-tab-btn",
      text: "📋 复制 Markdown 周报"
    });
    copyBtn.addEventListener("click", () => {
      const md = generateWeeklyMarkdown(reviewData, `知识工作周报 (${dateKey(startWeek)} ~ ${dateKey(today)})`);
      navigator.clipboard.writeText(md).then(() => {
        new Notice("已成功复制本周工作复盘周报！");
      });
    });

    const archiveBtn = actions.createEl("button", {
      cls: "crisp-pulse-tab-btn is-active",
      text: "📁 归档至知识库"
    });
    archiveBtn.addEventListener("click", async () => {
      archiveBtn.setDisabled(true);
      archiveBtn.setText("正在归档...");
      await this.plugin.archiveWeeklyReviewToVault(reviewData, dateKey(startWeek), dateKey(today));
      archiveBtn.setDisabled(false);
      archiveBtn.setText("📁 归档至知识库");
    });

    // Summary Matrix
    const statsGrid = card.createDiv({ cls: "crisp-pulse-stats-grid" });
    const items = [
      { label: "本周总得分", val: `${reviewData.totalScore} 分` },
      { label: "新建笔记", val: `${reviewData.notesCreated} 篇` },
      { label: "沉淀文字量", val: `+${reviewData.wordsAdded} 词` },
      { label: "深度改写润色", val: `+${reviewData.rewrittenWords} 词` },
      { label: "完成关键任务", val: `${reviewData.tasksCompleted} 项` },
      { label: "交互活跃时长", val: `${reviewData.activeHours} 小时` }
    ];

    if (reviewData.focusHours && Number(reviewData.focusHours) > 0) {
      items.push({ label: "深度专注时长", val: `${reviewData.focusHours} 小时` });
    }
    for (const it of items) {
      const box = statsGrid.createDiv({ cls: "crisp-pulse-stat-box" });
      box.createDiv({ cls: "crisp-pulse-stat-label", text: it.label });
      box.createDiv({ cls: "crisp-pulse-stat-value", text: it.val });
    }

    // Directory Distribution Bar
    const distWrap = card.createDiv({ cls: "crisp-pulse-distribution-bar-wrap" });
    distWrap.createDiv({ cls: "crisp-pulse-file-list-title", text: "🗂️ 核心知识目录精力分布" });

    if (reviewData.dirBreakdown.length === 0) {
      distWrap.createDiv({ cls: "crisp-pulse-empty-files", text: "本周尚无文件变动记录。" });
    } else {
      const bar = distWrap.createDiv({ cls: "crisp-pulse-distribution-bar" });
      const palette = ["#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#64748b"];

      reviewData.dirBreakdown.forEach((item, idx) => {
        const seg = bar.createDiv({ cls: "crisp-pulse-bar-segment" });
        seg.style.width = `${item.percent}%`;
        seg.style.backgroundColor = palette[idx % palette.length];
      });

      const legend = distWrap.createDiv({ cls: "crisp-pulse-distribution-legend" });
      reviewData.dirBreakdown.forEach((item, idx) => {
        const legItem = legend.createDiv({ cls: "crisp-pulse-dist-item" });
        const dot = legItem.createDiv({ cls: "crisp-pulse-dist-dot" });
        dot.style.backgroundColor = palette[idx % palette.length];
        legItem.createSpan({ text: `${item.dir}: ${item.percent}% (${item.count}次变动)` });
      });
    }

    // 1.3.0 ANKS Knowledge Stream Insight Card
    const coreItem = (reviewData.dirBreakdown || []).find(d => d.dir === "Core");
    const topicsItem = (reviewData.dirBreakdown || []).find(d => d.dir === "Topics");
    const corePct = coreItem ? coreItem.percent : 0;
    const topicsPct = topicsItem ? topicsItem.percent : 0;

    let insightText = "";
    if (topicsPct >= 60) {
      insightText = `💡 知识沉淀建议：本周精力高度集中于业务实践（Topics 占比 ${topicsPct}%）。复盘时可筛选已有初步验证的高频经验与方法，提炼沉淀至 Core 基础知识体系。`;
    } else if (corePct >= 40) {
      insightText = `💡 底层体系反馈：本周深度投入了底层核心体系建设（Core 占比 ${corePct}%），基础沉淀扎实。后续可结合业务课题在 Topics 中落地转化。`;
    } else {
      insightText = `💡 知识流向反馈：本周底层知识架构与业务实践节奏均衡（Core ${corePct}% / Topics ${topicsPct}%），知识流向畅通。`;
    }

    const insightCard = card.createDiv({ cls: "crisp-pulse-anks-insight" });
    insightCard.createDiv({ cls: "crisp-pulse-anks-insight-text", text: insightText });

    // Top 5 Deeply Focused Files
    const topWrap = card.createDiv({ cls: "crisp-pulse-file-list-wrap" });
    topWrap.createDiv({ cls: "crisp-pulse-file-list-title", text: "📝 本周深度推进笔记 Top 5" });

    const topList = topWrap.createDiv({ cls: "crisp-pulse-topfiles-list" });
    if (reviewData.topFiles.length === 0) {
      topList.createDiv({ cls: "crisp-pulse-empty-files", text: "本周尚无笔记改动。" });
    } else {
      reviewData.topFiles.forEach((file, index) => {
        const item = topList.createEl("button", { cls: "crisp-pulse-topfile-item" });
        item.setAttr("title", file.path);
        item.type = "button";

        const left = item.createSpan();
        left.createSpan({ text: `${index + 1}. `, cls: "crisp-pulse-kpi-sub" });
        left.createSpan({ text: file.path, cls: "crisp-pulse-file-name" });

        const right = item.createSpan({ cls: "crisp-pulse-file-meta" });
        const tags = [];
        if (file.created) tags.push("新建");
        if (file.words > 0) tags.push(`+${file.words}词`);
        if (file.tasks > 0) tags.push(`${file.tasks}任务`);
        right.textContent = tags.join(" · ") || "已编辑";

        item.addEventListener("click", () => {
          const f = this.app.vault.getAbstractFileByPath(file.path);
          if (f instanceof TFile) {
            this.app.workspace.openLinkText(file.path, "");
          } else {
            new Notice(`无法打开：文件 "${file.path}" 已不存在。`);
          }
        });
      });
    }
  }

  getMetricLabel(m) {
    switch (m) {
      case "activity":
        return "交互活跃分钟";
      case "focus":
        return "深度专注分钟";
      case "words":
        return "新增词数";
      case "notes":
        return "新建笔记";
      case "tasks":
        return "完成任务";
      case "contribution":
      default:
        return "贡献得分";
    }
  }
}

/* ==========================================================================
   Settings Tab (v1.3.0)
   ========================================================================== */

class CrispPulseSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Crisp Pulse 知识脉冲设置 (v1.4.0)" });

    // 0. Software License & Activation
    containerEl.createEl("h3", { text: "软件授权" });

    const statusSetting = new Setting(containerEl)
      .setName("当前激活状态")
      .setDesc("正在验证授权状态...");

    const updateStatusDesc = (status) => {
      if (status && status.valid && status.payload) {
        const owner = status.payload.userName || "Crisp 用户";
        const expiry = status.payload.expiresAt
          ? `，到期时间: ${String(status.payload.expiresAt).split("T")[0]}`
          : "";
        const verification = status.source === "offline" ? "离线验证" : "在线验证";
        statusSetting.setDesc(`✅ 已激活（授权给: ${owner}${expiry}，${verification}）`);
      } else if (this.plugin.settings.licenseCode) {
        statusSetting.setDesc(`❌ 未激活（${status?.reason || "授权码无效"}）`);
      } else {
        statusSetting.setDesc("❌ 未激活（输入 Crisp Suite 授权码激活全功能与生态联动）");
      }
    };

    updateStatusDesc(this.plugin.licenseManager?.getStatus());

    new Setting(containerEl)
      .setName("输入授权码")
      .setDesc("粘贴购买获取的 Crisp Suite 授权字符串进行离线/在线激活。")
      .addText((text) => {
        text
          .setPlaceholder("粘贴 Crisp 授权码...")
          .setValue(this.licenseDraft !== undefined ? this.licenseDraft : (this.plugin.settings.licenseCode || ""))
          .onChange((value) => {
            this.licenseDraft = value.trim();
          });
      })
      .addButton((button) =>
        button
          .setButtonText("激活 / 重新验证")
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText("正在验证...");
            const codeToVerify = this.licenseDraft !== undefined ? this.licenseDraft : (this.plugin.settings.licenseCode || "");
            const result = await this.plugin.activateLicense(codeToVerify);
            if (result.valid && result.payload) {
              new Notice(`🎉 Crisp Pulse 激活成功！欢迎使用，${result.payload.userName || "Crisp 用户"}`);
            } else {
              new Notice(`❌ 激活失败: ${result.reason || "未知错误"}`);
            }
            this.display();
          })
      );

    // 1. Scope & Cycles
    containerEl.createEl("h3", { text: "统计周期与范围" });

    new Setting(containerEl)
      .setName("默认数据质量范围")
      .setDesc("控制统计时包含的数据类型")
      .addDropdown((drop) =>
        drop
          .addOption("reliable", "可靠记录 (排除旧版异常数据与估算打卡)")
          .addOption("recorded_only", "仅实测记录 (彻底忽略历史估算)")
          .addOption("all", "全部历史 (包含历史估算与旧版数据)")
          .setValue(this.plugin.settings.dataQualityScope || "reliable")
          .onChange(async (val) => {
            this.plugin.settings.dataQualityScope = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("默认看板时间跨度")
      .setDesc("打开 Pulse View 时默认统计的日期范围")
      .addDropdown((drop) =>
        drop
          .addOption("year", "近 53 周 (全年)")
          .addOption("90d", "最近 90 天")
          .addOption("30d", "最近 30 天")
          .addOption("7d", "本周 (最近 7 天)")
          .addOption("ytd", "本自然年 (YTD)")
          .setValue(this.plugin.settings.defaultDateRange || "year")
          .onChange(async (val) => {
            this.plugin.settings.defaultDateRange = val;
            await this.plugin.saveSettings();
          })
      );

    const cycleDesc = this.plugin.settings.trackingStartDate
      ? `当前统计周期从 ${this.plugin.settings.trackingStartDate} 开始计算`
      : "尚未设定新周期（从历史首日开始计算）";

    new Setting(containerEl)
      .setName("开启新统计周期")
      .setDesc(`重设打卡与总分的计算起始日。历史数据将被完整保留，但早于此日期的异常数据不再影响连续打卡天数。\n${cycleDesc}`)
      .addButton((btn) =>
        btn.setButtonText("设今天为起始日").onClick(async () => {
          const today = getTodayKey();
          this.plugin.settings.trackingStartDate = today;
          await this.plugin.saveSettings();
          new Notice(`已设置新统计周期起始日为：${today}`);
          this.display();
        })
      )
      .addButton((btn) =>
        btn.setButtonText("清除起始日限制").onClick(async () => {
          this.plugin.settings.trackingStartDate = null;
          await this.plugin.saveSettings();
          new Notice("已清除统计周期起始日限制");
          this.display();
        })
      );

    // 2. Folder Filtering & Presets
    containerEl.createEl("h3", { text: "目录范围与黑白名单" });

    new Setting(containerEl)
      .setName("知识库预设模式")
      .setDesc("一键快速配置目标目录范围")
      .addDropdown((drop) =>
        drop
          .addOption("all", "全库统计 (默认)")
          .addOption("anks-knowledge", "ANKS 专属预设 (聚焦 Core、Topics，排除 Sidecar/附件/模板)")
          .addOption("custom", "自定义目录")
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
            this.display();
          })
      );

    new Setting(containerEl)
      .setName("排除目录 (Excluded Folders)")
      .setDesc("这些目录下的笔记变动不会计入统计（逗号分隔）")
      .addText((text) =>
        text
          .setValue((this.plugin.settings.excludedFolders || []).join(", "))
          .onChange(async (val) => {
            this.plugin.settings.excludedFolders = val.split(",").map((s) => s.trim()).filter(Boolean);
            this.plugin.settings.activeFolderPreset = "custom";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("仅包含目录 (Included Folders)")
      .setDesc("若指定，则仅这些目录下的笔记计入统计；留空表示全库（逗号分隔）")
      .addText((text) =>
        text
          .setValue((this.plugin.settings.includedFolders || []).join(", "))
          .onChange(async (val) => {
            this.plugin.settings.includedFolders = val.split(",").map((s) => s.trim()).filter(Boolean);
            this.plugin.settings.activeFolderPreset = "custom";
            await this.plugin.saveSettings();
          })
      );

    // 3. Basic Settings
    containerEl.createEl("h3", { text: "常规偏好" });

    new Setting(containerEl)
      .setName("显示底部状态栏指示器")
      .setDesc("在 Obsidian 底部状态栏显示今日脉冲贡献分与连续天数")
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
      .setName("周起始日")
      .setDesc("年度热力图周起始日")
      .addDropdown((drop) =>
        drop
          .addOption("sunday", "周日 (Sunday)")
          .addOption("monday", "周一 (Monday)")
          .setValue(this.plugin.settings.weekStartsOn)
          .onChange(async (val) => {
            this.plugin.settings.weekStartsOn = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("默认看板指标")
      .setDesc("打开 Pulse View 时默认激活的指标")
      .addDropdown((drop) =>
        drop
          .addOption("contribution", "贡献得分 (Contribution)")
          .addOption("activity", "交互活跃 (Active Time)")
          .addOption("focus", "深度专注 (Focus Time)")
          .addOption("words", "新增字数 (Words)")
          .addOption("notes", "新建笔记 (Notes)")
          .addOption("tasks", "完成任务 (Tasks)")
          .setValue(this.plugin.settings.defaultMetric)
          .onChange(async (val) => {
            this.plugin.settings.defaultMetric = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("会话空闲超时 (分钟)")
      .setDesc("判定单次有效编辑会话结束的无操作时长")
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
    containerEl.createEl("h3", { text: "贡献得分权重配置" });

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

    createWeightSetting("新建笔记得分", "每新建一篇 Markdown 笔记的得分加成", "weightNoteCreated");
    createWeightSetting("有意义编辑会话得分", "单次产生实质变化的编辑会话得分加成", "weightMeaningfulEdit");
    createWeightSetting("完成任务得分", "每勾选完成一个 Markdown 复选框任务的得分", "weightTaskCompleted");
    createWeightSetting("新建内链得分", "每新建一个 [[双向链接]] 的得分", "weightLinkCreated");
    createWeightSetting("深度专注每分钟得分", "Crisp Focus 专注计时每分钟折算的贡献分（默认 0.05 分/分钟）", "weightFocusMinute");

    new Setting(containerEl)
      .setName("捕获/大段粘贴折算系数")
      .setDesc("识别为网页剪藏或瞬间大段粘贴时的字数得分折扣")
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
    containerEl.createEl("h3", { text: "生态与知识库协同 (v1.3.0)" });

    const focusAvailable = this.plugin.focusAdapter?.isAvailable();
    const focusStatusDesc = focusAvailable
      ? "✅ 已成功检测到 Crisp Focus 插件，可自动监听专注完成并计分"
      : "未检测到 Crisp Focus 插件（可在插件管理中启用 Crisp Focus 体验专注联动）";

    new Setting(containerEl)
      .setName("Crisp Focus 专注计时联动")
      .setDesc(`当 Crisp Focus 专注会话完成时，自动将专注时长累加至今日知识脉冲。\n${focusStatusDesc}`)
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
      .setName("专注时长计入贡献总分")
      .setDesc("开启后，番茄钟专注分钟数将按设定权重折算为知识脉冲贡献得分")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.includeFocusInContribution).onChange(async (val) => {
          this.plugin.settings.includeFocusInContribution = val;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        })
      );

    new Setting(containerEl)
      .setName("周报默认归档目录")
      .setDesc("在周复盘点击「归档至知识库」时生成 Markdown 文件的目标路径")
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
        .setName("测试开启 25 分钟专注")
        .setDesc("立即委托 Crisp Focus 启动一个 25 分钟番茄钟会话")
        .addButton((btn) =>
          btn.setButtonText("立即开启专注").onClick(async () => {
            await this.plugin.focusAdapter.startFocusSession(25);
            new Notice("已启动 Crisp Focus 25 分钟专注会话");
          })
        );
    }

    // 6. Data Controls, Export & Backups
    containerEl.createEl("h3", { text: "数据维护与导出" });

    new Setting(containerEl)
      .setName("导出统计数据")
      .setDesc("下载当前全部统计记录为 CSV 或 JSON 格式")
      .addButton((btn) =>
        btn.setButtonText("导出 CSV").onClick(() => {
          this.plugin.exportCSVFile();
        })
      )
      .addButton((btn) =>
        btn.setButtonText("导出 JSON 备份").onClick(() => {
          this.plugin.exportJSONFile();
        })
      );

    new Setting(containerEl)
      .setName("手动创建备份快照")
      .setDesc("将当前脉冲数据完整复制到插件 backups/ 目录下")
      .addButton((btn) =>
        btn.setButtonText("立即备份").onClick(async () => {
          btn.setDisabled(true);
          const res = await this.plugin.createBackup("manual");
          if (res.success) {
            new Notice(`备份成功：${res.fileName}`);
          } else {
            new Notice("备份失败：" + (res.error?.message || res.error));
          }
          btn.setDisabled(false);
        })
      );

    new Setting(containerEl)
      .setName("重新扫描并估算历史数据")
      .setDesc("基于当前 Vault 符合目录规则的文件的创建和修改时间重新生成历史底图")
      .addButton((btn) =>
        btn.setButtonText("开始重构").onClick(async () => {
          btn.setDisabled(true);
          new Notice("正在扫描 Vault 重构历史脉冲...");
          await this.plugin.runHistoricalBackfill(true);
          new Notice("历史数据估算完成！");
          btn.setDisabled(false);
          this.plugin.refreshViews();
        })
      );

    new Setting(containerEl)
      .setName("重置全部脉冲数据")
      .setDesc("清空所有已记录的脉冲数据（系统将在执行前自动创建备份快照）")
      .addButton((btn) =>
        btn
          .setButtonText("重置数据")
          .setWarning()
          .onClick(() => {
            const modal = new Modal(this.app);
            modal.setTitle("确认重置 Crisp Pulse 数据");
            modal.contentEl.createEl("p", {
              text: "将清空全部统计记录。系统将在清空前自动创建备份至 backups/ 目录。输入 RESET 后才能确认；笔记文件不会被删除。"
            });
            let confirmation = "";
            new Setting(modal.contentEl).setName("输入 RESET").addText((text) =>
              text.onChange((value) => {
                confirmation = value;
              })
            );
            new Setting(modal.contentEl)
              .addButton((button) => button.setButtonText("取消").onClick(() => modal.close()))
              .addButton((button) =>
                button
                  .setButtonText("确认重置")
                  .setWarning()
                  .onClick(async () => {
                    if (confirmation !== "RESET") {
                      new Notice("请输入 RESET 确认。");
                      return;
                    }
                    button.setDisabled(true);

                    const backupRes = await this.plugin.createBackup("pre-reset");
                    if (!backupRes.success) {
                      new Notice("自动备份失败，已取消重置以保护数据：" + (backupRes.error?.message || backupRes.error));
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
                      new Notice(`Crisp Pulse: 数据已重置（已备份至 backups/${backupRes.fileName}）`);
                    } catch (saveErr) {
                      new Notice("Crisp Pulse：数据保存失败，请检查文件权限。");
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
      "基于知识沉淀与有效编辑算法的知识脉冲热力图与工作复盘看板。"
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

