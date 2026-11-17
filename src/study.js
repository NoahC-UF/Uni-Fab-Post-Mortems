// "Study": look at several jobs together to find patterns, and to tell apart the three places a lost margin
// can come from:
//   Estimating   the price was below goal before the shop started (planned margin under the goal)
//   Job release  the plan looked healthy because the planned hours were too low: the job booked about twice
//                its planned hours across several operations, or lost most of its margin on operations that
//                overrun on most jobs (a low standard, not a one-off)
//   Shop         a narrower overrun: one or two operations far over their hours on this job
//
// Everything is computed fresh from the stored job data with the same engine as the job page, so a number
// here always matches the job's own page. The three-way split is a rule of thumb: without the hours that
// were quoted (the Quote vs Job BAQ) the app cannot cleanly separate estimating from job release.

import { evaluateJob } from './engine/job.js';
import { loadJobInputs } from './staging.js';
import { computeEconomics, CAUSE_LABELS } from './economics.js';
import { getSettings } from './settings.js';
import { loadExtraCosts } from './extraCosts.js';
import { targetContext, targetFor } from './targets.js';
import { quantityNote } from './quantity.js';

export const MAX_STUDY_JOBS = 300;
export const MATRIX_MAX_JOBS = 30;
export const MATRIX_MAX_OPS = 15;
const MIN_JOBS_FOR_PATTERN = 3;
// Rules of thumb for telling a broad overrun (planned hours too low) from a narrow one (shop):
const BROAD_JOB_MULTIPLE = 2.0; // the job booked at least this many times its planned hours...
const BROAD_OP_MULTIPLE = 1.5; // ...with at least two operations at this multiple of their own hours

export const FOCUS_LABELS = {
  estimating: 'Estimating',
  'release-shop': 'Job Release + Shop',
  shop: 'Shop',
  met: 'Met Target',
  data: 'Check Data',
  'no-price': 'No Price',
  open: 'Still Open',
};

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const r4 = (n) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const sumBy = (arr, f) => r2(arr.reduce((t, x) => t + num(f(x)), 0));
const pc = (v) => `${(v * 100).toFixed(1)}%`;
const money0 = (v) => `${v < 0 ? '-' : ''}$${Math.abs(Math.round(v)).toLocaleString('en-CA')}`;

function median(values) {
  const s = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const mean = (values) => (values.length ? values.reduce((t, v) => t + v, 0) / values.length : null);

/**
 * @param {object} db
 * @param {string[]} jobNums
 * @param {object} config   engine config (thresholds, rates)
 * @param {{targetMarginPct: number, baseCurrency: string}} settings
 */
export function buildStudy(db, jobNums, config, settings) {
  const unique = [...new Set(jobNums)];
  const truncated = unique.length > MAX_STUDY_JOBS;
  const list = unique.slice(0, MAX_STUDY_JOBS);
  // Each job is held to the target margin of its customer's tier (Settings); settings.targetMarginPct is the default.
  const tctx = targetContext(db, { ...getSettings(db), ...settings });

  const jobs = [];
  const missing = [];
  const mtlAgg = new Map(); // partNum -> aggregate
  const cells = new Map(); // `${opCode}|${jobNum}` -> { opCode, jobNum, expected, actual, varDollars, flagged }
  const opFlagged = new Map(); // opCode -> flagged operation count

  // ---------------------------------------------------------------- per job
  for (const jobNum of list) {
    const inputs = loadJobInputs(db, jobNum);
    if (!inputs) {
      missing.push(jobNum);
      continue;
    }
    const result = evaluateJob(inputs, config);
    const tgt = targetFor(tctx, { name: inputs.job.custName, id: inputs.job.custId });
    const econ = computeEconomics(result, inputs.revenue, { ...settings, targetMarginPct: tgt.pct, tier: tgt.tier, extra: loadExtraCosts(db, jobNum, { config }) });
    const qNote = quantityNote(result);
    const lab = result.totals.labour;

    jobs.push({
      jobNum,
      part: inputs.job.partNum ?? '',
      customer: inputs.job.custName ?? '',
      closed: result.jobState === 'closed',
      closedDate: inputs.job.closedDate ?? null,
      qtyOrdered: num(inputs.job.prodQty),
      qtyMade: num(inputs.job.qtyCompleted),
      flag: result.flag,
      flaggedLines: result.flaggedLines,
      impact: result.totals.impactDollars,
      labourVar: result.totals.labour.varDollars,
      materialVar: result.totals.material.varDollars,
      plannedHours: lab.estHours,
      actualHours: lab.actHours,
      hoursMultiple: lab.estHours > 0 ? r2(lab.actHours / lab.estHours) : null,
      labourDiff: econ.labour.diff, // actual labour cost minus planned labour cost
      materialDiff: econ.material.diff,
      tier: tgt.tier,
      target: tgt.target, // the target margin that applies to this job (fraction)
      price: econ.price,
      plannedCost: econ.cost.planned,
      actualCost: econ.cost.actual,
      plannedMargin: econ.margin.planned,
      actualMargin: econ.margin.actual,
      plannedMarginPct: econ.margin.plannedPct,
      actualMarginPct: econ.margin.actualPct,
      cause: econ.verdict.code,
      causeLabel: CAUSE_LABELS[econ.verdict.code] ?? '',
      qtyNote: qNote?.text ?? null,
      qtyNoteShort: qNote ? `quantity ${qNote.jobQty} vs ${qNote.typicalQty} on most operations` : null,
      focus: null,
      focusLabel: '',
      focusDetail: '',
      priceNeeded: null,
      priceGapPct: null,
    });

    for (const o of result.ops) {
      if (!o.counts || o.subcontract) continue;
      const code = o.opCode || '(none)';
      const ck = `${code}|${jobNum}`;
      const c = cells.get(ck) ?? { opCode: code, jobNum, expected: 0, actual: 0, varDollars: 0, flagged: false };
      c.expected += o.expectedHours;
      c.actual += o.act.total;
      c.varDollars += o.varDollars;
      c.flagged ||= o.flagged;
      cells.set(ck, c);
      if (o.flagged) opFlagged.set(code, (opFlagged.get(code) ?? 0) + 1);
    }

    for (const m of result.materials) {
      if (m.pending) continue;
      const key = m.partNum || '(none)';
      const a = mtlAgg.get(key) ?? { partNum: key, description: m.description, jobs: new Set(), expectedQty: 0, actualQty: 0, estDollars: 0, actDollars: 0, usageVar: 0, priceVar: 0, flagged: 0 };
      a.jobs.add(jobNum);
      a.expectedQty += m.expectedQty;
      a.actualQty += m.actualQty;
      a.estDollars += m.estDollars;
      a.actDollars += m.actDollars;
      a.usageVar += m.usageVar;
      a.priceVar += m.priceVar;
      if (m.flagged) a.flagged++;
      mtlAgg.set(key, a);
    }
  }

  // ------------------------------------------------- by operation (each job counted once per operation)
  const byOp = new Map();
  for (const c of cells.values()) {
    const list_ = byOp.get(c.opCode) ?? [];
    list_.push(c);
    byOp.set(c.opCode, list_);
  }
  let operations = [...byOp.entries()].map(([opCode, cs]) => {
    const expected = cs.reduce((t, c) => t + c.expected, 0);
    const actual = cs.reduce((t, c) => t + c.actual, 0);
    const jobsOver = cs.filter((c) => c.actual > c.expected).length;
    const jobsUnder = cs.filter((c) => c.actual < c.expected).length;
    const medianVarPct = median(cs.filter((c) => c.expected > 0).map((c) => (c.actual - c.expected) / c.expected));
    const decided = jobsOver + jobsUnder;
    const share = decided ? Math.max(jobsOver, jobsUnder) / decided : 0;
    const steady = cs.length >= MIN_JOBS_FOR_PATTERN && decided > 0 && medianVarPct !== null && share >= 0.75 && Math.abs(medianVarPct) >= 0.1;
    let pattern = 'Mixed: no steady pattern';
    if (cs.length < MIN_JOBS_FOR_PATTERN || medianVarPct === null || decided === 0) pattern = 'Too few jobs to say';
    else if (steady) pattern = jobsOver > jobsUnder ? 'Usually over: estimate looks low' : 'Usually under: estimate looks high';
    return {
      opCode,
      jobs: cs.length,
      expectedHours: r2(expected),
      actualHours: r2(actual),
      varHours: r2(actual - expected),
      varPct: expected > 0 ? r4((actual - expected) / expected) : null,
      hoursMultiple: expected > 0 ? r2(actual / expected) : null,
      medianVarPct: medianVarPct === null ? null : r4(medianVarPct),
      jobsOver,
      jobsUnder,
      flagged: opFlagged.get(opCode) ?? 0,
      varDollars: r2(cs.reduce((t, c) => t + c.varDollars, 0)),
      shareOfNet: null,
      usuallyOver: steady && jobsOver > jobsUnder,
      pattern,
    };
  });
  const netOpVar = r2(operations.reduce((t, o) => t + o.varDollars, 0));
  operations = operations
    .map((o) => ({ ...o, shareOfNet: netOpVar > 0 ? r4(o.varDollars / netOpVar) : null }))
    .sort((x, y) => Math.abs(y.varDollars) - Math.abs(x.varDollars));
  const usuallyOver = new Set(operations.filter((o) => o.usuallyOver).map((o) => o.opCode));

  // ---------------------------------------------------------------- where to look, per job
  for (const j of jobs) {
    if (j.price !== null && j.actualMarginPct !== null && j.actualMarginPct < j.target) {
      j.priceNeeded = r2(j.actualCost / (1 - j.target)); // the price that would have earned the goal at the cost it really had
      j.priceGapPct = j.price > 0 ? r4(j.priceNeeded / j.price - 1) : null;
    }
    const mine = [...cells.values()].filter((c) => c.jobNum === j.jobNum);
    const over = mine.filter((c) => c.varDollars > 0 && c.expected > 0).sort((a, b) => b.varDollars - a.varDollars);
    const top = over.slice(0, 3).map((c) => `${c.opCode.toLowerCase()} ${(c.actual / c.expected).toFixed(1)}×`).join(', ');
    const overDollars = over.reduce((t, c) => t + c.varDollars, 0);
    const broadOps = over.filter((c) => c.actual / c.expected >= BROAD_OP_MULTIPLE).length;
    const broad = j.hoursMultiple !== null && j.hoursMultiple >= BROAD_JOB_MULTIPLE && broadOps >= 2;
    const systemicDollars = over.filter((c) => usuallyOver.has(c.opCode)).reduce((t, c) => t + c.varDollars, 0);

    if (!j.closed) {
      j.focus = 'open';
      j.focusDetail = j.price === null ? 'no sale price' : 'margin so far; not final';
    } else if (j.qtyNote) {
      j.focus = 'data';
      j.focusDetail = j.qtyNoteShort;
    } else if (j.price === null) {
      j.focus = 'no-price';
      j.focusDetail = 'no sale price; hours only';
    } else if (j.plannedMarginPct < j.target) {
      j.focus = 'estimating';
      j.focusDetail = `planned margin only ${pc(j.plannedMarginPct)} against the ${pc(j.target)} goal`;
    } else if (j.actualMarginPct >= j.target) {
      j.focus = 'met';
      j.focusDetail = top ? `still over on ${top}` : '';
    } else if (broad || (overDollars > 0 && systemicDollars / overDollars >= 0.5)) {
      j.focus = 'release-shop';
      j.focusDetail = top;
    } else {
      j.focus = 'shop';
      j.focusDetail = top;
    }
    j.focusLabel = FOCUS_LABELS[j.focus];
  }

  // ---------------------------------------------------------------- materials
  const materials = [...mtlAgg.values()]
    .map((a) => ({
      partNum: a.partNum,
      description: a.description,
      jobs: a.jobs.size,
      expectedQty: r2(a.expectedQty),
      actualQty: r2(a.actualQty),
      estDollars: r2(a.estDollars),
      actDollars: r2(a.actDollars),
      varDollars: r2(a.actDollars - a.estDollars),
      varPct: a.estDollars > 0 ? r4((a.actDollars - a.estDollars) / a.estDollars) : null,
      usageVar: r2(a.usageVar),
      priceVar: r2(a.priceVar),
      flagged: a.flagged,
    }))
    .sort((x, y) => Math.abs(y.varDollars) - Math.abs(x.varDollars));

  // ---------------------------------------------------------------- heat map
  const matrixJobs = jobs.slice(0, MATRIX_MAX_JOBS).map((j) => j.jobNum);
  const matrixOps = operations.slice(0, MATRIX_MAX_OPS).map((o) => o.opCode);
  const matrix = {
    jobs: matrixJobs,
    truncatedJobs: jobs.length > MATRIX_MAX_JOBS,
    rows: matrixOps.map((code) => ({
      opCode: code,
      cells: matrixJobs.map((jn) => {
        const c = cells.get(`${code}|${jn}`);
        if (!c) return null;
        const pct = c.expected > 0 ? r4((c.actual - c.expected) / c.expected) : null;
        const hrs = r2(c.actual - c.expected);
        const usd = r2(c.varDollars);
        const dirOf = (v) => (v > 0 ? 'over' : v < 0 ? 'under' : 'zero');
        // each view (%, hours, $) has its own colour direction and strength; hours and $ are shaded by size relative to the biggest cell
        return { pct, hrs, usd, expected: r2(c.expected), actual: r2(c.actual), flagged: c.flagged, dir: dirOf(hrs), dirPct: pct === null ? 'zero' : dirOf(pct), dirUsd: dirOf(usd), shade: pct === null ? 0 : Math.min(70, Math.round(Math.abs(pct) * 160)), shadeHrs: 0, shadeUsd: 0 };
      }),
    })),
  };
  const heatCells = matrix.rows.flatMap((r) => r.cells.filter(Boolean));
  const maxHrs = Math.max(0, ...heatCells.map((c) => Math.abs(c.hrs)));
  const maxUsd = Math.max(0, ...heatCells.map((c) => Math.abs(c.usd)));
  for (const c of heatCells) {
    // square-root scaling so one huge cell does not wash out all the others
    c.shadeHrs = maxHrs > 0 ? Math.min(70, Math.round(70 * Math.sqrt(Math.abs(c.hrs) / maxHrs))) : 0;
    c.shadeUsd = maxUsd > 0 ? Math.min(70, Math.round(70 * Math.sqrt(Math.abs(c.usd) / maxUsd))) : 0;
  }

  // ---------------------------------------------------------------- margins (closed jobs that have a price)
  const priced = jobs.filter((j) => j.closed && j.price !== null);
  const price = sumBy(priced, (j) => j.price);
  const plannedCost = sumBy(priced, (j) => j.plannedCost);
  const actualCost = sumBy(priced, (j) => j.actualCost);
  const plannedHours = sumBy(priced, (j) => j.plannedHours);
  const actualHours = sumBy(priced, (j) => j.actualHours);
  const pp = priced.map((j) => j.plannedMarginPct);
  const ap = priced.map((j) => j.actualMarginPct);
  // one number for the group: each job's target weighted by its price (it is just the target when every job has the same one)
  const target = price > 0 ? r4(priced.reduce((t, j) => t + j.price * j.target, 0) / price) : num(tctx.settings.targetMarginPct) / 100;
  const avgGap = priced.length ? priced.reduce((t, j) => t + (j.actualMarginPct - j.target), 0) / priced.length : null; // average points above / below each job's own target
  const stats = {
    n: priced.length,
    target,
    targetsDiffer: new Set(priced.map((j) => j.target)).size > 1,
    avgGap,
    average: { planned: mean(pp), actual: mean(ap) },
    median: { planned: median(pp), actual: median(ap) },
    weighted: { planned: price > 0 ? (price - plannedCost) / price : null, actual: price > 0 ? (price - actualCost) / price : null },
    dollars: { planned: r2(price - plannedCost), actual: r2(price - actualCost), shortfall: r2(price - actualCost - (price - plannedCost)) },
    // dollars the group earned compared with what the goal margin would have earned
    vsGoalDollars: { planned: r2(priced.reduce((t, j) => t + j.price - j.plannedCost - j.price * j.target, 0)), actual: r2(priced.reduce((t, j) => t + j.price - j.actualCost - j.price * j.target, 0)) },
    hours: { planned: plannedHours, actual: actualHours, multiple: plannedHours > 0 ? r2(actualHours / plannedHours) : null, extra: r2(actualHours - plannedHours) },
    labourDiff: sumBy(priced, (j) => j.labourDiff),
    materialDiff: sumBy(priced, (j) => j.materialDiff),
    belowGoal: priced.filter((j) => j.actualMarginPct < j.target).length,
    setUpAboveGoal: priced.filter((j) => j.plannedMarginPct >= j.target).length,
    setUpBelowGoal: priced.filter((j) => j.plannedMarginPct < j.target).length,
  };
  for (const k of ['average', 'median', 'weighted']) for (const w of ['planned', 'actual']) if (stats[k][w] !== null) stats[k][w] = r4(stats[k][w]);

  const focusCounts = {};
  for (const j of jobs) focusCounts[j.focus] = (focusCounts[j.focus] ?? 0) + 1;
  const causes = {};
  for (const j of jobs) causes[j.cause] = (causes[j.cause] ?? 0) + 1;

  // ---------------------------------------------------------------- repeat parts
  const byPart = new Map();
  for (const j of jobs) {
    if (!j.part) continue;
    const a = byPart.get(j.part) ?? [];
    a.push(j);
    byPart.set(j.part, a);
  }
  const repeatParts = [...byPart.entries()]
    .filter(([, js]) => js.length >= 2)
    .map(([part, js]) => {
      const closedPriced = js.filter((j) => j.closed && j.price !== null);
      const pr = sumBy(closedPriced, (j) => j.price);
      const ac = sumBy(closedPriced, (j) => j.actualCost);
      const pl = sumBy(closedPriced, (j) => j.plannedCost);
      const ph = sumBy(js, (j) => j.plannedHours);
      const ah = sumBy(js, (j) => j.actualHours);
      return {
        part,
        jobs: js.map((j) => j.jobNum),
        pricedJobs: closedPriced.length,
        price: pr,
        plannedMargin: r2(pr - pl),
        actualMargin: r2(pr - ac),
        belowPlan: r2(pr - pl - (pr - ac)),
        actualMarginPct: pr > 0 ? r4((pr - ac) / pr) : null,
        hoursMultiple: ph > 0 ? r2(ah / ph) : null,
        lostEveryRun: closedPriced.length >= 2 && closedPriced.every((j) => j.actualMargin < 0),
      };
    })
    .filter((p) => p.pricedJobs >= 1)
    .sort((a, b) => a.actualMargin - b.actualMargin);

  const summary = summarise({ stats, operations, netOpVar, jobs, priced, target });

  // ---------------------------------------------------------------- chart: margins in close-date order
  const ordered = [...priced].sort((a, b) => String(a.closedDate ?? '9999').localeCompare(String(b.closedDate ?? '9999')) || a.jobNum.localeCompare(b.jobNum));
  const chart = {
    labels: ordered.map((j) => j.jobNum),
    closed: ordered.map((j) => j.closedDate),
    parts: ordered.map((j) => j.part),
    planned: ordered.map((j) => r2(j.plannedMarginPct * 100)),
    actual: ordered.map((j) => r2(j.actualMarginPct * 100)),
    target: r2(target * 100),
    goals: ordered.map((j) => r2(j.target * 100)), // each job's own target, for the goal line
  };

  // for the "where to look" table: the jobs whose price fell furthest short of the cost first
  const ranked = [...jobs].sort((a, b) => (b.priceGapPct ?? -Infinity) - (a.priceGapPct ?? -Infinity) || a.jobNum.localeCompare(b.jobNum));

  return {
    jobs,
    ranked,
    missing,
    truncated,
    total: unique.length,
    operations,
    materials,
    matrix,
    chart,
    repeatParts,
    summary,
    stats,
    focusCounts,
    qtyNotes: jobs.filter((j) => j.qtyNote).map((j) => ({ jobNum: j.jobNum, text: j.qtyNote })),
    causes,
    netOpVar,
    totals: {
      jobs: jobs.length,
      pricedJobs: priced.length,
      openJobs: jobs.filter((j) => !j.closed).length,
      price,
      plannedCost,
      actualCost,
      plannedMargin: stats.dollars.planned,
      actualMargin: stats.dollars.actual,
      plannedMarginPct: stats.weighted.planned,
      actualMarginPct: stats.weighted.actual,
      labourVar: sumBy(jobs, (j) => j.labourVar),
      materialVar: sumBy(jobs, (j) => j.materialVar),
      impact: sumBy(jobs, (j) => j.impact),
      belowTarget: stats.belowGoal,
    },
  };
}

/** The opening paragraph and the three-team readout, in plain words. */
function summarise({ stats, operations, netOpVar, jobs, priced, target }) {
  if (!priced.length) {
    return { headline: 'None of these jobs is closed with a sale price, so margins cannot be shown. The hour comparisons below still work.', teams: [] };
  }
  const avgP = stats.average.planned;
  const avgA = stats.average.actual;
  const diff = stats.avgGap ?? avgA - target; // average of each job against its own target
  const pts = Math.abs(diff * 100).toFixed(1);
  const gap = `${pts} points ${diff < 0 ? 'under' : 'over'} ${stats.targetsDiffer ? `each job's own goal (${pc(target)} on average)` : `the ${pc(target)} goal`}`;
  let headline = `Jobs were set up to make ${pc(avgP)} on average, and finished at ${pc(avgA)}: ${gap}.`;

  const lab = stats.labourDiff;
  const mat = stats.materialDiff;
  const mult = stats.hours.multiple;
  if (lab + mat > 0) {
    const labourShare = lab > 0 ? lab / (Math.max(lab, 0) + Math.max(mat, 0)) : 0;
    headline +=
      ` Cost ran ${money0(lab + mat)} over plan on the ${priced.length} priced job${priced.length === 1 ? '' : 's'}` +
      `${labourShare >= 0.7 ? ', almost all of it shop labour' : ''}: labour ${lab >= 0 ? '+' : '-'}${money0(Math.abs(lab))}, material ${mat >= 0 ? '+' : '-'}${money0(Math.abs(mat))}` +
      `${mult ? `; they booked ${mult.toFixed(1)}× their planned hours` : ''}.`;
  } else if (mult) {
    headline += ` The priced jobs booked ${mult.toFixed(1)}× their planned hours.`;
  }

  const teams = [];
  const est = jobs.filter((j) => j.focus === 'estimating');
  const names = (arr) => arr.slice(0, 4).map((j) => j.jobNum).join(', ') + (arr.length > 4 ? ` and ${arr.length - 4} more` : '');
  teams.push({
    team: 'Estimating',
    text:
      `${stats.belowGoal} of ${priced.length} jobs finished below ${stats.targetsDiffer ? 'their goal' : pc(target)}` +
      `${est.length ? `; ${est.length} of them (${names(est)}) were priced below goal before the shop started` : '; none were priced below goal before the shop started'}. ` +
      'Without the quoted hours, a low actual margin cannot be pinned on estimating alone.',
  });
  const release = jobs.filter((j) => j.focus === 'release-shop');
  teams.push({
    team: 'Job Release',
    text:
      `${stats.setUpAboveGoal} of ${priced.length} jobs were set up above goal, so the planned hours made the price look healthy` +
      `${mult && mult > 1 ? `; actual hours then ran ${mult.toFixed(1)}× planned` : ''}. ` +
      `${release.length ? `${release.length} job${release.length === 1 ? '' : 's'} (${names(release)}) booked about twice their planned hours or more across several operations, or lost their margin on operations that overrun on most jobs: that points at planned hours set too low.` : 'No job booked about twice its planned hours across several operations.'}`,
  });
  const shopJobs = jobs.filter((j) => j.focus === 'shop');
  const topOp = operations.find((o) => o.varDollars > 0);
  teams.push({
    team: 'Shop',
    text:
      `${topOp && netOpVar > 0 ? `${topOp.opCode} alone is ${money0(topOp.varDollars)} of the ${money0(netOpVar)} net operation overrun (${Math.round((topOp.varDollars / netOpVar) * 100)}%). ` : ''}` +
      `${shopJobs.length ? `${shopJobs.length} job${shopJobs.length === 1 ? '' : 's'} (${names(shopJobs)}) lost ${shopJobs.length === 1 ? 'its' : 'their'} margin on one or two operations rather than across the board.` : 'No job lost its margin on just one or two operations.'}`,
  });
  return { headline, teams };
}
