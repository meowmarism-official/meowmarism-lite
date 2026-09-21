// Chart drawing, hover, zoom and the range buttons.
function niceMax(v) { v = Math.max(1, Number(v) || 1); const p = 10 ** Math.floor(Math.log10(v)), n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; }
function chartTimeLabel(ts) { return chartRangeMs > 86_400_000 ? new Date(ts).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : fmtClock(ts, chartRangeMs <= 120000); }
function bindChart(c) {
  if (c.dataset.boundChart) return; c.dataset.boundChart = '1';
  c.addEventListener('mousemove', (e) => { const r = c.getBoundingClientRect(); const padL = 48, padR = 10; sharedHoverRatio = Math.max(0, Math.min(1, (e.clientX - r.left - padL) / Math.max(1, r.width - padL - padR))); scheduleChartDraw(true); });
  c.addEventListener('mouseleave', () => { sharedHoverRatio = null; scheduleChartDraw(true); });
  c.addEventListener('pointerdown', (e) => { const r = c.getBoundingClientRect(); chartDrag = { id:c.id, x:e.clientX-r.left, width:r.width }; try { c.setPointerCapture(e.pointerId); } catch (_) {} });
  c.addEventListener('pointerup', (e) => {
    if (!chartDrag || chartDrag.id !== c.id) return; const r=c.getBoundingClientRect(), end=e.clientX-r.left, start=chartDrag.x; chartDrag=null;
    if (Math.abs(end-start) < 22) return;
    const padL=48,padR=10, spanW=Math.max(1,r.width-padL-padR), a=Math.max(0,Math.min(1,(start-padL)/spanW)), b=Math.max(0,Math.min(1,(end-padL)/spanW));
    const lo=Math.min(a,b), hi=Math.max(a,b), currentEnd=chartLiveMode ? (rawHistory.at(-1)?.t || serverNow()) : (chartAnchorTime || rawHistory.at(-1)?.t || serverNow());
    const currentStart=currentEnd-chartRangeMs; chartAnchorTime=currentStart+hi*chartRangeMs; chartRangeMs=Math.max(10_000,Math.round(chartRangeMs*(hi-lo))); chartLiveMode=false; document.querySelectorAll('[data-range-ms]').forEach((x)=>x.classList.remove('active')); chartScaleState.clear(); updateHistoryModeUi(); scheduleChartDraw(true);
  });
  c.addEventListener('dblclick', () => { chartLiveMode=true; chartAnchorTime=null; updateHistoryModeUi(); scheduleChartDraw(true); });
}
function nearestPoint(points, target) {
  let lo = 0, hi = points.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (Number(points[mid].t) < target) lo = mid + 1; else hi = mid; }
  if (lo > 0 && Math.abs(Number(points[lo - 1].t) - target) < Math.abs(Number(points[lo].t) - target)) return points[lo - 1];
  return points[lo];
}
function hysteresisMax(canvasId, desired) {
  desired = niceMax(desired);
  const now = performance.now();
  const state = chartScaleState.get(canvasId) || { max: desired, lowSince: now };
  if (desired > state.max) { state.max = desired; state.lowSince = now; }
  else if (desired < state.max * .55) {
    if (now - state.lowSince > 6000) { state.max = desired; state.lowSince = now; }
  } else state.lowSince = now;
  chartScaleState.set(canvasId, state); return state.max;
}
function drawChart(canvasId, series, opts = {}) {
  const c = $(canvasId); if (!c || c.offsetParent === null) return; bindChart(c);
  const r = c.getBoundingClientRect(), dpr = devicePixelRatio || 1, w = Math.max(1, Math.floor(r.width * dpr)), h = Math.max(1, Math.floor(r.height * dpr));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const ctx = c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, r.width, r.height);
  const pad = { l: 48, r: 10, t: 10, b: 27 }, cw = Math.max(1, r.width - pad.l - pad.r), ch = Math.max(1, r.height - pad.t - pad.b);
  const all = chartHistoryForRange(chartRangeMs);
  if (!all.length) { ctx.fillStyle = '#68707b'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('Waiting for samples…', pad.l + cw / 2, pad.t + ch / 2); return; }
  const availableFirst = Number(all[0].t), availableLast = Number(all[all.length - 1].t);
  // Important: while the panel is still collecting its first range, start exactly where data starts.
  const tMax = availableLast;
  const tMin = Math.max(availableFirst, tMax - chartRangeMs);
  const span = Math.max(1, tMax - tMin);
  const points = all.filter((p) => Number(p.t) >= tMin && Number(p.t) <= tMax);
  let desiredMax = Math.max(1, ...series.flatMap((s) => points.map((p) => Number(s.get(p)) || 0)));
  let max = opts.max ?? hysteresisMax(canvasId, desiredMax); if (opts.max == null) max = hysteresisMax(canvasId, desiredMax);
  const min = opts.min ?? 0, yFormat = opts.yFormat || ((v) => String(Math.round(v)));
  ctx.font = '9px "Cascadia Mono",Consolas,monospace'; ctx.lineWidth = 1; ctx.fillStyle = '#68707b'; ctx.strokeStyle = '#24282d';
  for (let i = 0; i <= 4; i++) {
    const ratio = i / 4, y = pad.t + ch * ratio, val = max - (max - min) * ratio;
    ctx.beginPath(); ctx.moveTo(pad.l, y + .5); ctx.lineTo(pad.l + cw, y + .5); ctx.stroke();
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(yFormat(val), pad.l - 7, y);
  }
  for (let i = 0; i <= 4; i++) {
    const ratio = i / 4, x = pad.l + cw * ratio, ts = tMin + span * ratio;
    ctx.strokeStyle = '#202328'; ctx.beginPath(); ctx.moveTo(x + .5, pad.t); ctx.lineTo(x + .5, pad.t + ch); ctx.stroke();
    ctx.fillStyle = '#68707b'; ctx.textAlign = i === 0 ? 'left' : i === 4 ? 'right' : 'center'; ctx.textBaseline = 'top'; ctx.fillText(chartTimeLabel(ts), x, pad.t + ch + 8);
  }
  if (points.length < 2) { ctx.fillStyle = '#68707b'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('Collecting samples…', pad.l + cw / 2, pad.t + ch / 2); return; }
  const xFor = (t) => pad.l + ((Number(t) - tMin) / span) * cw;
  const yFor = (v) => pad.t + ch - ((Math.max(min, Math.min(max, Number(v) || 0)) - min) / (max - min || 1)) * ch;
  for (const ev of timelineEntries) {
    if (!['lag','crash','restart'].includes(ev.type) || ev.at < tMin || ev.at > tMax) continue;
    const x = xFor(ev.at); ctx.save(); ctx.strokeStyle = ev.type === 'crash' ? '#d76767' : ev.type === 'lag' ? '#d4a84f' : '#7895b5'; ctx.globalAlpha = .55; ctx.setLineDash([2,3]); ctx.beginPath(); ctx.moveTo(x,pad.t); ctx.lineTo(x,pad.t+ch); ctx.stroke(); ctx.restore();
  }
  for (const s of series) {
    ctx.strokeStyle = s.color; ctx.lineWidth = 1.4; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.beginPath(); let drew = false;
    for (const p of points) { const v = Number(s.get(p)); if (!Number.isFinite(v)) continue; const x = xFor(p.t), y = yFor(v); if (!drew) { ctx.moveTo(x, y); drew = true; } else ctx.lineTo(x, y); }
    ctx.stroke();
    const last = [...points].reverse().find((p) => Number.isFinite(Number(s.get(p))));
    if (last) { ctx.fillStyle = s.color; ctx.beginPath(); ctx.arc(xFor(last.t), yFor(s.get(last)), 2.4, 0, Math.PI * 2); ctx.fill(); }
  }
  const hover = sharedHoverRatio == null ? chartHover.get(canvasId) : { x: pad.l + sharedHoverRatio * cw };
  if (hover && hover.x >= pad.l && hover.x <= pad.l + cw) {
    const target = tMin + ((hover.x - pad.l) / cw) * span, p = nearestPoint(points, target), x = xFor(p.t);
    ctx.strokeStyle = '#626b76'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + ch); ctx.stroke(); ctx.setLineDash([]);
    const lines = [fmtClock(p.t, true), ...series.map((s) => {
      const smooth = Number(s.get(p)), raw = s.rawGet ? Number(s.rawGet(p)) : NaN;
      const main = (s.format || yFormat)(Number.isFinite(smooth) ? smooth : 0);
      return Number.isFinite(raw) && Math.abs(raw - smooth) > .05 ? `${s.label || 'Value'}  ${main} · raw ${(s.format || yFormat)(raw)}` : `${s.label || 'Value'}  ${main}`;
    })];
    ctx.font = '10px "Cascadia Mono",Consolas,monospace'; const boxW = Math.max(...lines.map((t) => ctx.measureText(t).width)) + 20, boxH = 10 + lines.length * 16;
    const boxX = Math.min(Math.max(pad.l + 4, x - boxW / 2), r.width - boxW - 5), boxY = pad.t + 5;
    ctx.fillStyle = 'rgba(12,13,15,.96)'; ctx.strokeStyle = '#3a4048'; ctx.lineWidth = 1; ctx.fillRect(boxX, boxY, boxW, boxH); ctx.strokeRect(boxX + .5, boxY + .5, boxW - 1, boxH - 1);
    lines.forEach((line, i) => { ctx.fillStyle = i === 0 ? '#9299a3' : series[i - 1]?.color || '#d9dce0'; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(line, boxX + 10, boxY + 7 + i * 16); });
  }
}
function redrawCharts() {
  drawChart('overviewChart', [
    { label: 'CPU', color: '#5f9ee8', get: (p) => p.cpu, rawGet: (p) => p.cpuRaw, format: pct },
    { label: 'RAM', color: '#9b83d7', get: (p) => p.ram, rawGet: (p) => p.ramRaw, format: pct },
  ], { max: 100, yFormat: (v) => `${Math.round(v)}%` });
  drawChart('perfCpuRamChart', [
    { label: 'CPU', color: '#5f9ee8', get: (p) => p.cpu, rawGet: (p) => p.cpuRaw, format: pct },
    { label: 'RAM', color: '#9b83d7', get: (p) => p.ram, rawGet: (p) => p.ramRaw, format: pct },
  ], { max: 100, yFormat: (v) => `${Math.round(v)}%` });
  drawChart('networkChart', [
    { label: 'RX', color: '#5cb6a4', get: (p) => p.rx, rawGet: (p) => p.rxRaw, format: fmtRate },
    { label: 'TX', color: '#d3a75c', get: (p) => p.tx, rawGet: (p) => p.txRaw, format: fmtRate },
  ], { yFormat: fmtRate });
  drawChart('playerChart', [{ label: 'Players', color: '#5f9ee8', get: (p) => p.players, format: (v) => String(Math.round(v)) }], { max: Math.max(1, latest?.players?.max || PLAYERS.peak() || 1), yFormat: (v) => String(Math.round(v)) });
}
function scheduleChartDraw(force = false) {
  if (chartDrawPending && !force) return;
  chartDrawPending = true;
  requestAnimationFrame(() => {
    const now = performance.now();
    if (!force && now - lastChartDrawAt < 70) { chartDrawPending = false; setTimeout(() => scheduleChartDraw(true), 70); return; }
    chartDrawPending = false; lastChartDrawAt = now; redrawCharts();
  });
}
window.addEventListener('resize', () => scheduleChartDraw(true));
document.querySelectorAll('[data-range-ms]').forEach((btn) => btn.addEventListener('click', () => {
  chartRangeMs = Number(btn.dataset.rangeMs) || 60000; chartLiveMode = true; chartAnchorTime = null;
  document.querySelectorAll('[data-range-ms]').forEach((b) => b.classList.toggle('active', Number(b.dataset.rangeMs) === chartRangeMs)); updateHistoryModeUi();
  chartScaleState.clear(); updateTelemetry(); scheduleChartDraw(true);
}));

function appendHistoryFromStats(payload) {
  if (!payload?.stats) return;
  const st = payload.stats;
  mergeAggregate(history1s, [{ t: st.sampledAt || serverNow(), samples: st.sampleWindow?.count || 0, cpu: st.cpu?.usage || 0, ram: st.memory?.percent || 0, disk: st.disk?.percent ?? null, procCpu: st.server?.cpuPercent ?? null, procRam: st.server?.rssMB ?? null, rx: st.network?.rxBps || 0, tx: st.network?.txBps || 0, players: st.players?.online || 0 }], 1000);
}
