// Players page: session stats, the online table, an optional history chart slot and the per-player drawer with actions and history. Shared by every product.
// cfg: { el, chartHtml? (markup of the chart card the product draws into), load?() -> player stats (products that poll), history(name) -> tracker detail,
//   act(action, name, { value, reason }), isRunning(), confirm(title, message, label, danger), toast, t, esc, onUpdate?(stats), isVisible?(), refreshMs? }
(function () {
  const PAGE = (chartHtml) => `
        <div class="card">
          <div class="player-summary" style="grid-template-columns:repeat(6,minmax(0,1fr))"><div class="player-stat"><div class="n" id="playersNow">0</div><div class="l">Online now</div></div><div class="player-stat"><div class="n" id="playersMax">—</div><div class="l">Server limit</div></div><div class="player-stat"><div class="n" id="playersPeak">0</div><div class="l">Peak session</div></div><div class="player-stat"><div class="n" id="playersUnique">0</div><div class="l">Unique today*</div></div><div class="player-stat"><div class="n" id="playersAvgSession">—</div><div class="l">Avg session*</div></div><div class="player-stat"><div class="n" id="playersLongest">—</div><div class="l">Longest session*</div></div></div><div class="hint" style="padding:7px 12px;border-bottom:1px solid var(--line)">*Since this panel process started; no fake historical data after a panel restart.</div>
          <div class="table-wrap"><table class="data-table"><thead><tr><th>Player</th><th>Session</th><th>Joined</th><th>Status</th><th></th></tr></thead><tbody id="playerRows" data-no-i18n></tbody></table><div class="empty-state" id="playerEmpty">No players online.</div></div>
        </div>${chartHtml || ''}`;

  const DRAWER = `
<div class="drawer-backdrop" id="drawerBackdrop"></div>
<aside class="player-drawer" id="playerDrawer" aria-hidden="true">
  <div class="drawer-head"><div class="drawer-title">Player</div><button class="drawer-close" id="drawerClose" aria-label="Close player panel">×</button></div>
  <div class="drawer-body">
    <div class="player-identity"><div class="player-big-name" id="drawerPlayerName">—</div><div class="online-tag" id="drawerPlayerStatus">online</div></div>
    <div class="drawer-section"><div class="drawer-section-title">Session</div><div class="drawer-section-body"><div class="drawer-kv"><span>Joined</span><span id="drawerJoined">—</span></div><div class="drawer-kv"><span>Session</span><span id="drawerSession">—</span></div></div></div>
    <div class="drawer-section"><div class="drawer-section-title">Gamemode</div><div class="drawer-section-body"><div class="action-grid"><button class="action-btn" data-player-action="gamemode" data-value="survival">Survival</button><button class="action-btn" data-player-action="gamemode" data-value="creative">Creative</button><button class="action-btn" data-player-action="gamemode" data-value="adventure">Adventure</button><button class="action-btn" data-player-action="gamemode" data-value="spectator">Spectator</button></div></div></div>
    <div class="drawer-section"><div class="drawer-section-title">Player</div><div class="drawer-section-body"><div class="action-grid"><button class="action-btn" data-player-action="heal">Heal</button><button class="action-btn" data-player-action="feed">Feed</button><button class="action-btn" data-player-action="clear-effects">Clear effects</button><button class="action-btn danger" data-player-action="kill">Kill</button></div></div></div>
    <div class="drawer-section"><div class="drawer-section-title">Access</div><div class="drawer-section-body"><div class="action-grid"><button class="action-btn warn" data-player-action="op">OP</button><button class="action-btn" data-player-action="deop">DeOP</button><button class="action-btn" data-player-action="whitelist-add">Whitelist +</button><button class="action-btn" data-player-action="whitelist-remove">Whitelist −</button></div></div></div>
    <div class="drawer-section"><div class="drawer-section-title">History</div><div class="drawer-section-body"><div class="player-history-grid"><div class="ph-box"><div class="v" id="drawerFirstSeen">—</div><div class="k">First seen</div></div><div class="ph-box"><div class="v" id="drawerTotalPlay">—</div><div class="k">Total play</div></div><div class="ph-box"><div class="v" id="drawerJoins">—</div><div class="k">Joins</div></div><div class="ph-box"><div class="v" id="drawerLastSeen">—</div><div class="k">Last seen</div></div></div><div class="session-list" id="drawerSessions" style="margin-top:8px"><div class="hint">Loading history…</div></div></div></div>
    <div class="drawer-section"><div class="drawer-section-title">Moderation</div><div class="drawer-section-body"><input class="reason-input" id="playerReason" placeholder="Reason (optional)" maxlength="160"><div class="action-grid"><button class="action-btn warn" data-player-action="kick">Kick</button><button class="action-btn danger" data-player-action="ban">Ban</button></div></div></div>
  </div>
</aside>`;

  function mount(cfg) {
    const { t, esc, toast } = cfg;
    const F = window.MeowFormat;
    const $ = (id) => document.getElementById(id);
    cfg.el.innerHTML = PAGE(cfg.chartHtml);
    document.body.insertAdjacentHTML('beforeend', DRAWER);

    let latest = { online: 0, max: null, list: [] };
    let peak = 0;
    let selected = null;

    function update(data) {
      const p = data || { online: 0, max: null, list: [] };
      latest = p;
      peak = Math.max(peak, p.online || 0);
      $('playersNow').textContent = p.online || 0; $('playersMax').textContent = p.max ?? '—'; $('playersPeak').textContent = peak;
      $('playersUnique').textContent = p.uniqueToday ?? 0;
      $('playersAvgSession').textContent = p.averageSessionSec ? F.duration(p.averageSessionSec) : '—';
      $('playersLongest').textContent = p.longestSessionSec ? F.duration(p.longestSessionSec) : '—';
      const list = p.list || [];
      $('playerRows').innerHTML = list.map((x) => `<tr class="player-row"><td class="player-name"><button class="player-link" data-player="${esc(x.name)}">${esc(x.name)}</button></td><td class="mono">${F.duration(x.sessionSec)}</td><td class="mono">${F.date(x.joinedAt)}</td><td><span style="color:var(--green)">online</span></td><td class="player-open">›</td></tr>`).join('');
      $('playerEmpty').style.display = list.length ? 'none' : 'block';
      if (selected) renderSelected();
      if (cfg.onUpdate) cfg.onUpdate(p);
    }

    const current = () => (latest.list || []).find((p) => p.name === selected) || null;
    function renderSelected() {
      const p = current();
      $('drawerPlayerName').textContent = selected || '—';
      $('drawerJoined').textContent = p ? F.date(p.joinedAt) : '—';
      $('drawerSession').textContent = p ? F.duration(p.sessionSec) : '—';
      $('drawerPlayerStatus').textContent = p ? 'online' : 'offline';
      $('drawerPlayerStatus').style.color = p ? 'var(--green)' : 'var(--muted)';
      document.querySelectorAll('[data-player-action]').forEach((b) => { b.disabled = !p || !cfg.isRunning(); });
    }

    function open(name) {
      selected = name;
      $('playerReason').value = '';
      renderSelected();
      $('drawerFirstSeen').textContent = '—'; $('drawerTotalPlay').textContent = '—'; $('drawerJoins').textContent = '—'; $('drawerLastSeen').textContent = '—';
      $('drawerSessions').innerHTML = `<div class="hint">${esc(t('Loading history…'))}</div>`;
      $('playerDrawer').classList.add('open'); $('drawerBackdrop').classList.add('open'); $('playerDrawer').setAttribute('aria-hidden', 'false');
      Promise.resolve(cfg.history(name)).then((h) => {
        if (selected !== name || !h || h.error) return;
        $('drawerFirstSeen').textContent = F.date(h.firstSeenAt); $('drawerLastSeen').textContent = F.date(h.lastSeenAt);
        $('drawerTotalPlay').textContent = F.duration(h.totalPlaySec); $('drawerJoins').textContent = h.joins ?? 0;
        const sessions = (h.sessions || []).slice().reverse().slice(0, 12);
        $('drawerSessions').innerHTML = sessions.length
          ? sessions.map((x) => `<div class="session-line">${F.date(x.joinedAt)} · ${x.leftAt ? F.duration((x.durationMs || 0) / 1000) : esc(t('online now'))}</div>`).join('')
          : `<div class="hint">${esc(t('No completed sessions yet.'))}</div>`;
      }).catch(() => { $('drawerSessions').innerHTML = `<div class="hint">${esc(t('History unavailable.'))}</div>`; });
    }
    function close() {
      $('playerDrawer').classList.remove('open'); $('drawerBackdrop').classList.remove('open'); $('playerDrawer').setAttribute('aria-hidden', 'true');
    }

    async function act(action, value) {
      const p = current();
      if (!p) return toast(t('Player is no longer online'), 'error');
      if (['ban', 'kill', 'deop', 'op'].includes(action) && !(await cfg.confirm(`${action.toUpperCase()} ${p.name}?`, t('This is sent to the server right away.'), action.toUpperCase(), action === 'ban' || action === 'kill'))) return;
      try {
        await cfg.act(action, p.name, { value, reason: $('playerReason').value });
        toast(`${p.name}: ${action}`);
        if (action === 'kick' || action === 'ban') setTimeout(close, 300);
      } catch (e) { toast(e.message, 'error'); }
    }

    $('playerRows').addEventListener('click', (e) => { const b = e.target.closest('[data-player]'); if (b) open(b.dataset.player); });
    $('drawerClose').onclick = close; $('drawerBackdrop').onclick = close;
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    document.querySelectorAll('[data-player-action]').forEach((b) => b.addEventListener('click', () => act(b.dataset.playerAction, b.dataset.value || null)));

    async function load() { try { update(await cfg.load()); } catch (err) { toast(err.message, 'error'); } }
    if (cfg.load && cfg.refreshMs) setInterval(() => { if (!cfg.isVisible || cfg.isVisible()) load(); }, cfg.refreshMs);
    return { update, load, open, close, refresh: renderSelected, notePeak: (n) => { peak = Math.max(peak, Number(n) || 0); }, peak: () => peak, players: () => latest };
  }
  window.MeowPlayers = { mount };
})();
