// The instance page frame every product shares: the icon sidebar with the page list, the top bar with the title,
// state pills and the power buttons. The pages themselves belong to the product.
// Also owns page navigation: titles, URLs, history and the active page. Returns { show(page, { push, replace }), pageFromPath(), meta }.
// cfg: { edition, allowed?(page), onPage?(page), panelLinks? (Manage users, Settings, Update, GitHub, version and copyright), brandSub?, base? (URL prefix of the page links), pages: [page id or { id, href, label, icon }], backLabel, sync (sync pill), history (history button), t, esc }
(function () {
  const CATALOG = {"overview": {"href": "/overview", "icon": "<svg viewBox=\"0 0 24 24\"><rect x=\"3\" y=\"3\" width=\"7\" height=\"9\" rx=\"1\"/><rect x=\"14\" y=\"3\" width=\"7\" height=\"5\" rx=\"1\"/><rect x=\"14\" y=\"12\" width=\"7\" height=\"9\" rx=\"1\"/><rect x=\"3\" y=\"16\" width=\"7\" height=\"5\" rx=\"1\"/></svg>", "label": "Overview"}, "performance": {"href": "/performance", "icon": "<svg viewBox=\"0 0 24 24\"><polyline points=\"22 12 18 12 15 21 9 3 6 12 2 12\"/></svg>", "label": "Performance"}, "players": {"href": "/players", "icon": "<svg viewBox=\"0 0 24 24\"><path d=\"M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2\"/><circle cx=\"9\" cy=\"7\" r=\"4\"/><path d=\"M23 21v-2a4 4 0 0 0-3-3.87\"/><path d=\"M16 3.13a4 4 0 0 1 0 7.75\"/></svg>", "label": "Players"}, "console": {"href": "/console", "icon": "<svg viewBox=\"0 0 24 24\"><polyline points=\"4 17 10 11 4 5\"/><line x1=\"12\" y1=\"19\" x2=\"20\" y2=\"19\"/></svg>", "label": "Console"}, "settings": {"href": "/settings", "icon": "<svg viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"3\"/><path d=\"M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z\"/></svg>", "label": "Settings"}, "mods": {"href": "/mods", "icon": "<svg viewBox=\"0 0 24 24\"><path d=\"M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z\"/><polyline points=\"3.27 6.96 12 12.01 20.73 6.96\"/><line x1=\"12\" y1=\"22.08\" x2=\"12\" y2=\"12\"/></svg>", "label": "Mods"}, "files": {"href": "/files", "icon": "<svg viewBox=\"0 0 24 24\"><path d=\"M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z\"/></svg>", "label": "Files"}, "access": {"href": "/access", "icon": "<svg viewBox=\"0 0 24 24\"><rect x=\"3\" y=\"11\" width=\"18\" height=\"11\" rx=\"2\"/><path d=\"M7 11V7a5 5 0 0 1 10 0v4\"/></svg>", "label": "Access"}, "backups": {"href": "/backups", "icon": "<svg viewBox=\"0 0 24 24\"><polyline points=\"21 8 21 21 3 21 3 8\"/><rect x=\"1\" y=\"3\" width=\"22\" height=\"5\"/><line x1=\"10\" y1=\"12\" x2=\"14\" y2=\"12\"/></svg>", "label": "Backups"}, "schedule": {"href": "/schedule", "icon": "<svg viewBox=\"0 0 24 24\"><rect x=\"3\" y=\"4\" width=\"18\" height=\"18\" rx=\"2\"/><line x1=\"16\" y1=\"2\" x2=\"16\" y2=\"6\"/><line x1=\"8\" y1=\"2\" x2=\"8\" y2=\"6\"/><line x1=\"3\" y1=\"10\" x2=\"21\" y2=\"10\"/></svg>", "label": "Scheduler"}, "manage": {"href": "/manage", "icon": "<svg viewBox=\"0 0 24 24\"><line x1=\"4\" y1=\"21\" x2=\"4\" y2=\"14\"/><line x1=\"4\" y1=\"10\" x2=\"4\" y2=\"3\"/><line x1=\"12\" y1=\"21\" x2=\"12\" y2=\"12\"/><line x1=\"12\" y1=\"8\" x2=\"12\" y2=\"3\"/><line x1=\"20\" y1=\"21\" x2=\"20\" y2=\"16\"/><line x1=\"20\" y1=\"12\" x2=\"20\" y2=\"3\"/><line x1=\"1\" y1=\"14\" x2=\"7\" y2=\"14\"/><line x1=\"9\" y1=\"8\" x2=\"15\" y2=\"8\"/><line x1=\"17\" y1=\"16\" x2=\"23\" y2=\"16\"/></svg>", "label": "Manage"}, "automation": {"href": "/automation", "icon": "<svg viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"10\"/><polyline points=\"12 6 12 12 16 14\"/></svg>", "label": "Automation"}, "events": {"href": "/events", "icon": "<svg viewBox=\"0 0 24 24\"><path d=\"M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z\"/><polyline points=\"14 2 14 8 20 8\"/><line x1=\"16\" y1=\"13\" x2=\"8\" y2=\"13\"/><line x1=\"16\" y1=\"17\" x2=\"8\" y2=\"17\"/></svg>", "label": "Events & Audit"}, "system": {"href": "/system", "icon": "<svg viewBox=\"0 0 24 24\"><rect x=\"4\" y=\"4\" width=\"16\" height=\"16\" rx=\"2\"/><rect x=\"9\" y=\"9\" width=\"6\" height=\"6\"/><line x1=\"9\" y1=\"1\" x2=\"9\" y2=\"4\"/><line x1=\"15\" y1=\"1\" x2=\"15\" y2=\"4\"/><line x1=\"9\" y1=\"20\" x2=\"9\" y2=\"23\"/><line x1=\"15\" y1=\"20\" x2=\"15\" y2=\"23\"/></svg>", "label": "System"}};

  const META = {
    overview: ['Overview', 'live server status'],
    performance: ['Performance', 'CPU, memory, disk and network history'],
    players: ['Players', 'click a player to manage them'],
    console: ['Console', 'live server output and commands'],
    settings: ['Settings', 'Minecraft server configuration'],
    mods: ['Mods', 'enable or disable installed mods'],
    files: ['Files', 'browse files on the server'],
    access: ['Access', 'whitelist, operators and bans'],
    backups: ['Backups', 'world backups, manual and automatic'],
    schedule: ['Scheduler', 'plan backups, restarts and commands'],
    manage: ['Manage instance', 'resources, server software and removal'],
    automation: ['Automation', 'Scheduled restarts, backups, sleep mode and crash handling'],
    events: ['Events & Audit', 'timeline, health, lifecycle and panel actions'],
  };

  function mount(cfg) {
    const t = cfg.t || ((x) => x);
    const esc = cfg.esc || ((x) => String(x));
    const brandSub = cfg.brandSub ? `<div class="side-brand-sub">${esc(t(cfg.brandSub))}</div>` : '';
    const syncPill = cfg.sync === false ? '' : '<div class="sync-pill" id="syncPill"><span class="sync-dot"></span><span id="syncText">syncing</span></div>';
    const historyBtn = cfg.history === false ? '' : '<button class="history-mode-btn" id="btnBackLive">Viewing history \u00b7 Back to live</button>';
    const panel = cfg.panelLinks ? `
      <a href="/#users" class="back-link" id="navUsersLink" data-no-prefix style="display:none"><svg viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg><span class="side-label">${esc(t('Manage users'))}</span></a>
      <a href="/#settings" class="back-link" id="navSettingsLink" data-no-prefix style="display:none"><svg viewBox="0 0 24 24"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg><span class="side-label">${esc(t('Settings'))}</span></a>
      <a href="/#update" class="back-link" id="navUpdateLink" data-no-prefix><svg viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg><span class="side-label">${esc(t('Update'))}</span><span class="side-dot" id="updateDot" style="display:none"></span></a>
      <a href="#" class="back-link gh" id="navGhLink" data-no-prefix><svg viewBox="0 0 24 24"><path d="M12 0C5.37 0 0 5.5 0 12.3c0 5.43 3.44 10.03 8.21 11.66.6.11.82-.27.82-.6 0-.29-.01-1.06-.02-2.08-3.34.75-4.04-1.65-4.04-1.65-.55-1.42-1.33-1.81-1.33-1.81-1.09-.77.08-.75.08-.75 1.2.09 1.84 1.26 1.84 1.26 1.07 1.87 2.8 1.33 3.49 1.02.11-.79.42-1.33.76-1.64-2.67-.31-5.47-1.37-5.47-6.1 0-1.35.47-2.45 1.24-3.31-.12-.31-.54-1.57.12-3.28 0 0 1.01-.33 3.3 1.27a11.2 11.2 0 0 1 6 0c2.29-1.6 3.3-1.27 3.3-1.27.66 1.71.24 2.97.12 3.28.77.86 1.24 1.96 1.24 3.31 0 4.74-2.8 5.79-5.48 6.09.43.38.81 1.13.81 2.28 0 1.64-.02 2.97-.02 3.37 0 .33.22.72.83.6C20.57 22.32 24 17.72 24 12.3 24 5.5 18.63 0 12 0Z"/></svg><span class="side-label">GitHub</span></a>` : '';
    const meta = cfg.panelLinks ? '<div class="side-meta"><span id="sideVersion"></span>&copy; hexedmaya &middot; <a href="#" id="sideLicenseLink">License</a></div>' : '';
    const links = cfg.pages.map((p) => {
      const page = typeof p === 'string' ? { id: p, ...CATALOG[p] } : { ...CATALOG[p.id], ...p };
      return `<a href="${(cfg.base || '') + page.href}" data-page="${page.id}">${page.icon}<span class="side-label">${esc(t(page.label))}</span></a>`;
    }).join('\n      ');
    cfg.sidebarEl.innerHTML = `
    <div class="side-brand"><svg class="brand-logo" height="22" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 26 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="meowmarism"><path d="M3.2 4.7 C3.2 3.29 4.82 2.5 5.94 3.36 L13 8.83 L20.06 3.36 C21.18 2.5 22.8 3.29 22.8 4.7 L22.8 18.4 C22.8 20.58 20.28 21.79 18.57 20.42 L13 15.96 L7.43 20.42 C5.72 21.79 3.2 20.58 3.2 18.4 Z"/><path d="M12.08 14.59 C12.08 14.26 12.35 14.06 12.74 14.06 H13.26 C13.65 14.06 13.92 14.26 13.92 14.59 C13.92 14.85 13.79 15.04 13.59 15.24 L13 15.83 L12.41 15.24 C12.21 15.04 12.08 14.85 12.08 14.59 Z" fill="currentColor" stroke="none"/><path d="M6.3 12.7 L9.6 13.7" stroke-width="1.3"/><path d="M6.3 15.5 L9.6 14.9" stroke-width="1.3"/><path d="M19.7 12.7 L16.4 13.7" stroke-width="1.3"/><path d="M19.7 15.5 L16.4 14.9" stroke-width="1.3"/></svg><div class="side-brand-text"><div class="side-brand-name"><span class="wordmark">meowmarism</span> <span class="edition">${cfg.edition}</span></div>${brandSub}</div></div>
    <nav class="nav">
      ${links}
    </nav>
    <div class="sidebar-foot">${panel}
      <a href="#" data-lang-toggle class="back-link" data-no-prefix><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg><span class="side-label" data-no-i18n data-lang-label></span></a>
      <a href="#" id="backToController" data-no-prefix class="back-link"><svg viewBox="0 0 24 24"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg><span class="side-label">${esc(t(cfg.backLabel))}</span></a>
      <div class="live-row" id="liveRow"><span class="live-dot"></span><span id="connectionText">connecting</span></div>${meta}
    </div>

  `;
    cfg.topbarEl.innerHTML = `
      <div class="crumb"><span class="page-title" id="pageTitle">Overview</span><span class="page-sub" id="pageSub">live server status</span></div>
      <div class="top-actions">
        <div class="phase-pill" id="phasePill"><span class="phase-dot"></span><span id="phaseText">offline</span></div>
        ${syncPill}
        ${historyBtn}
        <button class="btn primary" id="btnStart">Start</button>
        <button class="btn" id="btnRestart">Restart</button>
        <button class="btn danger" id="btnStop">Stop</button>
      </div>
    `;

    const base = cfg.base || '';
    const pageFromPath = () => {
      const page = location.pathname.slice(base.length).replace(/^\//, '').split('/')[0] || 'overview';
      return META[page] ? page : 'overview';
    };
    function show(page, { push = false, replace = false } = {}) {
      if (!META[page] || (cfg.allowed && !cfg.allowed(page))) page = 'overview';
      document.querySelectorAll('.page').forEach((el) => el.classList.toggle('active', el.id === `page-${page}`));
      document.querySelectorAll('[data-page]').forEach((el) => el.classList.toggle('active', el.dataset.page === page));
      const [title, sub] = META[page];
      document.getElementById('pageTitle').textContent = t(title);
      document.getElementById('pageSub').textContent = t(sub);
      document.title = `${t(title)} · Server Panel`;
      const target = `${base}/${page}`;
      if (push && location.pathname !== target) history.pushState({ page }, '', target);
      else if (replace && location.pathname !== target) history.replaceState({ page }, '', target);
      if (cfg.onPage) cfg.onPage(page);
    }
    document.querySelectorAll('[data-page]').forEach((link) => link.addEventListener('click', (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      show(link.dataset.page, { push: true });
    }));
    window.addEventListener('popstate', () => show(pageFromPath()));
    return { show, pageFromPath, meta: META };
  }
  window.MeowInstanceShell = { mount, pages: CATALOG, meta: META };
})();
