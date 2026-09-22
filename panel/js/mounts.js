// Core components mounted on the instance page and the $ helper.
const $ = (id) => document.getElementById(id) || document.createElement('div');

const OVERVIEW_PAGE = MeowResources.mountOverview({ el: $('page-overview'), t: window.t, onViewLog: () => showPage('console', { push: true }) });
const PERF_PAGE = MeowResources.mountPerformance({ el: $('page-performance'), t: window.t });
const SERVER_ICON = MeowServerIcon.mount({
  el: $('serverIconRoot'),
  src: () => `${window.__BASE || ''}/api/server-icon?ts=${Date.now()}`,
  send: async (body) => (await fetch('/api/server-icon', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json(),
  toast: (message, type) => toast(message, type),
  t: window.t,
});
const PLAYERS = MeowPlayers.mount({
  el: $('playersRoot'),
  chartHtml: `<div class="card" style="margin-top:12px"><div class="card-head"><div class="card-title">Player count history</div><div class="chart-head-right"><div class="card-meta">live</div><div class="chart-range"><button class="range-btn active" data-range-ms="60000">1m</button><button class="range-btn" data-range-ms="300000">5m</button><button class="range-btn" data-range-ms="900000">15m</button><button class="range-btn" data-range-ms="3600000">1h</button><button class="range-btn" data-range-ms="86400000">24h</button><button class="range-btn" data-range-ms="604800000">7d</button></div></div></div><div class="card-body"><div class="chart-host"><canvas class="chart chart-sm" id="playerChart"></canvas></div></div></div>`,
  history: (name) => fetch(`/api/player-history?name=${encodeURIComponent(name)}`, { cache: 'no-store' }).then((r) => r.json()),
  act: (action, player, o) => post('/player-action', { player, action, value: o.value, reason: o.reason }),
  isRunning: () => running,
  confirm: (title, message, label, danger) => modalConfirm(title, message, label, danger),
  onUpdate: (p) => { OVERVIEW_PAGE.update({ players: `${p.online || 0} / ${p.max ?? '—'}` }); CONSOLE.refreshSuggestions(); },
  toast: (message, type) => toast(message, type),
  t: window.t, esc,
});
const PALETTE = MeowPalette.mount({
  goto: (page) => showPage(page, { push: true }),
  focusConsole: () => CONSOLE.focus(),
  focusSearch: () => CONSOLE.focusSearch(),
  extra: () => {
    const out = [
      { label: 'Restart server…', sub: 'Open scheduled restart controls', key: '', run: () => showPage('automation', { push: true }) },
      { label: 'Start server', sub: 'Start Minecraft if offline', key: '', run: () => post('/start').catch((e) => toast(e.message, 'error')) },
      { label: 'Stop server', sub: 'Clean shutdown', key: '', run: () => post('/stop').catch((e) => toast(e.message, 'error')) },
      { label: 'Back to live graphs', sub: 'Leave history mode', key: '', run: () => { chartLiveMode = true; chartAnchorTime = null; updateHistoryModeUi(); scheduleChartDraw(true); } },
    ];
    for (const p of latest?.players?.list || []) out.push({ label: p.name, sub: `Player · ${fmtDuration(p.sessionSec)} online`, key: 'player', run: () => { showPage('players', { push: true }); PLAYERS.open(p.name); } });
    return out;
  },
  esc,
});
const AUTOMATION = MeowAutomation.mount({
  el: $('automationRoot'),
  load: async () => (await fetch('/api/config')).json(),
  save: async (patch) => { const r = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }); if (!r.ok) throw new Error('could not save'); },
  toast: (message, type) => toast(message, type),
  t: window.t,
  after: (section) => { if (section === 'backup') loadBackups(); },
});
