// Margin % colour bands (Settings > Margin % Colours).
//
// The colour depends on how far a margin is from ITS OWN target (the target margin of the customer's tier, see targets.js), in
// percentage points, so 25% is a different colour for a Tier A customer (target 45%) than for a Tier D one (target 20%).
// A short list of thresholds, each with a colour: "difference from target below -10 points = red". A margin takes the colour of the
// lowest threshold its difference is below; one above every threshold takes the optional "at or above" colour. No bands saved = the
// standard colouring (blue at or above the target, red below zero).
// The same list colours the Margin % column of the Customers pages and the Planned / Actual Margin columns of the job tables;
// public/job-columns.js repeats bandStyle() for the tables the browser builds, so keep the two the same.

import { UserError } from './errors.js';

export const MAX_BANDS = 8;
export const NO_BANDS = { bands: [], top: null };
const HEX = /^#[0-9a-f]{6}$/i;
const LOWEST = -100;
const HIGHEST = 100;

/** A list of strings from a form field that may arrive as one value or several. */
const many = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

const colourOf = (v) => (typeof v === 'string' && HEX.test(v.trim()) ? v.trim().toLowerCase() : null);

/** What is stored (or anything else) as a clean { bands: [{below, color}] sorted lowest first, top: colour | null }. below = points from target. */
export function normaliseBands(raw) {
  const bands = [];
  for (const b of Array.isArray(raw?.bands) ? raw.bands : []) {
    const below = Number(b?.below);
    const color = colourOf(b?.color);
    if (b?.below === '' || b?.below === null || !Number.isFinite(below) || !color) continue;
    bands.push({ below, color });
  }
  bands.sort((a, b) => a.below - b.below);
  return { bands: bands.slice(0, MAX_BANDS), top: colourOf(raw?.top) };
}

/**
 * The bands from the Settings form: fields bandBelow and bandColor (one pair per row, a row with no number is ignored)
 * and bandTopOn + bandTopColor for the "at or above" colour.
 */
export function parseMarginBands(body) {
  const below = many(body?.bandBelow);
  const colour = many(body?.bandColor);
  const bands = [];
  below.forEach((raw, i) => {
    if (String(raw ?? '').trim() === '') return;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < LOWEST || n > HIGHEST) throw new UserError(`"${raw}" is not a number of percentage points from target. Use a number from ${LOWEST} to ${HIGHEST}, such as -5 (5 points under target) or 0 (the target itself).`);
    const color = colourOf(colour[i]);
    if (!color) throw new UserError(`Choose a colour for the "below ${n} points" row.`);
    bands.push({ below: n, color });
  });
  if (bands.length > MAX_BANDS) throw new UserError(`Use at most ${MAX_BANDS} thresholds.`);
  bands.sort((a, b) => a.below - b.below);
  for (let i = 1; i < bands.length; i++) {
    if (bands[i].below === bands[i - 1].below) throw new UserError(`Two rows both say "below ${bands[i].below} points". Each threshold can be used once.`);
  }
  const topOn = body?.bandTopOn !== undefined && ['on', 'true', '1'].includes(String(body.bandTopOn));
  let top = null;
  if (topOn) {
    top = colourOf(body?.bandTopColor);
    if (!top) throw new UserError('Choose a colour for the "at or above the highest threshold" row, or untick it.');
  }
  return { bands, top };
}

/** Black or white text, whichever reads better on this background colour. */
export function textOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const lum = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return lum > 0.4 ? '#111111' : '#ffffff';
}

/**
 * How far a margin is from its target, in percentage points (+ above, - below), to one decimal place: the same rounding as the
 * figures on screen, so 14.96% against a 20% target is -5.0 points and counts as exactly 5 under.
 * margin and target are fractions (0.15 = 15%). null when either is missing.
 */
export function pointsFromTarget(margin, target) {
  if (margin === null || margin === undefined || target === null || target === undefined) return null;
  const m = Number(margin);
  const t = Number(target);
  if (!Number.isFinite(m) || !Number.isFinite(t)) return null;
  return Math.round((Math.round(m * 1000) / 10 - Math.round(t * 1000) / 10) * 10) / 10;
}

/** The colour a margin falls in for its target, or null (no bands, no margin or target, or above every threshold with no "at or above" colour). */
export function bandFor(cfg, margin, target) {
  const { bands, top } = cfg ?? NO_BANDS;
  if (!bands?.length) return null;
  const diff = pointsFromTarget(margin, target);
  if (diff === null) return null;
  const hit = bands.find((b) => diff < b.below);
  return hit ? hit.color : top || null;
}

/** The style attribute for a margin, or '' when no band applies. The colours are checked hex values, so this is safe in HTML. */
export function bandStyle(cfg, margin, target) {
  const c = bandFor(cfg, margin, target);
  return c ? `background:${c};color:${textOn(c)}` : '';
}

/** A readable list of the bands, e.g. for a legend: [{label: 'More than 10 points under target', color}, ...]. */
export function bandLegend(cfg) {
  const { bands, top } = cfg ?? NO_BANDS;
  if (!bands?.length) return [];
  const say = (n) => (n === 0 ? 'target' : n < 0 ? `${-n} points under target` : `${n} points over target`);
  const out = bands.map((b) => ({ label: `Below ${say(b.below)}`, color: b.color }));
  if (top) out.push({ label: `${say(bands[bands.length - 1].below)} or better`, color: top });
  return out;
}
