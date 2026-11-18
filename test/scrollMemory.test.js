import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseAccuracyFilters, customersPage } from '../src/accuracy.js';
import { makeSession } from './helpers.js';

const NOW = new Date('2026-06-15T12:00:00Z');
const F = (over = {}) => ({ ...parseAccuracyFilters({ from: '2000-01-01', to: '2999-01-01', internal: '1', minJobs: '1' }, NOW, {}), ...over });
const q = 'from=2000-01-01&to=2999-01-01&minJobs=1';
const js = (name) => fs.readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');

describe('remembering where you were when a filter reloads the page', () => {
  let S;
  let key;
  before(async () => {
    S = await makeSession();
    key = customersPage(S.db, F({ tier: '', mgr: '' })).all.sort((a, b) => b.jobs - a.jobs)[0].key;
  });
  const urls = () => [`/accuracy/ops?${q}`, `/accuracy/customers?${q}`, `/accuracy/customers/${encodeURIComponent(key)}?${q}`];

  test('each page tells the script its sections (the same ones as the Scroll To menu) and loads it', async () => {
    for (const url of urls()) {
      const body = (await S.admin.get(url)).body;
      const attr = /<form method="get"[^>]*class="no-print acc-form" data-sections="([^"]*)"/.exec(body);
      assert.ok(attr, `${url}: the form lists its sections`);
      const menu = /scrollMenu\(\[([^\]]*)\]\)/.exec(body)[1].replace(/'/g, '').split(',');
      assert.deepEqual(attr[1].split(','), menu, `${url}: same sections as the menu`);
      assert.ok(body.includes('/static/scroll-memory.js'), `${url}: loads the script`);
      for (const id of attr[1].split(',')) assert.ok(id === 'sec-top' || body.includes(`id="${id}"`), `${url}: #${id} exists`);
    }
  });

  test('the script is served and saves before every way of reloading the same page, but not before leaving it', async () => {
    const r = await S.admin.get('/static/scroll-memory.js');
    assert.equal(r.statusCode, 200);
    const src = js('scroll-memory.js');
    for (const part of ["'submit'", "'change'", "'click'", 'form.acc-form', '.acc-pick', 'u.pathname === window.location.pathname', '!u.hash', 'sessionStorage', 'accStickySettle']) assert.ok(src.includes(part), part);
    assert.ok(js('sticky-compact.js').includes('accStickySettle'), 'the pinned block can settle without animating');
  });

  // run the real script against a tiny pretend page, to see what it saves and where it scrolls back to
  const run = ({ saved, scrollY = 0, sections = { 'sec-charts': 400, 'sec-problems': 900 }, path = '/accuracy/customers/X' } = {}) => {
    const store = new Map();
    if (saved) store.set('accScrollMemory', JSON.stringify(saved));
    const listeners = {};
    const scrolls = [];
    const win = { scrollY, innerHeight: 900, location: { pathname: path, origin: 'http://h', href: `http://h${path}` }, sessionStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) }, addEventListener: (n, f) => { (listeners[n] ??= []).push(f); }, scrollTo: (o) => { scrolls.push(o.top); win.scrollY = o.top; } };
    const els = Object.fromEntries(Object.entries(sections).map(([id, top]) => [id, { tagName: 'DIV', open: false, getBoundingClientRect: () => ({ top: top - win.scrollY }) }]));
    const doc = {
      addEventListener: (n, f) => { (listeners[n] ??= []).push(f); },
      getElementById: (id) => els[id] ?? null,
      querySelector: () => ({ getAttribute: () => ['sec-top', ...Object.keys(sections)].join(',') }),
    };
    const ctx = { window: win, document: doc, URL, Date, JSON, Math, scrollTopOffset: () => 100 };
    ctx.window.window = win;
    vm.createContext(ctx);
    vm.runInContext(js('scroll-memory.js'), ctx);
    const fire = (type, ev = {}) => (listeners[type] ?? []).forEach((f) => f(ev));
    return { store, win, scrolls, fire, doc: (listeners.DOMContentLoaded ? () => fire('DOMContentLoaded') : () => {}) };
  };
  const form = { matches: (sel) => sel === 'form.acc-form' };

  test('Apply Filters: saves the section being read and how far into it you are', () => {
    const t = run({ scrollY: 1000 }); // sec-problems starts at 900: 100px in, under the 100px edge: top is at 900-1000 = -100 against the page, edge 100
    t.fire('submit', { target: form });
    const saved = JSON.parse(t.store.get('accScrollMemory'));
    assert.equal(saved.id, 'sec-problems');
    assert.equal(saved.path, '/accuracy/customers/X');
    assert.equal(saved.delta, 900 - 1000 - 100, 'the section top is 200px above the pinned edge');
  });

  test('at the very top there is nothing to go back to', () => {
    const t = run({ scrollY: 0, sections: { 'sec-charts': 600, 'sec-problems': 1100 } });
    t.fire('submit', { target: form });
    assert.equal(t.store.has('accScrollMemory'), false);
  });

  test('the Show box and a same-page link (a date button, Month / Quarter) save too; a link to another page or an anchor does not', () => {
    const link = (href) => ({ button: 0, target: { closest: () => ({ href, target: '' }) } });
    let t = run({ scrollY: 1000 });
    t.fire('change', { target: { closest: (s) => (s === '.acc-pick' ? {} : null) } });
    assert.ok(t.store.has('accScrollMemory'), 'the Show box');
    t = run({ scrollY: 1000 });
    t.fire('click', link('/accuracy/customers/X?from=2026-01-01'));
    assert.ok(t.store.has('accScrollMemory'), 'a date button');
    t = run({ scrollY: 1000 });
    t.fire('click', link('/accuracy/ops?x=1'));
    assert.equal(t.store.has('accScrollMemory'), false, 'another page');
    t.fire('click', link('/accuracy/customers/X?x=1#drill'));
    assert.equal(t.store.has('accScrollMemory'), false, 'a link to an anchor');
  });

  test('on the way back it scrolls to the same spot (once), and ignores old or other-page memories', () => {
    const fresh = { path: '/accuracy/customers/X', id: 'sec-problems', delta: -200, open: false, at: Date.now() };
    let t = run({ saved: fresh });
    t.fire('DOMContentLoaded');
    assert.deepEqual(t.scrolls, [900 - 100 + 200], 'section top 200px above the 100px edge');
    assert.equal(t.store.has('accScrollMemory'), false, 'used once');
    t = run({ saved: { ...fresh, at: Date.now() - 120000 } });
    t.fire('DOMContentLoaded');
    assert.deepEqual(t.scrolls, [], 'too old');
    t = run({ saved: { ...fresh, path: '/accuracy/ops' } });
    t.fire('DOMContentLoaded');
    assert.deepEqual(t.scrolls, [], 'another page');
    t = run({ saved: { ...fresh, id: 'sec-gone' } });
    t.fire('DOMContentLoaded');
    assert.deepEqual(t.scrolls, [], 'a section that is no longer there');
  });
});
