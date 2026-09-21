// Small formatters shared by every product page.
(function () {
  function duration(v) {
    if (!Number.isFinite(Number(v)) || v < 0) return '—';
    let s = Math.floor(v), d = Math.floor(s / 86400); s %= 86400;
    let h = Math.floor(s / 3600); s %= 3600;
    let m = Math.floor(s / 60); s %= 60;
    if (d) return `${d}d ${h}h ${m}m`;
    if (h) return `${h}h ${m}m ${s}s`;
    if (m) return `${m}m ${s}s`;
    return `${s}s`;
  }
  function startup(ms) {
    ms = Number(ms);
    if (!Number.isFinite(ms) || ms < 0) return '—';
    return ms < 10000 ? `${(ms / 1000).toFixed(2)}s` : `${(ms / 1000).toFixed(1)}s`;
  }
  window.MeowFormat = { duration, startup };
})();
