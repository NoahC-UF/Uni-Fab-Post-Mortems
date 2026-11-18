import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeSession } from './helpers.js';

const q = 'from=2000-01-01&to=2999-01-01&minJobs=1';
const css = () => fs.readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');

describe('the Operations & Materials page has the same pinned, shrinking top block as the Customers pages', () => {
  let S;
  let body;
  before(async () => {
    S = await makeSession();
    body = (await S.admin.get(`/accuracy/ops?${q}`)).body;
  });

  test('the heading and the date line are at the left of the date row, with the date buttons at the right', () => {
    const m = /<div class="row acc-datebar"><div class="acc-lead">(.*?)<\/div><div class="date-tools">/s.exec(body);
    assert.ok(m, 'the heading sits first in the date row');
    assert.match(m[1], /^<div class="acc-titlebar"><h1>Post-Mortem Review: Operations &amp; Materials<\/h1><\/div><div class="muted acc-crumbs">2000-01-01 to 2999-01-01<\/div>$/);
    assert.ok(!body.includes('class="acc-title"') && !body.includes('class="page-head acc-head"'), 'no separate heading block any more');
  });

  test('the heading, filters and the six cards are in the pinned block; the notes and the lists are not', () => {
    const start = body.indexOf('<div class="acc-sticky">');
    const end = body.lastIndexOf('<div', body.indexOf('id="sec-ops"'));
    assert.ok(start > 0 && end > start);
    const pinned = body.slice(start, end);
    for (const part of ['acc-titlebar', 'acc-datebar', 'acc-filters', 'class="tiles tiles-6"', 'Unestimated Work', 'scroll-menu']) assert.ok(pinned.includes(part), part);
    assert.equal((pinned.match(/<div class="acc-sticky">/g) ?? []).length, 1);
    assert.equal((pinned.match(/<div\b/g) ?? []).length, (pinned.match(/<\/div>/g) ?? []).length, 'closed right before the lists');
    assert.ok(!pinned.includes('id="sec-ops"') && !pinned.includes('id="sec-mtl"'));
  });

  test('the notes that only show sometimes sit below the pinned block', async () => {
    const all = (await S.admin.get(`/accuracy/ops?${q}&status=all&tier=A`)).body;
    const lastTile = all.indexOf('lines with actuals but no estimate');
    assert.ok(lastTile > 0);
    for (const note of ['In-progress jobs are included', 'acc-orgnote']) {
      const at = all.indexOf(note);
      assert.ok(at > lastTile, `${note}: after the cards, not between the filters and the cards`);
    }
  });

  test('a customer-only view keeps its note, below the block', async () => {
    const cust = S.db.prepare("SELECT cust_id FROM jobs WHERE cust_id <> '' GROUP BY cust_id ORDER BY COUNT(*) DESC LIMIT 1").get().cust_id;
    const page = (await S.admin.get(`/accuracy/ops?${q}&cust=${encodeURIComponent(cust)}`)).body;
    const note = page.indexOf('Back to this customer');
    assert.ok(note > page.indexOf('lines with actuals but no estimate'), 'the "Showing only" note follows the cards');
  });

  test('each card has a one-line layer: SHORT LABEL: value', () => {
    const layers = [...body.matchAll(/<div class="tile-short" aria-hidden="true"><span class="ts-label">([^<]*)<\/span><span class="ts-value">(.*?)<\/span><\/div><div class="label">([^<]*)<\/div><div class="value">(.*?)<\/div>/g)];
    assert.deepEqual(layers.map((m) => [m[3], m[1]]), [
      ['Labour Variance', 'Labour Var.:'],
      ['Material Variance', 'Material Var.:'],
      ['Operation Accuracy', 'Op. Accuracy:'],
      ['Material Accuracy', 'Mat. Accuracy:'],
      ['Needs Attention', 'Needs Attention:'],
      ['Unestimated Work', 'Unestimated:'],
    ]);
    for (const m of layers) assert.equal(m[2], m[4], `${m[3]}: the one-line layer shows the same value as the card`);
  });

  test('the CSV menu (Operations CSV, Materials CSV) is in the filter section after the divider, left of the Scroll To arrow', () => {
    const start = body.indexOf('<div class="filters">');
    const form = body.slice(start, body.indexOf('</form>', start));
    const tools = form.indexOf('class="filter-tools"');
    const at = (needle) => (needle === 'class="filter-sep"' ? form.indexOf(needle, tools) : form.indexOf(needle));
    const where = ['class="filter-actions"', '>Reset<', '>Apply Filters<', 'class="filter-tools"', 'class="filter-sep"', 'csv-menu', '>Operations CSV<', '>Materials CSV<', 'class="scroll-menu"'].map(at);
    assert.ok(where.every((w) => w >= 0), `all present: ${where}`);
    assert.deepEqual([...where].sort((a, b) => a - b), where, 'Reset, Apply, divider, the CSV menu, Scroll To arrow');
    assert.ok(/href="\/accuracy\/export\.csv\?[^"]*view=ops"/.test(form) && /href="\/accuracy\/export\.csv\?[^"]*view=materials"/.test(form));
    assert.match(css(), /\.csv-menu|scroll-panel/, 'styled like the Scroll To list');
  });

  test('the Operations and Materials section headers have the Show box and the Group by buttons at their top right', () => {
    for (const id of ['sec-ops', 'sec-mtl']) {
      const at = body.indexOf(`id="${id}"`);
      assert.match(body.slice(at, at + 400), /<div class="acc-cardhead">\s*<h2>/, id);
    }
    assert.ok(!/<div class="page-head" style="margin-bottom:8px">\s*<h2>(Operations|Materials)/.test(body));
  });

  test('it loads the shrinking, Scroll To and scroll-memory scripts, and keeps the Scroll To sections', () => {
    for (const s of ['/static/sticky-compact.js', '/static/scroll-menu.js', '/static/scroll-memory.js']) assert.ok(body.includes(s), s);
    for (const id of ['sec-ops', 'sec-mtl', 'sec-chart', 'sec-unest']) assert.ok(body.includes(`id="${id}"`), id);
    assert.match(body, /scrollMenu\(\[[^\]]*sec-ops[^\]]*sec-mtl[^\]]*sec-chart[^\]]*sec-unest/);
  });

  test('the drill-down page keeps working inside the pinned layout', async () => {
    const op = /href="\/accuracy\/ops\?[^"]*drill=([^"&]+)/.exec(body);
    assert.ok(op, 'the page links to a drill-down');
    const page = (await S.admin.get(`/accuracy/ops?${q}&drill=${op[1]}`)).body;
    assert.ok(page.includes('id="drill"') && page.includes('<div class="acc-sticky">'));
    assert.match(page, /scrollMenu\(\[[^\]]*'drill'/);
  });

  test('a link to #drill or #jobs lands below the pinned block, not under it', () => {
    const all = css();
    assert.match(all, /html:has\(\.acc-sticky\) \{ scroll-padding-top: calc\(var\(--topbar-h, 57px\) \+ var\(--acc-compact-h, \d+px\) \+ \d+px\); \}/);
    const js = fs.readFileSync(new URL('../public/sticky-compact.js', import.meta.url), 'utf8');
    assert.ok(js.includes("setProperty('--acc-compact-h'"), 'the script sets the shrunk height');
    assert.match(all, /html:has\(\.acc-sticky\) :is\(\[id\], #drill, #bubbleFold\) \{ scroll-margin-top: 0; \}/, 'and the 76px margin of the section ids is not added on top');
  });
});
