// Display formatting shared by the web pages and the Excel export.

const nf = (min, max) => new Intl.NumberFormat('en-CA', { minimumFractionDigits: min, maximumFractionDigits: max });
const f0 = nf(0, 0);
const f1 = nf(1, 1);
const f2 = nf(2, 2);
const fq = nf(0, 2);

const isNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

export function money(v) {
  if (!isNum(v)) return '';
  const n = Number(v);
  return `${n < 0 ? '-' : ''}$${f2.format(Math.abs(n))}`;
}

/** +$420.00 / -$180.00 */
export function smoney(v) {
  if (!isNum(v)) return '';
  const n = Number(v);
  if (n === 0) return '$0.00';
  return `${n > 0 ? '+' : '-'}$${f2.format(Math.abs(n))}`;
}

export function money0(v) {
  if (!isNum(v)) return '';
  const n = Number(v);
  return `${n < 0 ? '-' : ''}$${f0.format(Math.abs(n))}`;
}

export function hrs(v) {
  return isNum(v) ? f2.format(Number(v)) : '';
}

export function shrs(v) {
  if (!isNum(v)) return '';
  const n = Number(v);
  if (n === 0) return '0.00';
  return `${n > 0 ? '+' : '-'}${f2.format(Math.abs(n))}`;
}

/** fraction -> +12.3% (null = "n/a") */
export function spct(v) {
  if (!isNum(v)) return 'n/a';
  const n = Number(v) * 100;
  if (Math.abs(n) < 0.05) return '0.0%';
  return `${n > 0 ? '+' : '-'}${f1.format(Math.abs(n))}%`;
}

export function pct(v) {
  return isNum(v) ? `${f1.format(Number(v) * 100)}%` : '';
}

/** a number of percentage points -> +12.2 pts / -16.1 pts */
export function spts(v) {
  if (!isNum(v)) return 'n/a';
  const n = Number(v);
  if (Math.abs(n) < 0.05) return '0.0 pts';
  return `${n > 0 ? '+' : '-'}${f1.format(Math.abs(n))} pts`;
}

/** +$68,867 / -$68,867 (whole dollars) */
export function smoney0(v) {
  if (!isNum(v)) return '';
  const n = Number(v);
  if (n === 0) return '$0';
  return `${n > 0 ? '+' : '-'}$${f0.format(Math.abs(n))}`;
}

/** A short signed amount for small print: +$201k, -$2k, +$1.2M; under $1,000 it is the whole dollars (+$905). */
export function smoneyK(v) {
  if (!isNum(v)) return '';
  const n = Number(v);
  const abs = Math.abs(n);
  const sign = n > 0 ? '+' : '-';
  if (Math.round(abs) === 0) return '$0';
  if (abs >= 999500) return `${sign}$${(abs / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (abs >= 1000) return `${sign}$${Math.round(abs / 1000)}k`;
  return `${sign}$${Math.round(abs)}`;
}

export function qty(v) {
  return isNum(v) ? fq.format(Number(v)) : '';
}

export function dateOnly(v) {
  if (!v) return '';
  return String(v).slice(0, 10);
}

/** SQLite datetime('now') is UTC without a zone marker: show it as "YYYY-MM-DD HH:MM". */
export function dateTime(v) {
  if (!v) return '';
  return String(v).replace('T', ' ').slice(0, 16);
}

export function clockTime(decimalHours) {
  if (!isNum(decimalHours)) return '';
  const total = Math.round(Number(decimalHours) * 60);
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export const STATUS_LABELS = {
  flagged: 'Flagged',
  under_review: 'Under Review',
  root_cause_found: 'Root Cause Found',
  actions_assigned: 'Actions Assigned',
  closed: 'Closed',
  dismissed: 'Dismissed',
};

export const DQ_LABELS = {
  'complete-zero-hours': 'Marked complete with 0 actual hours',
  'hours-zero-qty': 'Hours reported but 0 quantity',
  'labor-mismatch': 'Labour transactions do not add up to the operation hours',
  'no-rate': 'No labour rate known for this resource group',
  'no-est-cost': 'No estimated unit cost on this material line',
  'no-transactions': 'No material transactions found (using JobMtl issued qty)',
  'qty-mismatch': 'Transactions disagree with JobMtl issued qty',
  'unknown-tran-type': 'Some transaction types were ignored (check the type list)',
  'negative-net': 'More material returned than issued',
};
