// Estimated vs actual hours by operation (Job Detail page and the printable report).
// Colours are read from the page's theme (CSS variables) so the chart follows light / dark mode.
window.addEventListener('DOMContentLoaded', () => {
  const el = document.getElementById('opChart');
  const dataEl = document.getElementById('chartData');
  if (!el || !dataEl || !window.Chart) return;
  const d = JSON.parse(dataEl.textContent);
  if (!d.labels.length) return;
  const css = getComputedStyle(el); // the printable report keeps its own (paper) colours
  const v = (name) => css.getPropertyValue(name).trim();
  const blue = v('--brand-2');
  const red = v('--red');
  const text = v('--chart-text');
  const grid = v('--chart-grid');
  Chart.defaults.color = text;
  Chart.defaults.borderColor = grid;
  new Chart(el, {
    type: 'bar',
    data: {
      labels: d.labels,
      datasets: [
        { label: 'Estimated hrs', data: d.est, backgroundColor: v('--chart-est') },
        {
          label: 'Actual hrs',
          data: d.act,
          // actual bars turn red when over the estimate; open operations are lighter
          backgroundColor: d.act.map((a, i) => (d.counted[i] ? (a > d.est[i] ? red : blue) : v('--chart-open'))),
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: { y: { beginAtZero: true, title: { display: true, text: 'Hours', color: text }, grid: { color: grid } }, x: { grid: { color: grid } } },
      plugins: { legend: { position: 'bottom' } },
    },
  });
});
