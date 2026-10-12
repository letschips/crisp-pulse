/* 1.19.3：速记面板跟着笔记刷新。失败模式：在原笔记里删掉最后一个速记块，新内容里没有 [!memo]，面板不刷新，仍显示已删的卡片。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('removing the last memo block from a note refreshes the memo panel', async () => {
  const events = {};
  const timers = [];
  const ctx = {
    require: (m) => (['crypto', 'fs', 'path', 'util'].includes(m) ? require(m) : { Plugin: class {}, ItemView: class {}, PluginSettingTab: class {}, Modal: class {}, Notice: class {}, Setting: class {}, TFile: class {}, addIcon() {} }),
    module: { exports: {} }, console, Date,
    window: { setTimeout, clearTimeout, setInterval: (f, n) => { const t = setInterval(f, n); t.unref(); timers.push(t); return t; }, clearInterval },
    document: {}, navigator: {}, setTimeout, clearTimeout, structuredClone, crypto: globalThis.crypto, atob, TextDecoder, TextEncoder, Buffer,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8'), ctx);
  const P = ctx.module.exports;
  P.CrispPulseLicenseManager.prototype.initialize = async () => {};
  const file = { path: '2026-10-12.md', extension: 'md', stat: { mtime: 1, size: 30 }, content: '> [!memo] 12:00\n> 唯一一条速记\n' };
  const on = (kind, n, fn) => { (events[`${kind}:${n}`] ||= []).push(fn); return {}; };
  let shown = [];
  const p = new P();
  p.manifest = { id: 'crisp-pulse', version: 'test', dir: 'plugin' };
  p.loadData = async () => ({ daily: {}, settings: { showStatusBarItem: false, memoMode: 'general', hasRunBackfill: true } });
  p.app = {
    vault: { configDir: '.obsidian', getMarkdownFiles: () => [file], cachedRead: async (f) => f.content, read: async (f) => f.content, adapter: { exists: async () => false }, on: (n, f) => on('vault', n, f) },
    metadataCache: { getFileCache: () => ({}), on: (n, f) => on('metadata', n, f) },
    workspace: { on: (n, f) => on('workspace', n, f), onLayoutReady() {}, getLeavesOfType: () => [{ view: { reload: async () => { shown = await p.memoStore.list(); } } }] },
    plugins: { getPlugin: () => null },
  };
  for (const n of ['registerView', 'addRibbonIcon', 'addCommand', 'addSettingTab', 'registerEvent', 'registerInterval', 'registerActivityListeners']) p[n] = () => {};
  try {
    await p.onload();
    shown = await p.memoStore.list();
    assert.equal(shown.length, 1);
    file.content = '# 日记\n手动删掉了最后一条速记\n';
    file.stat = { mtime: 2, size: 35 };
    for (const fn of events['vault:modify'] || []) await fn(file);
    for (const fn of events['metadata:changed'] || []) await fn(file, file.content, {});
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(shown.length, 0, '面板刷新，已删的卡片不再显示');
  } finally {
    timers.forEach(clearInterval);
    p.onunload?.();
  }
});
