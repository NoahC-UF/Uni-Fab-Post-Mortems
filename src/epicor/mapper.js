// Turns raw BAQ rows (Epicor column names) into app rows (camelCase fields), using
// the field map. Also reports missing / unexpected columns for the field check.

import { BAQ_MAP, columnFor } from './epicor_field_map.js';

export class FieldMapError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'FieldMapError';
    this.details = details;
  }
}

const ISO_DATE = /^(\d{4}-\d{2}-\d{2})/;

export function coerce(value, type) {
  if (value === undefined || value === null || value === '') {
    return type === 'bool' ? false : type === 'number' || type === 'int' ? 0 : null;
  }
  switch (type) {
    case 'string':
      return String(value).trim();
    case 'int': {
      const n = Math.trunc(Number(value));
      return Number.isFinite(n) ? n : 0;
    }
    case 'id': {
      // nullable identifier (order number, quote number): empty or 0 means "none"
      const n = Math.trunc(Number(value));
      return Number.isFinite(n) && n !== 0 ? n : null;
    }
    case 'number': {
      const n = Number(value);
      return Number.isFinite(n) ? n : 0;
    }
    case 'bool':
      if (typeof value === 'boolean') return value;
      if (typeof value === 'number') return value !== 0;
      return ['true', '1', 'yes', 'y', 't'].includes(String(value).trim().toLowerCase());
    case 'date': {
      if (value instanceof Date) return value.toISOString().slice(0, 10);
      const m = ISO_DATE.exec(String(value));
      if (m) return m[1] === '0001-01-01' || m[1] === '1900-01-01' ? null : m[1];
      return null;
    }
    case 'time': {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    default:
      return value;
  }
}

/** Compare the columns of one sample row with what the field map expects. */
export function checkColumns(baqKey, sampleRow) {
  const spec = BAQ_MAP[baqKey];
  const have = new Set(Object.keys(sampleRow ?? {}));
  const missing = { req: [], warn: [], optional: [] };
  for (const [col, [field, , level]] of Object.entries(spec.columns)) {
    if (!have.has(col)) missing[level === 'req' ? 'req' : level === 'warn' ? 'warn' : 'optional'].push({ column: col, field });
  }
  const known = new Set(Object.keys(spec.columns));
  const unexpected = [...have].filter((c) => !known.has(c) && !c.startsWith('RowIdent') && !c.startsWith('odata'));
  return { baq: spec.id, missing, unexpected, ok: missing.req.length === 0 };
}

/**
 * Map rows. Throws FieldMapError if a REQUIRED column is missing from the data
 * (so the sync stops with a clear message instead of loading garbage).
 */
export function mapRows(baqKey, rawRows) {
  const spec = BAQ_MAP[baqKey];
  if (!rawRows.length) return { rows: [], check: { baq: spec.id, missing: { req: [], warn: [], optional: [] }, unexpected: [], ok: true } };
  const check = checkColumns(baqKey, rawRows[0]);
  if (!check.ok) {
    const names = check.missing.req.map((m) => m.column).join(', ');
    throw new FieldMapError(
      `${spec.id} is missing required column(s): ${names}. Run the field check in Settings and fix src/epicor/epicor_field_map.js.`,
      check,
    );
  }
  const entries = Object.entries(spec.columns);
  const rows = rawRows.map((raw) => {
    const out = {};
    for (const [col, [field, type]] of entries) out[field] = coerce(raw[col], type);
    return out;
  });
  return { rows, check };
}

/** Build a raw BAQ-shaped row from app-field values (used by the mock data and tests). */
export function toRawRow(baqKey, obj) {
  const raw = {};
  for (const [col, [field, type]] of Object.entries(BAQ_MAP[baqKey].columns)) {
    if (!(field in obj)) continue;
    const v = obj[field];
    raw[col] = type === 'date' && typeof v === 'string' && v.length === 10 ? `${v}T00:00:00` : v;
  }
  return raw;
}

export { columnFor };
