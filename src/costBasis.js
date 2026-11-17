// The labour and material cost of a job as the variance engine sees it: what the job was set up to cost, and what it has cost.
// Used for margins (economics.js) and to price the sub-assemblies a job consumes (extraCosts.js).

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Labour (hours x rates, with burden; subcontract operations have no hours and are left out) and material, planned and actual. */
export function costBasis(result) {
  const ops = result.ops.filter((o) => !o.subcontract);
  return {
    plannedLabour: r2(ops.reduce((t, o) => t + num(o.estDollars), 0)),
    actualLabour: r2(ops.reduce((t, o) => t + num(o.actDollars), 0)),
    plannedMaterial: r2(result.materials.reduce((t, m) => t + num(m.requiredQty) * num(m.estUnitCost), 0)),
    actualMaterial: r2(result.materials.reduce((t, m) => t + num(m.actDollars), 0)),
  };
}
