/* 速记进 Crisp Search（1.47.0，Crisp Search 0.8.0 的结果提供方接口）。失败模式：
   - 没有隐藏标识的速记（真实库里占大多数）列不出来，或选中后定位不到那一条；
   - 为了能定位，在列出时往笔记里写标识（搜索不该改笔记）；
   - 速记第二行以后的文字搜不到；图片、标签、Markdown 标记进了标题；
   - 速记已被改动或删掉，选中后面板显示一个空列表而不说明；
   - 没装 Crisp Search、版本旧或它后加载时，Pulse 报错或永远不注册；Pulse 重载后留下失效的提供方；
   - 速记混进「全部」页签，和正文命中重复。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const context = {
  require: () => ({ Plugin: class {}, TFile: class {}, ItemView: class {}, PluginSettingTab: class {}, Setting: class {}, Modal: class {}, Notice: class {}, addIcon() {} }),
  module: { exports: {} }, console, Date, window: { setTimeout, clearTimeout, setInterval, clearInterval },
  document: { hidden: false }, navigator: {}, setTimeout, clearTimeout, structuredClone, crypto: globalThis.crypto, TextEncoder, TextDecoder, Buffer, atob, Blob,
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8'), context);
const Pulse = context.module.exports;
const View = Pulse.CrispPulseMemoView;
const { memoSearchEntries, memoSearchTarget } = Pulse.memoHelpers;
const plain = (value) => JSON.parse(JSON.stringify(value));

const memos = [
  { id: 'abc-1', date: '2026-11-11', time: '11:20', path: 'Daily/2026-11-11.md', startLine: 12, text: '**搜索**插件大改 #工作\n把任务和速记也接进来' },
  { date: '2026-11-10', time: '09:00', path: 'Daily/2026-11-10.md', startLine: 4, text: '![[a.png]]\n- 整理照片' },
  { date: '2026-11-09', time: '08:00', path: 'Daily/2026-11-09.md', startLine: 7, text: '![[录音.webm]]' },
];

test('every memo becomes an entry, with or without a hidden id, and nothing is written', () => {
  const entries = plain(memoSearchEntries(memos));
  assert.deepEqual(entries.map((e) => e.id), ['id:abc-1', 'at:4:Daily/2026-11-10.md', 'at:7:Daily/2026-11-09.md']);
  assert.equal(entries[0].title, '搜索插件大改');
  assert.equal(entries[0].text, '**搜索**插件大改 #工作\n把任务和速记也接进来');
  assert.equal(entries[0].accessory, '2026-11-11 11:20');
  assert.equal(entries[1].title, '整理照片');
  assert.match(entries[2].title, /2026-11-09 08:00/, '只有录音的速记用时间当标题');
  assert.deepEqual(plain(memoSearchTarget('id:abc-1')), { id: 'abc-1' });
  assert.deepEqual(plain(memoSearchTarget('at:4:Daily/2026-11-10.md')), { path: 'Daily/2026-11-10.md', startLine: 4 });
  assert.deepEqual(plain(memoSearchTarget('at:4:目录/含:冒号.md')), { path: '目录/含:冒号.md', startLine: 4 });
  for (const bad of ['', 'id:', 'id:has space', 'at:x:Daily/a.md', 'at:4:', 'other:1', null]) assert.equal(memoSearchTarget(bad), null, String(bad));
});

function fakePulse({ search = null, list = async () => memos.map((m) => ({ ...m })) } = {}) {
  const focused = [];
  const view = { focusMemo: (id) => focused.push({ id }), focusMemoAt: (at) => focused.push(plain(at)) };
  const plugin = Object.assign(Object.create(Pulse.prototype), {
    stopped: false,
    app: { plugins: { plugins: search ? { 'crisp-search': search } : {} }, workspace: { getLeavesOfType: () => [{ view }] } },
    memoStore: { list },
    activateMemoView: async () => {},
  });
  return { plugin, focused };
}

test('choosing a result shows that memo in the panel; a memo that moved or is gone is reported', async () => {
  const { plugin, focused } = fakePulse();
  await plugin.revealMemoEntry('id:abc-1');
  await plugin.revealMemoEntry('at:4:Daily/2026-11-10.md');
  assert.deepEqual(focused, [{ id: 'abc-1' }, { path: 'Daily/2026-11-10.md', startLine: 4 }]);
  await assert.rejects(() => plugin.revealMemoEntry('at:99:Daily/2026-11-10.md'), /速记/);
  await assert.rejects(() => plugin.revealMemoEntry('id:not-there'), /速记/);
  await assert.rejects(() => plugin.revealMemoEntry('junk'), /速记/);
  assert.equal(focused.length, 2);
});

/* 速记面板在侧栏里但不是当前标签页时，Obsidian 重启或 Pulse 重载后它是延迟加载的占位视图，没有 focusMemo/focusMemoAt。
   revealLeaf 是 async，接口只保证它完成时真视图已加载（最后一步 await loadIfDeferred()）。Obsidian 1.15.0 实测在同步阶段
   就换上了真视图（2026-11-12），但 onOpen 还没跑完；这里按接口约定测：换视图慢于一个微任务时，调用方也要等到真视图再操作。 */
function deferredWorkspace() {
  const focused = [];
  const real = { focusMemo: (id) => focused.push({ id }), focusMemoAt: (at) => focused.push(plain(at)), showQuery: (q) => focused.push({ q }) };
  const leaf = { view: {} };
  // 真实的 rerender 走 setViewState、等视图 onOpen 读完文件，远不止一个微任务。
  leaf.loadIfDeferred = async () => { await new Promise((r) => setTimeout(r, 5)); leaf.view = real; };
  const workspace = {
    getLeavesOfType: () => [leaf],
    revealLeaf: async (l) => { await l.loadIfDeferred(); },
  };
  return { workspace, focused };
}

test('a memo panel that is still deferred after a restart is loaded before the memo is shown', async () => {
  for (const [name, run, want] of [
    ['Search, memo with id', (p) => p.revealMemoEntry('id:abc-1'), [{ id: 'abc-1' }]],
    ['Search, memo without id', (p) => p.revealMemoEntry('at:4:Daily/2026-11-10.md'), [{ path: 'Daily/2026-11-10.md', startLine: 4 }]],
    ['Tempo back to its memo', (p) => p.revealMemo({ id: 'abc-1' }), [{ id: 'abc-1' }]],
    ['review "see these memos"', (p) => p.openMemoQuery('#工作'), [{ q: '#工作' }]],
  ]) {
    const { workspace, focused } = deferredWorkspace();
    const plugin = Object.assign(Object.create(Pulse.prototype), {
      stopped: false,
      app: { plugins: { plugins: {} }, workspace },
      memoStore: { list: async () => memos.map((m) => ({ ...m })) },
    });
    await run(plugin);
    assert.deepEqual(focused, want, name);
  }
});

test('the panel can show one memo that has no id, and clears that with the other filters', () => {
  const v = Object.create(View.prototype);
  v.resetFilters();
  v.memos = memos.map((m) => ({ ...m, tags: [], links: [] }));
  v.reload = async () => {};
  v.focusMemoAt({ path: 'Daily/2026-11-10.md', startLine: 4 });
  assert.equal(v.isFiltered(), true);
  assert.deepEqual(v.visibleMemos().map((m) => m.startLine), [4]);
  v.resetFilters();
  assert.equal(v.isFiltered(), false);
  assert.equal(v.visibleMemos().length, 3);
});

test('Pulse registers with Crisp Search when it can, keeps memos out of the mixed tab, and never throws', async () => {
  const none = fakePulse();
  none.plugin.connectSearch();
  assert.equal(none.plugin.offSearch, null);
  const old = fakePulse({ search: { searchProviderApiVersion: 0, registerSearchProvider() { throw new Error('should not be called'); } } });
  old.plugin.connectSearch();
  const broken = fakePulse({ search: { searchProviderApiVersion: 1, registerSearchProvider() { throw new Error('boom'); } } });
  broken.plugin.connectSearch();
  assert.equal(broken.plugin.offSearch, null);

  const registered = []; let removed = 0;
  const search = { searchProviderApiVersion: 1, registerSearchProvider(p) { registered.push(p); return () => removed++; } };
  const { plugin, focused } = fakePulse({ search });
  plugin.connectSearch();
  plugin.connectSearch();
  assert.equal(registered.length, 2);
  assert.equal(removed, 1, '重新注册前先撤掉上一次');
  const provider = registered[1];
  assert.equal(provider.id, 'crisp-pulse');
  assert.equal(provider.label, '速记');
  assert.equal(provider.mixed, false);
  assert.deepEqual((await provider.list()).map((e) => e.id), ['id:abc-1', 'at:4:Daily/2026-11-10.md', 'at:7:Daily/2026-11-09.md']);
  await provider.open('id:abc-1');
  assert.deepEqual(focused, [{ id: 'abc-1' }]);
  plugin.stopped = true;
  plugin.connectSearch();
  assert.equal(registered.length, 2, '停用后不再注册');
});
