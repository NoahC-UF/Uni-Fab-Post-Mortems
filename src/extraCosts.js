// Costs that belong to a job's margin but are not labour or material issued from stock, so the variance engine does not see them.
// They only change MARGINS. Variances, flags and thresholds are untouched.
//
//   Sub-assemblies   Epicor books the cost of a sub-assembly job (for example 090824-4-1-601) into its parent as a WIP-MFG
//                    transaction. The parent's material line for it has no estimated cost, so without this the parent
//                    looks far cheaper than it was. Actual = the WIP-MFG cost. Planned = what the sub-assembly job was
//                    set up to cost (its own planned cost), or the actual when that job is not in the app.
//   Inspection       Purchased material that goes through receiving inspection reaches the job as INS-MTL, not
//                    STK-MTL / PUR-MTL. A line with no STK / PUR transactions is already counted at issued qty x estimated
//                    cost (the engine's fallback), so there the real INS-MTL cost REPLACES that guess; a line that also has
//                    STK / PUR transactions gets the INS-MTL cost added. (Planned cost of those lines is already counted.)
//   Subcontract      Outside services are received as PUR-SUB (straight to the job) or INS-SUB (through inspection). The
//                    app has no estimate for them, so they count as planned = actual and never show as an overrun.
//
// PUR-INS is not counted: it is the receipt INTO inspection, and the same money then arrives as INS-MTL / INS-SUB.

import { loadJobInputs } from './staging.js';
import { evaluateJob } from './engine/job.js';
import { getEngineConfig } from './settings.js';
import { costBasis } from './costBasis.js';

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const MAX_DEPTH = 3;

export const NO_EXTRA = Object.freeze({ subAssembly: { planned: 0, actual: 0, items: [] }, inspection: { actual: 0, lines: [] }, subcontract: { actual: 0 } });

const COST = 'COALESCE(ext_cost, tran_qty * (COALESCE(mtl_unit_cost,0) + COALESCE(lbr_unit_cost,0) + COALESCE(bur_unit_cost,0) + COALESCE(sub_unit_cost,0) + COALESCE(mtl_bur_unit_cost,0)))';

/** What a sub-assembly job was set up to cost, including anything it consumed itself. */
function plannedCostOfJob(db, jobNum, config, depth) {
  const inputs = loadJobInputs(db, jobNum);
  if (!inputs) return null;
  const b = costBasis(evaluateJob(inputs, config));
  const x = loadExtraCosts(db, jobNum, { config, depth: depth + 1 });
  return b.plannedLabour + b.plannedMaterial + x.subAssembly.planned + x.subcontract.actual;
}

export function loadExtraCosts(db, jobNum, { config = getEngineConfig(db), depth = 0 } = {}) {
  const rows = db
    .prepare(`SELECT tran_type, COALESCE(part_num, '') AS part_num, assembly_seq, mtl_seq, SUM(${COST}) AS cost FROM material_transactions
              WHERE job_num = ? AND tran_type IN ('WIP-MFG', 'INS-MTL', 'INS-SUB', 'PUR-SUB') GROUP BY tran_type, part_num, assembly_seq, mtl_seq`)
    .all(jobNum);
  if (!rows.length) return NO_EXTRA;

  let inspection = 0;
  const inspectionLines = [];
  let subcontract = 0;
  const items = [];
  for (const r of rows) {
    const cost = Number(r.cost) || 0;
    if (r.tran_type === 'INS-MTL') {
      inspection += cost;
      inspectionLines.push({ assemblySeq: r.assembly_seq, mtlSeq: r.mtl_seq, cost: r2(cost) });
    }
    else if (r.tran_type === 'WIP-MFG') {
      // the sub-assembly job is the job whose number starts with this job's number and whose part is the one received
      const child = r.part_num
        ? db.prepare('SELECT job_num FROM jobs WHERE part_num = ? AND substr(job_num, 1, ?) = ? ORDER BY job_num LIMIT 1').get(r.part_num, jobNum.length + 1, `${jobNum}-`)
        : null;
      const planned = child && depth < MAX_DEPTH ? plannedCostOfJob(db, child.job_num, config, depth) : null;
      items.push({ part: r.part_num, job: child?.job_num ?? null, planned: r2(planned ?? cost), actual: r2(cost) });
    } else subcontract += cost;
  }
  return {
    subAssembly: { planned: r2(items.reduce((t, i) => t + i.planned, 0)), actual: r2(items.reduce((t, i) => t + i.actual, 0)), items: items.sort((a, b) => b.actual - a.actual) },
    inspection: { actual: r2(inspection), lines: inspectionLines },
    subcontract: { actual: r2(subcontract) },
  };
}
