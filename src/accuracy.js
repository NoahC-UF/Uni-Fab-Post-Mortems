// Quote Accuracy: roll the job-level results up by operation, material and customer, to see patterns instead of single jobs.
//
// Where the numbers come from
//   Every operation and material line of every job is stored by the same variance engine the rest of the app uses
//   (table line_results, filled whenever jobs are re-checked). Nothing is re-estimated here: the hours "expected"
//   are the hours the job should have taken for the quantity it made, the dollars are hours x (labour + burden rate)
//   for operations and quantity x estimated unit cost for material, and a line is "off" when the engine flagged it
//   (the app's own tiers and minimum hours / dollars, set in Settings). No new thresholds are made up here.
//
// Words used on the pages
//   Over estimate  = actual is MORE than estimated (cost more than planned): variance > 0. This is the Dashboard's "over".
//   Under estimate = actual is LESS than estimated (cost less than planned): variance < 0. This is the Dashboard's "under".
//   (Neither word blames anyone: a job that runs over can be the quote, how the job was released, or the shop floor.)
//   Net variance  = sum of the signed variances. Gross variance = sum of their sizes (so +50% and -50% do not cancel).
//   Variance %    = (actual - estimate) / estimate, taken over the whole group (total variance / total estimate).
//   Attention score = gross $ variance x share of jobs that were off (used for the Needs Attention flag and the drill-down, not shown in the lists).

import { getEngineConfig, getSettings } from './settings.js';
import { loadCustomerOrg, orgFor, customerIdsFor } from './customerOrg.js';
import { targetContext, targetFor } from './targets.js';
import { customerCondition, INTERNAL_CUSTOMER } from './postmortems.js';
import { tierFor, limitsFor, passesMinimum } from './engine/thresholds.js';

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const validDate = (s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const r4 = (n) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;

export const TOP_N = 10;
export const TOP_CHOICES = [10, 25, 50, 100]; // how many customers each customer list shows (the Show filter on the Customers page)
export const TOP_CUSTOMERS = 25; // the default
export const OUTLIER_PCT = 3; // a single line more than +/-300% off is dropped when "exclude outliers" is on
export const REPEAT_JOBS = 3; // the same group off on this many jobs for the same part = a part to fix
export const REPEAT_JOBS_CUSTOMER = 2; // "off on several jobs" for one customer's repeat parts
export const INTERNAL_KEY = '_internal';
export const INTERNAL_LABEL = 'Internal / Stock';

export const BASES = [
  { id: 'dollars', label: '$' },
  { id: 'hours', label: 'Hours' },
  { id: 'pct', label: '%' },
];
export const LIST_VIEWS = [
  { id: 'over', label: 'Jobs Over Estimates' },
  { id: 'under', label: 'Jobs Under Estimates' },
  { id: 'h', label: 'Both - Horizontal Window' },
  { id: 'v', label: 'Both - Vertical Window' },
];
export const SORTS = [
  { id: 'netvar', label: 'Net Var $' }, // net dollars variance, whatever the Variance Basis (the default for operations and materials)
  { id: 'attention', label: 'Needs Attention' },
  { id: 'impact', label: 'Impact (Chosen Basis)' },
  { id: 'frequency', label: '% of Jobs Off' },
  { id: 'avg', label: 'Avg Variance %' },
  { id: 'margin', label: 'Margin $', customers: true }, // margins exist for customers only
  { id: 'marginpct', label: 'Margin %', customers: true },
  { id: 'vstarget', label: 'Margin vs Target $', customers: true }, // dollars above / below the target margin: sort Low to High for the worst first
];
export const ORDERS = [
  { id: 'desc', label: 'High to Low' },
  { id: 'asc', label: 'Low to High' },
];

// ------------------------------------------------------------------------------------ filters

const pick = (v, allowed, dflt) => (allowed.includes(v) ? v : dflt);

/**
 * The Tier filter: one or more tiers (A, B, ...) and/or '_none' (customers not on the list), from tier=A&tier=B or tier=A,B.
 * Returned as one clean comma-separated string ('' = all tiers), so it can sit in a link and in the cache key.
 */
export function parseTierFilter(v) {
  const out = [];
  for (const part of (Array.isArray(v) ? v : [v]).flatMap((x) => (typeof x === 'string' ? x.split(',') : []))) {
    const s = part.trim();
    if (!s) continue;
    const t = s.toLowerCase() === '_none' ? '_none' : s.toUpperCase().slice(0, 12);
    if (!out.includes(t)) out.push(t);
  }
  return out.slice(0, 12).join(',');
}
const flag01 = (v, dflt) => {
  const last = Array.isArray(v) ? v[v.length - 1] : v;
  if (last === undefined) return dflt;
  return ['1', 'true', 'on', 'yes'].includes(String(last).toLowerCase());
};

export const DEFAULT_DAYS = 90; // the pages open on the last 90 days

/**
 * Filters from the query string. The defaults are: the last 90 days, closed jobs only, at least 3 jobs, $ basis.
 * customers: true for the Customers page, which opens sorted by Margin vs Target $, Low to High (the customers furthest below their
 * target first). Everywhere else the lists open on Net Var $, High to Low.
 */
export function parseAccuracyFilters(q = {}, now = new Date(), settings = {}, { customers = false } = {}) {
  const minJobs = Math.round(Number(q.minJobs));
  return {
    from: validDate(q.from) ?? iso(addDays(now, -DEFAULT_DAYS)),
    to: validDate(q.to) ?? iso(now),
    status: pick(q.status, ['closed', 'all'], 'closed'), // 'all' adds in-progress jobs (completed operations and issued material only)
    minJobs: Number.isFinite(minJobs) && minJobs >= 1 && minJobs <= 100 ? minJobs : 3,
    basis: pick(q.basis, BASES.map((b) => b.id), 'dollars'),
    outliers: flag01(q.outliers, false), // true = drop lines more than +/-300% off
    internal: flag01(q.internal, !settings.excludeNonOrderJobs), // include Internal / Stock jobs (no customer): follows the Settings choice until set here
    opBy: pick(q.opBy, ['op', 'rg'], 'op'),
    mtlBy: pick(q.mtlBy, ['part', 'class'], 'part'),
    sort: pick(q.sort, SORTS.map((s) => s.id), customers ? 'vstarget' : 'netvar'),
    order: pick(q.order, ORDERS.map((o) => o.id), customers ? 'asc' : 'desc'), // desc = the biggest / highest first, asc = the smallest / lowest first
    trend: pick(q.trend, ['month', 'quarter'], 'month'),
    lists: pick(q.lists, LIST_VIEWS.map((l) => l.id), 'over'), // which top lists to show: over, under, both side by side (h) or both stacked (v)
    cust: typeof q.cust === 'string' ? q.cust.trim().slice(0, 60) : '', // limit the page to one customer (the customer page's own lists link here)
    tier: parseTierFilter(q.tier), // only customers of these tiers, e.g. 'A,B' ('_none' = not on the list); '' = all
    top: TOP_CHOICES.includes(Math.round(Number(q.top))) ? Math.round(Number(q.top)) : TOP_CUSTOMERS, // how many customers the customer lists show
    mgr: typeof q.mgr === 'string' ? q.mgr.trim().slice(0, 80) : '', // only customers this account manager looks after
  };
}

/** Query string that carries the filters (plus any changes) into a link or an export. */
export function filterLink(f, patch = {}) {
  const v = { ...f, ...patch };
  const p = new URLSearchParams();
  for (const k of ['from', 'to', 'status', 'minJobs', 'basis', 'opBy', 'mtlBy', 'sort', 'order', 'trend', 'lists', 'top']) if (v[k] !== null) p.set(k, String(v[k])); // null = leave it out (a link to a page with its own default)
  p.set('outliers', v.outliers ? '1' : '0');
  p.set('internal', v.internal ? '1' : '0');
  if (v.cust) p.set('cust', v.cust);
  if (v.tier) p.set('tier', v.tier);
  if (v.mgr) p.set('mgr', v.mgr);
  for (const k of ['drill', 'dpart']) if (v[k]) p.set(k, String(v[k]));
  return p.toString();
}

// ------------------------------------------------------------------------------------ loading lines

const cache = new Map(); // small memo of loaded lines, thrown away whenever any job's numbers are recomputed
const CACHE_MAX = 8;

/**
 * Every counted operation / material line in the date range, with its job's part, customer and status.
 *  closed jobs:       closed date in the range
 *  in-progress jobs:  (when asked for) latest activity in the range; only completed operations and issued material are
 *                     in line_results as counted, so a full estimate is never set against partial actuals
 */
export function loadLines(db, f, { cust = f.cust || null } = {}) {
  const stamp = db.prepare('SELECT COUNT(*) AS n, MAX(computed_at) AS t FROM job_metrics').get();
  const orgStamp = db.prepare('SELECT COUNT(*) AS n, MAX(updated_at) AS t FROM customer_org').get();
  const key = JSON.stringify([f.from, f.to, f.status, f.internal, cust, f.tier, f.mgr, stamp.n, stamp.t, orgStamp.n, orgStamp.t]);
  if (cache.has(key)) return cache.get(key);

  const where = ['l.counted = 1'];
  const p = { from: f.from, to: f.to };
  where.push(
    f.status === 'all'
      ? '((j.closed = 1 AND j.closed_date >= @from AND j.closed_date <= @to) OR (j.closed = 0 AND l.activity_date >= @from AND l.activity_date <= @to))'
      : '(j.closed = 1 AND j.closed_date >= @from AND j.closed_date <= @to)',
  );
  if (!f.internal) where.push("j.order_num IS NOT NULL AND COALESCE(j.cust_id, '') <> ''");
  if (cust === INTERNAL_KEY) where.push("(j.order_num IS NULL OR COALESCE(j.cust_id, '') = '')");
  else if (cust) {
    where.push('j.cust_id = @cust');
    p.cust = cust;
  }
  // only the customers of this tier / looked after by this account manager (Internal / Stock jobs have no customer, so they drop out)
  const ids = customerIdsFor(db, { tier: f.tier, mgr: f.mgr });
  if (ids) {
    if (ids.length) where.push(`j.cust_id IN (${ids.map((id, i) => { p[`c${i}`] = id; return `@c${i}`; }).join(',')})`);
    else where.push('1 = 0');
  }
  const rows = db
    .prepare(
      `SELECT l.job_num, l.kind, l.op_code, l.resource_grp_id, l.part_num, l.description, l.class_id, l.unplanned, l.flag, l.activity_date,
              l.exp_hours, l.act_hours, l.exp_setup, l.act_setup, l.exp_run, l.act_run, l.var_hours, l.exp_qty, l.act_qty,
              l.est_dollars, l.act_dollars, l.var_dollars, l.usage_var, l.price_var, l.var_pct,
              j.part_num AS job_part, j.part_description AS job_part_desc, j.qty_completed AS job_qty, j.cust_id, j.cust_name, j.order_num, j.closed
       FROM line_results l JOIN jobs j ON j.job_num = l.job_num
       WHERE ${where.join(' AND ')}`,
    )
    .all(p)
    .map((r) => ({ ...r }));
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, rows);
  return rows;
}

/**
 * Splits the lines into what can be compared and what cannot.
 *  - estimated:   something was estimated, so a variance % exists
 *  - unestimated: nothing estimated but there are actuals (an estimating gap; shown in its own list, never divided by zero)
 *  - outliers:    lines more than +/-300% off, counted always and dropped from `estimated` only when asked
 * Lines with no estimate and no actuals say nothing and are ignored.
 */
export function splitLines(lines, f) {
  const estimated = [];
  const unestimated = [];
  let outliers = 0;
  for (const l of lines) {
    if (l.unplanned) {
      unestimated.push(l);
      continue;
    }
    const hasEstimate = l.kind === 'op' ? l.exp_hours > 0 : l.exp_qty > 0 || l.est_dollars > 0;
    if (!hasEstimate) continue;
    if (l.var_pct !== null && Math.abs(l.var_pct) > OUTLIER_PCT) {
      outliers++;
      if (f.outliers) continue;
    }
    estimated.push(l);
  }
  return { estimated, unestimated, outliers };
}

// ------------------------------------------------------------------------------------ groups

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function newAcc(key, label, extra = {}) {
  return {
    key, label, ...extra,
    jobs: new Set(), jobsOff: new Set(), lines: 0, linesOff: 0,
    estHrs: 0, actHrs: 0, expSetup: 0, actSetup: 0, expRun: 0, actRun: 0,
    expQty: 0, actQty: 0, estD: 0, actD: 0, varD: 0, gross: 0, usage: 0, price: 0,
  };
}

function add(acc, l) {
  acc.jobs.add(l.job_num);
  acc.lines++;
  if (l.flag !== 'green') {
    acc.linesOff++;
    acc.jobsOff.add(l.job_num);
  }
  acc.estHrs += num(l.exp_hours);
  acc.actHrs += num(l.act_hours);
  acc.expSetup += num(l.exp_setup);
  acc.actSetup += num(l.act_setup);
  acc.expRun += num(l.exp_run);
  acc.actRun += num(l.act_run);
  acc.expQty += num(l.exp_qty);
  acc.actQty += num(l.act_qty);
  acc.estD += num(l.est_dollars);
  acc.actD += num(l.act_dollars);
  acc.varD += num(l.var_dollars);
  acc.gross += Math.abs(num(l.var_dollars)); // gross = sum of the sizes of each line's variance
  acc.usage += num(l.usage_var);
  acc.price += num(l.price_var);
}

/** Turns an accumulator into the figures shown. `kind` is 'op' (hours) or 'material' (quantity). */
function finish(acc, kind) {
  const jobs = acc.jobs.size;
  const pctOff = jobs ? acc.jobsOff.size / jobs : 0;
  const varHrs = acc.actHrs - acc.estHrs;
  const varQty = acc.actQty - acc.expQty;
  // variance % over the whole group: hours for operations, dollars for material (the engine flags material on quantity or dollars)
  const avgPct = kind === 'op' ? (acc.estHrs > 0 ? varHrs / acc.estHrs : null) : acc.estD > 0 ? acc.varD / acc.estD : acc.expQty > 0 ? varQty / acc.expQty : null;
  return {
    key: acc.key,
    label: acc.label,
    description: acc.description ?? '',
    kind,
    jobs,
    jobsOff: acc.jobsOff.size,
    lines: acc.lines,
    linesOff: acc.linesOff,
    pctOff: r4(pctOff),
    estHrs: r2(acc.estHrs), actHrs: r2(acc.actHrs), varHrs: r2(varHrs),
    setup: { est: r2(acc.expSetup), act: r2(acc.actSetup), var: r2(acc.actSetup - acc.expSetup) },
    run: { est: r2(acc.expRun), act: r2(acc.actRun), var: r2(acc.actRun - acc.expRun) },
    expQty: r2(acc.expQty), actQty: r2(acc.actQty), varQty: r2(varQty),
    estDollars: r2(acc.estD), actDollars: r2(acc.actD),
    netDollars: r2(acc.varD), // + = over the estimate, - = under the estimate
    grossDollars: r2(acc.gross),
    usageDollars: r2(acc.usage), priceDollars: r2(acc.price),
    avgPct: avgPct === null ? null : r4(avgPct),
    attention: r2(acc.gross * pctOff),
  };
}

/** Lines -> groups. keyFn returns { key, label, description? }. */
export function groupLines(lines, keyFn, kind) {
  const m = new Map();
  for (const l of lines) {
    if (l.kind !== kind) continue;
    const k = keyFn(l);
    if (!m.has(k.key)) m.set(k.key, newAcc(k.key, k.label, { description: k.description }));
    add(m.get(k.key), l);
  }
  return [...m.values()].map((a) => finish(a, kind));
}

export const opKey = (by) => (l) => (by === 'rg' ? { key: l.resource_grp_id || '(none)', label: l.resource_grp_id || '(No Resource Group)' } : { key: l.op_code || '(none)', label: l.op_code || '(No Op Code)', description: l.description });
export const mtlKey = (by) => (l) => (by === 'class' ? { key: l.class_id || '(none)', label: l.class_id || '(No Class)' } : { key: l.part_num || '(none)', label: l.part_num || '(No Part)', description: l.description });

/** The measure a group is ranked on, for the chosen basis. + means over the estimate. */
export function impactOf(g, basis) {
  if (basis === 'hours') return g.kind === 'op' ? g.varHrs : g.kind === 'material' ? g.varQty : g.netDollars; // customers mix hours and material: dollars
  if (basis === 'pct') return g.avgPct ?? 0;
  return g.netDollars;
}

/**
 * "Needs attention": the group has enough jobs AND either its overall variance is outside the app's green band, or
 * it is off more often than the shop's norm (so +50% / -50% pairs that net to nothing are still caught).
 */
export function needsAttention(g, { greenMax, shopPctOff, minJobs }) {
  if (g.jobs < minJobs) return false;
  const outside = g.avgPct !== null && Math.abs(g.avgPct) >= greenMax;
  return outside || (g.pctOff > shopPctOff && g.attention > 0);
}

/** Top lists: over the estimate (variance > 0) and under the estimate (variance < 0), biggest first by the chosen sort. */
export function rankGroups(groups, f, topN = TOP_N) {
  const eligible = groups.filter((g) => g.jobs >= f.minJobs);
  const val = (g) => impactOf(g, f.basis);
  // The number a list is sorted on. For the variance sorts, "high" means the biggest miss in that list's own direction
  // (over the estimate: biggest positive; under the estimate: biggest negative). Margin sorts use the margin itself.
  // A group with no margin (nothing priced) is always last, whichever way the list runs.
  const keyOf = (g, dir) => {
    const s = dir === 'over' ? 1 : -1;
    switch (f.sort) {
      case 'netvar': return s * g.netDollars;
      case 'attention': return g.attention;
      case 'frequency': return g.pctOff;
      case 'avg': return s * (g.avgPct ?? 0);
      case 'margin': return g.margin ?? null;
      case 'marginpct': return g.marginPct ?? null;
      case 'vstarget': return g.vsTarget ?? null;
      default: return s * val(g);
    }
  };
  const flip = f.order === 'asc' ? -1 : 1;
  const order = (dir) => (a, b) => {
    const ka = keyOf(a, dir);
    const kb = keyOf(b, dir);
    if (ka === null || kb === null) return ka === kb ? a.label.localeCompare(b.label) : ka === null ? 1 : -1;
    return flip * (kb - ka) || a.label.localeCompare(b.label);
  };
  const over = eligible.filter((g) => val(g) > 0).sort(order('over'));
  const under = eligible.filter((g) => val(g) < 0).sort(order('under'));
  return { over: over.slice(0, topN), under: under.slice(0, topN), overAll: over.length, underAll: under.length, hidden: groups.length - eligible.length };
}

function totals(lines, kind) {
  const t = { net: 0, gross: 0, est: 0, act: 0, lines: 0, off: 0 };
  for (const l of lines) {
    if (l.kind !== kind) continue;
    t.net += num(l.var_dollars);
    t.gross += Math.abs(num(l.var_dollars));
    t.est += num(l.est_dollars);
    t.act += num(l.act_dollars);
    t.lines++;
    if (l.flag !== 'green') t.off++;
  }
  return { netDollars: r2(t.net), grossDollars: r2(t.gross), estDollars: r2(t.est), actDollars: r2(t.act), lines: t.lines, linesOff: t.off, accuracy: t.lines ? r4(1 - t.off / t.lines) : null };
}

// ------------------------------------------------------------------------------------ page 1: operations and materials

/** Everything the Operations & Materials page shows. */
export function opsAndMaterials(db, f) {
  const cfg = getEngineConfig(db);
  const lines = loadLines(db, f);
  const { estimated, unestimated, outliers } = splitLines(lines, f);

  const ops = groupLines(estimated, opKey(f.opBy), 'op');
  const mtls = groupLines(estimated, mtlKey(f.mtlBy), 'material');
  const opT = totals(estimated, 'op');
  const mtlT = totals(estimated, 'material');
  const ctx = { greenMax: cfg.greenMax, minJobs: f.minJobs };
  const opCtx = { ...ctx, shopPctOff: opT.lines ? opT.linesOff / opT.lines : 0 };
  const mtlCtx = { ...ctx, shopPctOff: mtlT.lines ? mtlT.linesOff / mtlT.lines : 0 };
  for (const g of ops) g.needsAttention = needsAttention(g, opCtx);
  for (const g of mtls) g.needsAttention = needsAttention(g, mtlCtx);

  const unOps = groupLines(unestimated, opKey(f.opBy), 'op');
  const unMtls = groupLines(unestimated, mtlKey(f.mtlBy), 'material');
  const byActual = (a, b) => b.actDollars - a.actDollars || a.label.localeCompare(b.label);

  // chart: the 15 biggest net $ variances across operations and materials together
  const eligible = [...ops, ...mtls].filter((g) => g.jobs >= f.minJobs && g.netDollars !== 0);
  const chart = eligible
    .sort((a, b) => Math.abs(b.netDollars) - Math.abs(a.netDollars) || a.label.localeCompare(b.label))
    .slice(0, 15)
    .map((g) => ({ kind: g.kind === 'op' ? 'op' : 'mtl', key: g.key, label: `${g.kind === 'op' ? '' : 'Mtl: '}${g.label}`, net: g.netDollars }));

  return {
    filters: f,
    lineCount: lines.length,
    estimatedLines: estimated.length,
    outliers,
    opT, mtlT,
    opAccuracy: opT.accuracy,
    mtlAccuracy: mtlT.accuracy,
    ops: { ...rankGroups(ops, f), all: ops },
    mtls: { ...rankGroups(mtls, f), all: mtls },
    attentionCount: { ops: ops.filter((g) => g.needsAttention).length, mtls: mtls.filter((g) => g.needsAttention).length },
    unestimated: {
      ops: unOps.sort(byActual).slice(0, TOP_N), opsAll: unOps.length,
      mtls: unMtls.sort(byActual).slice(0, TOP_N), mtlsAll: unMtls.length,
      lines: unestimated.length,
      actDollars: r2(unestimated.reduce((t, l) => t + num(l.act_dollars), 0)),
    },
    chart,
  };
}

// ------------------------------------------------------------------------------------ drill-down: group -> parts -> jobs

const jobCustomer = (l) => (l.order_num === null || !l.cust_id ? INTERNAL_LABEL : l.cust_name || l.cust_id);

/** Post-mortem status per job number: { job: { id, status } } (no row = no post-mortem yet). */
export function postMortemStatus(db, jobNums) {
  const out = new Map();
  for (let i = 0; i < jobNums.length; i += 400) {
    const chunk = jobNums.slice(i, i + 400);
    const rows = db.prepare(`SELECT job_num, id, status FROM post_mortems WHERE job_num IN (${chunk.map(() => '?').join(',')})`).all(...chunk);
    for (const r of rows) out.set(r.job_num, { id: r.id, status: r.status });
  }
  return out;
}

/** Trend of variance % over time for some lines: one point per month (or quarter), by the activity date. */
export function trendOf(lines, granularity, kind) {
  const bucket = (d) => {
    if (!d) return null;
    const y = d.slice(0, 4);
    const m = Number(d.slice(5, 7));
    return granularity === 'quarter' ? `${y}-Q${Math.ceil(m / 3)}` : d.slice(0, 7);
  };
  const m = new Map();
  for (const l of lines) {
    const b = bucket(l.activity_date);
    if (!b) continue;
    if (!m.has(b)) m.set(b, { est: 0, act: 0, estD: 0, varD: 0, lines: 0, off: 0 });
    const t = m.get(b);
    t.est += kind === 'op' ? num(l.exp_hours) : num(l.est_dollars);
    t.act += kind === 'op' ? num(l.act_hours) : num(l.act_dollars);
    t.varD += num(l.var_dollars);
    t.lines++;
    if (l.flag !== 'green') t.off++;
  }
  return [...m.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([label, t]) => ({ label, pct: t.est > 0 ? r4((t.act - t.est) / t.est) : null, netDollars: r2(t.varD), lines: t.lines, pctOff: t.lines ? r4(t.off / t.lines) : 0 }));
}

/**
 * A customer's margin over time: one point per month (or quarter), by the day each job closed (the date the date range
 * is applied to). Only closed, priced jobs count, the same as the Margin card, so the points add up to it.
 * Each point: jobs, price, margin $, margin %, and Margin vs Target $ (margin less target % x price).
 */
export function marginTrendOf(db, jobs, granularity, target) {
  const priced = jobs.filter((j) => j.priced);
  const closedOn = new Map();
  for (let i = 0; i < priced.length; i += 500) {
    const chunk = priced.slice(i, i + 500);
    for (const r of db.prepare(`SELECT job_num, closed_date FROM jobs WHERE job_num IN (${chunk.map(() => '?').join(',')})`).all(...chunk.map((j) => j.job))) closedOn.set(r.job_num, r.closed_date);
  }
  const bucket = (d) => {
    if (!d) return null;
    const y = d.slice(0, 4);
    const m = Number(d.slice(5, 7));
    return granularity === 'quarter' ? `${y}-Q${Math.ceil(m / 3)}` : d.slice(0, 7);
  };
  const m = new Map();
  for (const j of priced) {
    const b = bucket(closedOn.get(j.job) || j.activity);
    if (!b) continue;
    if (!m.has(b)) m.set(b, []);
    m.get(b).push(j);
  }
  return [...m.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([label, list]) => {
      const t = marginOf(list);
      return { label, jobs: t.pricedJobs, price: t.price, margin: t.margin, marginPct: t.marginPct, vsTarget: vsTargetOf(t, target) };
    });
}

/** Job-by-job rows for a set of lines of one group (so a job with two WELD operations is one row). */
function jobRows(db, lines, kind) {
  const m = new Map();
  for (const l of lines) {
    if (!m.has(l.job_num)) m.set(l.job_num, { job: l.job_num, part: l.job_part, customer: jobCustomer(l), est: 0, act: 0, estD: 0, actD: 0, varD: 0, off: false, lines: 0 });
    const r = m.get(l.job_num);
    r.est += kind === 'op' ? num(l.exp_hours) : num(l.exp_qty);
    r.act += kind === 'op' ? num(l.act_hours) : num(l.act_qty);
    r.estD += num(l.est_dollars);
    r.actD += num(l.act_dollars);
    r.varD += num(l.var_dollars);
    r.lines++;
    if (l.flag !== 'green') r.off = true;
  }
  const pm = postMortemStatus(db, [...m.keys()]);
  return [...m.values()]
    .map((r) => ({
      ...r,
      est: r2(r.est), act: r2(r.act), estD: r2(r.estD), actD: r2(r.actD), varD: r2(r.varD),
      var: r2(r.act - r.est),
      pct: (kind === 'op' ? r.est : r.estD) > 0 ? r4(kind === 'op' ? (r.act - r.est) / r.est : r.varD / r.estD) : null,
      pm: pm.get(r.job) ?? null,
    }))
    .sort((a, b) => Math.abs(b.varD) - Math.abs(a.varD) || a.job.localeCompare(b.job));
}

/**
 * One operation or material, one level down: its setup / run (or usage / price) split, its trend, the part numbers it
 * appears on (with the repeat offenders marked), and the contributing jobs (all of them, or just one part's).
 * type: 'op' or 'mtl'. key: the group's key under the page's current grouping.
 */
export function drillDown(db, f, { type, key, part = '' }) {
  const kind = type === 'mtl' ? 'material' : 'op';
  const lines = loadLines(db, f);
  const { estimated } = splitLines(lines, f);
  const keyFn = kind === 'op' ? opKey(f.opBy) : mtlKey(f.mtlBy);
  const mine = estimated.filter((l) => l.kind === kind && keyFn(l).key === key);
  if (!mine.length) return null;
  const [group] = groupLines(mine, keyFn, kind);

  // part numbers (the job's part) this group appears on
  const byPart = new Map();
  for (const l of mine) {
    const p = l.job_part || '(none)';
    if (!byPart.has(p)) byPart.set(p, newAcc(p, p, { description: l.job_part_desc }));
    add(byPart.get(p), l);
  }
  const parts = [...byPart.values()]
    .map((a) => ({ ...finish(a, kind), repeat: a.jobsOff.size >= REPEAT_JOBS }))
    .sort((a, b) => Number(b.repeat) - Number(a.repeat) || b.attention - a.attention || a.label.localeCompare(b.label));

  const jobLines = part ? mine.filter((l) => (l.job_part || '(none)') === part) : mine;
  const jobs = jobRows(db, jobLines, kind);
  return { type, key, kind, group, parts, repeatParts: parts.filter((p) => p.repeat).length, part, jobs: jobs.slice(0, 200), jobCount: jobs.length, trend: trendOf(mine, f.trend, kind) };
}

// ------------------------------------------------------------------------------------ page 2: customers

/** Group key for a line's customer. Jobs with no customer (stock, internal) share one bucket. */
function customerOf(l) {
  const internal = l.order_num === null || !l.cust_id;
  return internal ? { key: INTERNAL_KEY, label: INTERNAL_LABEL } : { key: l.cust_id, label: l.cust_name || l.cust_id };
}

/** One row per job: its estimated vs actual dollars, labour vs material, and whether the job as a whole was off. */
function jobTotals(db, estimated, cfg) {
  const m = new Map();
  for (const l of estimated) {
    if (!m.has(l.job_num)) {
      const c = customerOf(l);
      m.set(l.job_num, { job: l.job_num, part: l.job_part, partDesc: l.job_part_desc, custKey: c.key, custLabel: c.label, estD: 0, actD: 0, varD: 0, labour: 0, material: 0, varHrs: 0, qty: num(l.job_qty), activity: l.activity_date, lines: 0, flagged: 0, closed: Boolean(l.closed), order: l.order_num });
    }
    const r = m.get(l.job_num);
    r.estD += num(l.est_dollars);
    r.actD += num(l.act_dollars);
    r.varD += num(l.var_dollars);
    if (l.kind === 'op') {
      r.labour += num(l.var_dollars);
      r.varHrs += num(l.var_hours);
    } else r.material += num(l.var_dollars);
    r.lines++;
    if (l.flag !== 'green') r.flagged++;
  }
  // A job is "off" when its whole-job variance is outside the green band AND big enough to pass the minimum hours / dollars.
  const limits = limitsFor(cfg, {});
  for (const r of m.values()) {
    r.pct = r.estD > 0 ? r.varD / r.estD : null;
    r.off = r.pct !== null && tierFor(r.pct, limits) !== 'green' && passesMinimum({ hours: r.varHrs, dollars: r.varD }, cfg);
  }
  return attachEconomics(db, [...m.values()]);
}

/**
 * What each job sold for and what it really cost, from the numbers stored with the job (job_metrics: the same price and
 * cost the Flagged Jobs grid and the job page show). Only CLOSED jobs with a sale price get a margin: an open job's
 * cost is "so far" against its full price, which would make it look far better than it will end up.
 * Cost is what the job page shows: labour (with burden), material, sub-assemblies, inspection material and subcontract.
 *
 * Finance works out margin for a whole sales order. A job on a priced order that has no price of its own (a cart or a
 * grounding-pad job made for the order, say) still costs money, so the cost of those closed, unpriced jobs is added to
 * the first priced job of the same order (siblingCost) and counted in the customer's margin. It is never shown on one
 * job's own row.
 */
function attachEconomics(db, jobs) {
  const byJob = new Map();
  for (let i = 0; i < jobs.length; i += 500) {
    const chunk = jobs.slice(i, i + 500);
    const rows = db
      .prepare(`SELECT job_num, price, planned_cost, actual_cost FROM job_metrics WHERE job_num IN (${chunk.map(() => '?').join(',')})`)
      .all(...chunk.map((j) => j.job));
    for (const r of rows) byJob.set(r.job_num, r);
  }
  for (const j of jobs) {
    const e = byJob.get(j.job);
    const priced = Boolean(j.closed && e && num(e.price) > 0);
    j.price = priced ? num(e.price) : 0;
    j.cost = priced ? num(e.actual_cost) : 0;
    j.plannedCost = priced ? num(e.planned_cost) : 0;
    j.priced = priced;
    j.siblingCost = 0;
    j.siblingPlanned = 0;
    // The job's TRUE planned and actual cost, the same figures as its margin: labour, material, sub-assemblies, inspection
    // material, subcontract, and work with no estimate. A job still in progress keeps the lines compared so far (its full
    // plan against part-way actuals would be unfair), so it has no sub-assembly or subcontract cost until it closes.
    const full = j.closed && e;
    j.estFull = full ? num(e.planned_cost) : j.estD;
    j.actFull = full ? num(e.actual_cost) : j.actD;
    j.varFull = j.actFull - j.estFull;
  }

  // closed jobs with no price on the same orders as the priced jobs
  const firstOfOrder = new Map();
  for (const j of jobs) if (j.priced && j.order !== null && j.order !== undefined && !firstOfOrder.has(j.order)) firstOfOrder.set(j.order, j);
  const orders = [...firstOfOrder.keys()];
  for (let i = 0; i < orders.length; i += 500) {
    const chunk = orders.slice(i, i + 500);
    const rows = db
      .prepare(`SELECT j.order_num AS o, SUM(m.actual_cost) AS cost, SUM(m.planned_cost) AS planned FROM jobs j JOIN job_metrics m ON m.job_num = j.job_num
                WHERE j.closed = 1 AND COALESCE(m.price, 0) <= 0 AND j.order_num IN (${chunk.map(() => '?').join(',')}) GROUP BY j.order_num`)
      .all(...chunk);
    for (const r of rows) {
      const j = firstOfOrder.get(r.o);
      j.siblingCost = num(r.cost);
      j.siblingPlanned = num(r.planned);
    }
  }
  return jobs;
}

/** Sale price and margin of a set of jobs (only the priced ones count, so the margin % is price-weighted and honest). */
function marginOf(jobs) {
  let price = 0, cost = 0, planned = 0, n = 0, orderCost = 0;
  for (const j of jobs) {
    if (!j.priced) continue;
    n++;
    price += j.price;
    cost += j.cost + j.siblingCost;
    planned += j.plannedCost + j.siblingPlanned;
    orderCost += j.siblingCost;
  }
  return {
    pricedJobs: n,
    price: r2(price),
    cost: r2(cost),
    orderCost: r2(orderCost), // cost of unpriced jobs on the same orders, already inside cost
    margin: n ? r2(price - cost) : null,
    marginPct: price > 0 ? r4((price - cost) / price) : null,
    plannedMarginPct: price > 0 ? r4((price - planned) / price) : null,
  };
}

/** Margin $ less what the target margin would have earned on the same price: negative = dollars short of target. null when nothing is priced. */
export function vsTargetOf(g, target) {
  return g.margin === null || g.margin === undefined ? null : r2(g.margin - target * g.price);
}

function customerGroups(jobs) {
  const m = new Map();
  for (const j of jobs) {
    if (!m.has(j.custKey)) m.set(j.custKey, { key: j.custKey, label: j.custLabel, jobs: 0, off: 0, estD: 0, actD: 0, varD: 0, gross: 0, labour: 0, material: 0, flagged: 0, list: [] });
    const g = m.get(j.custKey);
    g.list.push(j);
    g.jobs++;
    if (j.off) g.off++;
    g.estD += j.estFull;
    g.actD += j.actFull;
    g.varD += j.varFull;
    g.gross += Math.abs(j.varFull);
    g.labour += j.labour;
    g.material += j.material;
    if (j.flagged) g.flagged++;
  }
  return [...m.values()].map((g) => {
    const pctOff = g.jobs ? g.off / g.jobs : 0;
    const lab = Math.abs(g.labour);
    const mat = Math.abs(g.material);
    const labShare = lab + mat > 0 ? lab / (lab + mat) : 0.5;
    return {
      key: g.key, label: g.label, jobs: g.jobs, jobsOff: g.off, pctOff: r4(pctOff),
      estDollars: r2(g.estD), actDollars: r2(g.actD), netDollars: r2(g.varD), grossDollars: r2(g.gross),
      ...marginOf(g.list),
      avgPct: g.estD > 0 ? r4(g.varD / g.estD) : null,
      labourDollars: r2(g.labour), materialDollars: r2(g.material),
      otherDollars: r2(g.varD - g.labour - g.material), // sub-assembly, inspection and unestimated-work variance: what the labour and material columns do not show
      mainly: labShare >= 0.7 ? 'Labour' : labShare <= 0.3 ? 'Material' : 'Both', // a display label only, not a flag
      attention: r2(g.gross * pctOff),
    };
  });
}

/** Everything the Customers page shows. */
export function customersPage(db, f) {
  const cfg = getEngineConfig(db);
  const lines = loadLines(db, f);
  const { estimated, outliers } = splitLines(lines, f);
  const jobs = jobTotals(db, estimated, cfg);
  const groups = customerGroups(jobs);
  const shop = shopFigures(jobs);
  for (const g of groups) {
    g.vsShop = r4(g.pctOff - shop.pctOff); // percentage points worse (+) or better (-) than the shop as a whole
    g.needsAttention = g.jobs >= f.minJobs && ((g.avgPct !== null && Math.abs(g.avgPct) >= cfg.greenMax) || (g.pctOff > shop.pctOff && g.attention > 0));
  }
  const org = loadCustomerOrg(db);
  const tctx = targetContext(db);
  for (const g of groups) {
    // each customer is held to the target margin of its own tier (Settings); the default for a customer with no tier target
    const t = targetFor(tctx, { name: g.label, id: g.key });
    g.target = t.target;
    g.targetSource = t.fromTier ? `tier ${t.tier} target` : 'default target';
    g.vsTarget = vsTargetOf(g, t.target);
  }
  for (const g of groups) Object.assign(g, orgFor(org, g)); // tier + account managers from the Customer Organization list (Settings)
  // the shop's own target: each customer's target weighted by what it was sold for
  const sold = groups.filter((g) => g.margin !== null && g.price > 0);
  const soldTotal = sold.reduce((t, g) => t + g.price, 0);
  shop.targetMargin = soldTotal > 0 ? r4(sold.reduce((t, g) => t + g.price * g.target, 0) / soldTotal) : tctx.settings.targetMarginPct / 100;
  shop.vsTarget = shop.margin === null ? null : r2(sold.reduce((t, g) => t + g.vsTarget, 0));
  // the figures for the cards at the top of the page
  shop.pricedCustomers = sold.length; // customers with a margin (at least one priced closed job)
  shop.underTarget = sold.filter((g) => g.vsTarget !== null && g.vsTarget < 0).length; // of them, how many are below their own target
  const losing = sold.filter((g) => g.margin < 0);
  shop.lossCustomers = losing.length; // customers that lost money over the period
  shop.lossDollars = r2(losing.reduce((t, g) => t + g.margin, 0)); // what they lost between them (negative)
  shop.labourDollars = r2(groups.reduce((t, g) => t + g.labourDollars, 0)); // the net variance split: labour, material and the rest
  shop.materialDollars = r2(groups.reduce((t, g) => t + g.materialDollars, 0));
  shop.otherDollars = r2(shop.netDollars - shop.labourDollars - shop.materialDollars);
  const ranked = rankGroups(groups.map((g) => ({ ...g, kind: 'customer', avgPct: g.avgPct })), f, f.top ?? TOP_CUSTOMERS);
  const eligible = groups.filter((g) => g.jobs >= f.minJobs);
  return {
    filters: f,
    topN: f.top ?? TOP_CUSTOMERS, // how many customers each list shows (titles say so)
    outliers,
    jobCount: jobs.length,
    customers: groups.length,
    attentionCount: groups.filter((g) => g.needsAttention).length,
    shop,
    greenMax: cfg.greenMax,
    targetMargin: num(getSettings(db).targetMarginPct) / 100, // the default target; each customer row carries its own (target), by tier
    under: ranked.under, over: ranked.over, underAll: ranked.underAll, overAll: ranked.overAll, hidden: ranked.hidden,
    all: groups,
    // bubbles: x = % of jobs off, y = net variance %, size = total job dollars
    bubbles: eligible.map((g) => ({ key: g.key, label: g.label, x: g.pctOff, y: g.avgPct ?? 0, dollars: g.actDollars, jobs: g.jobs, attention: g.needsAttention })),
  };
}

/** The shop as a whole, for "is this customer worse than normal?" */
function shopFigures(jobs) {
  const n = jobs.length;
  const off = jobs.filter((j) => j.off).length;
  const est = jobs.reduce((t, j) => t + j.estFull, 0);
  const v = jobs.reduce((t, j) => t + j.varFull, 0);
  return { ...marginOf(jobs), jobs: n, off, pctOff: n ? r4(off / n) : 0, accuracy: n ? r4(1 - off / n) : null, avgPct: est > 0 ? r4(v / est) : null, netDollars: r2(v), grossDollars: r2(jobs.reduce((t, j) => t + Math.abs(j.varFull), 0)) };
}

/**
 * Puts a table's rows in the order the page's filters ask for (Sort Lists By, Sort Order), on the column that sort means for THAT table.
 * keys: { sortId: row => number | null }. A sort the table has no column for keeps the table's usual order (fallback). Rows with no value
 * for the column go last, whichever way it runs. High to Low = the biggest first (for a signed column: the most over the estimate first).
 */
export function sortByFilters(rows, f, keys, fallback) {
  const key = keys[f.sort];
  if (!key) return rows.sort(fallback);
  const dir = f.order === 'asc' ? 1 : -1;
  const none = (v) => v === null || v === undefined || Number.isNaN(v);
  return rows.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (none(ka) || none(kb)) return none(ka) && none(kb) ? fallback(a, b) : none(ka) ? 1 : -1;
    return dir * (ka - kb) || fallback(a, b);
  });
}

/** One customer in full: summary, trend, top operations and materials, repeat parts, job list, post-mortem progress and root causes. */
export function customerDetail(db, f, custKey) {
  const cfg = getEngineConfig(db);
  const all = splitLines(loadLines(db, f), f).estimated;
  const shop = shopFigures(jobTotals(db, all, cfg));
  const lines = splitLines(loadLines(db, f, { cust: custKey }), f).estimated;
  if (!lines.length) return null;
  const jobs = jobTotals(db, lines, cfg);
  const [summary] = customerGroups(jobs);
  Object.assign(summary, orgFor(loadCustomerOrg(db), summary));
  const tgt = targetFor(targetContext(db), { name: summary.label, id: summary.key });
  summary.target = tgt.target;
  summary.targetSource = tgt.fromTier ? `tier ${tgt.tier} target` : 'default target';
  summary.vsTarget = vsTargetOf(summary, tgt.target);
  summary.vsShop = r4(summary.pctOff - shop.pctOff);

  // top operations and materials for this customer: the same lists as page 1, for this customer's lines only (any sample size)
  const one = { ...f, minJobs: 1 };
  const ops = groupLines(lines, opKey(f.opBy), 'op');
  const mtls = groupLines(lines, mtlKey(f.mtlBy), 'material');

  // repeat part numbers: the same part came in off on several jobs
  const byPart = new Map();
  for (const j of jobs) {
    const p = j.part || '(none)';
    if (!byPart.has(p)) byPart.set(p, { part: p, description: j.partDesc, jobs: 0, off: 0, qty: 0, labour: 0, material: 0, varD: 0, estD: 0 });
    const t = byPart.get(p);
    t.jobs++;
    if (j.off) t.off++;
    t.qty += j.qty; // the pieces made, over all of this part's jobs
    t.labour += j.labour;
    t.material += j.material;
    t.varD += j.varFull;
    t.estD += j.estFull;
  }
  const repeatParts = [...byPart.values()]
    .filter((p) => p.off >= REPEAT_JOBS_CUSTOMER)
    .map((p) => ({ ...p, qty: r2(p.qty), labour: r2(p.labour), material: r2(p.material), varD: r2(p.varD), avgPct: p.estD > 0 ? r4(p.varD / p.estD) : null }));
  // Repeat Part Numbers: Net Var $, Avg Var % and the share of jobs off are columns here; Needs Attention is not, so it keeps the usual order
  sortByFilters(repeatParts, f, {
    netvar: (p) => p.varD,
    impact: f.basis === 'pct' ? (p) => p.avgPct : (p) => p.varD, // no hours column: dollars
    avg: (p) => p.avgPct,
    frequency: (p) => p.off / p.jobs,
  }, (a, b) => b.off - a.off || Math.abs(b.varD) - Math.abs(a.varD));

  // job list with post-mortem status
  const pm = postMortemStatus(db, jobs.map((j) => j.job));
  const jobList = jobs
    .map((j) => ({
      ...j, estD: r2(j.estFull), actD: r2(j.actFull), varD: r2(j.varFull), pct: j.estFull > 0 ? r4(j.varFull / j.estFull) : null, pm: pm.get(j.job) ?? null,
      other: r2(j.varFull - j.labour - j.material),
      margin: j.priced ? r2(j.price - j.cost) : null,
      marginPct: j.priced ? r4((j.price - j.cost) / j.price) : null,
      plannedMarginPct: j.priced ? r4((j.price - j.plannedCost) / j.price) : null,
    }));
  // All Jobs: Var $ (Net Var $, Impact), Var % (Avg Variance %, Impact on the % basis) and the Off flag (% of Jobs Off) are columns; Needs Attention is not
  sortByFilters(jobList, f, {
    netvar: (j) => j.varD,
    impact: f.basis === 'pct' ? (j) => j.pct : (j) => j.varD, // no hours column: dollars
    avg: (j) => j.pct,
    frequency: (j) => (j.off ? 1 : 0),
  }, (a, b) => Math.abs(b.varD) - Math.abs(a.varD) || a.job.localeCompare(b.job));

  return {
    filters: f,
    key: custKey,
    summary,
    shop,
    targetMargin: summary.target, // this customer's tier target
    marginTrend: marginTrendOf(db, jobs, f.trend, summary.target),
    ops: rankGroups(ops, one),
    mtls: rankGroups(mtls, one),
    repeatParts,
    jobs: jobList.slice(0, 500),
    jobCount: jobList.length,
    cards: customerCards(db, custKey, jobs),
  };
}

/**
 * The figures behind the cards at the top of a customer's page that are not in the summary:
 *  flagged: this customer's jobs in the date range that are red or yellow (of all its jobs in the range)
 *  open / done: the customer's post-mortems, ALL dates (an open review is open whatever the dates say), each with the most recent one
 *  causes: the root causes picked in those post-mortems, most picked first
 */
export function customerCards(db, custKey, jobs) {
  const flags = jobs.length
    ? db.prepare(`SELECT flag, COUNT(*) AS n FROM job_metrics WHERE flag IN ('red','yellow') AND job_num IN (${jobs.map(() => '?').join(',')}) GROUP BY flag`).all(...jobs.map((j) => j.job))
    : [];
  const flagN = (f) => flags.find((r) => r.flag === f)?.n ?? 0;

  const cond = customerCondition(custKey);
  const p = custKey === INTERNAL_CUSTOMER ? {} : { cust: custKey };
  const pms = db
    .prepare(`SELECT pm.id, pm.job_num AS job, pm.status, pm.updated_at AS updatedAt, pm.closed_at AS closedAt
             FROM post_mortems pm JOIN jobs j ON j.job_num = pm.job_num WHERE ${cond}`)
    .all(p);
  const isDone = (r) => ['closed', 'dismissed'].includes(r.status);
  const newest = (list, key) => [...list].sort((a, b) => String(b[key] ?? b.updatedAt).localeCompare(String(a[key] ?? a.updatedAt)) || b.id - a.id)[0] ?? null;
  const open = pms.filter((r) => !isDone(r));
  const done = pms.filter(isDone);
  const causes = db
    .prepare(`SELECT rc.name AS name, COUNT(*) AS n
             FROM post_mortem_root_causes x JOIN root_causes rc ON rc.id = x.root_cause_id
             JOIN post_mortems pm ON pm.id = x.post_mortem_id JOIN jobs j ON j.job_num = pm.job_num
             WHERE ${cond} GROUP BY rc.name ORDER BY n DESC, rc.name LIMIT 5`)
    .all(p);
  return {
    flagged: { jobs: jobs.length, flagged: flagN('red') + flagN('yellow'), red: flagN('red'), yellow: flagN('yellow') },
    open: { count: open.length, latest: newest(open, 'updatedAt') },
    done: { count: done.length, latest: newest(done, 'closedAt') },
    causes,
  };
}

// ------------------------------------------------------------------------------------ CSV

const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (header, rows) => [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

const pctCell = (v) => (v === null || v === undefined ? '' : r2(v * 100));
const dir = (g, basis) => (impactOf(g, basis) > 0 ? 'Over Estimate' : impactOf(g, basis) < 0 ? 'Under Estimate' : 'On Estimate');

/** The tables as CSV, all groups (not just the top 10) with the page's filters applied. */
export function exportCsv(db, f, view) {
  if (view === 'customers') {
    const d = customersPage(db, f);
    return toCsv(
      ['Customer', 'Tier', 'Account Manager', 'Jobs', 'Priced Jobs', 'Sale Price $', 'Actual Cost $', 'Actual Margin $', 'Actual Margin %', 'Target Margin %', 'Margin vs Target $', 'Planned Margin %', 'Estimated Cost $', 'Actual Cost (All Jobs) $', 'Net Variance $', 'Gross Variance $', 'Avg Variance %', '% of Jobs Off', 'Labour Variance $', 'Material Variance $', 'Other Variance $', 'Mainly', 'Points vs Shop', 'Attention Score', 'Needs Attention', 'Enough Jobs'],
      d.all.sort((a, b) => b.attention - a.attention).map((g) => [g.label, g.tier, g.managers, g.jobs, g.pricedJobs, g.price, g.cost, g.margin, pctCell(g.marginPct), pctCell(g.target), g.vsTarget, pctCell(g.plannedMarginPct), g.estDollars, g.actDollars, g.netDollars, g.grossDollars, pctCell(g.avgPct), pctCell(g.pctOff), g.labourDollars, g.materialDollars, g.otherDollars, g.mainly, r2(g.vsShop * 100), g.attention, g.needsAttention ? 'Yes' : 'No', g.jobs >= f.minJobs ? 'Yes' : 'No']),
    );
  }
  const d = opsAndMaterials(db, f);
  if (view === 'materials') {
    return toCsv(
      ['Material', 'Description', 'Jobs', 'Expected Qty', 'Issued Qty', 'Estimated $', 'Actual $', 'Net Variance $', 'Gross Variance $', 'Usage Variance $', 'Price Variance $', 'Avg Variance %', '% of Jobs Off', 'Attention Score', 'Direction', 'Needs Attention', 'Enough Jobs'],
      d.mtls.all.sort((a, b) => b.attention - a.attention).map((g) => [g.label, g.description, g.jobs, g.expQty, g.actQty, g.estDollars, g.actDollars, g.netDollars, g.grossDollars, g.usageDollars, g.priceDollars, pctCell(g.avgPct), pctCell(g.pctOff), g.attention, dir(g, f.basis), g.needsAttention ? 'Yes' : 'No', g.jobs >= f.minJobs ? 'Yes' : 'No']),
    );
  }
  return toCsv(
    [f.opBy === 'rg' ? 'Resource Group' : 'Operation', 'Jobs', 'Expected Hrs', 'Actual Hrs', 'Variance Hrs', 'Setup Variance Hrs', 'Run Variance Hrs', 'Net Variance $', 'Gross Variance $', 'Avg Variance %', '% of Jobs Off', 'Attention Score', 'Direction', 'Needs Attention', 'Enough Jobs'],
    d.ops.all.sort((a, b) => b.attention - a.attention).map((g) => [g.label, g.jobs, g.estHrs, g.actHrs, g.varHrs, g.setup.var, g.run.var, g.netDollars, g.grossDollars, pctCell(g.avgPct), pctCell(g.pctOff), g.attention, dir(g, f.basis), g.needsAttention ? 'Yes' : 'No', g.jobs >= f.minJobs ? 'Yes' : 'No']),
  );
}

