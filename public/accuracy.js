// Quote Accuracy pages: click a table row to go down a level, and the three charts
// (diverging bars of the biggest net variances, the trend of one group or customer, the customer quadrant).
// Colours are read from the page theme so the charts follow light / dark mode.

// ---- a whole table row is a link
document.addEventListener('click', (e) => {
  const tr = e.target.closest && e.target.closest('tr[data-href]');
  if (!tr || e.target.closest('a, button, input, select, label')) return;
  window.location.href = tr.getAttribute('data-href');
});

window.addEventListener('DOMContentLoaded', () => {
  if (!window.Chart) return;
  const read = (id) => {
    const el = document.getElementById(id);
    if (!el) return null;
    try {
      return JSON.parse(el.textContent);
    } catch {
      return null;
    }
  };
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  Chart.defaults.color = v('--chart-text');
  Chart.defaults.borderColor = v('--chart-grid');
  const money = (n) => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-CA');
  const pctText = (n) => `${n > 0 ? '+' : ''}${(n * 100).toFixed(1)}%`;
  const pointer = (e, active) => {
    if (e.native && e.native.target) e.native.target.style.cursor = active.length ? 'pointer' : 'default';
  };

  // ---- the biggest net variances: jobs over the estimate to the right (red), under the estimate to the left (blue)
  const div = read('divData');
  const divEl = document.getElementById('divChart');
  if (div && divEl) {
    new Chart(divEl, {
      type: 'bar',
      data: {
        labels: div.items.map((i) => i.label),
        datasets: [{ data: div.items.map((i) => i.net), backgroundColor: div.items.map((i) => (i.net > 0 ? v('--red') : v('--blue'))) }],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        scales: { x: { ticks: { callback: (val) => money(val) }, title: { display: true, text: '← Jobs under the estimate      Jobs over the estimate →' } }, y: { ticks: { autoSkip: false } } },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => `${c.parsed.x > 0 ? 'Over the estimate' : 'Under the estimate'}: ${money(c.parsed.x)} net` , afterLabel: () => 'Click to drill down' } },
        },
        onHover: pointer,
        onClick: (e, active) => {
          if (!active.length) return;
          const item = div.items[active[0].index];
          window.location.href = `/accuracy/ops?${div.base}&drill=${item.kind}:${encodeURIComponent(item.key)}#drill`;
        },
      },
    });
  }

  // ---- trend of variance % over time (for one operation / material / customer)
  const trend = read('trendData');
  const trendEl = document.getElementById('trendChart');
  if (trend && trendEl) {
    const pts = trend.points || [];
    if (!pts.length) {
      trendEl.parentElement.innerHTML = '<div class="empty">No dated work in this range.</div>';
    } else {
      const band = (sign) => pts.map(() => sign * trend.green * 100);
      new Chart(trendEl, {
        type: 'line',
        data: {
          labels: pts.map((p) => p.label),
          datasets: [
            { label: 'Variance %', data: pts.map((p) => (p.pct === null ? null : p.pct * 100)), borderColor: v('--link'), backgroundColor: v('--link'), pointRadius: 4, tension: 0, spanGaps: true, borderWidth: 2 },
            { label: 'Green band', data: band(1), borderColor: v('--muted'), borderDash: [5, 5], pointRadius: 0, borderWidth: 1 },
            { label: 'Green band ', data: band(-1), borderColor: v('--muted'), borderDash: [5, 5], pointRadius: 0, borderWidth: 1 },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          interaction: { mode: 'index', intersect: false },
          scales: { y: { ticks: { callback: (val) => `${val}%` }, title: { display: true, text: 'Variance %' } } },
          plugins: {
            legend: { display: false },
            tooltip: {
              filter: (item) => item.datasetIndex === 0,
              callbacks: {
                label: (c) => `Variance: ${c.parsed.y === null ? 'n/a' : pctText(c.parsed.y / 100)}`,
                afterLabel: (c) => `Net ${money(pts[c.dataIndex].netDollars)}, ${pts[c.dataIndex].lines} lines, ${(pts[c.dataIndex].pctOff * 100).toFixed(0)}% off`,
              },
            },
          },
        },
      });
    }
  }

  // ---- a customer's margin % per month / quarter, with its tier target as a dashed line
  const mg = read('marginData');
  const mgEl = document.getElementById('marginChart');
  if (mg && mgEl) {
    const pts = mg.points || [];
    if (!pts.length) {
      mgEl.parentElement.innerHTML = '<div class="empty">No closed, priced jobs in this range.</div>';
    } else {
      const pct1 = (n) => `${(n * 100).toFixed(1)}%`;
      new Chart(mgEl, {
        type: 'line',
        data: {
          labels: pts.map((p) => p.label),
          datasets: [
            { label: 'Margin %', data: pts.map((p) => (p.marginPct === null ? null : p.marginPct * 100)), borderColor: v('--link'), backgroundColor: v('--link'), pointRadius: 4, tension: 0, spanGaps: true, borderWidth: 2 },
            ...(mg.target === null || mg.target === undefined ? [] : [{ label: 'Target', data: pts.map(() => mg.target * 100), borderColor: v('--muted'), borderDash: [5, 5], pointRadius: 0, borderWidth: 1 }]),
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          interaction: { mode: 'index', intersect: false },
          scales: { y: { ticks: { callback: (val) => `${val}%` }, title: { display: true, text: 'Margin %' } } },
          plugins: {
            legend: { display: false },
            tooltip: {
              filter: (item) => item.datasetIndex === 0,
              callbacks: {
                label: (c) => `Margin: ${c.parsed.y === null ? 'n/a' : pct1(c.parsed.y / 100)}`,
                afterLabel: (c) => [`${money(pts[c.dataIndex].margin)} on ${money(pts[c.dataIndex].price)} sold`, `${pts[c.dataIndex].jobs} priced job${pts[c.dataIndex].jobs === 1 ? '' : 's'}`, mg.target === null || mg.target === undefined ? '' : `Target ${pct1(mg.target)}`].filter(Boolean),
              },
            },
          },
        },
      });
    }
  }

  // ---- a customer's Margin vs Target $ per month / quarter: one bar each, green above target, red short of it
  const vt = read('vsTargetData');
  const vtEl = document.getElementById('vsTargetChart');
  if (vt && vtEl) {
    const pts = vt.points || [];
    if (!pts.length) {
      vtEl.parentElement.innerHTML = '<div class="empty">No closed, priced jobs in this range.</div>';
    } else {
      new Chart(vtEl, {
        type: 'bar',
        data: {
          labels: pts.map((p) => p.label),
          datasets: [{ label: 'Margin vs Target $', data: pts.map((p) => p.vsTarget), backgroundColor: pts.map((p) => ((p.vsTarget ?? 0) < 0 ? v('--red') : v('--green'))) }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          scales: { y: { ticks: { callback: (val) => money(val) }, title: { display: true, text: 'Margin vs Target $' } } },
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: (c) => `${c.parsed.y < 0 ? 'Short of target' : 'Over target'}: ${money(Math.abs(c.parsed.y))}`,
                afterLabel: (c) => [`${money(pts[c.dataIndex].margin)} margin on ${money(pts[c.dataIndex].price)} sold`, `${pts[c.dataIndex].jobs} priced job${pts[c.dataIndex].jobs === 1 ? '' : 's'}`],
              },
            },
          },
        },
      });
    }
  }

  // ---- customer quadrant: how often off (across) vs how far and which way (up), bubble = job dollars
  const bub = read('bubbleData');
  const bubEl = document.getElementById('bubbleChart');
  if (bub && bubEl) {
    const maxD = Math.max(1, ...bub.points.map((p) => p.dollars));
    const radius = (p) => 6 + 24 * Math.sqrt(p.dollars / maxD);
    const mk = (list, colour) => ({
      data: list.map((p) => ({ x: p.x * 100, y: p.y * 100, r: radius(p), p })),
      backgroundColor: `color-mix(in srgb, ${colour} 55%, transparent)`,
      borderColor: colour,
      borderWidth: 1.5,
    });
    const lines = {
      id: 'quadrantLines',
      afterDatasetsDraw(chart) {
        const { ctx, chartArea: a, scales } = chart;
        ctx.save();
        ctx.strokeStyle = v('--muted');
        ctx.setLineDash([6, 5]);
        ctx.lineWidth = 1;
        const h = (y) => {
          const py = scales.y.getPixelForValue(y);
          if (py >= a.top && py <= a.bottom) {
            ctx.beginPath();
            ctx.moveTo(a.left, py);
            ctx.lineTo(a.right, py);
            ctx.stroke();
          }
        };
        h(bub.green * 100);
        h(-bub.green * 100);
        const px = scales.x.getPixelForValue(bub.shopOff * 100);
        if (px >= a.left && px <= a.right) {
          ctx.beginPath();
          ctx.moveTo(px, a.top);
          ctx.lineTo(px, a.bottom);
          ctx.stroke();
        }
        ctx.restore();
      },
    };
    // The chart sits in a fold that starts closed. It is drawn when the fold is first opened (a chart drawn inside a closed
    // fold has no size to draw at).
    const drawBubble = () => new Chart(bubEl, {
      type: 'bubble',
      data: {
        datasets: [
          { label: 'Needs attention', ...mk(bub.points.filter((p) => p.attention), v('--red')) },
          { label: 'Other customers', ...mk(bub.points.filter((p) => !p.attention), v('--blue')) },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        scales: {
          x: { min: 0, max: 100, ticks: { callback: (val) => `${val}%` }, title: { display: true, text: 'Share of jobs off  (how often)' } },
          y: { ticks: { callback: (val) => `${val}%` }, title: { display: true, text: 'Net variance %  (above 0 = over the estimate)' } },
        },
        plugins: {
          legend: { position: 'bottom' },
          tooltip: {
            callbacks: {
              title: (items) => items[0].raw.p.label,
              label: (c) => `${c.raw.p.jobs} jobs, ${c.raw.p.x * 100 > 0 ? (c.raw.p.x * 100).toFixed(0) : 0}% off, net ${pctText(c.raw.p.y)}, ${money(c.raw.p.dollars)} of work`,
              afterLabel: () => 'Click to open this customer',
            },
          },
        },
        onHover: pointer,
        onClick: (e, active) => {
          if (!active.length) return;
          const p = bubEl && Chart.getChart(bubEl).data.datasets[active[0].datasetIndex].data[active[0].index].p;
          if (p) window.location.href = `/accuracy/customers/${encodeURIComponent(p.key)}?${bub.base}`;
        },
      },
      plugins: [lines],
    });
    const fold = document.getElementById('bubbleFold');
    if (fold && !fold.open) {
      fold.addEventListener('toggle', () => {
        if (fold.open && !Chart.getChart(bubEl)) drawBubble();
      });
    } else {
      drawBubble();
    }
  }
});
