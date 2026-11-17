import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COLUMN_HELP, helpKey } from '../src/columnHelp.js';
import { makeSession } from './helpers.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const viewsDir = path.join(root, 'src', 'views');
const keys = Object.keys(COLUMN_HELP);
const hasHelp = (label) => keys.some((k) => k === label || k.endsWith(`.${label}`));

// Headings that say it all themselves.
const SELF_EVIDENT = new Set(['name']);

const decode = (s) => s.replace(/&rarr;/g, '→').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');

/** Static heading texts (those with no template tags) from every page, and the dynamic ones counted separately. */
function viewHeadings() {
  const found = [];
  for (const f of fs.readdirSync(viewsDir).filter((n) => n.endsWith('.njk'))) {
    const src = fs.readFileSync(path.join(viewsDir, f), 'utf8');
    // (a heading is <th> or <th ...>, never <thead>)
    for (const m of src.matchAll(/<th(\s[^>]*)?>(.*?)<\/th>/gs)) {
      const attrs = m[1] ?? '';
      const inner = m[2];
      if (/data-help=|colspan=|hm-head/.test(attrs)) continue; // carries its own text, is a note row, or is a job number in the heat map
      if (/\{\{|\{%/.test(inner)) {
        found.push({ file: f, label: null, raw: inner });
        continue;
      }
      const label = helpKey(decode(inner.replace(/<[^>]*>/g, '')));
      if (label) found.push({ file: f, label });
    }
  }
  return found;
}

describe('column help text', () => {
  test('every column heading in the pages has a description', () => {
    const missing = viewHeadings()
      .filter((h) => h.label && !SELF_EVIDENT.has(h.label) && !hasHelp(h.label))
      .map((h) => `${h.file}: "${h.label}"`);
    assert.deepEqual([...new Set(missing)], [], 'add these to src/columnHelp.js');
  });

  test('every Flagged Jobs grid column has a description', () => {
    const src = fs.readFileSync(path.join(root, 'public', 'job-columns.js'), 'utf8');
    const titles = [...src.matchAll(/title: '([^']+)', field:/g)].map((m) => helpKey(m[1]));
    assert.ok(titles.length >= 15, 'found the grid columns');
    const missing = titles.filter((t) => !(`grid.${t}` in COLUMN_HELP) && !(t in COLUMN_HELP));
    assert.deepEqual(missing, []);
  });

  test('the headings that are built from template tags are covered', () => {
    // Dashboard: "$ over" / "$ under" / "$ impact" depending on the chosen direction
    for (const k of ['$ over', '$ under', '$ impact']) assert.ok(COLUMN_HELP[k], k);
    // the only other dynamic ones carry their own data-help
    for (const h of viewHeadings().filter((x) => x.label === null)) {
      assert.ok(/\$ (over|under|impact)/.test(h.raw) || /Actual \(/.test(h.raw), `unexpected dynamic heading: ${h.raw}`);
    }
    for (const k of ['actual (final)', 'actual (so far)']) assert.ok(COLUMN_HELP[k], k);
  });

  test('every scope a table uses has entries, and entries are readable', () => {
    const used = new Set();
    for (const f of [...fs.readdirSync(viewsDir).map((n) => path.join(viewsDir, n)), path.join(root, 'public', 'job-columns.js')]) {
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/data-help-scope="([^"]+)"/g)) used.add(m[1]);
    }
    assert.ok(used.size >= 6);
    for (const scope of used) assert.ok(keys.some((k) => k.startsWith(`${scope}.`)), `scope "${scope}" has no scoped entries`);
    for (const [k, v] of Object.entries(COLUMN_HELP)) {
      assert.equal(k, k.toLowerCase(), `key "${k}" must be lower case`);
      assert.ok(typeof v === 'string' && v.length > 8 && v.length <= 340, `"${k}": text length ${String(v).length}`);
    }
  });
});

describe('column help setting', () => {
  let S;
  before(async () => {
    S = await makeSession();
  });
  const on = (body) => body.includes('id="columnHelpData"') && body.includes('/static/column-help.js');

  test('on by default, with the descriptions embedded in the page', async () => {
    const r = await S.admin.get('/jobs?from=2000-01-01&to=2999-01-01');
    assert.equal(r.statusCode, 200);
    assert.ok(on(r.body));
    const data = JSON.parse(/id="columnHelpData">(.*?)<\/script>/s.exec(r.body)[1]);
    assert.ok(data['$ impact'].length > 20);
    assert.match(r.body, /id="jobsTable" data-table="jobs-grid" data-help-scope="grid"/);
  });

  test('a person can turn it off and on, and it only affects them', async () => {
    const off = await S.admin.post('/account/column-help', {}); // an unticked checkbox sends nothing
    assert.equal(off.statusCode, 302);
    assert.ok(!on((await S.admin.get('/jobs')).body), 'off for the admin');
    assert.ok(on((await S.reviewer.get('/jobs')).body), 'still on for the reviewer');
    const acct = await S.admin.get('/account');
    assert.ok(!/name="columnHelp"[^>]*checked/.test(acct.body));

    const again = await S.admin.post('/account/column-help', { columnHelp: '1' });
    assert.equal(again.statusCode, 302);
    assert.ok(on((await S.admin.get('/jobs')).body), 'on again');
    assert.match((await S.admin.get('/account')).body, /name="columnHelp"[^>]*checked/);
  });

  test('the setting needs a signed-in person', async () => {
    const { Client } = await import('./helpers.js');
    const anon = new Client(S.admin.app);
    const r = await anon.post('/account/column-help', { columnHelp: '1' });
    assert.notEqual(r.statusCode, 200);
    assert.ok(r.statusCode === 302 || r.statusCode === 401 || r.statusCode === 403);
  });
});

describe('page width setting', () => {
  let S;
  before(async () => {
    S = await makeSession();
  });
  const width = (body) => /<html[^>]*data-width="(\w+)"/.exec(body)?.[1];

  test('full width by default, and each person chooses their own', async () => {
    assert.equal(width((await S.admin.get('/jobs')).body), 'full');
    const r = await S.admin.post('/account/page-width', { pageWidth: 'standard' });
    assert.equal(r.statusCode, 302);
    assert.equal(width((await S.admin.get('/jobs')).body), 'standard');
    assert.equal(width((await S.reviewer.get('/jobs')).body), 'full', 'the reviewer is not affected');
    assert.match((await S.admin.get('/account')).body, /value="standard" checked/);
    await S.admin.post('/account/page-width', { pageWidth: 'wide' });
    assert.equal(width((await S.admin.get('/')).body), 'wide');
  });

  test('anything else is refused', async () => {
    const r = await S.admin.post('/account/page-width', { pageWidth: '99999px' });
    assert.notEqual(r.statusCode, 302);
    assert.equal(width((await S.admin.get('/jobs')).body), 'wide', 'unchanged');
  });
});
