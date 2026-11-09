// Labour variance per operation, plus the watchlist projection for open operations.

import { num, r2, r4, r6, ratio } from './num.js';
import { limitsFor, tierFor, passesMinimum, directionOf } from './thresholds.js';

/** Setup and production rates (labour + burden), manual override first, then Epicor's. */
export function opRates(op, cfg) {
  const ov = cfg.rateOverrides?.[op.resourceGrpId] ?? {};
  const pick = (o, e) => (o !== null && o !== undefined && o !== '' ? num(o) : num(e));
  const setLab = pick(ov.setLab, op.setLabRate);
  const setBur = pick(ov.setBur, op.setBurRate);
  const prodLab = pick(ov.prodLab, op.prodLabRate);
  const prodBur = pick(ov.prodBur, op.prodBurRate);
  return { setup: setLab + setBur, prod: prodLab + prodBur, setLab, setBur, prodLab, prodBur };
}

/**
 * Which operations count toward a post-mortem?
 *  - subcontract ops never count (no clock-ins; costed from the PO in phase 2)
 *  - ops marked complete count
 *  - on a CLOSED job, an op that has actual hours counts even if nobody ticked "complete"
 *  - everything else (open operations on in-progress jobs) goes to the watchlist instead
 */
export function countsTowardVariance(op, jobClosed) {
  const actTotal = num(op.actSetupHours) + num(op.actProdHours);
  if (op.subcontract) return { counts: false, reason: 'subcontract' };
  if (op.opComplete) return { counts: true, reason: 'complete' };
  if (jobClosed && actTotal > 0) return { counts: true, reason: 'closed-job' };
  return { counts: false, reason: jobClosed ? 'skipped' : 'open' };
}

export function evaluateOperation(op, ctx) {
  const { cfg, jobClosed = false, laborHours = null } = ctx;
  const estSet = num(op.estSetHours);
  const estRun = num(op.estProdHours);
  const actSet = num(op.actSetupHours);
  const actRun = num(op.actProdHours);
  const estTotal = estSet + estRun;
  const actTotal = actSet + actRun;
  const runQty = num(op.runQty);
  const qtyCompleted = num(op.qtyCompleted);
  const rates = opRates(op, cfg);
  const { counts, reason } = countsTowardVariance(op, jobClosed);
  const limits = limitsFor(cfg, { opCode: op.opCode, resourceGrpId: op.resourceGrpId });

  // ---- quantity normalisation (hours per piece) ----------------------------
  const qtyDiffers = runQty > 0 && Math.abs(qtyCompleted - runQty) > cfg.qtyTolerance;
  const perPieceApplies = qtyDiffers && qtyCompleted > 0;
  const qtyRatio = perPieceApplies ? qtyCompleted / runQty : 1;
  const basis = perPieceApplies ? 'hrsPerPc' : 'total';
  const estHrsPerPc = runQty > 0 ? estTotal / runQty : null;
  const actHrsPerPc = qtyCompleted > 0 ? actTotal / qtyCompleted : null;

  // ---- dollars -------------------------------------------------------------
  const estDollars = r2(estSet * rates.setup + estRun * rates.prod);
  const actDollars = r2(actSet * rates.setup + actRun * rates.prod);
  // what the hours SHOULD have been for the quantity actually produced
  const expectedHours = estTotal * qtyRatio;
  const expectedDollars = r2(estDollars * qtyRatio);

  const varHours = actTotal - expectedHours;
  const varDollars = r2(actDollars - expectedDollars);
  const rawVarHours = actTotal - estTotal;

  // ---- percentages (never divide by zero) -----------------------------------
  const unplanned = estTotal === 0 && actTotal > 0;
  const varPct = unplanned ? null : ratio(varHours, expectedHours) ?? 0;
  const setupPct = estSet > 0 ? (actSet - estSet) / estSet : null;
  const runPct = estRun > 0 ? (actRun - estRun) / estRun : null;
  const driver =
    r6(actSet - estSet) === 0 && r6(actRun - estRun) === 0
      ? null
      : Math.abs(actSet - estSet) >= Math.abs(actRun - estRun)
        ? 'setup'
        : 'run';

  // ---- flag ------------------------------------------------------------------
  let tier = null;
  let flag = null;
  let belowMinimum = false;
  if (counts) {
    const gate = passesMinimum({ hours: varHours, dollars: varDollars }, cfg);
    if (unplanned) {
      tier = 'red';
      belowMinimum = !gate;
      flag = gate ? 'red' : 'green';
    } else {
      tier = tierFor(varPct, limits);
      belowMinimum = tier !== 'green' && !gate;
      flag = gate ? tier : 'green';
    }
  }

  // ---- data quality hints for this op ----------------------------------------
  const dq = [];
  if (!op.subcontract) {
    if (op.opComplete && actTotal === 0) dq.push('complete-zero-hours');
    if (actTotal > 0 && qtyCompleted === 0) dq.push('hours-zero-qty');
    if (laborHours !== null && Math.abs(num(laborHours) - actTotal) > cfg.laborMismatchHours) dq.push('labor-mismatch');
    if (actTotal > 0 && rates.setup === 0 && rates.prod === 0) dq.push('no-rate');
  }

  return {
    assemblySeq: num(op.assemblySeq),
    oprSeq: num(op.oprSeq),
    opCode: op.opCode ?? '',
    opDesc: op.opDesc ?? '',
    resourceGrpId: op.resourceGrpId ?? '',
    subcontract: !!op.subcontract,
    opComplete: !!op.opComplete,
    counts,
    countReason: reason,
    est: { setup: r4(estSet), run: r4(estRun), total: r4(estTotal) },
    act: { setup: r4(actSet), run: r4(actRun), total: r4(actTotal) },
    var: {
      setupHrs: r4(actSet - estSet),
      runHrs: r4(actRun - estRun),
      totalHrs: r4(rawVarHours),
      setupPct: setupPct === null ? null : r4(setupPct),
      runPct: runPct === null ? null : r4(runPct),
    },
    qty: { run: runQty, completed: qtyCompleted, differs: qtyDiffers },
    perPiece: {
      applies: perPieceApplies,
      estHrsPerPc: estHrsPerPc === null ? null : r4(estHrsPerPc),
      actHrsPerPc: actHrsPerPc === null ? null : r4(actHrsPerPc),
    },
    basis,
    expectedHours: r4(expectedHours),
    varHours: r4(varHours),
    varPct: varPct === null ? null : r4(varPct),
    rates: { setup: r2(rates.setup), prod: r2(rates.prod) },
    estDollars,
    actDollars,
    expectedDollars,
    varDollars,
    unplanned,
    direction: directionOf(unplanned ? 1 : varHours),
    driver,
    limits,
    tier,
    flag,
    belowMinimum,
    flagged: flag === 'yellow' || flag === 'red',
    dq,
  };
}

/**
 * Watchlist: open operations on in-progress jobs. Compares "% of estimated hours used"
 * to "% of quantity complete" and projects the finish.
 * Example: 90% of hours used with 40% of qty done projects to 2.25x the estimate (+125%).
 */
export function evaluateWatch(op, ctx) {
  const { cfg } = ctx;
  const estTotal = num(op.estSetHours) + num(op.estProdHours);
  const actTotal = num(op.actSetupHours) + num(op.actProdHours);
  const runQty = num(op.runQty);
  const qtyCompleted = num(op.qtyCompleted);
  const rates = opRates(op, cfg);
  const blended = estTotal > 0 ? (num(op.estSetHours) * rates.setup + num(op.estProdHours) * rates.prod) / estTotal : rates.prod;
  const limits = limitsFor(cfg, { opCode: op.opCode, resourceGrpId: op.resourceGrpId });

  const pctHoursUsed = estTotal > 0 ? actTotal / estTotal : null;
  const pctQtyComplete = runQty > 0 ? Math.min(qtyCompleted / runQty, 10) : null;

  const base = {
    assemblySeq: num(op.assemblySeq),
    oprSeq: num(op.oprSeq),
    opCode: op.opCode ?? '',
    estHours: r4(estTotal),
    actHours: r4(actTotal),
    pctHoursUsed: pctHoursUsed === null ? null : r4(pctHoursUsed),
    pctQtyComplete: pctQtyComplete === null ? null : r4(pctQtyComplete),
    projectedHours: null,
    projectedPct: null,
    projectedDollars: null,
    flag: 'green',
  };

  if (estTotal === 0) {
    const unplanned = actTotal > 0;
    return { ...base, status: unplanned ? 'unplanned' : 'no-estimate', flag: unplanned ? 'red' : 'green' };
  }
  if (actTotal === 0) return { ...base, status: 'not-started' };
  if (pctQtyComplete === null) return { ...base, status: 'no-qty-target' };

  const overHours = actTotal - estTotal;
  const decide = (projectedHours, status) => {
    const projectedPct = (projectedHours - estTotal) / estTotal;
    const projectedDollars = r2((projectedHours - estTotal) * blended);
    const tier = tierFor(projectedPct, limits);
    const gate = passesMinimum({ hours: projectedHours - estTotal, dollars: projectedDollars }, cfg);
    const over = projectedHours > estTotal;
    const flag = over && gate ? tier : 'green';
    return {
      ...base,
      status: over && flag !== 'green' ? 'trending-over' : status,
      projectedHours: r4(projectedHours),
      projectedPct: r4(projectedPct),
      projectedDollars,
      flag,
    };
  };

  // already used more hours than the whole estimate
  if (pctQtyComplete < cfg.watchMinProgress) {
    if (actTotal > estTotal) {
      const gate = passesMinimum({ hours: overHours, dollars: overHours * blended }, cfg);
      return { ...base, status: 'over-early', flag: gate ? 'red' : 'green', projectedHours: r4(actTotal) };
    }
    return { ...base, status: 'too-early' };
  }
  return decide(actTotal / pctQtyComplete, 'on-track');
}
