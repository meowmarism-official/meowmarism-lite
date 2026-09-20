// Events page: event timeline and audit log side by side. Shared by every product.
// cfg: { el, load() -> { events: [{ at, type, title, detail?, severity? }], audit: [{ at, type, title, detail?, user }] }, t, esc, fmtClock(ts), isVisible?(), refreshMs? }
(function () {
  function mount(cfg) {
    const { t, esc } = cfg;
    cfg.el.innerHTML = `<div class="grid">
      <article class="card span-6"><div class="card-head"><div><div class="card-title">${esc(t('Event timeline'))}</div><div class="card-meta">${esc(t('joins, leaves and server lifecycle'))}</div></div></div><div class="event-list" data-ev-list></div></article>
      <article class="card span-6"><div class="card-head"><div><div class="card-title">${esc(t('Audit log'))}</div><div class="card-meta">${esc(t('panel actions and configuration changes'))}</div></div></div><div class="audit-list" data-au-list></div></article>
    </div>`;
    const row = (e, who) => `<div class="event-row"><div class="event-time">${esc(cfg.fmtClock(e.at))}</div><div class="event-dot ${esc(e.severity || '')}"></div><div><div class="event-title">${esc(t(e.title))}</div><div class="event-detail">${esc(e.detail || '')}</div></div>${who ? `<div class="event-type">${esc(who)}</div>` : ''}</div>`;
    const fill = (sel, list, empty, who) => {
      cfg.el.querySelector(sel).innerHTML = list.length ? list.slice().reverse().map((e) => row(e, who && who(e))).join('') : `<div class="event-empty">${esc(t(empty))}</div>`;
    };
    async function load() {
      try {
        const d = await cfg.load();
        fill('[data-ev-list]', d.events, 'No events yet.');
        fill('[data-au-list]', d.audit, 'No panel actions yet.', (e) => e.user);
      } catch (_) {}
    }
    if (cfg.refreshMs) setInterval(() => { if (!cfg.isVisible || cfg.isVisible()) load(); }, cfg.refreshMs);
    return { load };
  }
  window.MeowEvents = { mount };
})();
