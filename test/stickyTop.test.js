import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseAccuracyFilters, customersPage, customerDetail } from '../src/accuracy.js';
import { makeSession } from './helpers.js';

const NOW = new Date('2026-06-15T12:00:00Z');
const F = (over = {}) => ({ ...parseAccuracyFilters({ from: '2000-01-01', to: '2999-01-01', internal: '1', minJobs: '1' }, NOW, {}), ...over });
const q = 'from=2000-01-01&to=2999-01-01&minJobs=1';
const css = () => fs.readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');

describe("one customer's page: the heading line, the pinned top block and how it shrinks", () => {
  let S;
  let key;
  let body;
  before(async () => {
    S = await makeSession();
    key = customersPage(S.db, F({ tier: '', mgr: '' })).all.sort((a, b) => b.jobs - a.jobs)[0].key;
    body = (await S.admin.get(`/accuracy/customers/${encodeURIComponent(key)}?${q}`)).body;
  });

  // the left of the date row: [name, tier, account manager, note] on one line, the date line under it
  const lead = () => /<div class="row acc-datebar"><div class="acc-lead">(.*?)<\/div><div class="date-tools">/s.exec(body);

  test('the name, tier, account manager and the shop note share one line; the date line is under them, in the date row', () => {
    const row = lead();
    assert.ok(row, 'the heading sits first in the date row, before the date buttons');
    const m = /^<div class="acc-titlebar"><h1>([^<]*)<\/h1>(.*?)<div class="flash [^"]*acc-flag"[^>]*>(.*?)<\/div><\/div><div class="muted acc-crumbs">(.*)<\/div>$/s.exec(row[1]);
    assert.ok(m, 'name, then tier and manager, then the note, all in the title line, then the date line');
    assert.match(m[2].replace(/<[^>]+>/g, ''), /Tier .*Account Manager:/);
    assert.match(m[4], /Customers<\/a> &rsaquo; .* &middot; 2000-01-01 to 2999-01-01/);
    assert.ok(!body.includes('class="page-head"') && !body.includes('class="acc-org"') && !body.includes('acc-inline"'), 'no separate heading block, tier line or hidden copy any more');
  });

  test('the shop note is just the label and the customer\'s share of jobs off; the shop figure is in its hover text', () => {
    const note = /<div class="flash [^"]*acc-flag" title="([^"]*)">(.*?)<\/div>/s.exec(lead()[1]);
    const text = note[2].replace(/<[^>]+>/g, '');
    assert.match(text, /^(Worse than normal|Better than normal|In line with the shop): \d+(\.\d)?% of jobs off$/);
    assert.ok(!/shop-wide|vs |pts/.test(text));
    const d = customerDetail(S.db, F({ tier: '', mgr: '', internal: false }), key); // the page leaves Internal / Stock jobs out unless asked
    const pct = (n) => `${(n * 100).toFixed(1)}%`;
    assert.ok(text.includes(pct(d.summary.pctOff)));
    assert.ok(note[1].includes(pct(d.shop.pctOff)) && /[+-]\d+(\.\d)? pts/.test(note[1]));
  });

  test('the name, filters and cards are all inside the pinned block; the charts and lists are not', () => {
    const start = body.indexOf('<div class="acc-sticky">');
    const end = body.lastIndexOf('<div', body.indexOf('id="sec-charts"'));
    assert.ok(start > 0 && end > start);
    const pinned = body.slice(start, end);
    for (const part of ['acc-titlebar', 'acc-datebar', 'acc-filters', 'class="tiles tiles-7"', 'Top Root Causes', 'scroll-menu']) assert.ok(pinned.includes(part), part);
    assert.equal((pinned.match(/<div class="acc-sticky">/g) ?? []).length, 1);
    const open = (pinned.match(/<div\b/g) ?? []).length;
    const closed = (pinned.match(/<\/div>/g) ?? []).length;
    assert.equal(open, closed, 'the pinned block is closed right before the charts');
  });

  test('it pins only where it fits: a wide, tall window', () => {
    const m = /@media \(min-width: (\d+)px\) and \(min-height: (\d+)px\) \{\s*\.acc-sticky \{([^}]*)\}/.exec(css());
    assert.ok(m, 'the pinning rule is inside a size query');
    assert.ok(Number(m[1]) >= 1751, 'wider than where the seven cards wrap to two rows');
    assert.ok(Number(m[2]) >= 800);
    assert.match(m[3], /position: sticky/);
    assert.match(m[3], /background: var\(--bg\)/, 'opaque, so the page does not show through');
  });

  test('the Scroll To menu allows for the pinned block', () => {
    const js = fs.readFileSync(new URL('../public/scroll-menu.js', import.meta.url), 'utf8');
    assert.ok(js.includes('.acc-sticky') && js.includes('scrollTopOffset'));
  });

  test('each card carries a one-line layer: SHORT LABEL: value, hidden from screen readers', () => {
    const layers = [...body.matchAll(/<div class="tile-short" aria-hidden="true"><span class="ts-label">([^<]*)<\/span><span class="ts-value">(.*?)<\/span><\/div><div class="label">([^<]*)<\/div><div class="value">(.*?)<\/div>/g)];
    assert.deepEqual(layers.map((m) => [m[3], m[1]]), [
      ['Margin', 'Margin:'],
      ['Margin vs Target $', 'Mar. vs Tar. $:'],
      ['Labour vs Material', 'Lab. vs Mat.:'],
      ['Flagged Jobs', 'Flagged Jobs:'],
      ['Post-Mortems In Progress', 'PMRs In Progress:'],
      ['Completed Post-Mortems', 'Completed PMRs:'],
      ['Top Root Causes', 'Root Causes:'],
    ]);
    for (const m of layers) assert.equal(m[2], m[4], `${m[3]}: the one-line layer shows the same value as the card`);
  });

  test('the shrinking: the cards cross-fade (no change of layout), everything that changes height shares one time and curve', async () => {
    const all = css();
    const at = all.indexOf('@media (min-width: 1751px) and (min-height: 800px)');
    const block = all.slice(at, all.indexOf('@media (prefers-reduced-motion', at));
    for (const rule of ['.acc-sticky.is-compact .tile-short { opacity: 1', '.acc-sticky.is-compact .acc-crumbs { height: 0', '.acc-sticky.is-compact .tiles .tile { height: 36px', '.acc-sticky .tiles .tile { position: relative; height: 106px']) assert.ok(block.includes(rule), rule);
    assert.ok(!/display: flex; align-items: center; gap: 6px; white-space: nowrap; \}\s*\n\s*\.acc-sticky\.is-compact \.tiles \.tile \.l-full/.test(block), 'no layout switch on the card itself');
    assert.ok(!block.includes('@keyframes'), 'transitions, no keyframe jumps');
    const dur = block.match(/transition: [^;]*var\(--acc-dur\) var\(--acc-ease\)/g) ?? [];
    assert.equal(dur.length, 6, 'pin margin, tiles margin, crumbs, cards, the date buttons\' offset and the gap under the heading row: all share one duration and easing');
    assert.match(block, /--acc-dur: \.5s; --acc-ease: cubic-bezier\(/, 'half a second');
    assert.ok(all.includes('prefers-reduced-motion'), 'no animation for people who ask for none');
    assert.match(all, /\.tile \.tile-short \{ display: none; \}/, 'the one-line layer never shows outside the shrunk pinned block');
    assert.ok(body.includes('/static/sticky-compact.js'));
    const js = await S.admin.get('/static/sticky-compact.js');
    assert.equal(js.statusCode, 200);
    for (const part of ['is-compact', 'marginBottom', 'accStickyInfo', "addEventListener('scroll'"]) assert.ok(js.body.includes(part), part);
    assert.ok(fs.readFileSync(new URL('../public/scroll-menu.js', import.meta.url), 'utf8').includes('accStickyInfo'), 'the Scroll To menu knows the shrunk height');
  });

  test('the filter section: Reset and Apply next to the filters; after a divider the page buttons and the Scroll To arrow, all the same height', () => {
    const start = body.indexOf('<div class="filters">');
    const form = body.slice(start, body.indexOf('</form>', start));
    const tools = form.indexOf('class="filter-tools"');
    const at = (needle) => (needle === 'class="filter-sep"' ? form.indexOf(needle, tools) : form.indexOf(needle)); // the divider inside the tools, not the one between the two groups of filters
    const order = ['name="trend"', 'class="filter-actions"', '>Reset<', '>Apply Filters<', 'class="filter-tools"', 'class="filter-sep"', '&larr; All Customers', '>Open in Flagged Jobs<', 'class="scroll-menu"'];
    const where = order.map(at);
    assert.ok(where.every((w) => w >= 0), `all present: ${where}`);
    assert.deepEqual([...where].sort((a, b) => a - b), where, 'in this order, left to right');
    const all = css();
    assert.match(all, /\.filter-actions \.btn, \.acc-filters \.filters \.filter-tools \.btn \{ height: 30px;/, 'the page buttons are the same height as Reset and Apply');
    assert.match(all, /\.scroll-btn \{[^}]*height: 30px/, 'and as the arrow');
    assert.match(all, /\.filter-tools \{ margin-left: auto;/, 'pushed to the far right');
  });

  test('the filter boxes share the whole row (they may grow wider) but stay 30px tall, so the section is no taller', () => {
    const all = css();
    assert.match(all, /\.acc-filters \.filters > label, \.acc-filters \.filters > \.multi-field \{ flex: 1 1 112px; max-width: (\d+)px;/);
    assert.ok(Number(/\.multi-field \{ flex: 1 1 112px; max-width: (\d+)px;/.exec(all)[1]) >= 250, 'room to fill the row');
    assert.match(all, /\.acc-filters \.filters select[^{]*\{[^}]*height: 30px/, 'the same height as before');
  });
});
