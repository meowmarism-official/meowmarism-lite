// server.properties editor: grouped fields with descriptions, unsaved-change tracking, restart banner. Shared by every product.
// cfg: { el, load() -> the settings state, save(patch) -> { settings }, restart(), t, esc, toast, confirm(title, message, label, danger) }
(function () {
  function mount(cfg) {
    const { t, esc, toast } = cfg;
    const $ = (id) => document.getElementById(id);
    const dirtySettings = new Set();
    let settingsState = null;

    cfg.el.innerHTML = `<div class="restart-banner" id="restartBanner"><span id="restartBannerText"><strong>Restart required.</strong> Saved settings are waiting for a Minecraft server restart.</span><button class="btn" id="btnRestartSettings">Restart server</button></div>
<div class="pending-preview" id="pendingPreview"><div class="pending-head"><div class="card-title">Pending changes</div><div class="card-meta" id="pendingCount">0</div></div><div class="pending-list" id="pendingList"></div></div>
<div class="settings-toolbar"><div><div class="card-title">server.properties</div><div class="settings-status" id="settingsStatus">Loading settings…</div></div><div class="settings-actions"><button class="btn" id="btnResetSettings" disabled>Reset changes</button><button class="btn primary" id="btnSaveSettings" disabled>Save changes</button></div></div>
<div class="settings-grid" id="settingsGrid"><div class="card"><div class="card-body hint">Loading server settings…</div></div></div>`;

  function settingInputValue(el, field) { if (field.type === 'boolean') return el.checked; if (field.type === 'number') return Number(el.value); return el.value; }
  function renderSettingRow(f, value) {
    let control;
    if (f.type === 'boolean') control = `<label class="toggle-control"><input type="checkbox" data-setting="${esc(f.key)}" ${value ? 'checked' : ''}><span>${value ? 'On' : 'Off'}</span></label>`;
    else if (f.type === 'select') control = `<select class="setting-select" data-setting="${esc(f.key)}">${(f.options || []).map((o) => `<option value="${esc(o)}" ${String(o) === String(value) ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    else {
      const type = f.type === 'number' ? 'number' : 'text';
      control = `<input class="setting-input" type="${type}" data-setting="${esc(f.key)}" value="${esc(value ?? '')}" ${f.min != null ? `min="${f.min}"` : ''} ${f.max != null ? `max="${f.max}"` : ''} ${f.step != null ? `step="${f.step}"` : ''} ${f.maxLength != null ? `maxlength="${f.maxLength}"` : ''}>`;
    }
    const badge = f.restartRequired ? '<span class="setting-badge restart">restart</span>' : f.liveApply ? '<span class="setting-badge live">live</span>' : '';
    return `<div class="setting-row" data-row="${esc(f.key)}"><div><div class="setting-name">${esc(f.label)} <span class="setting-badges">${badge}</span></div><div class="setting-desc">${esc(f.description || '')}</div></div><div class="setting-control">${control}${f.suffix ? `<span class="setting-suffix">${esc(f.suffix)}</span>` : ''}</div></div>`;
  }
  function renderSettings(state, { preserveDirty = false } = {}) {
    if (!state) return;
    const preserved = {};
    if (preserveDirty) for (const key of dirtySettings) {
      const el = document.querySelector(`[data-setting="${CSS.escape(key)}"]`), field = settingsState?.fields?.find((f) => f.key === key);
      if (el && field) preserved[key] = settingInputValue(el, field);
    }
    settingsState = state;
    const groups = new Map();
    for (const field of state.fields || []) { if (!groups.has(field.group)) groups.set(field.group, []); groups.get(field.group).push(field); }
    $('settingsGrid').innerHTML = [...groups].map(([group, fields]) => `<section class="settings-card"><div class="settings-card-head"><div class="settings-card-title">${esc(group)}</div><div class="card-meta">${fields.length} settings</div></div><div class="settings-list">${fields.map((f) => renderSettingRow(f, Object.prototype.hasOwnProperty.call(preserved, f.key) ? preserved[f.key] : state.values?.[f.key])).join('')}</div></section>`).join('');
    $('settingsGrid').querySelectorAll('[data-setting]').forEach((el) => {
      const field = state.fields.find((f) => f.key === el.dataset.setting), event = field?.type === 'text' ? 'input' : 'change';
      el.addEventListener(event, () => markSettingDirty(el.dataset.setting));
    });
    for (const key of dirtySettings) $('settingsGrid').querySelector(`[data-row="${CSS.escape(key)}"]`)?.classList.add('dirty');
    updateSettingsUi();
  }
  function markSettingDirty(key) {
    const row = document.querySelector(`[data-row="${CSS.escape(key)}"]`), el = document.querySelector(`[data-setting="${CSS.escape(key)}"]`), field = settingsState?.fields?.find((f) => f.key === key);
    if (!el || !field) return;
    const now = settingInputValue(el, field), base = settingsState?.values?.[key];
    const same = field.type === 'number' ? Number(now) === Number(base) : String(now) === String(base);
    if (same) { dirtySettings.delete(key); row?.classList.remove('dirty'); } else { dirtySettings.add(key); row?.classList.add('dirty'); }
    if (field.type === 'boolean') el.nextElementSibling.textContent = el.checked ? 'On' : 'Off';
    updateSettingsUi();
  }
  function updateSettingsUi() {
    const dirty = dirtySettings.size, pending = settingsState?.pendingRestart?.length || 0;
    $('btnSaveSettings').disabled = !dirty; $('btnResetSettings').disabled = !dirty;
    $('settingsStatus').textContent = dirty ? `${dirty} unsaved change${dirty === 1 ? '' : 's'}` : `Synced · ${settingsState?.fields?.length || 0} settings`;
    $('restartBanner').classList.toggle('show', !!pending);
    $('restartBannerText').innerHTML = pending ? `<strong>Restart required.</strong> ${pending} saved setting${pending === 1 ? '' : 's'} waiting to become active.` : '<strong>Restart required.</strong>';
    const preview = $('pendingPreview'), list = $('pendingList');
    if (preview && list) {
      preview.classList.toggle('show', dirty > 0);
      $('pendingCount').textContent = `${dirty} change${dirty === 1 ? '' : 's'}`;
      const rows = [];
      for (const key of dirtySettings) {
        const field = settingsState?.fields?.find((f) => f.key === key), el = document.querySelector(`[data-setting="${CSS.escape(key)}"]`);
        if (!field || !el) continue;
        const oldVal = settingsState?.values?.[key], newVal = settingInputValue(el, field);
        rows.push(`<div class="pending-item"><span>${esc(field.label)}</span><span class="pending-old">${esc(oldVal)}</span><span class="pending-arrow">→</span><span class="pending-new">${esc(newVal)}</span><span class="pending-tag">${field.restartRequired ? 'restart' : field.liveApply ? 'live' : ''}</span></div>`);
      }
      list.innerHTML = rows.join('');
    }
  }
  function applySettingsState(state) { if (state) renderSettings(state, { preserveDirty: dirtySettings.size > 0 }); }

  $('btnSaveSettings').onclick = async () => {
    if (!settingsState || !dirtySettings.size) return;
    const patch = {};
    for (const key of dirtySettings) { const field = settingsState.fields.find((f) => f.key === key), el = document.querySelector(`[data-setting="${CSS.escape(key)}"]`); if (field && el) patch[key] = settingInputValue(el, field); }
    try { const result = await cfg.save(patch); dirtySettings.clear(); renderSettings(result.settings); toast(t('Server settings saved')); } catch (e) { toast(e.message, 'error'); }
  };
  $('btnResetSettings').onclick = () => { dirtySettings.clear(); renderSettings(settingsState); toast(t('Unsaved changes reset')); };
  $('btnRestartSettings').onclick = async () => { if (!(await cfg.confirm('Restart the server?', 'Players will be disconnected while it restarts.', 'Restart', true))) return; try { await cfg.restart(); toast(t('Server restart requested')); } catch (e) { toast(e.message, 'error'); } };

    async function load() { renderSettings(await cfg.load(), { preserveDirty: dirtySettings.size > 0 }); }
    return { render: applySettingsState, load };
  }
  window.MeowSettings = { mount };
})();
