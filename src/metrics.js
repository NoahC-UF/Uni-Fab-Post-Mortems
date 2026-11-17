// Runs the variance engine over staged jobs and stores the summary rows that the
// dashboard and the Flagged Jobs list read (job_metrics, flag_lines).

import { tx } from './db.js';
import { evaluateJob, flagLineRows, lineResultRows } from './engine/job.js';
import { getEngineConfig } from './settings.js';
import { loadJobInputs } from './staging.js';
import { loadEconomics, verdict } from './economics.js';
import { targetContext, targetForJob } from './targets.js';

// Bump this when recomputeJobs starts storing something new: the app then recomputes every job once at start-up.
export const METRICS_VERSION = 5; // 5: each job keeps the target margin of its customer's tier. 3: every line's result is kept (line_results) for the Quote Accuracy pages. 4: margin cost includes sub-assemblies, inspection material and subcontract

/** Re-check every job once after an update that adds stored numbers (for example margins). Returns how many were done. */
export function ensureMetricsCurrent(db, now = new Date()) {
  const row = db.prepare("SELECT value FROM settings WHERE key = '_metrics_version'").get();
  if (row && Number(JSON.parse(row.value)) >= METRICS_VERSION) return 0;
  const n = recomputeJobs(db, null, now);
  db.prepare("INSERT INTO settings (key, value) VALUES ('_metrics_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(METRICS_VERSION));
  return n;
}

export function evaluateStoredJob(db, jobNum, config = getEngineConfig(db)) {
  const inputs = loadJobInputs(db, jobNum);
  if (!inputs) return null;
  return evaluateJob(inputs, config);
}

/** Recompute the given jobs (or every job when jobNums is null). Returns how many were done. */
export function recomputeJobs(db, jobNums = null, now = new Date()) {
  const config = getEngineConfig(db);
  const list = jobNums ?? db.prepare('SELECT job_num FROM jobs').all().map((r) => r.job_num);
  const stamp = now.toISOString();
  const delMetrics = db.prepare('DELETE FROM job_metrics WHERE job_num = ?');
  const delLines = db.prepare('DELETE FROM flag_lines WHERE job_num = ?');
  const delResults = db.prepare('DELETE FROM line_results WHERE job_num = ?');
  const insResult = db.prepare(`INSERT INTO line_results
    (job_num, kind, assembly_seq, seq, counted, activity_date, op_code, resource_grp_id, part_num, description, class_id, unplanned, flag,
     exp_hours, act_hours, exp_setup, act_setup, exp_run, act_run, var_hours, exp_qty, act_qty, est_dollars, act_dollars, var_dollars, usage_var, price_var, var_pct)
    VALUES (@jobNum, @kind, @assemblySeq, @seq, @counted, @activityDate, @opCode, @resourceGrpId, @partNum, @description, @classId, @unplanned, @flag,
            @expHours, @actHours, @expSetup, @actSetup, @expRun, @actRun, @varHours, @expQty, @actQty, @estDollars, @actDollars, @varDollars, @usageVar, @priceVar, @varPct)`);
  // when a job's numbers last moved: its close date, or for an open job the latest labour or material entry
  const lastActivity = db.prepare(`SELECT MAX(d) AS d FROM (
    SELECT MAX(clock_in_date) AS d FROM labor_details WHERE job_num = ?1
    UNION ALL SELECT MAX(tran_date) FROM material_transactions WHERE job_num = ?1
    UNION ALL SELECT start_date FROM jobs WHERE job_num = ?1)`);
  const insMetrics = db.prepare(`INSERT INTO job_metrics
    (job_num, job_state, flag, flagged_lines, red_lines, yellow_lines, impact_dollars, over_dollars, under_dollars,
     net_dollars, labour_var_dollars, material_var_dollars, fingerprint, computed_at,
     price, planned_cost, actual_cost, planned_margin, actual_margin, planned_margin_pct, actual_margin_pct, cause, target_margin)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const tctx = targetContext(db); // the customer list and settings, read once for every job
  const insLine = db.prepare(`INSERT INTO flag_lines
    (job_num, kind, assembly_seq, seq, op_code, resource_grp_id, part_num, flag, direction, unplanned, var_hours, var_pct, var_dollars)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  tx(db, () => {
    for (const jobNum of list) {
      delMetrics.run(jobNum);
      delLines.run(jobNum);
      delResults.run(jobNum);
      const result = evaluateStoredJob(db, jobNum, config);
      if (!result) continue;
      const t = result.totals;
      const e = loadEconomics(db, jobNum, result, tctx);
      insMetrics.run(
        jobNum, result.jobState, result.flag, result.flaggedLines, result.redLines, result.yellowLines,
        t.impactDollars, t.overDollars, t.underDollars, t.netDollars, t.labour.varDollars, t.material.varDollars,
        result.fingerprint, stamp,
        e.price, e.cost.planned, e.cost.actual, e.margin.planned, e.margin.actual, e.margin.plannedPct, e.margin.actualPct, e.verdict.code, e.target,
      );
      const activityDate = result.job.closed && result.job.closedDate ? result.job.closedDate : (lastActivity.get(jobNum)?.d ?? null);
      for (const l of lineResultRows(result)) insResult.run({ jobNum, activityDate, ...l });
      for (const l of flagLineRows(result)) {
        insLine.run(
          jobNum, l.kind, l.assemblySeq, l.seq, l.opCode, l.resourceGrpId, l.partNum, l.flag, l.direction,
          l.unplanned ? 1 : 0, l.varHours, l.varPct, l.varDollars,
        );
      }
    }
  });
  return list.length;
}

/**
 * Re-applies the tier targets to every job's stored margin result, without re-running the variance engine: the target and the
 * likely cause (price / set-up, overrun, on target) depend only on numbers already stored plus the customer's tier. Used when
 * the customer list is imported. Returns how many jobs changed.
 */
export function refreshTargets(db) {
  const ctx = targetContext(db);
  const rows = db
    .prepare('SELECT job_num, job_state, price, planned_cost, actual_cost, planned_margin_pct, actual_margin_pct, cause, target_margin FROM job_metrics')
    .all();
  const upd = db.prepare('UPDATE job_metrics SET target_margin = ?, cause = ? WHERE job_num = ?');
  let changed = 0;
  tx(db, () => {
    for (const r of rows) {
      const target = targetForJob(db, r.job_num, ctx).target;
      const hasPrice = r.price !== null && r.price > 0;
      const cause = verdict({
        hasPrice,
        closed: r.job_state === 'closed',
        plannedCost: r.planned_cost ?? 0,
        plannedMarginPct: r.planned_margin_pct,
        actualMarginPct: r.actual_margin_pct,
        target,
        overrun: (r.actual_cost ?? 0) - (r.planned_cost ?? 0),
      }).code;
      if (target !== r.target_margin || cause !== r.cause) {
        upd.run(target, cause, r.job_num);
        changed++;
      }
    }
  });
  return changed;
}
