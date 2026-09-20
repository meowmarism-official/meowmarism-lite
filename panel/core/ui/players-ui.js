// Online players table with session stats and a per-player action dialog. Shared by every product.
// cfg: { el, load() -> player stats, detail(name), act(action, name, { value, reason }), t, esc, toast, isVisible() }
(function () {
  const dur = (sec) => {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    return h ? `${h}h ${m}m` : m ? `${m}m ${sec % 60}s` : `${sec}s`;
  };
  const GROUPS = [
    { title: 'Player', actions: [['heal', 'Heal'], ['feed', 'Feed'], ['clear-effects', 'Clear effects'], ['kill', 'Kill', 'danger']] },
    { title: 'Gamemode', actions: [['gamemode:survival', 'Survival'], ['gamemode:creative', 'Creative'], ['gamemode:adventure', 'Adventure'], ['gamemode:spectator', 'Spectator']] },
    { title: 'Access', actions: [['op', 'OP', 'warn'], ['deop', 'DeOP'], ['whitelist-add', 'Whitelist +'], ['whitelist-remove', 'Whitelist −']] },
    { title: 'Moderation', reason: true, actions: [['kick', 'Kick', 'warn'], ['ban', 'Ban', 'danger']] },
  ];

  function mount(cfg) {
    const { t, esc, toast } = cfg;
    let stats = null;
    let selected = null;

    cfg.el.innerHTML = `
      <div class="pl-summary" data-pl="summary"></div>
      <div class="pl-table"><table class="data-table"><thead><tr><th>${esc(t('Player'))}</th><th>${esc(t('Session'))}</th><th>${esc(t('Total playtime'))}</th><th></th></tr></thead><tbody data-pl="rows"></tbody></table>
        <div class="pl-empty" data-pl="empty">${esc(t('No players online.'))}</div></div>
      <div class="pl-back" data-pl="back"><div class="pl-modal" role="dialog" aria-modal="true">
        <div class="pl-head"><div><div class="pl-name" data-pl="name"></div><div class="pl-sub" data-pl="sub"></div></div><button class="btn" data-pl="close">×</button></div>
        <div class="pl-body">${GROUPS.map((g) => `<div class="pl-group"><div class="pl-group-title">${esc(t(g.title))}</div>
          ${g.reason ? `<input class="pl-reason" data-pl="reason" maxlength="160" placeholder="${esc(t('Reason (optional)'))}">` : ''}
          <div class="pl-actions">${g.actions.map(([a, label, cls]) => `<button class="btn ${cls || ''}" data-pl-action="${a}">${esc(t(label))}</button>`).join('')}</div></div>`).join('')}</div>
      </div></div>`;
    const q = (k) => cfg.el.querySelector(`[data-pl="${k}"]`);

    function render() {
      const s = stats || { online: 0, list: [] };
      q('summary').innerHTML = [
        [s.online, 'Online now'], [s.max ?? '—', 'Server limit'], [s.uniqueToday ?? 0, 'Unique today*'],
        [s.averageSessionSec ? dur(s.averageSessionSec) : '—', 'Avg session*'], [s.longestSessionSec ? dur(s.longestSessionSec) : '—', 'Longest session*'],
      ].map(([n, l]) => `<div class="pl-stat"><div class="pl-n">${esc(String(n))}</div><div class="pl-l">${esc(t(l))}</div></div>`).join('');
      q('rows').innerHTML = s.list.map((p) => `<tr><td><strong>${esc(p.name)}</strong></td><td>${dur(p.sessionSec)}</td><td>${dur(p.totalPlaySec)}</td><td style="text-align:right"><button class="btn" data-pl-open="${esc(p.name)}">${esc(t('Manage'))}</button></td></tr>`).join('');
      q('empty').style.display = s.list.length ? 'none' : '';
    }
    async function load() { try { stats = await cfg.load(); render(); } catch (err) { toast(err.message); } }

    const closeDialog = () => { selected = null; q('back').classList.remove('open'); };
    async function open(name) {
      selected = name;
      q('name').textContent = name;
      q('sub').textContent = '';
      q('reason').value = '';
      q('back').classList.add('open');
      try {
        const d = await cfg.detail(name);
        if (selected === name) q('sub').textContent = `${t('Joins')}: ${d.joins} · ${t('Total playtime')}: ${dur(d.totalPlaySec)}`;
      } catch (_) {}
    }

    cfg.el.addEventListener('click', async (e) => {
      const o = e.target.closest('[data-pl-open]');
      if (o) return open(o.dataset.plOpen);
      if (e.target === q('back') || e.target.closest('[data-pl="close"]')) return closeDialog();
      const b = e.target.closest('[data-pl-action]');
      if (!b || !selected) return;
      const [action, value] = b.dataset.plAction.split(':');
      try {
        await cfg.act(action, selected, { value, reason: q('reason').value });
        toast(`${selected}: ${action}${value ? ' ' + value : ''}`);
        if (action === 'kick' || action === 'ban') closeDialog();
        setTimeout(load, 800);
      } catch (err) { toast(err.message); }
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && selected) closeDialog(); });
    setInterval(() => { if (cfg.isVisible()) load(); }, 5000);
    return { load };
  }
  window.MeowPlayers = { mount };
})();
