// Network page of a proxy instance: which servers are behind it, where players join first, forced hosts.
// cfg: { el, t, esc, toast, load(), save({ servers, tryOrder, forcedHosts }) -> { changed, proxyChanged, errors },
//        templates?: { list() -> { templates }, remove(name), add({ template, name, entry }), creation() -> build log with link } }
// state: { ready, port, backends: [{ name, loader, mcVersion, port, linked, supported, reason, outOfSync }], tryOrder, forcedHosts }
(function () {
  function mount(cfg) {
    const { t, esc, toast } = cfg;
    let state = null;
    let draft = null;
    let result = null;
    let templates = [];
    let tplForm = null;
    let building = null;

    const $ = (id) => cfg.el.querySelector(`#${id}`);

    function fromState() {
      return {
        linked: new Set(state.backends.filter((b) => b.linked).map((b) => b.name)),
        entry: state.tryOrder[0] || '',
        hosts: Object.entries(state.forcedHosts).flatMap(([host, targets]) => targets.map((server) => ({ host, server }))),
      };
    }

    function dirty() {
      const base = fromState();
      return base.entry !== draft.entry || base.linked.size !== draft.linked.size || [...base.linked].some((n) => !draft.linked.has(n))
        || JSON.stringify(base.hosts) !== JSON.stringify(draft.hosts) || state.backends.some((b) => b.linked && b.outOfSync);
    }

    function backendRow(b) {
      const on = draft.linked.has(b.name);
      const note = !b.supported ? `<span class="net-note bad">${esc(t(b.reason))}</span>` : (b.outOfSync ? `<span class="net-note warn">${esc(t('The port changed, apply to update the proxy.'))}</span>` : '');
      return `<label class="net-row${b.supported ? '' : ' off'}"><input type="checkbox" data-link="${esc(b.name)}" ${on ? 'checked' : ''} ${b.supported ? '' : 'disabled'}>
        <span class="net-name"><strong>${esc(b.name)}</strong><span class="card-meta">${esc(b.loader)} ${esc(b.mcVersion || '')} · ${t('port')} ${b.port}</span></span>${note}</label>`;
    }

    function hostRow(h, i, names) {
      const options = names.map((n) => `<option value="${esc(n)}" ${n === h.server ? 'selected' : ''}>${esc(n)}</option>`).join('');
      return `<div class="net-host"><input data-host="${i}" value="${esc(h.host)}" placeholder="play.example.com"><select data-hostserver="${i}">${options}</select><button class="btn small danger" data-hostdel="${i}">${esc(t('Remove'))}</button></div>`;
    }

    function resultBox() {
      if (!result) return '';
      const parts = [];
      const restart = [...(result.proxyChanged ? [t('the proxy')] : []), ...result.changed];
      if (restart.length) parts.push(`<div>${esc(t('Restart to apply:'))} <strong>${restart.map(esc).join(', ')}</strong></div>`);
      else if (!result.errors.length) parts.push(`<div>${esc(t('Everything was already up to date.'))}</div>`);
      for (const e of result.errors) parts.push(`<div class="net-note bad">${esc(e.name)}: ${esc(t(e.error))}</div>`);
      return `<div class="net-result">${parts.join('')}</div>`;
    }

    function templatesCard() {
      if (!cfg.templates) return '';
      const rows = templates.map((x) => `<div class="net-row" style="cursor:default"><span class="net-name"><strong>${esc(x.name)}</strong><span class="card-meta">${esc(x.loader)} ${esc(x.mcVersion || '')}${x.description ? ` · ${esc(x.description)}` : ''}</span></span>
        <span style="margin-left:auto;display:flex;gap:6px"><button class="btn small primary" data-tadd="${esc(x.name)}" ${building ? 'disabled' : ''}>${esc(t('Add server'))}</button><button class="btn small danger" data-tdel="${esc(x.name)}" ${building ? 'disabled' : ''}>${esc(t('Remove'))}</button></span></div>`).join('');
      const form = tplForm ? `<div class="api-form" style="margin-top:10px"><div class="field"><label>${esc(t('Name'))} <span class="hint">${esc(t('a number is added when the name is taken'))}</span></label><input id="tplFormName" value="${esc(tplForm.name)}" maxlength="30"></div>
        <label class="api-check slim"><input type="checkbox" id="tplFormEntry" ${tplForm.entry ? 'checked' : ''}> ${esc(t('Make it the entry server'))}</label>
        <div class="row"><button class="btn primary" id="tplFormGo">${esc(t('Create and add'))}</button><button class="btn" id="tplFormCancel">${esc(t('Cancel'))}</button></div></div>` : '';
      const progress = building ? `<div class="hint" style="margin-top:10px">${esc(t(building.phase || 'Working...'))} · ${Math.round(building.progress || 0)}%</div>` : '';
      return `<div class="card"><div class="card-title">${esc(t('Templates'))}</div>
        <p class="hint" style="margin-top:0">${esc(t('Build new servers from a template and add them to this network in one step.'))}</p>
        ${rows || `<div class="hint">${esc(t('No templates yet. Save a server as a template on its Manage page.'))}</div>`}${form}${progress}</div>`;
    }

    async function build() {
      const body = { template: tplForm.template, name: $('tplFormName').value.trim() || tplForm.template, entry: $('tplFormEntry').checked };
      tplForm = null;
      building = { phase: 'Starting', progress: 0 };
      render();
      try {
        await cfg.templates.add(body);
        for (;;) {
          await new Promise((r) => setTimeout(r, 1500));
          const log = await cfg.templates.creation();
          building = { phase: log.phase, progress: log.progress };
          if (log.done) {
            building = null;
            if (log.error) toast(log.error, 'error'); else result = log.link || { changed: [], proxyChanged: false, errors: [] };
            break;
          }
          render();
        }
      } catch (e) { building = null; toast(e.message, 'error'); }
      state = await cfg.load();
      draft = fromState();
      render();
    }

    function render() {
      if (!state) { cfg.el.innerHTML = ''; return; }
      if (!state.ready) {
        cfg.el.innerHTML = `<div class="card"><div class="card-title">${esc(t('Network'))}</div><p class="hint" style="margin:0">${esc(t('Start the proxy once so it creates its configuration, then come back.'))}</p></div>`;
        return;
      }
      const names = [...draft.linked];
      const entryOptions = names.map((n) => `<option value="${esc(n)}" ${n === draft.entry ? 'selected' : ''}>${esc(n)}</option>`).join('');
      cfg.el.innerHTML = `<div class="net-page">
        <div class="card"><div class="card-title">${esc(t('Servers in this network'))}</div>
          <p class="hint" style="margin-top:0">${esc(t('The panel sets the proxy and each server up for secure forwarding. Players connect to the proxy on port'))} <strong>${state.port}</strong>.</p>
          ${state.backends.map(backendRow).join('') || `<div class="hint">${esc(t('No other instances yet.'))}</div>`}
          <div class="field" style="margin-top:12px"><label>${esc(t('Entry server'))} <span class="hint">${esc(t('where players join first and where they land if their server stops'))}</span></label>
            <select id="netEntry" ${names.length ? '' : 'disabled'}>${entryOptions}</select></div></div>
        <div class="card"><div class="card-title">${esc(t('Forced hosts'))}</div>
          <p class="hint" style="margin-top:0">${esc(t('Send players who join through a certain address straight to a server.'))}</p>
          ${draft.hosts.map((h, i) => hostRow(h, i, names)).join('')}
          <button class="btn small" id="netAddHost" ${names.length ? '' : 'disabled'}>${esc(t('Add host'))}</button></div>
        ${templatesCard()}
        <div class="row"><button class="btn primary" id="netApply" ${dirty() ? '' : 'disabled'}>${esc(t('Apply'))}</button></div>
        ${resultBox()}</div>`;
      wire();
    }

    function wire() {
      cfg.el.querySelectorAll('[data-link]').forEach((box) => box.addEventListener('change', () => {
        if (box.checked) draft.linked.add(box.dataset.link); else draft.linked.delete(box.dataset.link);
        if (!draft.linked.has(draft.entry)) draft.entry = [...draft.linked][0] || '';
        draft.hosts = draft.hosts.filter((h) => draft.linked.has(h.server));
        render();
      }));
      $('netEntry')?.addEventListener('change', (e) => { draft.entry = e.target.value; render(); });
      $('netAddHost')?.addEventListener('click', () => { draft.hosts.push({ host: '', server: [...draft.linked][0] }); render(); });
      cfg.el.querySelectorAll('[data-host]').forEach((input) => input.addEventListener('input', () => { draft.hosts[Number(input.dataset.host)].host = input.value.trim(); }));
      cfg.el.querySelectorAll('[data-hostserver]').forEach((sel) => sel.addEventListener('change', () => { draft.hosts[Number(sel.dataset.hostserver)].server = sel.value; render(); }));
      cfg.el.querySelectorAll('[data-hostdel]').forEach((b) => b.addEventListener('click', () => { draft.hosts.splice(Number(b.dataset.hostdel), 1); render(); }));
      $('netApply')?.addEventListener('click', apply);
      cfg.el.querySelectorAll('[data-tadd]').forEach((b) => b.addEventListener('click', () => { tplForm = { template: b.dataset.tadd, name: b.dataset.tadd, entry: false }; render(); }));
      cfg.el.querySelectorAll('[data-tdel]').forEach((b) => b.addEventListener('click', async () => {
        try { await cfg.templates.remove(b.dataset.tdel); templates = (await cfg.templates.list()).templates; render(); } catch (e) { toast(e.message, 'error'); }
      }));
      $('tplFormCancel')?.addEventListener('click', () => { tplForm = null; render(); });
      $('tplFormGo')?.addEventListener('click', build);
    }

    async function apply() {
      const servers = [...draft.linked];
      const forcedHosts = {};
      for (const h of draft.hosts) if (h.host) (forcedHosts[h.host] = forcedHosts[h.host] || []).push(h.server);
      try {
        result = await cfg.save({ servers, tryOrder: draft.entry ? [draft.entry] : [], forcedHosts });
        state = await cfg.load();
        draft = fromState();
        render();
      } catch (e) { toast(e.message, 'error'); }
    }

    async function load() {
      try { state = await cfg.load(); } catch (_) { return; }
      if (cfg.templates) { try { templates = (await cfg.templates.list()).templates; } catch (_) { /* keep the list */ } }
      if (!draft || !dirty()) draft = fromState();
      render();
    }

    return { load };
  }
  window.MeowNetwork = { mount };
})();
