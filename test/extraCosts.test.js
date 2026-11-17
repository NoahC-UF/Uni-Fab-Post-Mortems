import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { computeEconomics } from '../src/economics.js';
import { loadExtraCosts, NO_EXTRA } from '../src/extraCosts.js';
import { recomputeJobs, evaluateStoredJob } from '../src/metrics.js';
import { customersPage, parseAccuracyFilters } from '../src/accuracy.js';
import { makeSession } from './helpers.js';

// A job planned at $1,000 labour + 10 x $50 material = $1,500 that actually cost $1,500 labour + $600 material = $2,100.
const result = () => ({
  jobState: 'closed',
  ops: [{ subcontract: false, estDollars: 1000, actDollars: 1500 }],
  materials: [
    { assemblySeq: 0, mtlSeq: 10, qtySource: 'transactions', requiredQty: 10, estUnitCost: 50, actDollars: 600 },
    { assemblySeq: 0, mtlSeq: 20, qtySource: 'jobmtl', requiredQty: 0, estUnitCost: 0, actDollars: 0 },
  ],
});
const price = [{ orderNum: 1, orderLine: 1, extPrice: 5000, allocQty: 0, orderQty: 0 }];

describe('margin cost: sub-assemblies, inspection material and subcontract', () => {
  test('with no extras the cost is unchanged', () => {
    const a = computeEconomics(result(), price);
    const b = computeEconomics(result(), price, { extra: NO_EXTRA });
    assert.equal(a.cost.actual, 2100);
    assert.deepEqual([b.cost.planned, b.cost.actual], [a.cost.planned, a.cost.actual]);
  });

  test('sub-assemblies add their planned and actual cost, and a real overrun shows', () => {
    const e = computeEconomics(result(), price, { extra: { subAssembly: { planned: 1000, actual: 1400, items: [{ part: 'R2', job: 'J-1-601', planned: 1000, actual: 1400 }] }, inspection: { actual: 0, lines: [] }, subcontract: { actual: 0 } } });
    assert.equal(e.cost.planned, 2500);
    assert.equal(e.cost.actual, 3500);
    assert.equal(e.subAssembly.diff, 400);
    assert.equal(e.margin.actual, 1500);
    assert.equal(e.margin.actualPct, 0.3);
  });

  test('subcontract is planned = actual, so it is cost but never an overrun', () => {
    const base = computeEconomics(result(), price);
    const e = computeEconomics(result(), price, { extra: { subAssembly: NO_EXTRA.subAssembly, inspection: { actual: 0, lines: [] }, subcontract: { actual: 800 } } });
    assert.equal(e.cost.planned, base.cost.planned + 800);
    assert.equal(e.cost.actual, base.cost.actual + 800);
    assert.equal(e.cost.diff, base.cost.diff, 'the overrun is the same as without it');
    assert.equal(e.subcontract.diff, 0);
  });

  test('inspection: the real cost replaces the estimate on a line with no issue transactions, and is added on a line that has them', () => {
    const r = result();
    r.materials[1] = { assemblySeq: 0, mtlSeq: 20, qtySource: 'jobmtl', requiredQty: 2, estUnitCost: 100, actDollars: 200 }; // counted at issued qty x estimate
    const e = computeEconomics(r, price, {
      extra: { subAssembly: NO_EXTRA.subAssembly, inspection: { actual: 560, lines: [{ assemblySeq: 0, mtlSeq: 20, cost: 260 }, { assemblySeq: 0, mtlSeq: 10, cost: 300 }] }, subcontract: { actual: 0 } },
    });
    // line 20: 260 replaces the 200 guess (+60); line 10 already has transactions, so 300 is added
    assert.equal(e.material.inspection, 360);
    assert.equal(e.material.actual, 600 + 200 + 360);
    assert.equal(e.material.planned, 500 + 200, 'planned cost is untouched');
  });

  test('loadExtraCosts reads sub-assemblies (with the sub-assembly job\'s own planned cost), inspection and subcontract from the transactions', async () => {
    const S = await makeSession();
    const db = S.db;
    const parent = db.prepare("SELECT job_num FROM jobs WHERE closed = 1 AND order_num IS NOT NULL ORDER BY job_num LIMIT 1").get().job_num;
    const child = `${parent}-601`;
    const donor = db.prepare('SELECT job_num FROM jobs WHERE closed = 1 AND job_num <> ? AND (SELECT COUNT(*) FROM job_operations o WHERE o.job_num = jobs.job_num) > 0 ORDER BY job_num LIMIT 1').get(parent).job_num;

    // the sub-assembly job: a copy of another job, with its own part number and no order
    const copy = (table, cols) => {
      for (const row of db.prepare(`SELECT * FROM ${table} WHERE job_num = ?`).all(donor)) {
        const r = { ...row, job_num: child, ...cols };
        const names = Object.keys(r);
        db.prepare(`INSERT INTO ${table} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...names.map((n) => r[n]));
      }
    };
    copy('jobs', { part_num: 'SUB-ASM-1', order_num: null, cust_id: '', cust_name: '' });
    copy('job_operations', {});
    copy('job_materials', {});
    const childPlan = computeEconomics(evaluateStoredJob(db, child), []).cost.planned;
    assert.ok(childPlan > 0, 'the copied job has a plan');

    const tran = db.prepare('INSERT INTO material_transactions (tran_num, tran_date, tran_type, job_num, assembly_seq, mtl_seq, part_num, tran_qty, ext_cost) VALUES (?,?,?,?,?,?,?,?,?)');
    tran.run(9000001, '2026-03-01', 'WIP-MFG', parent, 0, 900, 'SUB-ASM-1', 1, childPlan + 500);
    tran.run(9000002, '2026-03-01', 'WIP-MFG', parent, 0, 901, 'NOT-A-JOB', 1, 300);
    tran.run(9000003, '2026-03-01', 'PUR-SUB', parent, 0, 0, 'OUTSIDE', 1, 1200);
    tran.run(9000004, '2026-03-01', 'INS-SUB', parent, 0, 0, 'OUTSIDE2', 1, 300);
    tran.run(9000005, '2026-03-01', 'INS-MTL', parent, 0, 5, 'X', 2, 700);
    tran.run(9000006, '2026-03-01', 'PUR-INS', parent, 0, 5, 'X', 2, 700); // the receipt into inspection: never counted

    const x = loadExtraCosts(db, parent);
    assert.equal(x.subcontract.actual, 1500, 'PUR-SUB + INS-SUB');
    assert.equal(x.inspection.actual, 700, 'INS-MTL only');
    assert.equal(x.subAssembly.actual, childPlan + 800);
    const item = x.subAssembly.items.find((i) => i.part === 'SUB-ASM-1');
    assert.equal(item.job, child);
    assert.equal(item.planned, Math.round(childPlan * 100) / 100, 'planned = what that job was set up to cost');
    assert.equal(x.subAssembly.items.find((i) => i.part === 'NOT-A-JOB').planned, 300, 'no such job in the app: planned = actual');

    // stored margins use it; variances and flags do not move
    const before = db.prepare('SELECT * FROM job_metrics WHERE job_num = ?').get(parent);
    recomputeJobs(db, [parent]);
    const after = db.prepare('SELECT * FROM job_metrics WHERE job_num = ?').get(parent);
    assert.ok(after.actual_cost > before.actual_cost + 2000, 'cost went up by the sub-assemblies, subcontract and inspection material');
    for (const k of ['flag', 'flagged_lines', 'impact_dollars', 'net_dollars', 'labour_var_dollars', 'material_var_dollars']) assert.equal(after[k], before[k], `${k} unchanged`);
    assert.equal(after.price, before.price);
    assert.ok(after.actual_margin < before.actual_margin);
  });

  test('Customers: cost of an unpriced closed job on a priced order counts against that order\'s revenue', async () => {
    const S = await makeSession();
    const db = S.db;
    const priced = db.prepare("SELECT j.job_num, j.order_num, m.actual_cost FROM jobs j JOIN job_metrics m ON m.job_num = j.job_num WHERE j.closed = 1 AND m.price > 0 AND j.order_num IS NOT NULL ORDER BY j.job_num LIMIT 1").get();
    const donor = db.prepare("SELECT job_num FROM jobs WHERE closed = 1 AND job_num <> ? ORDER BY job_num LIMIT 1").get(priced.job_num).job_num;
    // make another closed job part of the same order, with no price of its own
    db.prepare('UPDATE jobs SET order_num = ?, cust_id = (SELECT cust_id FROM jobs WHERE job_num = ?), cust_name = (SELECT cust_name FROM jobs WHERE job_num = ?) WHERE job_num = ?').run(priced.order_num, priced.job_num, priced.job_num, donor);
    db.prepare('DELETE FROM job_revenue WHERE job_num = ?').run(donor);
    recomputeJobs(db, [donor]);
    const sib = db.prepare('SELECT price, actual_cost, planned_cost FROM job_metrics WHERE job_num = ?').get(donor);
    assert.ok(sib.price === null && sib.actual_cost > 0);

    const f = { ...parseAccuracyFilters({ from: '2000-01-01', to: '2999-01-01', internal: '1', minJobs: '1' }, new Date('2026-06-15T12:00:00Z'), {}) };
    const cust = db.prepare('SELECT cust_id FROM jobs WHERE job_num = ?').get(priced.job_num).cust_id;
    const g = customersPage(db, f).all.find((x) => x.key === cust);
    const pricedCost = db.prepare("SELECT SUM(m.actual_cost) c FROM jobs j JOIN job_metrics m ON m.job_num = j.job_num WHERE j.closed = 1 AND m.price > 0 AND j.cust_id = ?").get(cust).c;
    assert.ok(Math.abs(g.orderCost - sib.actual_cost) < 0.05, 'the unpriced job\'s cost is picked up');
    assert.ok(Math.abs(g.cost - (pricedCost + sib.actual_cost)) < 0.1, 'and is inside the customer\'s cost');
    assert.ok(Math.abs(g.margin - (g.price - g.cost)) < 0.05);
  });
});
