import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { parseAccuracyFilters, DEFAULT_DAYS } from '../src/accuracy.js';
import { makeSession } from './helpers.js';

const NOW = new Date('2026-06-15T12:00:00Z');

describe('the pages open on the last 90 days', () => {
  test('Ops & Materials and Customers', () => {
    assert.equal(DEFAULT_DAYS, 90);
    const f = parseAccuracyFilters({}, NOW, {});
    assert.equal(f.from, '2026-03-17');
    assert.equal(f.to, '2026-06-15');
    assert.equal(parseAccuracyFilters({ from: '2026-01-01' }, NOW, {}).from, '2026-01-01', 'a chosen date still wins');
  });

  test('the Last 90 days button is the highlighted one on all three pages', async () => {
    const S = await makeSession();
    for (const path of ['/', '/accuracy/ops', '/accuracy/customers']) {
      const body = (await S.admin.get(path)).body;
      assert.match(body, /<a class="btn btn-sm btn-primary" href="[^"]+">Last 90 days<\/a>/, path);
      assert.ok(!/<a class="btn btn-sm btn-primary" href="[^"]+">Last (30 days|12 months)<\/a>/.test(body), path);
    }
  });
});

describe('the Customers page opens sorted by Margin vs Target $, Low to High', () => {
  test('only on the Customers page: everywhere else it is Net Var $, High to Low', () => {
    const c = parseAccuracyFilters({}, NOW, {}, { customers: true });
    assert.equal(c.sort, 'vstarget');
    assert.equal(c.order, 'asc');
    const o = parseAccuracyFilters({}, NOW, {});
    assert.equal(o.sort, 'netvar');
    assert.equal(o.order, 'desc');
  });

  test('a choice made in the address always wins', () => {
    const c = parseAccuracyFilters({ sort: 'marginpct', order: 'desc' }, NOW, {}, { customers: true });
    assert.equal(c.sort, 'marginpct');
    assert.equal(c.order, 'desc');
    assert.equal(parseAccuracyFilters({ sort: 'attention' }, NOW, {}, { customers: true }).order, 'asc', 'only the sort given: the order is still the Customers default');
  });
});

describe('the filter row', () => {
  let S;
  const q = 'from=2000-01-01&to=2999-01-01&minJobs=1';
  before(async () => { S = await makeSession(); });

  /** The names of the filter boxes in the order they appear, with where the divider is. */
  const row = (body) => {
    const block = body.slice(body.indexOf('<div class="filters">'), body.indexOf('<div class="filter-actions">'));
    const names = [];
    const sep = block.indexOf('class="filter-sep"');
    let sepAfter = null;
    for (const m of block.matchAll(/<(?:input|select)[^>]*name="([A-Za-z]+)"[^>]*>/g)) {
      if (/type="hidden"/.test(m[0])) continue;
      if (m.index > sep && sepAfter === null && sep >= 0) sepAfter = names[names.length - 1];
      if (!names.includes(m[1])) names.push(m[1]);
    }
    return { names, sepAfter };
  };

  test('Customers: Tier, Account Manager, Jobs, Variance Basis, Minimum Jobs, Other Options | Show, Sort Lists By, Sort Order, Trend By', async () => {
    const { names, sepAfter } = row((await S.admin.get(`/accuracy/customers?${q}`)).body);
    // (Tier is a list of tick boxes and Other Options a list of two, so each appears under its own field name)
    assert.deepEqual(names, ['tier', 'mgr', 'status', 'basis', 'minJobs', 'outliers', 'internal', 'top', 'sort', 'order', 'trend']);
    assert.equal(sepAfter, 'internal', 'the divider comes after Other Options');
  });

  test('Ops & Materials has the same first group and Sort / Trend, then its two grouping choices', async () => {
    const { names, sepAfter } = row((await S.admin.get(`/accuracy/ops?${q}`)).body);
    assert.deepEqual(names, ['tier', 'mgr', 'status', 'basis', 'minJobs', 'outliers', 'internal', 'sort', 'order', 'trend', 'opBy', 'mtlBy']);
    assert.equal(sepAfter, 'internal');
  });

  test('the labels are in that order too', async () => {
    const body = (await S.admin.get(`/accuracy/customers?${q}`)).body;
    const block = body.slice(body.indexOf('<div class="filters">'), body.indexOf('<div class="filter-actions">'));
    const labels = ['Tier', 'Account Manager', 'Jobs', 'Variance Basis', 'Minimum Jobs', 'Other Options', 'Show', 'Sort Lists By', 'Sort Order', 'Trend By'];
    const at = labels.map((l) => block.search(new RegExp(`(?:<label[^>]*>|multi-field">)${l}\\s`)));
    assert.ok(at.every((i) => i >= 0), `all found: ${at}`);
    assert.deepEqual([...at].sort((a, b) => a - b), at, 'in the order asked for');
  });

  test('Exclude Outliers and Include Internal / Stock Jobs are in an Other Options dropdown, not loose in the row', async () => {
    const body = (await S.admin.get(`/accuracy/customers?${q}`)).body;
    const block = body.slice(body.indexOf('<div class="filters">'), body.indexOf('<div class="filter-actions">'));
    const menu = /Other Options[\s\S]*?<div class="multi-menu"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/.exec(block)?.[1] ?? '';
    assert.ok(menu.includes('Exclude Outliers (Over ±300%)') && menu.includes('Include Internal / Stock Jobs'), 'both are inside the menu');
    assert.ok(menu.includes('<input type="hidden" name="outliers" value="0">') && menu.includes('<input type="hidden" name="internal" value="0">'), 'unticked is still sent');
    assert.match(block, /None Selected/, 'the button says how many are on');
    const withBoth = (await S.admin.get(`/accuracy/customers?${q}&outliers=1&internal=1`)).body;
    assert.match(withBoth, /name="outliers" x-model="outliers" checked>/);
    assert.match(withBoth, /name="internal" x-model="internal" checked>/);
    assert.match(withBoth, /2 Selected/);
    const one = (await S.admin.get(`/accuracy/customers?${q}&outliers=1&internal=0`)).body;
    assert.match(one, /1 Selected/);
  });

  test('the options still do their job: the same address gives the same filters', async () => {
    const a = (await S.admin.get(`/accuracy/customers?${q}&outliers=1&internal=0`)).body;
    assert.match(a, /name="outliers" x-model="outliers" checked>/);
    assert.doesNotMatch(a, /name="internal" x-model="internal" checked>/);
  });

  test('every box has the same height and text size (one rule for them all)', async () => {
    const css = (await S.admin.get('/static/app.css')).body;
    const rule = /\.acc-filters \.filters select, \.acc-filters \.filters input:not\(\[type=checkbox\]\):not\(\[type=hidden\]\), \.acc-filters \.multi-btn \{([^}]*)\}/.exec(css)?.[1] ?? '';
    assert.match(rule, /height: 30px/);
    assert.match(rule, /font-size: \.8rem/);
    assert.match(css, /\.acc-filters \.filters > label, \.acc-filters \.filters > \.multi-field \{[^}]*font-size: \.74rem/, 'one label size');
  });

  test('on the Customers page the lists open worst first; on a customer\'s own page and Ops they are still High to Low', async () => {
    const cust = (await S.admin.get(`/accuracy/customers?${q}&minJobs=1`)).body;
    const key = /data-href="\/accuracy\/customers\/([^"?]+)\?/.exec(cust)[1];
    const detail = (await S.admin.get(`/accuracy/customers/${key}?${q}`)).body;
    assert.match(detail, /<option value="desc" selected>High to Low<\/option>/, 'one customer page: High to Low');
    const ops = (await S.admin.get(`/accuracy/ops?${q}&sort=vstarget`)).body;
    assert.match(ops, /<option value="netvar" selected>Net Var \$<\/option>/, 'a margin sort is not offered on Ops, so it falls back');
    assert.match(ops, /<option value="desc" selected>High to Low<\/option>/, 'and the order goes back to High to Low with it');
  });
});
