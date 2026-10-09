/* 跨端对拍：Pulse 生成的 ANKS 速记采集件，交给本机 ANKS 的 Python 规范化与路由器检查。
   失败模式：插件写出的字段被 ANKS 视为不合规而改写，或路由到错误目录。
   未设置 ANKS_VAULT 或没有 Python 3.11+ 时跳过；公开仓库的测试不依赖它。 */

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// 只在显式指定本机 ANKS 库时运行：ANKS_VAULT=<库根目录> npm test
const VAULT = process.env.ANKS_VAULT || '';
const TOOLS = VAULT ? path.join(VAULT, 'Sidecar/tools') : '';

function python() {
  for (const bin of ['python3', path.join(os.homedir(), '.local/bin/python3.13'), '/opt/homebrew/bin/python3']) {
    try {
      execFileSync(bin, ['-c', 'import sys, tomllib; assert sys.version_info >= (3, 11)'], { stdio: 'ignore' });
      return bin;
    } catch (_) { /* next */ }
  }
  return null;
}

const py = TOOLS && fs.existsSync(path.join(TOOLS, 'capture-metadata/contract.json')) ? python() : null;

function loadMemo() {
  const context = {
    require: () => ({ Plugin: class {}, ItemView: class {}, PluginSettingTab: class {}, Modal: class {}, Notice: class {}, Setting: class {}, TFile: class {}, addIcon() {} }),
    module: { exports: {} }, console, Date, window: { setTimeout, clearTimeout }, document: {}, navigator: {},
    setTimeout, clearTimeout, structuredClone, crypto: globalThis.crypto, atob, TextDecoder, TextEncoder, Buffer,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8'), context);
  return context.module.exports.memoHelpers;
}

test('真实 ANKS：Pulse 速记采集件不需要规范化，且路由到 raw-scratch', { skip: !py && 'set ANKS_VAULT to a local ANKS vault (needs Python 3.11+)' }, () => {
  const memo = loadMemo();
  const contract = JSON.parse(fs.readFileSync(path.join(TOOLS, 'capture-metadata/contract.json'), 'utf8'));
  const now = new Date(2026, 9, 9, 8, 1);
  const content = memo.insertMemoBlock(
    memo.buildAnksMemoFile({ date: '2026-10-09', topic: 'self-media', contract, now }),
    memo.buildMemoBlock('第一条 #想法', now),
    '',
  );
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-memo-'));
  const rel = 'Topics/self-media/raw/inbox/scratch/2026-10-09 速记.md';
  fs.mkdirSync(path.join(tmp, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(tmp, rel), content);
  const script = `
import importlib.util, json, sys
from pathlib import Path
tools = Path(sys.argv[1]); vault = Path(sys.argv[2]); rel = sys.argv[3]
sys.path.insert(0, str(tools))
from anks_core import capture_normalize as core
spec = importlib.util.spec_from_file_location("kr", tools / "knowledge-router/knowledge_router.py")
kr = importlib.util.module_from_spec(spec); sys.modules["kr"] = kr; spec.loader.exec_module(kr)
cands, skipped, scanned = core.collect_candidates(vault)
d = kr.resolve_target(rel, vault / rel, kr.load_rules(tools / "knowledge-router/routing-rules.toml"))
print(json.dumps({"candidates": cands, "skipped": skipped, "scanned": scanned, "status": d.status, "rule": d.rule}, ensure_ascii=False))
`;
  try {
    const out = JSON.parse(execFileSync(py, ['-c', script, TOOLS, tmp, rel], { encoding: 'utf8' }));
    assert.deepEqual(out, { candidates: [], skipped: [], scanned: 1, status: 'correct', rule: 'raw-scratch' });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
