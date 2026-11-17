// Job Study: (1) the operation-by-job heat map can show hours, % or dollars; (2) a line graph of planned
// vs actual margin for each job, in close-date order. Chart colours come from the page theme; when printing
// (always light) the chart is redrawn in light colours.

// ---- heat map: switch what the squares show. Every square carries all three numbers and its colour strength for each view.
window.addEventListener('DOMContentLoaded', () => {
  const select = document.getElementById('hmMode');
  const table = document.getElementById('heatmap');
  if (!select || !table) return;
  const WHAT = {
    hrs: 'Hours: actual minus expected hours.',
    pct: 'Percent: actual hours against expected hours.',
    usd: 'Dollars: labour cost of those hours (variance dollars).',
  };
  const fmt = {
    hrs: (v) => `${v > 0 ? '+' : ''}${Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10}`,
    pct: (v) => `${Math.round(v * 100)}%`,
    usd: (v) => {
      const a = Math.abs(v);
      const s = a >= 10000 ? `${Math.round(a / 1000)}k` : Math.round(a).toLocaleString('en-CA');
      return `${v > 0 ? '+' : v < 0 ? '-' : ''}$${s}`;
    },
  };
  const apply = (mode) => {
    if (!WHAT[mode]) mode = 'hrs';
    for (const td of table.querySelectorAll('td.hm-cell[data-hrs]')) {
      const raw = td.getAttribute(`data-${mode}`);
      if (raw === '' || raw === null) {
        td.textContent = '·'; // e.g. no expected hours, so no percent
        td.style.background = '';
        continue;
      }
      const v = Number(raw);
      td.textContent = fmt[mode](v);
      const dir = td.getAttribute(`data-d-${mode}`);
      const shade = Number(td.getAttribute(`data-sh-${mode}`)) || 0;
      td.style.background = dir === 'zero' || shade === 0 ? '' : `color-mix(in srgb, ${dir === 'over' ? 'var(--red)' : 'var(--blue)'} ${shade}%, transparent)`;
    }
    const what = document.getElementById('hmWhat');
    if (what) what.textContent = WHAT[mode];
  };
  let saved = null;
  try {
    saved = localStorage.getItem('uf-heatmap-mode');
  } catch {
    /* private window etc.: just use the default */
  }
  if (saved && WHAT[saved]) select.value = saved;
  apply(select.value);
  select.addEventListener('change', () => {
    apply(select.value);
    try {
      localStorage.setItem('uf-heatmap-mode', select.value);
    } catch {
      /* not saved; fine */
    }
  });
});

// ---- margin line graph
window.addEventListener('DOMContentLoaded', () => {
  const el = document.getElementById('marginChart');
  const dataEl = document.getElementById('marginChartData');
  if (!el || !dataEl || !window.Chart) return;
  const d = JSON.parse(dataEl.textContent);
  if (!d.labels.length) return;

  const colours = () => {
    const css = getComputedStyle(document.documentElement);
    const v = (n) => css.getPropertyValue(n).trim();
    return { planned: v('--link'), actual: v('--tile-yellow') || v('--yellow'), goal: v('--muted'), text: v('--chart-text'), grid: v('--chart-grid') };
  };
  const c0 = colours();
  Chart.defaults.color = c0.text;
  Chart.defaults.borderColor = c0.grid;

  const line = (label, data, colour, extra = {}) => ({ label, data, borderColor: colour, backgroundColor: colour, pointBackgroundColor: colour, tension: 0, borderWidth: 2, pointRadius: 4, pointHoverRadius: 6, spanGaps: true, ...extra });
  const chart = new Chart(el, {
    type: 'line',
    data: {
      labels: d.labels,
      datasets: [
        line('Planned margin (set-up)', d.planned, c0.planned),
        line('Actual margin', d.actual, c0.actual),
        line(Array.isArray(d.goals) && new Set(d.goals).size > 1 ? `Goal (by customer tier, ${d.target}% on average)` : `Goal (${d.target}%)`, Array.isArray(d.goals) && d.goals.length === d.labels.length ? d.goals : d.labels.map(() => d.target), c0.goal, { borderDash: [6, 5], pointRadius: 0, pointHoverRadius: 0, borderWidth: 1.5 }),
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        y: { title: { display: true, text: 'Margin %', color: c0.text }, ticks: { callback: (v) => `${v}%` }, grid: { color: c0.grid } },
        x: { ticks: { maxRotation: 70, minRotation: 45, autoSkip: false, font: { size: 10 } }, grid: { color: c0.grid } },
      },
      plugins: {
        legend: { position: 'bottom' },
        tooltip: {
          callbacks: {
            title: (items) => {
              const i = items[0].dataIndex;
              return `Job ${d.labels[i]}${d.closed[i] ? ` · closed ${d.closed[i]}` : ''}`;
            },
            afterTitle: (items) => d.parts[items[0].dataIndex] || '',
            label: (c) => `${c.dataset.label}: ${Number(c.parsed.y).toFixed(1)}%`,
          },
        },
      },
    },
  });

  // Printing is on white paper: redraw with the light theme's colours, then put the screen colours back.
  const recolour = () => {
    const c = colours();
    Chart.defaults.color = c.text;
    chart.data.datasets[0].borderColor = chart.data.datasets[0].backgroundColor = chart.data.datasets[0].pointBackgroundColor = c.planned;
    chart.data.datasets[1].borderColor = chart.data.datasets[1].backgroundColor = chart.data.datasets[1].pointBackgroundColor = c.actual;
    chart.data.datasets[2].borderColor = chart.data.datasets[2].backgroundColor = chart.data.datasets[2].pointBackgroundColor = c.goal;
    for (const axis of ['x', 'y']) {
      chart.options.scales[axis].grid.color = c.grid;
      chart.options.scales[axis].ticks.color = c.text;
    }
    chart.options.scales.y.title.color = c.text;
    chart.options.plugins.legend.labels = { color: c.text };
    chart.update();
  };
  window.addEventListener('beforeprint', recolour); // the page's own handler has already switched to light
  window.addEventListener('afterprint', recolour);
});
