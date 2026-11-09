// Material variance per job material line.
//
//   usage variance $ = (actual qty - expected qty) x est unit cost      (shop used more/less)
//   price variance $ = actual cost - actual qty x est unit cost         (cost per unit differed)
//   total variance $ = usage + price = actual cost - expected qty x est unit cost
//
// With AVERAGE costing the "price" part is really a cost-basis variance (the running
// average at the time of issue vs the estimate), so the UI labels it that way.

import { num, r2, r4, r6, ratio } from './num.js';
import { tierFor, worstTier, passesMinimum, directionOf, limitsFor } from './thresholds.js';

function unitCostSum(t) {
  return num(t.mtlUnitCost) + num(t.lbrUnitCost) + num(t.burUnitCost) + num(t.subUnitCost) + num(t.mtlBurUnitCost);
}

/**
 * Net the PartTran rows for one material line.
 * - issue types add to actuals (signed as stored, so a reversal posted as a negative issue still nets out)
 * - return types always REDUCE actuals, whether the system stores them as + or - numbers
 * - any other type is ignored and counted in `ignored`
 */
export function netTransactions(trans, cfg) {
  const issueTypes = new Set(cfg.issueTranTypes);
  const returnTypes = new Set(cfg.returnTranTypes);
  let issuedQty = 0;
  let returnedQty = 0;
  let issuedCost = 0;
  let returnedCost = 0;
  let used = 0;
  let ignored = 0;
  for (const t of trans) {
    const qty = num(t.tranQty);
    const cost = t.extCost === null || t.extCost === undefined ? qty * unitCostSum(t) : num(t.extCost);
    if (issueTypes.has(t.tranType)) {
      issuedQty += qty;
      issuedCost += cost;
      used++;
    } else if (returnTypes.has(t.tranType)) {
      returnedQty += Math.abs(qty);
      returnedCost += Math.abs(cost);
      used++;
    } else {
      ignored++;
    }
  }
  return {
    issuedQty,
    returnedQty,
    netQty: issuedQty - returnedQty,
    issuedCost: r2(issuedCost),
    returnedCost: r2(returnedCost),
    netCost: r2(issuedCost - returnedCost),
    used,
    ignored,
  };
}

export function evaluateMaterial(mtl, ctx) {
  const { cfg, job, trans = [] } = ctx;
  const jobClosed = !!job.closed;
  const requiredQty = num(mtl.requiredQty);
  const estUnit = num(mtl.estUnitCost ?? mtl.unitCost);
  const limits = limitsFor(cfg, {});

  // ---- expected quantity (optionally scaled to what was actually produced) ---
  const prodQty = num(job.prodQty);
  const jobQtyDone = num(job.qtyCompleted);
  const normalized =
    cfg.normalizeMaterialByQty &&
    jobClosed &&
    prodQty > 0 &&
    jobQtyDone > 0 &&
    Math.abs(jobQtyDone - prodQty) > cfg.qtyTolerance;
  const expectedQty = normalized ? requiredQty * (jobQtyDone / prodQty) : requiredQty;
  const estDollars = r2(expectedQty * estUnit);

  // ---- actuals: PartTran net of returns; fall back to JobMtl.IssuedQty -------
  const net = netTransactions(trans, cfg);
  const haveTrans = net.used > 0;
  const actualQty = haveTrans ? net.netQty : num(mtl.issuedQty);
  const actDollars = haveTrans ? net.netCost : r2(actualQty * estUnit);

  const qtyVar = actualQty - expectedQty;
  const dollarVar = r2(actDollars - estDollars);
  const usageVar = r2((actualQty - expectedQty) * estUnit);
  const priceVar = r2(actDollars - actualQty * estUnit);
  const actualUnitCost = actualQty !== 0 ? actDollars / actualQty : null;

  const unplanned = expectedQty === 0 && actualQty > 0;
  const qtyPct = unplanned ? null : ratio(qtyVar, expectedQty) ?? 0;
  const dollarPct = estDollars === 0 ? null : dollarVar / estDollars;

  // Material is often issued up front: an in-progress job that is NOT yet fully issued
  // is expected to be short, so under-issue is "pending", not a miss.
  const pending = !jobClosed && !mtl.issuedComplete && r6(qtyVar) < 0;

  // ---- flag: whichever of qty / dollars trips, gated by the minimum $ -------
  let tier = 'green';
  const qtyTier = qtyPct === null ? (unplanned ? 'red' : 'green') : tierFor(qtyPct, limits);
  const dollarTier = dollarPct === null ? (dollarVar !== 0 && actDollars > 0 && estDollars === 0 ? 'red' : 'green') : tierFor(dollarPct, limits);
  tier = worstTier(qtyTier, dollarTier);
  const gate = passesMinimum({ hours: null, dollars: dollarVar }, cfg);
  const flag = pending || !gate ? 'green' : tier;
  const belowMinimum = !pending && tier !== 'green' && !gate;
  const tripped = qtyTier === 'green' && dollarTier === 'green' ? null : qtyTier !== 'green' && dollarTier !== 'green' ? 'both' : qtyTier !== 'green' ? 'qty' : 'dollars';

  // ---- data quality hints ------------------------------------------------------
  const dq = [];
  if (requiredQty > 0 && !estUnit) dq.push('no-est-cost');
  if (!haveTrans && num(mtl.issuedQty) > 0) dq.push('no-transactions');
  if (haveTrans && Math.abs(net.netQty - num(mtl.issuedQty)) > Math.max(0.01, Math.abs(num(mtl.issuedQty)) * 0.001)) dq.push('qty-mismatch');
  if (net.ignored > 0) dq.push('unknown-tran-type');
  if (haveTrans && net.netQty < 0) dq.push('negative-net');

  return {
    assemblySeq: num(mtl.assemblySeq),
    mtlSeq: num(mtl.mtlSeq),
    partNum: mtl.partNum ?? '',
    description: mtl.description ?? '',
    ium: mtl.ium ?? '',
    classId: mtl.classId ?? '',
    prodCode: mtl.prodCode ?? '',
    backflush: !!mtl.backflush,
    issuedComplete: !!mtl.issuedComplete,
    requiredQty: r4(requiredQty),
    expectedQty: r4(expectedQty),
    normalized,
    actualQty: r4(actualQty),
    returnedQty: r4(net.returnedQty),
    qtySource: haveTrans ? 'transactions' : 'jobmtl',
    qtyVar: r4(qtyVar),
    qtyPct: qtyPct === null ? null : r4(qtyPct),
    estUnitCost: r4(estUnit),
    actualUnitCost: actualUnitCost === null ? null : r4(actualUnitCost),
    estDollars,
    actDollars,
    dollarVar,
    dollarPct: dollarPct === null ? null : r4(dollarPct),
    usageVar,
    priceVar,
    unplanned,
    pending,
    direction: directionOf(dollarVar !== 0 ? dollarVar : qtyVar),
    limits,
    tier,
    tripped,
    flag,
    belowMinimum,
    flagged: flag === 'yellow' || flag === 'red',
    dq,
  };
}
