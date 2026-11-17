import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAccuracyFilters, filterLink, splitLines, groupLines, rankGroups, needsAttention, impactOf, trendOf, toCsv,
  opKey, mtlKey, loadLines, opsAndMaterials, drillDown, customersPage, customerDetail, exportCsv, INTERNAL_KEY, INTERNAL_LABEL,
} from '../src/accuracy.js';
import { recomputeJobs } from '../src/metrics.js';
import { makeSession } from './helpers.js';

const NOW = new Date('2026-06-15T12:00:00Z');
const F = (over = {}) => ({ ...parseAccuracyFilters({ from: '2000-01-01', to: '2999-01-01', internal: '1', minJobs: '1' }, NOW, {}), ...over });

/** A made-up operation line. */
let n = 0;
const op = (o = {}) => ({
  job_num: o.job ?? `J${++n}`, kind: 'op', op_code: o.code ?? 'WELD', resource_grp_id: o.rg ?? 'RG1', part_num: null, description: 'Weld', class_id: null,
  unplanned: o.unplanned ?? 0, flag: o.flag ?? 'green', activity_date: o.date ?? '2026-03-10',
  exp_hours: o.exp ?? 10, act_hours: o.act ?? 10, exp_setup: o.expSet ?? 2, act_setup: o.actSet ?? 2, exp_run: o.expRun ?? 8, act_run: o.actRun ?? 8,
  var_hours: (o.act ?? 10) - (o.exp ?? 10), exp_qty: null, act_qty: null,
  est_dollars: o.estD ?? 1000, act_dollars: o.actD ?? 1000, var_dollars: o.varD ?? ((o.actD ?? 1000) - (o.estD ?? 1000)), usage_var: null, price_var: null,
  var_pct: o.pct === undefined ? ((o.act ?? 10) - (o.exp ?? 10)) / (o.exp ?? 10) : o.pct,
  job_part: o.part ?? 'P-1', job_part_desc: 'Part', cust_id: o.cust ?? 'C1', cust_name: o.custName ?? 'Acme', order_num: o.order === undefined ? 1 : o.order, closed: 1,
});

describe('calculations on hand-made lines', () => {
  test('net and gross are different: +50% and -50% net to zero but are badly estimated', () => {
    const lines = [
      op({ job: 'A', exp: 10, act: 15, estD: 1000, actD: 1500, flag: 'red' }),
      op({ job: 'B', exp: 10, act: 5, estD: 1000, actD: 500, flag: 'red' }),
    ];
    const [g] = groupLines(lines, opKey('op'), 'op');
    assert.equal(g.netDollars, 0);
    assert.equal(g.grossDollars, 1000);
    assert.equal(g.avgPct, 0);
    assert.equal(g.pctOff, 1);
    assert.equal(g.attention, 1000, 'gross x share of jobs off');
    assert.equal(g.jobs, 2);
  });

  test('variance % is total variance over total estimate; the setup / run split adds up', () => {
    const lines = [op({ exp: 10, act: 12, expSet: 4, actSet: 4, expRun: 6, actRun: 8 }), op({ exp: 20, act: 20, expSet: 5, actSet: 3, expRun: 15, actRun: 17 })];
    const [g] = groupLines(lines, opKey('op'), 'op');
    assert.equal(g.estHrs, 30);
    assert.equal(g.actHrs, 32);
    assert.equal(g.varHrs, 2);
    assert.equal(g.avgPct, 0.0667);
    assert.equal(g.setup.var + g.run.var, g.varHrs);
    assert.equal(g.setup.var, -2);
    assert.equal(g.run.var, 4);
  });

  test('a job counts once per group, however many lines it has; "off" if any line was flagged', () => {
    const lines = [op({ job: 'A', flag: 'green' }), op({ job: 'A', flag: 'yellow' }), op({ job: 'B', flag: 'green' })];
    const [g] = groupLines(lines, opKey('op'), 'op');
    assert.equal(g.jobs, 2);
    assert.equal(g.lines, 3);
    assert.equal(g.jobsOff, 1);
    assert.equal(g.pctOff, 0.5);
  });

  test('operations can be grouped by resource group instead', () => {
    const lines = [op({ code: 'WELD', rg: 'W1' }), op({ code: 'WELDT', rg: 'W1' }), op({ code: 'PAINT', rg: 'P1' })];
    assert.deepEqual(groupLines(lines, opKey('rg'), 'op').map((g) => g.key).sort(), ['P1', 'W1']);
    assert.deepEqual(groupLines(lines, opKey('op'), 'op').map((g) => g.key).sort(), ['PAINT', 'WELD', 'WELDT']);
  });

  test('material: usage and price variance and the class grouping', () => {
    const m = (o) => ({ ...op({ job: o.job }), kind: 'material', op_code: null, resource_grp_id: null, part_num: o.part, class_id: o.cls, exp_hours: null, act_hours: null, exp_qty: o.eq, act_qty: o.aq, est_dollars: o.est, act_dollars: o.act, var_dollars: o.act - o.est, usage_var: o.usage, price_var: o.price, var_pct: (o.act - o.est) / o.est });
    const lines = [m({ job: 'A', part: 'X', cls: 'STEEL', eq: 10, aq: 12, est: 100, act: 144, usage: 20, price: 24 }), m({ job: 'B', part: 'Y', cls: 'STEEL', eq: 5, aq: 5, est: 50, act: 50, usage: 0, price: 0 })];
    const byPart = groupLines(lines, mtlKey('part'), 'material');
    assert.equal(byPart.length, 2);
    const x = byPart.find((g) => g.key === 'X');
    assert.equal(x.usageDollars + x.priceDollars, x.netDollars, 'usage + price = total');
    const byClass = groupLines(lines, mtlKey('class'), 'material');
    assert.equal(byClass.length, 1);
    assert.equal(byClass[0].key, 'STEEL');
    assert.equal(byClass[0].jobs, 2);
  });

  test('nothing is divided by zero: unestimated lines are split off, and a group with no estimate has no %', () => {
    const lines = [op({ job: 'A' }), op({ job: 'B', unplanned: 1, exp: 0, act: 4, estD: 0, actD: 400, varD: 400, pct: null, flag: 'red' }), op({ job: 'C', exp: 0, act: 0, estD: 0, actD: 0, varD: 0, pct: null })];
    const { estimated, unestimated, outliers } = splitLines(lines, F());
    assert.equal(estimated.length, 1);
    assert.equal(unestimated.length, 1, 'actuals with no estimate');
    assert.equal(outliers, 0);
    const [g] = groupLines([{ ...lines[2] }], opKey('op'), 'op');
    assert.equal(g.avgPct, null);
    assert.ok(Number.isFinite(g.attention));
  });

  test('outliers are always counted, and dropped only when asked', () => {
    const lines = [op({ job: 'A' }), op({ job: 'B', exp: 1, act: 8, estD: 100, actD: 800, varD: 700, pct: 7 }), op({ job: 'C', exp: 10, act: 40, pct: 3 })]; // +700% and exactly +300%
    const kept = splitLines(lines, F({ outliers: false }));
    assert.equal(kept.estimated.length, 3);
    assert.equal(kept.outliers, 1, 'only beyond 300%');
    const dropped = splitLines(lines, F({ outliers: true }));
    assert.equal(dropped.estimated.length, 2);
    assert.equal(dropped.outliers, 1);
  });

  test('the lists: jobs over and under the estimate, sample size, the chosen basis and sort', () => {
    const mk = (code, jobs, varD, off = 0) => Array.from({ length: jobs }, (_, i) => op({ job: `${code}${i}`, code, estD: 1000, actD: 1000 + varD, varD, exp: 10, act: 10 + varD / 100, flag: i < off ? 'red' : 'green' }));
    const lines = [...mk('BIG', 4, 500, 1), ...mk('FREQ', 4, 100, 4), ...mk('OVR', 3, -300, 0), ...mk('TINY', 2, 900, 2)];
    const groups = groupLines(lines, opKey('op'), 'op');
    const byImpact = rankGroups(groups, F({ minJobs: 3, sort: 'impact' }));
    assert.deepEqual(byImpact.over.map((g) => g.key), ['BIG', 'FREQ'], 'over the estimate: biggest dollars first');
    assert.deepEqual(byImpact.under.map((g) => g.key), ['OVR'], 'under the estimate');
    assert.equal(byImpact.hidden, 1, 'TINY has too few jobs');
    assert.deepEqual(rankGroups(groups, F({ minJobs: 3, sort: 'frequency' })).over.map((g) => g.key), ['FREQ', 'BIG'], 'most often off first');
    assert.deepEqual(rankGroups(groups, F({ minJobs: 3, sort: 'attention' })).over.map((g) => g.key), ['FREQ', 'BIG'].sort((a, b) => groups.find((g) => g.key === b).attention - groups.find((g) => g.key === a).attention));
    assert.deepEqual(rankGroups(groups, F({ minJobs: 1, sort: 'impact' })).over.map((g) => g.key), ['BIG', 'TINY', 'FREQ'], 'with a smaller sample size TINY comes in');
    assert.equal(impactOf(groups[0], 'hours'), groups[0].varHrs);
    assert.equal(impactOf(groups[0], 'pct'), groups[0].avgPct);
    assert.equal(impactOf(groups[0], 'dollars'), groups[0].netDollars);
  });

  test('needs attention: enough jobs, and outside the green band or off more often than the shop', () => {
    const g = (o) => ({ jobs: 5, avgPct: 0, pctOff: 0, attention: 0, ...o });
    const ctx = { greenMax: 0.1, shopPctOff: 0.2, minJobs: 3 };
    assert.equal(needsAttention(g({ avgPct: 0.15 }), ctx), true, 'outside the green band');
    assert.equal(needsAttention(g({ avgPct: 0.0, pctOff: 0.6, attention: 900 }), ctx), true, 'nets to nothing but off far more often than the shop');
    assert.equal(needsAttention(g({ avgPct: 0.05, pctOff: 0.1, attention: 100 }), ctx), false);
    assert.equal(needsAttention(g({ jobs: 2, avgPct: 0.9 }), ctx), false, 'too few jobs');
  });

  test('trend: variance % per month or quarter, in order', () => {
    const lines = [op({ date: '2026-01-05', exp: 10, act: 12, estD: 10, actD: 12 }), op({ date: '2026-01-20', exp: 10, act: 10 }), op({ date: '2026-04-02', exp: 10, act: 9 }), op({ date: '' })]; // the last one has no date
    const m = trendOf(lines, 'month', 'op');
    assert.deepEqual(m.map((p) => p.label), ['2026-01', '2026-04']);
    assert.equal(m[0].pct, 0.1);
    assert.equal(m[1].pct, -0.1);
    assert.deepEqual(trendOf(lines, 'quarter', 'op').map((p) => p.label), ['2026-Q1', '2026-Q2']);
  });

  test('filters: defaults, limits and links', () => {
    const f = parseAccuracyFilters({}, NOW, {});
    assert.equal(f.to, '2026-06-15');
    assert.equal(f.from, '2026-03-17', 'the last 90 days');
    assert.equal(f.status, 'closed');
    assert.equal(f.minJobs, 3);
    assert.equal(f.basis, 'dollars');
    assert.equal(f.outliers, false);
    assert.equal(f.internal, true, 'no Settings choice: stock jobs in');
    assert.equal(parseAccuracyFilters({}, NOW, { excludeNonOrderJobs: true }).internal, false, 'follows Settings until set');
    assert.equal(parseAccuracyFilters({ internal: '1' }, NOW, { excludeNonOrderJobs: true }).internal, true);
    assert.equal(parseAccuracyFilters({ internal: ['0', '1'] }, NOW, {}).internal, true, 'a ticked box sends 0 then 1');
    const bad = parseAccuracyFilters({ status: 'x', basis: 'y', minJobs: '0', sort: 'z', opBy: 'q', from: 'nope' }, NOW, {});
    assert.deepEqual([bad.status, bad.basis, bad.minJobs, bad.sort, bad.opBy], ['closed', 'dollars', 3, 'attention', 'op']);
    const link = new URLSearchParams(filterLink(f, { drill: 'op:WELD' }));
    assert.equal(link.get('drill'), 'op:WELD');
    assert.equal(link.get('from'), f.from);
    assert.equal(link.get('outliers'), '0');
    assert.ok(!link.has('cust'));
    assert.equal(new URLSearchParams(filterLink({ ...f, cust: 'C9' })).get('cust'), 'C9');
  });

  test('CSV cells are quoted when they need to be', () => {
    assert.equal(toCsv(['a', 'b'], [['x,y', 'say "hi"'], [null, 3]]), 'a,b\r\n"x,y","say ""hi"""\r\n,3\r\n');
  });
});

describe('the stored lines match the rest of the app', () => {
  let S;
  before(async () => {
    S = await makeSession();
  });

  test('every operation and material line of every job is stored, flagged or not', () => {
    const jobs = S.db.prepare('SELECT COUNT(*) n FROM jobs').get().n;
    const ops = S.db.prepare('SELECT COUNT(*) n FROM job_operations').get().n;
    const mtls = S.db.prepare('SELECT COUNT(*) n FROM job_materials').get().n;
    const stored = S.db.prepare('SELECT kind, COUNT(*) n FROM line_results GROUP BY kind').all();
    assert.ok(jobs > 10);
    assert.equal(stored.find((r) => r.kind === 'op').n, ops);
    assert.equal(stored.find((r) => r.kind === 'material')?.n ?? 0, mtls);
    const green = S.db.prepare("SELECT COUNT(*) n FROM line_results WHERE flag = 'green'").get().n;
    assert.ok(green > 0, 'unflagged lines are kept too');
  });

  test('line totals equal the labour and material variance the Dashboard stores', () => {
    const rows = S.db.prepare("SELECT m.job_num, m.labour_var_dollars lab, m.material_var_dollars mat FROM job_metrics m WHERE m.job_state = 'closed' LIMIT 40").all();
    assert.ok(rows.length > 10);
    for (const r of rows) {
      const lab = S.db.prepare("SELECT COALESCE(SUM(var_dollars), 0) s FROM line_results WHERE job_num = ? AND kind = 'op' AND counted = 1").get(r.job_num).s;
      const mat = S.db.prepare("SELECT COALESCE(SUM(var_dollars), 0) s FROM line_results WHERE job_num = ? AND kind = 'material' AND counted = 1").get(r.job_num).s;
      assert.ok(Math.abs(lab - r.lab) < 0.05, `${r.job_num} labour ${lab} vs ${r.lab}`);
      assert.ok(Math.abs(mat - r.mat) < 0.05, `${r.job_num} material ${mat} vs ${r.mat}`);
    }
  });

  test('the flags are the engine\'s: the same lines are flagged here as in flag_lines', () => {
    const a = S.db.prepare("SELECT COUNT(*) n FROM line_results WHERE flag <> 'green' AND counted = 1").get().n;
    const b = S.db.prepare('SELECT COUNT(*) n FROM flag_lines').get().n;
    assert.equal(a, b);
  });

  test('closed jobs by close date; open jobs only when asked, and then only their counted lines', () => {
    const closed = loadLines(S.db, F({ status: 'closed' }));
    assert.ok(closed.length > 0 && closed.every((l) => l.closed === 1));
    const all = loadLines(S.db, F({ status: 'all' }));
    assert.ok(all.length > closed.length, 'in-progress jobs add lines');
    assert.ok(all.some((l) => l.closed === 0));
    const open = S.db.prepare("SELECT COUNT(*) n FROM line_results l JOIN jobs j ON j.job_num = l.job_num WHERE j.closed = 0 AND l.counted = 0").get().n;
    assert.ok(open > 0, 'open operations are stored but not counted');
    const narrow = loadLines(S.db, F({ from: '2999-01-01', to: '2999-12-31' }));
    assert.equal(narrow.length, 0, 'the date range applies');
  });

  test('Internal / Stock jobs are one bucket that can be left out', () => {
    const jobNum = S.db.prepare("SELECT job_num FROM jobs WHERE closed = 1 AND order_num IS NOT NULL LIMIT 1").get().job_num;
    S.db.prepare("UPDATE jobs SET order_num = NULL, cust_id = '', cust_name = '' WHERE job_num = ?").run(jobNum);
    const withInternal = loadLines(S.db, F({ internal: true }));
    const without = loadLines(S.db, F({ internal: false }));
    assert.ok(withInternal.some((l) => l.job_num === jobNum));
    assert.ok(!without.some((l) => l.job_num === jobNum));
    const page = customersPage(S.db, F({ internal: true }));
    const bucket = page.all.find((g) => g.key === INTERNAL_KEY);
    assert.ok(bucket && bucket.label === INTERNAL_LABEL);
    assert.ok(!customersPage(S.db, F({ internal: false })).all.some((g) => g.key === INTERNAL_KEY));
  });

  test('loaded lines are kept until a job is recomputed', () => {
    const f = F();
    const a = loadLines(S.db, f);
    assert.equal(loadLines(S.db, f), a, 'the same list again');
    recomputeJobs(S.db, null, new Date(Date.now() + 5000));
    assert.notEqual(loadLines(S.db, f), a, 'fresh after a recompute');
  });
});

describe('the pages\' numbers', () => {
  let S;
  before(async () => {
    S = await makeSession();
  });

  test('Operations & Materials: totals, lists and chart agree', () => {
    const d = opsAndMaterials(S.db, F({ minJobs: 3 }));
    assert.ok(d.ops.over.length > 0 && d.ops.under.length > 0);
    assert.ok(d.ops.over.every((g) => g.netDollars > 0 && g.jobs >= 3), 'over the estimate = positive variance');
    assert.ok(d.ops.under.every((g) => g.netDollars < 0));
    assert.ok(d.opT.grossDollars >= Math.abs(d.opT.netDollars), 'gross is never less than net');
    const sumNet = d.ops.all.reduce((t, g) => t + g.netDollars, 0);
    assert.ok(Math.abs(sumNet - d.opT.netDollars) < 0.05, 'the groups add up to the tile');
    assert.ok(d.opAccuracy > 0 && d.opAccuracy <= 1);
    assert.ok(d.chart.length > 0 && d.chart.length <= 15);
    for (let i = 1; i < d.chart.length; i++) assert.ok(Math.abs(d.chart[i - 1].net) >= Math.abs(d.chart[i].net), 'biggest first');
    assert.ok(d.chart.every((c) => ['op', 'mtl'].includes(c.kind) && c.key));
    assert.equal(d.unestimated.lines, S.db.prepare("SELECT COUNT(*) n FROM line_results l JOIN jobs j ON j.job_num = l.job_num WHERE l.counted = 1 AND l.unplanned = 1 AND j.closed = 1").get().n);
  });

  test('the chosen basis changes what the lists rank on', () => {
    const dollars = opsAndMaterials(S.db, F({ basis: 'dollars', sort: 'impact' })).ops.over.map((g) => g.key);
    const pct = opsAndMaterials(S.db, F({ basis: 'pct', sort: 'avg' })).ops.over.map((g) => g.key);
    assert.ok(dollars.length && pct.length);
    assert.notDeepEqual(dollars, pct, 'a different measure ranks differently');
  });

  test('drill-down: group, then parts (repeat offenders first), then jobs; a part narrows the jobs', () => {
    const d = opsAndMaterials(S.db, F({ minJobs: 3 }));
    const key = d.ops.over[0].key;
    const dd = drillDown(S.db, F(), { type: 'op', key });
    assert.equal(dd.group.key, key);
    assert.ok(dd.parts.length > 0);
    assert.equal(dd.group.setup.var + dd.group.run.var, dd.group.varHrs, 'setup + run = total');
    assert.ok(dd.parts.every((p) => p.repeat === (p.jobsOff >= 3)));
    const firstNonRepeat = dd.parts.findIndex((p) => !p.repeat);
    assert.ok(firstNonRepeat === -1 || dd.parts.slice(firstNonRepeat).every((p) => !p.repeat), 'repeat parts come first');
    assert.equal(dd.jobCount, dd.group.jobs);
    assert.ok(dd.jobs.every((j) => j.job && 'pm' in j && j.part));
    const part = dd.parts[0].key;
    const narrowed = drillDown(S.db, F(), { type: 'op', key, part });
    assert.ok(narrowed.jobs.length > 0 && narrowed.jobs.every((j) => j.part === part));
    assert.equal(drillDown(S.db, F(), { type: 'op', key: 'NO-SUCH-OP' }), null);
    assert.ok(dd.trend.length > 0 && dd.trend.every((p) => p.label && 'pct' in p));
  });

  test('Customers: each customer\'s jobs, the shop figures, the comparison and the indicator', () => {
    const c = customersPage(S.db, F({ minJobs: 1 }));
    assert.ok(c.customers > 3 && c.shop.jobs === c.jobCount);
    assert.ok(c.all.every((g) => ['Labour', 'Material', 'Both'].includes(g.mainly)));
    assert.ok(c.all.every((g) => g.grossDollars >= Math.abs(g.netDollars)));
    const sumJobs = c.all.reduce((t, g) => t + g.jobs, 0);
    assert.equal(sumJobs, c.jobCount);
    for (const g of c.all) assert.ok(Math.abs(g.vsShop - (g.pctOff - c.shop.pctOff)) < 0.0002);
    assert.ok(c.bubbles.length === c.customers);
    assert.ok(c.over.every((g) => g.netDollars > 0) && c.under.every((g) => g.netDollars < 0));
  });

  test('Customer detail: summary, trend, lists, repeat parts, jobs, post-mortem progress and root causes', () => {
    const page = customersPage(S.db, F({ minJobs: 1 }));
    const target = page.all.sort((a, b) => b.jobs - a.jobs)[0];
    // give two of this customer's flagged jobs a post-mortem: one finished with a root cause, one still open
    const flagged = S.db.prepare("SELECT j.job_num FROM jobs j JOIN job_metrics m ON m.job_num = j.job_num WHERE j.cust_id = ? AND m.flag IN ('red','yellow') LIMIT 2").all(target.key).map((r) => r.job_num);
    assert.ok(flagged.length >= 1, 'demo customer has flagged jobs');
    const ins = S.db.prepare("INSERT INTO post_mortems (job_num, status, snapshot_json, snapshot_taken_at) VALUES (?, ?, '{}', datetime('now'))");
    const first = ins.run(flagged[0], 'closed').lastInsertRowid;
    S.db.prepare('INSERT INTO post_mortem_root_causes (post_mortem_id, root_cause_id) VALUES (?, 1)').run(first);
    if (flagged[1]) ins.run(flagged[1], 'under_review');
    const c = customerDetail(S.db, F(), target.key);
    assert.equal(c.summary.jobs, target.jobs);
    assert.ok(c.jobs.length === Math.min(500, target.jobs));
    assert.equal(c.pmProgress.done, 1);
    assert.equal(c.pmProgress.started, flagged[1] ? 1 : 0);
    assert.equal(c.pmProgress.flagged, c.pmProgress.done + c.pmProgress.started + c.pmProgress.pending);
    assert.deepEqual(c.causes.map((r) => r.n), [1]);
    assert.ok(c.jobs.some((j) => j.pm && j.pm.status === 'closed'));
    assert.ok(Array.isArray(c.repeatParts) && c.repeatParts.every((p) => p.off >= 2));
    assert.ok(c.trend.length > 0);
    assert.ok(Math.abs(c.summary.vsShop - (c.summary.pctOff - c.shop.pctOff)) < 0.0002);
    assert.equal(customerDetail(S.db, F(), 'NOBODY'), null);
    // the ops page can be limited to one customer too
    const only = opsAndMaterials(S.db, F({ cust: target.key }));
    const jobsInOnly = new Set(loadLines(S.db, F({ cust: target.key })).map((l) => l.job_num));
    assert.equal(jobsInOnly.size, target.jobs);
    assert.ok(only.opT.lines > 0);
  });

  test('customers: sale price and actual margin come from the stored job price and cost, closed priced jobs only', () => {
    const d = customersPage(S.db, F({ status: 'all' }));
    const lines = loadLines(S.db, F({ status: 'all' }));
    let checked = 0;
    for (const g of d.all.slice(0, 25)) {
      const jobNums = [...new Set(lines.filter((l) => (l.order_num === null || !l.cust_id ? INTERNAL_KEY : l.cust_id) === g.key).map((l) => l.job_num))];
      const rows = S.db
        .prepare(`SELECT m.price, m.actual_cost FROM job_metrics m JOIN jobs j ON j.job_num = m.job_num WHERE j.closed = 1 AND m.price > 0 AND m.job_num IN (${jobNums.map(() => '?').join(',')})`)
        .all(...jobNums);
      const price = rows.reduce((s, x) => s + x.price, 0);
      const cost = rows.reduce((s, x) => s + x.actual_cost, 0);
      assert.equal(g.pricedJobs, rows.length, g.label);
      assert.ok(Math.abs(g.price - price) < 0.05, `${g.label} sale price`);
      if (rows.length) {
        assert.ok(Math.abs(g.margin - (price - cost)) < 0.05, `${g.label} margin $`);
        assert.ok(Math.abs(g.marginPct - (price - cost) / price) < 0.0002, `${g.label} margin %`);
        checked++;
      } else {
        assert.equal(g.margin, null);
        assert.equal(g.marginPct, null);
      }
    }
    assert.ok(checked > 0, 'the demo data has priced customers');
    assert.ok(d.shop.pricedJobs > 0 && d.shop.price > 0);
    assert.ok(d.targetMargin > 0);
  });

  test('customers: Total Est and Total Act are the full cost the margin uses; Net = Act - Est; Labour + Material + Other = Net', () => {
    const d = customersPage(S.db, F({ status: 'closed' }));
    const lines = loadLines(S.db, F({ status: 'closed' }));
    let checked = 0;
    for (const g of d.all.slice(0, 25)) {
      const jobNums = [...new Set(lines.filter((l) => (l.order_num === null || !l.cust_id ? INTERNAL_KEY : l.cust_id) === g.key).map((l) => l.job_num))];
      const m = S.db.prepare(`SELECT SUM(planned_cost) p, SUM(actual_cost) a FROM job_metrics WHERE job_num IN (${jobNums.map(() => '?').join(',')})`).get(...jobNums);
      assert.ok(Math.abs(g.actDollars - m.a) < 0.1, `${g.label}: Total Act is the stored actual cost of the jobs`);
      assert.ok(Math.abs(g.estDollars - m.p) < 0.1, `${g.label}: Total Est is the stored planned cost`);
      assert.ok(Math.abs(g.netDollars - (g.actDollars - g.estDollars)) < 0.1, `${g.label}: Net = Act - Est`);
      assert.ok(Math.abs(g.labourDollars + g.materialDollars + g.otherDollars - g.netDollars) < 0.1, `${g.label}: the three variance columns add up`);
      if (g.pricedJobs && g.pricedJobs === g.jobs) assert.ok(Math.abs(g.price - g.actDollars - g.margin) < 0.1, `${g.label}: sale price less Total Act is the margin`);
      checked++;
    }
    assert.ok(checked > 0);
  });

  test('customers: an in-progress job never gets a price or margin (its cost is only so far)', () => {
    const open = S.db.prepare('SELECT m.job_num FROM job_metrics m JOIN jobs j ON j.job_num = m.job_num WHERE j.closed = 0 AND m.price > 0 LIMIT 1').get();
    if (!open) return; // the demo data may have no priced open job
    const c = customerDetail(S.db, F({ status: 'all' }), S.db.prepare('SELECT cust_id FROM jobs WHERE job_num = ?').get(open.job_num).cust_id);
    const j = c?.jobs.find((x) => x.job === open.job_num);
    if (j) assert.ok(!j.priced && j.margin === null);
  });

  test('CSV: the current view, all groups, with the filters', () => {
    const ops = exportCsv(S.db, F({ minJobs: 3 }), 'ops').trimEnd().split('\r\n');
    assert.match(ops[0], /^Operation,Jobs,Expected Hrs/);
    assert.equal(ops.length - 1, opsAndMaterials(S.db, F({ minJobs: 3 })).ops.all.length, 'every group, not only the top 10');
    const byRg = exportCsv(S.db, F({ opBy: 'rg' }), 'ops').split('\r\n')[0];
    assert.match(byRg, /^Resource Group,/);
    assert.match(exportCsv(S.db, F(), 'materials'), /^Material,Description,Jobs/);
    const cust = exportCsv(S.db, F(), 'customers').trimEnd().split('\r\n');
    assert.match(cust[0], /^Customer,Tier,Account Manager,Jobs,Priced Jobs,Sale Price \$,Actual Cost \$,Actual Margin \$,Actual Margin %,Target Margin %,Margin vs Target \$,Planned Margin %,Estimated Cost \$,Actual Cost \(All Jobs\) \$/);
    assert.equal(cust.length - 1, customersPage(S.db, F()).all.length);
    assert.notEqual(exportCsv(S.db, F({ from: '2999-01-01', to: '2999-12-31' }), 'ops'), exportCsv(S.db, F(), 'ops'));
  });
});

describe('the pages in the browser', () => {
  let S;
  before(async () => {
    S = await makeSession();
  });
  const q = 'from=2000-01-01&to=2999-01-01&minJobs=1&internal=1';

  test('both pages are in the main navigation next to the Dashboard, for everyone', async () => {
    for (const client of [S.admin, S.reviewer]) {
      const html = (await client.get('/')).body;
      assert.ok(html.indexOf('>Dashboard<') < html.indexOf('href="/accuracy/ops"'), 'Ops & Materials follows the Dashboard');
      assert.ok(html.indexOf('href="/accuracy/ops"') < html.indexOf('href="/accuracy/customers"'));
      assert.ok(html.indexOf('href="/accuracy/customers"') < html.indexOf('href="/jobs"'));
    }
  });

  test('Operations & Materials renders every part', async () => {
    const r = await S.reviewer.get(`/accuracy/ops?${q}`);
    assert.equal(r.statusCode, 200);
    for (const t of ['Labour Variance', 'Material Variance', 'Operation Accuracy', 'Material Accuracy', 'Needs Attention', 'Top 10 Operations: Jobs Over Estimates', 'Top 10 Materials: Jobs Over Estimates', 'Biggest Net Variances', 'Unestimated Work', 'Attention Score']) assert.ok(r.body.includes(t), t);
    assert.match(r.body, /id="divData"/);
    assert.match(r.body, /name="outliers"/);
    assert.match(r.body, /name="minJobs"/);
    assert.match(r.body, /data-href="\/accuracy\/ops\?[^"]*drill=op:/, 'rows go down a level');
    assert.match(r.body, /\/accuracy\/export\.csv\?[^"]*view=ops/);
  });

  test('the lists default to Jobs Over Estimates, and a dropdown picks over, under, both side by side or both stacked', async () => {
    const page = async (extra = '') => (await S.admin.get(`/accuracy/ops?${q}${extra}`)).body;
    const has = (body, s) => body.includes(s);

    const dflt = await page();
    assert.ok(has(dflt, 'Top 10 Operations: Jobs Over Estimates') && has(dflt, 'Top 10 Materials: Jobs Over Estimates'));
    assert.ok(!has(dflt, 'Jobs Under Estimates <small'), 'only the over lists by default');
    assert.match(dflt, /<select onchange="window\.location\.href=this\.value" aria-label="Which lists to show">/);
    const labels = [...dflt.matchAll(/<option value="[^"]*lists=(\w+)[^"]*" ?(selected)?>([^<]+)<\/option>/g)].map((m) => [m[1], m[3], !!m[2]]);
    assert.deepEqual(labels.slice(0, 4), [['over', 'Jobs Over Estimates', true], ['under', 'Jobs Under Estimates', false], ['h', 'Both - Horizontal Window', false], ['v', 'Both - Vertical Window', false]]);

    const under = await page('&lists=under');
    assert.ok(has(under, 'Top 10 Operations: Jobs Under Estimates') && !has(under, 'Top 10 Operations: Jobs Over Estimates'));
    assert.match(under, /<option value="[^"]*lists=under[^"]*" selected>/);

    const horizontal = await page('&lists=h');
    assert.ok(has(horizontal, 'Top 10 Operations: Jobs Over Estimates') && has(horizontal, 'Top 10 Operations: Jobs Under Estimates'));
    assert.match(horizontal, /<div class="grid-2 acc-pair">\s*<div><h3>Top 10 Operations: Jobs Over Estimates/);

    const vertical = await page('&lists=v');
    assert.ok(has(vertical, 'Top 10 Operations: Jobs Over Estimates') && has(vertical, 'Top 10 Operations: Jobs Under Estimates'));
    assert.match(vertical, /<div class="acc-stack">\s*<div><h3>Top 10 Operations: Jobs Over Estimates/);
    assert.ok(vertical.indexOf('Operations: Jobs Over Estimates') < vertical.indexOf('Operations: Jobs Under Estimates'), 'over first, then under, one below the other');

    assert.match(await page('&lists=nonsense'), /<option value="[^"]*lists=over[^"]*" selected>/, 'an unknown choice is the default');
  });

  test('changing the lists keeps every other filter and the open drill-down; Apply Filters keeps the lists', async () => {
    const key = opsAndMaterials(S.db, F()).ops.over[0].key;
    const body = (await S.admin.get(`/accuracy/ops?from=2000-01-01&to=2999-01-01&minJobs=2&basis=hours&sort=frequency&lists=h&drill=op:${encodeURIComponent(key)}`)).body;
    const urls = [...body.matchAll(/<option value="(\/accuracy\/ops\?[^"]+)"/g)].map((m) => new URLSearchParams(m[1].split('?')[1].replace(/&amp;/g, '&')));
    assert.ok(urls.length >= 4);
    const under = urls.find((u) => u.get('lists') === 'under');
    assert.equal(under.get('minJobs'), '2');
    assert.equal(under.get('basis'), 'hours');
    assert.equal(under.get('sort'), 'frequency');
    assert.equal(under.get('drill'), `op:${key}`, 'the open drill-down stays open');
    assert.match(body, /<input type="hidden" name="lists" value="h">/, 'Apply Filters keeps the layout');
    assert.ok(body.includes('class="grid-2 acc-pair"'));
  });

  test('customer list columns: variance, then sale price and margin; no gross column; no page switch (the top menu does that)', async () => {
    const body = (await S.admin.get(`/accuracy/customers?${q}`)).body;
    const head = /<table data-table="acc-customers"[^>]*>\s*<thead>(.*?)<\/thead>/s.exec(body)[1];
    const cols = [...head.matchAll(/<th[^>]*>(.*?)<\/th>/g)].map((m) => m[1]);
    assert.deepEqual(cols, ['Customer', 'Tier', 'Manager', 'Jobs', 'Est $', 'Act $', 'Net Var $', 'Var %', 'Sale $', 'Margin $', 'Margin %', 'Target %', 'vs Target $', 'Labour $', 'Material $', 'Other $', '% Off']);
    for (const url of [`/accuracy/customers?${q}`, `/accuracy/ops?${q}`]) assert.ok(!(await S.admin.get(url)).body.includes('acc-tabs'), url);
    assert.ok(!body.includes('Actual Margin'), 'the word Actual is dropped from the margin headings');
  });

  test('the Customers page and one customer have the same picker', async () => {
    const cust = (await S.admin.get(`/accuracy/customers?${q}`)).body;
    assert.match(cust, /Which lists to show/);
    assert.ok(cust.includes('Top 25 Customers: Jobs Over Estimates') && !cust.includes('Top 25 Customers: Jobs Under Estimates'));
    const both = (await S.admin.get(`/accuracy/customers?${q}&lists=v`)).body;
    assert.ok(both.includes('Top 25 Customers: Jobs Over Estimates') && both.includes('Top 25 Customers: Jobs Under Estimates') && both.includes('acc-stack'));
    const link = /data-href="(\/accuracy\/customers\/[^"?]+)\?/.exec(cust)[1];
    const detail = (await S.admin.get(`${link}?${q}&lists=h`)).body;
    for (const t of ['Operations: Jobs Over Estimates', 'Operations: Jobs Under Estimates', 'Materials: Jobs Over Estimates', 'Materials: Jobs Under Estimates']) assert.ok(detail.includes(t), t);
    assert.match(detail, /Which lists to show/);
  });

  test('nobody is blamed: no page says under-quoted or over-quoted', async () => {
    for (const url of [`/accuracy/ops?${q}&lists=h`, `/accuracy/customers?${q}&lists=h`]) {
      const body = (await S.admin.get(url)).body;
      assert.ok(!/(under|over)[- ]?quoted/i.test(body), `${url} still says "quoted"`);
    }
    assert.match(exportCsv(S.db, F(), 'ops'), /Over Estimate/);
  });

  test('the drill-down opens from a row, then narrows to one part', async () => {
    const d = opsAndMaterials(S.db, F());
    const key = d.ops.over[0].key;
    const r = await S.admin.get(`/accuracy/ops?${q}&drill=op:${encodeURIComponent(key)}`);
    assert.equal(r.statusCode, 200);
    assert.match(r.body, /id="drill"/);
    assert.match(r.body, /Setup vs Run/);
    assert.match(r.body, /id="trendData"/);
    assert.match(r.body, /Part Numbers It Appears On/);
    assert.match(r.body, /Contributing Jobs/);
    assert.match(r.body, /href="\/jobs\/\d+"/, 'jobs link to the job page');
    const part = drillDown(S.db, F(), { type: 'op', key }).parts[0].key;
    const r2 = await S.admin.get(`/accuracy/ops?${q}&drill=op:${encodeURIComponent(key)}&dpart=${encodeURIComponent(part)}`);
    assert.match(r2.body, new RegExp(`Contributing Jobs for Part ${part}`));
    assert.equal((await S.admin.get(`/accuracy/ops?${q}&drill=op:NO-SUCH`)).statusCode, 200, 'an unknown group just shows the page');
  });

  test('a material drill-down shows usage vs price', async () => {
    const lines = S.db.prepare("SELECT DISTINCT job_num FROM line_results WHERE kind = 'op' AND counted = 1 LIMIT 3").all();
    // the demo data flags no material, so give the first three jobs a stored material line to drill into
    const ins = S.db.prepare("INSERT INTO line_results (job_num, kind, assembly_seq, seq, counted, activity_date, part_num, description, class_id, flag, exp_qty, act_qty, est_dollars, act_dollars, var_dollars, usage_var, price_var, var_pct) VALUES (?, 'material', 0, 77, 1, '2026-01-10', 'STEEL-9', 'Plate', 'STEEL', 'yellow', 10, 12, 100, 140, 40, 20, 20, 0.4)");
    for (const l of lines) ins.run(l.job_num);
    S.db.prepare("UPDATE jobs SET closed = 1, closed_date = '2026-02-01' WHERE job_num IN (SELECT job_num FROM line_results WHERE part_num = 'STEEL-9')").run();
    // (the page reads fresh lines: the stored-lines memo is keyed on the metrics stamp, so move it on)
    S.db.prepare("UPDATE job_metrics SET computed_at = computed_at || 'x' WHERE job_num = ?").run(lines[0].job_num);
    const r = await S.admin.get(`/accuracy/ops?${q}&drill=mtl:STEEL-9`);
    assert.equal(r.statusCode, 200);
    assert.match(r.body, /Usage vs Price/);
    assert.match(r.body, /Price/);
    assert.match(r.body, /STEEL-9/);
  });

  test('Customers renders, and a customer opens in full', async () => {
    const r = await S.reviewer.get(`/accuracy/customers?${q}`);
    assert.equal(r.statusCode, 200);
    for (const t of ['Sold', 'Margin vs Target $', 'Customers at a Loss', 'Net Variance', 'Customer-Level Accuracy', 'Top 25 Customers: Jobs Over Estimates', 'How Often vs How Far Off']) assert.ok(r.body.includes(t), t);
    assert.match(r.body, /id="bubbleData"/);
    const link = /data-href="(\/accuracy\/customers\/[^"?]+)\?/.exec(r.body);
    assert.ok(link, 'rows link to the customer');
    const detail = await S.reviewer.get(`${link[1]}?${q}`);
    assert.equal(detail.statusCode, 200);
    for (const t of ['Variance % Over Time', 'Post-Mortems for This Customer', 'Root Causes Picked', "What Is Going Wrong on This Customer's Work", 'Repeat Part Numbers', 'All Jobs', 'across the shop']) assert.ok(detail.body.includes(t), t);
    assert.match(detail.body, /Worse than normal|Better than normal|In line with the shop/);
    assert.equal((await S.reviewer.get(`/accuracy/customers/NOBODY?${q}`)).statusCode, 404);
  });

  test('CSV downloads', async () => {
    for (const [view, head] of [['ops', 'Operation,'], ['materials', 'Material,'], ['customers', 'Customer,']]) {
      const r = await S.admin.get(`/accuracy/export.csv?${q}&view=${view}`);
      assert.equal(r.statusCode, 200);
      assert.match(r.headers['content-type'], /text\/csv/);
      assert.match(r.headers['content-disposition'], new RegExp(`quote-accuracy-${view}-2000-01-01-to-2999-01-01\\.csv`));
      assert.ok(r.body.replace('﻿', '').startsWith(head));
    }
    assert.match((await S.admin.get(`/accuracy/export.csv?${q}&view=nonsense`)).headers['content-disposition'], /-ops-/);
  });

  test('the pages need a signed-in person', async () => {
    const { Client } = await import('./helpers.js');
    const anon = new Client(S.admin.app);
    for (const url of ['/accuracy/ops', '/accuracy/customers', '/accuracy/export.csv']) {
      const r = await anon.get(url);
      assert.equal(r.statusCode, 302, url);
      assert.match(r.headers.location, /\/login/);
    }
  });
});
