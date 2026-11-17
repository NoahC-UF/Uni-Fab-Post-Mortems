// A person's saved choice of table columns: which are shown, in what order, and how wide the ones they resized are.
// Stored per person (table user_prefs) as { visible: [fields], order: [every field, in display order], widths: { field: pixels } }.
// Older saves (just the shown fields, or without widths) still load.

import { UserError } from './errors.js';

const uniq = (list) => [...new Set(list)];
export const WIDTH = { min: 30, max: 1500 }; // pixels

/** Saved widths, checked: only real columns, whole numbers in a sensible range. */
function cleanWidths(raw, all) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const f of all) {
    const n = Math.round(Number(raw[f]));
    if (raw[f] !== undefined && Number.isFinite(n) && n >= WIDTH.min && n <= WIDTH.max) out[f] = n;
  }
  return out;
}

/**
 * Widths a person set on plain tables (the Job Study page), as { tableId: { "column title": pixels } }.
 * Keyed by the column's title, since these tables have no field names. Unknown tables, long titles and silly widths are dropped.
 */
export function cleanTableWidths(raw, tableIds) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const id of tableIds) {
    const t = raw[id];
    if (!t || typeof t !== 'object' || Array.isArray(t)) continue;
    const kept = {};
    let n = 0;
    for (const [label, px] of Object.entries(t)) {
      const w = Math.round(Number(px));
      if (n < 40 && label.length > 0 && label.length <= 80 && Number.isFinite(w) && w >= WIDTH.min && w <= WIDTH.max) {
        kept[label] = w;
        n++;
      }
    }
    if (n) out[id] = kept;
  }
  return out;
}

/** The body of a "Save column widths" request, checked. */
export function parseTableWidthsBody(body, tableIds) {
  const w = body?.widths;
  if (!w || typeof w !== 'object' || Array.isArray(w)) throw new UserError('Those column widths were not understood.');
  return cleanTableWidths(w, tableIds);
}

/** The saved choice as { visible, order }, or null (= the standard columns) if nothing usable is saved. */
export function normaliseColumnPref(raw, all) {
  const known = (f) => typeof f === 'string' && all.includes(f);
  let visible;
  let order;
  let widths = {};
  if (Array.isArray(raw)) {
    visible = raw;
    order = all; // older format: no order was saved
  } else if (raw && typeof raw === 'object' && Array.isArray(raw.visible)) {
    visible = raw.visible;
    order = Array.isArray(raw.order) ? raw.order : all;
    widths = cleanWidths(raw.widths, all);
  } else {
    return null;
  }
  visible = uniq(visible.filter(known));
  if (!visible.length) return null;
  return { visible, order: uniq([...order.filter(known), ...all]), widths }; // a column added later goes at the end
}

/** Checks the body of a "Save as my default" request. Returns what to store; throws a UserError if it is not usable. */
export function parseColumnPrefBody(body, all) {
  const cols = body?.columns;
  const known = (f) => typeof f === 'string' && all.includes(f);
  if (!Array.isArray(cols) || cols.length === 0 || cols.length > all.length || !cols.every(known)) {
    throw new UserError('Choose at least one column to show.');
  }
  if (body.order !== undefined && (!Array.isArray(body.order) || body.order.length > all.length || !body.order.every(known))) {
    throw new UserError('That column order was not understood.');
  }
  if (body.widths !== undefined && (!body.widths || typeof body.widths !== 'object' || Array.isArray(body.widths))) throw new UserError('Those column widths were not understood.');
  const norm = normaliseColumnPref({ visible: cols, order: body.order ?? all, widths: body.widths }, all);
  return { visible: norm.visible, order: norm.order, widths: norm.widths };
}
