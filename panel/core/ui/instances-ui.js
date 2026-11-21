// Instance cards and the summary strip. Shared by every product.
// Instance: { name, loader, loaderVersion, mcVersion, port, running, pill: { dot, label }, cpuPercent, rssMB, error, openAttr, canOpen, canManage }
(function () {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const bar = (pct) => `<div class="inst-bar"><i class="${pct > 85 ? 'hot' : pct > 60 ? 'warm' : ''}" style="width:${Math.min(100, Math.max(0, pct)).toFixed(0)}%"></i></div>`;

  function card(i, hostMemMB) {
    const L = MeowLoaders.info(i.loader || 'vanilla');
    const name = esc(i.name);
    const cpu = i.running && i.cpuPercent != null ? Math.max(0, i.cpuPercent) : null;
    const ram = i.running && i.rssMB != null ? i.rssMB : null;
    const usage = i.running && (cpu != null || ram != null)
      ? `<div class="inst-bars">
        <div><div class="inst-bar-label"><span>CPU</span><b>${cpu != null ? cpu.toFixed(0) + '%' : '-'}</b></div>${bar(cpu || 0)}</div>
        <div><div class="inst-bar-label"><span>Memory</span><b>${ram != null ? (ram / 1024).toFixed(1) + ' GB' : '-'}</b></div>${bar(ram != null && hostMemMB ? (ram / hostMemMB) * 100 : 0)}</div>
      </div>` : '';
    let actions = '';
    if (i.canOpen) actions += `<a class="btn primary grow" ${i.openAttr} style="text-align:center;text-decoration:none">Open</a>`;
    if (i.canManage) {
      actions += i.running
        ? `<button class="btn" data-act="restart" data-id="${name}">Restart</button><button class="btn danger" data-act="stop" data-id="${name}">Stop</button>`
        : `<button class="btn ${i.canOpen ? '' : 'primary grow'}" data-act="start" data-id="${name}">Start</button>`;
    }
    if (i.canCategorize) actions += `<button class="btn" data-act="category" data-id="${name}" data-category="${esc(i.category || '')}" title="Category">&#9776;</button>`;
    const sub = `${esc(L.label)}${i.loaderVersion && !['paper', 'purpur', 'vanilla', 'velocity'].includes(i.loader) ? ' ' + esc(i.loaderVersion) : ''} · ${esc(i.mcVersion || '-')}`;
    return `<article class="inst-card${i.running ? ' is-on' : ''}">
    <div class="inst-head">
      <div class="inst-logo" style="--lc:${L.color}" title="${esc(L.label)}">${MeowLoaders.svg(i.loader || 'vanilla', 26)}</div>
      <div class="inst-titles"><div class="inst-name" data-no-i18n>${i.canOpen ? `<a ${i.openAttr}>${name}</a>` : name}</div>
        <div class="inst-sub"><span data-no-i18n>${sub}</span></div></div>
      <span class="inst-pill"><span class="dot ${i.pill.dot}"></span>${esc(i.pill.label)}</span>
    </div>
    <div class="inst-meta"><span>Port <b>${i.port || '-'}</b></span></div>
    ${usage}
    ${i.error ? `<div class="inst-err">${esc(i.error)}</div>` : ''}
    <div class="inst-actions">${actions}</div>
  </article>`;
  }

  function summary(list) {
    const running = list.filter((i) => i.running);
    const ramGB = running.reduce((sum, i) => sum + (i.rssMB || 0), 0) / 1024;
    const cpu = running.reduce((sum, i) => sum + (i.cpuPercent || 0), 0);
    return list.length ? [
      [list.length, 'Instances'], [running.length, 'Running'], [ramGB.toFixed(1) + ' GB', 'Memory in use'], [cpu.toFixed(0) + '%', 'CPU in use'],
    ].map(([v, label]) => `<div class="inst-stat"><b>${v}</b><span>${label}</span></div>`).join('') : '';
  }

  const COLLAPSED_KEY = 'meow.collapsedCategories';
  const collapsed = () => { try { return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]')); } catch (_) { return new Set(); } };
  const saveCollapsed = (set) => { try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set])); } catch (_) { /* storage unavailable */ } };

  function section(title, items, hostMemMB, closed) {
    return `<section class="inst-cat${closed ? ' closed' : ''}"><button class="inst-cat-head" data-cat="${esc(title)}"><span class="inst-cat-arrow"></span><b data-no-i18n>${esc(title)}</b><span class="inst-cat-count">${items.length}</span></button>
      <div class="inst-grid">${items.map((i) => card(i, hostMemMB)).join('')}</div></section>`;
  }

  function render(gridEl, summaryEl, list, hostMemMB, emptyText) {
    summaryEl.innerHTML = summary(list);
    if (!gridEl.dataset.catBound) {
      gridEl.dataset.catBound = '1';
      gridEl.addEventListener('click', (e) => {
        const head = e.target.closest('.inst-cat-head');
        if (!head) return;
        const set = collapsed();
        const name = head.dataset.cat;
        if (set.has(name)) set.delete(name); else set.add(name);
        saveCollapsed(set);
        head.parentElement.classList.toggle('closed', set.has(name));
      });
    }
    const grouped = list.some((i) => i.category);
    gridEl.style.display = grouped ? 'block' : '';
    if (!list.length) { gridEl.innerHTML = `<div class="inst-empty" style="grid-column:1/-1">${emptyText}</div>`; return; }
    if (!grouped) { gridEl.innerHTML = list.map((i) => card(i, hostMemMB)).join(''); return; }
    const closed = collapsed();
    const names = [...new Set(list.map((i) => i.category || ''))].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
    gridEl.innerHTML = names.map((n) => section(n || 'Uncategorized', list.filter((i) => (i.category || '') === n), hostMemMB, closed.has(n || 'Uncategorized'))).join('');
  }

  window.MeowInstances = { card, summary, render };
})();
