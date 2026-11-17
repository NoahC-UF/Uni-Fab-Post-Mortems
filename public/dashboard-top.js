// Dashboard: the Top 10 table (Tabulator). It uses the same columns as Flagged Jobs (public/job-columns.js), shows a
// shorter set to begin with, and each person can add, remove and move columns and save the result.
window.addEventListener('DOMContentLoaded', () => {
  const el = document.getElementById('topJobs');
  const dataEl = document.getElementById('jobRows');
  if (!el || !dataEl || !window.Tabulator || !window.UFJobColumns) return;
  const rows = JSON.parse(dataEl.textContent);
  const json = (id, fallback) => {
    try {
      return JSON.parse(document.getElementById(id)?.textContent || 'null') ?? fallback;
    } catch {
      return fallback;
    }
  };
  const meta = json('gridMeta', {});
  const saved = json('colPrefs', null);

  // Over-runs / under-runs: show the dollars the list is ranked by; both: the total.
  const ranked = meta.dir === 'over' ? 'over' : meta.dir === 'under' ? 'under' : 'impact';
  const standard = ['flag', 'job', 'customer', 'part', ranked, 'net', 'miss', 'pmStatus'];
  const defs = UFJobColumns.create(Number(meta.target) || 0, { standard, filters: false, bands: meta.marginBands, minColWidth: UFJobColumns.minColWidth(el) });

  const table = new Tabulator(el, {
    data: rows,
    layout: 'fitDataStretch',
    placeholder: 'No flagged jobs in this period.',
    movableColumns: true, // drag a column title to move it
    columns: UFJobColumns.columnsFor(defs, saved),
  });
  UFJobColumns.attachMenu(table, { defs, saved, saveUrl: '/dashboard/columns', resetUrl: '/dashboard/columns/reset' });
});
