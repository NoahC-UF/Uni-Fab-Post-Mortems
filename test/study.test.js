import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { quantityNote } from '../src/quantity.js';
import { buildStudy, MATRIX_MAX_JOBS } from '../src/study.js';
import { getEngineConfig, getSettings, setSettings } from '../src/settings.js';
import { recomputeJobs } from '../src/metrics.js';
import { buildJobView } from '../src/jobView.js';
import { makeSession } from './helpers.js';

const op = (opCode, completed, extra = {}) => ({ opCode, subcontract: false, qty: { completed }, ...extra });
const res = (ops, over = {}) => ({
  jobState: 'closed',
  job: { qtyCompleted: 70, prodQty: 35 },
  ops,
  materials: [{ normalized: true }],
  ...over,
});

describe('quantity that disagrees', () => {
  test('the job says 70 but every operation but the last made 35', () => {
    const n = quantityNote(res([op('PROGRAM', 35), op('LASER', 35), op('WELDT', 35), op('PACK', 70)]));
    assert.ok(n);
    assert.deepEqual(n.oddOps, ['PACK (70)']);
    assert.equal(n.typicalQty, 35);
    assert.match(n.text, /70 were made \(35 ordered\)/);
    assert.match(n.text, /most operations completed 35/);
    assert.match(n.text, /scaled/);
  });
  test('nothing to say when the quantities agree, the job is open, or there is no data', () => {
    assert.equal(quantityNote(res([op('A', 70), op('B', 70)])), null);
    assert.equal(quantityNote(res([op('A', 35), op('B', 70)], { jobState: 'open' })), null);
    assert.equal(quantityNote(res([])), null);
    assert.equal(quantityNote(res([op('A', 70)], { job: { qtyCompleted: 0, prodQty: 35 } })), null);
  });
  test('subcontract operations are ignored', () => {
    assert.equal(quantityNote(res([op('A', 70), op('B', 70), { ...op('S', 5), subcontract: true }])), null);
  });
});

describe('study across jobs', () => {
  let S;
  let study;
  let jobNums;
  before(async () => {
    S = await makeSession();
    jobNums = S.db.prepare('SELECT job_num FROM jobs WHERE closed = 1 AND order_num IS NOT NULL ORDER BY job_num').all().map((r) => r.job_num);
    study = buildStudy(S.db, jobNums, getEngineConfig(S.db), { targetMarginPct: 20, baseCurrency: 'CAD' });
  });

  test('one row per job, with totals that add up', () => {
    assert.equal(study.jobs.length, jobNums.length);
    assert.equal(study.totals.jobs, jobNums.length);
    const priced = study.jobs.filter((j) => j.price !== null);
    const price = priced.reduce((t, j) => t + j.price, 0);
    assert.ok(Math.abs(study.totals.price - price) < 0.05);
    const cost = priced.reduce((t, j) => t + j.actualCost, 0);
    assert.ok(Math.abs(study.totals.actualMargin - (price - cost)) < 0.05);
    assert.ok(Math.abs(study.totals.actualMarginPct - (price - cost) / price) < 0.0001);
    for (const j of study.jobs.slice(0, 10)) assert.equal(j.cause, buildJobView(S.db, j.jobNum).economics.verdict.code, 'matches the job page');
  });

  test('operations are totalled across jobs, biggest dollar impact first, with a pattern reading', () => {
    assert.ok(study.operations.length >= 6);
    const sorted = study.operations.map((o) => Math.abs(o.varDollars));
    assert.deepEqual(sorted, [...sorted].sort((a, b) => b - a));
    const weld = study.operations.find((o) => o.opCode === 'WELD');
    assert.ok(weld && weld.jobs > 10);
    assert.ok(Math.abs(weld.varHours - (weld.actualHours - weld.expectedHours)) < 0.05);
    // (over / under count operations, so a job with two WELD operations counts twice; Jobs counts each job once)
    assert.ok(study.operations.every((o) => typeof o.pattern === 'string' && o.pattern.length > 0));
  });

  test('a steady pattern is called out only when most jobs agree', () => {
    // the demo data is built so WELD usually runs over; the reading must not be "Mixed" if 3/4 of jobs are over by 10%+
    const weld = study.operations.find((o) => o.opCode === 'WELD');
    if (weld.jobsOver / (weld.jobsOver + weld.jobsUnder) >= 0.75 && Math.abs(weld.medianVarPct) >= 0.1) assert.match(weld.pattern, /^Usually/);
    else assert.doesNotMatch(weld.pattern, /^Usually/);
  });

  test('operations: hours multiple, jobs over, and share of the net overrun', () => {
    const weld = study.operations.find((o) => o.opCode === 'WELD');
    assert.ok(Math.abs(weld.hoursMultiple - weld.actualHours / weld.expectedHours) < 0.01);
    assert.ok(weld.jobsOver + weld.jobsUnder <= weld.jobs, 'each job counts once per operation');
    const net = study.operations.reduce((t, o) => t + o.varDollars, 0);
    assert.ok(Math.abs(study.netOpVar - net) < 0.05);
    if (study.netOpVar > 0) assert.ok(Math.abs(weld.shareOfNet - weld.varDollars / study.netOpVar) < 0.001);
  });

  test('margin statistics: simple average, median, weighted, hours and dollars', () => {
    const priced = study.jobs.filter((j) => j.closed && j.price !== null);
    const avg = (xs) => xs.reduce((t, x) => t + x, 0) / xs.length;
    const med = (xs) => {
      const s = [...xs].sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };
    const st = study.stats;
    assert.equal(st.n, priced.length);
    assert.ok(Math.abs(st.average.planned - avg(priced.map((j) => j.plannedMarginPct))) < 0.0001);
    assert.ok(Math.abs(st.average.actual - avg(priced.map((j) => j.actualMarginPct))) < 0.0001);
    assert.ok(Math.abs(st.median.actual - med(priced.map((j) => j.actualMarginPct))) < 0.0001);
    assert.ok(Math.abs(st.hours.planned - priced.reduce((t, j) => t + j.plannedHours, 0)) < 0.05);
    assert.ok(Math.abs(st.hours.multiple - st.hours.actual / st.hours.planned) < 0.01);
    assert.equal(st.belowGoal, priced.filter((j) => j.actualMarginPct < 0.2).length);
    assert.equal(st.setUpAboveGoal + st.setUpBelowGoal, priced.length);
    assert.ok(Math.abs(st.dollars.shortfall - (st.dollars.actual - st.dollars.planned)) < 0.05);
    assert.ok(Math.abs(st.vsGoalDollars.actual - (st.dollars.actual - study.totals.price * 0.2)) < 0.1);
  });

  test('"where to look" follows the rules, and the price needed is the price that earns the goal', () => {
    const target = 0.2;
    const seen = new Set();
    for (const j of study.jobs) {
      assert.ok(['estimating', 'release-shop', 'shop', 'met', 'data', 'no-price', 'open'].includes(j.focus), j.jobNum);
      assert.ok(j.focusLabel, j.jobNum);
      seen.add(j.focus);
      if (j.focus === 'estimating') assert.ok(j.plannedMarginPct < target, `${j.jobNum} priced below goal at set-up`);
      if (j.focus === 'met') assert.ok(j.actualMarginPct >= target && j.plannedMarginPct >= target);
      if (j.focus === 'release-shop' || j.focus === 'shop') assert.ok(j.plannedMarginPct >= target && j.actualMarginPct < target, j.jobNum);
      if (j.priceNeeded !== null) {
        assert.ok(j.actualMarginPct < target);
        assert.ok(Math.abs((j.priceNeeded - j.actualCost) / j.priceNeeded - target) < 0.001, 'at that price the margin is exactly the goal');
        assert.ok(j.priceNeeded > j.price);
      }
    }
    assert.ok(seen.has('estimating') && seen.has('met'), [...seen].join());
    // the table is ordered by how far the price fell short
    const gaps = study.ranked.map((j) => j.priceGapPct ?? -Infinity);
    assert.deepEqual(gaps, [...gaps].sort((a, b) => b - a));
  });

  test('a job with no sale price, a job still open, and a job with disagreeing quantities are labelled as such', async () => {
    const all = S.db.prepare('SELECT job_num, closed, order_num FROM jobs').all();
    const noPrice = all.find((j) => j.closed && j.order_num === null);
    const open = all.find((j) => !j.closed && j.order_num !== null);
    const s = buildStudy(S.db, [noPrice.job_num, open.job_num], getEngineConfig(S.db), { targetMarginPct: 20, baseCurrency: 'CAD' });
    assert.equal(s.jobs.find((j) => j.jobNum === noPrice.job_num).focus, 'no-price');
    assert.equal(s.jobs.find((j) => j.jobNum === open.job_num).focus, 'open');
    assert.equal(s.stats.n, 0, 'open and unpriced jobs are left out of the margin figures');
    assert.match(s.summary.headline, /cannot be shown/);
    assert.equal(s.chart.labels.length, 0);
  });

  test('repeat parts add up the same part across jobs and say when it lost money every run', () => {
    assert.ok(study.repeatParts.length > 0, 'the demo repeats parts');
    for (const p of study.repeatParts) {
      assert.ok(p.jobs.length >= 2 && p.pricedJobs >= 1);
      const js = study.jobs.filter((j) => j.part === p.part && j.closed && j.price !== null);
      assert.ok(Math.abs(p.price - js.reduce((t, j) => t + j.price, 0)) < 0.05);
      assert.ok(Math.abs(p.actualMargin - js.reduce((t, j) => t + j.actualMargin, 0)) < 0.05);
      assert.equal(p.lostEveryRun, js.length >= 2 && js.every((j) => j.actualMargin < 0));
    }
    const margins = study.repeatParts.map((p) => p.actualMargin);
    assert.deepEqual(margins, [...margins].sort((a, b) => a - b), 'worst first');
  });

  test('the summary states the averages, the gap to goal, and a readout for each team', () => {
    const s = study.summary;
    const pc = (v) => `${(v * 100).toFixed(1)}%`;
    assert.ok(s.headline.includes(pc(study.stats.average.planned)) && s.headline.includes(pc(study.stats.average.actual)), s.headline);
    assert.match(s.headline, /points (under|over) the 20\.0% goal/);
    assert.deepEqual(s.teams.map((t) => t.team), ['Estimating', 'Job Release', 'Shop']);
    assert.match(s.teams[0].text, new RegExp(`${study.stats.belowGoal} of ${study.stats.n} jobs finished below 20.0%`));
    assert.match(s.teams[1].text, new RegExp(`${study.stats.setUpAboveGoal} of ${study.stats.n} jobs were set up above goal`));
  });

  test('chart data: priced closed jobs in close-date order, with planned, actual and the goal', () => {
    const c = study.chart;
    assert.equal(c.labels.length, study.stats.n);
    assert.equal(c.planned.length, c.labels.length);
    assert.equal(c.actual.length, c.labels.length);
    assert.equal(c.target, 20);
    const dates = c.closed.map((d) => String(d));
    assert.deepEqual(dates, [...dates].sort());
    const j = study.jobs.find((x) => x.jobNum === c.labels[0]);
    assert.ok(Math.abs(c.actual[0] - j.actualMarginPct * 100) < 0.01);
  });

  test('materials and the heat map', () => {
    assert.ok(study.materials.length > 3);
    assert.ok(study.matrix.jobs.length <= MATRIX_MAX_JOBS);
    const row = study.matrix.rows[0];
    assert.equal(row.cells.length, study.matrix.jobs.length);
    const cell = row.cells.find(Boolean);
    assert.ok(cell && ['over', 'under', 'zero'].includes(cell.dir) && cell.shade >= 0 && cell.shade <= 70);
  });

  test('heat map squares carry hours, percent and dollars, each with its own colour direction and strength', () => {
    const cells = study.matrix.rows.flatMap((r) => r.cells.filter(Boolean));
    assert.ok(cells.length > 20);
    for (const c of cells) {
      assert.equal(typeof c.hrs, 'number');
      assert.equal(typeof c.usd, 'number');
      assert.ok(Math.abs(c.hrs - (c.actual - c.expected)) < 0.02);
      assert.equal(c.dir, c.hrs > 0 ? 'over' : c.hrs < 0 ? 'under' : 'zero');
      assert.equal(c.dirUsd, c.usd > 0 ? 'over' : c.usd < 0 ? 'under' : 'zero');
      for (const s of [c.shade, c.shadeHrs, c.shadeUsd]) assert.ok(s >= 0 && s <= 70);
    }
    // the biggest square in each view is the darkest (70); a zero square has no colour
    assert.equal(Math.max(...cells.map((c) => c.shadeHrs)), 70);
    assert.equal(Math.max(...cells.map((c) => c.shadeUsd)), 70);
    for (const c of cells.filter((x) => x.hrs === 0)) assert.equal(c.shadeHrs, 0);
    // hours are shaded by size: a bigger variance is never lighter than a smaller one
    const sorted = [...cells].sort((a, b) => Math.abs(a.hrs) - Math.abs(b.hrs));
    for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i].shadeHrs >= sorted[i - 1].shadeHrs);
  });

  test('unknown jobs are reported, duplicates are studied once', () => {
    const s = buildStudy(S.db, [jobNums[0], jobNums[0], 'NO-SUCH-JOB'], getEngineConfig(S.db), { targetMarginPct: 20, baseCurrency: 'CAD' });
    assert.equal(s.jobs.length, 1);
    assert.deepEqual(s.missing, ['NO-SUCH-JOB']);
  });

  test('a job whose last operation made double is listed under "check the data", and on its own page', () => {
    const job = jobNums[3];
    S.db.prepare('UPDATE jobs SET qty_completed = prod_qty * 2 WHERE job_num = ?').run(job);
    const last = S.db.prepare('SELECT opr_seq FROM job_operations WHERE job_num = ? AND subcontract = 0 ORDER BY assembly_seq DESC, opr_seq DESC LIMIT 1').get(job).opr_seq;
    S.db.prepare('UPDATE job_operations SET qty_completed = run_qty * 2 WHERE job_num = ? AND opr_seq = ?').run(job, last);
    S.db.prepare('UPDATE job_operations SET qty_completed = run_qty WHERE job_num = ? AND opr_seq <> ?').run(job, last);
    const s = buildStudy(S.db, [job], getEngineConfig(S.db), { targetMarginPct: 20, baseCurrency: 'CAD' });
    assert.equal(s.qtyNotes.length, 1);
    assert.match(s.qtyNotes[0].text, /most operations completed/);
    const view = buildJobView(S.db, job);
    assert.ok(view.jobDq.some((d) => /most operations completed/.test(d)));
  });
});

describe('study pages', () => {
  let S;
  before(async () => {
    S = await makeSession();
  });

  test('ticked jobs open a study; every signed-in user can use it', async () => {
    const [a, b, c] = S.db.prepare('SELECT job_num FROM jobs WHERE closed = 1 AND order_num IS NOT NULL LIMIT 3').all().map((r) => r.job_num);
    const r = await S.reviewer.get(`/study?jobs=${a},${b},${c}`);
    assert.equal(r.statusCode, 200);
    for (const t of ['Job Study', '3 jobs studied together', 'By Operation: Where Are the Estimates Off?', 'Operation by Job Heat Map', 'By Material: Biggest Dollar Differences', 'Where to Look, Job by Job', 'Export Study to Excel']) assert.ok(r.body.includes(t), t);
    for (const j of [a, b, c]) assert.ok(r.body.includes(`/jobs/${j}`), j);
    assert.equal((await S.anon.get(`/study?jobs=${a}`)).statusCode, 302, 'must sign in');
  });

  test('"study all" uses the Flagged Jobs filters', async () => {
    const r = await S.reviewer.get('/study?from=2000-01-01&to=2100-01-01&flag=red');
    assert.equal(r.statusCode, 200);
    const n = S.db.prepare("SELECT COUNT(*) n FROM jobs j JOIN job_metrics m ON m.job_num = j.job_num WHERE j.order_num IS NOT NULL AND m.flag = 'red'").get().n;
    assert.ok(r.body.includes(`${n} job${n === 1 ? '' : 's'} studied together`) || r.body.includes('Only the first'), `expected ${n}`);
  });

  test('nothing to study, or bad input, gives a plain message', async () => {
    const none = await S.reviewer.get('/study?from=2000-01-01&to=2000-01-02&flag=red');
    assert.equal(none.statusCode, 400);
    assert.match(none.body, /nothing to study/);
    assert.equal((await S.reviewer.get('/study?jobs=%3Cscript%3E')).statusCode, 400);
  });

  test('the study page shows the summary, margin table, line graph, where-to-look table and repeat parts', async () => {
    const r = await S.reviewer.get('/study?from=2000-01-01&to=2100-01-01&flag=all');
    assert.equal(r.statusCode, 200);
    for (const t of ['Summary', 'Margin Summary', 'Average margin (simple)', 'Median margin', 'Revenue-weighted margin', 'Labour hours', 'Planned vs Actual Margin by Job', 'id="marginChartData"',
      'Where to Look, Job by Job', 'Price Needed for Goal', 'Hours (Actual / Expected)', 'Share of Overrun', 'Repeat Parts', 'Print / Save as PDF', '/static/study.js']) assert.ok(r.body.includes(t), t);
    assert.ok(r.body.includes('Estimating') && r.body.includes('Job Release'), 'the three-team readout');
    // heat map: a view selector with hours as the default, and squares that carry all three numbers
    assert.match(r.body, /<select id="hmMode"/);
    assert.match(r.body, /<option value="hrs" selected>/, 'hours is the default view');
    assert.ok(r.body.includes('<option value="pct">') && r.body.includes('<option value="usd">'));
    assert.match(r.body, /<td class="num hm-cell" data-pct="[^"]*" data-hrs="-?[\d.]+" data-usd="-?[\d.]+"/);
    const firstSquare = />\s*([+-]?[\d.]+)<\/td>/.exec(/id="heatmap"[\s\S]*?<tbody>[\s\S]*?(<td class="num hm-cell"[\s\S]*?<\/td>)/.exec(r.body)[1])[1];
    assert.ok(/^[+-]?\d+(\.\d)?$/.test(firstSquare), `the squares start out in hours, e.g. ${firstSquare}`);
    assert.equal((await S.reviewer.get('/static/study.js')).statusCode, 200);
  });

  test('the study exports to Excel with its sheets', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const res = await S.reviewer.get('/study/export.xlsx?from=2000-01-01&to=2100-01-01&flag=red');
    assert.equal(res.statusCode, 200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload);
    assert.deepEqual(wb.worksheets.map((w) => w.name), ['Summary', 'Jobs', 'By operation', 'By material', 'Heat map', 'Repeat parts']);
    const jobHeaders = wb.getWorksheet('Jobs').getRow(1).values;
    for (const h of ['Hours (actual / planned)', 'Price needed for goal', 'Where to look']) assert.ok(jobHeaders.includes(h), h);
    assert.ok(wb.getWorksheet('Summary').getRow(2).values.includes('Average margin (simple)'));
    assert.ok(wb.getWorksheet('Jobs').rowCount > 5);
    assert.ok(wb.getWorksheet('By operation').getRow(1).values.includes('Pattern'));
  });

  test('"All jobs" and "include jobs with no sales order" let a person capture everything', async () => {
    const rowsOf = (html) => {
      const m = /id="jobRows">([^<]*)</.exec(html);
      return m ? JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')) : [];
    };
    const base = '/jobs?from=2000-01-01&to=2100-01-01';
    const flagged = rowsOf((await S.reviewer.get(base)).body).length;
    const all = rowsOf((await S.reviewer.get(`${base}&flag=all`)).body).length;
    assert.ok(all > flagged, 'All jobs shows the ones that are not flagged too');
    assert.equal(getSettings(S.db).excludeNonOrderJobs, true);
    const withNoOrder = rowsOf((await S.reviewer.get(`${base}&flag=all&noOrder=1`)).body).length;
    assert.ok(withNoOrder > all, 'jobs with no sales order come back when asked for');
    const page = (await S.reviewer.get(`${base}&flag=all&noOrder=1`)).body;
    assert.ok(page.includes('Include Jobs With No Sales Order') && page.includes('All jobs (flagged or not)') && page.includes('id="studyAll"') && page.includes('id="studySelected"'));
    assert.ok(page.includes('Study all'), 'the study-all button is on the page');
    void setSettings;
    void recomputeJobs;
  });
});
