import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate } from '../src/db.js';
import { MockSource } from '../src/mock/mockSource.js';
import { runSync } from '../src/sync/sync.js';
import { buildJobView } from '../src/jobView.js';
import { computeEconomics, priceFromLines } from '../src/economics.js';

const quiet = { info() {}, warn() {}, error() {} };

// A job planned at $1,000 labour + 10 x $50 material = $1,500, that actually cost $1,500 labour + $600 material = $2,100.
const result = (state = 'closed') => ({
  jobState: state,
  ops: [
    { subcontract: false, estDollars: 1000, actDollars: 1500 },
    { subcontract: true, estDollars: 0, actDollars: 0 },
  ],
  materials: [{ requiredQty: 10, estUnitCost: 50, actDollars: 600 }],
});
const line = (extPrice, allocQty = 0, orderQty = 0, orderNum = 1, orderLine = 1) => ({ orderNum, orderLine, extPrice, allocQty, orderQty });

describe('price from sales order lines', () => {
  test('a job takes its share of each order line', () => {
    const p = priceFromLines([line(10000, 6, 10, 1, 1), line(2000, 4, 4, 2, 1)]);
    assert.equal(p.total, 8000, '60% of 10,000 + all of 2,000');
    assert.equal(p.anyAssumed, false);
  });
  test('unknown share counts the whole line and says so', () => {
    const p = priceFromLines([line(5000, 0, 0)]);
    assert.equal(p.total, 5000);
    assert.equal(p.anyAssumed, true);
    assert.equal(p.lines[0].shareKnown, false);
  });
  test('no lines means no price (not a price of zero)', () => {
    assert.equal(priceFromLines([]).total, null);
  });
});

describe('cost and margin', () => {
  test('planned and actual cost, margins and the differences', () => {
    const e = computeEconomics(result(), [line(3000)], { targetMarginPct: 20 });
    assert.equal(e.labour.planned, 1000);
    assert.equal(e.material.planned, 500);
    assert.equal(e.cost.planned, 1500);
    assert.equal(e.cost.actual, 2100);
    assert.equal(e.cost.diff, 600);
    assert.equal(e.margin.planned, 1500);
    assert.equal(e.margin.actual, 900);
    assert.equal(e.margin.plannedPct, 0.5);
    assert.equal(e.margin.actualPct, 0.3);
    assert.equal(e.margin.lost, 600);
    assert.equal(e.currency, 'CAD');
  });
  test('subcontract operations are left out of labour cost', () => {
    const r = result();
    r.ops[1] = { subcontract: true, estDollars: 999, actDollars: 999 };
    assert.equal(computeEconomics(r, [line(3000)]).labour.planned, 1000);
  });
});

describe('what went wrong?', () => {
  test('met target: ok', () => {
    assert.equal(computeEconomics(result(), [line(3000)], { targetMarginPct: 20 }).verdict.code, 'ok');
  });
  test('plan looked healthy but the job overran: points at hours / material, not price', () => {
    // price 2,300: planned margin 800 = 34.8%; actual 200 = 8.7%
    const v = computeEconomics(result(), [line(2300)], { targetMarginPct: 20 }).verdict;
    assert.equal(v.code, 'overrun');
    assert.match(v.text, /plan was healthy/);
  });
  test('price did not even cover the plan: points at quoting and set-up', () => {
    // price 1,700: planned margin 200 = 11.8% < 20%
    const v = computeEconomics(result(), [line(1700)], { targetMarginPct: 20 }).verdict;
    assert.equal(v.code, 'price-vs-plan');
    assert.match(v.text, /quote price/);
  });
  test('no price, or no plan, are reported plainly', () => {
    assert.equal(computeEconomics(result(), []).verdict.code, 'no-price');
    assert.equal(computeEconomics(result(), []).margin.actual, null);
    const empty = { jobState: 'closed', ops: [], materials: [] };
    assert.equal(computeEconomics(empty, [line(1000)]).verdict.code, 'no-plan');
  });
  test('an open job says "so far"', () => {
    const e = computeEconomics(result('open'), [line(2300)], { targetMarginPct: 20 });
    assert.equal(e.closed, false);
    assert.match(e.verdict.text, /so far/);
  });
  test('the target margin setting changes the verdict', () => {
    assert.equal(computeEconomics(result(), [line(2300)], { targetMarginPct: 5 }).verdict.code, 'ok');
  });
});

describe('sale price through the sync', () => {
  let db;
  before(async () => {
    db = openDb(':memory:');
    migrate(db);
    await runSync({ db, source: new MockSource(), kind: 'full', logger: quiet });
  });

  test('the demo data has prices, and a job with no sales order has none', () => {
    assert.ok(db.prepare('SELECT COUNT(*) n FROM job_revenue').get().n > 50);
    const withOrder = db.prepare('SELECT job_num FROM jobs WHERE order_num IS NOT NULL AND closed = 1 LIMIT 1').get().job_num;
    const without = db.prepare('SELECT job_num FROM jobs WHERE order_num IS NULL LIMIT 1').get().job_num;
    assert.ok(buildJobView(db, withOrder).economics.price > 0);
    const none = buildJobView(db, without).economics;
    assert.equal(none.price, null);
    assert.equal(none.verdict.code, 'no-price');
  });

  test('the demo includes jobs whose price was the problem and jobs whose overrun was', () => {
    const codes = new Set(
      db.prepare('SELECT job_num FROM jobs WHERE closed = 1 AND order_num IS NOT NULL').all().map((r) => buildJobView(db, r.job_num).economics.verdict.code),
    );
    assert.ok(codes.has('price-vs-plan'), [...codes].join());
    assert.ok(codes.has('ok'), [...codes].join());
  });

  test('a batched job (several order lines) adds the lines up', () => {
    const multi = db.prepare('SELECT job_num, COUNT(*) n FROM job_revenue GROUP BY job_num HAVING n > 1 LIMIT 1').get();
    assert.ok(multi, 'demo has a batched job');
    const e = buildJobView(db, multi.job_num).economics;
    assert.equal(e.priceLines.length, multi.n);
    const sum = db.prepare('SELECT SUM(ext_price) s FROM job_revenue WHERE job_num = ?').get(multi.job_num).s;
    assert.ok(Math.abs(e.price - sum) < 0.02);
  });

  test('if the optional price BAQ fails, the sync still succeeds, says so, and keeps the prices it had', async () => {
    const before = db.prepare('SELECT COUNT(*) n FROM job_revenue').get().n;
    const source = new MockSource();
    const real = source.fetchBaq.bind(source);
    source.fetchBaq = async (key, o) => {
      if (key === 'jobRevenue') throw new Error('Epicor could not find that BAQ (404).');
      return real(key, o);
    };
    const r = await runSync({ db, source, kind: 'full', logger: quiet });
    assert.equal(r.ok, true, r.error);
    assert.ok(r.warnings.some((w) => /JobRevenue was skipped/.test(w) && /404/.test(w)), r.warnings.join(' | '));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM job_revenue').get().n, before, 'existing prices are kept');
  });

  test('a required BAQ failing still stops the sync (only the price one is optional)', async () => {
    const source = new MockSource();
    const real = source.fetchBaq.bind(source);
    source.fetchBaq = async (key, o) => {
      if (key === 'jobOperations') throw new Error('boom');
      return real(key, o);
    };
    const r = await runSync({ db, source, kind: 'full', logger: quiet });
    assert.equal(r.ok, false);
  });
});

describe('margins stored for the Flagged Jobs grid and export', () => {
  let db;
  before(async () => {
    db = openDb(':memory:');
    migrate(db);
    await runSync({ db, source: new MockSource(), kind: 'full', logger: quiet });
  });

  test('every job has its price, margins and likely cause stored, matching the job page', () => {
    const rows = db.prepare('SELECT * FROM job_metrics m JOIN jobs j ON j.job_num = m.job_num WHERE j.closed = 1').all();
    assert.ok(rows.length > 20);
    for (const m of rows.slice(0, 25)) {
      const e = buildJobView(db, m.job_num).economics;
      assert.equal(m.cause, e.verdict.code, m.job_num);
      assert.equal(m.price, e.price, m.job_num);
      assert.equal(m.actual_margin, e.margin.actual, m.job_num);
      assert.equal(m.planned_margin_pct, e.margin.plannedPct, m.job_num);
    }
    assert.ok(rows.some((m) => m.price === null && m.cause === 'no-price'), 'jobs without an order are stored as no-price');
  });

  test('a changed target margin re-labels the jobs', async () => {
    const { setSettings } = await import('../src/settings.js');
    const { recomputeJobs } = await import('../src/metrics.js');
    const count = (code) => db.prepare('SELECT COUNT(*) n FROM job_metrics WHERE cause = ?').get(code).n;
    const okAt20 = count('ok');
    setSettings(db, { targetMarginPct: 60 });
    recomputeJobs(db);
    assert.ok(count('ok') < okAt20, 'a tougher target leaves fewer jobs on target');
    setSettings(db, { targetMarginPct: 20 });
    recomputeJobs(db);
    assert.equal(count('ok'), okAt20);
  });

  test('after an update that adds stored numbers, every job is re-checked once at start-up', async () => {
    const { ensureMetricsCurrent } = await import('../src/metrics.js');
    db.prepare("DELETE FROM settings WHERE key = '_metrics_version'").run();
    db.prepare('UPDATE job_metrics SET price = NULL, cause = NULL').run();
    assert.ok(ensureMetricsCurrent(db) > 50);
    assert.ok(db.prepare('SELECT COUNT(*) n FROM job_metrics WHERE cause IS NULL').get().n === 0);
    assert.equal(ensureMetricsCurrent(db), 0, 'and not again');
  });
});
