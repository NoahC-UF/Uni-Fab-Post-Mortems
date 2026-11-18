import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseAccuracyFilters, customersPage, filterLink } from '../src/accuracy.js';
import { makeSession } from './helpers.js';

const NOW = new Date('2026-06-15T12:00:00Z');
const F = (over = {}) => ({ ...parseAccuracyFilters({ from: '2000-01-01', to: '2999-01-01', internal: '1', minJobs: '1' }, NOW, {}), ...over });
const q = 'from=2000-01-01&to=2999-01-01&minJobs=1';

describe("one customer's Operations & Material Review section", () => {
  let S;
  let key;
  let label;
  before(async () => {
    S = await makeSession();
    const c = customersPage(S.db, F({ tier: '', mgr: '' })).all.sort((a, b) => b.jobs - a.jobs)[0];
    key = c.key;
    label = c.label;
  });
  const page = async (extra = '') => (await S.admin.get(`/accuracy/customers/${encodeURIComponent(key)}?${q}${extra}`)).body;
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/'/g, '&#39;');

  test("it is titled 'Company Name - Operations & Material Review', with the Show box in the same header, top right", async () => {
    const body = await page();
    const head = /<div class="acc-cardhead">\s*<h2>(.*?)<\/h2>\s*<label class="acc-pick no-print">Show\s*<select[^>]*>(.*?)<\/select>\s*<\/label>\s*<\/div>/s.exec(body);
    assert.ok(head, 'the title and the Show box share the header row');
    assert.equal(head[1], `${esc(label)} - Operations &amp; Material Review`);
    assert.ok(!body.includes("What Is Going Wrong on This Customer's Work"));
    assert.ok(!/<div class="row no-print" style="margin-bottom:8px"><label class="acc-pick/.test(body), 'no separate row for the Show box any more');
    const css = fs.readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');
    assert.match(css, /\.acc-cardhead \{ display: flex; align-items: center; justify-content: space-between;/, 'title at the left, Show box at the right');
  });

  test('it opens on Both - Horizontal Window; an explicit choice in the address is respected', async () => {
    const body = await page();
    assert.match(body, /<option value="[^"]*lists=h[^"]*" selected>Both - Horizontal Window<\/option>/);
    assert.ok(body.includes('<input type="hidden" name="lists" value="h">'), 'Apply Filters keeps it');
    const over = await page('&lists=over');
    assert.match(over, /<option value="[^"]*lists=over[^"]*" selected>Jobs Over Estimates<\/option>/);
    const under = await page('&lists=under');
    assert.match(under, /selected>Jobs Under Estimates<\/option>/);
  });

  test('the other pages keep their own default (Jobs Over Estimates)', async () => {
    assert.equal(parseAccuracyFilters({}, NOW, {}).lists, 'over', 'the shared default is unchanged');
    for (const url of [`/accuracy/customers?${q}`, `/accuracy/ops?${q}`]) {
      const b = (await S.admin.get(url)).body;
      assert.ok(b.includes('<input type="hidden" name="lists" value="over">'), url);
    }
  });

  test('going from the Customers page to a customer and back does not carry the lists choice across', async () => {
    const list = (await S.admin.get(`/accuracy/customers?${q}&lists=over`)).body;
    const rows = [...list.matchAll(/data-href="(\/accuracy\/customers\/[^"?]+\?[^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
    assert.ok(rows.length > 0);
    for (const h of rows) assert.ok(!/[?&]lists=/.test(h), `a customer row does not pass the lists on: ${h}`);
    const bubble = JSON.parse(/<script type="application\/json" id="bubbleData">(.*?)<\/script>/s.exec(list)[1]);
    assert.ok(!/lists=/.test(bubble.base), 'nor does the chart');
    // opened from there, the customer is on Both - Horizontal Window
    const opened = (await S.admin.get(rows[0])).body;
    assert.match(opened, /selected>Both - Horizontal Window<\/option>/);
    // and the way back carries no lists choice either, so the Customers page keeps its own default
    const back = /<a class="btn" href="(\/accuracy\/customers\?[^"]*)">&larr; All Customers<\/a>/.exec(opened)[1].replace(/&amp;/g, '&');
    assert.ok(!/lists=/.test(back));
    const customers = (await S.admin.get(back)).body;
    assert.ok(customers.includes('<input type="hidden" name="lists" value="over">'));
  });

  test('filterLink can leave the lists choice out', () => {
    const f = F();
    assert.ok(new URLSearchParams(filterLink(f)).has('lists'));
    assert.ok(!new URLSearchParams(filterLink(f, { lists: null })).has('lists'));
  });

  test('the Scroll To menu calls the section by its new name', async () => {
    const body = await page();
    assert.ok(body.includes('@click="go(\'sec-problems\')">Operations &amp; Material Review</button>'));
  });
});

describe('the heading line and the pinned block are centred on the same lines', () => {
  const css = fs.readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');
  test('the date buttons are centred on the date line, then on the name line, with the offset animated like everything else', () => {
    assert.match(css, /\.acc-sticky \.date-tools \{ margin-bottom: -3px; transition: margin-bottom var\(--acc-dur\) var\(--acc-ease\); \}/);
    assert.match(css, /\.acc-sticky\.is-compact \.date-tools \{ margin-bottom: 3px; \}/);
    assert.match(css, /\.acc-titlebar \{ display: flex; align-items: center;/, 'name, tier line and note are centred on one line');
    assert.match(css, /\.acc-sticky \.tile-short \{[^}]*align-items: center;/, 'and each one-line card');
  });
});
