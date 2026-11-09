// Estimated vs actual hours by operation (Job Detail page and the printable report).
window.addEventListener('DOMContentLoaded', () => {
  const el = document.getElementById('opChart');
  const dataEl = document.getElementById('chartData');
  if (!el || !dataEl || !window.Chart) return;
  const d = JSON.parse(dataEl.textContent);
  if (!d.labels.length) return;
  const css = getComputedStyle(document.documentElement);
  const blue = css.getPropertyValue('--brand-2').trim();
  const red = css.getPropertyValue('--red').trim();
  const grey = '#b7c0cc';
  new Chart(el, {
    type: 'bar',
    data: {
      labels: d.labels,
      datasets: [
        { label: 'Estimated hrs', data: d.est, backgroundColor: grey },
        {
          label: 'Actual hrs',
          data: d.act,
          // actual bars turn red when over the estimate; open operations are lighter
          backgroundColor: d.act.map((a, i) => (d.counted[i] ? (a > d.est[i] ? red : blue) : '#9fb7d1')),
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: { y: { beginAtZero: true, title: { display: true, text: 'Hours' } } },
      plugins: { legend: { position: 'bottom' } },
    },
  });
});
