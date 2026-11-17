// Performance diagnostics card: tick timing, lag warnings, JVM numbers and a timed profile. Shared by every product.
// cfg: { el, load({ refresh }) -> state, startProfile(seconds) -> state, t, esc, toast, isVisible() }
// state: { running, phase, tick, tps, lag: { count, events }, java, tools: { profile, hint }, profile: { state, seconds, startedAt, error, result } }
(function () {
  function mount(cfg) {
    const { t, esc, toast } = cfg;
    let state = null;
    let seconds = 10;
    let timer = null;

    cfg.el.innerHTML = `<div class="diag"><div class="diag-grid" id="diagGrid"></div><div class="card diag-profile" id="diagProfile"></div></div>`;
    const grid = cfg.el.querySelector('#diagGrid');
    const profileCard = cfg.el.querySelector('#diagProfile');

    const fmt = (v, digits = 1) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(digits));
    const ago = (at) => { if (!at) return ''; const s = Math.max(0, Math.round((Date.now() - at) / 1000)); return s < 60 ? `${s} s` : `${Math.round(s / 60)} min`; };
    const tone = (ms) => (ms == null ? '' : ms > 50 ? 'bad' : ms > 40 ? 'warn' : 'good');
    const bar = (percent, cls = '') => `<span class="diag-bar ${cls}"><span style="width:${Math.min(100, Math.max(0, percent))}%"></span></span>`;
    const table = (rows) => `<div class="diag-rows">${rows.map((r) => `<div class="diag-row"><span class="diag-name" title="${esc(r.name)}">${esc(r.name)}</span>${bar(r.percent)}<span class="diag-pct">${fmt(r.percent)}%</span></div>`).join('') || `<div class="hint">${esc(t('No data'))}</div>`}</div>`;

    function tickCard() {
      const tick = state?.tick;
      if (!state?.running) return `<div class="hint">${esc(t('The server is not running.'))}</div>`;
      if (!tick) return `<div class="hint">${esc(t('Waiting for the first tick report…'))}</div>`;
      const stat = (label, value, cls = '') => `<div class="diag-stat"><div class="diag-v ${cls}">${value}</div><div class="diag-k">${esc(label)}</div></div>`;
      return `<div class="diag-stats">
        ${stat('TPS', fmt(state.tps), state.tps != null && state.tps < 19 ? 'bad' : 'good')}
        ${stat(t('Average tick'), `${fmt(tick.avgMs)} ms`, tone(tick.avgMs))}
        ${stat('P50', `${fmt(tick.p50Ms)} ms`, tone(tick.p50Ms))}
        ${stat('P95', `${fmt(tick.p95Ms)} ms`, tone(tick.p95Ms))}
        ${stat('P99', `${fmt(tick.p99Ms)} ms`, tone(tick.p99Ms))}
      </div><div class="card-meta">${esc(t('A tick has 50 ms'))} · ${esc(t('updated'))} ${ago(tick.at)} ${esc(t('ago'))}${tick.sample ? ` · ${tick.sample} ${esc(t('ticks measured'))}` : ''}</div>`;
    }

    function lagCard() {
      const lag = state?.lag;
      if (!lag?.count) return `<div class="hint">${esc(t('No lag warnings since the server started.'))}</div>`;
      const rows = (lag.events || []).slice(-8).reverse().map((e) => `<div class="diag-lag ${e.delayMs >= 5000 ? 'bad' : 'warn'}"><span>${new Date(e.at).toLocaleTimeString()}</span><span>${e.ticksBehind} ${esc(t('ticks behind'))}</span><span>${(e.delayMs / 1000).toFixed(1)} s</span></div>`).join('');
      return `<div class="card-meta">${lag.count} ${esc(t('warnings'))}</div>${rows}`;
    }

    function jvmCard() {
      const j = state?.java;
      if (!state?.running) return `<div class="hint">${esc(t('The server is not running.'))}</div>`;
      if (!j) return `<div class="hint">${esc(state?.tools?.hint || t('Heap and GC numbers need the JDK tool jstat.'))}</div>`;
      return `<div class="diag-stats">
        <div class="diag-stat"><div class="diag-v">${fmt(j.heapUsedMB, 0)} MB</div><div class="diag-k">${esc(t('Heap used'))}</div></div>
        <div class="diag-stat"><div class="diag-v">${fmt(j.heapPercent, 0)}%</div><div class="diag-k">${esc(t('of the heap'))}</div></div>
        <div class="diag-stat"><div class="diag-v ${j.gcLoadPercent > 10 ? 'bad' : ''}">${fmt(j.gcLoadPercent, 1)}%</div><div class="diag-k">${esc(t('GC load'))}</div></div>
        <div class="diag-stat"><div class="diag-v">${j.youngGcCount ?? '—'} / ${j.fullGcCount ?? '—'}</div><div class="diag-k">${esc(t('GC runs young / full'))}</div></div>
      </div>`;
    }

    function profileBody() {
      const p = state?.profile || { state: 'idle' };
      const tools = state?.tools || {};
      const busy = p.state === 'running' || p.state === 'reading';
      let head = `<div class="card-head"><div class="card-title">${esc(t('Profile'))}</div><div class="diag-actions">`;
      for (const s of [10, 20, 30]) head += `<button class="btn ${seconds === s ? 'primary' : ''}" data-seconds="${s}" ${busy ? 'disabled' : ''}>${s} s</button>`;
      head += `<button class="btn primary" id="diagStart" ${busy || !state?.running || !tools.profile ? 'disabled' : ''}>${esc(t('Start profile'))}</button></div></div>`;
      let body = `<div class="card-body">`;
      if (!tools.profile) body += `<div class="hint">${esc(tools.hint || t('Profiling needs a JDK with jcmd and jfr.'))}</div>`;
      else if (!state?.running) body += `<div class="hint">${esc(t('Start the server to take a profile.'))}</div>`;
      else if (p.state === 'running') body += `<div class="hint">${esc(t('Recording'))} ${p.seconds} s… ${bar(Math.min(100, ((Date.now() - p.startedAt) / (p.seconds * 1000)) * 100))}</div>`;
      else if (p.state === 'reading') body += `<div class="hint">${esc(t('Reading the recording…'))}</div>`;
      else if (p.state === 'error') body += `<div class="hint bad">${esc(p.error || t('The profile failed.'))}</div>`;
      else if (p.state === 'done' && p.result) body += resultBody(p.result);
      else body += `<div class="hint">${esc(t('Records what the server threads are busy with and shows who uses the time. Run it while the lag happens.'))}</div>`;
      return `${head}${body}</div>`;
    }

    function resultBody(r) {
      const server = r.serverThread;
      const gc = r.gc || {};
      return `<div class="card-meta">${r.samples} ${esc(t('samples'))} · ${r.durationSec ?? '?'} s · GC: ${gc.count || 0}× · ${fmt(gc.totalPauseMs, 0)} ms ${esc(t('paused'))} (${esc(t('longest'))} ${fmt(gc.longestMs, 0)} ms)</div>
        <div class="diag-cols">
          <div><div class="diag-sub">${esc(t('Server thread: who uses the time'))}</div>${server ? table(server.owners) : `<div class="hint">${esc(t('The server thread was not sampled.'))}</div>`}</div>
          <div><div class="diag-sub">${esc(t('Server thread: busiest methods'))}</div>${server ? table(server.methods) : ''}</div>
          <div><div class="diag-sub">${esc(t('All threads: who uses the time'))}</div>${table(r.owners || [])}</div>
          <div><div class="diag-sub">${esc(t('Threads'))}</div>${table(r.threads || [])}</div>
        </div>`;
    }

    function render() {
      const card = (title, body) => `<div class="card"><div class="card-head"><div class="card-title">${esc(title)}</div></div><div class="card-body">${body}</div></div>`;
      grid.innerHTML = card(t('Tick timing'), tickCard()) + card(t('Lag warnings'), lagCard()) + card('JVM', jvmCard());
      profileCard.innerHTML = profileBody();
      profileCard.querySelectorAll('[data-seconds]').forEach((b) => { b.onclick = () => { seconds = Number(b.dataset.seconds); render(); }; });
      const start = profileCard.querySelector('#diagStart');
      if (start) start.onclick = async () => {
        try { state = await cfg.startProfile(seconds); render(); } catch (e) { toast(e.message, 'error'); }
      };
    }

    async function refresh(force = false) {
      if (!force && cfg.isVisible && !cfg.isVisible()) return;
      try { state = await cfg.load({ refresh: true }); render(); } catch (_) {}
    }

    function schedule() {
      clearInterval(timer);
      timer = setInterval(() => {
        const busy = state?.profile?.state === 'running' || state?.profile?.state === 'reading';
        if (busy) { refresh(); return; }
        if (Date.now() - (state?.at || 0) >= 5000) refresh();
      }, 1500);
    }

    render();
    schedule();
    return { load: () => refresh(true), render };
  }
  window.MeowDiagnostics = { mount };
})();
