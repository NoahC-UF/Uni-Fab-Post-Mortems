import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normaliseColumnPref, parseColumnPrefBody } from '../src/columnPrefs.js';
import { GRID_COLUMNS } from '../src/gridRows.js';
import { setPref } from '../src/prefs.js';
import { makeSession } from './helpers.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALL = ['a', 'b', 'c', 'd'];

describe('saved columns: which are shown, and in what order', () => {
  test('an older save (just the shown list) still loads, in the standard order', () => {
    assert.deepEqual(normaliseColumnPref(['c', 'a'], ALL), { visible: ['c', 'a'], order: ['a', 'b', 'c', 'd'], widths: {} });
  });

  test('a new save keeps the order; unknown fields are dropped; columns added later go last', () => {
    assert.deepEqual(normaliseColumnPref({ visible: ['c', 'a', 'zzz'], order: ['c', 'a', 'zzz', 'b'] }, ALL), { visible: ['c', 'a'], order: ['c', 'a', 'b', 'd'], widths: {} });
  });

  test('nothing usable means the standard columns', () => {
    for (const bad of [null, undefined, [], {}, 'x', { visible: [] }, { visible: ['nope'] }]) assert.equal(normaliseColumnPref(bad, ALL), null, JSON.stringify(bad));
  });

  test('a save request is checked', () => {
    assert.deepEqual(parseColumnPrefBody({ columns: ['b'], order: ['d', 'b', 'a', 'c'] }, ALL), { visible: ['b'], order: ['d', 'b', 'a', 'c'], widths: {} });
    assert.deepEqual(parseColumnPrefBody({ columns: ['b', 'b'] }, ALL), { visible: ['b'], order: ALL, widths: {} }, 'no order sent = the standard order');
    for (const bad of [{}, { columns: [] }, { columns: ['x'] }, { columns: ['a'], order: 'a' }, { columns: ['a'], order: ['a', 'x'] }, { columns: ALL.concat('a') }]) {
      assert.throws(() => parseColumnPrefBody(bad, ALL), /column/i, JSON.stringify(bad));
    }
  });

  test('widths are kept for real columns, as whole numbers in range', () => {
    assert.deepEqual(normaliseColumnPref({ visible: ['a'], order: ALL, widths: { a: 120.4, b: 5, c: 99999, zzz: 100, d: 'wide' } }, ALL).widths, { a: 120 });
    assert.deepEqual(normaliseColumnPref({ visible: ['a'], widths: [100] }, ALL).widths, {}, 'a list is not a set of widths');
    assert.deepEqual(parseColumnPrefBody({ columns: ['a', 'b'], widths: { a: 200, b: 90 } }, ALL).widths, { a: 200, b: 90 });
    assert.throws(() => parseColumnPrefBody({ columns: ['a'], widths: 'wide' }, ALL), /widths/);
    assert.throws(() => parseColumnPrefBody({ columns: ['a'], widths: [1] }, ALL), /widths/);
  });

  test('the column list in the browser script matches the server list', () => {
    const js = fs.readFileSync(path.join(root, 'public', 'job-columns.js'), 'utf8');
    const fields = [...js.matchAll(/title: '[^']+', field: '(\w+)'/g)].map((m) => m[1]);
    assert.deepEqual(fields.slice().sort(), GRID_COLUMNS.slice().sort());
  });
});

describe('column choices on the pages', () => {
  let S;
  before(async () => {
    S = await makeSession();
  });
  const post = (client, url, body) =>
    S.app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json', 'x-csrf-token': client.csrf, cookie: client.cookie }, payload: JSON.stringify(body) });
  const colPrefs = (body) => JSON.parse(/id="colPrefs">([^<]*)</.exec(body)[1]);
  const jobsUrl = '/jobs?from=2000-01-01&to=2100-01-01';
  const dashUrl = '/?from=2000-01-01&to=2999-01-01';

  test('Flagged Jobs remembers the order as well as the choice', async () => {
    const order = ['impact', 'job', 'flag', 'customer'];
    const full = [...order, ...GRID_COLUMNS.filter((c) => !order.includes(c))];
    assert.equal((await post(S.admin, '/jobs/columns', { columns: order, order: full })).statusCode, 200);
    const saved = colPrefs((await S.admin.get(jobsUrl)).body);
    assert.deepEqual(saved.visible, order);
    assert.deepEqual(saved.order.slice(0, 4), order);
    assert.equal(saved.order.length, GRID_COLUMNS.length);
    assert.equal(colPrefs((await S.reviewer.get(jobsUrl)).body), null, 'a different person is not affected');
  });

  test('the widths a person set are saved with the columns, on both tables', async () => {
    for (const [save, url] of [['/jobs/columns', jobsUrl], ['/dashboard/columns', dashUrl]]) {
      assert.equal((await post(S.admin, save, { columns: ['job', 'customer', 'miss'], widths: { customer: 260, miss: 210, bogus: 5, job: 7 } })).statusCode, 200);
      assert.deepEqual(colPrefs((await S.admin.get(url)).body).widths, { customer: 260, miss: 210 }, 'only real columns and sensible widths');
      assert.equal((await post(S.admin, save, { columns: ['job'], widths: 'wide' })).statusCode, 400);
      assert.deepEqual(colPrefs((await S.admin.get(url)).body).widths, { customer: 260, miss: 210 }, 'a bad save changes nothing');
      assert.equal((await post(S.admin, save + '/reset', {})).statusCode, 200);
      assert.equal(colPrefs((await S.admin.get(url)).body), null);
    }
  });

  test('a save from before column order existed still opens', async () => {
    const id = S.db.prepare("SELECT id FROM users WHERE username = 'rev'").get().id;
    setPref(S.db, id, 'jobs.columns', ['job', 'net']);
    const saved = colPrefs((await S.reviewer.get(jobsUrl)).body);
    assert.deepEqual(saved.visible, ['job', 'net']);
    assert.deepEqual(saved.order, GRID_COLUMNS);
  });

  test('the Dashboard Top 10 is a table with the same columns, saved separately', async () => {
    const page = (await S.admin.get(dashUrl)).body;
    assert.match(page, /id="topJobs"/);
    assert.match(page, /id="colPicker"/, 'has the Columns menu');
    const rows = JSON.parse(/id="jobRows">(.*?)<\/script>/s.exec(page)[1]);
    assert.ok(rows.length > 0 && rows.length <= 10);
    for (const f of ['job', 'part', 'customer', 'flag', 'impact', 'over', 'under', 'net', 'miss', 'price', 'plannedMarginPct', 'actualMarginPct', 'causeLabel', 'pmStatus', 'state', 'closedDate', 'lines']) {
      assert.ok(f in rows[0], `row has ${f}`);
    }
    assert.equal(JSON.parse(/id="gridMeta">([^<]*)</.exec(page)[1]).dir, '');
    assert.equal(JSON.parse(/id="gridMeta">([^<]*)</.exec((await S.admin.get(`${dashUrl}&dir=over`)).body)[1]).dir, 'over');
    assert.equal(colPrefs(page), null);

    assert.equal((await post(S.admin, '/dashboard/columns', { columns: ['job', 'price'], order: ['price', 'job'] })).statusCode, 200);
    const saved = colPrefs((await S.admin.get(dashUrl)).body);
    assert.deepEqual(saved.visible, ['job', 'price']);
    assert.deepEqual(saved.order.slice(0, 2), ['price', 'job']);
    await post(S.admin, '/jobs/columns', { columns: ['job', 'flag', 'impact', 'customer'] });
    assert.equal(colPrefs((await S.admin.get(jobsUrl)).body).visible.length, 4, 'the Flagged Jobs choice is separate');
    assert.deepEqual(colPrefs((await S.admin.get(dashUrl)).body).visible, ['job', 'price'], 'and saving it did not touch the Dashboard one');
    assert.equal(colPrefs((await S.reviewer.get(dashUrl)).body), null, 'a different person is not affected');

    assert.equal((await post(S.admin, '/dashboard/columns', { columns: ['job', 'passwordHash'] })).statusCode, 400);
    assert.equal((await post(S.admin, '/dashboard/columns', { columns: [] })).statusCode, 400);
    assert.deepEqual(colPrefs((await S.admin.get(dashUrl)).body).visible, ['job', 'price'], 'a bad save changes nothing');
    assert.equal((await post(S.admin, '/dashboard/columns/reset', {})).statusCode, 200);
    assert.equal(colPrefs((await S.admin.get(dashUrl)).body), null);
  });
});
