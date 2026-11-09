// Flagged Jobs grid (Tabulator). Rows are embedded in the page as JSON; filters above the grid are server-side.
window.addEventListener('DOMContentLoaded', () => {
  const el = document.getElementById('jobsTable');
  const dataEl = document.getElementById('jobRows');
  if (!el || !dataEl || !window.Tabulator) return;
  const rows = JSON.parse(dataEl.textContent);

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const rank = { red: 3, yellow: 2, green: 1 };
  const fmt0 = new Intl.NumberFormat('en-CA', { maximumFractionDigits: 0 });
  const money0 = (v) => (v === null || v === undefined ? '' : (v < 0 ? '-$' : '$') + fmt0.format(Math.abs(v)));
  const smoney0 = (v) => (v === null || v === undefined ? '' : v === 0 ? '$0' : (v > 0 ? '+$' : '-$') + fmt0.format(Math.abs(v)));
  const cls = (v) => (v > 0 ? 'neg-bad' : v < 0 ? 'neg-good' : 'muted');

  const chip = (flag) => {
    const label = { red: 'Red', yellow: 'Yellow', green: 'OK' }[flag] || flag;
    return `<span class="chip chip-${flag}">${label}</span>`;
  };
  const statusLabel = { flagged: 'Flagged', under_review: 'Under Review', root_cause_found: 'Root Cause Found', actions_assigned: 'Actions Assigned', closed: 'Closed', dismissed: 'Dismissed' };

  const signed = (cell) => {
    const v = cell.getValue();
    return v === null || v === undefined ? '' : `<span class="${cls(v)}">${smoney0(v)}</span>`;
  };

  const table = new Tabulator(el, {
    data: rows,
    layout: 'fitDataStretch',
    pagination: true,
    paginationSize: 50,
    paginationSizeSelector: [25, 50, 100, 250],
    initialSort: [{ column: 'impact', dir: 'desc' }],
    placeholder: 'No jobs match.',
    columns: [
      { title: 'Flag', field: 'flag', width: 90, formatter: (c) => chip(c.getValue()), sorter: (a, b) => (rank[a] || 0) - (rank[b] || 0), headerFilter: 'list', headerFilterParams: { values: { red: 'Red', yellow: 'Yellow', green: 'OK' }, clearable: true }, headerFilterFunc: (v, rv) => !v || v === rv },
      { title: 'Job', field: 'job', width: 100, formatter: (c) => `<a href="/jobs/${encodeURIComponent(c.getValue())}">${esc(c.getValue())}</a>`, headerFilter: 'input' },
      { title: 'Part', field: 'part', width: 130, headerFilter: 'input', formatter: (c) => `<span title="${esc(c.getRow().getData().partDesc)}">${esc(c.getValue())}</span>` },
      { title: 'Customer', field: 'customer', minWidth: 150, headerFilter: 'input', formatter: (c) => (c.getValue() ? esc(c.getValue()) : '<span class="muted">(no order)</span>') },
      { title: 'Status', field: 'state', width: 110, headerFilter: 'list', headerFilterParams: { values: { Closed: 'Closed', 'In progress': 'In progress' }, clearable: true } },
      { title: 'Closed', field: 'closedDate', width: 105 },
      { title: '$ impact', field: 'impact', hozAlign: 'right', sorter: 'number', width: 105, formatter: (c) => `<b>${money0(c.getValue())}</b>` },
      { title: '$ over', field: 'over', hozAlign: 'right', sorter: 'number', width: 95, formatter: (c) => (c.getValue() ? `<span class="neg-bad">${money0(c.getValue())}</span>` : '') },
      { title: '$ under', field: 'under', hozAlign: 'right', sorter: 'number', width: 95, formatter: (c) => (c.getValue() ? `<span class="neg-good">${money0(c.getValue())}</span>` : '') },
      { title: 'Net', field: 'net', hozAlign: 'right', sorter: 'number', width: 95, formatter: signed },
      { title: 'Labour $', field: 'labour', hozAlign: 'right', sorter: 'number', width: 100, formatter: signed, visible: false },
      { title: 'Material $', field: 'material', hozAlign: 'right', sorter: 'number', width: 105, formatter: signed, visible: false },
      { title: 'Lines', field: 'lines', hozAlign: 'right', sorter: 'number', width: 70 },
      { title: 'Biggest miss', field: 'miss', minWidth: 170, headerFilter: 'input', formatter: (c) => { const d = c.getRow().getData(); return d.miss ? `${esc(d.miss)} <span class="${cls(d.missDollars)}">${smoney0(d.missDollars)}</span>` : ''; } },
      { title: 'Post-mortem', field: 'pmStatus', minWidth: 150, headerFilter: 'list', headerFilterParams: { values: statusLabel, clearable: true }, formatter: (c) => { const d = c.getRow().getData(); return d.pmId ? `<a href="/postmortems/${d.pmId}"><span class="chip chip-status-${d.pmStatus}">${esc(statusLabel[d.pmStatus])}</span></a>` : `<a class="chip chip-status-flagged" href="/jobs/${encodeURIComponent(d.job)}">Flagged - review</a>`; } },
    ],
  });

  // column chooser
  const picker = document.getElementById('colPicker');
  table.on('tableBuilt', () => {
    if (!picker) return;
    picker.innerHTML = '';
    table.getColumns().forEach((col) => {
      const def = col.getDefinition();
      const id = 'col_' + def.field;
      const label = document.createElement('label');
      label.className = 'check';
      label.innerHTML = `<input type="checkbox" id="${id}" ${col.isVisible() ? 'checked' : ''}> ${esc(def.title)}`;
      label.querySelector('input').addEventListener('change', (e) => (e.target.checked ? col.show() : col.hide()));
      picker.appendChild(label);
    });
  });
});
