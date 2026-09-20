// History line charts in the panel look: card with legend and range buttons, hover crosshair shared across charts. Shared by every product.
// cfg: { el, load(rangeMs) -> { points: [{ t, ... }] }, charts: [{ title, series: [{ key, label, color, format(v) }], max?, minMax?, hint? }], t, esc, isVisible() }
(function () {
  const RANGES = [['1m', 60e3], ['5m', 300e3], ['15m', 900e3], ['1h', 3600e3], ['24h', 86400e3], ['7d', 604800e3]];
  const PAD = { l: 48, r: 10, t: 10, b: 27 };
  const MONO = '"Cascadia Mono",Consolas,monospace';
  let hoverRatio = null;
  const instances = new Set();

  const niceMax = (v) => { v = Math.max(1, Number(v) || 1); const p = 10 ** Math.floor(Math.log10(v)), n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; };
  const clock = (ts, sec, long) => (long
    ? new Date(ts).toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', ...(sec ? { second: '2-digit' } : {}) }));

  function draw(canvas, pts, chart, range, t) {
    const r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    if (!r.width || !r.height) return;
    const w = Math.floor(r.width * dpr), h = Math.floor(r.height * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, r.width, r.height);
    const cw = Math.max(1, r.width - PAD.l - PAD.r), ch = Math.max(1, r.height - PAD.t - PAD.b);
    const info = (text) => { g.font = '11px system-ui,sans-serif'; g.fillStyle = '#68707b'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(t(text), PAD.l + cw / 2, PAD.t + ch / 2); };
    if (!pts.length) return info('Waiting for samples…');
    const tMax = pts[pts.length - 1].t, tMin = Math.max(pts[0].t, tMax - range), span = Math.max(1, tMax - tMin);
    const shown = pts.filter((p) => p.t >= tMin);
    const max = chart.max || niceMax(Math.max(chart.minMax || 1, ...chart.series.flatMap((s) => shown.map((p) => Number(p[s.key]) || 0))) * 1.1);
    const fmt = chart.series[0].format || ((v) => String(Math.round(v)));
    g.font = `9px ${MONO}`; g.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = PAD.t + (ch * i) / 4;
      g.strokeStyle = '#24282d'; g.beginPath(); g.moveTo(PAD.l, y + .5); g.lineTo(PAD.l + cw, y + .5); g.stroke();
      g.fillStyle = '#68707b'; g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillText(fmt(max - (max * i) / 4), PAD.l - 7, y);
    }
    for (let i = 0; i <= 4; i++) {
      const x = PAD.l + (cw * i) / 4;
      g.strokeStyle = '#202328'; g.beginPath(); g.moveTo(x + .5, PAD.t); g.lineTo(x + .5, PAD.t + ch); g.stroke();
      g.fillStyle = '#68707b'; g.textAlign = i === 0 ? 'left' : i === 4 ? 'right' : 'center'; g.textBaseline = 'top';
      g.fillText(clock(tMin + (span * i) / 4, span <= 900e3, span > 86400e3), x, PAD.t + ch + 8);
    }
    if (shown.length < 2) return info('Collecting samples…');
    const X = (ts) => PAD.l + ((ts - tMin) / span) * cw;
    const Y = (v) => PAD.t + ch - (Math.max(0, Math.min(max, Number(v) || 0)) / max) * ch;
    for (const s of chart.series) {
      g.strokeStyle = s.color; g.lineWidth = 1.4; g.lineJoin = 'round'; g.lineCap = 'round'; g.beginPath();
      let started = false;
      for (const p of shown) { const v = Number(p[s.key]); if (!Number.isFinite(v)) continue; if (started) g.lineTo(X(p.t), Y(v)); else { g.moveTo(X(p.t), Y(v)); started = true; } }
      g.stroke();
      const last = shown[shown.length - 1];
      g.fillStyle = s.color; g.beginPath(); g.arc(X(last.t), Y(last[s.key]), 2.4, 0, Math.PI * 2); g.fill();
    }
    if (hoverRatio == null) return;
    const target = tMin + hoverRatio * span;
    const p = shown.reduce((a, b) => (Math.abs(b.t - target) < Math.abs(a.t - target) ? b : a));
    const x = X(p.t);
    g.strokeStyle = '#626b76'; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(x, PAD.t); g.lineTo(x, PAD.t + ch); g.stroke(); g.setLineDash([]);
    const lines = [clock(p.t, true), ...chart.series.map((s) => `${t(s.label)}  ${(s.format || fmt)(Number(p[s.key]) || 0)}`)];
    g.font = `10px ${MONO}`;
    const bw = Math.max(...lines.map((l) => g.measureText(l).width)) + 20, bh = 10 + lines.length * 16;
    const bx = Math.min(Math.max(PAD.l + 4, x - bw / 2), r.width - bw - 5), by = PAD.t + 5;
    g.fillStyle = 'rgba(12,13,15,.96)'; g.strokeStyle = '#3a4048'; g.fillRect(bx, by, bw, bh); g.strokeRect(bx + .5, by + .5, bw - 1, bh - 1);
    lines.forEach((l, i) => { g.fillStyle = i === 0 ? '#9299a3' : chart.series[i - 1].color; g.textAlign = 'left'; g.textBaseline = 'top'; g.fillText(l, bx + 10, by + 7 + i * 16); });
  }

  function mount(cfg) {
    const { t, esc } = cfg;
    let range = RANGES[1][1];
    let points = [];
    const ranges = () => `<div class="chart-range">${RANGES.map(([l, ms]) => `<button class="range-btn${ms === range ? ' active' : ''}" data-ch-range="${ms}">${l}</button>`).join('')}</div>`;
    cfg.el.innerHTML = `<div class="grid">${cfg.charts.map((c, i) => `
      <article class="card span-12"><div class="card-head"><div class="card-title">${esc(t(c.title))}</div><div class="chart-head-right">
        <div class="chart-legend">${c.series.map((s) => `<span><i class="legend-dot" style="background:${s.color}"></i>${esc(t(s.label))}</span>`).join('')}</div>${ranges()}</div></div>
        <div class="card-body"><div class="chart-host"><canvas class="chart" data-ch-canvas="${i}"></canvas></div>${c.hint ? `<div class="chart-hint">${esc(t(c.hint))}</div>` : ''}</div></article>`).join('')}</div>`;
    const canvases = [...cfg.el.querySelectorAll('[data-ch-canvas]')];

    function render() { canvases.forEach((cv, i) => draw(cv, points, cfg.charts[i], range, t)); }
    async function load() { try { points = (await cfg.load(range)).points || []; } catch (_) { points = []; } render(); }
    canvases.forEach((cv) => {
      cv.addEventListener('mousemove', (e) => { const r = cv.getBoundingClientRect(); hoverRatio = Math.max(0, Math.min(1, (e.clientX - r.left - PAD.l) / Math.max(1, r.width - PAD.l - PAD.r))); instances.forEach((i) => i.render()); });
      cv.addEventListener('mouseleave', () => { hoverRatio = null; instances.forEach((i) => i.render()); });
    });
    cfg.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-ch-range]');
      if (!b) return;
      range = Number(b.dataset.chRange);
      cfg.el.querySelectorAll('[data-ch-range]').forEach((x) => x.classList.toggle('active', Number(x.dataset.chRange) === range));
      load();
    });
    const self = { load, render: () => { if (cfg.isVisible()) render(); } };
    instances.add(self);
    window.addEventListener('resize', self.render);
    setInterval(() => { if (cfg.isVisible()) load(); }, 5000);
    return self;
  }
  window.MeowCharts = { mount };
})();
