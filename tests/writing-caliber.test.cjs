// 写作口径：元数据和机器写的内容不算作者写下的字；本月节奏不拿剪藏当写作基线。
// 容易出错的地方：ANKS 速记文件的 Frontmatter 把 10 个字算成 40 多个；脑图文件底部的 JSON 每次保存都算新增；
// 上个月剪藏的一篇长文让「月底追平」变成每天几万词。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load() {
  class Plugin {}
  const el = () => ({ createEl: el, createDiv: el, createSpan: el, setAttr() {}, addEventListener() {}, style: {} });
  const context = {
    require: () => ({ Plugin, ItemView: class {}, Setting: class {}, PluginSettingTab: class {}, Notice: class {}, TFile: class {}, Modal: class {}, setIcon() {}, addIcon() {}, moment: { locale: () => 'zh-cn' } }),
    module: { exports: {} }, console, window: { setTimeout, clearTimeout, setInterval, clearInterval, localStorage: { getItem: () => 'zh' } }, document: { createElement: el }, localStorage: { getItem: () => 'zh' }, navigator: { language: 'zh-CN' },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8'), context);
  return context.module.exports;
}
const { countWritingWords, buildMonthPace } = load().dashboardHelpers;

test('Frontmatter、隐藏注释和速记的时刻行不算字数', () => {
  const memo = ['---', 'type: "raw"', 'topic: "self-media"', 'inbox_type: scratch', 'created: 2026-11-10', '---', '', '> [!memo] 11:23', '> Fable 发布了，太好用了', '<!-- crisp-pulse-memo:abc123 -->', ''].join('\n');
  assert.equal(countWritingWords(memo), countWritingWords('> Fable 发布了，太好用了'));
  // 只有开头的才是 Frontmatter；正文里的分隔线之间照常算
  assert.equal(countWritingWords('正文\n\n---\n中间两个字\n---\n'), 7);
  assert.equal(countWritingWords('---\ntitle: x\n---'), 0);
});

test('脑图文件底部的 crisp-mind 数据块不算字数，别的代码块照常算', () => {
  const mind = ['# 鱼骨图', '- 起点', '', '```crisp-mind', '{"nodes":[{"id":"n1","text":"hello world","style":{"color":"red"}}]}', '```', ''].join('\n');
  assert.equal(countWritingWords(mind), countWritingWords('# 鱼骨图\n- 起点'));
  assert.equal(countWritingWords('```js\nconst a = 1\n```'), countWritingWords('js\nconst a = 1'));
  // 没闭合的数据块（正在写盘）也不算
  assert.equal(countWritingWords('标题\n```crisp-mind\n{"a":"b c d"}'), 2);
});

test('本月节奏的新增词数不含大段捕获和系统目录，旧记录没有来源标记时按路径认', () => {
  const day = (wordsAdded, captureWords, files) => ({ quality: 'recorded', contribution: { score: 1, wordsAdded, captureWords }, activity: {}, files });
  const daily = {
    '2026-10-04': day(531000, 530000, { 'clip.md': { wordsAdded: 530700, sourceWords: { capture: 530000, unattributed: 700 } }, 'a.md': { wordsAdded: 300, sourceWords: { unattributed: 300 } } }),
    // 旧记录：没有 sourceWords，系统备份按路径剔除，捕获按当天合计剔除
    '2026-10-05': day(9000, 6000, { 'Sidecar/logs/docs-sync/backups/x.md': { wordsAdded: 2000 }, 'b.md': { wordsAdded: 7000 } }),
    '2026-11-04': day(400, 0, { 'c.md': { wordsAdded: 400, sourceWords: { unattributed: 400 } } }),
  };
  const pace = buildMonthPace(daily, '2026-11-05', () => true, 'words');
  assert.equal(pace.baselineTotal, 2000);
});
