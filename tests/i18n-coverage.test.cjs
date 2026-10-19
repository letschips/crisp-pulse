/* 界面文案完整性：main.js 里每处 tr(zh, en) 都要恰好两个非空参数、英文侧不含中文、两侧不相同。
   失败模式：新加的文案漏了英文、英文侧粘了中文、或者两侧抄成一样，英文界面露出中文。 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const CJK = /[㐀-鿿豈-﫿]/;

/** 从 tr( 后面读到匹配的 )，按顶层逗号切参数；跳过字符串、模板字面量和 ${} 里的内容。 */
function readArgs(start) {
  const args = [];
  let depth = 0, quote = null, cur = '';
  for (let i = start; i < SOURCE.length; i++) {
    const ch = SOURCE[i], next = SOURCE[i + 1];
    if (quote) {
      cur += ch;
      if (ch === '\\') { cur += next ?? ''; i++; continue; }
      if (quote === '`' && ch === '$' && next === '{') {
        let d = 1; cur += '{'; i += 2;
        for (; i < SOURCE.length && d > 0; i++) { const c = SOURCE[i]; cur += c; if (c === '{') d++; else if (c === '}') d--; }
        i--; continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; cur += ch; continue; }
    if ('([{'.includes(ch)) { depth++; cur += ch; continue; }
    if (')]}'.includes(ch)) {
      if (ch === ')' && depth === 0) { args.push(cur); return args; }
      depth--; cur += ch; continue;
    }
    if (ch === ',' && depth === 0) { args.push(cur); cur = ''; continue; }
    cur += ch;
  }
  return args;
}

test('每处 tr() 都有完整的中英文两侧', () => {
  let calls = 0;
  const bad = [];
  const re = /(?<![\w$.])tr\(/g;
  for (let m; (m = re.exec(SOURCE));) {
    if (SOURCE.slice(m.index - 9, m.index) === 'function ' || SOURCE.slice(m.index - 6, m.index) === 'const ') continue;
    calls++;
    const args = readArgs(m.index + 3);
    const line = SOURCE.slice(0, m.index).split('\n').length;
    if (args.length !== 2) bad.push(`${line}: ${args.length} 个参数`);
    else if (!args[0].trim() || !args[1].trim()) bad.push(`${line}: 有空参数`);
    else if (CJK.test(args[1])) bad.push(`${line}: 英文侧含中文`);
    else if (args[0].trim() === args[1].trim()) bad.push(`${line}: 两侧相同`);
  }
  assert.ok(calls > 1000, `只找到 ${calls} 处 tr()，扫描器可能失效`);
  assert.deepEqual(bad, []);
});
