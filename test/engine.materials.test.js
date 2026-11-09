import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMaterial, netTransactions } from '../src/engine/materials.js';
import { evaluateJob, diffSnapshot, flagLineRows } from '../src/engine/job.js';
import { DEFAULT_CONFIG } from '../src/engine/thresholds.js';

const cfg = { ...DEFAULT_CONFIG };
const closedJob = { jobNum: 'J1', prodQty: 10, qtyCompleted: 10, closed: true };
const openJob = { jobNum: 'J2', prodQty: 10, qtyCompleted: 4, closed: false };

const mtl = (o = {}) => ({
  assemblySeq: 0,
  mtlSeq: 10,
  partNum: 'PL-14GA',
  description: '14ga plate',
  requiredQty: 100,
  issuedQty: 100,
  ium: 'LB',
  estUnitCost: 2,
  issuedComplete: true,
  backflush: false,
  ...o,
});
const tran = (o = {}) => ({
  assemblySeq: 0,
  mtlSeq: 10,
  tranType: 'STK-MTL',
  tranQty: 100,
  mtlUnitCost: 2,
  extCost: 200,
  ...o,
});
const ev = (m, trans, job = closedJob, c = cfg) => evaluateMaterial(mtl(m), { cfg: c, job, trans });

describe('net of returns', () => {
  test('issues add, returns reduce (returns stored positive)', () => {
    const n = netTransactions([tran({ tranQty: 120, extCost: 240 }), tran({ tranType: 'MTL-STK', tranQty: 20, extCost: 40 })], cfg);
    assert.equal(n.netQty, 100);
    assert.equal(n.netCost, 200);
    assert.equal(n.returnedQty, 20);
  });
  test('returns reduce actuals even when the system stores them as negatives', () => {
    const n = netTransactions([tran({ tranQty: 120, extCost: 240 }), tran({ tranType: 'MTL-STK', tranQty: -20, extCost: -40 })], cfg);
    assert.equal(n.netQty, 100);
    assert.equal(n.netCost, 200);
  });
  test('a negative issue (reversal) nets out', () => {
    const n = netTransactions([tran({ tranQty: 100, extCost: 200 }), tran({ tranQty: -10, extCost: -20 })], cfg);
    assert.equal(n.netQty, 90);
    assert.equal(n.netCost, 180);
  });
  test('missing ExtCost is computed from the unit costs', () => {
    const n = netTransactions([tran({ tranQty: 10, extCost: null, mtlUnitCost: 2, lbrUnitCost: 0.5, burUnitCost: 0.25, subUnitCost: 0, mtlBurUnitCost: 0.25 })], cfg);
    assert.equal(n.netCost, 30);
  });
  test('unknown transaction types are ignored and counted', () => {
    const n = netTransactions([tran({ tranType: 'ADJ-QTY', tranQty: 999 })], cfg);
    assert.equal(n.used, 0);
    assert.equal(n.ignored, 1);
  });
  test('a return reduces the line variance end to end', () => {
    // required 100 @ $2. Issued 130, returned 30 -> net 100 = exactly on estimate.
    const r = ev({ issuedQty: 100 }, [tran({ tranQty: 130, extCost: 260 }), tran({ tranType: 'MTL-STK', tranQty: 30, extCost: 60 })]);
    assert.equal(r.actualQty, 100);
    assert.equal(r.actDollars, 200);
    assert.equal(r.dollarVar, 0);
    assert.equal(r.flag, 'green');
    assert.equal(r.returnedQty, 30);
  });
});

describe('quantity and dollar variance', () => {
  test('on estimate is green', () => {
    const r = ev({}, [tran()]);
    assert.equal(r.qtyVar, 0);
    assert.equal(r.dollarVar, 0);
    assert.equal(r.flag, 'green');
    assert.equal(r.qtySource, 'transactions');
  });
  test('qty over by 50% and above $ minimum flags red, direction over', () => {
    const r = ev({}, [tran({ tranQty: 150, extCost: 300 })]);
    assert.equal(r.qtyVar, 50);
    assert.equal(r.qtyPct, 0.5);
    assert.equal(r.dollarVar, 100);
    assert.equal(r.flagged, false, '$100 is under the $250 minimum');
    assert.equal(r.belowMinimum, true);
    const big = ev({ requiredQty: 1000, estUnitCost: 2 }, [tran({ tranQty: 1500, extCost: 3000 })]);
    assert.equal(big.dollarVar, 1000);
    assert.equal(big.flag, 'red');
    assert.equal(big.direction, 'over');
  });
  test('under-run (we over-quoted) flags too', () => {
    const r = ev({ requiredQty: 1000 }, [tran({ tranQty: 500, extCost: 1000 })]);
    assert.equal(r.flag, 'red');
    assert.equal(r.direction, 'under');
    assert.equal(r.dollarVar, -1000);
  });
  test('flags on dollars alone when quantity is fine (price moved)', () => {
    const r = ev({ requiredQty: 1000, estUnitCost: 2 }, [tran({ tranQty: 1000, extCost: 3000 })]);
    assert.equal(r.qtyVar, 0);
    assert.equal(r.dollarPct, 0.5);
    assert.equal(r.tripped, 'dollars');
    assert.equal(r.flag, 'red');
  });
  test('flags on quantity alone when a cheaper unit cost keeps dollars within tolerance', () => {
    // qty +26% (red) but the cheaper price keeps the $ variance at only +5%
    const r = ev({ requiredQty: 10000, estUnitCost: 2 }, [tran({ tranQty: 12600, extCost: 21000 })]);
    assert.equal(r.qtyPct, 0.26);
    assert.equal(r.dollarPct, 0.05);
    assert.equal(r.tripped, 'qty');
    assert.equal(r.flag, 'red', 'whichever measure trips wins, as long as the $ minimum is met');
  });
  test('both measures tripping is reported as both (worst tier wins)', () => {
    const r = ev({ requiredQty: 1000, estUnitCost: 2 }, [tran({ tranQty: 1200, extCost: 2250 })]);
    assert.equal(r.qtyPct, 0.2);
    assert.equal(r.dollarPct, 0.125);
    assert.equal(r.tripped, 'both');
    assert.equal(r.flag, 'yellow');
  });
  test('quantity trips but the dollars are under the minimum: not flagged', () => {
    const r = ev({ requiredQty: 1000, estUnitCost: 2 }, [tran({ tranQty: 1200, extCost: 2200 })]);
    assert.equal(r.dollarVar, 200);
    assert.equal(r.flag, 'green');
    assert.equal(r.belowMinimum, true);
  });
  test('no divide by zero when required qty is 0 (material not on the job = unplanned)', () => {
    const r = ev({ requiredQty: 0, estUnitCost: 0 }, [tran({ tranQty: 200, extCost: 600 })]);
    assert.equal(r.unplanned, true);
    assert.equal(r.qtyPct, null);
    assert.equal(r.dollarPct, null);
    assert.equal(r.flag, 'red');
    assert.ok(Number.isFinite(r.dollarVar));
  });
  test('required 0 and issued 0 is nothing', () => {
    const r = ev({ requiredQty: 0, issuedQty: 0 }, []);
    assert.equal(r.flag, 'green');
    assert.equal(r.unplanned, false);
  });
  test('falls back to JobMtl.IssuedQty when there are no transactions, with a data quality hint', () => {
    const r = ev({ issuedQty: 100 }, []);
    assert.equal(r.qtySource, 'jobmtl');
    assert.equal(r.actualQty, 100);
    assert.ok(r.dq.includes('no-transactions'));
  });
  test('missing estimated unit cost is a data quality hint', () => {
    const r = ev({ estUnitCost: null, unitCost: null }, [tran()]);
    assert.ok(r.dq.includes('no-est-cost'));
  });
  test('uses UnitCost when EstUnitCost is empty', () => {
    const r = ev({ estUnitCost: null, unitCost: 2 }, [tran()]);
    assert.equal(r.estDollars, 200);
  });
});

describe('usage vs price split', () => {
  test('usage + price = total variance', () => {
    // required 100 @ $2 = $200. Actual 120 pcs costing $300 ($2.50/unit)
    const r = ev({}, [tran({ tranQty: 120, extCost: 300 })]);
    assert.equal(r.usageVar, 40, '20 extra units x $2');
    assert.equal(r.priceVar, 60, '$300 - 120 x $2');
    assert.equal(r.usageVar + r.priceVar, r.dollarVar);
    assert.equal(r.dollarVar, 100);
  });
  test('pure price variance (right qty, paid more)', () => {
    const r = ev({}, [tran({ tranQty: 100, extCost: 250 })]);
    assert.equal(r.usageVar, 0);
    assert.equal(r.priceVar, 50);
  });
  test('pure usage variance (right price, used more)', () => {
    const r = ev({}, [tran({ tranQty: 130, extCost: 260 })]);
    assert.equal(r.usageVar, 60);
    assert.equal(r.priceVar, 0);
  });
  test('split holds when usage is under and price is over', () => {
    const r = ev({}, [tran({ tranQty: 80, extCost: 240 })]); // $3/unit
    assert.equal(r.usageVar, -40);
    assert.equal(r.priceVar, 80);
    assert.equal(r.usageVar + r.priceVar, r.dollarVar);
  });
  test('split always adds up, even when net qty is 0', () => {
    const r = ev({}, [tran({ tranQty: 10, extCost: 20 }), tran({ tranType: 'MTL-STK', tranQty: 10, extCost: 25 })]);
    assert.equal(r.actualQty, 0);
    assert.equal(r.usageVar + r.priceVar, r.dollarVar);
  });
  test('actual unit cost is reported', () => {
    assert.equal(ev({}, [tran({ tranQty: 100, extCost: 250 })]).actualUnitCost, 2.5);
  });
});

describe('quantity normalisation for materials', () => {
  test('closed job that made fewer pieces: expected qty scales down', () => {
    const job = { ...closedJob, prodQty: 10, qtyCompleted: 8 };
    const r = ev({ requiredQty: 100 }, [tran({ tranQty: 80, extCost: 160 })], job);
    assert.equal(r.normalized, true);
    assert.equal(r.expectedQty, 80);
    assert.equal(r.qtyVar, 0);
    assert.equal(r.flag, 'green');
  });
  test('closed job that made more pieces: expected qty scales up', () => {
    const job = { ...closedJob, prodQty: 10, qtyCompleted: 12 };
    const r = ev({ requiredQty: 100 }, [tran({ tranQty: 120, extCost: 240 })], job);
    assert.equal(r.expectedQty, 120);
    assert.equal(r.qtyVar, 0);
  });
  test('can be switched off in settings', () => {
    const job = { ...closedJob, prodQty: 10, qtyCompleted: 8 };
    const r = ev({ requiredQty: 100 }, [tran({ tranQty: 80, extCost: 160 })], job, { ...cfg, normalizeMaterialByQty: false });
    assert.equal(r.normalized, false);
    assert.equal(r.expectedQty, 100);
  });
  test('qty completed 0 cannot normalise', () => {
    const r = ev({}, [tran()], { ...closedJob, qtyCompleted: 0 });
    assert.equal(r.normalized, false);
  });
  test('open jobs are not normalised (material is issued ahead of production)', () => {
    const r = ev({ issuedComplete: true }, [tran()], openJob);
    assert.equal(r.normalized, false);
    assert.equal(r.expectedQty, 100);
  });
});

describe('in-progress jobs and partial issue', () => {
  test('under-issued line that is not marked issue-complete is pending, not a miss', () => {
    const r = ev({ requiredQty: 1000, issuedComplete: false }, [tran({ tranQty: 100, extCost: 200 })], openJob);
    assert.equal(r.pending, true);
    assert.equal(r.flag, 'green');
  });
  test('over-issue on an open job is still flagged', () => {
    const r = ev({ requiredQty: 1000, issuedComplete: false }, [tran({ tranQty: 1400, extCost: 2800 })], openJob);
    assert.equal(r.pending, false);
    assert.equal(r.flag, 'red');
  });
  test('issue-complete line on an open job can be flagged as under', () => {
    const r = ev({ requiredQty: 1000, issuedComplete: true }, [tran({ tranQty: 500, extCost: 1000 })], openJob);
    assert.equal(r.pending, false);
    assert.equal(r.flag, 'red');
    assert.equal(r.direction, 'under');
  });
  test('closed job: under-issue is real', () => {
    const r = ev({ requiredQty: 1000, issuedComplete: false }, [tran({ tranQty: 500, extCost: 1000 })], closedJob);
    assert.equal(r.pending, false);
    assert.equal(r.flag, 'red');
  });
});

describe('backflush', () => {
  test('backflushed lines are marked so reviewers know quantities are system-generated', () => {
    const r = ev({ backflush: true }, [tran()]);
    assert.equal(r.backflush, true);
    assert.equal(ev({ backflush: false }, [tran()]).backflush, false);
  });
});

describe('whole job', () => {
  const op = (o = {}) => ({
    assemblySeq: 0, oprSeq: 10, opCode: 'WELD', resourceGrpId: 'W1', estSetHours: 0, estProdHours: 10,
    actSetupHours: 0, actProdHours: 20, runQty: 10, qtyCompleted: 10, opComplete: true, subcontract: false,
    setLabRate: 40, prodLabRate: 40, setBurRate: 20, prodBurRate: 20, ...o,
  });
  const inputs = () => ({
    job: { ...closedJob, partNum: 'P-1', custName: 'ACME' },
    ops: [op(), op({ oprSeq: 20, opCode: 'PACK', estProdHours: 4, actProdHours: 1 })],
    materials: [mtl({ requiredQty: 1000 })],
    transactions: [tran({ tranQty: 1500, extCost: 3000 })],
    labor: [],
  });

  test('totals, over/under split, impact and worst flag', () => {
    const r = evaluateJob(inputs());
    // WELD: +10 hrs x $60 = +600 ; PACK: -3 hrs x $60 = -180 ; material +1000
    assert.equal(r.totals.labour.varDollars, 420);
    assert.equal(r.totals.material.varDollars, 1000);
    assert.equal(r.totals.netDollars, 1420);
    assert.equal(r.totals.overDollars, 1600);
    assert.equal(r.totals.underDollars, 180);
    assert.equal(r.totals.impactDollars, 1780);
    assert.equal(r.flag, 'red');
    assert.equal(r.flaggedLines, 3);
  });

  test('partially complete job: only completed ops count toward variance', () => {
    const i = inputs();
    i.job = { ...i.job, closed: false };
    i.ops[0] = op({ opComplete: false, actProdHours: 20 }); // huge overrun but still open
    i.ops[1] = op({ oprSeq: 20, opCode: 'PACK', estProdHours: 4, actProdHours: 1, opComplete: true });
    i.materials = [];
    i.transactions = [];
    const r = evaluateJob(i);
    assert.equal(r.ops[0].counts, false);
    assert.equal(r.totals.labour.varDollars, -180, 'open WELD op excluded');
    assert.equal(r.watch.length, 1, 'open op goes to the watchlist');
    assert.equal(r.watch[0].opCode, 'WELD');
  });

  test('closed jobs have no watchlist', () => {
    assert.equal(evaluateJob(inputs()).watch.length, 0);
  });

  test('pending material is left out of job totals', () => {
    const i = inputs();
    i.job = { ...i.job, closed: false, qtyCompleted: 4 };
    i.materials = [mtl({ requiredQty: 1000, issuedComplete: false })];
    i.transactions = [tran({ tranQty: 100, extCost: 200 })];
    const r = evaluateJob(i);
    assert.equal(r.totals.material.varDollars, 0);
  });

  test('LaborDtl cross-check flags a mismatch per operation', () => {
    const i = inputs();
    i.labor = [{ assemblySeq: 0, oprSeq: 10, laborHrs: 12 }];
    const r = evaluateJob(i);
    assert.ok(r.ops[0].dq.includes('labor-mismatch'));
    assert.ok(r.ops[1].dq.includes('labor-mismatch'), 'op with hours but no labour rows');
  });

  test('flag line rows are produced for flagged lines only', () => {
    const rows = flagLineRows(evaluateJob(inputs()));
    assert.equal(rows.length, 3);
    assert.ok(rows.every((x) => ['red', 'yellow'].includes(x.flag)));
    assert.deepEqual(rows.map((x) => x.kind).sort(), ['material', 'op', 'op']);
  });

  test('a job with nothing wrong is green with no flagged lines', () => {
    const i = inputs();
    i.ops = [op({ actProdHours: 10 })];
    i.materials = [mtl()];
    i.transactions = [tran()];
    const r = evaluateJob(i);
    assert.equal(r.flag, 'green');
    assert.equal(r.flaggedLines, 0);
    assert.equal(r.totals.impactDollars, 0);
  });
});

describe('snapshots', () => {
  const base = () => ({
    job: { ...closedJob },
    ops: [{ assemblySeq: 0, oprSeq: 10, opCode: 'WELD', estProdHours: 10, actProdHours: 12, runQty: 10, qtyCompleted: 10, opComplete: true, setLabRate: 40, prodLabRate: 40, setBurRate: 20, prodBurRate: 20 }],
    materials: [],
    transactions: [],
    labor: [],
  });
  test('identical data has the same fingerprint and no differences', () => {
    const a = evaluateJob(base());
    const b = evaluateJob(base());
    assert.equal(a.fingerprint, b.fingerprint);
    assert.deepEqual(diffSnapshot(JSON.parse(JSON.stringify(a)), b), []);
  });
  test('later changes in Epicor are detected and described', () => {
    const snap = JSON.parse(JSON.stringify(evaluateJob(base())));
    const later = base();
    later.ops[0].actProdHours = 15;
    const live = evaluateJob(later);
    assert.notEqual(snap.fingerprint, live.fingerprint);
    const diff = diffSnapshot(snap, live);
    const hrs = diff.find((d) => d.label === 'Labour actual hours');
    assert.equal(hrs.before, 12);
    assert.equal(hrs.after, 15);
  });
  test('the snapshot itself never changes when live data changes', () => {
    const snap = JSON.stringify(evaluateJob(base()));
    const later = base();
    later.ops[0].actProdHours = 99;
    evaluateJob(later);
    assert.equal(JSON.stringify(JSON.parse(snap)), snap);
  });
});
