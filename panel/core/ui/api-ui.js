// Optional HTTP API on the Update page: switch it on or off, manage tokens and webhooks. Shared by every product.
// cfg: { el, t, esc, toast, confirm(title, message, label, danger), load(), setEnabled(bool), createToken(body), revokeToken(id),
//        createWebhook(body), removeWebhook(id), testWebhook(id) }
// state: { enabled, baseUrl, scopes: { name: description }, events: [type], instances: [name], tokens: [..], webhooks: [..] }
(function () {
  function mount(cfg) {
    const { t, esc, toast } = cfg;
    let state = null;
    let shown = null;
    let formOpen = null;

    const when = (at) => (at ? new Date(at).toLocaleString() : '—');

    function tokenForm() {
      const scopes = Object.entries(state.scopes).map(([name, text]) => `<label class="api-check" title="${esc(text)}"><input type="checkbox" name="scope" value="${esc(name)}" ${name === 'read' ? 'checked' : ''}> ${esc(name)}</label>`).join('');
      const instances = state.instances.map((n) => `<label class="api-check"><input type="checkbox" name="instance" value="${esc(n)}"> ${esc(n)}</label>`).join('') || `<span class="hint">${esc(t('No instances yet.'))}</span>`;
      return `<div class="api-form" id="apiTokenForm">
        <div class="field"><label>${esc(t('Name'))}</label><input id="apiTokenName" maxlength="60" placeholder="discord-bot"></div>
        <div class="field"><label>${esc(t('Permissions'))}</label><div class="api-checks">${scopes}</div></div>
        <div class="field"><label>${esc(t('Instances'))} <span class="hint">${esc(t('none checked = all'))}</span></label><div class="api-checks">${instances}</div></div>
        <div class="field"><label>${esc(t('Expires'))}</label><select id="apiTokenExpiry"><option value="">${esc(t('Never'))}</option><option value="30">30 ${esc(t('days'))}</option><option value="90">90 ${esc(t('days'))}</option><option value="365">365 ${esc(t('days'))}</option></select></div>
        <div class="row"><button class="btn primary" id="apiTokenCreate">${esc(t('Create token'))}</button><button class="btn" id="apiFormCancel">${esc(t('Cancel'))}</button></div></div>`;
    }

    function hookForm() {
      const events = state.events.map((e) => `<label class="api-check"><input type="checkbox" name="event" value="${esc(e)}"> ${esc(e)}</label>`).join('');
      return `<div class="api-form" id="apiHookForm">
        <div class="field"><label>URL</label><input id="apiHookUrl" placeholder="https://example.com/meowmarism"></div>
        <div class="field"><label>${esc(t('Events'))} <span class="hint">${esc(t('none checked = all'))}</span></label><div class="api-checks">${events}</div></div>
        <div class="row"><button class="btn primary" id="apiHookCreate">${esc(t('Add webhook'))}</button><button class="btn" id="apiFormCancel">${esc(t('Cancel'))}</button></div></div>`;
    }

    function secretBox() {
      if (!shown) return '';
      return `<div class="api-secret"><div class="card-meta">${esc(shown.label)}</div><code id="apiSecret">${esc(shown.value)}</code> <button class="btn" id="apiCopy">${esc(t('Copy'))}</button> <button class="btn" id="apiSecretDone">${esc(t('Done'))}</button></div>`;
    }

    function enabledBody() {
      const base = state.baseUrl || `${location.origin}/api/v1`;
      const tokens = state.tokens.map((k) => `<div class="api-row"><div><strong>${esc(k.name)}</strong><div class="card-meta">${k.scopes.map((s) => `<span class="api-chip">${esc(s)}</span>`).join(' ')} · ${esc(k.instances ? k.instances.join(', ') : t('all instances'))}</div></div><div class="card-meta">${esc(t('last used'))}: ${esc(when(k.lastUsedAt))}${k.expiresAt ? ` · ${esc(t('expires'))}: ${esc(when(k.expiresAt))}` : ''}</div><button class="btn danger" data-revoke="${esc(k.id)}" data-name="${esc(k.name)}">${esc(t('Revoke'))}</button></div>`).join('') || `<div class="hint">${esc(t('No tokens yet.'))}</div>`;
      const hooks = state.webhooks.map((h) => `<div class="api-row"><div><strong>${esc(h.name || h.url)}</strong><div class="card-meta">${esc(h.url)} · ${esc(h.events.join(', '))}</div></div><div class="card-meta">${h.lastAt ? `${esc(String(h.lastStatus))} · ${esc(when(h.lastAt))}` : esc(t('not called yet'))}${h.failures ? ` · ${h.failures}× ${esc(t('failed'))}` : ''}</div><div class="api-actions"><button class="btn" data-test="${esc(h.id)}">${esc(t('Test'))}</button><button class="btn danger" data-remove="${esc(h.id)}">${esc(t('Remove'))}</button></div></div>`).join('') || `<div class="hint">${esc(t('No webhooks yet.'))}</div>`;
      return `${secretBox()}
        <div class="api-block"><div class="api-head"><div class="card-title">${esc(t('Tokens'))}</div>${formOpen ? '' : `<button class="btn" id="apiNewToken">${esc(t('New token'))}</button>`}</div>${formOpen === 'token' ? tokenForm() : ''}${tokens}</div>
        <div class="api-block"><div class="api-head"><div class="card-title">Webhooks</div>${formOpen ? '' : `<button class="btn" id="apiNewHook">${esc(t('New webhook'))}</button>`}</div>${formOpen === 'hook' ? hookForm() : ''}${hooks}</div>
        <div class="api-block"><div class="card-title">${esc(t('Use it'))}</div><pre class="api-code">curl -H "Authorization: Bearer mmk_…" ${esc(base)}/instances</pre><p class="hint">${esc(t('Endpoints: instances, status, start / stop / restart, command, console, players, metrics, diagnostics, settings, backups, files, events (stream) and webhooks.'))}</p></div>`;
    }

    function render() {
      if (!state) { cfg.el.innerHTML = ''; return; }
      cfg.el.innerHTML = `<div class="card api-card"><div class="card-title">${esc(t('Optional features'))}</div>
        <div class="api-feature"><div><strong>${esc(t('HTTP API'))}</strong><div class="hint" style="margin-top:2px">${esc(t('Lets scripts and bots read status and control servers with API tokens. Off until you switch it on.'))}</div></div>
        <button class="btn ${state.enabled ? '' : 'primary'}" id="apiToggle">${esc(state.enabled ? t('Disable') : t('Enable'))}</button></div>
        ${state.enabled ? enabledBody() : ''}</div>`;
      wire();
    }

    const $ = (id) => cfg.el.querySelector(`#${id}`);
    const checked = (name) => [...cfg.el.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value);

    async function refresh() {
      try { state = await cfg.load(); } catch (_) { return; }
      render();
    }

    async function act(fn, okMessage) {
      try { await fn(); if (okMessage) toast(okMessage); await refresh(); } catch (e) { toast(e.message, 'error'); }
    }

    function wire() {
      $('apiToggle').onclick = () => act(async () => {
        if (state.enabled && !(await cfg.confirm(t('Disable the API?'), t('Every token stops working until you enable it again. Tokens and webhooks are kept.'), t('Disable'), true))) return;
        await cfg.setEnabled(!state.enabled);
        shown = null; formOpen = null;
      });
      if (!state.enabled) return;
      $('apiNewToken')?.addEventListener('click', () => { formOpen = 'token'; render(); });
      $('apiNewHook')?.addEventListener('click', () => { formOpen = 'hook'; render(); });
      $('apiFormCancel')?.addEventListener('click', () => { formOpen = null; render(); });
      $('apiTokenCreate')?.addEventListener('click', () => act(async () => {
        const expiry = $('apiTokenExpiry').value;
        const made = await cfg.createToken({ name: $('apiTokenName').value, scopes: checked('scope'), instances: checked('instance'), expiresInDays: expiry ? Number(expiry) : null });
        shown = { label: t('Copy this token now. It is not shown again.'), value: made.token };
        formOpen = null;
      }));
      $('apiHookCreate')?.addEventListener('click', () => act(async () => {
        const made = await cfg.createWebhook({ url: $('apiHookUrl').value, events: checked('event') });
        shown = { label: t('Signing secret of the webhook. It is not shown again.'), value: made.secret };
        formOpen = null;
      }));
      $('apiCopy')?.addEventListener('click', async () => { try { await navigator.clipboard.writeText(shown.value); toast(t('Copied')); } catch (_) { toast(t('Select the text and copy it yourself.'), 'error'); } });
      $('apiSecretDone')?.addEventListener('click', () => { shown = null; render(); });
      cfg.el.querySelectorAll('[data-revoke]').forEach((b) => { b.onclick = () => act(async () => {
        if (!(await cfg.confirm(t('Revoke this token?'), `${b.dataset.name}: ${t('Programs using it lose access immediately.')}`, t('Revoke'), true))) return;
        await cfg.revokeToken(b.dataset.revoke);
      }); });
      cfg.el.querySelectorAll('[data-remove]').forEach((b) => { b.onclick = () => act(() => cfg.removeWebhook(b.dataset.remove)); });
      cfg.el.querySelectorAll('[data-test]').forEach((b) => { b.onclick = () => act(async () => {
        const r = await cfg.testWebhook(b.dataset.test);
        toast(r && r.ok ? t('The webhook answered.') : t('The webhook did not answer with 2xx.'), r && r.ok ? 'ok' : 'error');
      }); });
    }

    render();
    return { load: refresh, render };
  }
  window.MeowApi = { mount };
})();
