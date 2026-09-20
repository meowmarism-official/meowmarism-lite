// System page: host, memory, disk and uptime of the machine running the panel. Shared by every product.
// cfg: { el, load() -> system info, t, esc }
(function () {
  const dur = (sec) => {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${sec % 60}s`;
  };
  const gb = (v) => (Number.isFinite(Number(v)) ? `${Number(v).toFixed(1)} GB` : '—');

  function mount(cfg) {
    const { esc, t } = cfg;
    const rows = (list) => list.map(([k, v]) => `<div class="kv-row"><div class="kv-key">${esc(t(k))}</div><div class="kv-val">${esc(v == null || v === '' ? '—' : v)}</div></div>`).join('');
    async function load() {
      let s;
      try { s = await cfg.load(); } catch (_) { return; }
      const mem = s.memory || {};
      const disk = s.disk;
      cfg.el.innerHTML = `
        <div class="card"><div class="card-title">${esc(t('Uptime'))}</div>${rows([['Host', dur(s.hostUptimeSec)], ['Panel', dur(s.panelUptimeSec)]])}</div>
        <div class="card"><div class="card-title">${esc(t('Host'))}</div>${rows([
          ['Hostname', s.hostname], ['Operating system', s.os], ['Architecture', s.arch], ['CPU', s.cpu], ['Logical cores', s.cores],
          ['Load 1 / 5 / 15m', Array.isArray(s.load) ? s.load.join(' / ') : null],
          ['Memory', `${gb(mem.usedGB)} / ${gb(mem.totalGB)}`],
          ['Disk free', disk ? `${gb(disk.freeGB)} / ${gb(disk.totalGB)}` : null],
          ['Node', s.node], ...(s.docker ? [['Docker', s.docker]] : []),
        ])}</div>`;
    }
    return { load };
  }
  window.MeowSystem = { mount };
})();
