// The job table used on the Flagged Jobs page and (top 10) on the Dashboard: its columns and its rows.
// The column list must match public/job-columns.js.

import { topMissLabel } from './queries.js';
import { STATUS_LABELS } from './format.js';
import { CAUSE_LABELS } from './economics.js';

/** Columns a person may show, hide and reorder (field names used by the grid). */
export const GRID_COLUMNS = [
  'flag', 'job', 'part', 'customer', 'state', 'closedDate', 'impact', 'over', 'under', 'net', 'labour', 'material', 'lines', 'miss', 'pmStatus',
  'price', 'plannedMarginPct', 'actualMarginPct', 'actualMargin', 'causeLabel', 'lineDollars',
];

/** Database rows (see listJobs) as the plain objects the grid is given. */
export function clientRows(rows) {
  return rows.map((r) => ({
    job: r.job_num,
    part: r.part_num,
    partDesc: r.part_description,
    customer: r.cust_name || '',
    state: r.closed ? 'Closed' : 'In progress',
    closedDate: r.closed_date || '',
    flag: r.flag,
    lines: r.flagged_lines,
    impact: r.impact_dollars,
    over: r.over_dollars,
    under: r.under_dollars,
    net: r.net_dollars,
    labour: r.labour_var_dollars,
    material: r.material_var_dollars,
    miss: topMissLabel(r.topMiss),
    missDollars: r.topMiss?.var_dollars ?? null,
    price: r.price,
    lineDollars: r.line_dollars ?? null, // only when the list is for one bar of the Dashboard chart
    plannedMarginPct: r.planned_margin_pct,
    actualMarginPct: r.actual_margin_pct,
    targetMargin: r.target_margin,
    actualMargin: r.actual_margin,
    cause: r.cause,
    causeLabel: CAUSE_LABELS[r.cause] ?? '',
    pmId: r.pm_id,
    pmStatus: r.pm_status || 'flagged',
    pmLabel: STATUS_LABELS[r.pm_status || 'flagged'],
  }));
}
