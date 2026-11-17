// Target margin by customer tier.
//
// Settings > Thresholds and Rules holds a default target margin and, optionally, one for each tier (A, B, C, D, New).
// A customer's tier comes from the Customer Organization list (customerOrg.js). A job takes the target of its customer's tier;
// a customer with no tier, one that is not on the list, or a tier left empty in Settings gets the default.
// Everything that shows or uses a target margin goes through here, so they always agree.

import { getSettings } from './settings.js';
import { loadCustomerOrg, orgFor } from './customerOrg.js';
import { UserError } from './errors.js';

export const TIER_TARGETS = [
  { tier: 'A', label: 'Tier A' },
  { tier: 'B', label: 'Tier B' },
  { tier: 'C', label: 'Tier C' },
  { tier: 'D', label: 'Tier D' },
  { tier: 'NEW', label: 'New' },
];

const hasValue = (v) => v !== null && v !== undefined && String(v).trim() !== '' && Number.isFinite(Number(v));

/** What the target lookups need, loaded once (the customer list is read once, not once per job). */
export function targetContext(db, settings = getSettings(db)) {
  return { settings, org: loadCustomerOrg(db) };
}

/**
 * The target margin for a customer.
 * @returns {{tier: string, pct: number, target: number, fromTier: boolean}} pct is a percentage (30), target a fraction (0.3).
 *          fromTier: false = the default target was used.
 */
export function targetFor(ctx, { name, id } = {}) {
  const tier = orgFor(ctx.org, { label: name, key: id }).tier || '';
  const own = tier ? ctx.settings.targetMarginByTier?.[tier] : undefined;
  const fromTier = hasValue(own);
  const pct = fromTier ? Number(own) : Number(ctx.settings.targetMarginPct) || 0;
  return { tier, pct, target: pct / 100, fromTier };
}

/** The same, for a job in the database. */
export function targetForJob(db, jobNum, ctx = targetContext(db)) {
  const j = db.prepare('SELECT cust_name, cust_id FROM jobs WHERE job_num = ?').get(jobNum);
  return targetFor(ctx, { name: j?.cust_name, id: j?.cust_id });
}

/** Clean up the per-tier targets from the Settings form: only known tiers, 0 to 99, empty = use the default. */
export function parseTierTargets(body) {
  const out = {};
  for (const { tier, label } of TIER_TARGETS) {
    const raw = body?.[`targetMargin_${tier}`];
    if (raw === undefined || String(raw).trim() === '') continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n >= 100) throw new UserError(`The ${label} target margin must be a percentage from 0 to 99, or empty to use the default.`);
    out[tier] = n;
  }
  return out;
}
