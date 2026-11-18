import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeSession } from './helpers.js';

const q = 'from=2000-01-01&to=2999-01-01&minJobs=1';

describe('the Customers page has the same pinned, shrinking top block as one customer\'s page', () => {
  let S;
  let body;
  before(async () => {
    S = await makeSession();
    body = (await S.admin.get(`/accuracy/customers?${q}`)).body;
  });

  test('the heading and the date line are at the left of the date row, with the date buttons at the right', () => {
    const m = /<div class="row acc-datebar"><div class="acc-lead">(.*?)<\/div><div class="date-tools">/s.exec(body);
    assert.ok(m, 'the heading sits first in the date row');
    assert.match(m[1], /^<div class="acc-titlebar"><h1>Post-Mortem Review: Customers<\/h1><\/div><div class="muted acc-crumbs">2000-01-01 to 2999-01-01<\/div>$/);
    assert.ok(!body.includes('class="page-head acc-head"') && !body.includes('class="acc-title"'), 'no separate heading block any more');
  });

  test('the heading, filters and the six cards are in the pinned block; the notes, the customer lists and the chart are not', () => {
    const start = body.indexOf('<div class="acc-sticky">');
    const end = body.lastIndexOf('<div', body.indexOf('id="sec-customers"'));
    assert.ok(start > 0 && end > start);
    const pinned = body.slice(start, end);
    for (const part of ['acc-titlebar', 'acc-datebar', 'acc-filters', 'class="tiles tiles-6"', 'Customer-Level Accuracy', 'scroll-menu']) assert.ok(pinned.includes(part), part);
    assert.equal((pinned.match(/<div class="acc-sticky">/g) ?? []).length, 1);
    assert.equal((pinned.match(/<div\b/g) ?? []).length, (pinned.match(/<\/div>/g) ?? []).length, 'closed right before the notes and the lists');
    assert.ok(!pinned.includes('id="sec-customers"') && !pinned.includes('id="bubbleFold"'));
  });

  test('the notes that only show sometimes sit below the pinned block, so it stays short', async () => {
    const all = (await S.admin.get(`/accuracy/customers?${q}&status=all&tier=A`)).body;
    const pinnedEnd = all.indexOf('</div>{# /acc-sticky #}') >= 0 ? all.indexOf('</div>{# /acc-sticky #}') : all.indexOf('id="sec-customers"');
    const flash = all.indexOf('In-progress jobs are included');
    const org = all.indexOf('acc-orgnote');
    assert.ok(flash > 0 && org > 0, 'both notes show with these filters');
    const lastTile = all.indexOf('Customer-Level Accuracy');
    assert.ok(org > lastTile && flash > lastTile, 'after the cards, not between the filters and the cards');
    assert.ok(pinnedEnd > 0);
  });

  test('each card has a one-line layer: SHORT LABEL: value', () => {
    const layers = [...body.matchAll(/<div class="tile-short" aria-hidden="true"><span class="ts-label">([^<]*)<\/span><span class="ts-value">(.*?)<\/span><\/div><div class="label">([^<]*)<\/div><div class="value">(.*?)<\/div>/g)];
    assert.deepEqual(layers.map((m) => [m[3], m[1]]), [
      ['Sold', 'Sold:'],
      ['Margin', 'Margin:'],
      ['Margin vs Target $', 'Mar. vs Tar. $:'],
      ['Customers at a Loss', 'At a Loss:'],
      ['Net Variance', 'Net Var.:'],
      ['Customer-Level Accuracy', 'Accuracy:'],
    ]);
    for (const m of layers) assert.equal(m[2], m[4], `${m[3]}: the one-line layer shows the same value as the card`);
  });

  test('the Customers CSV button is in the filter section after the divider, left of the Scroll To arrow, the same height as the rest', () => {
    const start = body.indexOf('<div class="filters">');
    const form = body.slice(start, body.indexOf('</form>', start));
    const tools = form.indexOf('class="filter-tools"');
    const at = (needle) => (needle === 'class="filter-sep"' ? form.indexOf(needle, tools) : form.indexOf(needle));
    const where = ['class="filter-actions"', '>Reset<', '>Apply Filters<', 'class="filter-tools"', 'class="filter-sep"', 'Customers CSV', 'class="scroll-menu"'].map(at);
    assert.ok(where.every((w) => w >= 0), `all present: ${where}`);
    assert.deepEqual([...where].sort((a, b) => a - b), where, 'Reset, Apply, divider, CSV button, Scroll To arrow');
    assert.ok(/<a class="btn" href="\/accuracy\/export\.csv\?[^"]*">/.test(form), 'a full-size button, not the small one');
  });

  test('the Customers section header has the list layout box at its top right, like the customer page', () => {
    const at = body.indexOf('id="sec-customers"');
    const head = /<div class="acc-cardhead">\s*<h2>Customers<\/h2>(.*?)<\/div>\s*<div/s.exec(body.slice(at));
    assert.ok(head, 'a card header with the title at the left');
    assert.ok(/listPick|acc-pick|Show/.test(head[1]), 'and the picker in it');
  });

  test('it loads the shrinking and the Scroll To scripts, and keeps the Scroll To sections', () => {
    for (const s of ['/static/sticky-compact.js', '/static/scroll-menu.js', '/static/scroll-memory.js']) assert.ok(body.includes(s), s);
    assert.match(body, /scrollMenu\(\['sec-top','sec-customers','bubbleFold'\]\)|scrollMenu\(\[[^\]]*sec-customers/);
    for (const id of ['sec-customers', 'bubbleFold']) assert.ok(body.includes(`id="${id}"`), id);
  });
});
