// Modrinth browsing for mods, plugins and datapacks: search cards, project details, installs and updates.
// Shared by every product. The page provides the containers and a few helpers, the server side is the modrinth module from core.
(function () {
  function mount(cfg) {
    const { t, esc, toast } = cfg;
    const $ = (id) => document.getElementById(id);
    const base = cfg.base;

    cfg.browseEl.innerHTML = `          <div class="settings-toolbar"><div><div class="card-title">Modrinth</div><div class="settings-status" id="mrNote">—</div></div>
            <div class="settings-actions"><select class="compact-select" id="mrKindSel" aria-label="What are you looking for?"></select><input class="compact-input" id="mrQuery" placeholder="Search Modrinth..." style="width:260px"><select class="compact-select" id="mrSort"><option value="relevance">Relevance</option><option value="downloads">Most downloaded</option><option value="follows">Most followed</option><option value="newest">Newest</option><option value="updated">Recently updated</option></select></div>
          </div>
          <div class="mr-note" id="mrKindNote" style="display:none"></div>
          <div id="mrResults" class="mr-grid"></div>
          <div class="hint" id="mrEmpty" style="display:none;padding:10px 4px">Nothing found.</div>
          <div style="padding:10px 0"><button class="btn" id="mrMore" style="display:none">Load more</button></div>
          <div class="hint" style="padding:6px 4px">Changes only take effect after a server restart. Required dependencies are installed automatically. Downloads come from Modrinth and are checked against their SHA-512.</div>
        `;
    cfg.updatesEl.innerHTML = `          <div class="settings-toolbar"><div><div class="card-title">Updates</div><div class="settings-status" id="mrUpdStatus">—</div></div>
            <div class="settings-actions"><button class="btn" id="mrUpdRefresh">Check again</button> <button class="btn primary" id="mrUpdAll" style="display:none">Update all</button></div>
          </div>
          <article class="card"><div class="table-wrap"><table class="data-table"><thead><tr><th>Mod</th><th>Installed</th><th>Latest</th><th></th></tr></thead><tbody id="mrUpdRows"></tbody></table></div></article>
          <div id="mrIncompat" style="display:none;margin-top:14px"><article class="card"><div class="card-head"><div class="card-title">No compatible version</div></div><div class="card-body hint" id="mrIncompatList"></div></article></div>
          <div class="hint" id="mrUnknown" style="padding:10px 4px"></div>
          <div class="hint" style="padding:6px 4px">Old files are moved to the mods-old (or plugins-old) folder instead of being deleted.</div>
        `;
    if (!$('mrDetBack')) document.body.insertAdjacentHTML('beforeend', `<div class="modal-back" id="mrDetBack"><div class="modal mr-det" role="dialog" aria-modal="true" style="position:relative"><div id="mrDet"></div></div></div>`);

  let mrReq = 0;
  let mrInfo = null, mrOffset = 0, mrTimer = null, mrUpdates = null, mrKind = 'mod';
  let mrCtx = { installable: true, kind: 'mod' };
  async function mrEnsureInfo() {
    if (!mrInfo) mrInfo = await (await fetch(base() + '/info')).json();
    return mrInfo;
  }
  const MR_KIND_LABELS = () => [['mod', t(mrInfo && mrInfo.kind === 'plugin' ? 'Plugins' : 'Mods')], ['datapack', t('Datapacks')], ['resourcepack', t('Resource packs')], ['shader', t('Shaders')], ['modpack', t('Modpacks')]];
  function mrRenderKinds() {
    $('mrKindSel').innerHTML = MR_KIND_LABELS().map(([k, label]) => `<option value="${k}"${k === mrKind ? ' selected' : ''}>${esc(label)}</option>`).join('');
  }
  const MR_KIND_NOTES = () => ({
    datapack: t('Datapacks are installed into the world folder and load after a restart or /reload.'),
    resourcepack: t('Resource packs are used by players, not by the server. You can look at them here and open them on Modrinth.'),
    shader: t('Shaders are used by players, not by the server. You can look at them here and open them on Modrinth.'),
    modpack: t('Modpacks are used by players to set up their game. You can look at them here and open them on Modrinth.'),
  });
  async function mrSearch(reset) {
    const my = ++mrReq;
    const info = await mrEnsureInfo();
    if (my !== mrReq) return;
    if (reset) { mrOffset = 0; $('mrResults').innerHTML = ''; }
    mrRenderKinds();
    const note = MR_KIND_NOTES()[mrKind];
    $('mrKindNote').style.display = note ? '' : 'none';
    $('mrKindNote').textContent = note || '';
    if (!(info.kinds && info.kinds[mrKind])) { $('mrNote').textContent = mrKind === 'mod' ? t('This server type has no mods or plugins on Modrinth.') : t('This server has no Minecraft version set.'); $('mrMore').style.display = 'none'; return; }
    $('mrNote').textContent = mrKind === 'mod'
      ? t('Showing {kind} for Minecraft {mc} ({loader}).', { kind: t(info.kind === 'plugin' ? 'plugins' : 'mods'), mc: info.mcVersion, loader: info.loader })
      : t('Showing {kind} for Minecraft {mc}.', { kind: MR_KIND_LABELS().find(([k]) => k === mrKind)[1].toLowerCase(), mc: info.mcVersion });
    const r = await fetch(`${base()}/search?q=${encodeURIComponent($('mrQuery').value)}&offset=${mrOffset}&sort=${encodeURIComponent($('mrSort').value)}&kind=${encodeURIComponent(mrKind)}`);
    const d = await r.json();
    if (my !== mrReq) return;
    if (!r.ok) { $('mrNote').textContent = t(d.error || 'Could not reach Modrinth'); return; }
    mrCtx = { installable: d.installable !== false, kind: d.kind || mrKind };
    $('mrResults').insertAdjacentHTML('beforeend', d.hits.map((h) => mrCard(h, mrCtx)).join(''));
    mrOffset += d.hits.length;
    $('mrEmpty').style.display = !mrOffset ? '' : 'none';
    $('mrMore').style.display = d.total > mrOffset ? '' : 'none';
  }
  $('mrQuery').addEventListener('input', () => { clearTimeout(mrTimer); mrTimer = setTimeout(() => mrSearch(true), 350); });
  $('mrMore').addEventListener('click', () => mrSearch(false));
  $('mrSort').addEventListener('change', () => mrSearch(true));
  $('mrKindSel').addEventListener('change', () => { mrKind = $('mrKindSel').value; mrSearch(true); });
  function mrReport(d) {
    if (!d.ok) { toast(t(d.error || 'Failed'), 'error'); return; }
    const files = d.installed.filter((x) => x.file);
    const warns = d.installed.filter((x) => x.warning);
    toast(files.length ? t('Installed {n} file(s), restart the server to load them', { n: files.length }) : t('Already up to date'));
    warns.forEach((w) => toast(w.warning, 'error'));
    cfg.onInstalled();
  }
  async function mrInstall(projectId, versionId) {
    const r = await fetch(base() + '/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId, versionId, kind: mrKind }) });
    const d = await r.json();
    mrReport(d);
    if (d.ok) {
      document.querySelectorAll(`[data-mr-install="${CSS.escape(projectId)}"]`).forEach((btn) => {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = t('Installed');
        btn.replaceWith(tag);
      });
    } else {
      document.querySelectorAll(`[data-mr-install="${CSS.escape(projectId)}"]`).forEach((btn) => { btn.disabled = false; });
    }
  }
  async function mrLoadUpdates() {
    const info = await mrEnsureInfo();
    if (!info.supported) { $('mrUpdStatus').textContent = t('This server type has no mods or plugins on Modrinth.'); return; }
    $('mrUpdStatus').textContent = t('Checking...');
    const r = await fetch(base() + '/updates');
    const d = await r.json();
    if (!r.ok) { $('mrUpdStatus').textContent = t(d.error || 'Could not reach Modrinth'); return; }
    mrUpdates = d;
    $('mrUpdStatus').textContent = d.updates.length ? t('{n} update(s) available', { n: d.updates.length }) : t('Everything is up to date');
    $('mrUpdAll').style.display = d.updates.length ? '' : 'none';
    cfg.onUpdateCount(d.updates.length);
    $('mrUpdRows').innerHTML = d.updates.map((u) => `<tr><td>${esc(u.title)}</td><td>${esc(u.current)}</td><td>${esc(u.latest)}</td><td style="text-align:right"><button class="btn" data-mr-update="${esc(u.file)}">Update</button></td></tr>`).join('');
    $('mrIncompat').style.display = d.incompatible.length ? '' : 'none';
    $('mrIncompatList').textContent = d.incompatible.map((x) => `${x.title} ${x.current}`).join(', ');
    $('mrUnknown').textContent = d.unknown.length ? t('{n} file(s) are not on Modrinth and are not checked: {names}', { n: d.unknown.length, names: d.unknown.join(', ') }) : '';
  }
  async function mrApplyUpdate(body) {
    const r = await fetch(base() + '/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    mrReport(await r.json());
    mrLoadUpdates();
  }
  $('mrUpdRefresh').addEventListener('click', mrLoadUpdates);
  $('mrUpdAll').addEventListener('click', () => mrApplyUpdate({ all: true }));

  // --- Modrinth cards and project details ---
  const MR_IMG = (u) => `${base()}/img?u=${encodeURIComponent(u)}`;
  const mrNum = (n) => {
    n = Number(n) || 0;
    if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '')}k`;
    return String(n);
  };
  const mrAgo = (iso) => {
    const days = (Date.now() - new Date(iso).getTime()) / 864e5;
    if (!Number.isFinite(days)) return '';
    if (days < 1) return t('today');
    if (days < 30) return t('{n}d ago', { n: Math.floor(days) });
    if (days < 365) return t('{n}mo ago', { n: Math.floor(days / 30) });
    return t('{n}y ago', { n: Math.floor(days / 365) });
  };
  const mrIcon = (icon, title, cls = '') => (icon ? `<img class="mr-icon ${cls}" alt="" loading="lazy" src="${MR_IMG(icon)}">` : `<div class="mr-icon ${cls}">${esc((title || '?').slice(0, 1).toUpperCase())}</div>`);
  const MR_LOW_DOWNLOADS = 50000;
  const mrLow = (n) => Number(n) < MR_LOW_DOWNLOADS;
  const mrChips = (list) => (list || []).map((c) => `<span class="mr-chip">${esc(c)}</span>`).join('');
  function mrCard(h, ctx) {
    const canInstall = !ctx || ctx.installable !== false;
    return `<article class="mr-card" data-mr-open="${esc(h.projectId)}" tabindex="0">
      ${mrIcon(h.icon, h.title)}
      <div class="mr-main">
        <div class="mr-title"><b>${esc(h.title)}</b><span class="mr-by">${esc(t('by'))} ${esc(h.author)}</span></div>
        <div class="mr-desc">${esc(h.description)}</div>
        <div class="mr-meta"><span>${mrNum(h.downloads)} ${esc(t('downloads'))}</span><span>${mrNum(h.follows)} ${esc(t('followers'))}</span>${h.updated ? `<span>${esc(mrAgo(h.updated))}</span>` : ''}${mrLow(h.downloads) ? `<span class="mr-chip warn" title="${esc(t('Fewer than 50,000 downloads. Fewer people have tried it, so check it before you install.'))}">${esc(t('Under 50k downloads'))}</span>` : ''}${mrChips(h.categories.slice(0, 3))}</div>
      </div>
      <div class="mr-act">${h.installed ? `<span class="tag">${t('Installed')}</span>` : canInstall ? `<button class="btn primary" data-mr-install="${esc(h.projectId)}">${t('Install')}</button>` : `<a class="btn" href="https://modrinth.com/${esc(ctx.kind)}/${esc(h.slug)}" target="_blank" rel="noopener noreferrer">${t('Open on Modrinth')}</a>`}</div>
    </article>`;
  }

  // Modrinth descriptions are Markdown with HTML mixed in: tags are dropped, text is escaped, only https links and Modrinth CDN images survive.
  function mrMd(src) {
    const text = String(src || '').replace(/\r/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(?:p|div|h[1-6]|li|tr)>/gi, '\n').replace(/<[^>]*>/g, '');
    const unesc = (v) => v.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    const inline = (raw) => esc(raw)
      .replace(/!\[([^\]]*)\]\((https:\/\/cdn\.modrinth\.com\/[^\s)]+)\)/g, (_, alt, u) => `<img class="mr-md-img" loading="lazy" alt="${alt}" src="${MR_IMG(unesc(u))}">`)
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer nofollow">${label}</a>`)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,!?]|$)/g, '$1<em>$2</em>');
    const out = [];
    let list = null;
    let code = null;
    let para = [];
    const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
    for (const line of text.split('\n')) {
      if (/^\s*```/.test(line)) {
        if (code) { out.push(`<pre>${esc(code.join('\n'))}</pre>`); code = null; } else { flushPara(); closeList(); code = []; }
        continue;
      }
      if (code) { code.push(line); continue; }
      let m;
      if (!line.trim()) { flushPara(); closeList(); continue; }
      if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) { flushPara(); closeList(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); continue; }
      if (/^\s*(?:-{3,}|\*{3,})\s*$/.test(line)) { flushPara(); closeList(); out.push('<hr>'); continue; }
      if ((m = /^\s*(?:[-*+]|(\d+)[.)])\s+(.*)$/.exec(line))) {
        flushPara();
        const kind = m[1] ? 'ol' : 'ul';
        if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
        out.push(`<li>${inline(m[2])}</li>`);
        continue;
      }
      if ((m = /^>\s?(.*)$/.exec(line))) { flushPara(); closeList(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
      closeList();
      para.push(line.trim());
    }
    if (code) out.push(`<pre>${esc(code.join('\n'))}</pre>`);
    flushPara();
    closeList();
    return out.join('') || `<p class="hint">${t('No description.')}</p>`;
  }

  const mrEnv = (v) => t({ required: 'required', optional: 'optional', unsupported: 'unsupported' }[v] || 'unknown');
  let mrDet = null;
  function mrCloseDetail() { $('mrDetBack').classList.remove('open'); mrDet = null; }
  async function mrOpenDetail(projectId) {
    $('mrDet').innerHTML = `<div class="mr-dbody"><div class="hint">${t('Loading...')}</div></div>`;
    $('mrDetBack').classList.add('open');
    const token = projectId;
    mrDet = { id: token };
    let p, versions;
    try {
      const [pr, vr] = await Promise.all([fetch(`${base()}/project?id=${encodeURIComponent(projectId)}`), fetch(`${base()}/versions?project=${encodeURIComponent(projectId)}&kind=${encodeURIComponent(mrKind)}`)]);
      p = await pr.json();
      if (!pr.ok) throw new Error(p.error || 'Could not reach Modrinth');
      versions = ((await vr.json()).versions) || [];
    } catch (err) {
      if (mrDet && mrDet.id === token) $('mrDet').innerHTML = `<div class="mr-dbody"><div class="hint">${esc(t(err.message))}</div><div class="mr-links"><button class="btn" data-mr-close>${t('Close')}</button></div></div>`;
      return;
    }
    if (!mrDet || mrDet.id !== token) return;
    const info = await mrEnsureInfo();
    const tabs = ['description', 'gallery', 'versions', 'info'];
    const labels = { description: t('Description'), gallery: t('Gallery'), versions: t('Versions'), info: t('Info') };
    const authors = p.team.map((m) => m.name).filter(Boolean);
    const ext = (href, label) => (href ? `<a class="btn" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>` : '');
    const panes = {
      description: `<div class="mr-md">${mrMd(p.body)}</div>`,
      gallery: p.gallery.length
        ? `<div class="mr-gal">${p.gallery.map((g) => `<figure data-mr-light="${esc(g.url)}"><img loading="lazy" alt="${esc(g.title || '')}" src="${MR_IMG(g.url)}">${g.title ? `<figcaption>${esc(g.title)}</figcaption>` : ''}</figure>`).join('')}</div>`
        : `<div class="hint">${t('No images.')}</div>`,
      versions: versions.length
        ? `<div class="hint" style="margin-bottom:10px">${esc(t('Compatible versions for Minecraft {mc}', { mc: info.mcVersion }))}</div>${versions.map((v) => `<div class="mr-ver"><div style="min-width:0"><b>${esc(v.name || v.number)}</b> <span class="mr-chip ${v.channel === 'release' ? 'rel' : v.channel}">${esc(v.channel)}</span>
            <div class="hint" style="margin-top:3px">${esc(v.number)} · ${esc((v.gameVersions || []).join(', '))} · ${esc(mrAgo(v.published))} · ${mrNum(v.downloads)} ${esc(t('downloads'))}${v.size ? ` · ${(v.size / 1048576).toFixed(1)} MB` : ''}</div></div>
            ${p.installable === false ? '' : `<button class="btn" data-mr-pick="${esc(v.id)}" data-mr-project="${esc(p.projectId)}">${t('Install')}</button>`}</div>`).join('')}`
        : `<div class="hint">${t('No compatible versions.')}</div>`,
      info: `<table class="mr-info"><tbody>
        <tr><td>${t('License')}</td><td>${esc(p.license ? (p.license.name || p.license.id || '-') : '-')}</td></tr>
        <tr><td>${t('Loaders')}</td><td>${mrChips(p.loaders) || '-'}</td></tr>
        <tr><td>${t('Environment')}</td><td>${esc(t('Client'))}: ${esc(mrEnv(p.environment.client))} · ${esc(t('Server'))}: ${esc(mrEnv(p.environment.server))}</td></tr>
        <tr><td>${t('Minecraft versions')}</td><td>${esc(p.gameVersions.join(', ') || '-')}</td></tr>
        <tr><td>${t('Published')}</td><td>${esc(p.published ? new Date(p.published).toLocaleDateString() : '-')}</td></tr>
        <tr><td>${t('Updated')}</td><td>${esc(p.updated ? new Date(p.updated).toLocaleDateString() : '-')}</td></tr>
        <tr><td>${t('Team')}</td><td>${esc(p.team.map((m) => `${m.name}${m.role ? ` (${m.role})` : ''}`).join(', ') || '-')}</td></tr>
        </tbody></table>
        <div class="mr-links">${ext(p.links.site, t('Open on Modrinth'))}${ext(p.links.source, t('Source code'))}${ext(p.links.issues, t('Issues'))}${ext(p.links.wiki, t('Wiki'))}${ext(p.links.discord, 'Discord')}</div>`,
    };
    $('mrDet').innerHTML = `<div class="mr-dhead">${mrIcon(p.icon, p.title)}
        <div style="min-width:0;flex:1"><div class="mr-dtitle">${esc(p.title)}</div>
          <div class="mr-dsub">${esc(p.description)}</div>
          <div class="mr-dstats"><span>${authors.length ? `${esc(t('by'))} ${esc(authors.join(', '))}` : ''}</span><span>${mrNum(p.downloads)} ${esc(t('downloads'))}</span><span>${mrNum(p.followers)} ${esc(t('followers'))}</span>${p.updated ? `<span>${esc(t('Updated'))} ${esc(mrAgo(p.updated))}</span>` : ''}</div>
          <div class="mr-meta">${mrChips(p.categories)}</div></div>
        <div style="display:flex;flex-direction:column;gap:8px;align-items:flex-end">${p.installed ? `<span class="tag">${t('Installed')}</span>` : p.installable === false ? `<a class="btn primary" href="${esc(p.links.site)}" target="_blank" rel="noopener noreferrer">${t('Open on Modrinth')}</a>` : `<button class="btn primary" data-mr-install="${esc(p.projectId)}">${t('Install')}</button>`}<button class="btn" data-mr-close>${t('Close')}</button></div></div>
      ${mrLow(p.downloads) ? `<div class="mr-warn" style="margin-top:12px">${esc(t('This project has fewer than 50,000 downloads. Fewer people have tried it, so read the description, look at the source code and be careful with the files you install.'))}</div>` : ''}
      <div class="mr-tabs">${tabs.map((k, i) => `<button data-mr-tab="${k}"${i ? '' : ' class="on"'}>${esc(labels[k])}</button>`).join('')}</div>
      <div class="mr-dbody" id="mrDetBody">${panes.description}</div>`;
    mrDet.panes = panes;
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('mrDetBack').classList.contains('open')) mrCloseDetail(); });
  $('mrDetBack').addEventListener('click', (e) => { if (e.target === $('mrDetBack')) mrCloseDetail(); });
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-mr-close]')) { mrCloseDetail(); return; }
    const tab = e.target.closest('[data-mr-tab]');
    if (tab && mrDet && mrDet.panes) {
      document.querySelectorAll('[data-mr-tab]').forEach((b) => b.classList.toggle('on', b === tab));
      $('mrDetBody').innerHTML = mrDet.panes[tab.dataset.mrTab];
      return;
    }
    const light = e.target.closest('[data-mr-light]');
    if (light) {
      const box = document.createElement('div');
      box.className = 'mr-light';
      box.innerHTML = `<img alt="" src="${MR_IMG(light.dataset.mrLight)}">`;
      box.addEventListener('click', () => box.remove());
      $('mrDet').parentNode.appendChild(box);
      return;
    }
    const card = e.target.closest('[data-mr-open]');
    if (card && !e.target.closest('button, a')) mrOpenDetail(card.dataset.mrOpen);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches && e.target.matches('[data-mr-open]')) mrOpenDetail(e.target.dataset.mrOpen);
  });
  document.addEventListener('click', async (e) => {
    const inst = e.target.closest('[data-mr-install]');
    const upd = e.target.closest('[data-mr-update]');
    const pick = e.target.closest('[data-mr-pick]');
    if (inst) { inst.disabled = true; await mrInstall(inst.dataset.mrInstall); }
    if (upd) { upd.disabled = true; await mrApplyUpdate({ files: [upd.dataset.mrUpdate] }); }
    if (pick) { pick.disabled = true; $('mrDetBack').classList.remove('open'); await mrInstall(pick.dataset.mrProject, pick.dataset.mrPick); }
  });

    // Another instance is shown: forget what was loaded for the previous one.
    function mrReset() {
      mrInfo = null; mrOffset = 0; mrKind = 'mod'; mrUpdates = null; mrReq++;
      $('mrResults').innerHTML = ''; $('mrQuery').value = ''; $('mrUpdRows').innerHTML = '';
      $('mrDetBack').classList.remove('open');
    }

    return { search: mrSearch, loadUpdates: mrLoadUpdates, reset: mrReset };
  }
  window.MeowModrinth = { mount };
})();
