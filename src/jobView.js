// Builds everything the Job Detail page and the printable report need for one job.

import { evaluateJob } from './engine/job.js';
import { getEngineConfig, getSettings } from './settings.js';
import { computeEconomics } from './economics.js';
import { loadExtraCosts } from './extraCosts.js';
import { targetContext, targetFor } from './targets.js';
import { quantityNote } from './quantity.js';
import { loadJobInputs } from './staging.js';

const key = (a, o) => `${a}-${o}`;

/**
 * Employee names and numbers are only shown to Admins (employee-level data). Reviewers still
 * see when, how long, how many pieces and scrap, which is what a methods review needs.
 */
function labourRow(l, isAdmin) {
  return {
    id: `${l.laborHedSeq}-${l.laborDtlSeq}`,
    type: l.laborType === 'S' ? 'Setup' : l.laborType === 'P' ? 'Production' : l.laborType || '',
    date: l.clockInDate,
    clockIn: l.clockInTime,
    clockOut: l.clockOutTime,
    hours: l.laborHrs,
    qty: l.laborQty,
    scrap: l.scrapQty,
    scrapReason: l.scrapReason,
    status: l.timeStatus,
    active: !!l.activeTrans,
    long: Number(l.laborHrs) > 12,
    shift: isAdmin ? l.shift : null,
    employee: isAdmin ? `${l.employeeName || ''}${l.employeeNum ? ` (#${l.employeeNum})` : ''}`.trim() : null,
  };
}

export function buildJobView(db, jobNum, { isAdmin = false, config = null } = {}) {
  const inputs = loadJobInputs(db, jobNum);
  if (!inputs) return null;
  const result = evaluateJob(inputs, config ?? getEngineConfig(db));

  const laborByOp = new Map();
  for (const l of inputs.labor) {
    const k = key(l.assemblySeq, l.oprSeq);
    if (!laborByOp.has(k)) laborByOp.set(k, []);
    laborByOp.get(k).push(labourRow(l, isAdmin));
  }
  const watchByOp = new Map(result.watch.map((w) => [key(w.assemblySeq, w.oprSeq), w]));

  const opMeta = new Map(inputs.ops.map((o) => [key(o.assemblySeq, o.oprSeq), o]));
  const ops = result.ops.map((o) => {
    const k = key(o.assemblySeq, o.oprSeq);
    const labor = laborByOp.get(k) ?? [];
    return { ...o, labor, laborTotal: labor.reduce((t, l) => t + Number(l.hours || 0), 0), watch: watchByOp.get(k) ?? null, resourceDesc: opMeta.get(k)?.rgDescription ?? '' };
  });

  const seqs = [...new Set([...ops.map((o) => o.assemblySeq), ...result.materials.map((m) => m.assemblySeq)])].sort((a, b) => a - b);
  const assemblies = seqs.map((seq) => {
    const first = inputs.ops.find((o) => o.assemblySeq === seq);
    return {
      seq,
      part: first?.assemblyPart || (seq === 0 ? inputs.job.partNum : ''),
      desc: first?.assemblyDesc || (seq === 0 ? inputs.job.partDescription : ''),
      ops: ops.filter((o) => o.assemblySeq === seq),
      materials: result.materials.filter((m) => m.assemblySeq === seq),
    };
  });

  const chart = {
    labels: ops.filter((o) => !o.subcontract).map((o) => (seqs.length > 1 ? `${o.assemblySeq}.${o.oprSeq} ` : `${o.oprSeq} `) + o.opCode),
    est: ops.filter((o) => !o.subcontract).map((o) => o.est.total),
    act: ops.filter((o) => !o.subcontract).map((o) => o.act.total),
    counted: ops.filter((o) => !o.subcontract).map((o) => o.counts),
  };

  const dq = [];
  for (const o of ops) for (const d of o.dq) dq.push({ where: `Op ${o.oprSeq} ${o.opCode}`, code: d });
  for (const m of result.materials) for (const d of m.dq) dq.push({ where: `Material ${m.partNum}`, code: d });
  const jobDq = [];
  if (inputs.job.closed && ops.some((o) => o.countReason === 'skipped')) jobDq.push('Job is closed but has operations that were never completed.');
  const qNote = quantityNote(result);
  if (qNote) jobDq.push(qNote.text);
  const stillClocked = inputs.labor.filter((l) => l.activeTrans).length;
  if (stillClocked) jobDq.push(`${stillClocked} labour transaction(s) are still clocked in.`);
  const longTx = inputs.labor.filter((l) => Number(l.laborHrs) > 12).length;
  if (longTx) jobDq.push(`${longTx} labour transaction(s) are longer than 12 hours.`);

  const settings = getSettings(db);
  const tgt = targetFor(targetContext(db, settings), { name: inputs.job.custName, id: inputs.job.custId }); // this customer's tier target
  const economics = computeEconomics(result, inputs.revenue, { targetMarginPct: tgt.pct, tier: tgt.tier, baseCurrency: settings.baseCurrency, extra: loadExtraCosts(db, inputs.job.jobNum, { config: config ?? getEngineConfig(db) }) });

  return { job: inputs.job, result, ops, assemblies, chart, dq, jobDq, economics, multiLevel: seqs.length > 1, subcontractCount: ops.filter((o) => o.subcontract).length };
}
