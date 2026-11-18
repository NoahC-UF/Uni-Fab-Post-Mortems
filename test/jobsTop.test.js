import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeSession } from './helpers.js';

const q = 'from=2000-01-01&to=2999-01-01';
const css = () => fs.readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');

describe('the Flagged Jobs page has the same pinned, shrinking top block as the Accuracy pages', () => {
  let S;
  let body;
  before(async () => {
    S = await makeSession();
    body = (await S.admin.get(`/jobs?${q}&flag=all`)).body;
  });

  test('the heading and the match count are at the left of the date row, with the quick date buttons and the dates at the right', () => {
    const m = /<div class="row acc-datebar"><div class="acc-lead">(.*?)<\/div><div class="date-tools">(.*?)<\/div><\/div>\s*<div class="card acc-filters">/s.exec(body);
    assert.ok(m, 'the heading sits first in the date row, before the date buttons');
    assert.match(m[1], /^<div class="acc-titlebar"><h1>Flagged Jobs<\/h1><\/div><div class="muted acc-crumbs">\d+ jobs? match\. Ranked by total \$ impact \(labour \+ material\), biggest first\.<\/div>$/);
    assert.ok(m[2].includes('Last 30 days') && m[2].includes('name="from"') && m[2].includes('name="to"'));
    assert.ok(!body.includes('class="page-head"'), 'no separate heading block any more');
    assert.equal((body.match(/name="from"/g) ?? []).length, 1, 'the dates are in the date row only, not repeated in the filters');
  });

  test('the quick date buttons change the dates and keep every other filter', async () => {
    const page = (await S.admin.get(`/jobs?${q}&flag=red&direction=over&part=FRAME&minImpact=100`)).body;
    const bar = /<div class="date-tools">(.*?)<\/div>/s.exec(page)[1];
    const links = [...bar.matchAll(/href="([^"]*)"/g)].map((x) => x[1].replace(/&amp;/g, '&'));
    assert.ok(links.length >= 5);
    for (const href of links) {
      const p = new URL(href, 'http://x').searchParams;
      assert.equal(p.get('flag'), 'red', href);
      assert.equal(p.get('direction'), 'over', href);
      assert.equal(p.get('part'), 'FRAME', href);
      assert.equal(p.get('minImpact'), '100', href);
      assert.ok(href.startsWith('/jobs?'));
    }
    const target = await S.admin.get(links[0]);
    assert.equal(target.statusCode, 200);
  });

  test('the heading, dates and filters are pinned; the note from the Dashboard chart and the table are not', async () => {
    const start = body.indexOf('<div class="acc-sticky">');
    const end = body.indexOf('id="sec-jobs"');
    assert.ok(start > 0 && end > start);
    const pinned = body.slice(start, end);
    for (const part of ['acc-titlebar', 'acc-datebar', 'acc-filters', 'name="status"', 'name="pm"', 'scroll-menu']) assert.ok(pinned.includes(part), part);
    assert.ok(!pinned.includes('id="jobsTable"') && !pinned.includes('id="jobRows"'));
    assert.equal((pinned.match(/<div class="acc-sticky">/g) ?? []).length, 1);

    const clicked = (await S.admin.get(`/jobs?${q}&flag=all&lineOp=WELD&lineDir=over`)).body;
    const pin = clicked.slice(clicked.indexOf('<div class="acc-sticky">'), clicked.indexOf('id="sec-jobs"'));
    assert.ok(clicked.includes('line-filter') && !pin.slice(0, pin.indexOf('</form>')).includes('class="flash'), 'the note about the bar you clicked is outside the pinned block');
    assert.ok(clicked.indexOf('line-filter') > clicked.indexOf('</form>'), 'below the filters');
    assert.ok(/<input type="hidden" name="lineOp" value="WELD"><input type="hidden" name="lineDir" value="over">/.test(clicked), 'Apply keeps the bar filter');
    assert.match(clicked, /Ranked by the dollars each put into the bar you clicked/);
  });

  test('every filter is still there', () => {
    for (const n of ['status', 'flag', 'direction', 'cause', 'cust', 'op', 'rg', 'part', 'job', 'minImpact', 'pm', 'noOrder', 'opFlagged', 'rgFlagged']) assert.ok(body.includes(`name="${n}"`), n);
  });

  test('Reset and Apply sit right after the filters; after a divider the Excel export button and the Scroll To arrow', () => {
    const start = body.indexOf('<div class="filters">');
    const form = body.slice(start, body.indexOf('</form>', start));
    const tools = form.indexOf('class="filter-tools"');
    const at = (needle) => (needle === 'class="filter-sep"' ? form.indexOf(needle, tools) : form.indexOf(needle));
    const where = ['name="pm"', 'name="noOrder"', 'class="filter-actions"', '>Reset<', '>Apply Filters<', 'class="filter-tools"', 'class="filter-sep"', '>&#8681; Excel<', 'class="scroll-menu"'].map(at);
    assert.ok(where.every((w) => w >= 0), `all present: ${where}`);
    assert.deepEqual([...where].sort((a, b) => a - b), where, 'in this order, left to right');
    assert.match(form, /<a class="btn" href="\/jobs\/export\.xlsx[^"]*"[^>]*>/, 'a full-size button');
  });

  test('Include Jobs With No Sales Order is in an Other Options drop-down, like the Accuracy pages, and keeps its state', async () => {
    assert.match(body, /Other Options\s*<div class="multi" x-data="\{ open: false, noOrder: false/);
    assert.ok(body.includes('None Selected') && body.includes('Include Jobs With No Sales Order'));
    const on = (await S.admin.get(`/jobs?${q}&flag=all&noOrder=1`)).body;
    assert.match(on, /noOrder: true/);
    assert.ok(on.includes('1 Selected'));
    assert.match(on, /name="noOrder" value="1" x-model="noOrder" checked/);
  });

  test('the table is a section of its own for Scroll To, with and without matching jobs', async () => {
    assert.ok(body.includes('id="sec-jobs"') && body.includes('id="jobsTable"'));
    assert.match(body, /scrollMenu\('sec-top','sec-jobs'\)|scrollMenu\(\['sec-top','sec-jobs'\]\)/);
    const none = (await S.admin.get(`/jobs?${q}&part=NO-SUCH-PART-ANYWHERE`)).body;
    assert.ok(none.includes('No jobs match these filters') && none.includes('id="sec-jobs"'));
    assert.ok(/data-sections="sec-top,sec-jobs"/.test(body), 'scroll memory knows the sections');
  });

  test('it loads the shrinking, Scroll To and scroll-memory scripts (and still the grid\'s)', () => {
    for (const s of ['/static/sticky-compact.js', '/static/scroll-menu.js', '/static/scroll-memory.js', '/static/multi-select.js', '/static/job-columns.js', '/static/jobs-table.js']) assert.ok(body.includes(s), s);
  });

  test('the Op Code and Resource Group filters (with their own Flagged tick box) are sized like the other boxes', () => {
    const all = css();
    assert.match(all, /\.acc-filters \.filters > \.field \{ flex: 1 1 112px; max-width: 320px;/);
    assert.match(all, /\.acc-filters \.field-head \.check\.mini \{/);
  });
});
