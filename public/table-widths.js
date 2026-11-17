// Resizable columns for plain tables (the Job Study page): drag the right edge of a column title.
// "Save Column Widths" keeps the widths for the person (any computer); "Reset Column Widths" goes back to the standard ones.
// Widths are kept per table, by column title.
window.addEventListener('DOMContentLoaded', () => {
  const tables = [...document.querySelectorAll('table[data-resize][data-table]')];
  if (!tables.length) return;
  const MIN = 30;
  let widths = {};
  try {
    widths = JSON.parse(document.getElementById('savedWidths')?.textContent || '{}') || {};
  } catch {
    widths = {};
  }
  const msg = document.getElementById('wMsg');
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

  const heads = (table) => (table.tHead && table.tHead.rows[0] ? [...table.tHead.rows[0].cells] : []);
  const labelOf = (th) => th.textContent.replace(/\s+/g, ' ').trim();
  // the heat map's job-number columns are narrow on purpose; every other column can be resized
  const resizable = (th) => labelOf(th) !== '' && !th.classList.contains('hm-head');
  const minFromSettings = (table) => parseInt(getComputedStyle(table).getPropertyValue('--tbl-colw'), 10) || 0;

  // Set (or clear, with px = null) the width of one column: its title and every cell under it.
  const setWidth = (table, idx, px) => {
    const n = heads(table).length;
    for (const row of table.rows) {
      if (row.cells.length !== n) continue; // a note or total row that spans columns
      const cell = row.cells[idx];
      if (px === null) {
        cell.style.width = cell.style.minWidth = cell.style.whiteSpace = '';
      } else {
        const w = Math.max(px, minFromSettings(table));
        cell.style.width = cell.style.minWidth = `${w}px`;
        cell.style.whiteSpace = 'normal'; // narrower than its text: wrap rather than push the column wider
      }
    }
  };

  for (const table of tables) {
    const id = table.dataset.table;
    heads(table).forEach((th, idx) => {
      if (!resizable(th)) return;
      const label = labelOf(th);
      const saved = widths[id] && widths[id][label];
      if (saved) setWidth(table, idx, saved);
      const grip = document.createElement('span');
      grip.className = 'col-resizer';
      grip.setAttribute('aria-hidden', 'true');
      th.appendChild(grip);
      grip.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startW = th.getBoundingClientRect().width;
        let now = Math.round(startW);
        grip.classList.add('on');
        const move = (ev) => {
          now = Math.max(MIN, Math.round(startW + ev.clientX - startX));
          setWidth(table, idx, now);
        };
        const up = () => {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          grip.classList.remove('on');
          now = Math.round(th.getBoundingClientRect().width); // what it really is: a column cannot go narrower than its own contents
          if (now !== Math.round(startW)) {
            (widths[id] = widths[id] || {})[label] = now;
            say('');
          }
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
      grip.addEventListener('click', (e) => e.stopPropagation()); // not a click on the title
    });
  }

  document.getElementById('wSave')?.addEventListener('click', async () => {
    try {
      const r = await post('/study/widths', { widths });
      say(r.ok ? 'Saved. These column widths will be used every time.' : 'Could not save. Please try again.');
    } catch {
      say('Could not save. Please try again.');
    }
  });

  document.getElementById('wReset')?.addEventListener('click', async () => {
    try {
      const r = await post('/study/widths/reset');
      if (!r.ok) return say('Could not reset. Please try again.');
    } catch {
      return say('Could not reset. Please try again.');
    }
    widths = {};
    for (const table of tables) heads(table).forEach((th, idx) => resizable(th) && setWidth(table, idx, null));
    say('Back to the standard widths.');
  });
});
