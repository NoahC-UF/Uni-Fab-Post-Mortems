// The job table's columns and its Columns menu, shared by the Flagged Jobs grid and the Dashboard's Top 10.
// A person can show / hide columns (Columns menu), drag a column title to move it, and save the result as
// their own default. The saved choice is { visible: [fields], order: [every field in display order], widths: { field: px } }
// (widths only for columns they dragged wider or narrower).
window.UFJobColumns = (function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const rank = { red: 3, yellow: 2, green: 1 };
  const fmt0 = new Intl.NumberFormat('en-CA', { maximumFractionDigits: 0 });
  const money0 = (v) => (v === null || v === undefined ? '' : (v < 0 ? '-$' : '$') + fmt0.format(Math.abs(v)));
  const smoney0 = (v) => (v === null || v === undefined ? '' : v === 0 ? '$0' : (v > 0 ? '+$' : '-$') + fmt0.format(Math.abs(v)));
  const cls = (v) => (v > 0 ? 'neg-bad' : v < 0 ? 'neg-good' : 'muted');

  // A coloured dot instead of the word, to save space (the word is in the tooltip and for screen readers).
  const flagWord = { red: 'Red', yellow: 'Yellow', green: 'Green (within tolerance)' };
  const dot = (flag) => `<span class="flag-dot flag-dot-${esc(flag)}" role="img" aria-label="${esc(flagWord[flag] || flag)}" title="${esc(flagWord[flag] || flag)}"></span>`;
  const causeHint = {
    'Price / Set-Up': "The price was already below target margin against the job's own plan",
    Overrun: 'The plan was healthy; the job cost more than it said',
    'On Target': 'Margin meets the target',
    'No Price': 'No priced sales order for this job',
    'No Plan': 'The job has no planned cost',
  };
  const statusLabel = { flagged: 'Flagged', under_review: 'Under Review', root_cause_found: 'Root Cause Found', actions_assigned: 'Actions Assigned', closed: 'Closed', dismissed: 'Dismissed' };
  const signed = (cell) => {
    const v = cell.getValue();
    return v === null || v === undefined ? '' : `<span class="${cls(v)}">${smoney0(v)}</span>`;
  };

  /**
   * Every column, in the standard order. `show` = shown in the standard set (when the person has not saved their own).
   * options.standard: list of fields to show as the standard set instead (the Dashboard uses a shorter one).
   * options.filters = false: no filter boxes under the titles.
   * options.minColWidth: no column narrower than this many pixels (Settings > Table Appearance).
   */
  function create(target, options = {}) {
    // each job is compared with the target of its own customer's tier (targetMargin on the row); the page's default target is the fallback
    // Settings > Margin % Colours (options.bands = { bands: [{below, color}] lowest first, top }): the colour depends on how many points
    // the margin is from that target. Same rules as src/marginBands.js (rounding, 'below', text colour).
    const bands = options.bands && Array.isArray(options.bands.bands) ? options.bands : null;
    const bandStyle = (v, t) => {
      if (!bands || !bands.bands.length) return '';
      const diff = Math.round((Math.round(Number(v) * 1000) / 10 - Math.round(Number(t) * 1000) / 10) * 10) / 10;
      if (!Number.isFinite(diff)) return '';
      const hit = bands.bands.find((b) => diff < b.below);
      const colour = hit ? hit.color : bands.top;
      if (!colour || !/^#[0-9a-f]{6}$/i.test(colour)) return '';
      const n = parseInt(colour.slice(1), 16);
      const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
      const lum = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
      return `background:${colour};color:${lum > 0.4 ? '#111111' : '#ffffff'}`;
    };
    const marginPct = (v, cell) => {
      if (v === null || v === undefined) return '';
      const own = cell ? cell.getRow().getData().targetMargin : null;
      const t = own === null || own === undefined ? target : own;
      const style = bandStyle(v, t);
      if (style) {
        const d = Math.round((Math.round(v * 1000) / 10 - Math.round(t * 1000) / 10) * 10) / 10;
        return `<span class="band" style="${style}" title="Target ${(t * 100).toFixed(1)}%; ${Math.abs(d)} points ${d < 0 ? 'under' : 'over'} target">${(v * 100).toFixed(1)}%</span>`;
      }
      return `<span class="${v < t ? 'neg-bad' : ''}" title="Target ${(t * 100).toFixed(1)}%">${(v * 100).toFixed(1)}%</span>`;
    };
    const defs = [
      { show: true, title: 'Flag', field: 'flag', width: 84, hozAlign: 'center', formatter: (c) => dot(c.getValue()), sorter: (a, b) => (rank[a] || 0) - (rank[b] || 0), headerFilter: 'list', headerFilterParams: { values: { red: 'Red', yellow: 'Yellow', green: 'Green' }, clearable: true }, headerFilterFunc: (v, rv) => !v || v === rv },
      { show: true, title: 'Job', field: 'job', width: 100, formatter: (c) => `<a href="/jobs/${encodeURIComponent(c.getValue())}">${esc(c.getValue())}</a>`, headerFilter: 'input' },
      { show: true, title: 'Part', field: 'part', width: 130, headerFilter: 'input', formatter: (c) => `<span title="${esc(c.getRow().getData().partDesc)}">${esc(c.getValue())}</span>` },
      { show: true, title: 'Customer', field: 'customer', minWidth: 150, headerFilter: 'input', formatter: (c) => (c.getValue() ? esc(c.getValue()) : '<span class="muted">(no order)</span>') },
      { show: true, title: 'Status', field: 'state', width: 110, headerFilter: 'list', headerFilterParams: { values: { Closed: 'Closed', 'In progress': 'In Progress' }, clearable: true } },
      { show: true, title: 'Closed', field: 'closedDate', width: 105 },
      { show: true, title: '$ Impact', field: 'impact', hozAlign: 'right', sorter: 'number', width: 105, formatter: (c) => `<b>${money0(c.getValue())}</b>` },
      { show: true, title: '$ Over', field: 'over', hozAlign: 'right', sorter: 'number', width: 95, formatter: (c) => (c.getValue() ? `<span class="neg-bad">${money0(c.getValue())}</span>` : '') },
      { show: true, title: '$ Under', field: 'under', hozAlign: 'right', sorter: 'number', width: 95, formatter: (c) => (c.getValue() ? `<span class="neg-good">${money0(c.getValue())}</span>` : '') },
      { show: true, title: 'Net', field: 'net', hozAlign: 'right', sorter: 'number', width: 95, formatter: signed },
      { show: false, title: 'Labour $', field: 'labour', hozAlign: 'right', sorter: 'number', width: 100, formatter: signed },
      { show: false, title: 'Material $', field: 'material', hozAlign: 'right', sorter: 'number', width: 105, formatter: signed },
      { show: true, title: 'Lines', field: 'lines', hozAlign: 'right', sorter: 'number', width: 70 },
      // price and margin (CAD). Blank = the job has no priced sales order.
      { show: true, title: 'Sale Price', field: 'price', hozAlign: 'right', sorter: 'number', width: 105, formatter: (c) => (c.getValue() === null || c.getValue() === undefined ? '' : money0(c.getValue())) },
      { show: true, title: 'Planned Margin', field: 'plannedMarginPct', hozAlign: 'right', sorter: 'number', width: 115, formatter: (c) => marginPct(c.getValue(), c) },
      { show: true, title: 'Actual Margin', field: 'actualMarginPct', hozAlign: 'right', sorter: 'number', width: 110, formatter: (c) => marginPct(c.getValue(), c) },
      // only has numbers when the list was opened from a bar of the Dashboard chart
      { show: false, title: 'Matching Lines $', field: 'lineDollars', hozAlign: 'right', sorter: 'number', width: 130, formatter: (c) => (c.getValue() === null || c.getValue() === undefined ? '' : `<b>${money0(c.getValue())}</b>`) },
      { show: false, title: 'Actual Margin $', field: 'actualMargin', hozAlign: 'right', sorter: 'number', width: 120, formatter: (c) => (c.getValue() === null || c.getValue() === undefined ? '' : `<span class="${c.getValue() < 0 ? 'neg-bad' : ''}">${money0(c.getValue())}</span>`) },
      { show: true, title: 'Likely Cause', field: 'causeLabel', minWidth: 120, headerFilter: 'list', headerFilterParams: { values: { 'Price / Set-Up': 'Price / Set-Up', Overrun: 'Overrun', 'On Target': 'On Target', 'No Price': 'No Price', 'No Plan': 'No Plan' }, clearable: true }, formatter: (c) => (c.getValue() ? `<span title="${esc(causeHint[c.getValue()] || '')}">${esc(c.getValue())}</span>` : '') },
      { show: true, title: 'Biggest Miss', field: 'miss', minWidth: 170, headerFilter: 'input', formatter: (c) => { const d = c.getRow().getData(); return d.miss ? `${esc(d.miss)} <span class="${cls(d.missDollars)}">${smoney0(d.missDollars)}</span>` : ''; } },
      { show: true, title: 'Post-Mortem', field: 'pmStatus', minWidth: 150, headerFilter: 'list', headerFilterParams: { values: statusLabel, clearable: true }, formatter: (c) => { const d = c.getRow().getData(); return d.pmId ? `<a href="/postmortems/${d.pmId}"><span class="chip chip-status-${d.pmStatus}">${esc(statusLabel[d.pmStatus])}</span></a>` : `<a class="chip chip-status-flagged" href="/jobs/${encodeURIComponent(d.job)}">Flagged - Review</a>`; } },
    ];
    const result = defs.map((d) => {
      const def = { ...d };
      if (options.standard) def.show = options.standard.includes(d.field);
      if (options.minColWidth) {
        if (def.width) def.width = Math.max(def.width, options.minColWidth);
        if (def.minWidth) def.minWidth = Math.max(def.minWidth, options.minColWidth);
      }
      if (options.filters === false) {
        delete def.headerFilter;
        delete def.headerFilterParams;
        delete def.headerFilterFunc;
      }
      return def;
    });
    result.minColWidth = options.minColWidth || 0; // columnsFor keeps a saved width from going under it
    return result;
  }

  /** Column definitions for Tabulator: in the person's saved order, shown or hidden as they chose (or the standard set). */
  function columnsFor(defs, saved) {
    const order = saved && Array.isArray(saved.order) ? saved.order : defs.map((d) => d.field);
    const byField = new Map(defs.map((d) => [d.field, d]));
    const ordered = order.map((f) => byField.get(f)).filter(Boolean);
    for (const d of defs) if (!ordered.includes(d)) ordered.push(d);
    const widths = (saved && saved.widths) || {};
    return ordered.map(({ show, ...def }) => {
      const out = { ...def, visible: saved && Array.isArray(saved.visible) ? saved.visible.includes(def.field) : show };
      if (widths[def.field]) {
        out.width = widths[def.field]; // the width they set (never under the table's minimum from Settings)
        if (defs.minColWidth) out.width = Math.max(out.width, defs.minColWidth);
        out.minWidth = Math.min(def.minWidth || 40, out.width);
      }
      return out;
    });
  }

  /** The standard columns, in the standard order (what "Reset to standard" goes back to). */
  const standardColumns = (defs) => defs.map(({ show, ...def }) => ({ ...def, visible: show }));

  /** The Columns menu: tick boxes to show / hide, "Save as my default", "Reset to standard". Needs #colPicker, #colSave, #colReset, #colMsg. */
  function attachMenu(table, { defs, saveUrl, resetUrl, saved }) {
    const picker = document.getElementById('colPicker');
    const msg = document.getElementById('colMsg');
    const say = (t) => {
      if (msg) msg.textContent = t;
    };
    const token = (() => {
      try {
        return JSON.parse(document.body.getAttribute('hx-headers') || '{}')['x-csrf-token'] || '';
      } catch {
        return '';
      }
    })();
    const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': token }, body: JSON.stringify(body ?? {}) });

    // Widths the person has set by dragging a column's edge (start from the ones already saved).
    let widths = { ...((saved && saved.widths) || {}) };
    table.on('columnResized', (col) => {
      if (col.getField()) widths[col.getField()] = Math.round(col.getWidth());
      say('');
    });

    const dataColumns = () => table.getColumns().filter((c) => c.getField()); // not the tick-box column
    const order = () => dataColumns().map((c) => c.getField());
    const visibleFields = () => dataColumns().filter((c) => c.isVisible()).map((c) => c.getField());

    // The list follows the order on screen, so moving a column title moves its entry too.
    const buildPicker = () => {
      if (!picker) return;
      picker.innerHTML = '';
      dataColumns().forEach((col) => {
        const def = col.getDefinition();
        const label = document.createElement('label');
        label.className = 'check';
        label.innerHTML = `<input type="checkbox" id="col_${esc(def.field)}" ${col.isVisible() ? 'checked' : ''}> ${esc(def.title)}`;
        label.querySelector('input').addEventListener('change', (e) => {
          if (e.target.checked) col.show();
          else col.hide();
          say('');
        });
        picker.appendChild(label);
      });
    };
    table.on('tableBuilt', buildPicker);
    table.on('columnMoved', () => {
      buildPicker();
      say('');
    });

    document.getElementById('colSave')?.addEventListener('click', async () => {
      const cols = visibleFields();
      if (!cols.length) return say('Choose at least one column first.');
      try {
        const r = await post(saveUrl, { columns: cols, order: order(), widths });
        say(r.ok ? 'Saved. These columns will be shown, in this order and at these widths, every time.' : 'Could not save. Please try again.');
      } catch {
        say('Could not save. Please try again.');
      }
    });

    document.getElementById('colReset')?.addEventListener('click', async () => {
      try {
        const r = await post(resetUrl);
        if (!r.ok) return say('Could not reset. Please try again.');
      } catch {
        return say('Could not reset. Please try again.');
      }
      widths = {};
      table.setColumns(standardColumns(defs));
      buildPicker();
      say('Back to the standard columns.');
    });
  }

  /** The minimum column width set for this table in Settings (read from the page's CSS variable), or 0 for automatic. */
  const minColWidth = (el) => parseInt(getComputedStyle(el).getPropertyValue('--tbl-colw'), 10) || 0;

  return { create, columnsFor, attachMenu, minColWidth };
})();
