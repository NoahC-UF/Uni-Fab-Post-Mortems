// Puts the operation and material rules together for one job.

import { createHash } from 'node:crypto';
import { num, r2, r4 } from './num.js';
import { TIER_RANK, DEFAULT_CONFIG } from './thresholds.js';
import { evaluateOperation, evaluateWatch } from './labour.js';
import { evaluateMaterial } from './materials.js';

export function mergeConfig(overrides = {}) {
  return { ...DEFAULT_CONFIG, ...overrides };
}

const opKey = (asm, seq) => `${num(asm)}-${num(seq)}`;

function groupBy(list, keyFn) {
  const m = new Map();
  for (const x of list) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

/**
 * inputs: { job, ops[], materials[], transactions[], labor[] }  (camelCase, see src/model.js)
 * returns a plain, JSON-safe result object. This is what gets frozen into a post-mortem snapshot.
 */
export function evaluateJob(inputs, config = DEFAULT_CONFIG) {
  const cfg = mergeConfig(config);
  const { job, ops = [], materials = [], transactions = [], labor = [] } = inputs;
  const jobClosed = !!job.closed;

  const laborByOp = groupBy(labor, (l) => opKey(l.assemblySeq, l.oprSeq));
  const transByLine = groupBy(transactions, (t) => opKey(t.assemblySeq, t.mtlSeq));

  const opResults = ops.map((op) => {
    const rows = laborByOp.get(opKey(op.assemblySeq, op.oprSeq));
    const laborHours = rows ? rows.reduce((t, l) => t + num(l.laborHrs), 0) : labor.length ? 0 : null;
    return evaluateOperation(op, { cfg, jobClosed, laborHours });
  });

  const mtlResults = materials.map((m) =>
    evaluateMaterial(m, { cfg, job, trans: transByLine.get(opKey(m.assemblySeq, m.mtlSeq)) ?? [] }),
  );

  const watch = jobClosed
    ? []
    : ops.filter((op, i) => !opResults[i].counts && !op.subcontract).map((op) => evaluateWatch(op, { cfg }));

  // ---- totals -------------------------------------------------------------------
  const countedOps = opResults.filter((o) => o.counts);
  const activeMtls = mtlResults.filter((m) => !m.pending);
  const flaggedOps = opResults.filter((o) => o.flagged);
  const flaggedMtls = mtlResults.filter((m) => m.flagged);

  const labourVar = r2(countedOps.reduce((t, o) => t + o.varDollars, 0));
  const materialVar = r2(activeMtls.reduce((t, m) => t + m.dollarVar, 0));

  let over = 0;
  let under = 0;
  let impact = 0;
  for (const line of [...flaggedOps.map((o) => o.varDollars), ...flaggedMtls.map((m) => m.dollarVar)]) {
    impact += Math.abs(line);
    if (line > 0) over += line;
    else under += -line;
  }

  const flags = [...flaggedOps, ...flaggedMtls].map((l) => l.flag);
  const worst = flags.reduce((w, f) => (TIER_RANK[f] > TIER_RANK[w] ? f : w), 'green');

  const result = {
    job: {
      jobNum: job.jobNum,
      partNum: job.partNum ?? '',
      partDescription: job.partDescription ?? '',
      custId: job.custId ?? '',
      custName: job.custName ?? '',
      prodQty: num(job.prodQty),
      qtyCompleted: num(job.qtyCompleted),
      closed: jobClosed,
      closedDate: job.closedDate ?? null,
      orderNum: job.orderNum ?? null,
    },
    jobState: jobClosed ? 'closed' : 'open',
    ops: opResults,
    materials: mtlResults,
    watch,
    totals: {
      labour: {
        estHours: r4(countedOps.reduce((t, o) => t + o.est.total, 0)),
        actHours: r4(countedOps.reduce((t, o) => t + o.act.total, 0)),
        estDollars: r2(countedOps.reduce((t, o) => t + o.expectedDollars, 0)),
        actDollars: r2(countedOps.reduce((t, o) => t + o.actDollars, 0)),
        varDollars: labourVar,
      },
      material: {
        estDollars: r2(activeMtls.reduce((t, m) => t + m.estDollars, 0)),
        actDollars: r2(activeMtls.reduce((t, m) => t + m.actDollars, 0)),
        usageVar: r2(activeMtls.reduce((t, m) => t + m.usageVar, 0)),
        priceVar: r2(activeMtls.reduce((t, m) => t + m.priceVar, 0)),
        varDollars: materialVar,
      },
      netDollars: r2(labourVar + materialVar),
      overDollars: r2(over),
      underDollars: r2(under),
      impactDollars: r2(impact),
    },
    flag: worst,
    flaggedLines: flags.length,
    redLines: flags.filter((f) => f === 'red').length,
    yellowLines: flags.filter((f) => f === 'yellow').length,
    dqCount: opResults.reduce((t, o) => t + o.dq.length, 0) + mtlResults.reduce((t, m) => t + m.dq.length, 0),
  };
  result.fingerprint = fingerprint(result);
  return result;
}

/** Stable short hash of the numbers that matter; used to detect "live data changed since snapshot". */
export function fingerprint(result) {
  const core = {
    c: result.job.closed,
    q: result.job.qtyCompleted,
    o: result.ops.map((o) => [o.assemblySeq, o.oprSeq, o.act.setup, o.act.run, o.qty.completed, o.opComplete]),
    m: result.materials.map((m) => [m.assemblySeq, m.mtlSeq, m.actualQty, m.actDollars]),
  };
  return createHash('sha1').update(JSON.stringify(core)).digest('hex').slice(0, 12);
}

/**
 * Compare a frozen snapshot with the live evaluation and list what changed
 * (empty list = nothing changed). Used for the post-mortem warning banner.
 */
export function diffSnapshot(snapshot, live) {
  if (!snapshot || !live) return [];
  if (snapshot.fingerprint && snapshot.fingerprint === live.fingerprint) return [];
  const out = [];
  const add = (label, before, after, unit = '') => {
    if (Math.abs(num(before) - num(after)) > 0.004) out.push({ label, before: num(before), after: num(after), unit });
  };
  add('Labour actual hours', snapshot.totals.labour.actHours, live.totals.labour.actHours, 'hrs');
  add('Labour variance', snapshot.totals.labour.varDollars, live.totals.labour.varDollars, '$');
  add('Material actual cost', snapshot.totals.material.actDollars, live.totals.material.actDollars, '$');
  add('Material variance', snapshot.totals.material.varDollars, live.totals.material.varDollars, '$');
  add('Qty completed', snapshot.job.qtyCompleted, live.job.qtyCompleted, 'pcs');
  if (snapshot.job.closed !== live.job.closed) {
    out.push({ label: 'Job closed', before: snapshot.job.closed ? 'yes' : 'no', after: live.job.closed ? 'yes' : 'no', unit: '' });
  }
  if (!out.length) out.push({ label: 'Underlying transactions changed', before: '', after: '', unit: '' });
  return out;
}

/** Flat rows for the flag_lines table. */
export function flagLineRows(result) {
  const rows = [];
  for (const o of result.ops) {
    if (!o.flagged) continue;
    rows.push({
      kind: 'op',
      assemblySeq: o.assemblySeq,
      seq: o.oprSeq,
      opCode: o.opCode,
      resourceGrpId: o.resourceGrpId,
      partNum: null,
      flag: o.flag,
      direction: o.direction,
      unplanned: o.unplanned,
      varHours: o.varHours,
      varPct: o.varPct,
      varDollars: o.varDollars,
    });
  }
  for (const m of result.materials) {
    if (!m.flagged) continue;
    rows.push({
      kind: 'material',
      assemblySeq: m.assemblySeq,
      seq: m.mtlSeq,
      opCode: null,
      resourceGrpId: null,
      partNum: m.partNum,
      flag: m.flag,
      direction: m.direction,
      unplanned: m.unplanned,
      varHours: null,
      varPct: m.dollarPct ?? m.qtyPct,
      varDollars: m.dollarVar,
    });
  }
  return rows;
}
