// Customer tier levels and account managers: read from the "Customer Organization" spreadsheet, kept in the
// customer_org table, looked up by customer name, and exported again in the same layout so the file can be
// edited and imported back.
//
//   Name | Level | Account Management
//   AVL Manufacturing | A | Mike Kraynack, Nick Iossifidis
//
// Customers are matched to Epicor by NAME (the spreadsheet has no customer ID), ignoring capitals, extra spaces and
// curly quotes. "XXXXX" in the spreadsheet means "no account manager yet" and is stored as empty.

import ExcelJS from 'exceljs';
import { UserError } from './errors.js';

export const UNASSIGNED_MARK = 'XXXXX';
const MAX_ROWS = 20000;

/** The name used to match customers: lower case, curly quotes straightened, runs of spaces collapsed. */
export function nameKey(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const tidyTier = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().toUpperCase().slice(0, 12);

/** "Mike Kraynack ,  Nick Iossifidis;Noah" -> "Mike Kraynack, Nick Iossifidis, Noah". XXXXX / blank -> "". */
export function tidyManagers(v) {
  const seen = new Set();
  const out = [];
  for (const part of String(v ?? '').split(/[,;\n/]+/)) {
    const p = part.replace(/\s+/g, ' ').trim();
    if (!p || p.toUpperCase() === UNASSIGNED_MARK || seen.has(p.toLowerCase())) continue;
    seen.add(p.toLowerCase());
    out.push(p);
  }
  return out.join(', ').slice(0, 300);
}

// ------------------------------------------------------------------------------------ reading a file

const HEADERS = {
  name: ['name', 'customer', 'customer name'],
  tier: ['level', 'tier', 'tier level'],
  managers: ['account management', 'account manager', 'account managers', 'account manager(s)', 'managers'],
};

/** Finds the header row (the first 10 rows are searched) and the column of each field: the leftmost match wins. */
function findColumns(rows) {
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const cols = {};
    rows[r].forEach((cell, c) => {
      const h = String(cell ?? '').trim().toLowerCase();
      for (const [field, names] of Object.entries(HEADERS)) if (cols[field] === undefined && names.includes(h)) cols[field] = c;
    });
    if (cols.name !== undefined && cols.tier !== undefined) return { row: r, cols };
  }
  return null;
}

/** Quick CSV reader: quotes, doubled quotes, commas and line breaks inside quotes. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      rows.push(row); row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const cellText = (c) => {
  if (c === null || c === undefined) return '';
  if (typeof c === 'object') return String(c.text ?? c.result ?? (c.richText ? c.richText.map((x) => x.text).join('') : '') ?? '');
  return String(c);
};

/** Rows of text from an .xlsx (the first sheet that has Name and Level headings) or a .csv. */
async function readRows(buffer, filename) {
  if (/\.csv$/i.test(filename)) return parseCsv(buffer.toString('utf8'));
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    throw new UserError('That file could not be read. Choose an Excel (.xlsx) or CSV (.csv) file.');
  }
  for (const ws of wb.worksheets) {
    const rows = [];
    ws.eachRow({ includeEmpty: true }, (row, n) => {
      if (n > MAX_ROWS) return;
      const vals = [];
      for (let c = 1; c <= Math.max(row.cellCount, 1); c++) vals.push(cellText(row.getCell(c).value));
      rows.push(vals);
    });
    if (findColumns(rows)) return rows;
  }
  throw new UserError('No sheet in that file has "Name" and "Level" column headings. Export the current list from Settings to see the layout.');
}

/**
 * Reads the customers out of an uploaded file.
 * @returns {{entries: {name: string, tier: string, managers: string}[], skipped: number, duplicates: number}}
 */
export async function parseCustomerFile(buffer, filename = '') {
  const rows = await readRows(buffer, filename);
  const found = findColumns(rows);
  if (!found) throw new UserError('That file has no "Name" and "Level" column headings. Export the current list from Settings to see the layout.');
  const { row: headerRow, cols } = found;
  const byKey = new Map();
  let skipped = 0;
  let duplicates = 0;
  for (const r of rows.slice(headerRow + 1)) {
    const name = String(r[cols.name] ?? '').replace(/\s+/g, ' ').trim();
    if (!name) {
      if (r.some((x) => String(x ?? '').trim())) skipped++;
      continue;
    }
    const key = nameKey(name);
    if (byKey.has(key)) duplicates++;
    byKey.set(key, { name, tier: tidyTier(r[cols.tier]), managers: tidyManagers(cols.managers === undefined ? '' : r[cols.managers]) });
  }
  if (!byKey.size) throw new UserError('The file has the right headings but no customers under them.');
  if (byKey.size > MAX_ROWS) throw new UserError(`That file has more than ${MAX_ROWS} customers.`);
  return { entries: [...byKey.values()], skipped, duplicates };
}

// ------------------------------------------------------------------------------------ the table

/**
 * Saves the customers.
 * mode 'replace': the file is the whole list (customers not in it are removed).
 * mode 'update':  customers in the file are added or changed; the rest are left alone.
 */
export function applyCustomers(db, entries, mode, nowIso) {
  const before = new Map(db.prepare('SELECT name_key, tier, managers FROM customer_org').all().map((r) => [r.name_key, r]));
  const incoming = new Set(entries.map((e) => nameKey(e.name)));
  const res = { added: 0, changed: 0, unchanged: 0, removed: 0 };
  db.exec('BEGIN');
  try {
    if (mode === 'replace') {
      const del = db.prepare('DELETE FROM customer_org WHERE name_key = ?');
      for (const k of before.keys()) if (!incoming.has(k)) { del.run(k); res.removed++; }
    }
    const up = db.prepare(
      `INSERT INTO customer_org (name_key, name, tier, managers, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(name_key) DO UPDATE SET name = excluded.name, tier = excluded.tier, managers = excluded.managers, updated_at = excluded.updated_at`,
    );
    for (const e of entries) {
      const k = nameKey(e.name);
      const old = before.get(k);
      if (!old) res.added++;
      else if (old.tier !== e.tier || old.managers !== e.managers) res.changed++;
      else { res.unchanged++; continue; }
      up.run(k, e.name, e.tier, e.managers, nowIso);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return res;
}

/** name_key -> { name, tier, managers } for every customer on the list. */
export function loadCustomerOrg(db) {
  return new Map(db.prepare('SELECT name_key, name, tier, managers FROM customer_org').all().map((r) => [r.name_key, { name: r.name, tier: r.tier, managers: r.managers }]));
}

/** What to show next to a customer: { listed, tier, managers }. Matched on the customer's name, then on its ID. */
export function orgFor(org, { label, key } = {}) {
  const hit = org.get(nameKey(label)) ?? org.get(nameKey(key));
  return hit ? { listed: true, tier: hit.tier, managers: hit.managers } : { listed: false, tier: '', managers: '' };
}

/** What the Tier and Account Manager filters offer: the tiers and managers that are on the list. */
export function orgFilterOptions(db) {
  const tiers = new Set();
  const managers = new Set();
  for (const o of loadCustomerOrg(db).values()) {
    if (o.tier) tiers.add(o.tier);
    for (const m of o.managers.split(',').map((x) => x.trim()).filter(Boolean)) managers.add(m);
  }
  const rank = (t) => (t === 'NEW' ? 'ZZZ' : t); // A, B, C, D, then NEW
  const sorted = [...tiers].sort((a, b) => rank(a).localeCompare(rank(b)));
  return {
    tiers: sorted,
    // the tick boxes of the Tier filter: each tier on the list, then the customers that are not on it
    tierChoices: [...sorted.map((t) => ({ v: t, label: t === 'NEW' ? 'New' : `Tier ${t}` })), { v: NOT_LISTED, label: 'Not on the List' }],
    managers: [...managers].sort((a, b) => a.localeCompare(b)),
  };
}

/** Special values of the filters. */
export const NOT_LISTED = '_none'; // customers that are not on the list
export const UNASSIGNED = '_unassigned'; // on the list, with no account manager

/** Does a customer's list entry pass the tier and account manager filters? ('' = no filter) */
export function passesOrgFilter(entry, { tier = '', mgr = '' }) {
  const listed = Boolean(entry?.listed);
  if (tier) {
    // tier is one tier or a comma-separated list of them (A,B): the customer passes when it is in any of them
    const wanted = String(tier).split(',').map((x) => x.trim()).filter(Boolean);
    const ok = wanted.some((t) => (t === NOT_LISTED ? !listed : listed && entry.tier === t));
    if (!ok) return false;
  }
  if (mgr) {
    if (mgr === NOT_LISTED) { if (listed) return false; } else if (mgr === UNASSIGNED) { if (!listed || entry.managers) return false; } else if (!listed || !entry.managers.split(',').some((m) => m.trim().toLowerCase() === mgr.toLowerCase())) return false;
  }
  return true;
}

/** The ids of the customers (in the job data) that pass the filters, or null when no filter is set. */
export function customerIdsFor(db, filter) {
  if (!filter.tier && !filter.mgr) return null;
  const org = loadCustomerOrg(db);
  return jobCustomers(db)
    .filter((c) => passesOrgFilter(orgFor(org, { label: c.name, key: c.id }), filter))
    .map((c) => c.id);
}

/** The customers in the job data, each with whether it is on the list. */
function jobCustomers(db) {
  return db
    .prepare("SELECT cust_id, MAX(cust_name) AS cust_name, COUNT(*) AS jobs FROM jobs WHERE COALESCE(cust_id, '') <> '' GROUP BY cust_id ORDER BY MAX(cust_name)")
    .all()
    .map((r) => ({ id: r.cust_id, name: r.cust_name || r.cust_id, jobs: r.jobs }));
}

/** The numbers for the Settings section. */
export function orgSummary(db) {
  const org = loadCustomerOrg(db);
  const tiers = new Map();
  let unassigned = 0;
  for (const o of org.values()) {
    tiers.set(o.tier || '(none)', (tiers.get(o.tier || '(none)') ?? 0) + 1);
    if (!o.managers) unassigned++;
  }
  const customers = jobCustomers(db);
  const notListed = customers.filter((c) => !orgFor(org, { label: c.name, key: c.id }).listed);
  const updated = db.prepare('SELECT MAX(updated_at) AS t FROM customer_org').get().t;
  return {
    count: org.size,
    tiers: [...tiers.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([tier, n]) => ({ tier, n })),
    unassigned,
    updated,
    jobCustomers: customers.length,
    matched: customers.length - notListed.length,
    notListed: notListed.slice(0, 60),
    notListedCount: notListed.length,
  };
}

// ------------------------------------------------------------------------------------ exporting

const HEADER_ROW = ['Name', 'Level', 'Account Management'];

function listRows(db) {
  return [...loadCustomerOrg(db).values()].sort((a, b) => a.tier.localeCompare(b.tier) || a.name.localeCompare(b.name)).map((o) => [o.name, o.tier, o.managers]);
}

/** An .xlsx in the same layout as the original file, plus a second sheet of the customers in the job data that are not on the list yet. */
export async function exportWorkbook(db) {
  const wb = new ExcelJS.Workbook();
  const head = (ws) => {
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF14395B' } };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  };
  const ws = wb.addWorksheet('Customer Organization');
  ws.columns = [{ header: HEADER_ROW[0], width: 46 }, { header: HEADER_ROW[1], width: 10 }, { header: HEADER_ROW[2], width: 38 }];
  for (const r of listRows(db)) ws.addRow(r);
  head(ws);
  ws.autoFilter = { from: 'A1', to: `C${Math.max(2, ws.rowCount)}` };

  const org = loadCustomerOrg(db);
  const missing = jobCustomers(db).filter((c) => !orgFor(org, { label: c.name, key: c.id }).listed);
  const ms = wb.addWorksheet('Not Yet Listed');
  ms.columns = [{ header: 'Name', width: 46 }, { header: 'Level', width: 10 }, { header: 'Account Management', width: 38 }, { header: 'Jobs in the app', width: 16 }];
  for (const c of missing) ms.addRow([c.name, '', '', c.jobs]);
  head(ms);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const csvCell = (v) => (/[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

export function exportCsv(db) {
  return [HEADER_ROW, ...listRows(db)].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
