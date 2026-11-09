// Small number helpers shared by the variance engine.
// Money is rounded to cents at every line so totals always add up exactly.

export function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Round to cents. Adds a tiny nudge so 1.005 rounds to 1.01 like a person expects. */
export function r2(v) {
  const n = num(v);
  return Math.round((n + Math.sign(n) * 1e-9) * 100) / 100;
}

export function r4(v) {
  return Math.round(num(v) * 10000) / 10000;
}

/** Round to 6 decimals: used before comparing percentages to thresholds, so
 *  floating point noise (0.0999999999) can never push a 10% variance into green. */
export function r6(v) {
  return Math.round(num(v) * 1e6) / 1e6;
}

/** a / b, or null when b is 0 (never divides by zero). */
export function ratio(a, b) {
  const d = num(b);
  if (d === 0) return null;
  return num(a) / d;
}

export function sum(list, pick = (x) => x) {
  return list.reduce((t, x) => t + num(pick(x)), 0);
}
