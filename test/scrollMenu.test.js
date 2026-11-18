import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { parseAccuracyFilters, customersPage, opsAndMaterials } from '../src/accuracy.js';
import { makeSession } from './helpers.js';

const NOW = new Date('2026-06-15T12:00:00Z');
const F = (over = {}) => ({ ...parseAccuracyFilters({ from: '2000-01-01', to: '2999-01-01', internal: '1', minJobs: '1' }, NOW, {}), ...over });
const q = 'from=2000-01-01&to=2999-01-01&minJobs=1';

/** The Scroll To menu on a page: [{ id, label }] in the order shown. */
const menu = (body) => {
  const m = /<div class="scroll-menu" x-data="scrollMenu\(\[([^\]]*)\]\)"/.exec(body);
  if (!m) return null;
  const ids = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  const items = [...body.matchAll(/<button type="button" class="scroll-item"[^>]*@click="go\('([^']+)'\)">([^<]*)<\/button>/g)].map((x) => ({ id: x[1], label: x[2] }));
  return { ids, items };
};
const hasId = (body, id) => id === 'sec-top' || body.includes(`id="${id}"`);

describe('the Scroll To menu in the filter section', () => {
  let S;
  let key;
  before(async () => {
    S = await makeSession();
    key = customersPage(S.db, F({ tier: '', mgr: '' })).all.sort((a, b) => b.jobs - a.jobs)[0].key;
  });

  const pages = () => [
    ['Ops & Materials', `/accuracy/ops?${q}`, ['Overview', 'Operations', 'Materials', 'Biggest Net Variances', 'Unestimated Work']],
    ['Customers', `/accuracy/customers?${q}`, ['Overview', 'Customers', 'How Often vs How Far Off']],
    ['one customer', `/accuracy/customers/${encodeURIComponent(key)}?${q}`, ['Overview', 'Margin Charts', 'Operations &amp; Material Review', 'Repeat Part Numbers', 'All Jobs']],
  ];

  test('each page has the menu with its own sections, starting with Overview (the top of the page)', async () => {
    for (const [name, url, labels] of pages()) {
      const body = (await S.admin.get(url)).body;
      const m = menu(body);
      assert.ok(m, `${name}: has the menu`);
      assert.deepEqual(m.items.map((i) => i.label), labels, name);
      assert.deepEqual(m.ids, m.items.map((i) => i.id), `${name}: the menu script and the buttons agree`);
      assert.equal(m.items[0].id, 'sec-top');
      assert.ok(body.includes('class="scroll-title">Scroll To<'), name);
      assert.ok(body.includes('/static/scroll-menu.js'), `${name}: loads the script`);
    }
  });

  test('every item points at a section that is really on the page', async () => {
    for (const [name, url] of pages()) {
      const body = (await S.admin.get(url)).body;
      for (const it of menu(body).items) assert.ok(hasId(body, it.id), `${name}: ${it.label} -> #${it.id}`);
    }
  });

  test('a drill-down adds its own item, in page order', async () => {
    const key1 = opsAndMaterials(S.db, F()).ops.over[0].key;
    const body = (await S.admin.get(`/accuracy/ops?${q}&drill=op:${encodeURIComponent(key1)}`)).body;
    assert.deepEqual(menu(body).items.map((i) => i.label), ['Overview', 'Drill-Down', 'Operations', 'Materials', 'Biggest Net Variances', 'Unestimated Work']);
    assert.ok(hasId(body, 'drill'));
  });

  test('the script is served and the menu stays out of print', async () => {
    const js = await S.admin.get('/static/scroll-menu.js');
    assert.equal(js.statusCode, 200);
    assert.ok(js.body.includes('function scrollMenu('));
    const body = (await S.admin.get(pages()[0][1])).body;
    assert.ok(/<form method="get"[^>]*class="no-print acc-form"/.test(body), 'the whole filter form, menu included, does not print');
  });
});
