import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { parseAccuracyFilters, customersPage, opsAndMaterials } from '../src/accuracy.js';
import { makeSession } from './helpers.js';

const NOW = new Date('2026-06-15T12:00:00Z');
const F = (over = {}) => ({ ...parseAccuracyFilters({ from: '2000-01-01', to: '2999-01-01', internal: '1', minJobs: '1' }, NOW, {}), ...over });
const q = 'from=2000-01-01&to=2999-01-01&minJobs=1';

// The Operations and Materials lists: which columns they have, and that they open ranked on Net Var $ (the impact on the $ basis).
describe('the Operations and Materials lists', () => {
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

  test('the columns, on Ops and on a customer page: no Gross Var $, Attention Score or Excess $', async () => {
    for (const url of [`/accuracy/ops?${q}`, `/accuracy/customers/${encodeURIComponent(key)}?${q}`]) {
      const b = (await S.admin.get(url)).body;
      assert.deepEqual(cols(b, 'acc-ops').slice(1), ['Jobs', 'Est Hrs', 'Actual Hrs', 'Var Hrs', 'Est $', 'Act $', 'Net Var $', 'Avg Var %', '% Jobs Off'], url);
      assert.deepEqual(cols(b, 'acc-mtl').slice(1), ['Jobs', 'Exp Qty', 'Issued Qty', 'Est $', 'Act $', 'Net Var $', 'Avg Var %', '% Jobs Off'], url);
      assert.ok(!b.includes('Excess $'), url);
    }
  });

  test('they open ranked on Net Var $, biggest first, and the lists really are in that order', async () => {
    const f = parseAccuracyFilters({}, NOW, {});
    assert.equal(f.sort, 'netvar');
    assert.equal(f.order, 'desc');
    const b = (await S.admin.get(`/accuracy/ops?${q}`)).body;
    assert.match(b, /<option value="netvar" selected>Net Var \$<\/option>/);
    assert.ok(/<option value="impact" >|<option value="impact">/.test(b), 'Impact (Chosen Basis) is still a choice');
    assert.ok(!/<option value="excess"/.test(b), 'no Excess $ sort');
    const d = opsAndMaterials(S.db, F());
    for (const list of [d.ops.over, d.mtls.over]) assert.ok(list.slice(1).every((g, i) => list[i].netDollars >= g.netDollars));
    for (const list of [d.ops.under, d.mtls.under]) assert.ok(list.slice(1).every((g, i) => list[i].netDollars <= g.netDollars));
  });

  test('an old link with sort=excess opens on the default', async () => {
    const b = (await S.admin.get(`/accuracy/ops?${q}&sort=excess`)).body;
    assert.match(b, /<option value="netvar" selected>/);
  });
});
