// Price, cost and margin for one job: was the problem the price, the plan, or the shop floor?
//
//   price          what the customer is paying (sales order lines this job is made for), CAD
//   planned cost   what the job said it would cost when it was set up: estimated hours x resource-group
//                  rates (+ burden) plus required material x estimated unit cost
//   actual cost    what it has really cost (final if the job is closed, "so far" if it is still open):
//                  actual hours x the same rates, plus material issued net of returns
//
// Planned margin = price - planned cost.  Actual margin = price - actual cost.
//   Planned margin already below target -> the price did not cover the job's own plan: a quoting / set-up problem.
//   Planned margin fine, actual margin low -> the plan looked healthy but the job took more than it said.
//
// Cost here is labour (with burden) and material, plus the three things the variance engine does not see (see extraCosts.js):
// the cost of sub-assembly jobs a job consumes, purchased material received through inspection, and subcontract.
// Freight and overhead are not in the app's data.

import { getSettings } from './settings.js';
import { camelRow } from './staging.js';
import { costBasis } from './costBasis.js';
import { loadExtraCosts, NO_EXTRA } from './extraCosts.js';
import { targetContext, targetForJob } from './targets.js';

/** Short labels for the verdict codes, for the grid, the filter and the Excel export. */
export const CAUSE_LABELS = {
  'price-vs-plan': 'Price / Set-Up',
  overrun: 'Overrun',
  ok: 'On Target',
  'no-price': 'No Price',
  'no-plan': 'No Plan',
};

/** Economics for a job straight from the database (used when a post-mortem snapshot is taken). */
export function loadEconomics(db, jobNum, result, ctx = targetContext(db)) {
  const revenue = db.prepare('SELECT * FROM job_revenue WHERE job_num = ? ORDER BY order_num, order_line, order_rel_num').all(jobNum).map(camelRow);
  const t = targetForJob(db, jobNum, ctx); // the target of this customer's tier
  return computeEconomics(result, revenue, { targetMarginPct: t.pct, tier: t.tier, baseCurrency: ctx.settings.baseCurrency, extra: loadExtraCosts(db, jobNum) });
}

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const pctOf = (part, whole) => (whole > 0 ? part / whole : null);

/** Price from the sales order lines. Each line counts for the share of it that this job makes. */
export function priceFromLines(lines = []) {
  const used = lines.map((l) => {
    const orderQty = num(l.orderQty);
    const alloc = num(l.allocQty);
    // alloc unknown (0) or no line quantity: assume this job makes the whole line, and say so
    const known = alloc > 0 && orderQty > 0;
    const share = known ? alloc / orderQty : 1;
    return {
      orderNum: l.orderNum,
      orderLine: l.orderLine,
      allocQty: alloc,
      orderQty,
      linePrice: r2(num(l.extPrice)),
      share: Math.round(share * 10000) / 10000,
      amount: r2(num(l.extPrice) * share),
      shareKnown: known,
    };
  });
  const total = r2(used.reduce((t, l) => t + l.amount, 0));
  return { lines: used, total: used.length ? total : null, anyAssumed: used.some((l) => !l.shareKnown) };
}

/**
 * @param {object} result       evaluateJob() output (ops and materials with estimates and actuals)
 * @param {object[]} revenue    rows of job_revenue (camelCase)
 * @param {{targetMarginPct?: number, baseCurrency?: string, extra?: object}} opts  extra: the result of loadExtraCosts()
 */
export function computeEconomics(result, revenue = [], { targetMarginPct = 20, tier = '', baseCurrency = 'CAD', extra = NO_EXTRA } = {}) {
  const closed = result.jobState === 'closed';
  const target = num(targetMarginPct) / 100;

  const b = costBasis(result);
  const plannedLabour = b.plannedLabour;
  const actualLabour = b.actualLabour;
  const plannedMaterial = b.plannedMaterial;
  // Purchased material that came in through inspection (INS-MTL). A line with no issue transactions is already counted at issued
  // qty x estimated cost, so the real cost replaces that; a line that also has issue transactions gets the real cost added.
  // Its planned cost is already in plannedMaterial.
  let inspection = 0;
  if (extra.inspection?.lines) {
    for (const l of extra.inspection.lines) {
      const m = result.materials.find((x) => x.assemblySeq === l.assemblySeq && x.mtlSeq === l.mtlSeq);
      inspection += m && m.qtySource === 'jobmtl' ? num(l.cost) - num(m.actDollars) : num(l.cost);
    }
  } else inspection = num(extra.inspection?.actual);
  inspection = r2(inspection);
  const actualMaterial = r2(b.actualMaterial + inspection);
  const sub = extra.subAssembly ?? NO_EXTRA.subAssembly;
  const subcontract = r2(num(extra.subcontract?.actual)); // no estimate exists for it: planned = actual, so it is never an overrun
  const plannedCost = r2(plannedLabour + plannedMaterial + num(sub.planned) + subcontract);
  const actualCost = r2(actualLabour + actualMaterial + num(sub.actual) + subcontract);

  const p = priceFromLines(revenue);
  const price = p.total;
  const hasPrice = price !== null && price > 0;

  const plannedMargin = hasPrice ? r2(price - plannedCost) : null;
  const actualMargin = hasPrice ? r2(price - actualCost) : null;
  const plannedMarginPct = hasPrice ? pctOf(plannedMargin, price) : null;
  const actualMarginPct = hasPrice ? pctOf(actualMargin, price) : null;
  const overrun = r2(actualCost - plannedCost);

  return {
    currency: baseCurrency,
    closed,
    price: hasPrice ? price : null,
    priceLines: p.lines,
    priceAssumed: p.anyAssumed,
    target,
    targetTier: tier, // the customer tier whose target this is ('' = the default target)
    labour: { planned: plannedLabour, actual: actualLabour, diff: r2(actualLabour - plannedLabour) },
    material: { planned: plannedMaterial, actual: actualMaterial, diff: r2(actualMaterial - plannedMaterial), inspection },
    subAssembly: { planned: r2(num(sub.planned)), actual: r2(num(sub.actual)), diff: r2(num(sub.actual) - num(sub.planned)), items: sub.items ?? [] },
    subcontract: { planned: subcontract, actual: subcontract, diff: 0 },
    cost: { planned: plannedCost, actual: actualCost, diff: overrun, diffPct: plannedCost > 0 ? overrun / plannedCost : null },
    margin: { planned: plannedMargin, actual: actualMargin, plannedPct: plannedMarginPct, actualPct: actualMarginPct, lost: hasPrice ? r2(plannedMargin - actualMargin) : null },
    verdict: verdict({ hasPrice, closed, plannedCost, plannedMarginPct, actualMarginPct, target, overrun }),
  };
}

const pc = (v) => `${(v * 100).toFixed(1)}%`;
const usd = (v) => `$${Math.abs(Math.round(v)).toLocaleString('en-CA')}`;

export function verdict({ hasPrice, closed, plannedCost, plannedMarginPct, actualMarginPct, target, overrun }) {
  if (!hasPrice) {
    return { code: 'no-price', tone: 'info', text: 'No sale price is available for this job (it is not linked to a priced sales order line, or price data has not been synced yet), so margins cannot be shown.' };
  }
  const now = closed ? '' : 'At the cost booked so far, ';
  if (plannedCost <= 0) {
    return { code: 'no-plan', tone: 'warn', text: 'The job has no planned cost (no estimated hours or material), so there is nothing to compare the price with. Check how the job was set up.' };
  }
  if (plannedMarginPct < target) {
    const worse = actualMarginPct < plannedMarginPct;
    return {
      code: 'price-vs-plan',
      tone: 'bad',
      text: `The price did not cover the job's own plan: planned margin was ${pc(plannedMarginPct)} against a ${pc(target)} target, before the shop booked a single hour. ${worse ? `${now}${closed ? 'Actual' : 'actual'} cost then took it to ${pc(actualMarginPct)}. ` : ''}The first place to look is the quote price against the job set-up (sales and estimating).`,
    };
  }
  if (actualMarginPct < target) {
    return {
      code: 'overrun',
      tone: 'bad',
      text: `The plan was healthy (${pc(plannedMarginPct)} planned margin), but ${closed ? 'actual cost came in' : 'cost so far is'} ${usd(overrun)} ${overrun >= 0 ? 'over' : 'under'} the plan, leaving ${pc(actualMarginPct)} against a ${pc(target)} target. The price covered what the job said it needed, so the gap is hours or material beyond the plan: compare the planned hours with what the shop needed, operation by operation, below.`,
    };
  }
  return { code: 'ok', tone: 'good', text: `${closed ? 'Margin' : 'Margin so far'} of ${pc(actualMarginPct)} meets the ${pc(target)} target (planned ${pc(plannedMarginPct)}).` };
}
