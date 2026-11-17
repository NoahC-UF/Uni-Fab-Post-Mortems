// Dashboard chart: flagged variance dollars by operation (over = red, under = blue).
// Colours are read from the page's theme (CSS variables) so the chart follows light / dark mode.
// Hover a bar: the three jobs that put the most into it. Click it: the Flagged Jobs page, filtered to every job behind it.
window.addEventListener('DOMContentLoaded', () => {
  const el = document.getElementById('byOp');
  const dataEl = document.getElementById('byOpData');
  if (!el || !dataEl || !window.Chart) return;
  const data = JSON.parse(dataEl.textContent);
  const rows = data.rows;
  const css = getComputedStyle(el);
  const v = (name) => css.getPropertyValue(name).trim();
  Chart.defaults.color = v('--chart-text');
  Chart.defaults.borderColor = v('--chart-grid');

  const KINDS = ['over', 'under']; // dataset 0 = over (red), dataset 1 = under (blue)
  const money = (n) => '$' + Math.round(n).toLocaleString('en-CA');
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const link = (label, kind) => `/jobs?from=${encodeURIComponent(data.from)}&to=${encodeURIComponent(data.to)}&lineOp=${encodeURIComponent(label)}&lineDir=${kind}`;

  new Chart(el, {
    type: 'bar',
    data: {
      labels: rows.map((r) => r.label),
      datasets: [
        { label: 'Over ($)', data: rows.map((r) => Math.round(r.over_dollars)), backgroundColor: v('--red') },
        { label: 'Under ($)', data: rows.map((r) => Math.round(r.under_dollars)), backgroundColor: v('--blue') },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: { x: { stacked: true }, y: { stacked: true, ticks: { callback: (val) => '$' + val.toLocaleString() } } },
      onHover: (e, active) => {
        if (e.native && e.native.target) e.native.target.style.cursor = active.length ? 'pointer' : 'default';
      },
      onClick: (e, active) => {
        if (!active.length) return;
        const { datasetIndex, index } = active[0];
        window.location.href = link(rows[index].label, KINDS[datasetIndex]);
      },
      plugins: {
        tooltip: {
          callbacks: {
            label: (c) => `${c.dataset.label}: ${money(c.parsed.y)}`,
            // the biggest jobs behind this part of the bar
            afterBody: (items) => {
              const c = items[0];
              const kind = KINDS[c.datasetIndex];
              const top = rows[c.dataIndex][kind === 'over' ? 'topOver' : 'topUnder'] || [];
              if (!top.length) return [];
              return ['', `Top ${top.length} job${top.length === 1 ? '' : 's'}:`, ...top.map((j) => `${j.job}  ${money(j.dollars)}${j.customer ? '  ' + clip(j.customer, 28) : ''}`)];
            },
            footer: () => ['', 'Click to Review All Related Jobs'],
          },
          footerFont: { weight: 'normal', style: 'italic' },
        },
      },
    },
  });
});
