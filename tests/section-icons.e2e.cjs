/* Real Obsidian acceptance for section icons. Failure boundaries: missing or
 * clipped SVGs, a wrong icon for a section, theme/size drift, collateral icon
 * changes, persistent settings changes, and event work left behind by probes.
 * Uses isolated view instances and reads live data; never opens or edits notes.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

async function liveProbe(config) {
  const fs = require('fs'), crypto = require('crypto');
  const p = app.plugins.plugins['crisp-pulse'];
  const leaf = app.workspace.getLeavesOfType('crisp-pulse-view')[0];
  if (!p || !leaf || document.hidden) throw new Error('Open Pulse in the visible target vault first');
  const expected = {
    dashboard: ['activity', 'calendar-heatmap', 'pomodoro', 'file-text'],
    review: ['notebook-pen', 'lightbulb', 'git-compare', 'folder-tree', 'workflow-nodes', 'pen', 'scroll'],
    analytics: ['gauge', 'bar-chart', 'heatmap', 'line-chart', 'pen', 'folder-tree', 'clock', 'clock-24'],
    yearly: ['orbit', 'fingerprint', 'lunar-calendar', 'geology']
  };
  const wc = require('electron').remote.getCurrentWebContents();
  const originalClasses = document.body.className;
  const active = document.activeElement;
  const settingsBefore = JSON.stringify(p.settings);
  const dataPath = app.vault.adapter.getBasePath() + '/' + app.vault.configDir + '/plugins/crisp-pulse/data.json';
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const before = hash(dataPath);
  const rows = [];
  fs.mkdirSync(config.outDir, { recursive: true });
  const overlay = document.body.createDiv();
  overlay.id = 'pulse-section-icons-e2e';
  overlay.style.cssText = 'position:fixed;left:0;top:0;height:100vh;z-index:99999;overflow:hidden;background:var(--background-primary);display:flex';
  const style = document.head.createEl('style');
  style.textContent = '#pulse-section-icons-e2e > .workspace-leaf-content{width:100%;height:100%;display:flex;flex-direction:column} #pulse-section-icons-e2e .view-header{display:none} #pulse-section-icons-e2e > .workspace-leaf-content > .view-content{flex:1;min-height:0;width:100%;overflow:auto}';
  const tick = () => new Promise(resolve => setTimeout(resolve, 100));
  const check = (ok, why) => { if (!ok) throw new Error(why); };
  let v;
  const cleanup = () => {
    if (!v) return;
    clearInterval(v.pomodoroTicker); clearInterval(v.traceTicker);
    v.analyticsResizeObserver?.disconnect(); v.bannerResizeObserver?.disconnect();
    v.footerResizeObserver?.disconnect(); v.footerGroundResizeObserver?.disconnect();
    v.unload(); v.containerEl.remove(); v = null;
  };
  try {
    for (const theme of ['dark', 'light']) for (const width of [1024, 390]) {
      document.body.classList.toggle('theme-dark', theme === 'dark');
      document.body.classList.toggle('theme-light', theme === 'light');
      document.body.classList.toggle('is-mobile', width < 600);
      document.body.classList.toggle('is-phone', width < 600);
      document.body.classList.remove('is-translucent');
      overlay.style.width = `${width}px`;
      v = new p.constructor.CrispPulseView(leaf, p);
      overlay.appendChild(v.containerEl);
      // Keep the real plugin identity (licensing uses WeakMaps). Hide scenery
      // only on the isolated view so the capture starts at the section icons.
      v.renderBanner = () => {};
      v.renderFooter = () => {};
      for (const tab of Object.keys(expected)) {
        v.activeViewTab = tab; v.render(); await tick();
        const cards = [...v.contentEl.querySelectorAll('.pulse-v2-tray-head')];
        check(cards.length === expected[tab].length, `${tab}: unexpected card count ${cards.length}`);
        const icons = cards.map((head, i) => {
          const host = head.querySelector('.pulse-v2-tray-icon');
          const svg = host?.querySelector('svg');
          const name = expected[tab][i];
          check(svg?.classList.contains(`crisp-pulse-section-${name}`), `${tab}/${i}: expected ${name}`);
          check(svg.getAttribute('viewBox') === '0 0 100 100', `${name}: wrong host coordinate system`);
          check(!svg.querySelector('svg'), `${name}: nested SVG shrinks artwork`);
          const artwork = svg.firstElementChild;
          check(artwork?.getAttribute('transform') === 'scale(6.25)', `${name}: 16-unit artwork not normalized`);
          check(artwork.getAttribute('stroke') === 'currentColor', `${name}: fixed theme color`);
          check(host.getAttribute('aria-hidden') === 'true', `${name}: decorative icon announced`);
          check(!svg.querySelector('script,image,use,foreignObject'), `${name}: external/active SVG content`);
          const r = svg.getBoundingClientRect(), h = host.getBoundingClientRect();
          const bounds = svg.getBBox();
          check(bounds.width >= 40 && bounds.height >= 40 && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 100 && bounds.y + bounds.height <= 100, `${name}: artwork clipped or too small`);
          check(r.width === 18 && r.height === 18 && h.width === 36 && h.height === 36, `${name}: size drift`);
          check(r.left >= h.left && r.right <= h.right && r.top >= h.top && r.bottom <= h.bottom, `${name}: clipped icon`);
          const c = getComputedStyle(svg);
          return { title: head.querySelector('.pulse-v2-tray-title').textContent, name, color: c.color, strokeWidth: c.strokeWidth, width: r.width, height: r.height };
        });
        const search = v.contentEl.querySelector('.crisp-pulse-search-btn svg');
        if (search) check(search.classList.contains('lucide-search'), 'Search icon changed outside section scope');
        check(!v.contentEl.querySelector('.pulse-v2-tray-icon .lucide'), `${tab}: built-in section icon remains`);
        const screenshot = `${theme}-${width}-${tab}.png`;
        fs.writeFileSync(`${config.outDir}/${screenshot}`, (await wc.capturePage({ x: 0, y: 0, width: Math.min(width, innerWidth), height: Math.min(844, innerHeight) })).toPNG());
        rows.push({ theme, width, tab, count: cards.length, icons, screenshot });
      }
      cleanup();
    }
  } finally {
    cleanup(); overlay.remove(); style.remove(); document.body.className = originalClasses; active?.focus?.();
  }
  const initialSettings = JSON.parse(settingsBefore);
  const changedSettings = [...new Set([...Object.keys(initialSettings), ...Object.keys(p.settings)])]
    .filter(key => JSON.stringify(initialSettings[key]) !== JSON.stringify(p.settings[key]));
  check(!changedSettings.length, `Persistent settings changed: ${changedSettings.join(', ')}`);
  const after = hash(dataPath);
  check(before === after, 'data.json changed during read-only acceptance');
  const report = { version: p.manifest.version, rows, checkedIcons: rows.reduce((n, row) => n + row.count, 0), dataUnchanged: before === after, beforeDataHash: before, afterDataHash: after };
  fs.writeFileSync(`${config.outDir}/results.json`, JSON.stringify(report, null, 2));
  return JSON.stringify(report);
}

const outDir = path.resolve(process.argv[2] || '/tmp/pulse-section-icons-e2e');
if (!process.env.PULSE_VAULT) throw new Error('Set PULSE_VAULT to the visible vault where Pulse is open');
const result = spawnSync('obsidian', [`vault=${process.env.PULSE_VAULT}`, 'eval', `code=(${liveProbe.toString()})(${JSON.stringify({ outDir })})`], { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
try {
  if (result.error || result.status !== 0) throw result.error || new Error(result.stderr || result.stdout);
  const report = JSON.parse(result.stdout.slice(result.stdout.indexOf('=> ') + 3).trim());
  console.log(JSON.stringify({ cases: report.rows.length, checkedIcons: report.checkedIcons, dataUnchanged: report.dataUnchanged, artifact: `${outDir}/results.json` }, null, 2));
} catch (error) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(`${outDir}/failure.json`, JSON.stringify({ error: error.message, stdout: result.stdout, stderr: result.stderr }, null, 2));
  console.error(error.message, result.stdout); process.exitCode = 1;
}
