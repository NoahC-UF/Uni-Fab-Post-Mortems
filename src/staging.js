// Reads and writes the local staging tables (a copy of what Epicor returned).

const colCache = new Map();

export const camelToSnake = (s) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
export const snakeToCamel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

export function camelRow(row) {
  if (!row) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) out[snakeToCamel(k)] = v;
  return out;
}

function tableColumns(db, table) {
  if (!colCache.has(table)) {
    colCache.set(table, db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  }
  return colCache.get(table);
}

const toSql = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

/** INSERT OR REPLACE camelCase objects into a table; fields without a column are ignored. */
export function insertRows(db, table, rows, extra = {}) {
  if (!rows.length) return 0;
  const cols = tableColumns(db, table);
  const used = cols.filter((c) => snakeToCamel(c) in rows[0] || c in extra);
  const stmt = db.prepare(`INSERT OR REPLACE INTO ${table} (${used.join(', ')}) VALUES (${used.map(() => '?').join(', ')})`);
  for (const row of rows) {
    stmt.run(...used.map((c) => toSql(c in extra ? extra[c] : row[snakeToCamel(c)])));
  }
  return rows.length;
}

/** Replace everything we hold for the given jobs (children first, then the job rows). */
export function replaceJobData(db, { jobs, ops, labor, mtls, trans, revenue = null }, syncedAt) {
  const jobNums = jobs.map((j) => j.jobNum);
  const del = {
    ops: db.prepare('DELETE FROM job_operations WHERE job_num = ?'),
    labor: db.prepare('DELETE FROM labor_details WHERE job_num = ?'),
    mtls: db.prepare('DELETE FROM job_materials WHERE job_num = ?'),
    trans: db.prepare('DELETE FROM material_transactions WHERE job_num = ?'),
    revenue: db.prepare('DELETE FROM job_revenue WHERE job_num = ?'),
  };
  for (const j of jobNums) {
    del.ops.run(j);
    del.labor.run(j);
    del.mtls.run(j);
    del.trans.run(j);
    if (revenue) del.revenue.run(j); // revenue === null: that optional BAQ did not run, keep what we already hold
  }
  const counts = {
    jobs: insertRows(db, 'jobs', jobs, { synced_at: syncedAt }),
    operations: insertRows(db, 'job_operations', ops),
    labor: insertRows(db, 'labor_details', labor),
    materials: insertRows(db, 'job_materials', mtls),
    transactions: insertRows(db, 'material_transactions', trans),
  };
  if (revenue) counts.revenue = insertRows(db, 'job_revenue', revenue);
  return counts;
}

/** Everything the engine needs for one job, in the engine's camelCase shape. */
export function loadJobInputs(db, jobNum) {
  const job = camelRow(db.prepare('SELECT * FROM jobs WHERE job_num = ?').get(jobNum));
  if (!job) return null;
  const all = (sql) => db.prepare(sql).all(jobNum).map(camelRow);
  return {
    job,
    ops: all('SELECT * FROM job_operations WHERE job_num = ? ORDER BY assembly_seq, opr_seq'),
    materials: all('SELECT * FROM job_materials WHERE job_num = ? ORDER BY assembly_seq, mtl_seq'),
    transactions: all('SELECT * FROM material_transactions WHERE job_num = ? ORDER BY tran_date, tran_num'),
    labor: all('SELECT * FROM labor_details WHERE job_num = ? ORDER BY clock_in_date, clock_in_time, labor_dtl_seq'),
    revenue: all('SELECT * FROM job_revenue WHERE job_num = ? ORDER BY order_num, order_line, order_rel_num'),
  };
}
