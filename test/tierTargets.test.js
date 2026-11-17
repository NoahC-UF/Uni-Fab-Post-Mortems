import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { targetContext, targetFor, parseTierTargets, TIER_TARGETS } from '../src/targets.js';
import { applyCustomers } from '../src/customerOrg.js';
import { setSettings, DEFAULT_SETTINGS } from '../src/settings.js';
import { customersPage, customerDetail, parseAccuracyFilters, exportCsv as accuracyCsv, vsTargetOf } from '../src/accuracy.js';
import { buildStudy } from '../src/study.js';
import { refreshTargets, recomputeJobs } from '../src/metrics.js';
import { getEngineConfig, getSettings } from '../src/settings.js';
import { clientRows } from '../src/gridRows.js';
import { makeSession } from './helpers.js';

const F = (over = {}) => ({ ...parseAccuracyFilters({ from: '2000-01-01', to: '2999-01-01', internal: '1', minJobs: '1' }, new Date('2026-06-15T12:00:00Z'), {}), ...over });
const FORM = { greenPct: 10, yellowPct: 25, minHours: 2, minDollars: 250, syncWindowMonths: 12, normalizeMaterialByQty: 'on', excludeNonOrderJobs: 'on', targetMarginPct: 20 };

describe('which target applies', () => {
  const org = new Map([
    ['acme', { name: 'Acme', tier: 'A', managers: '' }],
    ['bolt', { name: 'Bolt', tier: 'B', managers: '' }],
    ['notier', { name: 'No Tier', tier: '', managers: '' }],
    ['newco', { name: 'NewCo', tier: 'NEW', managers: '' }],
  ]);
  const ctx = (byTier, pct = 20) => ({ settings: { ...DEFAULT_SETTINGS, targetMarginPct: pct, targetMarginByTier: byTier }, org });

  test('a customer gets its tier\'s target; no tier, not on the list, or an empty tier box gets the default', () => {
    const c = ctx({ A: 35, B: 28, NEW: 15 });
    assert.deepEqual(targetFor(c, { name: 'Acme' }), { tier: 'A', pct: 35, target: 0.35, fromTier: true });
    assert.deepEqual(targetFor(c, { name: 'ACME  ' }), { tier: 'A', pct: 35, target: 0.35, fromTier: true }, 'matched like everywhere else: capitals and spaces do not matter');
    assert.equal(targetFor(c, { name: 'Bolt' }).pct, 28);
    assert.equal(targetFor(c, { name: 'NewCo' }).pct, 15);
    assert.deepEqual(targetFor(c, { name: 'No Tier' }), { tier: '', pct: 20, target: 0.2, fromTier: false });
    assert.deepEqual(targetFor(c, { name: 'Nobody' }), { tier: '', pct: 20, target: 0.2, fromTier: false });
    assert.equal(targetFor(ctx({ A: 35 }), { name: 'Bolt' }).pct, 20, 'tier B has no target: the default');
    assert.equal(targetFor(ctx({}), { name: 'Acme' }).pct, 20, 'no tier targets at all: everyone gets the default, as before');
    assert.equal(targetFor(ctx({ A: 0 }), { name: 'Acme' }).pct, 0, 'zero is a real target, not "empty"');
    assert.equal(targetFor(ctx({ A: 35 }, 25), { name: 'Nobody' }).pct, 25);
    assert.equal(targetFor(c, {}).pct, 20, 'no customer');
  });

  test('the Settings boxes: A, B, C, D and New, 0 to 99, empty = default', () => {
    assert.deepEqual(TIER_TARGETS.map((t) => t.tier), ['A', 'B', 'C', 'D', 'NEW']);
    assert.deepEqual(parseTierTargets({ targetMargin_A: '35', targetMargin_B: ' 28.5 ', targetMargin_C: '', targetMargin_NEW: '15' }), { A: 35, B: 28.5, NEW: 15 });
    assert.deepEqual(parseTierTargets({}), {});
    assert.deepEqual(parseTierTargets({ targetMargin_D: '0' }), { D: 0 });
    for (const bad of ['100', '-1', 'abc']) assert.throws(() => parseTierTargets({ targetMargin_A: bad }), /Tier A target margin/, bad);
    assert.deepEqual(parseTierTargets({ targetMargin_X: '40' }), {}, 'an unknown tier is ignored');
  });
});

describe('the target margin by tier, everywhere', () => {
  let S;
  let names; // customers that have closed, priced jobs
  const jobOf = (name) => S.db.prepare("SELECT j.job_num FROM jobs j JOIN job_metrics m ON m.job_num = j.job_num WHERE j.cust_name = ? AND j.closed = 1 AND m.price > 0 ORDER BY j.job_num LIMIT 1").get(name).job_num;

  before(async () => {
    S = await makeSession();
    names = S.db.prepare("SELECT DISTINCT j.cust_name AS n FROM jobs j JOIN job_metrics m ON m.job_num = j.job_num WHERE j.closed = 1 AND m.price > 0 AND j.cust_name <> '' ORDER BY j.cust_name").all().map((r) => r.n);
    assert.ok(names.length >= 3);
    applyCustomers(S.db, [
      { name: names[0], tier: 'A', managers: 'Ann' },
      { name: names[1], tier: 'B', managers: 'Bo' },
      { name: names[2], tier: 'NEW', managers: '' },
    ], 'replace', '2026-01-01T00:00:00Z');
  });

  test('Settings: save a target for each tier; they are kept, shown, validated; an empty box goes back to the default', async () => {
    const r = await S.admin.post('/settings/thresholds', { ...FORM, targetMarginPct: 20, targetMargin_A: 40, targetMargin_B: 30, targetMargin_C: '', targetMargin_D: '', targetMargin_NEW: 10 });
    assert.equal(r.statusCode, 302);
    assert.deepEqual(getSettings(S.db).targetMarginByTier, { A: 40, B: 30, NEW: 10 });
    const page = (await S.admin.get('/settings')).body;
    assert.ok(page.includes('Target Margin by Customer Tier') && page.includes('Default Target Margin (%)'));
    for (const [tier, v] of [['A', 40], ['B', 30], ['NEW', 10]]) assert.match(page, new RegExp(`name="targetMargin_${tier}" value="${v}"`), tier);
    assert.match(page, /name="targetMargin_C" value="" placeholder="20 \(default\)"/);
    const bad = await S.admin.post('/settings/thresholds', { ...FORM, targetMargin_A: 150 });
    assert.equal(bad.statusCode, 400);
    assert.match(bad.body, /Tier A target margin/);
    assert.deepEqual(getSettings(S.db).targetMarginByTier, { A: 40, B: 30, NEW: 10 }, 'a refused form changes nothing');
    assert.equal((await S.reviewer.post('/settings/thresholds', { ...FORM, targetMargin_A: 50 })).statusCode, 403);
  });

  test('each job stores the target of its customer\'s tier, and the likely cause follows it', () => {
    const t = (name) => S.db.prepare('SELECT m.target_margin AS t, m.cause, m.planned_margin_pct AS p, m.actual_margin_pct AS a, m.job_state FROM job_metrics m JOIN jobs j ON j.job_num = m.job_num WHERE j.cust_name = ? AND m.price > 0 LIMIT 1').get(name);
    assert.equal(t(names[0]).t, 0.4);
    assert.equal(t(names[1]).t, 0.3);
    assert.equal(t(names[2]).t, 0.1);
    const other = S.db.prepare("SELECT m.target_margin t FROM job_metrics m JOIN jobs j ON j.job_num = m.job_num WHERE j.cust_name NOT IN (?, ?, ?) AND j.cust_name <> '' LIMIT 1").get(...names.slice(0, 3));
    assert.equal(other.t, 0.2, 'a customer that is not on the list gets the default');
    // a closed job is "on target" only when it meets ITS target
    for (const name of names.slice(0, 3)) {
      const r = t(name);
      if (r.job_state !== 'closed' || r.a === null) continue;
      if (r.p >= r.t && r.a >= r.t) assert.equal(r.cause, 'ok', name);
      if (r.a < r.t) assert.notEqual(r.cause, 'ok', name);
    }
  });

  test('the job page and the post-mortem economics show the customer\'s tier target', async () => {
    const body = (await S.admin.get(`/jobs/${jobOf(names[0])}`)).body;
    assert.ok(body.includes('Target margin 40.0%') && body.includes('(tier A)'), 'tier A: 40%');
    const b2 = (await S.admin.get(`/jobs/${jobOf(names[1])}`)).body;
    assert.ok(b2.includes('Target margin 30.0%') && b2.includes('(tier B)'));
    const notListed = S.db.prepare("SELECT j.job_num FROM jobs j JOIN job_metrics m ON m.job_num = j.job_num WHERE j.cust_name NOT IN (?, ?, ?) AND j.cust_name <> '' AND m.price > 0 LIMIT 1").get(...names.slice(0, 3)).job_num;
    const b3 = (await S.admin.get(`/jobs/${notListed}`)).body;
    assert.ok(b3.includes('Target margin 20.0%') && !/Target margin 20\.0% \(tier/.test(b3));
  });

  test('the Flagged Jobs grid rows carry their own target', () => {
    const rows = S.db.prepare("SELECT m.*, j.part_num, j.part_description, j.cust_name, j.closed, j.closed_date FROM job_metrics m JOIN jobs j ON j.job_num = m.job_num WHERE j.cust_name = ? LIMIT 2").all(names[0]);
    for (const r of clientRows(rows.map((x) => ({ ...x, job_num: x.job_num })))) assert.equal(r.targetMargin, 0.4);
  });

  test('Customers: each customer is measured against its own tier\'s target', () => {
    const d = customersPage(S.db, F());
    const by = (n) => d.all.find((g) => g.label === n);
    for (const [name, target] of [[names[0], 0.4], [names[1], 0.3], [names[2], 0.1]]) {
      const g = by(name);
      assert.equal(g.target, target, name);
      assert.ok(Math.abs(g.vsTarget - (g.margin - target * g.price)) < 0.011, `${name}: margin vs target uses its own target`);
      assert.ok(g.targetSource.startsWith('tier'), name);
    }
    const other = d.all.find((g) => ![names[0], names[1], names[2]].includes(g.label) && g.margin !== null);
    assert.equal(other.target, 0.2);
    assert.equal(other.targetSource, 'default target');
    // the shop-wide target is each customer's target weighted by what it was sold for
    const sold = d.all.filter((g) => g.margin !== null && g.price > 0);
    const w = sold.reduce((t, g) => t + g.price * g.target, 0) / sold.reduce((t, g) => t + g.price, 0);
    assert.ok(Math.abs(d.shop.targetMargin - w) < 0.0001);
    assert.ok(Math.abs(d.shop.vsTarget - sold.reduce((t, g) => t + g.vsTarget, 0)) < 0.05);
  });

  test('Customers page and CSV show which target applied; a customer\'s own page uses it', async () => {
    const body = (await S.admin.get('/accuracy/customers?minJobs=1&from=2000-01-01&to=2999-01-01')).body;
    assert.ok(body.includes('tier A target') && body.includes('default target'));
    assert.match(body, /Margin \$ less 40% of the sale price \(tier A target\)/);
    assert.match(body, /target 30% \(tier B target\)/);
    const csv = accuracyCsv(S.db, F(), 'customers').trimEnd().split('\r\n');
    const head = csv[0].split(',');
    const col = head.indexOf('Target Margin %');
    assert.ok(col > 0);
    const row = csv.find((l) => l.startsWith(names[0]));
    assert.equal(row.split(',')[col], '40');

    const c = customerDetail(S.db, F(), customersPage(S.db, F()).all.find((g) => g.label === names[0]).key);
    assert.equal(c.targetMargin, 0.4);
    assert.equal(c.summary.target, 0.4);
    const detail = (await S.admin.get(`/accuracy/customers/${encodeURIComponent(c.key)}?from=2000-01-01&to=2999-01-01`)).body;
    assert.ok(detail.includes('the 40% tier A target'));
  });

  test('Job Study holds every job to its own target, and says so', () => {
    const jobs = [jobOf(names[0]), jobOf(names[1]), jobOf(names[2])];
    const st = buildStudy(S.db, jobs, getEngineConfig(S.db), { targetMarginPct: getSettings(S.db).targetMarginPct, baseCurrency: 'CAD' });
    const targets = Object.fromEntries(st.jobs.map((j) => [j.jobNum, j.target]));
    assert.deepEqual([targets[jobs[0]], targets[jobs[1]], targets[jobs[2]]], [0.4, 0.3, 0.1]);
    assert.equal(st.stats.targetsDiffer, true);
    const priced = st.jobs.filter((j) => j.closed && j.price !== null);
    assert.ok(priced.length > 0);
    const w = priced.reduce((t, j) => t + j.price * j.target, 0) / priced.reduce((t, j) => t + j.price, 0);
    assert.ok(Math.abs(st.stats.target - w) < 0.0001, 'the one number for the group is the price-weighted target');
    for (const j of st.jobs.filter((x) => x.priceNeeded !== null)) assert.ok(Math.abs(j.priceNeeded - j.actualCost / (1 - j.target)) < 0.02, `${j.jobNum}: price needed uses its own goal`);
    assert.equal(st.stats.belowGoal, priced.filter((j) => j.actualMarginPct < j.target).length);
    assert.deepEqual(st.chart.goals, [...priced].sort((a, b) => String(a.closedDate ?? '9999').localeCompare(String(b.closedDate ?? '9999')) || a.jobNum.localeCompare(b.jobNum)).map((j) => Math.round(j.target * 10000) / 100));
    const uniform = buildStudy(S.db, [jobOf(names[0])], getEngineConfig(S.db), { targetMarginPct: 20, baseCurrency: 'CAD' });
    assert.equal(uniform.stats.targetsDiffer, false);
    assert.equal(uniform.stats.target, 0.4);
  });

  test('importing a new customer list re-applies the targets to every job at once, without re-running the variance engine', async () => {
    const jobA = jobOf(names[0]);
    assert.equal(S.db.prepare('SELECT target_margin t FROM job_metrics WHERE job_num = ?').get(jobA).t, 0.4);
    // names[0] moves from tier A to tier B
    applyCustomers(S.db, [{ name: names[0], tier: 'B', managers: 'Ann' }], 'update', '2026-02-01T00:00:00Z');
    const flagBefore = S.db.prepare('SELECT flag, computed_at FROM job_metrics WHERE job_num = ?').get(jobA);
    const changed = refreshTargets(S.db);
    assert.ok(changed >= 1);
    const after = S.db.prepare('SELECT target_margin t, flag, computed_at FROM job_metrics WHERE job_num = ?').get(jobA);
    assert.equal(after.t, 0.3, 'now tier B');
    assert.deepEqual([after.flag, after.computed_at], [flagBefore.flag, flagBefore.computed_at], 'the variance result is untouched');
    assert.equal(refreshTargets(S.db), 0, 'nothing left to change');
    // the same answer as a full re-check
    recomputeJobs(S.db, [jobA]);
    assert.equal(S.db.prepare('SELECT target_margin t FROM job_metrics WHERE job_num = ?').get(jobA).t, 0.3);
    assert.equal(targetFor(targetContext(S.db), { name: names[0] }).pct, 30);
  });

  test('with no tier targets set, everything is exactly as it was (one target for all)', async () => {
    await S.admin.post('/settings/thresholds', { ...FORM, targetMarginPct: 25 });
    assert.deepEqual(getSettings(S.db).targetMarginByTier, {});
    const d = customersPage(S.db, F());
    for (const g of d.all) assert.equal(g.target, 0.25, g.label);
    const rows = S.db.prepare('SELECT DISTINCT target_margin t FROM job_metrics').all().map((r) => r.t);
    assert.deepEqual(rows, [0.25]);
    assert.equal(vsTargetOf({ margin: 300, price: 1000 }, 0.25), 50);
  });
});

describe('the Target % column', () => {
  test('each customer row shows its own target, with which one it is in the tooltip', async () => {
    const S = await makeSession();
    const names = S.db.prepare("SELECT DISTINCT j.cust_name AS n FROM jobs j JOIN job_metrics m ON m.job_num = j.job_num WHERE j.closed = 1 AND m.price > 0 AND j.cust_name <> '' ORDER BY j.cust_name").all().map((r) => r.n);
    applyCustomers(S.db, [{ name: names[0], tier: 'D', managers: '' }], 'replace', '2026-01-01T00:00:00Z');
    setSettings(S.db, { targetMarginPct: 30, targetMarginByTier: { D: 45 } });
    recomputeJobs(S.db);
    const body = (await S.admin.get('/accuracy/customers?minJobs=1&from=2000-01-01&to=2999-01-01&lists=v')).body;
    const head = [...body.match(/<table data-table="acc-customers"[^>]*>\s*<thead>(.*?)<\/thead>/s)[1].matchAll(/<th[^>]*>(.*?)<\/th>/g)].map((m) => m[1]);
    assert.deepEqual(head.slice(head.indexOf('Margin %'), head.indexOf('Margin %') + 3), ['Margin %', 'Target %', 'vs Target $']);
    // the table row of one customer: from its name to the end of that row
    const row = (name) => {
      const at = body.indexOf(`<b>${name}</b>`);
      return at < 0 ? '' : body.slice(at, body.indexOf('</tr>', at));
    };
    assert.match(row(names[0]), /<span title="tier D target">45%<\/span>/);
    const other = [...body.matchAll(/<span title="default target">([\d.]+)%<\/span>/g)];
    assert.ok(other.length > 0 && other.every((m) => m[1] === '30'));
  });
});
