// Optional HTTP API. mode 'toggle': the on/off card on the Update page. mode 'page': tokens and webhooks on the API page.
// cfg: { el, mode, t, esc, toast, confirm(title, message, label), load(), setEnabled(bool), createToken, updateToken(id, body), renewToken(id, body),
//        revokeToken(id), createWebhook, removeWebhook(id), testWebhook(id), onChange() }
// state: { enabled, baseUrl, scopes: { name: description }, events: [type], instances: [name], tokens: [..], webhooks: [..] }
(function () {
  const PRESETS = [
    ['Read only', ['read']],
    ['Control', ['read', 'power', 'console']],
    ['Everything', null],
  ];

  function mount(cfg) {
    const { t, esc, toast } = cfg;
    const page = cfg.mode === 'page';
    let state = null;
    let secret = null;
    let form = null;
    let copyLabel = null;
    let db = null;

    const when = (at) => (at ? new Date(at).toLocaleString() : '—');
    const $ = (id) => cfg.el.querySelector(`#${id}`);
    const checked = (name) => [...cfg.el.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value);
    const chips = (list) => list.map((s) => `<span class="api-chip">${esc(s)}</span>`).join(' ');

    function expiryText(k) {
      if (!k.expiresAt) return t('never expires');
      return `${k.expiresAt <= Date.now() ? t('expired') : t('expires')}: ${when(k.expiresAt)}`;
    }

    function tokenForm() {
      const edit = form.token;
      const scopes = Object.entries(state.scopes).map(([name, text]) => `<label class="api-check"><input type="checkbox" name="scope" value="${esc(name)}" ${(edit ? edit.scopes.includes(name) : name === 'read') ? 'checked' : ''}><span><strong>${esc(name)}</strong><small>${esc(t(text))}</small></span></label>`).join('');
      const instances = state.instances.map((n) => `<label class="api-check slim"><input type="checkbox" name="instance" value="${esc(n)}" ${edit && edit.instances && edit.instances.includes(n) ? 'checked' : ''}> ${esc(n)}</label>`).join('') || `<span class="hint">${esc(t('No instances yet.'))}</span>`;
      const presets = PRESETS.map(([label], i) => `<button type="button" class="btn small" data-preset="${i}">${esc(t(label))}</button>`).join('');
      const keep = edit && edit.expiresAt ? `<option value="keep" selected>${esc(t('keep'))}: ${esc(when(edit.expiresAt))}</option>` : '';
      return `<div class="api-form">
        <div class="api-form-title">${esc(edit ? t('Edit token') : t('New token'))}</div>
        <div class="field"><label>${esc(t('Name'))}</label><input id="apiTokenName" maxlength="60" placeholder="discord-bot" value="${esc(edit ? edit.name : '')}"></div>
        <div class="field"><label>${esc(t('Permissions'))}</label><div class="api-presets">${presets}</div><div class="api-checks wide">${scopes}</div></div>
        <div class="field"><label>${esc(t('Instances'))} <span class="hint">${esc(t('none checked = all'))}</span></label><div class="api-checks">${instances}</div></div>
        <div class="field"><label>${esc(t('Expires'))}</label><select id="apiTokenExpiry">${keep}<option value="" ${edit && !edit.expiresAt || !edit ? 'selected' : ''}>${esc(t('Never'))}</option><option value="30">30 ${esc(t('days'))}</option><option value="90">90 ${esc(t('days'))}</option><option value="365">365 ${esc(t('days'))}</option></select></div>
        <div class="row"><button class="btn primary" id="apiTokenSave">${esc(edit ? t('Save') : t('Create token'))}</button><button class="btn" data-close>${esc(t('Cancel'))}</button></div></div>`;
    }

    function hookForm() {
      const events = state.events.map((e) => `<label class="api-check slim"><input type="checkbox" name="event" value="${esc(e)}"> ${esc(e)}</label>`).join('');
      return `<div class="api-form"><div class="api-form-title">${esc(t('New webhook'))}</div>
        <div class="field"><label>URL</label><input id="apiHookUrl" placeholder="https://example.com/meowmarism"></div>
        <div class="field"><label>${esc(t('Events'))} <span class="hint">${esc(t('none checked = all'))}</span></label><div class="api-checks">${events}</div></div>
        <div class="row"><button class="btn primary" id="apiHookCreate">${esc(t('Add webhook'))}</button><button class="btn" data-close>${esc(t('Cancel'))}</button></div></div>`;
    }

    function secretBox() {
      if (!secret) return '';
      return `<div class="api-secret"><div class="api-secret-title">${esc(secret.label)}</div><code id="apiSecret">${esc(secret.value)}</code><div class="row"><button class="btn primary" id="apiCopy">${esc(copyLabel || t('Copy'))}</button><button class="btn" id="apiSecretDone">${esc(t('Done'))}</button></div></div>`;
    }

    function tokenRow(k) {
      const dead = k.expiresAt && k.expiresAt <= Date.now();
      return `<div class="api-token${dead ? ' dead' : ''}">
        <div class="api-token-main"><strong>${esc(k.name)}</strong><div class="api-chips">${chips(k.scopes)}</div>
          <div class="card-meta">${esc(k.instances ? k.instances.join(', ') : t('all instances'))}</div></div>
        <div class="card-meta api-token-info"><div>${esc(t('created'))}: ${esc(when(k.createdAt))}</div><div>${esc(t('last used'))}: ${esc(k.lastUsedAt ? when(k.lastUsedAt) : t('never'))}</div><div>${esc(expiryText(k))}</div>${k.renewedAt ? `<div>${esc(t('renewed'))}: ${esc(when(k.renewedAt))}</div>` : ''}</div>
        <div class="api-actions"><button class="btn small" data-edit="${esc(k.id)}">${esc(t('Edit'))}</button><button class="btn small" data-renew="${esc(k.id)}" data-name="${esc(k.name)}">${esc(t('Renew'))}</button><button class="btn small danger" data-revoke="${esc(k.id)}" data-name="${esc(k.name)}">${esc(t('Revoke'))}</button></div></div>`;
    }

    function hookRow(h) {
      return `<div class="api-token"><div class="api-token-main"><strong>${esc(h.name || h.url)}</strong><div class="card-meta">${esc(h.url)}</div><div class="api-chips">${chips(h.events.length ? h.events : [t('all events')])}</div></div>
        <div class="card-meta api-token-info">${h.lastAt ? `${esc(String(h.lastStatus))} · ${esc(when(h.lastAt))}` : esc(t('not called yet'))}${h.failures ? `<div>${h.failures}× ${esc(t('failed'))}</div>` : ''}</div>
        <div class="api-actions"><button class="btn small" data-test="${esc(h.id)}">${esc(t('Test'))}</button><button class="btn small danger" data-remove="${esc(h.id)}">${esc(t('Remove'))}</button></div></div>`;
    }

    function dbRow() {
      if (!cfg.database || !db) return '';
      const busy = !!(db.job && db.job.running);
      let line = '';
      if (db.enabled) {
        if (busy) line = (db.job.lines || []).slice(-1)[0] || t('Working...');
        else if (db.running) line = `${t('Running on port')} ${db.port}`;
        else line = db.error || (db.job && db.job.error) || t('Not running');
      }
      const hint = db.enabled && db.installed ? t('Installed and always on. It cannot be disabled while it is installed.') : !db.canDownload ? t('Needs mariadb-server installed on this host; the panel then runs it for you.') : t('Installs and runs a MariaDB for you: one database per server and one shared by the whole network. Off until you switch it on.');
      return `<div class="api-feature" style="border-top:1px solid var(--line);margin-top:8px"><div><strong>${esc(t('Database'))}</strong><div class="hint" style="margin-top:2px">${esc(hint)}</div>${line ? `<div class="card-meta" style="margin-top:4px">${esc(line)}</div>` : ''}</div>
        <div class="row">${db.enabled && !db.running && !busy ? `<button class="btn primary" id="dbRetry">${esc(t('Retry'))}</button>` : ''}${db.enabled && db.installed ? '' : `<button class="btn ${db.enabled ? '' : 'primary'}" id="dbToggle" ${busy ? 'disabled' : ''}>${esc(db.enabled ? t('Disable') : t('Enable'))}</button>`}</div></div>`;
    }

    function renderToggle() {
      cfg.el.innerHTML = `<div class="card api-card"><div class="card-title">${esc(t('Optional features'))}</div>
        <div class="api-feature"><div><strong>${esc(t('HTTP API'))}</strong><div class="hint" style="margin-top:2px">${esc(t('Lets scripts and bots read status and control servers with API tokens. Off until you switch it on.'))}</div></div>
        <button class="btn ${state.enabled ? '' : 'primary'}" id="apiToggle">${esc(state.enabled ? t('Disable') : t('Enable'))}</button></div>
        ${state.enabled ? `<p class="hint">${esc(t('Manage tokens and webhooks on the API page.'))}</p>` : ''}${dbRow()}</div>`;
    }

    function renderPage() {
      if (!state.enabled) {
        cfg.el.innerHTML = `<div class="card"><div class="card-title">API</div><p class="hint" style="margin:0">${esc(t('The API is off. Switch it on under Update, Optional features.'))}</p></div>`;
        return;
      }
      const base = state.baseUrl || `${location.origin}/api/v1`;
      cfg.el.innerHTML = `<div class="api-page">${secretBox()}
        <div class="card"><div class="api-head"><div><div class="card-title" style="margin:0">${esc(t('Tokens'))}</div><div class="hint" style="margin:2px 0 0">${esc(t('A token is a password for scripts. It is shown once; renew it if it leaks or is lost.'))}</div></div>${form ? '' : `<button class="btn primary" id="apiNewToken">${esc(t('New token'))}</button>`}</div>
          ${form && form.kind === 'token' ? tokenForm() : ''}${state.tokens.map(tokenRow).join('') || `<div class="hint">${esc(t('No tokens yet.'))}</div>`}</div>
        <div class="card"><div class="api-head"><div class="card-title" style="margin:0">Webhooks</div>${form ? '' : `<button class="btn" id="apiNewHook">${esc(t('New webhook'))}</button>`}</div>
          ${form && form.kind === 'hook' ? hookForm() : ''}${state.webhooks.map(hookRow).join('') || `<div class="hint">${esc(t('No webhooks yet.'))}</div>`}</div>
        <div class="card"><div class="card-title">${esc(t('Use it'))}</div><pre class="api-code">curl -H "Authorization: Bearer mmk_…" ${esc(base)}/instances</pre>
          <p class="hint" style="margin-bottom:0">${esc(t('Endpoints: instances, status, start / stop / restart, command, console, players, metrics, diagnostics, settings, backups, files, events (stream) and webhooks.'))}</p></div></div>`;
    }

    function render() {
      if (!state) { cfg.el.innerHTML = ''; return; }
      if (page) renderPage(); else renderToggle();
      wire();
    }

    async function refresh() {
      try { state = await cfg.load(); } catch (_) { return; }
      if (cfg.database) { try { db = await cfg.database.status(); } catch (_) { /* keep the last state */ } }
      render();
      if (db && db.job && db.job.running) setTimeout(refresh, 2000);
    }

    async function act(fn) {
      try { await fn(); await refresh(); if (cfg.onChange) cfg.onChange(state); } catch (e) { toast(e.message, 'error'); }
    }

    function selectSecret() {
      const node = $('apiSecret');
      if (!node) return;
      const range = document.createRange();
      range.selectNodeContents(node);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }

    async function copy() {
      let ok = false;
      try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(secret.value); ok = true; } } catch (_) {}
      if (!ok) {
        const area = document.createElement('textarea');
        area.value = secret.value;
        area.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.appendChild(area);
        area.select();
        try { ok = document.execCommand('copy'); } catch (_) {}
        area.remove();
      }
      if (!ok) selectSecret();
      copyLabel = ok ? t('Copied') : t('Selected, press Ctrl+C');
      render();
      if (!ok) selectSecret();
      setTimeout(() => { copyLabel = null; if (secret) { const b = $('apiCopy'); if (b) b.textContent = t('Copy'); } }, 2500);
    }

    function wire() {
      $('dbRetry')?.addEventListener('click', () => act(() => cfg.database.setEnabled(true)));
      $('dbToggle')?.addEventListener('click', () => act(async () => {
        if (db.enabled && !(await cfg.confirm(t('Disable the database?'), t('The database server stops. Your data is kept and comes back when you enable it again.'), t('Disable')))) return;
        await cfg.database.setEnabled(!db.enabled);
      }));
      $('apiToggle')?.addEventListener('click', () => act(async () => {
        if (state.enabled && !(await cfg.confirm(t('Disable the API?'), t('Every token stops working until you enable it again. Tokens and webhooks are kept.'), t('Disable')))) return;
        await cfg.setEnabled(!state.enabled);
        secret = null; form = null;
      }));
      if (!page || !state.enabled) return;
      $('apiNewToken')?.addEventListener('click', () => { form = { kind: 'token', token: null }; render(); });
      $('apiNewHook')?.addEventListener('click', () => { form = { kind: 'hook' }; render(); });
      cfg.el.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => { form = null; render(); }));
      cfg.el.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
        const preset = PRESETS[Number(b.dataset.preset)][1] || Object.keys(state.scopes);
        cfg.el.querySelectorAll('input[name="scope"]').forEach((i) => { i.checked = preset.includes(i.value); });
      }));
      $('apiTokenSave')?.addEventListener('click', () => act(async () => {
        const raw = $('apiTokenExpiry').value;
        const body = { name: $('apiTokenName').value, scopes: checked('scope'), instances: checked('instance') };
        if (raw !== 'keep') body.expiresInDays = raw ? Number(raw) : null;
        if (form.token) { await cfg.updateToken(form.token.id, body); } else {
          const made = await cfg.createToken(body);
          secret = { label: t('Copy this token now. It is not shown again.'), value: made.token };
        }
        form = null;
      }));
      $('apiHookCreate')?.addEventListener('click', () => act(async () => {
        const made = await cfg.createWebhook({ url: $('apiHookUrl').value, events: checked('event') });
        secret = { label: t('Signing secret of the webhook. It is not shown again.'), value: made.secret };
        form = null;
      }));
      $('apiCopy')?.addEventListener('click', copy);
      $('apiSecretDone')?.addEventListener('click', () => { secret = null; render(); });
      if (secret) selectSecretSoon();
      cfg.el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => { form = { kind: 'token', token: state.tokens.find((k) => k.id === b.dataset.edit) }; render(); }));
      cfg.el.querySelectorAll('[data-renew]').forEach((b) => b.addEventListener('click', () => act(async () => {
        if (!(await cfg.confirm(t('Renew this token?'), `${b.dataset.name}: ${t('It gets a new secret. The old one stops working at once, so update every program that uses it.')}`, t('Renew')))) return;
        const made = await cfg.renewToken(b.dataset.renew, {});
        secret = { label: `${b.dataset.name}: ${t('Copy the new token now. It is not shown again.')}`, value: made.token };
      })));
      cfg.el.querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', () => act(async () => {
        if (!(await cfg.confirm(t('Revoke this token?'), `${b.dataset.name}: ${t('Programs using it lose access immediately.')}`, t('Revoke')))) return;
        await cfg.revokeToken(b.dataset.revoke);
      })));
      cfg.el.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => act(() => cfg.removeWebhook(b.dataset.remove))));
      cfg.el.querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', () => act(async () => {
        const r = await cfg.testWebhook(b.dataset.test);
        if (!(r && r.ok)) toast(t('The webhook did not answer with 2xx.'), 'error');
      })));
    }

    function selectSecretSoon() { setTimeout(selectSecret, 0); }

    render();
    return { load: refresh, render };
  }
  window.MeowApi = { mount };
})();
