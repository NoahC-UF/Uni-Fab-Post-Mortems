import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseAccuracyFilters, customersPage, opsAndMaterials } from '../src/accuracy.js';
import { makeSession } from './helpers.js';

const NOW = new Date('2026-06-15T12:00:00Z');
const F = (over = {}) => ({ ...parseAccuracyFilters({ from: '2000-01-01', to: '2999-01-01', internal: '1', minJobs: '1' }, NOW, {}), ...over });
const q = 'from=2000-01-01&to=2999-01-01&minJobs=1';
const LONG = 'Plank Grating, Stair Tread Plank, GRIP STRUT, Galvanized Steel, Pre-Galvanized, 14 Gauge (.0785" Thick), 4-Diamond-N (10-1/2" Width), 1-1/2" Channel Depth, Serrated Surface, Slip Resistant';

describe('long descriptions do not widen the tables', () => {
  let S;
  let key;
  before(async () => {
    S = await makeSession();
    key = customersPage(S.db, F({ tier: '', mgr: '' })).all.sort((a, b) => b.jobs - a.jobs)[0].key;
    // a long description on every material and every part, so every page has something long to show
    S.db.prepare('UPDATE line_results SET description = ? WHERE kind = \'material\'').run(LONG);
    S.db.prepare('UPDATE jobs SET part_description = ?').run(LONG);
  });

  test('a description is a clipped, one-line block with the whole text in the hover tip (materials, parts, repeat parts)', async () => {
    const mtlKey = opsAndMaterials(S.db, F()).mtls.all[0].key;
    const pages = [
      `/accuracy/ops?${q}`, // the materials list
      `/accuracy/ops?${q}&drill=mtl:${encodeURIComponent(mtlKey)}`, // the parts a material appears on
      `/accuracy/customers/${encodeURIComponent(key)}?${q}`, // the materials list of one customer
    ];
    for (const url of pages) {
      const body = (await S.admin.get(url)).body;
      const esc = LONG.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/'/g, '&#39;');
      assert.ok(body.includes(`<span class="acc-desc" title="${esc}">${esc}</span>`), `${url}: the full text is the hover tip`);
      assert.ok(!/<br><small class="muted">[^<]{60,}<\/small>/.test(body), `${url}: no more unclipped descriptions`);
    }
  });

  test('the first column of each of these tables is marked to take the room, the others keep their numbers', async () => {
    const ops = (await S.admin.get(`/accuracy/ops?${q}`)).body;
    assert.match(ops, /<table data-table="acc-ops"[^>]*>\s*<thead><tr>\s*<th class="acc-descol" data-help=/);
    assert.match(ops, /<table data-table="acc-mtl"[^>]*>\s*<thead><tr>\s*<th class="acc-descol" data-help=/);
    const cust = (await S.admin.get(`/accuracy/customers/${encodeURIComponent(key)}?${q}`)).body;
    assert.match(cust, /<table data-table="acc-mtl"[^>]*>\s*<thead><tr>\s*<th class="acc-descol" data-help=/);
    const mtlKey = opsAndMaterials(S.db, F()).mtls.all[0].key;
    const drill = (await S.admin.get(`/accuracy/ops?${q}&drill=mtl:${encodeURIComponent(mtlKey)}`)).body;
    assert.ok(drill.includes('<th class="acc-descol acc-descol-wide">Part</th>'), 'the parts table of a drill-down');
    const src = fs.readFileSync(new URL('../src/views/accuracy_customer.njk', import.meta.url), 'utf8');
    assert.ok(src.includes('<th class="acc-descol acc-descol-repeat">Part</th>') && src.includes('class="acc-desc" title="{{ p.description }}"'), 'and the customer\'s Repeat Part Numbers table');
  });

  test('the stylesheet clips it without letting it set the column width', () => {
    const css = fs.readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');
    const rule = /\.acc-desc \{([^}]*)\}/.exec(css)[1];
    for (const part of ['display: block', 'width: 0', 'min-width: 100%', 'overflow: hidden', 'text-overflow: ellipsis', 'white-space: nowrap']) assert.ok(rule.includes(part), part);
    assert.match(css, /table\.acc-table th\.acc-descol \{ width: 36%; \}/);
    assert.match(css, /table\.acc-table th\.acc-descol-wide \{ width: 62%; \}/);
  });
});
