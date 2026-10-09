/* 速记（flomo 式）测试：纯函数 + 内存假 vault 上的 MemoStore 全链路。
   每条测试对应一个会丢数据、写错位置或统计错误的失败模式。 */

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function load() {
  class Plugin { registerEvent() {} registerInterval() {} addCommand() {} }
  class TFile { constructor(p, content = '') { this.path = p; this.content = content; this.extension = p.split('.').pop(); this.basename = p.split('/').pop().replace(/\.md$/, ''); this.stat = { mtime: 0 }; } }
  class Setting { setName() { return this; } setDesc() { return this; } addDropdown() { return this; } addToggle() { return this; } addText() { return this; } addButton() { return this; } }
  const context = {
    require: () => ({ Plugin, TFile, Setting, ItemView: class {}, PluginSettingTab: class {}, Notice: class { constructor(m) { context.lastNotice = m; } }, Modal: class { open() {} close() {} }, addIcon() {} }),
    module: { exports: {} }, console, Date, window: { setInterval, clearInterval, setTimeout, clearTimeout },
    document: { hidden: false }, navigator: { clipboard: { writeText: async () => {} } },
    setTimeout, clearTimeout, structuredClone, crypto: globalThis.crypto, atob, TextDecoder, TextEncoder, Buffer,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8'), context);
  return { memo: context.module.exports.memoHelpers, TFile, context };
}

const { memo, TFile } = load();
// vm 里创建的数组/对象原型不同，比较前转成本 realm 的普通值
const plain = (x) => JSON.parse(JSON.stringify(x));

/* ---------- 内存假 vault ---------- */
function fakeApp({ files = {}, frontmatter = {}, adapterFiles = {}, dailyOptions = { folder: 'Daily', format: 'YYYY-MM-DD' } } = {}) {
  const store = new Map(Object.entries(files).map(([p, c]) => [p, new TFile(p, c)]));
  const folders = new Set();
  const app = {
    vault: {
      getAbstractFileByPath: (p) => store.get(p) || (folders.has(p) ? { path: p, children: [] } : null),
      getMarkdownFiles: () => [...store.values()].filter((f) => f.extension === 'md'),
      cachedRead: async (f) => f.content,
      read: async (f) => f.content,
      create: async (p, c) => { if (store.has(p)) throw new Error('File already exists.'); const f = new TFile(p, c); store.set(p, f); return f; },
      createFolder: async (p) => { folders.add(p); },
      process: async (f, fn) => { f.content = fn(f.content); return f.content; },
      adapter: {
        exists: async (p) => p in adapterFiles || store.has(p),
        read: async (p) => adapterFiles[p] ?? store.get(p)?.content,
      },
    },
    metadataCache: { getFileCache: (f) => ({ frontmatter: frontmatter[f.path] || parseFm(f.content) }) },
    internalPlugins: { getPluginById: (id) => (id === 'daily-notes' ? { enabled: true, instance: { options: dailyOptions } } : null) },
    fileManager: { getNewFileParent: () => ({ path: '' }) },
  };
  return { app, store, folders };
}

function parseFm(content) {
  const m = /^---\n([\s\S]*?)\n---/.exec(content || '');
  if (!m) return undefined;
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_]+):\s*"?(.*?)"?$/.exec(line);
    if (kv) out[kv[1]] = kv[2];
  }
  return out;
}

const D = (y, mo, d, h = 9, mi = 0) => new Date(y, mo - 1, d, h, mi);

/* ---------- 纯函数 ---------- */

test('速记块：多行文本逐行加引用前缀，空行保留为 >，时间取本地 HH:MM', () => {
  assert.equal(
    memo.buildMemoBlock('第一行\r\n\r\n第三行  ', D(2026, 10, 9, 7, 5)),
    '> [!memo] 07:05\n> 第一行\n>\n> 第三行',
  );
});

test('解析：只认 [!memo] 块，正文、标签、转化链接、行号都正确', () => {
  const content = [
    '# 2026-10-09', '', '> [!note] 不是速记', '> 跳过', '',
    '> [!memo] 22:04', '> 读完 #读书/方法 第三章', '> 下一句', '> → [[卡片笔记法]]', '',
    '> [!memo] 08:30', '> 早上想法 #想法 #想法 和 a#b',
  ].join('\n');
  const list = memo.parseMemoBlocks(content);
  assert.equal(list.length, 2);
  assert.deepEqual(
    plain({ time: list[0].time, text: list[0].text, tags: list[0].tags, links: list[0].links, start: list[0].startLine, end: list[0].endLine }),
    { time: '22:04', text: '读完 #读书/方法 第三章\n下一句', tags: ['读书/方法'], links: ['卡片笔记法'], start: 5, end: 8 },
  );
  assert.deepEqual(plain(list[1].tags), ['想法']);
});

test('标签：URL 锚点、纯数字、行内代码里的 # 不算标签', () => {
  assert.deepEqual(plain(memo.extractMemoTags('看 https://a.com/#x 和 #2026 和 `#code` 还有 #工作')), ['工作']);
});

test('插入：有同名段落标题时插到该段末尾、下一个同级标题之前', () => {
  const content = '# 日记\n\n## 速记\n\n> [!memo] 08:00\n> 旧\n\n## 今日总结\n\n写点什么\n';
  const out = memo.insertMemoBlock(content, '> [!memo] 09:00\n> 新', '## 速记');
  assert.equal(out, '# 日记\n\n## 速记\n\n> [!memo] 08:00\n> 旧\n\n> [!memo] 09:00\n> 新\n\n## 今日总结\n\n写点什么\n');
});

test('插入：没有段落标题时在文末补标题；标题设为空时直接追加到文末', () => {
  assert.equal(memo.insertMemoBlock('正文', '> [!memo] 09:00\n> 新', '## 速记'), '正文\n\n## 速记\n\n> [!memo] 09:00\n> 新\n');
  assert.equal(memo.insertMemoBlock('正文\n', '> [!memo] 09:00\n> 新', ''), '正文\n\n> [!memo] 09:00\n> 新\n');
  assert.equal(memo.insertMemoBlock('', '> [!memo] 09:00\n> 新', ''), '> [!memo] 09:00\n> 新\n');
});

test('删除：只删这一块和一个相邻空行；文件已被改动时拒绝删除', () => {
  const content = 'A\n\n> [!memo] 08:00\n> 一\n\n> [!memo] 09:00\n> 二\n';
  const [first] = memo.parseMemoBlocks(content);
  assert.equal(memo.removeMemoBlock(content, first), 'A\n\n> [!memo] 09:00\n> 二\n');
  const edited = content.replace('> 一', '> 一（改）');
  assert.throws(() => memo.removeMemoBlock(edited, first), /已被修改/);
});

test('转化回链：在块末尾追加 → [[链接]]，不改动正文', () => {
  const content = '> [!memo] 08:00\n> 一\n\n后文';
  const [m] = memo.parseMemoBlocks(content);
  assert.equal(memo.appendMemoLink(content, m, '新笔记'), '> [!memo] 08:00\n> 一\n> → [[新笔记]]\n\n后文');
});

test('统计：近 12 周总数、本月、连续天数（今天还没记时从昨天算起）', () => {
  const mk = (date, n = 1) => Array.from({ length: n }, () => ({ date }));
  const memos = [...mk('2026-10-08', 2), ...mk('2026-10-07'), ...mk('2026-10-05'), ...mk('2026-09-30'), ...mk('2026-06-01')];
  const s = memo.memoStats(memos, '2026-10-09', { weeks: 12, weekStartsOn: 'monday' });
  assert.equal(s.streak, 2);
  assert.equal(s.month, 4);
  assert.equal(s.recent, 5);
  assert.equal(s.cells.length, 84);
  assert.equal(s.cells[s.cells.length - 1].date, '2026-10-11'); // 周日结束的整周
  assert.equal(s.cells.find((c) => c.date === '2026-10-08').count, 2);
  assert.equal(memo.memoStats([{ date: '2026-10-09' }, ...memos], '2026-10-09').streak, 3);
});

test('日笔记路径：按日记插件的文件夹与格式拼路径，支持子目录格式', () => {
  assert.equal(memo.dailyNotePath(D(2026, 10, 9), { folder: 'Daily/', format: 'YYYY-MM-DD' }), 'Daily/2026-10-09.md');
  assert.equal(memo.dailyNotePath(D(2026, 1, 5), { folder: '', format: 'YYYY/MM/YYYYMMDD' }), '2026/01/20260105.md');
  assert.equal(memo.dailyDateFromPath('Daily/2026-10-09.md', { folder: 'Daily', format: 'YYYY-MM-DD' }), '2026-10-09');
  assert.equal(memo.dailyDateFromPath('Daily/notes.md', { folder: 'Daily', format: 'YYYY-MM-DD' }), null);
});

test('ANKS 采集件：字段来自采集合约，能被 raw-scratch 规则路由', () => {
  const file = memo.buildAnksMemoFile({
    date: '2026-10-09', topic: 'self-media', now: D(2026, 10, 9, 8, 0),
    contract: { contract: 'anks-capture-v2', routing: { 'pulse-memo': { inbox_type: 'scratch' } } },
  });
  assert.match(file, /^---\nid: "RAW-20261009-MEMO-[0-9A-F]{4}"\ntype: raw\ntopic: "self-media"\nowner: "topic:self-media"\ncapture_type: pulse-memo\ncapture_contract: anks-capture-v2\n/);
  assert.match(file, /inbox_type: scratch\n/);
  assert.match(file, /memo_date: "2026-10-09"\n/);
  assert.match(file, /\n# 2026-10-09 速记\n$/);
  assert.throws(() => memo.buildAnksMemoFile({ date: '2026-10-09', topic: 'self-media', contract: { contract: 'anks-capture-v2', routing: {} } }), /pulse-memo/);
});

/* ---------- MemoStore 全链路（内存假 vault） ---------- */

test('通用模式：记录追加到当天日笔记的速记段落；当天日笔记不存在时新建', async () => {
  const { app, store } = fakeApp({ files: { 'Daily/2026-10-08.md': '# 8 号\n' } });
  const s = new memo.MemoStore(app, () => ({ memoMode: 'general', memoHeading: '## 速记' }));
  await s.capture('第一条 #想法', D(2026, 10, 9, 8, 1));
  await s.capture('第二条', D(2026, 10, 9, 9, 2));
  assert.equal(store.get('Daily/2026-10-09.md').content, '## 速记\n\n> [!memo] 08:01\n> 第一条 #想法\n\n> [!memo] 09:02\n> 第二条\n');
  const list = await s.list();
  assert.deepEqual(plain(list.map((m) => [m.date, m.time, m.text])), [['2026-10-09', '09:02', '第二条'], ['2026-10-09', '08:01', '第一条 #想法']]);
  assert.equal(list[0].path, 'Daily/2026-10-09.md');
});

test('通用模式：空白内容不写入', async () => {
  const { app, store } = fakeApp();
  const s = new memo.MemoStore(app, () => ({ memoMode: 'general', memoHeading: '## 速记' }));
  await assert.rejects(() => s.capture('   \n ', D(2026, 10, 9)), /空/);
  assert.equal(store.size, 0);
});

test('ANKS 模式：写到 Topic 的 raw/inbox/scratch 每日采集件，第二条追加到同一文件', async () => {
  const adapterFiles = {
    'Sidecar/bin/anks': '#!/bin/sh',
    'Sidecar/tools/capture-metadata/contract.json': JSON.stringify({ contract: 'anks-capture-v2', routing: { 'pulse-memo': { inbox_type: 'scratch' } } }),
  };
  const { app, store } = fakeApp({ adapterFiles });
  const s = new memo.MemoStore(app, () => ({ memoMode: 'anks', memoAnksTopic: 'self-media', memoHeading: '## 速记' }));
  await s.capture('一', D(2026, 10, 9, 8, 0));
  await s.capture('二', D(2026, 10, 9, 8, 30));
  const p = 'Topics/self-media/raw/inbox/scratch/2026-10-09 速记.md';
  assert.ok(store.has(p));
  assert.equal(memo.parseMemoBlocks(store.get(p).content).length, 2);
  const list = await s.list();
  assert.deepEqual(plain(list.map((m) => m.text)), ['二', '一']);
});

test('ANKS 模式：采集合约缺少 pulse-memo 时拒绝写入，不猜字段', async () => {
  const adapterFiles = { 'Sidecar/bin/anks': '', 'Sidecar/tools/capture-metadata/contract.json': JSON.stringify({ contract: 'anks-capture-v2', routing: {} }) };
  const { app, store } = fakeApp({ adapterFiles });
  const s = new memo.MemoStore(app, () => ({ memoMode: 'anks', memoAnksTopic: 'self-media' }));
  await assert.rejects(() => s.capture('一', D(2026, 10, 9)), /pulse-memo/);
  assert.equal(store.size, 0);
});

test('ANKS 模式：库里有多个 Topic 且没选时拒绝写入，不替用户挑 Topic', async () => {
  const adapterFiles = { 'Sidecar/bin/anks': '', 'Sidecar/tools/capture-metadata/contract.json': JSON.stringify({ contract: 'anks-capture-v2', routing: { 'pulse-memo': { inbox_type: 'scratch' } } }) };
  const files = { 'Topics/main-business/README.md': '', 'Topics/self-media/README.md': '' };
  const { app, store } = fakeApp({ files, adapterFiles });
  const s = new memo.MemoStore(app, () => ({ memoMode: 'anks', memoAnksTopic: '' }));
  await assert.rejects(() => s.capture('一', D(2026, 10, 9)), /选择/);
  assert.equal(store.size, 2);
  const single = fakeApp({ files: { 'Topics/self-media/README.md': '' }, adapterFiles });
  await new memo.MemoStore(single.app, () => ({ memoMode: 'anks' })).capture('一', D(2026, 10, 9));
  assert.ok(single.store.has('Topics/self-media/raw/inbox/scratch/2026-10-09 速记.md'));
});

test('自动模式：有 Sidecar/bin/anks 且有 Topic 时走 ANKS，否则走日笔记', async () => {
  const anks = fakeApp({ files: { 'Topics/self-media/README.md': '' }, adapterFiles: { 'Sidecar/bin/anks': '' } });
  assert.equal(await new memo.MemoStore(anks.app, () => ({ memoMode: 'auto' })).resolveMode(), 'anks');
  const plain = fakeApp();
  assert.equal(await new memo.MemoStore(plain.app, () => ({ memoMode: 'auto' })).resolveMode(), 'general');
});

test('列表同时收录日笔记和带 memo_date 的采集件（切换模式后旧速记不丢）', async () => {
  const { app } = fakeApp({
    files: {
      'Daily/2026-10-08.md': '> [!memo] 10:00\n> 日记里的\n',
      'Topics/self-media/raw/articles/2026-10-07 速记.md': '---\nmemo_date: "2026-10-07"\n---\n> [!memo] 11:00\n> 已被路由走的\n',
      'Notes/普通.md': '> [!memo] 12:00\n> 不在来源范围\n',
    },
  });
  const s = new memo.MemoStore(app, () => ({ memoMode: 'general' }));
  assert.deepEqual(plain((await s.list()).map((m) => m.text)), ['日记里的', '已被路由走的']);
});

test('删除与回链在真实文件上执行，且以文件当前内容为准', async () => {
  const { app, store } = fakeApp({ files: { 'Daily/2026-10-09.md': '> [!memo] 08:00\n> 一\n\n> [!memo] 09:00\n> 二\n' } });
  const s = new memo.MemoStore(app, () => ({ memoMode: 'general' }));
  const [second, first] = await s.list();
  await s.linkBack(first, '新笔记');
  await s.remove(second);
  assert.equal(store.get('Daily/2026-10-09.md').content, '> [!memo] 08:00\n> 一\n> → [[新笔记]]\n');
});

test('随机回顾：从列表里取一条，空列表返回 null', () => {
  assert.equal(memo.pickRandomMemo([], () => 0.5), null);
  assert.equal(memo.pickRandomMemo([{ text: 'a' }, { text: 'b' }], () => 0.99).text, 'b');
});

/* ---------- flomo 核心：回顾、搜索筛选、标签树、URL 入口（均不依赖 ANKS） ---------- */

const M = (date, time, text, extra = {}) => ({ date, time, text, tags: memo.extractMemoTags(text), links: [], path: `Daily/${date}.md`, startLine: 0, raw: `> [!memo] ${time}\n> ${text}`, ...extra });

test('筛选：多关键词同时命中、标签含子标签、排除标签、无标签、日期范围、是否已转化', () => {
  const list = [
    M('2026-10-01', '09:00', '读书 卡片笔记法 #阅读/方法'),
    M('2026-10-02', '09:00', '写周报 #工作'),
    M('2026-10-03', '09:00', '随手一句没有标签'),
    M('2026-10-04', '09:00', '卡片 盒子 #阅读', { links: ['新笔记'] }),
  ];
  const texts = (f) => plain(memo.filterMemos(list, f).map((m) => m.date));
  assert.deepEqual(texts({ query: '卡片 笔记' }), ['2026-10-01']);
  assert.deepEqual(texts({ includeTags: ['阅读'] }), ['2026-10-01', '2026-10-04']);
  assert.deepEqual(texts({ includeTags: ['阅读'], excludeTags: ['阅读/方法'] }), ['2026-10-04']);
  assert.deepEqual(texts({ untagged: true }), ['2026-10-03']);
  assert.deepEqual(texts({ from: '2026-10-02', to: '2026-10-03' }), ['2026-10-02', '2026-10-03']);
  assert.deepEqual(texts({ converted: true }), ['2026-10-04']);
  assert.deepEqual(texts({ converted: false, query: '卡片' }), ['2026-10-01']);
  assert.deepEqual(texts({ query: 'READ' }), []);
  assert.equal(memo.filterMemos(list, {}).length, 4);
});

test('标签树：按层级折叠，计数含子标签，按条数排序', () => {
  const list = [M('2026-10-01', '09:00', '#阅读/方法 #阅读/方法/卡片'), M('2026-10-02', '09:00', '#阅读'), M('2026-10-03', '09:00', '#工作'), M('2026-10-04', '09:00', '#阅读/书单')];
  const tree = plain(memo.buildTagTree(list));
  assert.deepEqual(tree.map((n) => [n.path, n.count]), [['阅读', 3], ['工作', 1]]);
  const reading = tree[0];
  assert.deepEqual(reading.children.map((n) => [n.path, n.count]), [['阅读/方法', 1], ['阅读/书单', 1]]);
  assert.deepEqual(reading.children[0].children.map((n) => [n.name, n.count]), [['卡片', 1]]);
});

test('标签改名：只换整段标签和它的子标签，不误伤相似前缀、URL 和代码', () => {
  const r = (t) => memo.renameTagInText(t, '阅读', '读书');
  assert.equal(r('#阅读 和 #阅读/方法 还有 #阅读器'), '#读书 和 #读书/方法 还有 #阅读器');
  assert.equal(r('见 https://x.com/#阅读 与 `#阅读`'), '见 https://x.com/#阅读 与 `#阅读`');
  assert.equal(r('结尾#阅读'), '结尾#阅读');
  assert.equal(r('#阅读，好'), '#读书，好');
});

test('标签改名落到文件：只改写速记块，日笔记其他段落的同名标签不动', () => {
  const content = '# 日记 #阅读\n\n正文 #阅读\n\n## 速记\n\n> [!memo] 08:00\n> 一 #阅读/方法\n> → [[卡片 #阅读]]\n\n> [!memo] 09:00\n> 二 没标签\n';
  const out = memo.renameTagInContent(content, '阅读', '读书');
  assert.equal(out.changed, 1);
  assert.equal(out.content, content.replace('> 一 #阅读/方法', '> 一 #读书/方法'));
});

test('标签改名：新名字非法（空、含空格或 #）时拒绝', () => {
  for (const bad of ['', '读 书', '#读书', '读书#']) assert.throws(() => memo.renameTagInText('#阅读', '阅读', bad), /标签名/);
});

test('MemoStore.renameTag：跨多个文件改写并返回受影响条数；不依赖 ANKS', async () => {
  const { app, store } = fakeApp({ files: {
    'Daily/2026-10-08.md': '> [!memo] 08:00\n> a #阅读\n',
    'Daily/2026-10-09.md': '正文 #阅读\n\n> [!memo] 09:00\n> b #阅读/方法\n\n> [!memo] 10:00\n> c #工作\n',
  } });
  const s = new memo.MemoStore(app, () => ({ memoMode: 'general' }));
  const preview = await s.previewTagRename('阅读');
  assert.deepEqual(plain(preview), { memos: 2, files: 2 });
  const result = await s.renameTag('阅读', '读书');
  assert.deepEqual(plain(result), { memos: 2, files: 2 });
  assert.equal(store.get('Daily/2026-10-08.md').content, '> [!memo] 08:00\n> a #读书\n');
  assert.equal(store.get('Daily/2026-10-09.md').content, '正文 #阅读\n\n> [!memo] 09:00\n> b #读书/方法\n\n> [!memo] 10:00\n> c #工作\n');
});

test('每日回顾：同一天结果稳定、换一天会变；排除今天；按标签（含子标签）和时间范围、条数筛选', () => {
  const list = [];
  for (let d = 1; d <= 30; d++) list.push(M(`2026-09-${String(d).padStart(2, '0')}`, '09:00', `第 ${d} 条 ${d % 3 ? '#阅读/方法' : '#工作'}`));
  list.push(M('2026-10-09', '08:00', '今天写的 #阅读'));
  const opts = { count: 6 };
  const a = plain(memo.selectDailyReview(list, '2026-10-09', opts).map((m) => m.date));
  const b = plain(memo.selectDailyReview(list, '2026-10-09', opts).map((m) => m.date));
  const other = plain(memo.selectDailyReview(list, '2026-10-10', opts).map((m) => m.date));
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, other);
  assert.equal(a.length, 6);
  assert.ok(!a.includes('2026-10-09'));
  const work = memo.selectDailyReview(list, '2026-10-09', { count: 24, tags: ['工作'] });
  assert.equal(work.length, 10);
  assert.ok(work.every((m) => m.tags.includes('工作')));
  const reading = memo.selectDailyReview(list, '2026-10-09', { count: 24, tags: ['阅读'] });
  assert.equal(reading.length, 20);
  const recent = memo.selectDailyReview(list, '2026-10-09', { count: 24, withinDays: 15 });
  assert.ok(recent.every((m) => m.date >= '2026-09-24'));
  const batch2 = plain(memo.selectDailyReview(list, '2026-10-09', { count: 6, batch: 1 }).map((m) => m.date));
  assert.notDeepEqual(a, batch2);
  assert.equal(memo.selectDailyReview(list, '2026-10-09', { count: 99 }).length, 24); // 上限 24
});

test('去年今日：按年分组列出往年同月同日，另给上月今日', () => {
  const list = [M('2025-10-09', '09:00', '去年'), M('2024-10-09', '09:00', '前年'), M('2026-09-09', '09:00', '上月'), M('2025-10-08', '09:00', '不是同一天'), M('2026-10-09', '09:00', '今天')];
  const groups = plain(memo.onThisDay(list, '2026-10-09').map((g) => [g.label, g.memos.map((m) => m.text)]));
  assert.deepEqual(groups, [['上月今日', ['上月']], ['1 年前', ['去年']], ['2 年前', ['前年']]]);
  // 3 月 31 日没有对应的上月同日，不硬凑
  assert.deepEqual(plain(memo.onThisDay([M('2026-02-28', '09:00', 'x')], '2026-03-31')), []);
});

test('URL 入口：解析 text/tags/open 参数，空内容只打开视图', () => {
  assert.deepEqual(plain(memo.parseMemoUrlParams({ action: 'crisp-pulse-memo', vault: 'X', text: '想法', tags: '阅读, 工作' })), { text: '想法 #阅读 #工作', open: false });
  assert.deepEqual(plain(memo.parseMemoUrlParams({ text: '已有 #阅读', tags: '阅读' })), { text: '已有 #阅读', open: false });
  assert.deepEqual(plain(memo.parseMemoUrlParams({ text: '  ', open: '1' })), { text: '', open: true });
  assert.deepEqual(plain(memo.parseMemoUrlParams({})), { text: '', open: true });
});

/* ---------- 相关笔记与随机漫步（纯本地，不接 AI，不依赖 ANKS） ---------- */

test('分词：中文按双字、英文按词，标签单独计入并展开父级', () => {
  const t = plain(memo.tokenizeMemo({ text: '卡片笔记 Zettelkasten method #阅读/方法', tags: ['阅读/方法'] }));
  assert.ok(t.includes('卡片') && t.includes('片笔') && t.includes('笔记'));
  assert.ok(t.includes('zettelkasten') && t.includes('method'));
  assert.ok(t.includes('#阅读') && t.includes('#阅读/方法'));
  assert.ok(!t.includes('阅读/方法'), '标签文字不重复计入正文');
});

test('相关笔记：按相似度排序、不含自己、给出共同词，低于阈值的不推荐', () => {
  const list = [
    M('2026-10-01', '09:00', '卡片笔记写作法：每张卡片只写一个想法 #阅读'),
    M('2026-10-02', '09:00', '卡片盒里的想法要能互相链接 #阅读'),
    M('2026-10-03', '09:00', '周报改成倒叙写法 #工作'),
    M('2026-10-04', '09:00', '今天天气不错'),
  ];
  const index = memo.buildMemoIndex(list);
  const rel = memo.relatedMemos(list[0], index, { limit: 5 });
  assert.equal(rel[0].memo.date, '2026-10-02');
  assert.ok(rel.every((r) => r.memo !== list[0]));
  assert.ok(rel[0].shared.includes('卡片') || rel[0].shared.includes('#阅读'));
  assert.ok(!rel.some((r) => r.memo.date === '2026-10-04'), '无关内容不推荐');
  for (let i = 1; i < rel.length; i++) assert.ok(rel[i - 1].score >= rel[i].score);
  const solo = memo.buildMemoIndex([list[3]]);
  assert.deepEqual(plain(memo.relatedMemos(solo.memos[0], solo)), []);
});

test('随机漫步：优先走到未访问的相关速记；无路可走时随机跳到未访问的；都走过返回 null', () => {
  const list = [
    M('2026-10-01', '09:00', '卡片笔记写作法 #阅读'),
    M('2026-10-02', '09:00', '卡片笔记的链接 #阅读'),
    M('2026-10-03', '09:00', '完全无关的一句话 天气'),
  ];
  const index = memo.buildMemoIndex(list);
  const step1 = memo.walkStep(list[0], index, new Set([list[0]]), () => 0);
  assert.equal(step1.memo, list[1]);
  assert.equal(step1.via, 'related');
  const step2 = memo.walkStep(list[1], index, new Set([list[0], list[1]]), () => 0);
  assert.equal(step2.memo, list[2]);
  assert.equal(step2.via, 'random');
  assert.equal(memo.walkStep(list[2], index, new Set(list), () => 0), null);
});

test('相关理由：相连的中文双字拼回完整片段，标签和英文词保留，最多 3 个', () => {
  const m = M('2026-10-01', '09:00', '卡片笔记写作法 Zettelkasten 方法 #阅读');
  assert.deepEqual(plain(memo.explainShared(m, ['卡片', '片笔', '笔记', '#阅读', 'zettelkasten'])), ['卡片笔记', '#阅读', 'zettelkasten']);
  assert.deepEqual(plain(memo.explainShared(m, ['方法'])), ['方法']);
  assert.deepEqual(plain(memo.explainShared(m, [])), []);
});

test('速记热力图按条数分深浅：零星几条是浅色，记得多才变深，不因只有一天数据就满格', () => {
  const level = memo.memoHeatLevel;
  assert.equal(level(0, 1), 0);
  assert.equal(level(1, 1), 1, '只有一天、一条时不能直接最深');
  assert.ok(level(2, 8) < level(8, 8));
  const levels = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => level(n, 8));
  assert.deepEqual(levels, [...levels].sort((a, b) => a - b), '条数越多颜色不能变浅');
  assert.equal(level(8, 8), 4);
  assert.equal(level(1, 40), 1);
  assert.equal(level(40, 40), 4);
  assert.ok(level(12, 40) >= 2, '重度用户的中等日子也要有中间档');
});
