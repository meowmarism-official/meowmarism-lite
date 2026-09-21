// Formatting helpers.
function fmtDuration(v) { return MeowFormat.duration(v); }
function fmtDate(ts) { return ts ? new Date(ts).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'; }
function fmtClock(ts, withSeconds = true) { return ts ? new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}) }) : '—'; }
function fmtGB(v) { return Number.isFinite(Number(v)) ? `${Number(v).toFixed(1)} GB` : '—'; }
function fmtMB(v) { return Number.isFinite(Number(v)) ? `${Number(v).toFixed(0)} MB` : '—'; }
function fmtRate(v) {
  v = Number(v); if (!Number.isFinite(v)) return '—';
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(2)} GB/s`;
  if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(1)} MB/s`;
  if (v >= 1024) return `${(v / 1024).toFixed(1)} KB/s`;
  return `${Math.round(v)} B/s`;
}
function fmtBytes(v) {
  v = Number(v); if (!Number.isFinite(v)) return '—';
  if (v >= 1024 ** 4) return `${(v / 1024 ** 4).toFixed(2)} TB`;
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(2)} GB`;
  if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(1)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${Math.round(v)} B`;
}
function fmtStartup(ms) { return MeowFormat.startup(ms); }
function pct(v) { v = Number(v); return Number.isFinite(v) ? `${v.toFixed(1)}%` : '—'; }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function rangeLabel(ms) { return ms === 60000 ? '1 min' : ms === 300000 ? '5 min' : ms === 900000 ? '15 min' : ms === 3600000 ? '1 hour' : ms === 86400000 ? '24 hours' : '7 days'; }
function serverNow() { return Date.now() + (clockSynced ? clockOffsetMs : 0); }

function setBar(id, value, peak = null) {
  const fill = $(id); if (!fill) return;
  const n = Math.max(0, Math.min(100, Number(value) || 0));
  fill.style.width = `${n}%`;
  const host = fill.parentElement;
  if (!host) return;
  let marker = host.querySelector('.peak-hold');
  if (!marker) { marker = document.createElement('i'); marker.className = 'peak-hold'; host.appendChild(marker); }
  const p = Math.max(0, Math.min(100, Number(peak) || 0));
  marker.style.left = `calc(${p}% - .5px)`;
  marker.style.opacity = p > 0 ? '.65' : '0';
}
