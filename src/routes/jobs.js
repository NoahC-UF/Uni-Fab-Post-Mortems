import ExcelJS from 'exceljs';
import { filterOptions, filterQuery, listJobs, parseFilters, topMissLabel } from '../queries.js';
import { buildJobView } from '../jobView.js';
import { createPostMortem, getPostMortemByJob, snapshotChanges } from '../postmortems.js';
import { UserError, notFound } from '../errors.js';
import { STATUS_LABELS } from '../format.js';
import { getPref, setPref, deletePref } from '../prefs.js';
import { CAUSE_LABELS } from '../economics.js';
import { getSettings } from '../settings.js';
import { drawingsFor } from '../drawings.js';
import { presetRanges } from './dashboard.js';
import { GRID_COLUMNS, clientRows } from '../gridRows.js';
import { normaliseColumnPref, parseColumnPrefBody } from '../columnPrefs.js';

const JOB_RE = /^[A-Za-z0-9._-]{1,30}$/;
const FLAG_RANK = { red: 3, yellow: 2, green: 1 };

const COLUMNS_PREF = 'jobs.columns';

export default async function jobRoutes(app) {
  const { db, now } = app.ctx;

  // ------------------------------------------------------------ flagged jobs list
  app.get('/jobs', async (req, reply) => {
    const f = parseFilters(req.query, now(), 90);
    const rows = listJobs(db, f);
    const defaults = parseFilters({}, now(), 90);
    const saved = getPref(db, req.user.id, COLUMNS_PREF);
    // Opened from a bar of the Dashboard chart: say what the list is, and what it adds up to.
    const lineFilter = f.lineOp && f.lineDir ? { op: f.lineOp, dir: f.lineDir, total: Math.round(rows.reduce((t, r) => t + (r.line_dollars || 0), 0)) } : null;
    // the quick date buttons (the same as the Dashboard and the Accuracy pages): they change the dates and keep every other filter
    const presets = presetRanges(now()).map((p) => ({ label: p.label, on: p.from === f.from && p.to === f.to, href: `/jobs?${filterQuery({ ...f, from: p.from, to: p.to }, defaults)}` }));
    return reply.page('jobs_list.njk', {
      f,
      presets,
      lineFilter,
      rows: clientRows(rows),
      total: rows.length,
      options: filterOptions(db),
      exportQuery: filterQuery(f, defaults),
      targetMarginPct: getSettings(db).targetMarginPct,
      savedColumns: normaliseColumnPref(saved, GRID_COLUMNS), // null = the standard columns
    });
  });

  // "Save as my default" for the grid's columns. Per person, so it follows them to any computer.
  app.post('/jobs/columns', async (req, reply) => {
    setPref(db, req.user.id, COLUMNS_PREF, parseColumnPrefBody(req.body, GRID_COLUMNS));
    return reply.send({ ok: true });
  });

  app.post('/jobs/columns/reset', async (req, reply) => {
    deletePref(db, req.user.id, COLUMNS_PREF);
    return reply.send({ ok: true });
  });

  app.get('/jobs/export.xlsx', async (req, reply) => {
    const f = parseFilters(req.query, now(), 90);
    const rows = listJobs(db, f);
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Uni-Fab Post-Mortem';
    wb.created = now();

    const ws = wb.addWorksheet('Flagged jobs');
    ws.columns = [
      { header: 'Flag', key: 'flag', width: 8 },
      { header: 'Job', key: 'job', width: 10 },
      { header: 'Part', key: 'part', width: 16 },
      { header: 'Description', key: 'desc', width: 30 },
      { header: 'Customer', key: 'customer', width: 26 },
      { header: 'Status', key: 'state', width: 12 },
      { header: 'Closed', key: 'closed', width: 12 },
      { header: 'Qty made', key: 'qty', width: 10 },
      { header: 'Flagged lines', key: 'lines', width: 10 },
      { header: '$ impact', key: 'impact', width: 12 },
      { header: '$ over', key: 'over', width: 12 },
      { header: '$ under', key: 'under', width: 12 },
      { header: '$ net', key: 'net', width: 12 },
      { header: 'Labour $ var', key: 'labour', width: 13 },
      { header: 'Material $ var', key: 'material', width: 14 },
      { header: 'Biggest miss', key: 'miss', width: 22 },
      { header: 'Biggest miss $', key: 'missDollars', width: 14 },
      { header: 'Sale price (CAD)', key: 'price', width: 16 },
      { header: 'Planned cost', key: 'plannedCost', width: 14 },
      { header: 'Actual cost', key: 'actualCost', width: 14 },
      { header: 'Planned margin $', key: 'plannedMargin', width: 16 },
      { header: 'Actual margin $', key: 'actualMargin', width: 16 },
      { header: 'Planned margin %', key: 'plannedMarginPct', width: 16 },
      { header: 'Actual margin %', key: 'actualMarginPct', width: 15 },
      ...(f.lineOp && f.lineDir ? [{ header: `${f.lineOp} ${f.lineDir} $ (matching lines)`, key: 'lineDollars', width: 22 }] : []),
      { header: 'Likely cause', key: 'cause', width: 16 },
      { header: 'Post-mortem', key: 'pm', width: 18 },
    ];
    for (const r of rows) {
      ws.addRow({
        flag: r.flag.toUpperCase(), job: r.job_num, part: r.part_num, desc: r.part_description, customer: r.cust_name || '',
        state: r.closed ? 'Closed' : 'In progress', closed: r.closed_date || '', qty: r.qty_completed, lines: r.flagged_lines,
        impact: r.impact_dollars, over: r.over_dollars, under: r.under_dollars, net: r.net_dollars, labour: r.labour_var_dollars,
        material: r.material_var_dollars, miss: topMissLabel(r.topMiss), missDollars: r.topMiss?.var_dollars ?? null,
        price: r.price, plannedCost: r.price === null ? null : r.planned_cost, actualCost: r.price === null ? null : r.actual_cost,
        plannedMargin: r.planned_margin, actualMargin: r.actual_margin, plannedMarginPct: r.planned_margin_pct, actualMarginPct: r.actual_margin_pct,
        lineDollars: r.line_dollars ?? null,
        cause: CAUSE_LABELS[r.cause] ?? '',
        pm: STATUS_LABELS[r.pm_status || 'flagged'],
      });
    }
    for (const k of ['impact', 'over', 'under', 'net', 'labour', 'material', 'missDollars', 'price', 'plannedCost', 'actualCost', 'plannedMargin', 'actualMargin']) ws.getColumn(k).numFmt = '$#,##0.00;[Red]-$#,##0.00';
    for (const k of ['plannedMarginPct', 'actualMarginPct']) ws.getColumn(k).numFmt = '0.0%;[Red]-0.0%';
    if (f.lineOp && f.lineDir) ws.getColumn('lineDollars').numFmt = '$#,##0.00';
    const fill = { red: 'FFFDE4E1', yellow: 'FFFFF3C4', green: 'FFE3F4EA' };
    ws.eachRow((row, i) => {
      if (i === 1) return;
      const f = String(row.getCell('flag').value).toLowerCase();
      if (fill[f]) row.getCell('flag').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill[f] } };
    });
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF14395B' } };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    if (rows.length) ws.autoFilter = { from: 'A1', to: { row: rows.length + 1, column: ws.columns.length } };

    const ls = wb.addWorksheet('Flagged lines');
    ls.columns = [
      { header: 'Job', key: 'job', width: 10 }, { header: 'Type', key: 'kind', width: 10 }, { header: 'Op code / part', key: 'what', width: 20 },
      { header: 'Resource group', key: 'rg', width: 14 }, { header: 'Flag', key: 'flag', width: 8 }, { header: 'Direction', key: 'dir', width: 10 },
      { header: 'Unplanned', key: 'unp', width: 10 }, { header: 'Variance hrs', key: 'hrs', width: 13 }, { header: 'Variance %', key: 'pct', width: 12 },
      { header: 'Variance $', key: 'usd', width: 13 },
    ];
    const jobNums = rows.map((r) => r.job_num);
    for (let i = 0; i < jobNums.length; i += 400) {
      const chunk = jobNums.slice(i, i + 400);
      const lines = db
        .prepare(`SELECT * FROM flag_lines WHERE job_num IN (${chunk.map(() => '?').join(',')}) ORDER BY job_num, ABS(var_dollars) DESC`)
        .all(...chunk);
      for (const l of lines) {
        ls.addRow({ job: l.job_num, kind: l.kind === 'op' ? 'Labour' : 'Material', what: l.op_code || l.part_num, rg: l.resource_grp_id || '', flag: l.flag.toUpperCase(), dir: l.direction, unp: l.unplanned ? 'Yes' : '', hrs: l.var_hours, pct: l.var_pct, usd: l.var_dollars });
      }
    }
    ls.getColumn('pct').numFmt = '0.0%';
    ls.getColumn('usd').numFmt = '$#,##0.00;[Red]-$#,##0.00';
    ls.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ls.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF14395B' } };
    ls.views = [{ state: 'frozen', ySplit: 1 }];

    const buf = await wb.xlsx.writeBuffer();
    const stamp = now().toISOString().slice(0, 10);
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="flagged-jobs-${stamp}.xlsx"`)
      .send(Buffer.from(buf));
  });

  // ------------------------------------------------------------------ job detail
  app.get('/jobs/:jobNum', async (req, reply) => {
    const { jobNum } = req.params;
    if (!JOB_RE.test(jobNum)) throw notFound('That job');
    const view = buildJobView(db, jobNum, { isAdmin: req.user.isAdmin });
    if (!view) throw notFound(`Job ${jobNum}`);
    const pm = getPostMortemByJob(db, jobNum);
    const changes = pm ? snapshotChanges(db, pm).changes : [];
    return reply.page('job_detail.njk', { v: view, pm, changes, rank: FLAG_RANK, drawings: drawingsFor(getSettings(db), jobNum) });
  });

  // Start a post-mortem: freezes a snapshot of the job's current numbers.
  app.post('/jobs/:jobNum/postmortem', async (req, reply) => {
    const { jobNum } = req.params;
    if (!JOB_RE.test(jobNum)) throw notFound('That job');
    const existing = getPostMortemByJob(db, jobNum);
    if (existing) return reply.redirect(`/postmortems/${existing.id}`);
    const id = createPostMortem(db, { jobNum, userId: req.user.id, now: now() });
    return reply.redirect(`/postmortems/${id}?ok=${encodeURIComponent('Post-mortem started. The numbers were frozen as a snapshot.')}`);
  });

  // Dismiss without a full review (e.g. data entry error). Still keeps a snapshot and the reason.
  app.post('/jobs/:jobNum/dismiss', async (req, reply) => {
    const { jobNum } = req.params;
    if (!JOB_RE.test(jobNum)) throw notFound('That job');
    const reason = String(req.body?.reason ?? '').trim();
    if (!reason) throw new UserError('Please give a reason for dismissing this job.');
    const id = createPostMortem(db, { jobNum, userId: req.user.id, status: 'dismissed', dismissReason: reason, now: now() });
    return reply.redirect(`/postmortems/${id}?ok=${encodeURIComponent('Job dismissed.')}`);
  });
}
