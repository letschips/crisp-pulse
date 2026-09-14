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
  excludeSystemArtifacts: false, // opt-in; preserve existing collection scope
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
      const dir = parts.length > 1 ? parts[0] : "(根目录)";
      if (!dirCounts.has(dir)) dirCounts.set(dir, { count: 0, words: 0 });
      const dc = dirCounts.get(dir);
      dc.count += 1;
      dc.words += (finfo.wordsAdded || 0);

      if (!fileStats.has(fp)) fileStats.set(fp, { words: 0, rewrittenWords: 0, days: 0, created: false, tasks: 0 });
      const fs = fileStats.get(fp);
      fs.words += (finfo.wordsAdded || 0);
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
    throw new Error('请选择有效日期：开始不晚于结束，结束不晚于今天，区间最多 371 天。');
  }
  return { start, end, days, previousStart: reviewDayKey(first - days), previousEnd: reviewDayKey(first - 1) };
}
const REVIEW_SCOPE_LABELS = { reliable: '可靠记录', recorded_only: '仅实测记录', all: '全部历史' };
const REVIEW_DRAFT_FIELDS = { progress: '主要进展', learning: '洞见与证据', blockers: '阻塞与疑问', next: '下一步行动' };
function getReviewDrilldown(review, folder = '', sort = 'words') {
  const files = (review.allFiles || []).filter(file => folder === '(根目录)' ? !file.path.includes('/') : !folder || file.path.startsWith(`${folder}/`));
  const sortKey = ['words', 'rewrittenWords', 'tasks', 'days'].includes(sort) ? sort : 'words';
  files.sort((a, b) => b[sortKey] - a[sortKey] || a.path.localeCompare(b.path));
  return { files, words: files.reduce((n, f) => n + f.words, 0), rewrittenWords: files.reduce((n, f) => n + f.rewrittenWords, 0), tasks: files.reduce((n, f) => n + f.tasks, 0) };
}
function getReviewInsight(review) {
  if (!review.dirBreakdown?.length) return '没有文件记录，无法据此判断知识流向或产出质量。';
  const topics = review.dirBreakdown.find(d => d.dir === 'Topics')?.percent || 0;
  const core = review.dirBreakdown.find(d => d.dir === 'Core')?.percent || 0;
  const basis = '占比按文件×日期记录数计算，不代表工时或知识质量。';
  if (topics >= 60) return `ANKS 知识沉淀建议：Topics 占比 ${topics}%。可回看相关笔记中的证据与可复用经验；进入 Core 前仍需人工或策略批准。${basis}`;
  if (core >= 40) return `ANKS 底层建设反馈：Core 占比 ${core}%。可检查这些笔记是否已被实际问题引用和验证。${basis}`;
  return `目录记录分布：Core 占比 ${core}%，Topics 占比 ${topics}%。请结合实际笔记复盘。${basis}`;
}
function generateReviewReport(model) {
  const { period, current, previous, comparison, scope, draft } = model;
  const lines = [generateWeeklyMarkdown(current, `知识工作复盘 (${period.start} ~ ${period.end})`), '', '## 数据口径',
    `- 筛选：${REVIEW_SCOPE_LABELS[scope]}`,
    `- 当前区间：${period.start} ~ ${period.end}；纳入 ${current.coverage.recorded}/${period.days} 天，未记录 ${current.coverage.missing} 天，筛除 ${current.coverage.filtered} 天。`,
    `- 对比区间：${period.previousStart} ~ ${period.previousEnd}；纳入 ${previous.coverage.recorded}/${period.days} 天，未记录 ${previous.coverage.missing} 天，筛除 ${previous.coverage.filtered} 天。`,
    '- 未记录不等于零；覆盖不足时，变化只代表已纳入的记录。改写量为估算，贡献分不代表知识质量。',
    '- 目录占比按文件×日期记录数计算，不是编辑次数或工时。', '', '## 前后周期对比',
    '| 指标 | 当前 | 前期 | 变化 |', '| --- | ---: | ---: | --- |'];
  for (const row of comparison) lines.push(`| ${row.label} | ${formatPulseMinutes(row.current)} ${row.unit} | ${formatPulseMinutes(row.previous)} ${row.unit} | ${row.changeLabel} |`);
  lines.push('', '## 复盘反思');
  for (const [key, label] of Object.entries(REVIEW_DRAFT_FIELDS)) lines.push('', `### ${label}`, draft[key] || '（待补充）');
  lines.push('', '## 新增词数来源', '系统目录仅按路径识别，大段捕获为估算；其他新增不能据此归为人工写作。升级前记录保留为历史未分类。');
  for (const [key, label] of Object.entries(REVIEW_SOURCE_LABELS)) lines.push(`- ${label}：${current.sourceWords?.[key] || 0} 词`);
  lines.push('', '## 行动追踪');
  for (const action of model.actions || []) {
    lines.push(`- ${action.status === 'done' ? '[x]' : '[ ]'} ${action.title || '（待填写行动）'} · ${REVIEW_ACTION_STATES[action.status] || '待办'}`);
    if (action.sourcePeriod) lines.push(`  - 继承自：${action.sourcePeriod}`);
    if (action.outcomePath) lines.push(`  - 结果笔记：${reportNoteLink(action.outcomePath)}`);
  }
  if (!model.actions?.length) lines.push('（暂无结构化行动）');
  lines.push('', '## 洞见证据');
  for (const evidence of model.evidence || []) {
    lines.push('', `- ${reportNoteLink(evidence.path)} · 摘录时间 ${evidence.capturedAt}`);
    if (evidence.originalPath !== evidence.path) lines.push(`  - 摘录时路径：${evidence.originalPath}`);
    if (evidence.quote) lines.push(...evidence.quote.split('\n').map(line => `> ${line}`));
  }
  if (!model.evidence?.length) lines.push('（暂无关联证据）');
  return lines.join('\n');
}

const SYSTEM_ARTIFACT_FOLDERS = ['Sidecar/logs', 'Sidecar/backups', 'Sidecar/manifests'];
const REVIEW_SOURCE_LABELS = { system: '系统目录新增', capture: '大段捕获（估算）', unattributed: '其他新增（来源未确认）', historical: '历史未分类' };
const REVIEW_ACTION_STATES = { pending: '待办', done: '完成', deferred: '延期', cancelled: '取消' };
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
  if (!Object.hasOwn(REVIEW_SCOPE_LABELS, scope)) throw new Error('未知的数据筛选范围');
  return `${start}:${end}:${scope}`;
}
function reviewSafePath(path) {
  return typeof path === 'string' && path.endsWith('.md') && !path.startsWith('/') && !path.includes('\\') && !/(?:^|\/)\.\.(?:\/|$)/.test(path) && !/[\r\n\0]/.test(path);
}
function reportNoteLink(path) {
  // Use encoded Markdown links for filenames that cannot safely be represented as wikilinks.
  return /[\[\]|#]/.test(path) ? `[笔记](${path.split('/').map(part => encodeURIComponent(part).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16))).join('/')})` : `[[${path}]]`;
}

// 1.2 Weekly Markdown Generator
function generateWeeklyMarkdown(reviewData, weekTitle = "知识工作周报 (Week Review)") {
  const { totalScore, notesCreated, wordsAdded, rewrittenWords, tasksCompleted, activeHours, focusHours, dirBreakdown, topFiles } = reviewData;

  const lines = [
    `# ${weekTitle}`,
    "",
    "## 📊 区间总览",
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
    lines.push("- *区间内没有文件记录*");
  } else {
    for (const d of dirBreakdown) {
      lines.push(`- \`${d.dir}\`: ${d.percent}% (文件×日期记录 ${d.count} 条 / +${d.words} 词)`);
    }
  }

  lines.push("");
  lines.push("## 📝 新增词数 Top 5");
  if (topFiles.length === 0) {
    lines.push("- *区间内没有笔记记录*");
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

  lines.push("", "## 🗂️ 核心知识目录记录分布", anksInsight, "");

  if (!reviewData.dirBreakdown || reviewData.dirBreakdown.length === 0) {
    lines.push("- *区间内没有文件记录*");
  } else {
    for (const d of reviewData.dirBreakdown) {
      lines.push(`- \`${d.dir}\`: **${d.percent}%** (文件×日期记录 ${d.count} 条 / 沉淀 +${d.words} 词)`);
    }
  }

  lines.push("");
  lines.push("## 📝 新增词数 Top 5");
  if (!reviewData.topFiles || reviewData.topFiles.length === 0) {
    lines.push("- *区间内没有笔记记录*");
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

    const title = `${isoWeek} 知识工作周报 (${startKey} ~ ${endKey})`;
    const content = report?.content || generateAnksWeeklyReviewFileContent(reviewData, title, `${startKey} ~ ${endKey}`);

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
    if (!this.shouldTrackPath(file.path)) return Promise.resolve();
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
            today.files[file.path].wordsAdded += words;
            recordSourceWords(today.files[file.path], file.path, words, words >= 500);
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
    if (this.stopped || (this.sourceFilterChanging && isSystemArtifact(file.path))) return;
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
    if (this.stopped || !this.shouldTrackPath(file.path)) return;
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
        recordSourceWords(fileRecord, file.path, wordsDelta, wordsDelta >= 500 && timeDeltaMs < 2000);
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
      if (!this.shouldTrackPath(file.path)) {
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

  getReviewModel(start, end, scope = this.settings.dataQualityScope || 'reliable') {
    const period = getReviewPeriod(start, end);
    if (!Object.hasOwn(REVIEW_SCOPE_LABELS, scope)) throw new Error('未知的数据筛选范围');
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
    const fields = [['totalScore', '贡献得分', '分'], ['wordsAdded', '新增词数', '词'], ['rewrittenWords', '改写估算', '词'], ['notesCreated', '新建笔记', '篇'], ['tasksCompleted', '完成任务', '项'], ['focusMinutes', '专注记录', '分钟']];
    const comparison = fields.map(([key, label, unit]) => {
      const now = current[key], before = previous[key];
      const percent = previous.coverage.recorded && current.coverage.recorded && before > 0 ? Math.round((now - before) / before * 1000) / 10 : null;
      const changeLabel = !current.coverage.recorded ? '当前无可用记录' : !previous.coverage.recorded ? '前期无可用记录' : before === 0 ? (now === 0 ? '均为零' : '前期为零') : `${percent > 0 ? '+' : ''}${percent}%`;
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
      new Notice('归档目录无效，请在设置中使用库内相对路径。');
      return { success: false, reason: 'invalid_path' };
    }
    if (!Object.hasOwn(REVIEW_SCOPE_LABELS, model.scope)) return { success: false, reason: 'invalid_scope' };
    const topic = /^Topics\/([^/]+)(?:\/|$)/.exec(folder)?.[1];
    const frontmatter = ['---', 'type: review', 'review_type: content-data', ...(topic ? [`topic: ${JSON.stringify(topic)}`] : []),
      `created: ${getTodayKey()}`, `period_start: ${start}`, `period_end: ${end}`, `data_quality_scope: ${model.scope}`, 'generator: crisp-pulse', '---', ''];
    return this.archiveWeeklyReviewToVault(model.current, start, end, {
      fileName: `${start}_${end}-${model.scope}-知识工作复盘.md`,
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
    if (typeof title !== 'string' || !title.trim() || title.length > 500) throw new Error('请填写 1–500 字的行动。');
    const draft = this.reviewDraftForWrite(start, end, scope);
    if (!Array.isArray(draft.actions)) draft.actions = [];
    const action = { id: reviewEntryId(), title: title.trim(), status: 'pending', createdAt: new Date().toISOString() };
    draft.actions.push(action);this.markReviewDraftChanged(draft);return action.id;
  }

  updateReviewAction(start, end, scope, id, patch) {
    if (patch.status !== undefined && !Object.hasOwn(REVIEW_ACTION_STATES, patch.status)) throw new Error('行动状态无效。');
    if (patch.title !== undefined && (typeof patch.title !== 'string' || patch.title.length > 500)) throw new Error('行动文字最多 500 字。');
    if (patch.outcomePath) {
      const file = this.app.vault.getAbstractFileByPath(patch.outcomePath);
      if (!reviewSafePath(patch.outcomePath) || !file || file.extension !== 'md') throw new Error('结果笔记不存在，请填写已有 Markdown 笔记的完整路径。');
    }
    const draft = this.reviewDraftForWrite(start, end, scope);
    const action = draft.actions?.find(item => item?.id === id);if (!action) throw new Error('行动已不存在。');
    for (const key of ['title', 'status', 'outcomePath']) if (patch[key] !== undefined) action[key] = patch[key];
    if (patch.outcomePath && !action.originalOutcomePath) action.originalOutcomePath = patch.outcomePath;
    this.markReviewDraftChanged(draft);
  }

  importPreviousActions(start, end, scope) {
    const period = getReviewPeriod(start, end), sourceKey = getReviewDraftKey(period.previousStart, period.previousEnd, scope);
    const previous = this.store.reviewDrafts?.[sourceKey];if (!previous) return 0;
    const structured = Array.isArray(previous.actions) && previous.actions.length > 0;
    const candidates = structured ? previous.actions.filter(a => a && ['pending', 'deferred'].includes(a.status)) :
      (typeof previous.next === 'string' ? previous.next : '').split(/\r?\n/).map((line, index) => ({ id: `legacy:${sourceKey}:${index}`, title: line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?:\[ \]\s*)?/, '').trim(), status: /^\s*[-*+]\s+\[[xX]\]/.test(line) ? 'done' : 'pending' })).filter(a => a.title && a.status === 'pending');
    if (!candidates.length) return 0;
    const draft = this.reviewDraftForWrite(start, end, scope);if (!Array.isArray(draft.actions)) draft.actions = [];
    let added = 0;
    for (const candidate of candidates) {
      const originId = candidate.originId || candidate.id;
      if (!candidate.title || draft.actions.some(a => a?.originId === originId || a?.id === originId)) continue;
      draft.actions.push({ id: reviewEntryId(), originId, title: candidate.title, status: 'pending', sourcePeriod: sourceKey, createdAt: new Date().toISOString() });added++;
    }
    if (added) this.markReviewDraftChanged(draft);return added;
  }

  async addReviewEvidence(start, end, scope, path, quote = '') {
    const model = this.getReviewModel(start, end, scope);
    if (!reviewSafePath(path) || !model.current.allFiles.some(file => file.path === path)) throw new Error('请选择当前区间与范围内的笔记。');
    if (typeof quote !== 'string' || quote.length > 2000) throw new Error('单条摘录最多 2000 字。');
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || file.extension !== 'md') throw new Error('原笔记已不存在。');
    const originalPath = path;
    const content = await this.app.vault.read(file);
    if (this.stopped) throw new Error('插件已停止，请重试。');
    quote = quote.replace(/\r\n/g, '\n');
    if (quote && !content.replace(/\r\n/g, '\n').includes(quote)) throw new Error('摘录与当前原文不一致，请重新选择原文。');
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
    if (this.reviewComposing && container.contains(container.ownerDocument.activeElement)) return;
    const previousScroll = container?.scrollTop || 0;
    const previousHorizontal = container.querySelector(".crisp-pulse-heatmap-scroll")?.scrollLeft || 0;
    const active = container.ownerDocument.activeElement;
    const formFocus = container.contains(active) && active.dataset?.reviewField
      ? { field: active.dataset.reviewField, start: active.selectionStart, end: active.selectionEnd, scroll: active.scrollTop } : null;
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
    if (formFocus) {
      const input = [...container.querySelectorAll('[data-review-field]')].find(el => el.dataset.reviewField === formFocus.field);
      input?.focus({ preventScroll: true });
      if ((input?.tagName === 'TEXTAREA' || input?.type === 'text' || input?.type === 'search') && formFocus.start !== null) {
        input.setSelectionRange(formFocus.start, formFocus.end); input.scrollTop = formFocus.scroll;
      }
    }
    else if (focusedDate) container.querySelector(`[data-date="${focusedDate}"]`)?.focus({ preventScroll: true });
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
      text: "知识复盘"
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
    rangeSelect.createEl("option", { text: "时间: 最近 7 天", value: "7d" });
    rangeSelect.createEl("option", { text: "时间: 本年 (YTD)", value: "ytd" });
    rangeSelect.hidden = this.activeViewTab !== "dashboard";
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
      text: "导出全量 CSV"
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
    const now = new Date();
    const end = this.reviewEnd || dateKey(now);
    const start = this.reviewStart || dateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6));
    this.reviewStart = start;this.reviewEnd = end;
    const model = this.plugin.getReviewModel(start, end, this.currentScope);
    const card = parent.createDiv({ cls: 'crisp-pulse-review-card crisp-pulse-review-workspace' });
    card.createEl('h2', { text: '知识复盘与报告' });
    card.createEl('p', { cls: 'crisp-pulse-review-note', text: '先看发生了什么，再把证据、洞见和下一步写下来。报告包含整个区间，目录筛选只用于查看笔记。' });
    const periodControls = card.createDiv({ cls: 'crisp-pulse-review-controls' });
    const applyPeriod = (a, b) => {
      try {
        getReviewPeriod(a, b);
        this.reviewStart = a; this.reviewEnd = b;
        this.reviewRangeInputs = { start: a, end: b };
        this.reviewFileLimit = 20;
        this.render();
      } catch (error) { new Notice(error.message); }
    };
    const pending = this.reviewRangeInputs || { start, end };
    for (const [field, label] of [['start', '开始日期'], ['end', '结束日期']]) {
      const wrap = periodControls.createEl('label', { text: label });
      const input = wrap.createEl('input', { type: 'date' });
      input.value = pending[field]; input.max = getTodayKey(); input.setAttr('aria-label', label);
      input.dataset.reviewField = `period-${field}`;
      input.addEventListener('input', () => { this.reviewRangeInputs = { ...(this.reviewRangeInputs || { start, end }), [field]: input.value }; });
    }
    const apply = periodControls.createEl('button', { cls: 'crisp-pulse-tab-btn', text: '应用日期' });
    apply.addEventListener('click', () => { const range = this.reviewRangeInputs || { start, end }; applyPeriod(range.start, range.end); });
    const quick = card.createDiv({ cls: 'crisp-pulse-review-controls' });
    for (const days of [7, 30, 90]) {
      const button = quick.createEl('button', { cls: 'crisp-pulse-tab-btn', text: `最近 ${days} 天` });
      button.addEventListener('click', () => applyPeriod(reviewDayKey(reviewDayNumber(getTodayKey()) - days + 1), getTodayKey()));
    }
    const previous = quick.createEl('button', { cls: 'crisp-pulse-tab-btn', text: '前一个周期' });
    previous.addEventListener('click', () => applyPeriod(model.period.previousStart, model.period.previousEnd));
    const next = quick.createEl('button', { cls: 'crisp-pulse-tab-btn', text: '后一个周期' });
    const nextEnd = reviewDayKey(reviewDayNumber(end) + model.period.days);
    next.disabled = nextEnd > getTodayKey();
    next.addEventListener('click', () => applyPeriod(reviewDayKey(reviewDayNumber(end) + 1), nextEnd));
    card.createEl('p', { cls: 'crisp-pulse-review-note', text: `${start} — ${end} · ${REVIEW_SCOPE_LABELS[this.currentScope]} · 纳入 ${model.current.coverage.recorded}/${model.period.days} 天，未记录 ${model.current.coverage.missing} 天，筛除 ${model.current.coverage.filtered} 天。未记录不等于零。` });

    const comparison = card.createDiv({ cls: 'crisp-pulse-review-section' });
    comparison.createEl('h3', { text: '前后周期对比' });
    comparison.createEl('p', { cls: 'crisp-pulse-review-note', text: `前期 ${model.period.previousStart} — ${model.period.previousEnd}，纳入 ${model.previous.coverage.recorded}/${model.period.days} 天。覆盖不足时，变化只代表已纳入记录；贡献分不代表知识质量。` });
    const stats = comparison.createDiv({ cls: 'crisp-pulse-review-comparison' });
    for (const row of model.comparison) {
      const box = stats.createDiv({ cls: 'crisp-pulse-stat-box' });
      box.createDiv({ cls: 'crisp-pulse-stat-label', text: row.label });
      box.createDiv({ cls: 'crisp-pulse-stat-value', text: `${formatPulseMinutes(row.current)} ${row.unit}` });
      box.createDiv({ cls: 'crisp-pulse-review-note', text: `前期 ${formatPulseMinutes(row.previous)} ${row.unit} · ${row.changeLabel}` });
    }
    this.renderReviewSources(card, model);
    this.renderReviewDrilldown(card, model.current);
    this.renderReviewActions(card, model);
    this.renderReviewEvidence(card, model);
    this.renderReviewDraft(card, model);
  }

  renderReviewDrilldown(parent, review) {
    const section = parent.createDiv({ cls: 'crisp-pulse-review-section' });
    section.createEl('h3', { text: '目录与笔记钻取' });
    section.createEl('p', { cls: 'crisp-pulse-review-note', text: '按文件记录查看新增、改写估算与任务。记录天数表示文件在多少天出现过，不代表编辑次数；历史路径随重命名更新。' });
    const controls = section.createDiv({ cls: 'crisp-pulse-review-controls' });
    const folders = new Set();
    for (const file of review.allFiles) {
      const parts = file.path.split('/');
      if (parts.length === 1) folders.add('(根目录)');
      for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
    }
    const folder = controls.createEl('select', { cls: 'crisp-pulse-scope-select' });
    folder.setAttr('aria-label', '复盘目录');
    folder.createEl('option', { text: '全部目录', value: '' });
    for (const path of [...folders].sort()) folder.createEl('option', { text: path, value: path });
    if (this.reviewFolder && !folders.has(this.reviewFolder)) this.reviewFolder = '';
    folder.value = this.reviewFolder || '';
    folder.addEventListener('change', () => { this.reviewFolder = folder.value; this.reviewFileLimit = 20; this.render(); });
    const sort = controls.createEl('select', { cls: 'crisp-pulse-scope-select' });
    sort.setAttr('aria-label', '笔记排序');
    for (const [key, label] of [['words', '按新增词数'], ['rewrittenWords', '按改写估算'], ['tasks', '按完成任务'], ['days', '按记录天数']]) sort.createEl('option', { text: label, value: key });
    sort.value = this.reviewSort || 'words';
    sort.addEventListener('change', () => { this.reviewSort = sort.value; this.reviewFileLimit = 20; this.render(); });
    const drill = getReviewDrilldown(review, folder.value, sort.value);
    section.createDiv({ cls: 'crisp-pulse-review-note', text: `${drill.files.length} 篇笔记 · 新增 ${formatPulseMinutes(drill.words)} 词 · 改写估算 ${formatPulseMinutes(drill.rewrittenWords)} 词 · ${formatPulseMinutes(drill.tasks)} 项任务` });
    const list = section.createDiv({ cls: 'crisp-pulse-review-files' });
    const limit = this.reviewFileLimit || 20;
    for (const file of drill.files.slice(0, limit)) {
      const button = list.createEl('button', { cls: 'crisp-pulse-review-file' });
      button.createSpan({ text: file.path, cls: 'crisp-pulse-review-path' });
      button.createSpan({ text: `新增 ${formatPulseMinutes(file.words)} · 改写 ${formatPulseMinutes(file.rewrittenWords)} · 任务 ${formatPulseMinutes(file.tasks)} · ${file.days} 天`, cls: 'crisp-pulse-review-note' });
      button.addEventListener('click', () => {
        const target = this.app.vault.getAbstractFileByPath(file.path);
        if (target instanceof TFile) this.app.workspace.getLeaf('tab').openFile(target);
        else new Notice('该笔记已不存在，统计记录仍保留。');
      });
    }
    if (!drill.files.length) list.createDiv({ cls: 'crisp-pulse-review-note', text: '这个区间和筛选范围没有文件记录。' });
    if (drill.files.length > limit) {
      const more = section.createEl('button', { cls: 'crisp-pulse-tab-btn', text: `再显示 20 篇（已显示 ${limit}/${drill.files.length}）` });
      more.setAttr('aria-label', '显示更多复盘笔记');
      more.addEventListener('click', () => { this.reviewFileLimit = limit + 20; this.render(); });
    }
  }

  renderReviewSources(parent, model) {
    const section = parent.createDiv({ cls: 'crisp-pulse-review-section' });
    section.createEl('h3', { text: '新增词数来源' });
    section.createEl('p', { cls: 'crisp-pulse-review-note', text: '系统目录按路径识别；大段捕获为估算，其他新增来源未确认。历史记录保持未分类，无法据此区分人工与 AI 写作。' });
    const grid = section.createDiv({ cls: 'crisp-pulse-review-sources' });
    for (const [key, label] of Object.entries(REVIEW_SOURCE_LABELS)) {
      const box = grid.createDiv({ cls: 'crisp-pulse-stat-box' });
      box.createDiv({ cls: 'crisp-pulse-stat-label', text: label });
      box.createDiv({ cls: 'crisp-pulse-stat-value', text: `${formatPulseMinutes(model.current.sourceWords[key])} 词` });
    }
    const row = section.createDiv({ cls: 'crisp-pulse-review-controls' });
    const toggle = row.createEl('button', { cls: 'crisp-pulse-tab-btn', text: this.plugin.settings.excludeSystemArtifacts ? '系统产物已排除' : '排除后续系统产物' });
    toggle.setAttr('aria-pressed', String(!!this.plugin.settings.excludeSystemArtifacts));
    toggle.addEventListener('click', async () => {
      toggle.disabled = true;
      try { await this.plugin.setSystemArtifactsExcluded(!this.plugin.settings.excludeSystemArtifacts);this.render(); }
      catch (error) { new Notice(`设置未保存：${error.message}`);toggle.disabled = false; }
    });
    row.createSpan({ cls: 'crisp-pulse-review-note', text: '仅作用于 Sidecar/logs、Sidecar/backups、Sidecar/manifests。历史保留，现有目录黑白名单继续生效。' });
  }

  renderReviewActions(parent, model) {
    const section = parent.createDiv({ cls: 'crisp-pulse-review-section' });
    section.createEl('h3', { text: '跨期行动' });
    section.createEl('p', { cls: 'crisp-pulse-review-note', text: '跟进上一期的承诺，记录状态与实际交付。导入只读取同一数据范围的前一个等长周期，不修改上一期记录。' });
    const args = [model.period.start, model.period.end, model.scope];
    const controls = section.createDiv({ cls: 'crisp-pulse-review-controls' });
    const inherit = controls.createEl('button', { cls: 'crisp-pulse-tab-btn', text: '带入上一期未完成行动' });
    inherit.addEventListener('click', () => {
      const count = this.plugin.importPreviousActions(...args);new Notice(count ? `已带入 ${count} 项行动。` : '没有新的未完成行动可带入。');this.render();
    });
    const title = controls.createEl('input', { type: 'text', placeholder: '新增一项可执行的行动' });
    title.maxLength = 500;title.setAttr('aria-label', '新行动');title.dataset.reviewField = 'new-action';const newActionKey = getReviewDraftKey(...args);this.reviewNewActions ||= {};title.value = this.reviewNewActions[newActionKey] || '';
    this.trackReviewComposition(title);
    title.addEventListener('input', () => { this.reviewNewActions[newActionKey] = title.value; });
    const add = controls.createEl('button', { cls: 'crisp-pulse-tab-btn', text: '添加行动' });
    const submit = () => {
      try { this.plugin.addReviewAction(...args, title.value);delete this.reviewNewActions[newActionKey];this.render(); }
      catch (error) { new Notice(error.message); }
    };
    add.addEventListener('click', submit);title.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault();submit(); } });
    const list = section.createDiv({ cls: 'crisp-pulse-review-action-list' });
    if (!model.actions.length) list.createDiv({ cls: 'crisp-pulse-review-note', text: '还没有行动。可以新增，或将上一期“下一步行动”逐行带入。' });
    for (const action of model.actions) {
      const item = list.createDiv({ cls: 'crisp-pulse-review-action' });
      const row = item.createDiv({ cls: 'crisp-pulse-review-controls' });
      const input = row.createEl('input', { type: 'text' });input.value = action.title;input.maxLength = Math.max(500, action.title.length);
      input.dataset.reviewField = `action-${action.id}`;input.setAttr('aria-label', '行动内容');this.trackReviewComposition(input);
      input.addEventListener('input', () => {
        try { this.plugin.updateReviewAction(...args, action.id, { title: input.value }); }
        catch (error) { new Notice(error.message); }
      });
      const state = row.createEl('select', { cls: 'crisp-pulse-scope-select' });state.setAttr('aria-label', `行动状态 ${action.id}`);
      for (const [key, label] of Object.entries(REVIEW_ACTION_STATES)) state.createEl('option', { value: key, text: label });
      state.value = action.status;
      state.addEventListener('change', () => { this.plugin.updateReviewAction(...args, action.id, { status: state.value }); });
      if (action.sourcePeriod) item.createDiv({ cls: 'crisp-pulse-review-note', text: `继承自 ${action.sourcePeriod.split(':').slice(0, 2).join(' — ')}` });
      const outcome = item.createDiv({ cls: 'crisp-pulse-review-controls' });
      const path = outcome.createEl('input', { type: 'text', placeholder: '结果笔记完整路径，例如 Topics/项目/交付.md' });
      path.setAttr('aria-label', `结果笔记 ${action.id}`);path.dataset.reviewField = `outcome-${action.id}`;
      this.reviewOutcomeInputs ||= {};path.value = this.reviewOutcomeInputs[action.id] ?? action.outcomePath ?? '';
      this.trackReviewComposition(path);path.addEventListener('input', () => { this.reviewOutcomeInputs[action.id] = path.value; });
      const link = outcome.createEl('button', { cls: 'crisp-pulse-tab-btn', text: '关联结果' });
      link.setAttr('aria-label', `关联结果 ${action.id}`);
      link.addEventListener('click', () => {
        try { this.plugin.updateReviewAction(...args, action.id, { outcomePath: path.value.trim() });delete this.reviewOutcomeInputs[action.id];new Notice(path.value.trim() ? '结果笔记已关联。' : '结果关联已清除。');this.render(); }
        catch (error) { new Notice(error.message); }
      });
      if (action.outcomePath) {
        const open = outcome.createEl('button', { cls: 'crisp-pulse-tab-btn', text: '打开结果笔记' });
        open.addEventListener('click', () => this.openReviewNote(action.outcomePath));
      }
    }
  }

  trackReviewComposition(input) {
    input.addEventListener('compositionstart', () => { this.reviewComposing = true; });
    input.addEventListener('compositionend', () => { this.reviewComposing = false; });
  }

  openReviewNote(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) this.app.workspace.getLeaf('tab').openFile(file);
    else new Notice('原笔记已不存在，保留的证据摘录仍可查阅。');
  }

  renderReviewEvidence(parent, model) {
    const section = parent.createDiv({ cls: 'crisp-pulse-review-section' });
    section.createEl('h3', { text: '洞见证据' });
    section.createEl('p', { cls: 'crisp-pulse-review-note', text: '从本期笔记中关联来源，可保留原文摘录。摘录保存后不会随原文修改，仍可追溯采集时间和原始路径。' });
    const add = section.createEl('button', { cls: 'crisp-pulse-tab-btn', text: '从本期笔记添加证据' });
    add.disabled = !model.current.allFiles.length;
    add.addEventListener('click', () => new CrispPulseEvidenceModal(this.app, this.plugin, model, () => this.render()).open());
    const list = section.createDiv({ cls: 'crisp-pulse-review-evidence-list' });
    if (!model.evidence.length) list.createDiv({ cls: 'crisp-pulse-review-note', text: '尚未关联证据。保存后的报告会包含来源链接与摘录。' });
    for (const evidence of model.evidence) {
      const item = list.createDiv({ cls: 'crisp-pulse-review-evidence' });
      const controls = item.createDiv({ cls: 'crisp-pulse-review-controls' });
      const open = controls.createEl('button', { cls: 'crisp-pulse-tab-btn crisp-pulse-review-evidence-link', text: evidence.path });
      open.addEventListener('click', () => this.openReviewNote(evidence.path));
      const remove = controls.createEl('button', { cls: 'crisp-pulse-tab-btn', text: '移除引用' });
      remove.setAttr('aria-label', `移除引用 ${evidence.id}`);
      remove.addEventListener('click', () => { this.plugin.removeReviewEvidence(model.period.start, model.period.end, model.scope, evidence.id);this.render(); });
      item.createDiv({ cls: 'crisp-pulse-review-note', text: `摘录于 ${evidence.capturedAt?.slice(0, 10) || '未知日期'}${evidence.originalPath !== evidence.path ? ` · 原路径 ${evidence.originalPath}` : ''}` });
      if (evidence.quote) item.createEl('blockquote', { text: evidence.quote, cls: 'crisp-pulse-review-quote' });
    }
  }

  renderReviewDraft(parent, model) {
    const section = parent.createDiv({ cls: 'crisp-pulse-review-section' });
    section.createEl('h3', { text: '复盘报告' });
    section.createEl('p', { cls: 'crisp-pulse-review-note', text: '草稿按日期区间和数据范围分别保存。后台定期保存，也可点击立即保存；复制和归档会包含最新输入。' });
    const fields = section.createDiv({ cls: 'crisp-pulse-review-drafts' });
    for (const [key, label] of Object.entries(REVIEW_DRAFT_FIELDS)) {
      const wrap = fields.createEl('label', { text: label });
      const input = wrap.createEl('textarea');
      input.value = model.draft[key]; input.rows = 4;
      input.setAttr('aria-label', label); input.dataset.reviewField = key;
      input.placeholder = { progress: '完成了什么？对应哪些笔记或交付？', learning: '哪些认识发生了变化？保留原始证据链接。', blockers: '还有什么未解决、需要验证？', next: '写下下一步可执行的动作。' }[key];
      input.addEventListener('compositionstart', () => { this.reviewComposing = true; });
      input.addEventListener('compositionend', () => { this.reviewComposing = false; });
      input.addEventListener('input', () => this.plugin.updateReviewDraft(model.period.start, model.period.end, model.scope, key, input.value));
    }
    const actions = section.createDiv({ cls: 'crisp-pulse-review-controls' });
    const status = section.createDiv({ cls: 'crisp-pulse-review-note' });
    status.setAttr('role', 'status');
    const fresh = () => this.plugin.getReviewModel(model.period.start, model.period.end, model.scope);
    const save = actions.createEl('button', { cls: 'crisp-pulse-tab-btn', text: '立即保存草稿' });
    save.addEventListener('click', async () => {
      save.disabled = true;
      const result = await this.plugin.savePluginData();
      save.disabled = false; status.setText(result.success ? '草稿已保存到本地。' : '保存失败，草稿仍在内存中，请重试。');
    });
    const copy = actions.createEl('button', { cls: 'crisp-pulse-tab-btn', text: '复制 Markdown 报告' });
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(generateReviewReport(fresh())); status.setText('报告已复制。'); }
      catch (error) { status.setText('复制失败，请检查剪贴板权限后重试。'); }
    });
    const archive = actions.createEl('button', { cls: 'crisp-pulse-tab-btn is-active', text: '归档至知识库' });
    archive.addEventListener('click', async () => {
      archive.disabled = true;
      try {
        const result = await this.plugin.archiveReviewReport(fresh());
        status.setText(result.success ? `已归档：${result.path}` : result.reason === 'exists' ? '同区间、同范围报告已存在，原文已保留。' : '归档失败，请检查目录或控制台后重试。');
      } catch (error) { status.setText(`归档失败：${error.message}`); }
      finally { archive.disabled = false; }
    });
    if (this.plugin.focusAdapter?.isAvailable()) {
      const focus = actions.createEl('button', { cls: 'crisp-pulse-tab-btn', text: '开启 25 分钟专注' });
      focus.addEventListener('click', () => this.plugin.focusAdapter.startFocusSession(25));
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

class CrispPulseEvidenceModal extends Modal {
  constructor(app, plugin, model, onAdded) { super(app);this.plugin = plugin;this.model = model;this.onAdded = onAdded;this.readVersion = 0; }
  onOpen() {
    const root = this.contentEl;root.empty();root.addClass('crisp-pulse-evidence-modal');
    root.createEl('h2', { text: '关联洞见证据' });
    root.createEl('p', { text: '搜索本期笔记。选中原文可添加摘录，也可只保留来源链接。', cls: 'crisp-pulse-review-note' });
    const search = root.createEl('input', { type: 'search', placeholder: '按笔记路径搜索' });search.setAttr('aria-label', '搜索证据笔记');
    const choices = root.createDiv({ cls: 'crisp-pulse-evidence-choices' });
    const chosen = root.createDiv({ cls: 'crisp-pulse-review-note', text: '尚未选择笔记' });
    const preview = root.createEl('textarea');preview.readOnly = true;preview.rows = 7;preview.setAttr('aria-label', '证据原文预览');
    const quote = root.createEl('textarea');quote.rows = 3;quote.maxLength = 2000;quote.placeholder = '原文摘录（可留空，最多 2000 字）';quote.setAttr('aria-label', '保留的原文摘录');
    const status = root.createDiv({ cls: 'crisp-pulse-review-note' });status.setAttr('role', 'status');
    const actions = root.createDiv({ cls: 'crisp-pulse-review-controls' });
    const use = actions.createEl('button', { text: '使用选中文本' });
    use.addEventListener('click', () => {
      const selected = preview.value.slice(preview.selectionStart, preview.selectionEnd);
      if (!selected) { status.setText('请先在原文预览中选择文字。');return; }
      if (selected.length > 2000) { status.setText('选中文字超过 2000 字，请缩小范围。');return; }
      quote.value = selected;status.setText('已填入选中的原文。');
    });
    const save = actions.createEl('button', { text: '保存证据' });save.disabled = true;
    const select = async path => {
      const token = ++this.readVersion;this.selectedPath = null;save.disabled = true;preview.value = '';quote.value = '';chosen.setText(`读取：${path}`);
      try {
        const file = this.app.vault.getAbstractFileByPath(path);if (!file || file.extension !== 'md') throw new Error('原笔记已不存在。');
        const content = await this.app.vault.read(file);if (token !== this.readVersion) return;
        this.selectedPath = file.path;preview.value = content.slice(0, 12000);chosen.setText(file.path);save.disabled = false;
        status.setText(content.length > 12000 ? '预览前 12000 字；保存时会核对完整原文。' : '可选择原文，或直接保存来源链接。');
      } catch (error) { if (token === this.readVersion) { chosen.setText(path);status.setText(error.message); } }
    };
    const renderChoices = () => {
      choices.empty();const query = search.value.trim().toLocaleLowerCase();
      const files = this.model.current.allFiles.filter(file => file.path.toLocaleLowerCase().includes(query));
      for (const file of files.slice(0, 20)) { const button = choices.createEl('button', { text: file.path });button.addEventListener('click', () => select(file.path)); }
      if (files.length > 20) choices.createDiv({ cls: 'crisp-pulse-review-note', text: `匹配 ${files.length} 篇，仅显示前 20 篇，请继续缩小搜索。` });
      if (!files.length) choices.createDiv({ cls: 'crisp-pulse-review-note', text: '没有匹配的本期笔记。' });
    };
    search.addEventListener('input', renderChoices);renderChoices();
    save.addEventListener('click', async () => {
      if (!this.selectedPath) return;save.disabled = true;
      try {
        const added = await this.plugin.addReviewEvidence(this.model.period.start, this.model.period.end, this.model.scope, this.selectedPath, quote.value);
        const result = await this.plugin.savePluginData();
        if (!result.success) { status.setText('证据已保留在内存，但保存失败，请重试。');return; }
        this.onAdded();this.close();new Notice(added ? '证据已关联。' : '相同证据已存在。');
      } catch (error) { status.setText(error.message); }
      finally { save.disabled = !this.selectedPath; }
    });
    search.focus();
  }
  onClose() { this.readVersion++;this.contentEl.empty(); }
}

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

    new Setting(containerEl)
      .setName("排除后续系统产物")
      .setDesc("排除 Sidecar/logs、Sidecar/backups、Sidecar/manifests 的后续文件采集；不改历史记录和目录黑白名单。")
      .addToggle(toggle => toggle.setValue(!!this.plugin.settings.excludeSystemArtifacts).onChange(async value => {
        try { await this.plugin.setSystemArtifactsExcluded(value); }
        catch (error) { new Notice(`设置未保存：${error.message}`);this.display(); }
      }));

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


module.exports.getReviewDrilldown = getReviewDrilldown;
module.exports.generateReviewReport = generateReviewReport;

module.exports.CrispPulseEvidenceModal = CrispPulseEvidenceModal;
