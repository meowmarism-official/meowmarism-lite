// The panel frame every product shares: sidebar, Settings and Update pages, page switching and the version indicator.
// cfg: { edition, repo, serverLabel, brandSub?, logoutHref?, updateHint, paths? (page -> URL path, enables history),
//   urls: { version, update, updateStatus, settings, system? }, t, esc, confirm(title, message, label), pagesEl,
//   onPage(page), onLogout?() }
(function () {
  function mount(cfg) {
    const { t, esc } = cfg;
    const $ = (id) => document.getElementById(id);
    let panel = {};
    let versionInfo = null;
    const serverLabel = esc(t(cfg.serverLabel));
    const brandSub = cfg.brandSub ? `<div class="side-brand-sub">${esc(t(cfg.brandSub))}</div>` : '';
    const logoutOpen = cfg.logoutHref ? `<a class="side-item" href="${cfg.logoutHref}" id="navLogout" style="display:none" title="Log out">` : '<button class="side-item" id="navLogout" style="display:none" title="Log out">';
    const logoutClose = cfg.logoutHref ? '</a>' : '</button>';
    const updateHint = esc(t(cfg.updateHint));

    document.body.insertAdjacentHTML('afterbegin', `<nav class="sidebar" id="sidebar">
  <div class="side-brand">
    <svg class="brand-logo" height="22" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 26 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="meowmarism"><path d="M3.2 4.7 C3.2 3.29 4.82 2.5 5.94 3.36 L13 8.83 L20.06 3.36 C21.18 2.5 22.8 3.29 22.8 4.7 L22.8 18.4 C22.8 20.58 20.28 21.79 18.57 20.42 L13 15.96 L7.43 20.42 C5.72 21.79 3.2 20.58 3.2 18.4 Z"/><path d="M12.08 14.59 C12.08 14.26 12.35 14.06 12.74 14.06 H13.26 C13.65 14.06 13.92 14.26 13.92 14.59 C13.92 14.85 13.79 15.04 13.59 15.24 L13 15.83 L12.41 15.24 C12.21 15.04 12.08 14.85 12.08 14.59 Z" fill="currentColor" stroke="none"/><path d="M6.3 12.7 L9.6 13.7" stroke-width="1.3"/><path d="M6.3 15.5 L9.6 14.9" stroke-width="1.3"/><path d="M19.7 12.7 L16.4 13.7" stroke-width="1.3"/><path d="M19.7 15.5 L16.4 14.9" stroke-width="1.3"/></svg>
    <div class="side-brand-text">
      <div class="side-brand-name"><span class="wordmark">meowmarism</span> <span class="edition">${cfg.edition}</span></div>
      ${brandSub}
    </div>
  </div>
  <div class="side-top">
    <button class="side-item active" data-page="server" title="${serverLabel}">
      <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><line x1="7" y1="7.5" x2="7.01" y2="7.5"/><line x1="7" y1="16.5" x2="7.01" y2="16.5"/></svg>
      <span class="side-label">${serverLabel}</span>
    </button>
    <button class="side-item" data-page="users" id="navUsers" style="display:none" title="Manage users">
      <svg viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
      <span class="side-label">Manage users</span>
    </button>
    <button class="side-item" data-page="settings" id="navSettings" style="display:none" title="Settings">
      <svg viewBox="0 0 24 24"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>
      <span class="side-label">Settings</span>
    </button>
    <button class="side-item" data-page="system" id="navSystem" style="display:none" title="System">
      <svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>
      <span class="side-label">System</span>
    </button>
    <button class="side-item" data-page="update" id="navUpdate" title="Update">
      <svg viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
      <span class="side-label">Update</span>
      <span class="side-dot" id="updateDot" style="display:none"></span>
      <span class="side-pill" id="updatePill" style="display:none">new</span>
    </button>
    <button class="side-item gh" id="navGh" title="GitHub">
      <svg viewBox="0 0 24 24"><path d="M12 0C5.37 0 0 5.5 0 12.3c0 5.43 3.44 10.03 8.21 11.66.6.11.82-.27.82-.6 0-.29-.01-1.06-.02-2.08-3.34.75-4.04-1.65-4.04-1.65-.55-1.42-1.33-1.81-1.33-1.81-1.09-.77.08-.75.08-.75 1.2.09 1.84 1.26 1.84 1.26 1.07 1.87 2.8 1.33 3.49 1.02.11-.79.42-1.33.76-1.64-2.67-.31-5.47-1.37-5.47-6.1 0-1.35.47-2.45 1.24-3.31-.12-.31-.54-1.57.12-3.28 0 0 1.01-.33 3.3 1.27a11.2 11.2 0 0 1 6 0c2.29-1.6 3.3-1.27 3.3-1.27.66 1.71.24 2.97.12 3.28.77.86 1.24 1.96 1.24 3.31 0 4.74-2.8 5.79-5.48 6.09.43.38.81 1.13.81 2.28 0 1.64-.02 2.97-.02 3.37 0 .33.22.72.83.6C20.57 22.32 24 17.72 24 12.3 24 5.5 18.63 0 12 0Z"/></svg>
      <span class="side-label">GitHub</span>
    </button>
  </div>
  <div class="side-bottom">
    <button class="side-item" data-lang-toggle title="Language">
      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
      <span class="side-label" data-no-i18n data-lang-label></span>
    </button>
    <div class="side-meta">
      <span id="sideVersion"></span>&copy; hexedmaya &middot; <a href="#" id="sideLicenseLink">License</a>
    </div>
    <div class="side-account">
      <div class="side-avatar" id="sideAvatar">?</div>
      <div class="side-account-info">
        <div class="side-account-name" id="sideAccountName">-</div>
        <div class="side-account-role" id="sideAccountRole"></div>
      </div>
    </div>
    ${logoutOpen}
      <svg viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
      <span class="side-label">Log out</span>
    ${logoutClose}
  </div>
</nav>`);
    cfg.pagesEl.insertAdjacentHTML('beforeend', `  <section class="page" id="page-settings">
    <div class="topbar">
      <div>
        <h1>Settings</h1>
        <p class="sub">Panel-wide behavior.</p>
      </div>
    </div>
    <div class="card">
      <label class="toggle-row">
        <span class="toggle"><input type="checkbox" id="set-trustProxy" /><span class="toggle-track"></span><span class="toggle-thumb"></span></span>
        <span>This panel runs behind an HTTPS reverse proxy</span>
      </label>
      <p class="hint">Turn this on only when a proxy such as Caddy or nginx in front of the panel sets X-Forwarded-For and X-Forwarded-Proto. It enables Secure cookies and correct client IPs for login protection.</p>
      <p class="hint" id="set-status"></p>
    </div>
  </section>

  <section class="page" id="page-system">
    <div class="topbar">
      <div>
        <h1>System</h1>
        <p class="sub">The machine running this panel.</p>
      </div>
    </div>
    <div id="systemRoot"></div>
  </section>

  <section class="page" id="page-update">
    <div class="topbar">
      <div>
        <h1>Update</h1>
        <p class="sub">What's currently installed on this host, and what's newest on GitHub.</p>
      </div>
    </div>
    <div class="card">
      <div class="kv-row"><div class="kv-key">Installed version</div><div class="kv-val" id="upd-current">-</div></div>
      <div class="kv-row"><div class="kv-key">Latest release</div><div class="kv-val" id="upd-latest">-</div></div>
      <div class="kv-row"><div class="kv-key">Released</div><div class="kv-val" id="upd-date">-</div></div>
      <div class="kv-row"><div class="kv-key">Status</div><div class="kv-val" id="upd-status">-</div></div>
    </div>
    <div class="card">
      <div class="card-title">Updating</div>
      <p class="hint" style="margin-top:0">${updateHint}</p>
      <div class="row" style="margin-top:10px">
        <button class="btn primary" id="upd-now" style="display:none">Update now</button>
        <button class="btn" id="upd-check">Check for updates</button>
        <a class="btn" id="upd-release-link" href="#">View release on GitHub</a>
      </div>
      <p class="hint" id="upd-progress"></p>
      <p class="hint" id="upd-warn" style="color:var(--red)"></p>
    </div>
  </section>`);

    async function visitExternal(url, what) {
      if (await cfg.confirm('Leave this panel?', `Do you want to visit ${what}? This opens in a new tab.`, 'Visit')) window.open(url, '_blank', 'noopener');
    }
    $('navGh').addEventListener('click', () => visitExternal(`https://github.com/${cfg.repo}`, 'our GitHub'));
    $('sideLicenseLink').addEventListener('click', (e) => {
      e.preventDefault();
      visitExternal(`https://github.com/${cfg.repo}/blob/master/LICENSE`, 'the license on GitHub');
    });
    if (cfg.onLogout) $('navLogout').addEventListener('click', cfg.onLogout);

    const PAGES = ['server', 'users', 'settings', 'system', 'update'];
    const system = cfg.urls.system && window.MeowSystem ? MeowSystem.mount({ el: $('systemRoot'), load: async () => (await fetch(cfg.urls.system)).json(), t, esc }) : null;
    function showPage(page, { push = true } = {}) {
      if (!PAGES.includes(page) || ((page === 'users' || page === 'settings' || page === 'system') && (!panel.users || (page === 'system' && !system)))) page = 'server';
      document.querySelectorAll('.side-item[data-page]').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
      document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${page}`));
      if (cfg.paths && push && location.pathname !== cfg.paths[page]) history.pushState({}, '', cfg.paths[page]);
      if (page === 'settings') loadSettingsPage();
      if (page === 'system') system.load();
      if (page === 'update') loadUpdatePage();
      if (cfg.onPage) cfg.onPage(page);
    }
    document.querySelectorAll('.side-item[data-page]').forEach((btn) => btn.addEventListener('click', () => showPage(btn.dataset.page)));
    function pageFromPath() {
      if (!cfg.paths) return 'server';
      return PAGES.find((k) => cfg.paths[k] === location.pathname.replace(/\/+$/, '')) || 'server';
    }
    if (cfg.paths) window.addEventListener('popstate', () => showPage(pageFromPath(), { push: false }));

    function refreshUpdateIndicator() {
      const show = !!(versionInfo && versionInfo.updateAvailable && panel.update);
      $('updateDot').style.display = show ? '' : 'none';
      $('updatePill').style.display = show ? '' : 'none';
    }
    async function loadVersion(refresh) {
      try {
        versionInfo = await (await fetch(refresh ? `${cfg.urls.version}?refresh=1` : cfg.urls.version)).json();
        refreshUpdateIndicator();
        if (versionInfo.version) {
          $('sideVersion').textContent = `v${versionInfo.label || versionInfo.version} · `;
          $('sideVersion').title = versionInfo.commit ? `${versionInfo.channel === 'dev' ? 'Development build' : 'Release'} · commit ${versionInfo.commit}` : '';
        }
      } catch (_) {}
    }
    setInterval(loadVersion, 5 * 60 * 1000);

    async function loadSettingsPage() {
      const r = await fetch(cfg.urls.settings);
      if (!r.ok) return;
      $('set-trustProxy').checked = !!(await r.json()).trustProxy;
    }
    $('set-trustProxy').addEventListener('change', async (e) => {
      const r = await fetch(cfg.urls.settings, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trustProxy: e.target.checked }) });
      $('set-status').textContent = t(r.ok ? 'Saved.' : 'Could not save.');
    });

    async function loadUpdatePage() {
      const v = await (await fetch(cfg.urls.version)).json();
      versionInfo = v;
      $('upd-current').textContent = v.version ? `v${v.label || v.version}${v.commit ? ` (${v.commit})` : ''}` : 'unknown';
      $('upd-latest').textContent = v.latestVersion ? `v${v.latestVersion}` : 'unknown';
      $('upd-date').textContent = v.publishedAt ? new Date(v.publishedAt).toLocaleDateString() : '-';
      $('upd-status').innerHTML = v.checkError && !v.latestVersion ? `<span class="badge">${t('could not check GitHub')}</span>` : v.updateAvailable
        ? '<span class="badge new">update available</span>'
        : '<span class="badge ok">up to date</span>';
      $('upd-release-link').onclick = (e) => { e.preventDefault(); visitExternal(v.releaseUrl, 'the release notes on GitHub'); };
      $('upd-now').style.display = v.updateAvailable && panel.update ? '' : 'none';
      $('upd-now').disabled = false;
      try {
        const lr = (await (await fetch(cfg.urls.updateStatus)).json()).lastResult;
        $('upd-warn').textContent = lr && lr.rolledBack ? t(`The last update to v${(lr.to || '').replace(/^v/, '')} failed (${lr.reason}) and was rolled back to v${lr.from}.`) : '';
      } catch (_) {}
      $('upd-progress').textContent = '';
    }
    $('upd-check').addEventListener('click', async () => {
      $('upd-check').disabled = true;
      await loadVersion(true);
      await loadUpdatePage();
      $('upd-check').disabled = false;
    });
    $('upd-now').addEventListener('click', async () => {
      const running = await fetch(cfg.urls.version).then((r) => r.json()).then((v) => v.running || []).catch(() => []);
      const ok = await cfg.confirm('Update now?', running.length
        ? `meowmarism recommends stopping all servers before updating. If you continue, the running servers (${running.join(', ')}) are stopped, the panel waits until they have saved and shut down, installs the update and starts them again. The panel is unreachable for a few seconds.`
        : 'The new release is installed. The panel is unreachable for a few seconds.', 'Continue');
      if (!ok) return;
      $('upd-now').disabled = true;
      $('upd-progress').textContent = 'Downloading and installing...';
      const r = await fetch(cfg.urls.update, { method: 'POST' });
      if (!r.ok) { $('upd-progress').textContent = (await r.json().catch(() => ({}))).error || 'Could not start the update.'; $('upd-now').disabled = false; return; }
      const before = versionInfo?.version;
      const started = Date.now();
      const poll = setInterval(async () => {
        try {
          const vr = await fetch(cfg.urls.version);
          if (vr.status === 401) { clearInterval(poll); location.reload(); return; }
          const v = await vr.json();
          if (v.version && v.version !== before) { clearInterval(poll); location.reload(); return; }
          const st = await (await fetch(cfg.urls.updateStatus)).json();
          if (st.error) { clearInterval(poll); $('upd-progress').textContent = `Update failed: ${st.error}`; $('upd-now').disabled = false; }
          else if (st.step) $('upd-progress').textContent = `${t(st.step)}...`;
        } catch (_) { $('upd-progress').textContent = 'Restarting...'; }
        if (Date.now() - started > 5 * 60 * 1000) { clearInterval(poll); $('upd-progress').textContent = 'This is taking too long. Reload the page or check the host.'; $('upd-now').disabled = false; }
      }, 2000);
    });

    // account: { username, role, loggedIn }, panelCaps: { users, create, update }
    function setAccount(account, panelCaps) {
      panel = panelCaps || {};
      $('navLogout').style.display = account.loggedIn ? '' : 'none';
      $('sideAccountName').textContent = account.username || 'not logged in';
      $('sideAccountRole').textContent = account.role || '';
      $('sideAvatar').textContent = account.username ? account.username.slice(0, 1) : '?';
      $('navUsers').style.display = panel.users ? '' : 'none';
      $('navSettings').style.display = panel.users ? '' : 'none';
      $('navSystem').style.display = panel.users && system ? '' : 'none';
      refreshUpdateIndicator();
    }

    loadVersion();
    return { showPage, pageFromPath, setAccount, loadVersion, visitExternal };
  }
  window.MeowShell = { mount };
})();
