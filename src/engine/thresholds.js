// Flag tiers and the "minimum to flag" gate.
//
// Tier rules (variance can be over OR under, so we use the absolute value):
//   |pct| <  greenMax            -> green
//   greenMax <= |pct| <= yellowMax -> yellow
//   |pct| >  yellowMax           -> red
// With the defaults (10% / 25%): exactly 10% is yellow, exactly 25% is still yellow.

import { r6, num } from './num.js';

export const DEFAULT_CONFIG = Object.freeze({
  greenMax: 0.1,
  yellowMax: 0.25,
  minHours: 2,
  minDollars: 250,
  // per op code / resource group overrides: { WELD: { greenMax: 0.1, yellowMax: 0.2 } }
  opCodeOverrides: {},
  resourceGroupOverrides: {},
  // manual labour/burden rate overrides per resource group (null/undefined = use Epicor):
  // { WELD1: { setLab: 40, prodLab: 40, setBur: 25, prodBur: 25 } }
  rateOverrides: {},
  normalizeMaterialByQty: true,
  // PartTran types: issues add to actuals, returns reduce them. Verify in your system (BAQ guide 7.3).
  issueTranTypes: ['STK-MTL', 'PUR-MTL'],
  returnTranTypes: ['MTL-STK'],
  qtyTolerance: 0.0001,
  // watchlist: don't project a finish until this much of the qty is done (setup hours distort early numbers)
  watchMinProgress: 0.1,
  laborMismatchHours: 0.05,
});

export const TIER_RANK = { green: 0, yellow: 1, red: 2 };

export function worstTier(a, b) {
  return TIER_RANK[b] > TIER_RANK[a] ? b : a;
}

/** Percent limits that apply to an operation. Op-code override wins over resource group, which wins over global. */
export function limitsFor(cfg, { opCode, resourceGrpId } = {}) {
  const byOp = opCode ? cfg.opCodeOverrides?.[opCode] : undefined;
  const byRg = resourceGrpId ? cfg.resourceGroupOverrides?.[resourceGrpId] : undefined;
  const pick = byOp ?? byRg;
  return {
    greenMax: num(pick?.greenMax ?? cfg.greenMax),
    yellowMax: num(pick?.yellowMax ?? cfg.yellowMax),
    source: byOp ? 'op_code' : byRg ? 'resource_group' : 'global',
  };
}

/** Tier from a variance fraction (0.12 = 12%). null pct (no estimate) is handled by callers. */
export function tierFor(pct, limits) {
  const a = Math.abs(r6(pct));
  if (a < r6(limits.greenMax)) return 'green';
  if (a <= r6(limits.yellowMax)) return 'yellow';
  return 'red';
}

/**
 * The "minimum to flag" gate. A variance is only flagged when it is big enough in
 * hours OR in dollars (pass hours = null for lines that have no hours, e.g. material).
 */
export function passesMinimum({ hours = null, dollars = 0 }, cfg) {
  const d = Math.abs(r6(dollars)) >= r6(cfg.minDollars);
  const h = hours === null ? false : Math.abs(r6(hours)) >= r6(cfg.minHours);
  return h || d;
}

export function directionOf(value) {
  const v = r6(value);
  if (v > 0) return 'over';
  if (v < 0) return 'under';
  return 'even';
}
