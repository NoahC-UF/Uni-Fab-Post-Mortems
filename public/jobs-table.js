// Flagged Jobs grid (Tabulator). Rows are embedded in the page as JSON; filters above the grid are server-side.
// The columns and the Columns menu are shared with the Dashboard's Top 10: public/job-columns.js.
window.addEventListener('DOMContentLoaded', () => {
  const el = document.getElementById('jobsTable');
  const dataEl = document.getElementById('jobRows');
  if (!el || !dataEl || !window.Tabulator || !window.UFJobColumns) return;
  const rows = JSON.parse(dataEl.textContent);
  // A person's saved columns ({ visible, order }), or null = the standard set.
  const saved = (() => {
    try {
      const v = JSON.parse(document.getElementById('colPrefs')?.textContent || 'null');
      return v && typeof v === 'object' ? v : null;
    } catch {
      return null;
    }
  })();

  const meta = (() => {
    try {
      return JSON.parse(document.getElementById('gridMeta')?.textContent || '{}') || {};
    } catch {
      return {};
    }
  })();
  const target = Number(meta.target) || 0;

  const defs = UFJobColumns.create(target, { bands: meta.marginBands, minColWidth: UFJobColumns.minColWidth(el) });

  // Header of the tick-box column: Tabulator's own select-all box, with the words "Select All" under it
  // (the words are part of the label, so clicking them ticks the box too).
  const selectAllTitle = (cell, params, onRendered) => {
    const box = Tabulator.moduleBindings.format.formatters.rowSelection.call(cell.getTable().modules.format, cell, params, onRendered);
    const label = document.createElement('label');
    label.className = 'select-all';
    label.append(box, 'Select All');
    return label;
  };

  // Opened from a bar of the Dashboard chart: always show the Matching Lines $ column (next to $ Impact) and rank by it.
  let columns = UFJobColumns.columnsFor(defs, saved);
  if (meta.lineFilter) {
    const at = columns.findIndex((c) => c.field === 'impact');
    const mine = columns.find((c) => c.field === 'lineDollars');
    columns = columns.filter((c) => c.field !== 'lineDollars');
    columns.splice(at < 0 ? columns.length : at, 0, { ...mine, visible: true });
  }

  const table = new Tabulator(el, {
    data: rows,
    layout: 'fitDataStretch',
    pagination: true,
    paginationSize: 50,
    paginationSizeSelector: [25, 50, 100, 250],
    initialSort: [{ column: meta.lineFilter ? 'lineDollars' : 'impact', dir: 'desc' }],
    placeholder: 'No jobs match.',
    movableColumns: true, // drag a column title to move it
    // tick boxes in the first column pick jobs for the Study page
    selectableRows: true,
    rowHeader: { formatter: 'rowSelection', titleFormatter: selectAllTitle, headerSort: false, resizable: false, frozen: true, headerHozAlign: 'center', hozAlign: 'center', width: 68, cellClick: (e, cell) => cell.getRow().toggleSelect() },
    columns,
  });

  // ---- "Study ticked jobs": link to the Study page with the ticked job numbers
  const studyLink = document.getElementById('studySelected');
  const studyCount = document.getElementById('studyCount');
  const MAX_STUDY = 300;
  const refreshStudy = () => {
    if (!studyLink) return;
    const jobs = table.getSelectedData().map((r) => r.job);
    if (studyCount) studyCount.textContent = String(jobs.length);
    const usable = jobs.length > 0 && jobs.length <= MAX_STUDY;
    studyLink.classList.toggle('disabled', !usable);
    studyLink.setAttribute('aria-disabled', usable ? 'false' : 'true');
    studyLink.href = usable ? `/study?jobs=${encodeURIComponent(jobs.join(','))}` : '/study';
    studyLink.title = jobs.length > MAX_STUDY ? `Study up to ${MAX_STUDY} jobs at a time` : 'Study the ticked jobs side by side';
  };
  table.on('rowSelectionChanged', refreshStudy);

  UFJobColumns.attachMenu(table, { defs, saved, saveUrl: '/jobs/columns', resetUrl: '/jobs/columns/reset' });
});
