// Stacked line charts with a range selector. Shared by every product.
// cfg: { el, load(rangeMs) -> { points: [{ t, ... }] }, charts: [{ key, title, color, format(v), max?, minMax? }], t, esc, isVisible() }
(function () {
  const RANGES = [['1m', 60e3], ['5m', 300e3], ['15m', 900e3], ['1h', 3600e3], ['24h', 86400e3], ['7d', 604800e3]];

  function draw(canvas, pts, chart, rangeMs) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const g = canvas.getContext('2d');
    g.scale(dpr, dpr);
    const css = getComputedStyle(canvas);
    const muted = css.getPropertyValue('--muted').trim() || 'rgba(255,255,255,.45)';
    const now = Date.now(), from = now - rangeMs;
    const vals = pts.map((p) => p[chart.key]);
    const max = chart.max || Math.max(chart.minMax || 1, ...vals) * 1.15;
    const padL = 44, padB = 18, padT = 6;
    const X = (t) => padL + ((t - from) / rangeMs) * (w - padL - 6);
    const Y = (v) => padT + (1 - Math.min(v, max) / max) * (h - padT - padB);
    g.font = '11px system-ui,sans-serif';
    g.fillStyle = muted; g.strokeStyle = 'rgba(255,255,255,.07)'; g.lineWidth = 1;
    for (let i = 0; i <= 3; i++) {
      const v = (max / 3) * i, y = Y(v);
      g.beginPath(); g.moveTo(padL, y); g.lineTo(w - 6, y); g.stroke();
      g.textAlign = 'right'; g.fillText(chart.format ? chart.format(v) : String(Math.round(v)), padL - 6, y + 4);
    }
    g.textAlign = 'left'; g.fillText(`-${RANGES.find((r) => r[1] === rangeMs)?.[0] || ''}`, padL, h - 4);
    g.textAlign = 'right'; g.fillText('now', w - 6, h - 4);
    if (!pts.length) return;
    g.beginPath();
    pts.forEach((p, i) => (i ? g.lineTo(X(p.t), Y(p[chart.key])) : g.moveTo(X(p.t), Y(p[chart.key]))));
    g.strokeStyle = chart.color; g.lineWidth = 2; g.stroke();
    g.lineTo(X(pts[pts.length - 1].t), Y(0)); g.lineTo(X(pts[0].t), Y(0)); g.closePath();
    g.globalAlpha = 0.12; g.fillStyle = chart.color; g.fill(); g.globalAlpha = 1;
  }

  function mount(cfg) {
    const { t, esc } = cfg;
    let range = RANGES[1][1];
    let points = [];
    cfg.el.innerHTML = `<div class="ch-bar">${RANGES.map(([l, ms]) => `<button class="btn ${ms === range ? 'primary' : ''}" data-ch-range="${ms}">${l}</button>`).join('')}</div>
      ${cfg.charts.map((c) => `<div class="card ch-card"><div class="ch-head"><span>${esc(t(c.title))}</span><span class="ch-now" data-ch-now="${c.key}">—</span></div><canvas class="ch-canvas" data-ch-canvas="${c.key}"></canvas></div>`).join('')}`;

    function render() {
      for (const c of cfg.charts) {
        const canvas = cfg.el.querySelector(`[data-ch-canvas="${c.key}"]`);
        draw(canvas, points, c, range);
        const last = points[points.length - 1];
        cfg.el.querySelector(`[data-ch-now="${c.key}"]`).textContent = last ? (c.format ? c.format(last[c.key]) : String(Math.round(last[c.key]))) : '—';
      }
    }
    async function load() { try { points = (await cfg.load(range)).points || []; } catch (_) { points = []; } render(); }
    cfg.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-ch-range]');
      if (!b) return;
      range = Number(b.dataset.chRange);
      cfg.el.querySelectorAll('[data-ch-range]').forEach((x) => x.classList.toggle('primary', x === b));
      load();
    });
    window.addEventListener('resize', () => { if (cfg.isVisible()) render(); });
    setInterval(() => { if (cfg.isVisible()) load(); }, 5000);
    return { load };
  }
  window.MeowCharts = { mount };
})();
