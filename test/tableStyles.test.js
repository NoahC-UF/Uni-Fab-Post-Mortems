import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TABLES, TABLE_IDS, cleanStyle, normaliseTableStyles, parseTableStyleForm, tableStyleCss } from '../src/tableStyles.js';
import { getSettings } from '../src/settings.js';
import { makeSession } from './helpers.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('table appearance: the saved style', () => {
  test('only what is changed is kept; bad values are dropped', () => {
    assert.equal(cleanStyle(null), null);
    assert.equal(cleanStyle({}), null);
    assert.equal(cleanStyle({ fontSize: 3, colWidth: 99999, rowLines: { mode: 'sideways' } }), null, 'out of range or unknown = not changed');
    assert.deepEqual(cleanStyle({ fontSize: '15', colWidth: 120 }), { fontSize: 15, colWidth: 120 });
    assert.deepEqual(cleanStyle({ rowLines: { mode: 'off' }, colLines: { mode: 'on', size: 2, color: '#AABBCC' } }), {
      rowLines: { mode: 'off' },
      colLines: { mode: 'on', size: 2, color: '#aabbcc' },
    });
    assert.deepEqual(cleanStyle({ cellLines: { mode: 'on', size: 99, color: 'red; background:url(x)' } }), { cellLines: { mode: 'on', size: 1, color: null } }, 'a colour must be #rrggbb');
  });

  test('unknown tables are dropped', () => {
    const n = normaliseTableStyles({ 'jobs-grid': { fontSize: 14 }, 'no-such-table': { fontSize: 14 }, 'job-ops': {} });
    assert.deepEqual(n, { 'jobs-grid': { fontSize: 14 } });
    assert.deepEqual(normaliseTableStyles(null), {});
  });

  test('the form is checked, and a blank form means "standard"', () => {
    assert.deepEqual(parseTableStyleForm({ table: 'job-ops', fontSize: '', colWidth: '', rowMode: 'standard', colMode: 'standard', cellMode: 'standard' }), { id: 'job-ops', style: null });
    assert.deepEqual(
      parseTableStyleForm({ table: 'job-ops', fontSize: '16', colWidth: '110', rowMode: 'on', rowSize: '2', rowColor: '#112233', colMode: 'off', cellMode: 'standard' }),
      { id: 'job-ops', style: { fontSize: 16, colWidth: 110, rowLines: { mode: 'on', size: 2, color: '#112233' }, colLines: { mode: 'off' } } },
    );
    assert.deepEqual(parseTableStyleForm({ table: 'job-ops', rowMode: 'on', rowSize: '', rowColor: '' }).style, { rowLines: { mode: 'on', size: 1, color: null } }, 'blank size = 1, blank colour = theme');
    for (const bad of [{ table: 'nope' }, {}, { table: 'job-ops', fontSize: '99' }, { table: 'job-ops', colWidth: 'wide' }, { table: 'job-ops', rowMode: 'on', rowSize: '40' }, { table: 'job-ops', rowMode: 'maybe' }, { table: 'job-ops', cellMode: 'on', cellColor: 'blue' }]) {
      assert.throws(() => parseTableStyleForm(bad), Error, JSON.stringify(bad));
    }
  });

  test('the page CSS has one rule per changed table and nothing else', () => {
    assert.equal(tableStyleCss({}), '');
    const css = tableStyleCss({
      'jobs-grid': { fontSize: 15, colWidth: 120, rowLines: { mode: 'on', size: 2, color: '#aabbcc' }, colLines: { mode: 'off' }, cellLines: { mode: 'on', size: 1, color: null } },
      'job-ops': { rowLines: { mode: 'off' } },
    });
    const lines = css.split('\n');
    assert.equal(lines.length, 2);
    assert.equal(lines[0], '[data-table="jobs-grid"]{--tbl-font:15px;--tbl-font-th:12.3px;--tbl-chip-font:12.8px;--tbl-tag-font:12px;--tbl-btn-font:13.5px;--tbl-sub-font:13.5px;--tbl-dot:15px;--tbl-colw:120px;--tbl-row-w:2px;--tbl-row-c:#aabbcc;--tbl-col-w:0px;--tbl-cell-w:1px}');
    assert.equal(lines[1], '[data-table="job-ops"]{--tbl-row-w:0px}');
    assert.ok(!/[<>{}]\s*[<>]|url\(|expression/.test(tableStyleCss({ 'job-ops': { cellLines: { mode: 'on', color: 'x' } } })), 'nothing but numbers and #rrggbb can get in');
  });
});

describe('every table can be styled', () => {
  test('each table the pages draw has an id in the list, and each id in the list is drawn somewhere', () => {
    const used = new Set();
    for (const f of [...fs.readdirSync(path.join(root, 'src', 'views')).map((n) => path.join(root, 'src', 'views', n))]) {
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/data-table="([^"]+)"/g)) used.add(m[1]);
    }
    for (const id of used) assert.ok(TABLE_IDS.includes(id), `${id} is not in TABLES`);
    for (const id of TABLE_IDS) assert.ok(used.has(id), `${id} is in TABLES but no page uses it`);
  });

  test('no table is left out: every <table class="t"> and grid has a data-table', () => {
    for (const n of fs.readdirSync(path.join(root, 'src', 'views'))) {
      const src = fs.readFileSync(path.join(root, 'src', 'views', n), 'utf8');
      for (const m of src.matchAll(/<table\b[^>]*>/g)) {
        if (/:style=/.test(m[0])) continue; // the live preview on the Settings page: it takes its look from the form
        assert.match(m[0], /data-table="/, `${n}: ${m[0]}`);
      }
    }
  });

  test('names are in Title Case and ids are unique', () => {
    assert.equal(new Set(TABLE_IDS).size, TABLES.length);
    for (const t of TABLES) assert.match(t.label, /^[A-Z0-9]/, t.label);
  });
});

describe('Settings: table appearance', () => {
  let S;
  before(async () => {
    S = await makeSession();
  });
  const saved = () => getSettings(S.db).tableStyles;

  test('nothing is changed to begin with, and pages carry no table CSS', async () => {
    assert.deepEqual(saved(), {});
    assert.ok(!(await S.admin.get('/jobs')).body.includes('id="tableStyles"'));
  });

  test('the Settings page has the dropdown, with every table', async () => {
    const page = (await S.admin.get('/settings')).body;
    assert.match(page, /id="table-appearance"/);
    for (const t of TABLES) assert.ok(page.includes(`<option value="${t.id}">`), t.id);
    assert.match(page, /name="rowMode"/);
    assert.match(page, /name="fontSize"/);
    assert.match((await S.admin.get('/settings?table=job-ops')).body, /x-data="\{ table: 'job-ops' \}"/);
  });

  test('an Admin saves one table; it shows on every page for everyone, and only for that table', async () => {
    const r = await S.admin.post('/settings/table-styles', { table: 'job-ops', fontSize: '15', colWidth: '110', rowMode: 'off', colMode: 'on', colSize: '1', colColor: '#445566', cellMode: 'standard' });
    assert.equal(r.statusCode, 302);
    assert.match(r.headers.location, /table=job-ops/);
    assert.deepEqual(saved(), { 'job-ops': { fontSize: 15, colWidth: 110, rowLines: { mode: 'off' }, colLines: { mode: 'on', size: 1, color: '#445566' } } });
    for (const client of [S.admin, S.reviewer]) {
      const body = (await client.get('/jobs')).body;
      assert.match(body, /<style id="tableStyles">\[data-table="job-ops"\]\{--tbl-font:15px;--tbl-font-th:12.3px;--tbl-chip-font:12.8px;--tbl-tag-font:12px;--tbl-btn-font:13.5px;--tbl-sub-font:13.5px;--tbl-dot:15px;--tbl-colw:110px;--tbl-row-w:0px;--tbl-col-w:1px;--tbl-col-c:#445566\}<\/style>/);
      assert.ok(!body.includes('data-table="jobs-grid"]'), 'other tables are untouched');
    }
    assert.match((await S.admin.get('/settings?table=job-ops')).body, /\(changed\)/);
  });

  test('saving a second table keeps the first; a blank form puts a table back to standard', async () => {
    await S.admin.post('/settings/table-styles', { table: 'jobs-grid', fontSize: '13', rowMode: 'standard', colMode: 'standard', cellMode: 'on', cellSize: '1' });
    assert.deepEqual(Object.keys(saved()).sort(), ['job-ops', 'jobs-grid']);
    await S.admin.post('/settings/table-styles', { table: 'jobs-grid', fontSize: '', colWidth: '', rowMode: 'standard', colMode: 'standard', cellMode: 'standard' });
    assert.deepEqual(Object.keys(saved()), ['job-ops']);
  });

  test('"Back to standard" removes a table\'s changes', async () => {
    const r = await S.admin.post('/settings/table-styles/reset', { table: 'job-ops' });
    assert.equal(r.statusCode, 302);
    assert.deepEqual(saved(), {});
    assert.ok(!(await S.admin.get('/jobs')).body.includes('id="tableStyles"'));
  });

  test('a bad value is refused and changes nothing; Reviewers cannot change it', async () => {
    const before = JSON.stringify(saved());
    assert.equal((await S.admin.post('/settings/table-styles', { table: 'job-ops', fontSize: '200' })).statusCode, 400);
    assert.equal((await S.admin.post('/settings/table-styles', { table: 'nope', fontSize: '14' })).statusCode, 400);
    assert.equal((await S.admin.post('/settings/table-styles', { table: 'job-ops', cellMode: 'on', cellColor: 'javascript:1' })).statusCode, 400);
    assert.equal(JSON.stringify(saved()), before);
    assert.equal((await S.reviewer.post('/settings/table-styles', { table: 'job-ops', fontSize: '14' })).statusCode, 403);
    assert.equal((await S.reviewer.post('/settings/table-styles/reset', { table: 'job-ops' })).statusCode, 403);
    assert.equal(JSON.stringify(saved()), before);
  });
});

describe('the stylesheet reads the settings', () => {
  const css = fs.readFileSync(path.join(root, 'public', 'app.css'), 'utf8');
  test('HTML tables and grids both use every variable the page can set', () => {
    for (const v of ['--tbl-font', '--tbl-font-th', '--tbl-chip-font', '--tbl-tag-font', '--tbl-btn-font', '--tbl-sub-font', '--tbl-dot', '--tbl-colw', '--tbl-row-w', '--tbl-row-c', '--tbl-col-w', '--tbl-col-c', '--tbl-cell-w', '--tbl-cell-c']) {
      assert.ok(css.includes(`var(${v}`), `${v} is used`);
      assert.ok(css.includes(`${v}: initial`), `${v} starts unset on each table`);
    }
    assert.match(css, /body \.tabulator \.tabulator-row \.tabulator-cell \{[^}]*var\(--tbl-col-w/);
    assert.match(css, /table\.t td \{[^}]*var\(--tbl-row-w/);
  });
});
