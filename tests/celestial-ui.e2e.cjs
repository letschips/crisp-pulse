/* Real Obsidian acceptance: wrong manual/system theme, stale dawn/dusk after
 * focus, lighthouse collision, halo clipping, visible reset, missing motion,
 * duplicate canvases, and event/observer work after the view closes.
 * Loads the selected runtime with a local Date binding; never sets the system
 * clock, user theme, plugin settings, or vault content. Writes repeatable proof.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

async function liveProbe(config) {
  const fs = require('fs'), crypto = require('crypto');
  const p = app.plugins.plugins['crisp-pulse'];
  const leaf = app.workspace.getLeavesOfType('crisp-pulse-view')[0];
  if (!p || !leaf) throw new Error('Open Pulse in the target vault first');
  if (document.hidden) throw new Error('Restore the target Obsidian window before running visible UI acceptance');
  fs.mkdirSync(config.outDir, { recursive: true });
  const userData = app.vault.adapter.getBasePath() + '/' + app.vault.configDir + '/plugins/crisp-pulse/data.json';
  const hash = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  const before = hash(userData), rows = [];
  const source = fs.readFileSync(pathJoin(config.sourceDir, 'main.js'), 'utf8');
  let now = new Date(2026, 9, 19, 12), choice = 'system';
  class LocalDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now.getTime()])); }
    static now() { return now.getTime(); }
  }
  const hostApi = {
    Plugin: Object.getPrototypeOf(p.constructor), ItemView: Object.getPrototypeOf(p.constructor.CrispPulseView),
    Modal: Object.getPrototypeOf(p.constructor.CrispPulseEvidenceModal), TFile: app.vault.getMarkdownFiles()[0].constructor,
    PluginSettingTab: class {}, Setting: class {}, addIcon() {},
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', 'Date', source)(name => name === 'obsidian' ? hostApi : require(name), mod, mod.exports, LocalDate);
  const overlay = document.body.createDiv();
  overlay.id = 'pulse-celestial-e2e';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:var(--background-primary);padding:16px;overflow:auto';
  overlay.createDiv({ text: 'Pulse · celestial acceptance · real Obsidian DOM / local clock' });
  const stage = overlay.createDiv();
  const style = document.head.createEl('style');
  style.textContent = fs.readFileSync(pathJoin(config.sourceDir, 'styles.css'), 'utf8');
  const v = new mod.exports.CrispPulseView(leaf, p);
  v.app = Object.create(app);
  v.app.vault = Object.create(app.vault);
  v.app.vault.getConfig = key => key === 'theme' ? choice : app.vault.getConfig(key);
  const provider = Object.create(p);
  provider.app = v.app; provider.getBannerImageFile = () => null;
  v.plugin = provider;
  stage.appendChild(v.containerEl);
  v.containerEl.style.cssText = 'width:1024px;height:300px;max-width:none;position:relative';
  const root = v.containerEl.children[1];
  root.classList.add('crisp-pulse-view', 'pulse-v2');
  root.style.cssText = 'width:100%;height:100%;box-sizing:border-box';
  v.render = () => { root.empty(); v.renderBanner(root); };
  const tick = () => new Promise(r => setTimeout(r, 60));
  const check = (ok, reason) => { if (!ok) throw new Error(reason); };
  const run = async (name, fn) => {
    if (config.only && !name.includes(config.only)) return;
    try { rows.push({ name, pass: true, evidence: await fn() }); }
    catch (error) { rows.push({ name, pass: false, error: error.message }); }
  };
  const at = (h, m = 0) => { now = new Date(2026, 9, 19, h, m); };
  const finish = () => { for (const a of v.celestialEl?.getAnimations() || []) a.finish(); };
  let closed = false;
  try {
    v.load(); await v.onOpen(); await tick();
    await run('manual and system modes', async () => {
      const evidence = [];
      for (const [setting, hour, minute, want] of [
        ['moonstone', 12, 0, 'day'], ['moonstone', 0, 0, 'day'],
        ['obsidian', 12, 0, 'night'], ['obsidian', 0, 0, 'night'],
        ['system', 5, 59, 'night'], ['system', 6, 0, 'day'],
        ['system', 17, 59, 'day'], ['system', 18, 0, 'night'],
      ]) {
        choice = setting; at(hour, minute); v.updateCelestial(true); finish();
        check(v.bannerMode === want, `${setting} ${hour}:${minute}: expected ${want}, got ${v.bannerMode}`);
        check(root.querySelectorAll('.crisp-pulse-celestial').length === 1, 'More than one celestial body');
        evidence.push({ setting, hour, minute, mode: v.bannerMode });
      }
      return evidence;
    });
    await run('responsive trajectory clears lighthouse and halo', async () => {
      const evidence = [];
      for (const width of [240, 320, 390, 768, 1024]) {
        v.containerEl.style.width = `${width}px`; await tick();
        for (const [setting, hour, minute] of [['moonstone',6,0],['moonstone',12,0],['moonstone',17,59],['obsidian',18,0],['obsidian',0,0],['obsidian',5,59]]) {
          choice = setting; at(hour, minute); v.updateCelestial(true); finish();
          const b = root.querySelector('.crisp-pulse-banner').getBoundingClientRect(), c = v.celestialEl.getBoundingClientRect();
          check(c.left >= b.left - .5 && c.right <= b.right + .5 && c.top >= b.top - .5 && c.bottom <= b.bottom + .5, `${width}px ${hour}:${minute}: halo outside banner`);
          if (hour === 6 || hour === 18) check(c.left - b.left >= b.height * 1.02 + 3, `${width}px: celestial body covers lighthouse`);
          evidence.push({ width, hour, minute, x: c.x-b.x, y:c.y-b.y, size:c.width, bannerWidth:b.width, bannerHeight:b.height });
        }
      }
      return evidence;
    });
    await run('boundary reset stays invisible', async () => {
      choice = 'system'; v.containerEl.style.width = '1024px'; await tick();
      const evidence = [];
      for (const [h,m,want] of [[5,59,'night'],[6,0,'day'],[17,59,'day'],[18,0,'night']]) {
        at(h,m); v.updateCelestial(true); finish();
        check(v.bannerMode === want, 'Boundary retained previous celestial mode');
        const opacity = Number(getComputedStyle(v.celestialEl).opacity);
        if (m === 0) check(opacity <= .01, 'Reset is visible at the day/night boundary');
        evidence.push({h,m,mode:v.bannerMode,opacity});
      }
      return evidence;
    });
    await run('normal movement uses a finite transition', async () => {
      choice='system'; at(12); v.updateCelestial(true); finish();
      at(12,1); v.updateCelestial();
      const reduced = v.celestialEl.ownerDocument.defaultView.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const animations = v.celestialEl.getAnimations();
      if (!reduced) check(animations.some(a => a.effect.getKeyframes().some(k => k.transform)), 'No smooth transform movement');
      check(animations.every(a => a.effect.getTiming().iterations === 1), 'Unbounded animation');
      finish(); return {reduced, animations:animations.length};
    });
    await run('focus refreshes the sky after sleep', async () => {
      choice='system'; at(17,50); v.updateCelestial(true); finish();
      at(18,10); root.ownerDocument.defaultView.dispatchEvent(new Event('focus')); await tick(); finish();
      check(v.bannerMode === 'night', 'Wake/focus left the daytime sun visible');
      return {mode:v.bannerMode};
    });
    // Native screenshots of 320px and desktop layouts, with the same runtime.
    for (const width of [320,1024]) {
      v.containerEl.style.width=`${width}px`; choice='system'; at(6,10); v.updateCelestial(true); await tick(); finish();
      const wc=require('electron').remote.getCurrentWebContents();
      fs.writeFileSync(pathJoin(config.outDir,`banner-${width}.png`),(await wc.capturePage()).toPNG());
    }
    await run('closing stops focus updates', async () => {
      await v.onClose(); v.unload(); closed=true;
      const previous=v.celestialEl.style.cssText;
      at(22); root.ownerDocument.defaultView.dispatchEvent(new Event('focus')); await tick();
      check(v.celestialEl.style.cssText===previous,'Closed view still responds to focus');
      return {stopped:true};
    });
  } finally {
    if (!closed) { await v.onClose(); v.unload(); }
    v.containerEl.remove(); overlay.remove(); style.remove();
  }
  const after=hash(userData);
  const report={version:mod.exports.prototype ? JSON.parse(fs.readFileSync(pathJoin(config.sourceDir,'manifest.json'),'utf8')).version : p.manifest.version,
    rows,total:rows.length,passed:rows.filter(r=>r.pass).length,beforeDataHash:before,afterDataHash:after,dataUnchanged:before===after};
  fs.writeFileSync(pathJoin(config.outDir,'results.json'),JSON.stringify(report,null,2));
  return JSON.stringify(report);
  function pathJoin(a,b) { return a.replace(/\/$/,'')+'/'+b; }
}

const config={sourceDir:process.env.PULSE_SOURCE_DIR || path.resolve(__dirname,'..'),outDir:path.resolve(process.argv[2] || '/tmp/pulse-celestial-e2e'),only:process.env.PULSE_CASE || null};
const code=`(${liveProbe.toString()})(${JSON.stringify(config)})`;
const vaultArgs=process.env.PULSE_VAULT ? [`vault=${process.env.PULSE_VAULT}`] : [];
const result=spawnSync('obsidian',[...vaultArgs,'eval',`code=${code}`],{encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
try {
  if(result.error || result.status!==0) throw result.error || new Error(result.stderr || result.stdout);
  const report=JSON.parse(result.stdout.slice(result.stdout.indexOf('=> ')+3).trim());
  console.log(JSON.stringify({passed:report.passed,total:report.total,dataUnchanged:report.dataUnchanged,failures:report.rows.filter(r=>!r.pass),artifact:path.join(config.outDir,'results.json')},null,2));
  process.exitCode=report.total>0&&report.total===report.passed&&report.dataUnchanged ? 0 : 1;
} catch(error) {console.error(error.message,result.stdout);process.exitCode=1;}
