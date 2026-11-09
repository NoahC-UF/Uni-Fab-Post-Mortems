import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateOperation, evaluateWatch, countsTowardVariance, opRates } from '../src/engine/labour.js';
import { DEFAULT_CONFIG, tierFor, passesMinimum, limitsFor } from '../src/engine/thresholds.js';
import { r2 } from '../src/engine/num.js';

const cfg = { ...DEFAULT_CONFIG };
const RATES = { setLabRate: 40, prodLabRate: 40, setBurRate: 20, prodBurRate: 20 }; // $60/hr

const op = (o = {}) => ({
  assemblySeq: 0,
  oprSeq: 10,
  opCode: 'WELD',
  opDesc: 'Weld',
  resourceGrpId: 'WELD1',
  estSetHours: 1,
  estProdHours: 9,
  actSetupHours: 1,
  actProdHours: 9,
  runQty: 10,
  qtyCompleted: 10,
  opComplete: true,
  subcontract: false,
  ...RATES,
  ...o,
});
const ev = (o, ctx = {}) => evaluateOperation(op(o), { cfg, jobClosed: true, ...ctx });

describe('tiers', () => {
  const lim = { greenMax: 0.1, yellowMax: 0.25 };
  test('green below 10%, yellow 10-25% inclusive, red above 25%', () => {
    assert.equal(tierFor(0.0999, lim), 'green');
    assert.equal(tierFor(0.1, lim), 'yellow');
    assert.equal(tierFor(0.25, lim), 'yellow');
    assert.equal(tierFor(0.2501, lim), 'red');
  });
  test('under-runs tier the same as over-runs', () => {
    assert.equal(tierFor(-0.05, lim), 'green');
    assert.equal(tierFor(-0.15, lim), 'yellow');
    assert.equal(tierFor(-0.4, lim), 'red');
  });
  test('floating point noise cannot push exactly 10% into green', () => {
    assert.equal(tierFor((1.1 - 1) / 1, lim), 'yellow');
    assert.equal(tierFor(0.1 - 1e-12, lim), 'yellow');
  });
  test('op code override beats resource group beats global', () => {
    const c = {
      ...cfg,
      opCodeOverrides: { WELD: { greenMax: 0.05, yellowMax: 0.1 } },
      resourceGroupOverrides: { WELD1: { greenMax: 0.2, yellowMax: 0.4 }, ASSY1: { greenMax: 0.2, yellowMax: 0.4 } },
    };
    assert.deepEqual(limitsFor(c, { opCode: 'WELD', resourceGrpId: 'WELD1' }), { greenMax: 0.05, yellowMax: 0.1, source: 'op_code' });
    assert.equal(limitsFor(c, { opCode: 'ASSY', resourceGrpId: 'ASSY1' }).source, 'resource_group');
    assert.equal(limitsFor(c, { opCode: 'PACK', resourceGrpId: 'PACK1' }).source, 'global');
    assert.equal(limitsFor(c, { opCode: 'PACK' }).greenMax, 0.1);
  });
});

describe('minimum to flag', () => {
  test('passes on hours OR dollars', () => {
    assert.equal(passesMinimum({ hours: 2, dollars: 0 }, cfg), true);
    assert.equal(passesMinimum({ hours: 0.5, dollars: 250 }, cfg), true);
    assert.equal(passesMinimum({ hours: 1.9, dollars: 249 }, cfg), false);
    assert.equal(passesMinimum({ hours: -3, dollars: 0 }, cfg), true, 'under-runs count too');
  });
  test('hours = null means no hours measure (materials)', () => {
    assert.equal(passesMinimum({ hours: null, dollars: 100 }, cfg), false);
    assert.equal(passesMinimum({ hours: null, dollars: -300 }, cfg), true);
  });
});

describe('operation hours and dollars', () => {
  test('on-estimate op is green with zero variance', () => {
    const r = ev();
    assert.equal(r.flag, 'green');
    assert.equal(r.varHours, 0);
    assert.equal(r.direction, 'even');
  });

  test('estimated = setup + run; actual = setup + run; variance = actual - estimated', () => {
    const r = ev({ estSetHours: 1, estProdHours: 9, actSetupHours: 2, actProdHours: 12 });
    assert.equal(r.est.total, 10);
    assert.equal(r.act.total, 14);
    assert.equal(r.var.totalHrs, 4);
    assert.equal(r.varHours, 4);
    assert.equal(r.varPct, 0.4);
  });

  test('setup and run are reported separately and the driver is identified', () => {
    const r = ev({ estSetHours: 1, estProdHours: 9, actSetupHours: 4, actProdHours: 9 });
    assert.equal(r.var.setupHrs, 3);
    assert.equal(r.var.setupPct, 3);
    assert.equal(r.var.runHrs, 0);
    assert.equal(r.var.runPct, 0);
    assert.equal(r.driver, 'setup');
    const r2_ = ev({ estSetHours: 1, estProdHours: 9, actSetupHours: 1, actProdHours: 14 });
    assert.equal(r2_.driver, 'run');
    assert.equal(ev().driver, null);
  });

  test('dollars use separate setup and production rates (labour + burden)', () => {
    const r = ev({ setLabRate: 50, setBurRate: 30, prodLabRate: 40, prodBurRate: 20, estSetHours: 1, estProdHours: 1, actSetupHours: 2, actProdHours: 1 });
    assert.equal(r.rates.setup, 80);
    assert.equal(r.rates.prod, 60);
    assert.equal(r.estDollars, 140);
    assert.equal(r.actDollars, 220);
    assert.equal(r.varDollars, 80);
  });

  test('rate overrides replace Epicor rates, blank fields fall back to Epicor', () => {
    const c = { ...cfg, rateOverrides: { WELD1: { setLab: 100, prodLab: '', setBur: null, prodBur: 0 } } };
    const rates = opRates(op(), c);
    assert.equal(rates.setLab, 100);
    assert.equal(rates.prodLab, 40, 'blank falls back');
    assert.equal(rates.setBur, 20, 'null falls back');
    assert.equal(rates.prodBur, 0, 'explicit zero is a real override');
  });

  test('over-run flags red when > 25% and above minimum', () => {
    const r = ev({ actProdHours: 14 }); // 15 vs 10 hrs = +50%, +5 hrs, $300
    assert.equal(r.tier, 'red');
    assert.equal(r.flag, 'red');
    assert.equal(r.flagged, true);
    assert.equal(r.direction, 'over');
    assert.equal(r.varDollars, 300);
  });

  test('under-run is flagged too, direction under', () => {
    const r = ev({ actProdHours: 4 }); // 5 vs 10 = -50%
    assert.equal(r.flag, 'red');
    assert.equal(r.direction, 'under');
    assert.equal(r.varDollars, -300);
  });

  test('big % but tiny hours and dollars is NOT flagged (belowMinimum)', () => {
    const r = ev({ estSetHours: 0, estProdHours: 1, actSetupHours: 0, actProdHours: 1.5, setLabRate: 20, prodLabRate: 20, setBurRate: 10, prodBurRate: 10 });
    assert.equal(r.tier, 'red', 'raw tier is red (+50%)');
    assert.equal(r.belowMinimum, true);
    assert.equal(r.flag, 'green');
    assert.equal(r.flagged, false);
  });

  test('small % but big dollars passes the gate on dollars but is still green by tier', () => {
    const r = ev({ estProdHours: 100, estSetHours: 0, actProdHours: 105, actSetupHours: 0, runQty: 10, qtyCompleted: 10 });
    assert.equal(r.tier, 'green');
    assert.equal(r.flag, 'green');
  });

  test('per-op threshold override changes the tier', () => {
    const c = { ...cfg, opCodeOverrides: { WELD: { greenMax: 0.05, yellowMax: 0.12 } } };
    const r = evaluateOperation(op({ actProdHours: 11 }), { cfg: c, jobClosed: true }); // +20%
    assert.equal(r.tier, 'red');
    assert.equal(r.limits.source, 'op_code');
  });
});

describe('divide by zero and unplanned work', () => {
  test('estimate 0 and actual > 0 is Unplanned (no division by zero)', () => {
    const r = ev({ estSetHours: 0, estProdHours: 0, actSetupHours: 0, actProdHours: 5, runQty: 0, qtyCompleted: 5 });
    assert.equal(r.unplanned, true);
    assert.equal(r.varPct, null);
    assert.equal(r.flag, 'red');
    assert.equal(r.direction, 'over');
    assert.ok(Number.isFinite(r.varDollars));
  });
  test('unplanned but tiny is gated out', () => {
    const r = ev({ estSetHours: 0, estProdHours: 0, actProdHours: 0.1, actSetupHours: 0, setLabRate: 10, prodLabRate: 10, setBurRate: 5, prodBurRate: 5 });
    assert.equal(r.unplanned, true);
    assert.equal(r.flag, 'green');
    assert.equal(r.belowMinimum, true);
  });
  test('estimate 0 and actual 0 is fine, no NaN anywhere', () => {
    const r = ev({ estSetHours: 0, estProdHours: 0, actSetupHours: 0, actProdHours: 0 });
    assert.equal(r.unplanned, false);
    assert.equal(r.varPct, 0);
    assert.equal(r.flag, 'green');
    const numbers = [r.varHours, r.varDollars, r.estDollars, r.actDollars, r.expectedDollars, r.expectedHours];
    assert.ok(numbers.every(Number.isFinite), 'no NaN or Infinity');
  });
  test('null/undefined hours are treated as 0', () => {
    const r = ev({ estSetHours: null, estProdHours: undefined, actSetupHours: null, actProdHours: null });
    assert.equal(r.est.total, 0);
    assert.equal(r.flag, 'green');
  });
  test('zero setup estimate gives null setup % (not Infinity)', () => {
    const r = ev({ estSetHours: 0, actSetupHours: 2 });
    assert.equal(r.var.setupPct, null);
  });
});

describe('quantity normalisation (hours per piece)', () => {
  test('same qty: total hours basis, hrs/pc not used for flagging', () => {
    const r = ev();
    assert.equal(r.basis, 'total');
    assert.equal(r.perPiece.applies, false);
  });

  test('short run: 10 est hrs for 10 pcs, only 5 pcs made using 5 hrs is exactly on estimate', () => {
    const r = ev({ runQty: 10, qtyCompleted: 5, estSetHours: 0, estProdHours: 10, actSetupHours: 0, actProdHours: 5 });
    assert.equal(r.basis, 'hrsPerPc');
    assert.equal(r.perPiece.estHrsPerPc, 1);
    assert.equal(r.perPiece.actHrsPerPc, 1);
    assert.equal(r.varPct, 0);
    assert.equal(r.flag, 'green');
    assert.equal(r.var.totalHrs, -5, 'raw total variance is still shown');
  });

  test('without normalising, the same short run would look like a -50% under-run', () => {
    const r = ev({ runQty: 10, qtyCompleted: 5, estSetHours: 0, estProdHours: 10, actSetupHours: 0, actProdHours: 5 });
    assert.equal(r.var.totalHrs / r.est.total, -0.5);
    assert.equal(r.flag, 'green', 'but the flag uses hrs/pc');
  });

  test('short run that is genuinely slow per piece is flagged over', () => {
    // 5 of 10 pcs, should take 5 hrs, took 10 hrs: +100% per piece
    const r = ev({ runQty: 10, qtyCompleted: 5, estSetHours: 0, estProdHours: 10, actSetupHours: 0, actProdHours: 10 });
    assert.equal(r.perPiece.actHrsPerPc, 2);
    assert.equal(r.varPct, 1);
    assert.equal(r.varHours, 5);
    assert.equal(r.varDollars, 300);
    assert.equal(r.flag, 'red');
    assert.equal(r.direction, 'over');
  });

  test('over-run quantity is normalised too', () => {
    // est 10 hrs for 10 pcs, made 12 pcs in 12 hrs: on estimate per piece
    const r = ev({ runQty: 10, qtyCompleted: 12, estSetHours: 0, estProdHours: 10, actSetupHours: 0, actProdHours: 12 });
    assert.equal(r.basis, 'hrsPerPc');
    assert.equal(r.varPct, 0);
    assert.equal(r.flag, 'green');
  });

  test('qty completed 0 cannot normalise: falls back to total and raises a data quality hint', () => {
    const r = ev({ runQty: 10, qtyCompleted: 0, actProdHours: 12 });
    assert.equal(r.basis, 'total');
    assert.equal(r.perPiece.actHrsPerPc, null);
    assert.ok(r.dq.includes('hours-zero-qty'));
  });

  test('run qty 0 cannot normalise either', () => {
    const r = ev({ runQty: 0, qtyCompleted: 5 });
    assert.equal(r.basis, 'total');
    assert.equal(r.perPiece.estHrsPerPc, null);
  });
});

describe('which operations count', () => {
  test('complete ops count, open ops do not (in-progress job)', () => {
    assert.equal(countsTowardVariance(op({ opComplete: true }), false).counts, true);
    const open = countsTowardVariance(op({ opComplete: false }), false);
    assert.equal(open.counts, false);
    assert.equal(open.reason, 'open');
  });
  test('open op on an in-progress job gets no flag at all', () => {
    const r = evaluateOperation(op({ opComplete: false, actProdHours: 50 }), { cfg, jobClosed: false });
    assert.equal(r.counts, false);
    assert.equal(r.flag, null);
    assert.equal(r.flagged, false);
  });
  test('closed job: op with hours counts even if not ticked complete', () => {
    const r = countsTowardVariance(op({ opComplete: false, actProdHours: 3 }), true);
    assert.deepEqual(r, { counts: true, reason: 'closed-job' });
  });
  test('closed job: never-run op is skipped, not a -100% under-run', () => {
    const r = countsTowardVariance(op({ opComplete: false, actSetupHours: 0, actProdHours: 0 }), true);
    assert.deepEqual(r, { counts: false, reason: 'skipped' });
  });
  test('subcontract ops are excluded from labour variance', () => {
    const r = ev({ subcontract: true, opComplete: true, actProdHours: 0 });
    assert.equal(r.counts, false);
    assert.equal(r.flag, null);
    assert.equal(r.dq.length, 0, 'no zero-hour warning for subcontract');
  });
});

describe('data quality hints on operations', () => {
  test('complete op with 0 actual hours', () => {
    assert.ok(ev({ opComplete: true, actSetupHours: 0, actProdHours: 0 }).dq.includes('complete-zero-hours'));
  });
  test('LaborDtl total differing from JobOper actual hours is flagged', () => {
    assert.ok(ev({}, { laborHours: 12 }).dq.includes('labor-mismatch'));
    assert.ok(!ev({}, { laborHours: 10.02 }).dq.includes('labor-mismatch'), 'within tolerance');
    assert.ok(!ev({}, { laborHours: null }).dq.includes('labor-mismatch'), 'no labour data loaded, no claim');
  });
  test('hours with no rate known', () => {
    const r = ev({ setLabRate: 0, prodLabRate: 0, setBurRate: 0, prodBurRate: 0 });
    assert.ok(r.dq.includes('no-rate'));
  });
});

describe('watchlist for open operations', () => {
  const w = (o) => evaluateWatch(op({ opComplete: false, ...o }), { cfg });

  test('90% of hours used with 40% of qty complete is trending over', () => {
    const r = w({ estSetHours: 0, estProdHours: 10, actSetupHours: 0, actProdHours: 9, runQty: 100, qtyCompleted: 40 });
    assert.equal(r.pctHoursUsed, 0.9);
    assert.equal(r.pctQtyComplete, 0.4);
    assert.equal(r.projectedHours, 22.5);
    assert.equal(r.projectedPct, 1.25);
    assert.equal(r.status, 'trending-over');
    assert.equal(r.flag, 'red');
  });
  test('on pace is on-track', () => {
    const r = w({ estSetHours: 0, estProdHours: 10, actProdHours: 5, actSetupHours: 0, runQty: 100, qtyCompleted: 50 });
    assert.equal(r.status, 'on-track');
    assert.equal(r.flag, 'green');
  });
  test('ahead of pace is not flagged (watchlist is about trending OVER)', () => {
    const r = w({ estSetHours: 0, estProdHours: 10, actProdHours: 2, actSetupHours: 0, runQty: 100, qtyCompleted: 50 });
    assert.equal(r.flag, 'green');
  });
  test('no hours yet is not started; no division by zero', () => {
    const r = w({ actSetupHours: 0, actProdHours: 0 });
    assert.equal(r.status, 'not-started');
  });
  test('too little progress to project (setup hours distort early numbers)', () => {
    const r = w({ estSetHours: 1, estProdHours: 9, actSetupHours: 1, actProdHours: 0, runQty: 100, qtyCompleted: 2 });
    assert.equal(r.status, 'too-early');
    assert.equal(r.flag, 'green');
  });
  test('already past the whole estimate with almost nothing done is flagged', () => {
    const r = w({ estSetHours: 0, estProdHours: 10, actProdHours: 14, actSetupHours: 0, runQty: 100, qtyCompleted: 3 });
    assert.equal(r.status, 'over-early');
    assert.equal(r.flag, 'red');
  });
  test('estimate 0 with hours is unplanned; run qty 0 has no target', () => {
    assert.equal(w({ estSetHours: 0, estProdHours: 0, actProdHours: 3, actSetupHours: 0 }).status, 'unplanned');
    assert.equal(w({ runQty: 0, qtyCompleted: 0, actProdHours: 3 }).status, 'no-qty-target');
  });
  test('projection below the minimum hours/$ is not flagged', () => {
    const r = w({ estSetHours: 0, estProdHours: 1, actProdHours: 0.9, actSetupHours: 0, runQty: 100, qtyCompleted: 40, setLabRate: 10, prodLabRate: 10, setBurRate: 5, prodBurRate: 5 });
    assert.equal(r.projectedPct, 1.25);
    assert.equal(r.flag, 'green', 'only +1.25 hrs / $19');
  });
});

describe('rounding', () => {
  test('money rounds to cents', () => {
    assert.equal(r2(1.005), 1.01);
    assert.equal(r2(-1.005), -1.01);
    assert.equal(r2(0.1 + 0.2), 0.3);
  });
});
