// Table appearance: an Admin can change each table's text size, column width and row / column / cell lines
// (Settings > Table Appearance). It is the same for everyone.
//
// Saved as { [tableId]: style } in the settings (key tableStyles). A style only holds what was changed:
//   { fontSize: 15, colWidth: 120,
//     rowLines:  { mode: 'on', size: 1, color: '#8899aa' },   // horizontal line between rows
//     colLines:  { mode: 'off' },                             // vertical line between columns
//     cellLines: { mode: 'on', size: 1 } }                    // a box around every cell
// mode 'on' shows the lines (size in pixels, colour optional = the theme's line colour), 'off' hides them,
// and a line that is not mentioned stays as it is today.
//
// The page gets one rule per changed table that sets CSS variables (--tbl-*), which public/app.css uses.
// A table says which one it is with data-table="<id>".

import { UserError } from './errors.js';

/** Every table the app shows. `group` and `label` are what the dropdown reads. */
export const TABLES = [
  { id: 'jobs-grid', group: 'Flagged Jobs', label: 'Job List' },
  { id: 'dashboard-top', group: 'Dashboard', label: 'Top 10 Biggest Misses' },
  { id: 'job-margin', group: 'Job Page', label: 'Price and Margin' },
  { id: 'job-price', group: 'Job Page', label: 'Sales Order Lines' },
  { id: 'job-ops', group: 'Job Page', label: 'Operations' },
  { id: 'job-labour', group: 'Job Page', label: 'Labour Entries (Under an Operation)' },
  { id: 'job-mtl', group: 'Job Page', label: 'Materials' },
  { id: 'job-watch', group: 'Job Page', label: 'Watchlist (Open Operations)' },
  { id: 'job-dq', group: 'Job Page', label: 'Data Quality' },
  { id: 'pm-list', group: 'Post-Mortems', label: 'Post-Mortem List' },
  { id: 'pm-ops', group: 'Post-Mortems', label: 'Post-Mortem: Labour' },
  { id: 'pm-mtl', group: 'Post-Mortems', label: 'Post-Mortem: Material' },
  { id: 'pm-actions', group: 'Post-Mortems', label: 'Post-Mortem: Actions' },
  { id: 'actions-list', group: 'Open Actions', label: 'Action List' },
  { id: 'acc-ops', group: 'Quote Accuracy', label: 'Operations Lists' },
  { id: 'acc-mtl', group: 'Quote Accuracy', label: 'Materials Lists' },
  { id: 'acc-unestimated', group: 'Quote Accuracy', label: 'Unestimated Work' },
  { id: 'acc-drill', group: 'Quote Accuracy', label: 'Drill-Down (Split, Parts, Jobs)' },
  { id: 'acc-customers', group: 'Quote Accuracy', label: 'Customer Lists' },
  { id: 'acc-cust-detail', group: 'Quote Accuracy', label: 'Customer Detail' },
  { id: 'study-summary', group: 'Job Study', label: 'Margin Summary' },
  { id: 'study-jobs', group: 'Job Study', label: 'Where to Look (Jobs)' },
  { id: 'study-ops', group: 'Job Study', label: 'By Operation' },
  { id: 'study-heatmap', group: 'Job Study', label: 'Heat Map' },
  { id: 'study-parts', group: 'Job Study', label: 'Repeat Parts' },
  { id: 'study-mtl', group: 'Job Study', label: 'Materials' },
  { id: 'report', group: 'Printable Report', label: 'Report Tables' },
  { id: 'settings', group: 'Settings', label: 'Settings Tables' },
];
export const TABLE_IDS = TABLES.map((t) => t.id);

export const FONT_SIZE = { min: 10, max: 24 }; // pixels
export const COL_WIDTH = { min: 40, max: 600 }; // pixels
export const LINE_SIZE = { min: 1, max: 6 }; // pixels
const LINES = [
  ['row', 'rowLines'],
  ['col', 'colLines'],
  ['cell', 'cellLines'],
];
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const whole = (v) => (typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,4}$/.test(v.trim()) ? Number(v) : NaN);

/** One saved style, checked: unknown or out-of-range values are dropped. Returns null if nothing is changed. */
export function cleanStyle(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  const fs = whole(raw.fontSize);
  if (Number.isInteger(fs) && fs >= FONT_SIZE.min && fs <= FONT_SIZE.max) out.fontSize = fs;
  const cw = whole(raw.colWidth);
  if (Number.isInteger(cw) && cw >= COL_WIDTH.min && cw <= COL_WIDTH.max) out.colWidth = cw;
  for (const [, key] of LINES) {
    const l = raw[key];
    if (!l || typeof l !== 'object') continue;
    if (l.mode === 'off') out[key] = { mode: 'off' };
    else if (l.mode === 'on') {
      const size = whole(l.size);
      out[key] = {
        mode: 'on',
        size: Number.isInteger(size) && size >= LINE_SIZE.min && size <= LINE_SIZE.max ? size : 1,
        color: typeof l.color === 'string' && COLOR_RE.test(l.color) ? l.color.toLowerCase() : null,
      };
    }
  }
  return Object.keys(out).length ? out : null;
}

/** All saved styles, checked: only real tables, only usable values. */
export function normaliseTableStyles(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const id of TABLE_IDS) {
    const s = cleanStyle(raw[id]);
    if (s) out[id] = s;
  }
  return out;
}

/** The Settings form for one table, checked. Returns { id, style } (style null = back to standard). Throws a UserError for a value that cannot be used. */
export function parseTableStyleForm(body) {
  const id = body?.table;
  if (!TABLE_IDS.includes(id)) throw new UserError('Choose a table.');
  const b = body ?? {};
  const style = {};
  const num = (value, label, { min, max }) => {
    const v = String(value ?? '').trim();
    if (v === '') return undefined;
    const n = whole(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new UserError(`${label} must be a whole number from ${min} to ${max}, or left blank.`);
    return n;
  };
  const fontSize = num(b.fontSize, 'Text size', FONT_SIZE);
  if (fontSize !== undefined) style.fontSize = fontSize;
  const colWidth = num(b.colWidth, 'Column width', COL_WIDTH);
  if (colWidth !== undefined) style.colWidth = colWidth;
  for (const [prefix, key] of LINES) {
    const mode = b[`${prefix}Mode`] ?? 'standard';
    if (!['standard', 'on', 'off'].includes(mode)) throw new UserError('Choose Standard, On or Off for each kind of line.');
    if (mode === 'off') style[key] = { mode: 'off' };
    if (mode === 'on') {
      const size = num(b[`${prefix}Size`], 'Line size', LINE_SIZE) ?? 1;
      const color = String(b[`${prefix}Color`] ?? '').trim();
      if (color !== '' && !COLOR_RE.test(color)) throw new UserError('Pick a colour from the colour box, or choose the theme colour.');
      style[key] = { mode: 'on', size, color: color === '' ? null : color.toLowerCase() };
    }
  }
  return { id, style: cleanStyle(style) };
}

/** The CSS for the saved styles: one rule per changed table, setting the --tbl-* variables that app.css reads. */
export function tableStyleCss(styles) {
  const rules = [];
  for (const [id, s] of Object.entries(normaliseTableStyles(styles))) {
    const v = [];
    if (s.fontSize) {
      v.push(`--tbl-font:${s.fontSize}px`);
      v.push(`--tbl-font-th:${Math.round(s.fontSize * 0.82 * 10) / 10}px`); // column titles are a little smaller, as they are today
      // what sits inside the cells follows the text size too (chips such as Post-Mortem status, tags, small buttons, flag dots)
      const r1 = (x) => Math.round(x * 10) / 10;
      v.push(`--tbl-chip-font:${r1(s.fontSize * 0.85)}px`, `--tbl-tag-font:${r1(s.fontSize * 0.8)}px`, `--tbl-btn-font:${r1(s.fontSize * 0.9)}px`, `--tbl-sub-font:${r1(s.fontSize * 0.9)}px`, `--tbl-dot:${Math.round(s.fontSize * 0.97)}px`);
    }
    if (s.colWidth) v.push(`--tbl-colw:${s.colWidth}px`);
    for (const [prefix, key] of LINES) {
      const l = s[key];
      if (!l) continue;
      v.push(`--tbl-${prefix}-w:${l.mode === 'off' ? 0 : l.size}px`);
      if (l.mode === 'on' && l.color) v.push(`--tbl-${prefix}-c:${l.color}`);
    }
    rules.push(`[data-table="${id}"]{${v.join(';')}}`);
  }
  return rules.join('\n');
}
