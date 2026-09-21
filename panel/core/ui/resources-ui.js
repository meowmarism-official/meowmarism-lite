// Overview and Performance pages: status strip, resource cards and the Minecraft card. Shared by every product.
// mountOverview({ el, t, chart, side }) and mountPerformance({ el, t, chart, cards }); update() only touches the fields it is given.
// Numbers are formatted here; text / detail override the formatted strings.
(function () {
  const RANGES = [['60000', '1m'], ['300000', '5m'], ['900000', '15m'], ['3600000', '1h'], ['86400000', '24h'], ['604800000', '7d']];
  const DASH = '—';

  const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
  const pct = (v) => (num(v) == null ? DASH : `${num(v).toFixed(1)}%`);
  const gb = (v) => (num(v) == null ? DASH : `${num(v).toFixed(1)} GB`);
  const sample = (s) => `1s avg ${pct(s.avg)} · min ${pct(s.min)} · peak ${pct(s.max)}`;

  function chartCard({ title, canvasId, hint, span = 8, t = (s) => s }) {
    const ranges = RANGES.map(([ms, label], i) => `<button class="range-btn${i === 0 ? ' active' : ''}" data-range-ms="${ms}">${label}</button>`).join('');
    return `<article class="card span-${span}"><div class="card-head"><div class="card-title">${t(title)}</div><div class="chart-head-right"><div class="chart-legend"><span><i class="legend-dot"></i>CPU</span><span><i class="legend-dot ram"></i>RAM</span></div><div class="chart-range">${ranges}</div></div></div><div class="card-body"><div class="chart-host"><canvas class="chart" id="${canvasId}"></canvas></div><div class="chart-hint">${t(hint)}</div></div></article>`;
  }

  function writer(el) {
    const set = (id, value) => { const node = el.querySelector(`#${id}`); if (node && value !== undefined) node.textContent = value; };
    const bar = (id, value, peak) => {
      const fill = el.querySelector(`#${id}`); if (!fill) return;
      fill.style.width = `${Math.max(0, Math.min(100, Number(value) || 0))}%`;
      let marker = fill.parentElement.querySelector('.peak-hold');
      if (!marker) { marker = document.createElement('i'); marker.className = 'peak-hold'; fill.parentElement.appendChild(marker); }
      const p = Math.max(0, Math.min(100, Number(peak) || 0));
      marker.style.left = `calc(${p}% - .5px)`;
      marker.style.opacity = p > 0 ? '.65' : '0';
    };
    return { set, bar };
  }

  function minecraftCard(t) {
    const row = (label, id) => `<tr><td>${t(label)}</td><td id="${id}">${DASH}</td></tr>`;
    return `<article class="card span-4"><div class="card-head"><div class="card-title">Minecraft</div></div><div class="card-body"><table class="metric-table">${[
      ['Version', 'mcVersion'], ['Port', 'mcPort'], ['Gamemode', 'mcGamemode'], ['Difficulty', 'mcDifficulty'], ['View distance', 'mcViewDistance'],
      ['PvP', 'mcPvp'], ['Whitelist', 'mcWhitelist'], ['TPS', 'mcTps'],
    ].map(([label, id]) => row(label, id)).join('')}<tr><td>${t('MOTD')}</td><td id="mcMotd" title="">${DASH}</td></tr></table></div></article>`;
  }

  // cfg.chart / cfg.side: HTML for the history card and the right-hand card (defaults: canvas card, Minecraft card).
  function mountOverview(cfg) {
    const t = cfg.t || ((s) => s);
    const cell = (label, big, small) => `<div class="status-cell"><div class="status-kicker">${t(label)}</div><div class="big-value" id="${big[0]}">${big[1]}</div>${small}</div>`;
    cfg.el.innerHTML = `
        <div class="status-strip" id="statusStrip">
          <div class="status-main"><div class="status-kicker">${t('Server status')}</div><div class="status-state"><span class="state-dot"></span><span id="statusState">${t('Offline')}</span></div><div class="status-note" id="statusNote">${t('Server is not running')}</div></div>
          ${cell('Server uptime', ['serverUptime', DASH], `<div class="small-value" id="serverStarted">${t('not started')}</div>`)}
          ${cell('Players', ['overviewPlayers', `0 / ${DASH}`], `<div class="small-value">${t('currently online')}</div>`)}
          ${cell('CPU', ['overviewCpu', `${DASH}%`], `<div class="small-value" id="overviewLoad">${t('sampling…')}</div>`)}
          ${cell('RAM', ['overviewRam', `${DASH}%`], `<div class="small-value" id="overviewRamDetail">${t('sampling…')}</div>`)}
        </div>

        <div class="grid">
          ${cfg.chart != null ? cfg.chart : chartCard({ title: 'Performance history', canvasId: 'overviewChart', hint: 'Drag to zoom · double click for live', t })}
          ${cfg.side != null ? cfg.side : minecraftCard(t)}
        </div>`;
    const { set } = writer(cfg.el);
    const strip = cfg.el.querySelector('#statusStrip');

    function update(v = {}) {
      if (v.status) {
        const s = v.status;
        if (s.phase !== undefined) {
          for (const cls of ['ready', 'starting', 'stopping', 'error', 'offline']) strip.classList.remove(cls);
          if (s.phase) strip.classList.add(s.phase);
        }
        set('statusState', s.label); set('statusNote', s.note);
      }
      if (v.uptime) { set('serverUptime', v.uptime.value); set('serverStarted', v.uptime.started); }
      set('overviewPlayers', v.players);
      if (v.cpu) {
        if (v.cpu.value !== undefined) set('overviewCpu', pct(v.cpu.value));
        set('overviewCpu', v.cpu.text);
        if (v.cpu.avg !== undefined) set('overviewLoad', sample(v.cpu));
        set('overviewLoad', v.cpu.detail);
      }
      if (v.ram) {
        if (v.ram.value !== undefined) set('overviewRam', pct(v.ram.value));
        set('overviewRam', v.ram.text);
        set('overviewRamDetail', v.ram.detail);
        if (v.ram.avg !== undefined) set('overviewRamDetail', `${gb(v.ram.used)} / ${gb(v.ram.total)} · 1s avg ${pct(v.ram.avg)}`);
      }
      if (v.minecraft) {
        const m = v.minecraft, onOff = (b) => (b == null ? DASH : b ? 'on' : 'off');
        set('mcVersion', m.version || DASH); set('mcPort', m.port ?? DASH); set('mcGamemode', m.gamemode || DASH); set('mcDifficulty', m.difficulty || DASH);
        set('mcViewDistance', m.viewDistance != null ? `${m.viewDistance} chunks` : DASH);
        set('mcPvp', onOff(m.pvp)); set('mcWhitelist', onOff(m.whitelist));
        set('mcTps', m.tps ? [m.tps.one, m.tps.five, m.tps.fifteen].map((x) => Number(x).toFixed(2)).join(' / ') : DASH);
        set('mcMotd', m.motd || DASH);
        const motd = cfg.el.querySelector('#mcMotd'); if (motd) motd.title = m.motd || '';
      }
    }
    return { update };
  }

  const CARDS = {
    cpu: (t) => `<article class="card span-4"><div class="card-body"><div class="resource-top"><div><div class="resource-number" id="perfCpu">${DASH}%</div><div class="resource-label">CPU</div></div><div class="mono" id="perfTemp">${DASH}</div></div><div class="bar"><div id="perfCpuBar"></div></div><div class="resource-foot"><span id="perfCores">${DASH} ${t('cores')}</span><span id="perfClock">${DASH}</span></div><div class="sample-note" id="perfCpuSample">${t('current')} ${DASH} · min ${DASH} · peak ${DASH}</div></div></article>`,
    ram: (t) => `<article class="card span-4"><div class="card-body"><div class="resource-top"><div><div class="resource-number" id="perfRam">${DASH}%</div><div class="resource-label">RAM</div></div></div><div class="bar"><div id="perfRamBar"></div></div><div class="resource-foot"><span id="perfRamUsed">${DASH}</span><span id="perfRamTotal">${DASH}</span></div><div class="sample-note" id="perfRamSample">${t('current')} ${DASH} · min ${DASH} · peak ${DASH}</div></div></article>`,
    disk: (t) => `<article class="card span-4"><div class="card-body"><div class="resource-top"><div><div class="resource-number" id="perfDisk">${DASH}%</div><div class="resource-label">Disk</div></div></div><div class="bar"><div id="perfDiskBar"></div></div><div class="resource-foot"><span id="perfDiskUsed">${DASH} ${t('used')}</span><span id="perfDiskTotal">${DASH} ${t('total')}</span></div></div></article>`,
  };

  // cfg.cards: which resource cards to show (default cpu, ram, disk); cfg.chart: HTML of the wide chart card.
  function mountPerformance(cfg) {
    const t = cfg.t || ((s) => s);
    const cards = (cfg.cards || ['cpu', 'ram', 'disk']).map((c) => CARDS[c](t)).join('\n          ');
    const chart = cfg.chart != null ? cfg.chart : chartCard({ title: 'CPU / RAM', canvasId: 'perfCpuRamChart', hint: 'Lag, crash and restart markers are drawn on the timeline.', span: 12, t });
    cfg.el.innerHTML = `
        <div class="grid">
          ${cards}

          ${chart}
        </div>`;
    const { set, bar } = writer(cfg.el);

    function update(v = {}) {
      if (v.cpu) {
        const c = v.cpu;
        if (c.value !== undefined) { set('perfCpu', pct(c.value)); bar('perfCpuBar', c.value, c.peak); }
        if (c.temperatureC !== undefined) set('perfTemp', c.temperatureC != null ? `${Number(c.temperatureC).toFixed(1)}°C` : DASH);
        if (c.cores !== undefined) set('perfCores', `${c.cores ?? DASH} ${t('cores')}`);
        if (c.speedMHz !== undefined) set('perfClock', c.speedMHz ? `${(c.speedMHz / 1000).toFixed(2)} GHz` : DASH);
        if (c.avg !== undefined) set('perfCpuSample', sample(c));
        set('perfCpuSample', c.detail);
      }
      if (v.ram) {
        const r = v.ram;
        if (r.value !== undefined) { set('perfRam', pct(r.value)); bar('perfRamBar', r.value, r.peak); }
        if (r.used != null) set('perfRamUsed', `${gb(r.used)} ${t('used')}`);
        if (r.total !== undefined) set('perfRamTotal', `${gb(r.total)} ${t('total')}`);
        if (r.avg !== undefined) set('perfRamSample', sample(r));
        set('perfRamSample', r.detail);
      }
      if (v.disk !== undefined) {
        const d = v.disk;
        set('perfDisk', d ? pct(d.percent) : DASH); bar('perfDiskBar', d?.percent, d?.percent);
        set('perfDiskUsed', d ? `${gb(d.used)} ${t('used')}` : DASH); set('perfDiskTotal', d ? `${gb(d.total)} ${t('total')}` : DASH);
      }
    }
    return { update };
  }

  window.MeowResources = { mountOverview, mountPerformance, chartCard };
})();
