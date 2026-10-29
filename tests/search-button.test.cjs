// Header search button: shown only when Crisp Search is enabled, and opens its panel through the command.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function element(tag = 'div', options = {}) {
  const el = { tag, options, children: [], dataset: {}, attrs: { ...(options.attr || {}) }, handlers: {}, style: {}, value: '', classList: { add() {}, remove() {} },
    setAttr(k, v) { this.attrs[k] = v; }, addEventListener(k, v) { this.handlers[k] = v; }, setText(v) { this.text = v; }, empty() { this.children = []; } };
  el.createEl = (t, o = {}) => { const child = element(t, o); el.children.push(child); return child; };
  el.createDiv = (o) => el.createEl('div', o);
  el.createSpan = (o) => el.createEl('span', o);
  return el;
}
const all = (e) => [e, ...e.children.flatMap(all)];

function loadView(enabled) {
  const icons = [];
  class Plugin {}
  const context = {
    require: () => ({ Plugin, ItemView: class {}, Setting: class {}, PluginSettingTab: class {}, Notice: class {}, TFile: class {}, Modal: class {}, setIcon: (el, id) => icons.push(id) }),
    module: { exports: {} }, console, window: { setTimeout, clearTimeout, setInterval, clearInterval }, document: { createElement: () => element() },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8'), context);
  const { CrispPulseView } = context.module.exports;
  const ran = [];
  const app = {
    plugins: { enabledPlugins: new Set(enabled ? ['crisp-search'] : []) },
    commands: { executeCommandById: (id) => { ran.push(id); return true; } },
  };
  return { CrispPulseView, app, ran, icons };
}

test('the header shows a search button only when Crisp Search is enabled, and it opens the panel', () => {
  for (const enabled of [false, true]) {
    const { CrispPulseView, app, ran } = loadView(enabled);
    assert.ok(CrispPulseView, 'CrispPulseView is exported for tests');
    const plugin = { app, refreshViews() {}, settings: {} };
    const view = Object.create(CrispPulseView.prototype);
    Object.assign(view, { app, plugin, activeViewTab: 'dashboard', currentScope: 'reliable', containerEl: { children: [null, {}] } });
    const root = element();
    view.renderSearchButton(root);
    const button = all(root).find((e) => e.attrs['aria-label'] === '搜索（Crisp Search）');
    assert.equal(!!button, enabled);
    if (!enabled) continue;
    assert.equal(button.attrs['data-tooltip-position'], 'bottom');
    button.handlers.click();
    assert.deepEqual(ran, ['crisp-search:open']);
  }
});
