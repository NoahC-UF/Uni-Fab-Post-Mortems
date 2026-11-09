// Dashboard chart: flagged variance dollars by operation (over = red, under = blue).
window.addEventListener('DOMContentLoaded', () => {
  const el = document.getElementById('byOp');
  const dataEl = document.getElementById('byOpData');
  if (!el || !dataEl || !window.Chart) return;
  const rows = JSON.parse(dataEl.textContent);
  const css = getComputedStyle(document.documentElement);
  new Chart(el, {
    type: 'bar',
    data: {
      labels: rows.map((r) => r.label),
      datasets: [
        { label: 'Over ($)', data: rows.map((r) => Math.round(r.over_dollars)), backgroundColor: css.getPropertyValue('--red').trim() },
        { label: 'Under ($)', data: rows.map((r) => Math.round(r.under_dollars)), backgroundColor: css.getPropertyValue('--blue').trim() },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: { x: { stacked: true }, y: { stacked: true, ticks: { callback: (v) => '$' + v.toLocaleString() } } },
      plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: $${c.parsed.y.toLocaleString()}` } } },
    },
  });
});
