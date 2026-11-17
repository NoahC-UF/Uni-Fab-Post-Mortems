import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { parseAccuracyFilters, groupLines, rankGroups, opKey, opsAndMaterials, customersPage, exportCsv } from '../src/accuracy.js';
import { makeSession } from './helpers.js';

const NOW = new Date('2026-06-15T12:00:00Z');
const F = (over = {}) => ({ ...parseAccuracyFilters({ from: '2000-01-01', to: '2999-01-01', internal: '1', minJobs: '1' }, NOW, {}), ...over });
const q = 'from=2000-01-01&to=2999-01-01&minJobs=1';

let n = 0;
/** A made-up operation line: code, estimated and actual dollars. */
const op = (code, estD, actD) => ({
  job_num: `X${++n}`, kind: 'op', op_code: code, resource_grp_id: 'RG', part_num: null, description: code, class_id: null, unplanned: 0, flag: 'green', activity_date: '2026-03-10',
  exp_hours: 10, act_hours: 10, exp_setup: 2, act_setup: 2, exp_run: 8, act_run: 8, var_hours: 0, exp_qty: null, act_qty: null,
  est_dollars: estD, act_dollars: actD, var_dollars: actD - estD, usage_var: null, price_var: null, var_pct: null,
  job_part: 'P', job_part_desc: 'Part', cust_id: 'C1', cust_name: 'Acme', order_num: 1, closed: 1,
});
const excessOf = (lines, tol) => groupLines(lines, opKey('op'), 'op', tol)[0].excess;

describe('Excess $: the dollars beyond what the green band allows', () => {
  test('net variance less the green band on the estimate; 0 inside the band; same sign as the variance', () => {
    assert.equal(excessOf([op('A', 10000, 12000)], 0.1), 1000, '+$2,000 on $10,000 with a 10% band: $1,000 beyond');
    assert.equal(excessOf([op('A', 10000, 10800)], 0.1), 0, 'inside the band');
    assert.equal(excessOf([op('A', 10000, 10000)], 0.1), 0, 'on the estimate');
    assert.equal(excessOf([op('A', 10000, 7000)], 0.1), -2000, '-$3,000 under with a 10% band: $2,000 beyond');
    assert.equal(excessOf([op('A', 10000, 12000)], 0), 2000, 'no band: the whole variance');
  });

  test('overs and unders inside a group net first, as Net Var $ does', () => {
    assert.equal(excessOf([op('A', 10000, 13000), op('A', 10000, 7000)], 0.1), 0);
  });

  test('a tiny item at a huge % does not outrank a big item over by a lot of dollars', () => {
    const groups = groupLines([op('TINY', 80, 251), op('BIG', 20000, 26000), op('PLATE', 28000, 31000)], opKey('op'), 'op', 0.1);
    const byKey = Object.fromEntries(groups.map((g) => [g.key, g]));
    assert.equal(byKey.TINY.excess, 163, '+$171 and +213%, but only $163 beyond the band');
    assert.equal(byKey.BIG.excess, 4000);
    assert.equal(byKey.PLATE.excess, 200, 'the plate is +10.7%: barely beyond the band');
    const ranked = rankGroups(groups, F({ sort: 'excess' }));
    assert.deepEqual(ranked.over.map((g) => g.key), ['BIG', 'PLATE', 'TINY']);
  });

  test('inside the band the bigger net variance comes first; the Under list ranks the biggest savings first', () => {
    const groups = groupLines([op('S1', 10000, 10300), op('S2', 10000, 10900), op('U1', 10000, 9000), op('U2', 10000, 5000)], opKey('op'), 'op', 0.1);
    const ranked = rankGroups(groups, F({ sort: 'excess' }));
    assert.deepEqual(ranked.over.map((g) => g.key), ['S2', 'S1']);
    assert.deepEqual(ranked.under.map((g) => g.key), ['U2', 'U1']);
    assert.deepEqual(rankGroups(groups, F({ sort: 'excess', order: 'asc' })).over.map((g) => g.key), ['S1', 'S2'], 'Low to High flips it');
  });
});

describe('Excess $ on the pages', () => {
  let S;
  let key;
  before(async () => {
    S = await makeSession();
    key = customersPage(S.db, F({ tier: '', mgr: '' })).all.sort((a, b) => b.jobs - a.jobs)[0].key;
  });
  const cols = (body, table) => {
    const m = new RegExp(`<table data-table="${table}"[^>]*>\\s*<thead><tr>(.*?)</tr></thead>`, 's').exec(body);
    return [...m[1].matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((x) => x[1]);
  };

  test('Operations and Materials lists have Excess $ and no Gross Var $ or Attention Score, on Ops and on a customer page', async () => {
    for (const url of [`/accuracy/ops?${q}`, `/accuracy/customers/${encodeURIComponent(key)}?${q}`]) {
      const b = (await S.admin.get(url)).body;
      const ops = cols(b, 'acc-ops');
      const mtl = cols(b, 'acc-mtl');
      assert.deepEqual(ops.slice(1), ['Jobs', 'Est Hrs', 'Actual Hrs', 'Var Hrs', 'Est $', 'Act $', 'Net Var $', 'Excess $', 'Avg Var %', '% Jobs Off'], url);
      assert.deepEqual(mtl.slice(-4), ['Net Var $', 'Excess $', 'Avg Var %', '% Jobs Off'], url);
      for (const c of [...ops, ...mtl]) assert.ok(c !== 'Gross Var $' && c !== 'Attention Score', `${url}: ${c}`);
      assert.match(b, /<option value="excess" selected>Excess \$<\/option>/);
    }
  });

  test('the cells hold the number and a tooltip with how it was worked out', async () => {
    const d = opsAndMaterials(S.db, F());
    const g = d.ops.over[0];
    assert.ok(g.excess !== undefined && g.tolerance > 0);
    const b = (await S.admin.get(`/accuracy/ops?${q}`)).body;
    assert.ok(b.includes('green band on'), 'tooltip');
    assert.ok(d.ops.over.slice(1).every((x, i) => d.ops.over[i].excess >= x.excess), 'ranked by Excess $, biggest first');
  });

  test('the Customers page does not offer Excess $, and an old link falls back to the customer default', async () => {
    const b = (await S.admin.get(`/accuracy/customers?${q}&sort=excess`)).body;
    assert.ok(!/<option value="excess"/.test(b));
    assert.match(b, /<option value="vstarget" selected>/);
  });

  test('the CSVs gain an Excess $ column at the end and keep the rest', () => {
    const ops = exportCsv(S.db, F(), 'ops').split('\r\n')[0].split(',');
    assert.equal(ops.at(-1), 'Excess $');
    assert.ok(ops.includes('Gross Variance $') && ops.includes('Attention Score'));
    assert.equal(exportCsv(S.db, F(), 'materials').split('\r\n')[0].split(',').at(-1), 'Excess $');
  });
});
