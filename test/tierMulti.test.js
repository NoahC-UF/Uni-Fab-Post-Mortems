import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { parseAccuracyFilters, parseTierFilter, filterLink, customersPage, loadLines, TOP_CHOICES, TOP_CUSTOMERS } from '../src/accuracy.js';
import { applyCustomers, passesOrgFilter, orgFilterOptions } from '../src/customerOrg.js';
import { makeSession } from './helpers.js';

const NOW = new Date('2026-06-15T12:00:00Z');
const P = (q) => parseAccuracyFilters({ from: '2000-01-01', to: '2999-01-01', internal: '1', minJobs: '1', ...q }, NOW, {});

describe('the Tier filter takes more than one tier', () => {
  test('tier=A&tier=B and tier=A,B mean the same; empty means all', () => {
    assert.equal(parseTierFilter(['A', 'B']), 'A,B');
    assert.equal(parseTierFilter('A,B'), 'A,B');
    assert.equal(parseTierFilter(['a', 'B,a', ' ']), 'A,B', 'capitals do not matter and a tier is only counted once');
    assert.equal(parseTierFilter('A,_NONE'), 'A,_none');
    assert.equal(parseTierFilter(''), '');
    assert.equal(parseTierFilter(undefined), '');
    assert.equal(parseTierFilter({ a: 1 }), '');
    assert.equal(P({ tier: ['A', 'B'] }).tier, 'A,B');
    assert.equal(P({}).tier, '');
  });

  test('a customer passes when it is in any of the ticked tiers', () => {
    const listed = (tier) => ({ listed: true, tier, managers: '' });
    assert.ok(passesOrgFilter(listed('A'), { tier: 'A,B' }));
    assert.ok(passesOrgFilter(listed('B'), { tier: 'A,B' }));
    assert.ok(!passesOrgFilter(listed('C'), { tier: 'A,B' }));
    assert.ok(!passesOrgFilter(listed(''), { tier: 'A,B' }), 'on the list with no tier');
    assert.ok(!passesOrgFilter({ listed: false, tier: '', managers: '' }, { tier: 'A,B' }));
    assert.ok(passesOrgFilter({ listed: false, tier: '', managers: '' }, { tier: 'A,_none' }), 'Not on the List can be ticked with a tier');
    assert.ok(passesOrgFilter(listed('A'), { tier: 'A,_none' }));
    assert.ok(!passesOrgFilter(listed('B'), { tier: 'A,_none' }));
    assert.ok(passesOrgFilter(listed('A'), { tier: '' }));
  });

  test('it stays in the links as one value', () => {
    const f = P({ tier: ['A', 'B'] });
    assert.equal(new URLSearchParams(filterLink(f)).get('tier'), 'A,B');
    assert.ok(!new URLSearchParams(filterLink({ ...f, tier: '' })).has('tier'));
  });
});

describe('how many customers are shown', () => {
  test('10, 25, 50 or 100; 25 unless asked', () => {
    assert.deepEqual(TOP_CHOICES, [10, 25, 50, 100]);
    assert.equal(TOP_CUSTOMERS, 25);
    assert.equal(P({}).top, 25);
    for (const n of TOP_CHOICES) assert.equal(P({ top: String(n) }).top, n);
    for (const bad of ['7', '0', '-10', 'abc', '1000', '']) assert.equal(P({ top: bad }).top, 25, bad);
    assert.equal(new URLSearchParams(filterLink(P({ top: '50' }))).get('top'), '50', 'kept in links');
  });
});

describe('Customers page: tiers, Show and the title', () => {
  let S;
  let names;
  const q = 'from=2000-01-01&to=2999-01-01&minJobs=1';
  const labels = (f) => customersPage(S.db, P(f)).all.map((g) => g.label).sort();
  before(async () => {
    S = await makeSession();
    names = S.db.prepare("SELECT DISTINCT cust_name FROM jobs WHERE cust_name <> '' ORDER BY cust_name").all().map((r) => r.cust_name);
    assert.ok(names.length >= 5);
    applyCustomers(S.db, [
      { name: names[0], tier: 'A', managers: '' },
      { name: names[1], tier: 'B', managers: '' },
      { name: names[2], tier: 'C', managers: '' },
      { name: names[3], tier: 'D', managers: '' },
    ], 'replace', '2026-01-01T00:00:00Z');
  });

  test('A and B together give the customers of both, and the other pages follow', () => {
    assert.deepEqual(labels({ tier: 'A,B' }), [names[0], names[1]].sort());
    assert.deepEqual(labels({ tier: ['A', 'C'] }), [names[0], names[2]].sort());
    const both = labels({ tier: 'A,B' });
    const ab = loadLines(S.db, P({ tier: 'A,B' }));
    assert.ok(ab.length > 0 && ab.every((l) => both.includes(l.cust_name)));
    const notListed = labels({ tier: '_none' });
    assert.ok(notListed.length > 0);
    assert.deepEqual(labels({ tier: 'A,_none' }), [...new Set([...notListed, ...labels({ tier: 'A' })])].sort(), 'Not on the List can be ticked with a tier');
  });

  test('the Tier filter is a list of tick boxes with the ticked ones checked, on both pages', async () => {
    for (const path of ['/accuracy/customers', '/accuracy/ops']) {
      const body = (await S.admin.get(`${path}?${q}&tier=A&tier=B`)).body;
      assert.ok(!/<select name="tier"/.test(body), `${path}: no longer a single choice`);
      for (const t of ['A', 'B']) assert.match(body, new RegExp(`name="tier" value="${t}" x-model="sel" checked>`), `${path}: ${t} ticked`);
      for (const t of ['C', 'D', '_none']) assert.ok(body.includes(`name="tier" value="${t}"`) && !new RegExp(`name="tier" value="${t}" x-model="sel" checked>`).test(body), `${path}: ${t} offered, not ticked`);
      assert.ok(body.includes('Not on the List'));
      assert.ok(body.includes('/static/multi-select.js'));
      assert.ok(body.includes('tier A or tier B'), `${path}: the note says which tiers`);
      assert.match(body, /Show all customers/);
      const all = (await S.admin.get(`${path}?${q}`)).body;
      assert.ok(!/name="tier" value="[A-Z_a-z]+" x-model="sel" checked>/.test(all), `${path}: nothing ticked = all tiers`);
    }
  });

  test('the "Show all customers" link clears the tier filter however many tiers are ticked', async () => {
    const body = (await S.admin.get(`/accuracy/customers?${q}&tier=A&tier=B&mgr=Zed`)).body;
    const href = /<a href="([^"]+)">Show all customers<\/a>/.exec(body)[1].replace(/&amp;/g, '&');
    const u = new URLSearchParams(href.split('?')[1]);
    assert.equal(u.has('tier'), false);
    assert.equal(u.has('mgr'), false);
    assert.equal(u.get('minJobs'), '1');
  });

  test('Show: a box with 10, 25, 50 and 100, 25 chosen at first; the titles say the number', async () => {
    const page = (await S.admin.get(`/accuracy/customers?${q}`)).body;
    const box = /<select name="top"[^>]*>(.*?)<\/select>/s.exec(page)[1];
    assert.deepEqual([...box.matchAll(/<option value="(\d+)" ?(selected)?>Top (\d+)<\/option>/g)].map((m) => [m[1], !!m[2], m[3]]), [['10', false, '10'], ['25', true, '25'], ['50', false, '50'], ['100', false, '100']]);
    assert.ok(page.includes('Top 25 Customers: Jobs Over Estimates'));
    for (const n of [10, 50, 100]) {
      const body = (await S.admin.get(`/accuracy/customers?${q}&top=${n}&lists=v`)).body;
      assert.ok(body.includes(`Top ${n} Customers: Jobs Over Estimates`) && body.includes(`Top ${n} Customers: Jobs Under Estimates`), `Top ${n}`);
      assert.ok(new RegExp(`<option value="${n}" selected>`).test(body));
      assert.ok(!body.includes('Top 25 Customers'));
    }
    assert.ok((await S.admin.get(`/accuracy/customers?${q}&top=7`)).body.includes('Top 25 Customers'), 'an unknown number is the default');
  });

  test('the list is cut to that many customers', () => {
    const d10 = customersPage(S.db, P({ top: '10', sort: 'impact' }));
    const d25 = customersPage(S.db, P({ sort: 'impact' }));
    assert.equal(d10.topN, 10);
    assert.equal(d25.topN, 25);
    assert.ok(d10.over.length <= 10 && d25.over.length <= 25);
    assert.equal(d10.customers, d25.customers, 'the figures and the CSV still cover every customer');
  });

  test('the Show box is on the Customers page only, and the links keep it', async () => {
    assert.ok(!/<select name="top"/.test((await S.admin.get(`/accuracy/ops?${q}`)).body));
    const body = (await S.admin.get(`/accuracy/customers?${q}&top=50`)).body;
    const href = /href="([^"]+)">This month<\/a>/.exec(body)[1].replace(/&amp;/g, '&');
    assert.equal(new URLSearchParams(href.split('?')[1]).get('top'), '50');
  });

  test('the Tier choices offer each tier on the list, then Not on the List', () => {
    assert.deepEqual(orgFilterOptions(S.db).tierChoices, [
      { v: 'A', label: 'Tier A' }, { v: 'B', label: 'Tier B' }, { v: 'C', label: 'Tier C' }, { v: 'D', label: 'Tier D' }, { v: '_none', label: 'Not on the List' },
    ]);
  });
});

describe('the Mainly column is gone', () => {
  let S;
  before(async () => { S = await makeSession(); });
  test('not in the customers table, and its help text is gone; the CSV still has it', async () => {
    const body = (await S.admin.get('/accuracy/customers?from=2000-01-01&to=2999-01-01&minJobs=1')).body;
    const head = /<table data-table="acc-customers"[^>]*>\s*<thead>(.*?)<\/thead>/s.exec(body)[1];
    assert.ok(!/Mainly/.test(head));
    assert.ok(!body.includes('accuracy.mainly'));
    const csv = (await S.admin.get('/accuracy/export.csv?from=2000-01-01&to=2999-01-01&minJobs=1&view=customers')).body;
    assert.ok(csv.split('\r\n')[0].includes('Mainly'));
  });
});
