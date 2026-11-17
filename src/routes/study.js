// Study several jobs together (opened from the Flagged Jobs grid).
//   /study?jobs=092668-1-1,092115-1-1    the jobs ticked in the grid
//   /study?from=...&flag=all&...         every job the Flagged Jobs filters currently match
//   /study/export.xlsx                   the same study as a spreadsheet

import ExcelJS from 'exceljs';
import { listJobs, parseFilters, filterQuery } from '../queries.js';
import { getEngineConfig, getSettings } from '../settings.js';
import { buildStudy, MAX_STUDY_JOBS } from '../study.js';
import { UserError } from '../errors.js';
import { getPref, setPref, deletePref } from '../prefs.js';
import { cleanTableWidths, parseTableWidthsBody } from '../columnPrefs.js';

// The Study page's tables whose columns a person can resize, and where their widths are kept (see public/table-widths.js).
export const STUDY_TABLE_IDS = ['study-summary', 'study-jobs', 'study-ops', 'study-heatmap', 'study-parts', 'study-mtl'];
const WIDTHS_PREF = 'study.widths';

const JOB_RE = /^[A-Za-z0-9._-]{1,30}$/;

export default async function studyRoutes(app) {
  const { db, now } = app.ctx;

  function pick(req) {
    const raw = typeof req.query?.jobs === 'string' ? req.query.jobs : '';
    if (raw.trim()) {
      const nums = raw.split(',').map((s) => s.trim()).filter((s) => JOB_RE.test(s));
      if (!nums.length) throw new UserError('No valid job numbers were given.');
      return { jobNums: nums, source: 'selected', f: null, filterString: '' };
    }
    const f = parseFilters(req.query, now(), 90);
    const rows = listJobs(db, f);
    return { jobNums: rows.map((r) => r.job_num), source: 'filters', f, filterString: filterQuery(f, parseFilters({}, now(), 90)) };
  }

  const run = (jobNums) => {
    const s = getSettings(db);
    return buildStudy(db, jobNums, getEngineConfig(db), { targetMarginPct: s.targetMarginPct, baseCurrency: s.baseCurrency });
  };

  app.get('/study', async (req, reply) => {
    const p = pick(req);
    if (!p.jobNums.length) throw new UserError('No jobs match those filters, so there is nothing to study. Go back and widen the filters.');
    const study = run(p.jobNums);
    const s = getSettings(db);
    const exportQuery = p.source === 'selected' ? `jobs=${encodeURIComponent(p.jobNums.join(','))}` : p.filterString;
    const savedWidths = cleanTableWidths(getPref(db, req.user.id, WIDTHS_PREF), STUDY_TABLE_IDS);
    return reply.page('study.njk', { study, source: p.source, f: p.f, exportQuery, target: s.targetMarginPct / 100, max: MAX_STUDY_JOBS, savedWidths });
  });

  // "Save column widths" for the Study tables. Per person, so it follows them to any computer.
  app.post('/study/widths', async (req, reply) => {
    setPref(db, req.user.id, WIDTHS_PREF, parseTableWidthsBody(req.body, STUDY_TABLE_IDS));
    return reply.send({ ok: true });
  });

  app.post('/study/widths/reset', async (req, reply) => {
    deletePref(db, req.user.id, WIDTHS_PREF);
    return reply.send({ ok: true });
  });

  app.get('/study/export.xlsx', async (req, reply) => {
    const p = pick(req);
    if (!p.jobNums.length) throw new UserError('There are no jobs to export.');
    const st = run(p.jobNums);
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Uni-Fab Post-Mortem';
    wb.created = now();
    const money = '$#,##0.00;[Red]-$#,##0.00';
    const pct = '0.0%;[Red]-0.0%';
    const head = (ws) => {
      ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF14395B' } };
      ws.views = [{ state: 'frozen', ySplit: 1 }];
    };

    // ---- summary: the headline, the three-team readout, and the margin table
    const sum = wb.addWorksheet('Summary');
    sum.columns = [{ header: 'Measure', key: 'm', width: 42 }, { header: 'Planned', key: 'p', width: 16 }, { header: 'Actual', key: 'a', width: 16 }, { header: `Actual vs ${Math.round(st.stats.target * 100)}% goal (points)`, key: 'g', width: 24 }];
    const s = st.stats;
    const pts = (v) => (v === null ? null : Math.round((v - s.target) * 1000) / 10);
    sum.addRow({ m: 'Average margin (simple)', p: s.average.planned, a: s.average.actual, g: pts(s.average.actual) });
    sum.addRow({ m: 'Median margin', p: s.median.planned, a: s.median.actual, g: pts(s.median.actual) });
    sum.addRow({ m: 'Revenue-weighted margin', p: s.weighted.planned, a: s.weighted.actual, g: pts(s.weighted.actual) });
    sum.addRow({ m: 'Margin dollars', p: s.dollars.planned, a: s.dollars.actual });
    sum.addRow({ m: 'Margin dollars vs the goal margin', p: s.vsGoalDollars.planned, a: s.vsGoalDollars.actual });
    sum.addRow({ m: 'Labour hours', p: s.hours.planned, a: s.hours.actual });
    sum.addRow({ m: 'Hours multiple (actual / planned)', a: s.hours.multiple });
    sum.addRow({});
    sum.addRow({ m: `Based on ${s.n} closed jobs with a sale price (CAD). Freight and overhead are not in the data.` });
    sum.addRow({ m: st.summary.headline });
    for (const t of st.summary.teams) sum.addRow({ m: `${t.team}: ${t.text}` });
    for (const r of [1, 2, 3]) sum.getRow(r + 1).getCell('p').numFmt = pct;
    for (const r of [1, 2, 3]) sum.getRow(r + 1).getCell('a').numFmt = pct;
    for (const r of [4, 5]) for (const c of ['p', 'a']) sum.getRow(r + 1).getCell(c).numFmt = money;
    head(sum);

    const jobs = wb.addWorksheet('Jobs');
    jobs.columns = [
      { header: 'Job', key: 'jobNum', width: 14 }, { header: 'Part', key: 'part', width: 20 }, { header: 'Customer', key: 'customer', width: 26 },
      { header: 'Status', key: 'status', width: 12 }, { header: 'Closed', key: 'closedDate', width: 12 },
      { header: 'Qty ordered', key: 'qtyOrdered', width: 11 }, { header: 'Qty made', key: 'qtyMade', width: 10 },
      { header: 'Flag', key: 'flag', width: 8 }, { header: 'Flagged lines', key: 'flaggedLines', width: 10 },
      { header: '$ impact', key: 'impact', width: 12 }, { header: 'Labour $ var', key: 'labourVar', width: 13 }, { header: 'Material $ var', key: 'materialVar', width: 14 },
      { header: 'Sale price (CAD)', key: 'price', width: 16 }, { header: 'Planned cost', key: 'plannedCost', width: 14 }, { header: 'Actual cost', key: 'actualCost', width: 14 },
      { header: 'Planned margin $', key: 'plannedMargin', width: 16 }, { header: 'Actual margin $', key: 'actualMargin', width: 16 },
      { header: 'Planned margin %', key: 'plannedMarginPct', width: 16 }, { header: 'Actual margin %', key: 'actualMarginPct', width: 15 },
      { header: 'Likely cause', key: 'causeLabel', width: 16 },
      { header: 'Planned hours', key: 'plannedHours', width: 14 }, { header: 'Actual hours', key: 'actualHours', width: 13 }, { header: 'Hours (actual / planned)', key: 'hoursMultiple', width: 16 },
      { header: 'Price needed for goal', key: 'priceNeeded', width: 18 }, { header: 'Price gap %', key: 'priceGapPct', width: 12 },
      { header: 'Where to look', key: 'focusLabel', width: 20 }, { header: 'Detail', key: 'focusDetail', width: 44 }, { header: 'Quantity check', key: 'qtyNote', width: 60 },
    ];
    for (const j of st.ranked) jobs.addRow({ ...j, status: j.closed ? 'Closed' : 'In progress', flag: String(j.flag).toUpperCase(), closedDate: j.closedDate ?? '' });
    for (const k of ['impact', 'labourVar', 'materialVar', 'price', 'plannedCost', 'actualCost', 'plannedMargin', 'actualMargin', 'priceNeeded']) jobs.getColumn(k).numFmt = money;
    for (const k of ['plannedMarginPct', 'actualMarginPct', 'priceGapPct']) jobs.getColumn(k).numFmt = pct;
    head(jobs);

    const ops = wb.addWorksheet('By operation');
    ops.columns = [
      { header: 'Operation', key: 'opCode', width: 14 }, { header: 'Jobs', key: 'jobs', width: 8 },
      { header: 'Expected hrs', key: 'expectedHours', width: 13 }, { header: 'Actual hrs', key: 'actualHours', width: 12 }, { header: 'Variance hrs', key: 'varHours', width: 13 },
      { header: 'Hours (actual / expected)', key: 'hoursMultiple', width: 16 },
      { header: 'Variance %', key: 'varPct', width: 12 }, { header: 'Typical job %', key: 'medianVarPct', width: 13 },
      { header: 'Jobs over', key: 'jobsOver', width: 10 }, { header: 'Jobs under', key: 'jobsUnder', width: 10 }, { header: 'Flagged', key: 'flagged', width: 9 },
      { header: 'Variance $', key: 'varDollars', width: 13 }, { header: 'Share of net overrun', key: 'shareOfNet', width: 18 }, { header: 'Pattern', key: 'pattern', width: 34 },
    ];
    for (const o of st.operations) ops.addRow(o);
    ops.getColumn('varDollars').numFmt = money;
    for (const k of ['varPct', 'medianVarPct', 'shareOfNet']) ops.getColumn(k).numFmt = pct;
    head(ops);

    const mtl = wb.addWorksheet('By material');
    mtl.columns = [
      { header: 'Part', key: 'partNum', width: 22 }, { header: 'Description', key: 'description', width: 34 }, { header: 'Jobs', key: 'jobs', width: 8 },
      { header: 'Expected qty', key: 'expectedQty', width: 13 }, { header: 'Actual qty', key: 'actualQty', width: 12 },
      { header: 'Expected $', key: 'estDollars', width: 13 }, { header: 'Actual $', key: 'actDollars', width: 13 }, { header: 'Variance $', key: 'varDollars', width: 13 },
      { header: 'Variance %', key: 'varPct', width: 12 }, { header: 'Usage $', key: 'usageVar', width: 12 }, { header: 'Cost basis $', key: 'priceVar', width: 13 }, { header: 'Flagged', key: 'flagged', width: 9 },
    ];
    for (const m of st.materials) mtl.addRow(m);
    for (const k of ['estDollars', 'actDollars', 'varDollars', 'usageVar', 'priceVar']) mtl.getColumn(k).numFmt = money;
    mtl.getColumn('varPct').numFmt = pct;
    head(mtl);

    const hm = wb.addWorksheet('Heat map');
    hm.columns = [{ header: 'Operation (variance % vs expected hours)', key: 'op', width: 34 }, ...st.matrix.jobs.map((j) => ({ header: j, key: j, width: 13 }))];
    for (const r of st.matrix.rows) hm.addRow({ op: r.opCode, ...Object.fromEntries(st.matrix.jobs.map((j, i) => [j, r.cells[i]?.pct ?? null])) });
    for (let c = 2; c <= st.matrix.jobs.length + 1; c++) hm.getColumn(c).numFmt = pct;
    head(hm);

    const rp = wb.addWorksheet('Repeat parts');
    rp.columns = [
      { header: 'Part', key: 'part', width: 26 }, { header: 'Jobs', key: 'jobs', width: 40 }, { header: 'Priced jobs', key: 'pricedJobs', width: 11 },
      { header: 'Sale price (CAD)', key: 'price', width: 16 }, { header: 'Planned margin $', key: 'plannedMargin', width: 16 }, { header: 'Actual margin $', key: 'actualMargin', width: 16 },
      { header: 'Below plan by', key: 'belowPlan', width: 14 }, { header: 'Actual margin %', key: 'actualMarginPct', width: 15 }, { header: 'Hours (actual / planned)', key: 'hoursMultiple', width: 16 },
      { header: 'Lost money every run', key: 'lostEveryRun', width: 18 },
    ];
    for (const p of st.repeatParts) rp.addRow({ ...p, jobs: p.jobs.join(', '), lostEveryRun: p.lostEveryRun ? 'Yes' : '' });
    for (const k of ['price', 'plannedMargin', 'actualMargin', 'belowPlan']) rp.getColumn(k).numFmt = money;
    rp.getColumn('actualMarginPct').numFmt = pct;
    head(rp);

    const buf = await wb.xlsx.writeBuffer();
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="job-study-${now().toISOString().slice(0, 10)}.xlsx"`)
      .send(Buffer.from(buf));
  });
}
