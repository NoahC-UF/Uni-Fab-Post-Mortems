// Pulls the five BAQs into the local staging tables, then recomputes variance.
// Every run is written to sync_log (start, end, rows, errors).

import { tx } from '../db.js';
import { SYNC_ORDER, BAQ_MAP } from '../epicor/epicor_field_map.js';
import { mapRows } from '../epicor/mapper.js';
import { replaceJobData } from '../staging.js';
import { recomputeJobs } from '../metrics.js';
import { getSettings } from '../settings.js';
import { maskSecrets } from '../mask.js';

const isoDate = (d) => d.toISOString().slice(0, 10);

function monthsAgo(now, months) {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d;
}

/** Date to pass as the BAQs' FromDate. */
export function chooseFromDate(db, kind, now, windowMonths, override = null) {
  if (override) return override;
  const windowStart = isoDate(monthsAgo(now, windowMonths));
  if (kind === 'full') return windowStart;
  const last = db.prepare("SELECT started_at FROM sync_log WHERE status = 'ok' ORDER BY id DESC LIMIT 1").get();
  if (!last) return windowStart;
  // overlap by 3 days so a job closed just before the last sync is never missed
  const from = isoDate(new Date(new Date(last.started_at).getTime() - 3 * 86400000));
  return from > windowStart ? from : windowStart;
}

function dedupe(rows, keyFn) {
  const seen = new Map();
  let dropped = 0;
  for (const r of rows) {
    const k = keyFn(r);
    if (seen.has(k)) {
      dropped++;
      continue;
    }
    seen.set(k, r);
  }
  return { rows: [...seen.values()], dropped };
}

export function isSyncRunning(db) {
  return !!db.prepare("SELECT 1 FROM sync_log WHERE status = 'running' AND started_at > datetime('now', '-30 minutes')").get();
}

/**
 * @param {{db, source, kind?: 'incremental'|'full', now?: Date, startedBy?: string, fromDate?: string, secrets?: string[], logger?}} o
 */
export async function runSync({ db, source, kind = 'incremental', now = new Date(), startedBy = null, fromDate = null, secrets = [], logger = console }) {
  const settings = getSettings(db);
  const from = chooseFromDate(db, kind, now, settings.syncWindowMonths, fromDate);
  const logId = Number(
    db
      .prepare('INSERT INTO sync_log (kind, source, started_at, status, started_by) VALUES (?, ?, ?, ?, ?)')
      .run(kind, source.name, now.toISOString(), 'running', startedBy).lastInsertRowid,
  );
  const finish = (status, rows, error = null) =>
    db
      .prepare('UPDATE sync_log SET ended_at = ?, status = ?, rows_json = ?, error = ? WHERE id = ?')
      .run(new Date().toISOString(), status, JSON.stringify(rows), error, logId);

  try {
    // ---- fetch + map (nothing is written until everything has been read successfully)
    const mapped = {};
    const fetched = {};
    const warnings = [];
    for (const key of SYNC_ORDER) {
      const raw = await source.fetchBaq(key, { fromDate: from });
      fetched[key] = raw.length;
      const { rows, check } = mapRows(key, raw);
      mapped[key] = rows;
      if (check.missing.warn.length) {
        warnings.push(`${BAQ_MAP[key].id}: missing columns ${check.missing.warn.map((m) => m.column).join(', ')}`);
      }
    }

    // ---- tidy: one row per job / op / labour row / material line
    const header = dedupe(
      mapped.jobHeader.slice().sort((a, b) => (a.orderNum ?? 1e12) - (b.orderNum ?? 1e12) || (a.orderLine ?? 0) - (b.orderLine ?? 0)),
      (r) => r.jobNum,
    );
    const jobSet = new Set(header.rows.map((j) => j.jobNum));
    const inScope = (r) => jobSet.has(r.jobNum);
    const ops = dedupe(
      mapped.jobOperations.filter(inScope).sort((a, b) => (a.opDtlSeq ?? 0) - (b.opDtlSeq ?? 0)),
      (r) => `${r.jobNum}|${r.assemblySeq}|${r.oprSeq}`,
    );
    const labor = dedupe(mapped.laborDetail.filter(inScope), (r) => `${r.laborHedSeq}|${r.laborDtlSeq}`);
    const mtls = dedupe(mapped.jobMaterials.filter(inScope), (r) => `${r.jobNum}|${r.assemblySeq}|${r.mtlSeq}`);
    const trans = dedupe(mapped.materialTransactions.filter(inScope), (r) => String(r.tranNum));

    const orphans = mapped.jobOperations.length + mapped.laborDetail.length + mapped.jobMaterials.length + mapped.materialTransactions.length
      - ops.rows.length - ops.dropped - labor.rows.length - labor.dropped - mtls.rows.length - mtls.dropped - trans.rows.length - trans.dropped;
    if (orphans > 0) warnings.push(`${orphans} detail row(s) belonged to jobs not in the header BAQ and were skipped`);
    if (header.dropped) warnings.push(`${header.dropped} job header row(s) merged (jobs linked to several order lines)`);
    if (ops.dropped) warnings.push(`${ops.dropped} duplicate operation row(s) merged (an op with more than one resource?)`);

    // ---- write
    const syncedAt = new Date().toISOString();
    const counts = tx(db, () => replaceJobData(db, { jobs: header.rows, ops: ops.rows, labor: labor.rows, mtls: mtls.rows, trans: trans.rows }, syncedAt));
    const recomputed = recomputeJobs(db, header.rows.map((j) => j.jobNum), new Date());

    const summary = { fromDate: from, fetched, stored: counts, recomputed, warnings };
    finish('ok', summary);
    logger.info?.(`Sync ${kind} (${source.name}) ok: ${counts.jobs} jobs, ${counts.operations} ops, ${counts.labor} labour rows`);
    return { ok: true, id: logId, ...summary };
  } catch (err) {
    const message = maskSecrets(err.message, secrets);
    finish('error', {}, message);
    logger.error?.(`Sync ${kind} (${source.name}) failed: ${message}`);
    return { ok: false, id: logId, error: message, details: err.details ?? null };
  }
}

export function lastSync(db) {
  const row = db.prepare('SELECT * FROM sync_log ORDER BY id DESC LIMIT 1').get();
  if (!row) return null;
  return { ...row, rows: row.rows_json ? JSON.parse(row.rows_json) : null };
}
