// Mods page: Installed (enabled and disabled lists with filter and sorting), Browse Modrinth and Updates. Shared by every product.
// cfg: { el, load() -> { enabled, disabled }, toggle(name, enable), modrinthBase() -> API prefix, t, esc, toast, refreshMs?, isVisible?() }
(function () {
  function mount(cfg) {
    const { t, esc, toast } = cfg;
    cfg.el.innerHTML = `
        <div class="mods-tabs" style="display:flex;gap:6px;margin-bottom:14px">
          <button class="btn primary" data-mods-tab="installed">Installed</button>
          <button class="btn" data-mods-tab="browse">Browse Modrinth</button>
          <button class="btn" data-mods-tab="updates">Updates <span class="tag" id="modsUpdateCount" style="display:none">0</span></button>
        </div>
        <div id="modsInstalled">
        <div class="settings-toolbar"><div><div class="card-title">Installed mods</div><div class="settings-status" id="modsStatus">—</div></div>
          <div class="settings-actions"><input class="compact-input" id="modsSearch" placeholder="Filter mods..."></div>
        </div>
        <div class="grid">
          <article class="card span-6"><div class="card-head"><div class="card-title">Enabled</div><div class="card-meta" id="modsEnabledCount">0</div></div>
            <div class="table-wrap"><table class="data-table"><thead><tr><th data-mods-sort="name" style="cursor:pointer">File</th><th data-mods-sort="sizeMB" style="cursor:pointer">Size</th><th data-mods-sort="addedAt" style="cursor:pointer">Added</th><th></th></tr></thead><tbody id="modsEnabledRows"></tbody></table></div>
          </article>
          <article class="card span-6"><div class="card-head"><div class="card-title">Disabled</div><div class="card-meta" id="modsDisabledCount">0</div></div>
            <div class="table-wrap"><table class="data-table"><thead><tr><th data-mods-sort="name" style="cursor:pointer">File</th><th data-mods-sort="sizeMB" style="cursor:pointer">Size</th><th data-mods-sort="addedAt" style="cursor:pointer">Added</th><th></th></tr></thead><tbody id="modsDisabledRows"></tbody></table></div>
          </article>
        </div>
        <div class="hint" style="padding:10px 4px">Changes only take effect after a server restart.</div>
        </div>
        <div id="modsBrowse" style="display:none"></div>
        <div id="modsUpdates" style="display:none"></div>`;
    const $ = (id) => document.getElementById(id);
    let enabledList = [], disabledList = [];
    let sortKey = 'name', sortDir = 1;

    const sortMods = (list) => list.slice().sort((a, b) => {
      let av = a[sortKey], bv = b[sortKey];
      if (sortKey === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      if (av == null) av = sortKey === 'name' ? '' : -1;
      if (bv == null) bv = sortKey === 'name' ? '' : -1;
      return av < bv ? -1 * sortDir : av > bv ? 1 * sortDir : 0;
    });
    function render() {
      const q = ($('modsSearch').value || '').toLowerCase();
      const part = (rowsId, countId, list, enable) => {
        const filtered = sortMods(list.filter((m) => !q || m.name.toLowerCase().includes(q)));
        $(countId).textContent = `${filtered.length}/${list.length}`;
        $(rowsId).innerHTML = filtered.map((m) => `<tr><td>${esc(m.name)}</td><td>${m.sizeMB} MB</td><td class="hint">${m.addedAt ? new Date(m.addedAt).toLocaleString() : '?'}</td><td style="text-align:right"><button class="btn ${enable ? '' : 'warn'}" data-mod-toggle="${esc(m.name)}" data-mod-enable="${enable}">${esc(t(enable ? 'Enable' : 'Disable'))}</button></td></tr>`).join('')
          || `<tr><td colspan="4" class="hint">${esc(t(q ? 'No mods match.' : 'None.'))}</td></tr>`;
      };
      part('modsEnabledRows', 'modsEnabledCount', enabledList, false);
      part('modsDisabledRows', 'modsDisabledCount', disabledList, true);
      $('modsStatus').textContent = `${enabledList.length} ${t('enabled')} - ${disabledList.length} ${t('disabled')}`;
    }
    async function load() {
      try { const d = await cfg.load(); enabledList = d.enabled; disabledList = d.disabled; render(); } catch (err) { console.error(err); }
    }

    const MR = MeowModrinth.mount({
      browseEl: $('modsBrowse'),
      updatesEl: $('modsUpdates'),
      base: cfg.modrinthBase,
      t, esc, toast,
      onInstalled: () => load(),
      onUpdateCount: (n) => { $('modsUpdateCount').style.display = n ? '' : 'none'; $('modsUpdateCount').textContent = n; },
    });
    function show(tab) {
      cfg.el.querySelectorAll('[data-mods-tab]').forEach((b) => b.classList.toggle('primary', b.dataset.modsTab === tab));
      $('modsInstalled').style.display = tab === 'installed' ? '' : 'none';
      $('modsBrowse').style.display = tab === 'browse' ? '' : 'none';
      $('modsUpdates').style.display = tab === 'updates' ? '' : 'none';
      if (tab === 'installed') load();
      if (tab === 'browse') MR.search(true);
      if (tab === 'updates') MR.loadUpdates();
    }

    cfg.el.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-mods-tab]');
      if (tab) return show(tab.dataset.modsTab);
      const th = e.target.closest('[data-mods-sort]');
      if (th) {
        const key = th.dataset.modsSort;
        if (sortKey === key) sortDir *= -1; else { sortKey = key; sortDir = 1; }
        return render();
      }
      const btn = e.target.closest('[data-mod-toggle]');
      if (btn) {
        btn.disabled = true;
        Promise.resolve(cfg.toggle(btn.dataset.modToggle, btn.dataset.modEnable === 'true')).then(() => load()).finally(() => { btn.disabled = false; });
      }
    });
    $('modsSearch').addEventListener('input', render);
    if (cfg.refreshMs) setInterval(() => { if (!cfg.isVisible || cfg.isVisible()) load(); }, cfg.refreshMs);
    return { load, show, modrinth: MR, reset: () => MR.reset && MR.reset() };
  }
  window.MeowMods = { mount };
})();
