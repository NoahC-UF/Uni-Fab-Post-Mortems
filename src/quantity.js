// Does the job's "quantity completed" agree with what its operations say?
//
// Epicor sets the job's quantity from the LAST operation. If someone books a different quantity on that
// operation (for example 70 on PACK when every other operation made 35), the job looks like it made 70.
// The app scales expected material to the job quantity, and scales an operation's expected hours to that
// operation's own quantity, so a wrong quantity shows up as a false under-run (or over-run). This finds
// the cases where the quantities disagree so people check the data before trusting the flags.

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const fmt = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
const differs = (a, b) => Math.abs(a - b) > Math.max(0.5, Math.abs(b) * 0.01);

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * @param {object} result  evaluateJob() output
 * @returns {null | {jobQty, orderedQty, typicalQty, oddOps: string[], materialScaled: boolean, text: string}}
 */
export function quantityNote(result) {
  if (result.jobState !== 'closed') return null; // only a closed job has a final quantity to question
  const jobQty = num(result.job.qtyCompleted);
  const orderedQty = num(result.job.prodQty);
  const ops = result.ops.filter((o) => !o.subcontract && num(o.qty.completed) > 0);
  const typicalQty = median(ops.map((o) => num(o.qty.completed)));
  if (!(jobQty > 0) || typicalQty === null || !differs(jobQty, typicalQty)) return null;

  const oddOps = ops.filter((o) => differs(num(o.qty.completed), typicalQty)).map((o) => `${o.opCode} (${fmt(num(o.qty.completed))})`);
  const materialScaled = result.materials.some((m) => m.normalized);
  const scaled = [];
  if (materialScaled) scaled.push(`expected material was scaled to ${fmt(jobQty)}`);
  if (oddOps.length) scaled.push("the expected hours of the different operations were scaled to their own quantity");
  const text =
    `The job says ${fmt(jobQty)} were made${orderedQty > 0 ? ` (${fmt(orderedQty)} ordered)` : ''}, but most operations completed ${fmt(typicalQty)}` +
    `${oddOps.length ? `; different: ${oddOps.join(', ')}` : ''}. ` +
    `${scaled.length ? `${scaled.join(' and ').replace(/^./, (c) => c.toUpperCase())}, so those variances may not be real. ` : ''}` +
    'Check which quantity is right in Epicor.';
  return { jobQty, orderedQty, typicalQty, oddOps, materialScaled, text };
}
