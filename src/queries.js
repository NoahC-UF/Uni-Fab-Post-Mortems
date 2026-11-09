// Read-side queries for the dashboard and the Flagged Jobs list.

import { getSettings } from './settings.js';

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const validDate = (s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);
const str = (s) => (typeof s === 'string' ? s.trim().slice(0, 80) : '');

export const OPEN_PM_STATUSES = ['under_review', 'root_cause_found', 'actions_assigned'];
export const DONE_PM_STATUSES = ['closed', 'dismissed'];

export function parseFilters(q = {}, now = new Date(), defaultDays = 90) {
  const num = Number(q.minImpact);
  return {
    from: validDate(q.from) ?? iso(addDays(now, -defaultDays)),
    to: validDate(q.to) ?? iso(now),
    status: ['all', 'closed', 'open'].includes(q.status) ? q.status : 'all',
    flag: ['flagged', 'red', 'yellow', 'green', 'all'].includes(q.flag) ? q.flag : 'flagged',
    direction: ['over', 'under'].includes(q.direction) ? q.direction : '',
    cust: str(q.cust),
    part: str(q.part),
    op: str(q.op),
    rg: str(q.rg),
    job: str(q.job),
    minImpact: Number.isFinite(num) && num > 0 ? num : 0,
    pm: ['none', 'open', 'closed'].includes(q.pm) ? q.pm : '',
  };
}

/** Query-string for links that should carry the current filters (e.g. the Excel export). */
export function filterQuery(f, defaults = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== '' && v !== 0 && v !== defaults[k]) p.set(k, String(v));
  return p.toString();
}

/** WHERE clause + params for the job population. `include` lets the dashboard override parts. */
export function buildWhere(db, f, { ignoreFlag = false, closedOnly = false } = {}) {
  const settings = getSettings(db);
  const where = [];
  const p = {};

  const closedCond = 'j.closed = 1 AND j.closed_date >= @from AND j.closed_date <= @to';
  const status = closedOnly ? 'closed' : f.status;
  if (status === 'open') where.push('j.closed = 0');
  else {
    where.push(status === 'closed' ? `(${closedCond})` : `((${closedCond}) OR j.closed = 0)`);
    // (SQLite rejects named parameters the SQL does not use, so only add these when needed)
    p.from = f.from;
    p.to = f.to;
  }

  if (settings.excludeNonOrderJobs) where.push('j.order_num IS NOT NULL');

  if (!ignoreFlag) {
    if (f.flag === 'flagged') where.push("m.flag IN ('red','yellow')");
    else if (['red', 'yellow', 'green'].includes(f.flag)) {
      where.push('m.flag = @flag');
      p.flag = f.flag;
    }
  }
  if (f.direction) {
    where.push('EXISTS (SELECT 1 FROM flag_lines d WHERE d.job_num = j.job_num AND d.direction = @direction)');
    p.direction = f.direction;
  }
  if (f.op) {
    where.push('EXISTS (SELECT 1 FROM flag_lines o WHERE o.job_num = j.job_num AND o.op_code = @op)');
    p.op = f.op;
  }
  if (f.rg) {
    where.push('EXISTS (SELECT 1 FROM flag_lines r WHERE r.job_num = j.job_num AND r.resource_grp_id = @rg)');
    p.rg = f.rg;
  }
  if (f.cust) {
    where.push('j.cust_id = @cust');
    p.cust = f.cust;
  }
  if (f.part) {
    where.push('j.part_num LIKE @part');
    p.part = `%${f.part}%`;
  }
  if (f.job) {
    where.push('j.job_num LIKE @job');
    p.job = `%${f.job}%`;
  }
  if (f.minImpact) {
    where.push('m.impact_dollars >= @minImpact');
    p.minImpact = f.minImpact;
  }
  if (f.pm === 'none') where.push('pm.id IS NULL');
  else if (f.pm === 'open') where.push(`pm.status IN (${OPEN_PM_STATUSES.map((s) => `'${s}'`).join(',')})`);
  else if (f.pm === 'closed') where.push(`pm.status IN (${DONE_PM_STATUSES.map((s) => `'${s}'`).join(',')})`);
  return { sql: where.join(' AND '), params: p };
}

const BASE_FROM = `FROM jobs j
  JOIN job_metrics m ON m.job_num = j.job_num
  LEFT JOIN post_mortems pm ON pm.job_num = j.job_num`;

export function listJobs(db, f, { limit = 5000 } = {}) {
  const { sql, params } = buildWhere(db, f);
  const rows = db
    .prepare(
      `SELECT j.job_num, j.part_num, j.part_description, j.cust_id, j.cust_name, j.closed, j.closed_date, j.start_date,
              j.prod_qty, j.qty_completed, j.order_num,
              m.flag, m.flagged_lines, m.red_lines, m.yellow_lines, m.impact_dollars, m.over_dollars, m.under_dollars,
              m.net_dollars, m.labour_var_dollars, m.material_var_dollars,
              pm.id AS pm_id, pm.status AS pm_status
       ${BASE_FROM}
       WHERE ${sql}
       ORDER BY m.impact_dollars DESC, j.job_num
       LIMIT ${Number(limit)}`,
    )
    .all(params)
    .map((r) => ({ ...r }));
  attachTopMiss(db, rows);
  return rows;
}

/** Adds { topMiss } (the single biggest flagged line, by dollars) to each job row. */
export function attachTopMiss(db, rows) {
  if (!rows.length) return rows;
  const top = new Map();
  for (let i = 0; i < rows.length; i += 400) {
    const chunk = rows.slice(i, i + 400).map((r) => r.job_num);
    const found = db
      .prepare(
        `SELECT job_num, kind, op_code, part_num, direction, unplanned, var_dollars, var_pct
         FROM flag_lines WHERE job_num IN (${chunk.map(() => '?').join(',')})
         ORDER BY ABS(var_dollars) DESC`,
      )
      .all(...chunk);
    for (const l of found) if (!top.has(l.job_num)) top.set(l.job_num, { ...l });
  }
  for (const r of rows) r.topMiss = top.get(r.job_num) ?? null;
  return rows;
}

export function topMissLabel(t) {
  if (!t) return '';
  const what = t.kind === 'op' ? t.op_code : `Material ${t.part_num}`;
  return `${what}${t.unplanned ? ' (unplanned)' : ''}`;
}

export function filterOptions(db) {
  const col = (sql) => db.prepare(sql).all().map((r) => Object.values(r)[0]);
  return {
    customers: db.prepare("SELECT DISTINCT cust_id AS id, cust_name AS name FROM jobs WHERE cust_id IS NOT NULL AND cust_id <> '' ORDER BY cust_name").all().map((r) => ({ ...r })),
    opCodes: col("SELECT DISTINCT op_code FROM job_operations WHERE op_code <> '' ORDER BY op_code"),
    resourceGroups: col("SELECT DISTINCT resource_grp_id FROM job_operations WHERE resource_grp_id IS NOT NULL AND resource_grp_id <> '' ORDER BY resource_grp_id"),
  };
}

// ------------------------------------------------------------------ dashboard
export function dashboardData(db, f, now = new Date()) {
  const closed = buildWhere(db, f, { ignoreFlag: true, closedOnly: true });
  const agg = db
    .prepare(
      `SELECT COUNT(*) AS jobs,
              SUM(CASE WHEN m.flag = 'green' THEN 1 ELSE 0 END) AS green,
              SUM(CASE WHEN m.flag = 'yellow' THEN 1 ELSE 0 END) AS yellow,
              SUM(CASE WHEN m.flag = 'red' THEN 1 ELSE 0 END) AS red,
              COALESCE(SUM(m.over_dollars), 0) AS over_dollars,
              COALESCE(SUM(m.under_dollars), 0) AS under_dollars,
              COALESCE(SUM(m.net_dollars), 0) AS net_dollars,
              SUM(CASE WHEN pm.id IS NOT NULL THEN 1 ELSE 0 END) AS with_pm
       ${BASE_FROM} WHERE ${closed.sql}`,
    )
    .get(closed.params);

  const settings = getSettings(db);
  const openJobs = db
    .prepare(
      `SELECT COUNT(*) AS jobs, SUM(CASE WHEN m.flag IN ('red','yellow') THEN 1 ELSE 0 END) AS flagged
       FROM jobs j JOIN job_metrics m ON m.job_num = j.job_num
       WHERE j.closed = 0 ${settings.excludeNonOrderJobs ? 'AND j.order_num IS NOT NULL' : ''}`,
    )
    .get();

  const openPm = db.prepare(`SELECT COUNT(*) n FROM post_mortems WHERE status IN (${OPEN_PM_STATUSES.map((s) => `'${s}'`).join(',')})`).get().n;
  const overdueActions = db
    .prepare("SELECT COUNT(*) n FROM action_items WHERE status <> 'done' AND due_date IS NOT NULL AND due_date < ?")
    .get(iso(now)).n;

  // Population for the table and chart: closed jobs in the period + in-progress jobs
  const pop = buildWhere(db, f, { ignoreFlag: true });
  const awaiting = db
    .prepare(`SELECT COUNT(*) n ${BASE_FROM} WHERE ${pop.sql} AND m.flag IN ('red','yellow') AND pm.id IS NULL`)
    .get(pop.params).n;

  const top = db
    .prepare(
      `SELECT j.job_num, j.part_num, j.cust_name, j.closed, j.closed_date,
              m.flag, m.impact_dollars, m.over_dollars, m.under_dollars, m.net_dollars, m.flagged_lines,
              pm.id AS pm_id, pm.status AS pm_status
       ${BASE_FROM} WHERE ${pop.sql} AND m.flag IN ('red','yellow')
       ORDER BY m.impact_dollars DESC, j.job_num LIMIT 10`,
    )
    .all(pop.params)
    .map((r) => ({ ...r }));
  attachTopMiss(db, top);

  const byOp = db
    .prepare(
      `SELECT COALESCE(l.op_code, 'Material') AS label,
              SUM(CASE WHEN l.var_dollars > 0 THEN l.var_dollars ELSE 0 END) AS over_dollars,
              SUM(CASE WHEN l.var_dollars < 0 THEN -l.var_dollars ELSE 0 END) AS under_dollars
       FROM flag_lines l
       JOIN jobs j ON j.job_num = l.job_num
       JOIN job_metrics m ON m.job_num = j.job_num
       LEFT JOIN post_mortems pm ON pm.job_num = j.job_num
       WHERE ${pop.sql}
       GROUP BY label ORDER BY SUM(ABS(l.var_dollars)) DESC LIMIT 12`,
    )
    .all(pop.params)
    .map((r) => ({ ...r }));

  const total = agg.jobs || 0;
  return {
    reviewed: total,
    green: agg.green || 0,
    yellow: agg.yellow || 0,
    red: agg.red || 0,
    withinTolerancePct: total ? (agg.green || 0) / total : null,
    overDollars: agg.over_dollars,
    underDollars: agg.under_dollars,
    netDollars: agg.net_dollars,
    withPm: agg.with_pm || 0,
    inProgress: openJobs.jobs || 0,
    inProgressFlagged: openJobs.flagged || 0,
    openPostMortems: openPm,
    awaitingReview: awaiting,
    overdueActions,
    top,
    byOp,
  };
}
