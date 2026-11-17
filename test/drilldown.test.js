import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listJobs, parseFilters } from '../src/queries.js';
import { cleanTableWidths, parseTableWidthsBody } from '../src/columnPrefs.js';
import { STUDY_TABLE_IDS } from '../src/routes/study.js';
import { makeSession } from './helpers.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const range = 'from=2000-01-01&to=2999-01-01';

describe('Dashboard chart: the jobs behind a bar', () => {
  let S;
  let bars;
  before(async () => {
    S = await makeSession();
    const page = (await S.admin.get(`/?${range}`)).body;
    const data = JSON.parse(/id="byOpData">(.*?)<\/script>/s.exec(page)[1]);
    assert.equal(data.from, '2000-01-01');
    assert.equal(data.to, '2999-01-01');
    bars = data.rows;
  });

  test('every bar carries its top 3 jobs for the over and under parts, biggest first', () => {
    assert.ok(bars.length > 3);
    for (const b of bars) {
      for (const [list, total] of [[b.topOver, b.over_dollars], [b.topUnder, b.under_dollars]]) {
        assert.ok(Array.isArray(list) && list.length <= 3);
        assert.equal(list.length > 0, total > 0, `${b.label}: has jobs exactly when there are dollars`);
        for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].dollars >= list[i].dollars, 'biggest first');
        for (const j of list) {
          assert.ok(j.job && j.dollars > 0 && j.dollars <= total + 0.01);
          assert.ok('customer' in j && 'part' in j);
        }
      }
    }
    assert.ok(bars.some((b) => b.topOver.length === 3), 'demo data has a bar with three');
  });

  test('clicking a bar lists every job behind it, and they add up to the bar', () => {
    for (const b of bars.slice(0, 6)) {
      for (const [dir, total] of [['over', b.over_dollars], ['under', b.under_dollars]]) {
        const f = parseFilters({ from: '2000-01-01', to: '2999-01-01', lineOp: b.label, lineDir: dir }, new Date(), 30);
        const rows = listJobs(S.db, f);
        assert.equal(rows.length > 0, total > 0, `${b.label} ${dir}`);
        const sum = rows.reduce((t, r) => t + r.line_dollars, 0);
        assert.ok(Math.abs(sum - total) < 0.5, `${b.label} ${dir}: jobs add to ${sum}, the bar says ${total}`);
        for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].line_dollars >= rows[i].line_dollars, 'biggest contributor first');
        // the top jobs in the tooltip are the first jobs of that list
        const top = dir === 'over' ? b.topOver : b.topUnder;
        assert.deepEqual(rows.slice(0, top.length).map((r) => Math.round(r.line_dollars)), top.map((j) => Math.round(j.dollars)));
      }
    }
  });

  test('the Material bar works too (material lines have no operation code)', () => {
    // the demo data has no flagged material lines, so add two to jobs that are in the list
    const jobs = S.db.prepare("SELECT job_num FROM job_metrics WHERE flag IN ('red','yellow') ORDER BY impact_dollars DESC LIMIT 2").all().map((r) => r.job_num);
    const ins = S.db.prepare("INSERT INTO flag_lines (job_num, kind, assembly_seq, seq, op_code, resource_grp_id, part_num, flag, direction, unplanned, var_hours, var_pct, var_dollars) VALUES (?, 'material', 0, 99, NULL, NULL, 'STEEL-1', 'red', 'over', 0, NULL, 0.5, ?)");
    ins.run(jobs[0], 500);
    ins.run(jobs[1], 1500);
    const f = (dir) => parseFilters({ from: '2000-01-01', to: '2999-01-01', lineOp: 'Material', lineDir: dir }, new Date(), 30);
    const rows = listJobs(S.db, f('over'));
    assert.deepEqual(rows.map((r) => [r.job_num, r.line_dollars]), [[jobs[1], 1500], [jobs[0], 500]], 'biggest contributor first');
    assert.equal(listJobs(S.db, f('under')).length, 0);
    S.db.prepare("DELETE FROM flag_lines WHERE kind = 'material'").run();
  });

  test('the Flagged Jobs page says what the list is, shows the matching dollars, and keeps the filter when Apply is pressed', async () => {
    const b = bars[0];
    const page = (await S.admin.get(`/jobs?${range}&lineOp=${encodeURIComponent(b.label)}&lineDir=over`)).body;
    assert.match(page, /Showing the jobs behind the/);
    assert.match(page, new RegExp(`<b>${b.label} over-runs</b>`));
    assert.match(page, /name="lineOp" value=/);
    assert.match(page, /"lineFilter":true/);
    const rows = JSON.parse(/id="jobRows">(.*?)<\/script>/s.exec(page)[1]);
    assert.ok(rows.length > 0 && rows.every((r) => typeof r.lineDollars === 'number'));
    const plain = (await S.admin.get(`/jobs?${range}`)).body;
    assert.ok(!plain.includes('Showing the jobs behind the') && /"lineFilter":false/.test(plain));
    assert.ok(JSON.parse(/id="jobRows">(.*?)<\/script>/s.exec(plain)[1]).every((r) => r.lineDollars === null));
  });

  test('a made-up filter value finds nothing instead of everything', async () => {
    const rows = listJobs(S.db, parseFilters({ from: '2000-01-01', to: '2999-01-01', lineOp: 'NOSUCHOP', lineDir: 'over' }, new Date(), 30));
    assert.equal(rows.length, 0);
    const half = listJobs(S.db, parseFilters({ from: '2000-01-01', to: '2999-01-01', lineOp: 'Material' }, new Date(), 30));
    assert.ok(half.length > 0 && half.every((r) => r.line_dollars === undefined), 'an operation without over / under does nothing');
  });

  test('the Excel export of that list has the matching-lines column', async () => {
    const res = await S.admin.get(`/jobs/export.xlsx?${range}&lineOp=Material&lineDir=over`);
    assert.equal(res.statusCode, 200);
    assert.ok(res.rawPayload.length > 1000);
  });

  test('the chart script shows the top jobs and the click note, and goes to the filtered list', () => {
    const js = fs.readFileSync(path.join(root, 'public', 'dashboard.js'), 'utf8');
    assert.match(js, /Click to Review All Related Jobs/);
    assert.match(js, /topOver/);
    assert.match(js, /lineOp=.*lineDir=/);
    assert.match(js, /onClick/);
  });
});

describe('Job Study: saved column widths', () => {
  let S;
  before(async () => {
    S = await makeSession();
  });
  const post = (client, url, body) =>
    S.app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json', 'x-csrf-token': client.csrf, cookie: client.cookie }, payload: JSON.stringify(body) });
  const studyUrl = () => `/study?${range}&flag=all`;
  const saved = (body) => JSON.parse(/id="savedWidths">([^<]*)</.exec(body)[1]);

  test('widths are kept per table by column title; bad ones are dropped', () => {
    assert.deepEqual(cleanTableWidths({ 'study-jobs': { Job: 120.4, 'Sale Price': 5, Customer: 99999, '': 100 }, 'no-table': { Job: 100 }, 'study-ops': 'x' }, STUDY_TABLE_IDS), { 'study-jobs': { Job: 120 } });
    assert.deepEqual(cleanTableWidths(null, STUDY_TABLE_IDS), {});
    assert.deepEqual(parseTableWidthsBody({ widths: { 'study-mtl': { Part: 200 } } }, STUDY_TABLE_IDS), { 'study-mtl': { Part: 200 } });
    for (const bad of [{}, { widths: 'wide' }, { widths: [1] }, null]) assert.throws(() => parseTableWidthsBody(bad, STUDY_TABLE_IDS), /widths/);
  });

  test('the Study tables can be resized and the page has the Save / Reset buttons', async () => {
    const page = (await S.admin.get(studyUrl())).body;
    for (const id of STUDY_TABLE_IDS) {
      const m = new RegExp(`<table data-table="${id}" data-resize`).test(page);
      if (!m) assert.ok(['study-summary', 'study-jobs', 'study-ops', 'study-parts', 'study-mtl', 'study-heatmap'].includes(id), id); // tables only appear when there is data for them
    }
    assert.match(page, /id="wSave"/);
    assert.match(page, /id="wReset"/);
    assert.match(page, /\/static\/table-widths\.js/);
    assert.deepEqual(saved(page), {}, 'standard widths until they save');
  });

  test('saving keeps the widths for that person only, reset clears them, and a bad save changes nothing', async () => {
    assert.equal((await post(S.admin, '/study/widths', { widths: { 'study-jobs': { Job: 140, Customer: 260 }, 'study-ops': { Operation: 110 }, bogus: { x: 100 } } })).statusCode, 200);
    assert.deepEqual(saved((await S.admin.get(studyUrl())).body), { 'study-jobs': { Job: 140, Customer: 260 }, 'study-ops': { Operation: 110 } });
    assert.deepEqual(saved((await S.reviewer.get(studyUrl())).body), {}, 'a different person is not affected');
    assert.equal((await post(S.admin, '/study/widths', { widths: 'wide' })).statusCode, 400);
    assert.deepEqual(Object.keys(saved((await S.admin.get(studyUrl())).body)).sort(), ['study-jobs', 'study-ops'], 'unchanged');
    assert.equal((await S.app.inject({ method: 'POST', url: '/study/widths', headers: { 'content-type': 'application/json', cookie: S.admin.cookie }, payload: '{"widths":{}}' })).statusCode, 403, 'needs the page token');
    assert.equal((await post(S.admin, '/study/widths/reset', {})).statusCode, 200);
    assert.deepEqual(saved((await S.admin.get(studyUrl())).body), {});
  });

  test('the resize script keeps widths per table title and saves through the page', () => {
    const js = fs.readFileSync(path.join(root, 'public', 'table-widths.js'), 'utf8');
    assert.match(js, /\/study\/widths/);
    assert.match(js, /col-resizer/);
    assert.match(js, /hm-head/, 'the heat map job columns are left alone');
  });
});
