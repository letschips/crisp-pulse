// Regression: native [aria-label] tooltips must not call HTMLElement.isShown on SVG roots or targets.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function documentFixture() {
  const doc = { activeElement: null };
  function element(tag = 'div', options = {}) {
    const properties = new Map();
    const el = { tag, ownerDocument: doc, parentElement: null, children: [], attrs: { ...(options.attr || {}) },
      textContent: options.text || '', dataset: {}, handlers: {}, clientWidth: 600,
      style: { setProperty: (key, value) => properties.set(key, value), getPropertyValue: key => properties.get(key) || '' },
      setAttribute(key, value) { this.attrs[key] = String(value); if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value); },
      getAttribute(key) { return this.attrs[key] ?? null; },
      setAttr(key, value) { this.setAttribute(key, value); },
      appendChild(child) { child.parentElement = this; this.children.push(child); return child; },
      addEventListener(name, handler) { this.handlers[name] = handler; },
      focus() { doc.activeElement = this; },
    };
    el.createEl = (tag, options) => el.appendChild(element(tag, options));
    el.createDiv = options => el.createEl('div', options);
    el.createSpan = options => el.createEl('span', options);
    return el;
  }
  doc.createElement = element;
  doc.createElementNS = (_ns, tag) => element(tag);
  return doc;
}

function nativeTooltip(target) {
  for (let el = target; el; el = el.parentElement) {
    const value = el.style.getPropertyValue('--no-tooltip');
    if (value) { if (value.trim() === 'true') return; break; }
  }
  return target.isShown();
}

function viewFixture(doc) {
  const context = { module: { exports: {} }, console, document: doc,
    require: () => ({ Plugin: class {}, ItemView: class {}, Setting: class {}, PluginSettingTab: class {}, Notice: class {}, TFile: class {}, Modal: class {}, moment: { locale: () => 'en' } }),
    window: { setTimeout, clearTimeout, setInterval, clearInterval, localStorage: { getItem: () => 'en' } },
    localStorage: { getItem: () => 'en' },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8'), context);
  const view = Object.create(context.module.exports.CrispPulseView.prototype);
  view.analyticsSection = parent => parent.createDiv();
  view.renderDataTable = () => {};
  return view;
}
const all = root => [root, ...root.children.flatMap(all)];

test('the shared SVG factory preserves names and keyboard targets while suppressing inherited native tooltips', () => {
  const doc = documentFixture(), view = viewFixture(doc), parent = doc.createElement();
  const { svg, draw } = view.analyticsSvg(parent, 600, 112, 'Daily score');
  assert.equal(svg.getAttribute('aria-label'), 'Daily score');
  assert.equal(svg.getAttribute('role'), 'group');
  assert.doesNotThrow(() => nativeTooltip(svg));
  const target = draw('rect', { 'aria-label': '2026-11-13: 12 points', role: 'button', tabindex: 0, 'data-analytics-date': '2026-11-13' });
  assert.doesNotThrow(() => nativeTooltip(target));
  assert.equal(target.getAttribute('aria-label'), '2026-11-13: 12 points');
  assert.equal(target.getAttribute('tabindex'), '0');
  target.focus();
  assert.equal(doc.activeElement, target);
  assert.equal(view.analyticsSvg(parent, 44, 44).svg.getAttribute('aria-hidden'), 'true');
});

test('standalone analytics charts suppress root and day-target tooltips, retaining readouts and navigation', () => {
  const doc = documentFixture(), view = viewFixture(doc), parent = doc.createElement(), opened = [];
  view.openAnalyticsDay = date => opened.push(date);
  const points = ['2026-11-12', '2026-11-13'].map((date, i) => ({ date, status: 'included', quality: 'recorded', value: i + 2 }));
  view.renderAnalyticsChart(parent, { points, totals: { value: 5 } }, {
    title: 'Score', total: 'value', totalLabel: 'Total', type: 'bar', unit: 'pts',
    description: 'Daily points', series: [{ key: 'value', label: 'Score', color: 'blue' }],
  });
  const svg = all(parent).find(el => el.tag === 'svg');
  const targets = all(svg).filter(el => el.attrs['data-analytics-date']);
  assert.doesNotThrow(() => nativeTooltip(svg));
  assert.equal(targets.length, 2);
  targets.forEach(target => assert.doesNotThrow(() => nativeTooltip(target)));
  const readout = all(parent).find(el => el.attrs['aria-live'] === 'polite');
  targets[1].handlers.pointerenter();
  assert.ok(readout.textContent.includes('2026-11-13'));
  targets[1].handlers.keydown({ key: 'ArrowLeft', preventDefault() {} });
  assert.equal(doc.activeElement, targets[0]);
  assert.equal(targets[0].getAttribute('tabindex'), '0');
  targets[0].handlers.keydown({ key: 'Enter', preventDefault() {} });
  assert.deepEqual(opened, ['2026-11-12']);
});
