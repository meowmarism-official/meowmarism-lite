// Create dialog parts for modpacks: the source choice (blank server or modpack) and the modpack picker. Shared by every product.
// mountSource({ el, t, esc, onChange(mode) }) -> { mode() }
// mountPicker({ el, t, esc, loaders, api, iconSrc?(url), maxRamMB?: number | () => number }) -> { validate(), value(), reset() }
//   loaders: loaders this edition can run; others are shown but cannot be chosen
//   api: { search({ query, offset }) -> { total, hits }, versions(projectId) -> [version], preview(versionId) -> summary }
(function () {
  const LOADER_NAMES = { fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', quilt: 'Quilt', vanilla: 'Vanilla' };
  const loaderName = (l) => LOADER_NAMES[l] || l;

  function mountSource(cfg) {
    const { t, esc } = cfg;
    let mode = 'blank';
    const card = (id, title, text) => `<button type="button" class="source-card" data-mode="${id}"><b>${esc(t(title))}</b><span>${esc(t(text))}</span></button>`;
    cfg.el.innerHTML = `<div class="source-grid">${card('blank', 'Blank server', 'Choose the loader and version yourself.')}${card('modpack', 'From modpack', 'Pick a Modrinth modpack and get it running.')}</div>`;
    const paint = () => cfg.el.querySelectorAll('.source-card').forEach((b) => b.classList.toggle('selected', b.dataset.mode === mode));
    cfg.el.addEventListener('click', (e) => {
      const b = e.target.closest('.source-card');
      if (!b) return;
      mode = b.dataset.mode; paint();
      if (cfg.onChange) cfg.onChange(mode);
    });
    paint();
    return { mode: () => mode };
  }

  function mountPicker(cfg) {
    const { t, esc } = cfg;
    const supported = new Set(cfg.loaders || []);
    const icon = (url) => (url && /^https:\/\/cdn\.modrinth\.com\//.test(url) ? (cfg.iconSrc ? cfg.iconSrc(url) : url) : '');
    const q = (sel) => cfg.el.querySelector(sel);
    const gb = (bytes) => `${(bytes / 1073741824).toFixed(bytes >= 1073741824 ? 1 : 2)} GB`;
    const mb = (v) => (v >= 1024 ? `${+(v / 1024).toFixed(1)} GB` : `${v} MB`);
    let project = null, versions = [], summary = null, timer = null, seq = 0;
    let offset = 0;

    cfg.el.innerHTML = `
      <div class="mp-search">
        <input class="mp-query" type="search" placeholder="${esc(t('Search modpacks…'))}" autocomplete="off">
        <div class="mp-results"></div>
        <button type="button" class="btn mp-more" style="display:none">${esc(t('Show more'))}</button>
      </div>
      <div class="mp-detail" style="display:none"></div>`;

    const results = q('.mp-results'), more = q('.mp-more'), detail = q('.mp-detail'), search = q('.mp-search');

    function cardHtml(h) {
      const src = icon(h.icon);
      return `<button type="button" class="mp-card" data-id="${esc(h.id)}">
        ${src ? `<img src="${esc(src)}" alt="" width="40" height="40">` : '<span class="mp-noicon"></span>'}
        <span class="mp-card-text"><b>${esc(h.title)}</b><span>${esc(h.description || '')}</span>
        <small>${esc((h.categories || []).slice(0, 3).join(' · '))}${h.downloads != null ? ` · ${esc(Number(h.downloads).toLocaleString())} ${esc(t('downloads'))}` : ''}</small></span></button>`;
    }

    async function runSearch(append) {
      const mine = ++seq;
      if (!append) { offset = 0; results.innerHTML = `<p class="hint">${esc(t('Searching…'))}</p>`; more.style.display = 'none'; }
      let data;
      try { data = await cfg.api.search({ query: q('.mp-query').value.trim(), offset }); } catch (err) {
        if (mine === seq) results.innerHTML = `<p class="hint" style="color:var(--red)">${esc(err.message || t('Search failed'))}</p>`;
        return;
      }
      if (mine !== seq) return;
      const hits = data.hits || [];
      if (!append) results.innerHTML = '';
      if (!append && !hits.length) results.innerHTML = `<p class="hint">${esc(t('No modpacks found.'))}</p>`;
      results.insertAdjacentHTML('beforeend', hits.map(cardHtml).join(''));
      offset += hits.length;
      more.style.display = hits.length && offset < (data.total || 0) ? '' : 'none';
    }

    q('.mp-query').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => runSearch(false), 300); });
    more.addEventListener('click', () => runSearch(true));
    results.addEventListener('click', (e) => {
      const card = e.target.closest('.mp-card');
      if (card) choose(card.dataset.id);
    });

    async function choose(id) {
      search.style.display = 'none'; detail.style.display = '';
      detail.innerHTML = `<p class="hint">${esc(t('Loading…'))}</p>`;
      project = null; versions = []; summary = null;
      try {
        versions = await cfg.api.versions(id);
      } catch (err) { detail.innerHTML = `<p class="hint" style="color:var(--red)">${esc(err.message || t('Loading failed'))}</p>${backButton()}`; return; }
      const hit = [...results.querySelectorAll('.mp-card')].find((c) => c.dataset.id === id);
      project = { id, title: hit ? hit.querySelector('b').textContent : id, icon: hit && hit.querySelector('img') ? hit.querySelector('img').getAttribute('src') : '' };
      renderDetail();
    }

    const backButton = () => `<button type="button" class="btn mp-back">${esc(t('Choose another modpack'))}</button>`;

    function versionOptions() {
      return versions.map((v) => {
        const ok = v.loaders.some((l) => supported.has(l));
        const loaders = v.loaders.map(loaderName).join(', ');
        const label = `${v.versionNumber} · ${v.mcVersions[0] || '?'} · ${loaders}${ok ? '' : ` (${t('not supported here')})`}`;
        return `<option value="${esc(v.id)}"${ok ? '' : ' disabled'}>${esc(label)}</option>`;
      }).join('');
    }

    function renderDetail() {
      const first = versions.find((v) => v.loaders.some((l) => supported.has(l)));
      detail.innerHTML = `
        <div class="mp-head">${project.icon ? `<img src="${esc(project.icon)}" alt="" width="48" height="48">` : ''}<div><b>${esc(project.title)}</b></div>${backButton()}</div>
        ${versions.length ? `<div class="field"><label for="mp-version">${esc(t('Pack version'))}</label><select id="mp-version">${versionOptions()}</select></div>
        <div class="mp-summary"></div>` : `<p class="hint">${esc(t('This modpack has no version that can run on a server.'))}</p>`}`;
      if (first) { q('#mp-version').value = first.id; loadSummary(first.id); }
      else if (versions.length) q('.mp-summary').innerHTML = `<p class="hint" style="color:var(--red)">${esc(t('None of this modpack\'s versions can run on this edition.'))}</p>`;
    }

    detail.addEventListener('click', (e) => {
      if (e.target.closest('.mp-back')) { detail.style.display = 'none'; search.style.display = ''; project = null; summary = null; }
    });
    detail.addEventListener('change', (e) => { if (e.target.id === 'mp-version') loadSummary(e.target.value); });
    detail.addEventListener('input', (e) => {
      if (e.target.id === 'mp-ram') { q('#mp-ram-out').textContent = mb(Number(e.target.value)); }
    });

    async function loadSummary(versionId) {
      const box = q('.mp-summary');
      summary = null;
      box.innerHTML = `<p class="hint">${esc(t('Reading the modpack…'))}</p>`;
      let s;
      try { s = await cfg.api.preview(versionId); } catch (err) { box.innerHTML = `<p class="hint" style="color:var(--red)">${esc(err.message || t('Could not read the modpack'))}</p>`; return; }
      if (!q('#mp-version') || q('#mp-version').value !== versionId) return;
      if (!supported.has(s.loader)) {
        box.innerHTML = `<p class="hint" style="color:var(--red)">${esc(t('This pack needs {loader}, which this edition cannot run yet.', { loader: loaderName(s.loader) }))}</p>`;
        return;
      }
      summary = s;
      const ram = s.memory.recommendedMB;
      const hostMax = typeof cfg.maxRamMB === 'function' ? cfg.maxRamMB() : cfg.maxRamMB;
      const max = Math.max(ram, hostMax || 32768);
      box.innerHTML = `
        <div class="mp-facts">
          <div><span>Minecraft</span><b>${esc(s.minecraft)}</b></div>
          <div><span>${esc(t('Loader'))}</span><b>${esc(loaderName(s.loader))} ${esc(s.loaderVersion)}</b></div>
          <div><span>${esc(t('Mods'))}</span><b>${esc(String(s.modCount))}</b></div>
          <div><span>${esc(t('Download'))}</span><b>~${esc(gb(s.downloadBytes))}</b></div>
        </div>
        ${s.skippedCount ? `<p class="hint">${esc(t('{n} files are ignored because Meowmarism manages them.', { n: s.skippedCount }))}</p>` : ''}
        <div class="field"><label for="mp-ram">${esc(t('Memory'))} <b id="mp-ram-out">${esc(mb(ram))}</b></label>
          <input id="mp-ram" type="range" min="1024" max="${max}" step="512" value="${ram}">
          <div class="hint">${esc(t('Meowmarism recommendation'))}: ${esc(mb(ram))} · ${esc(t('minimum'))} ${esc(mb(s.memory.minimumMB))}</div></div>
        <div class="field"><label for="mp-name">${esc(t('Instance name'))}</label><input id="mp-name" value="${esc(suggestName(s.name || project.title))}"></div>`;
    }

    const suggestName = (n) => String(n).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'modpack';

    function value() {
      if (!summary) return null;
      return {
        projectId: project.id, versionId: summary.versionId, name: (q('#mp-name').value || '').trim(),
        ramMB: Number(q('#mp-ram').value), minecraft: summary.minecraft, loader: summary.loader, loaderVersion: summary.loaderVersion,
      };
    }
    function validate() {
      if (!project) return 'Pick a modpack';
      if (!summary) return 'Pick a modpack version that this edition can run';
      if (!value().name) return 'Pick an instance name';
      return null;
    }
    function reset() {
      project = null; versions = []; summary = null;
      detail.style.display = 'none'; search.style.display = '';
      q('.mp-query').value = '';
      runSearch(false);
    }
    return { validate, value, reset };
  }

  window.MeowModpack = { mountSource, mountPicker };
})();
