// Runs the variance engine over staged jobs and stores the summary rows that the
// dashboard and the Flagged Jobs list read (job_metrics, flag_lines).

import { tx } from './db.js';
import { evaluateJob, flagLineRows } from './engine/job.js';
import { getEngineConfig } from './settings.js';
import { loadJobInputs } from './staging.js';

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
  const insMetrics = db.prepare(`INSERT INTO job_metrics
    (job_num, job_state, flag, flagged_lines, red_lines, yellow_lines, impact_dollars, over_dollars, under_dollars,
     net_dollars, labour_var_dollars, material_var_dollars, fingerprint, computed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insLine = db.prepare(`INSERT INTO flag_lines
    (job_num, kind, assembly_seq, seq, op_code, resource_grp_id, part_num, flag, direction, unplanned, var_hours, var_pct, var_dollars)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  tx(db, () => {
    for (const jobNum of list) {
      delMetrics.run(jobNum);
      delLines.run(jobNum);
      const result = evaluateStoredJob(db, jobNum, config);
      if (!result) continue;
      const t = result.totals;
      insMetrics.run(
        jobNum, result.jobState, result.flag, result.flaggedLines, result.redLines, result.yellowLines,
        t.impactDollars, t.overDollars, t.underDollars, t.netDollars, t.labour.varDollars, t.material.varDollars,
        result.fingerprint, stamp,
      );
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
