// Account management: user table and the add/edit dialog with presets, panel permissions and per-instance overrides.
// cfg: { el, base, instances() -> [name], role() -> 'owner'|'member', t, esc, toast, confirm(title, message, label, danger) }
(function () {
  const CAP_LABELS = { view: 'View', console: 'Console & players', power: 'Start / stop', files: 'Files', mods: 'Mods', backups: 'Backups', settings: 'Settings', remove: 'Remove instance' };
  const PANEL_LABELS = { users: 'Manage users', create: 'Create instances', update: 'Update the panel' };
  const PRESET_CAPS = {
    viewer: ['view'],
    operator: ['view', 'console', 'power'],
    manager: ['view', 'console', 'power', 'files', 'mods', 'backups', 'settings'],
    administrator: ['view', 'console', 'power', 'files', 'mods', 'backups', 'settings', 'remove'],
  };
  const PRESET_PANEL = {
    administrator: { users: true, create: true, update: true },
    manager: { users: false, create: true, update: false },
    operator: { users: false, create: false, update: false },
    viewer: { users: false, create: false, update: false },
  };
  const same = (a, b) => a.length === b.length && a.every((c) => b.includes(c));
  function presetOf(caps) {
    if (!caps.length) return 'none';
    for (const [name, list] of Object.entries(PRESET_CAPS)) if (same(caps, list)) return name;
    return 'custom';
  }

  function mount(cfg) {
    const { t, esc, toast } = cfg;
    let users = [];
    let capList = [];
    let editing = null;

    cfg.el.innerHTML = `
      <div class="mu-bar"><div><div class="mu-title">${esc(t('Manage users'))}</div><div class="mu-sub">${esc(t('Who can log in, and exactly what each account may do.'))}</div></div><button class="btn primary" data-mu="add">${esc(t('Add user'))}</button></div>
      <div class="card"><table class="data-table"><thead><tr><th>${esc(t('Username'))}</th><th>${esc(t('Access'))}</th><th></th></tr></thead><tbody data-mu="rows"></tbody></table></div>`;
    document.body.insertAdjacentHTML('beforeend', `
      <div class="mu-back" data-mu="back"><div class="mu-modal">
        <div class="mu-modal-title" data-mu="title"></div>
        <div class="mu-field" data-mu="nameRow"><label>${esc(t('Username'))}</label><input data-mu="username" autocomplete="off"></div>
        <div class="mu-two"><div class="mu-field"><label>${esc(t('Password'))}</label><input data-mu="password" type="password" autocomplete="new-password"></div>
          <div class="mu-field"><label>${esc(t('Repeat password'))}</label><input data-mu="password2" type="password" autocomplete="new-password"></div></div>
        <div class="mu-field"><label>${esc(t('Preset'))}</label><select data-mu="preset"><option value="administrator">${esc(t('Administrator'))}</option><option value="manager">${esc(t('Manager'))}</option><option value="operator">${esc(t('Operator'))}</option><option value="viewer">${esc(t('Viewer'))}</option><option value="custom">${esc(t('Custom'))}</option></select></div>
        <div class="mu-perm-title">${esc(t('Panel'))}</div><div class="mu-perms" data-mu="panel"></div>
        <div class="mu-perm-title">${esc(t('Default access to every instance'))}</div><div class="mu-perms" data-mu="global"></div>
        <div class="mu-perm-title">${esc(t('Per-instance overrides'))}</div><table class="data-table"><tbody data-mu="instances"></tbody></table>
        <div class="mu-status" data-mu="status"></div>
        <div class="mu-actions"><button class="btn" data-mu="cancel">${esc(t('Cancel'))}</button><button class="btn primary" data-mu="save">${esc(t('Save'))}</button></div>
      </div></div>`);
    const q = (k) => document.querySelector(`[data-mu="${k}"]`);
    const post = (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    function describe(u) {
      if (u.role === 'owner') return t('Owner');
      const p = presetOf(u.access.global);
      const admin = u.panel.users && u.panel.create && u.panel.update && p === 'administrator';
      const base = admin ? t('Administrator') : p === 'none' ? t('No default access') : p === 'custom' ? t('Custom access') : t(p[0].toUpperCase() + p.slice(1));
      const extra = Object.keys(u.access.instances).length;
      return extra ? `${base} + ${extra} ${t(extra > 1 ? 'overrides' : 'override')}` : base;
    }

    async function load() {
      const r = await fetch(cfg.base);
      if (!r.ok) { q('rows').innerHTML = `<tr><td colspan="3" class="mu-hint">${esc(t('Not allowed.'))}</td></tr>`; return; }
      const d = await r.json();
      users = d.users; capList = d.instanceCaps;
      q('rows').innerHTML = users.map((u) => `<tr><td>${esc(u.username)}</td><td>${esc(describe(u))}</td><td style="text-align:right;white-space:nowrap">${u.role === 'owner' ? '' : `<button class="btn" data-mu-edit="${esc(u.username)}">${esc(t('Edit'))}</button> <button class="btn danger" data-mu-remove="${esc(u.username)}">${esc(t('Remove'))}</button>`}</td></tr>`).join('')
        || `<tr><td colspan="3" class="mu-hint">${esc(t('No accounts yet.'))}</td></tr>`;
    }

    const box = (group, cap, label, checked, disabled) => `<label class="mu-perm"><input type="checkbox" data-${group}="${cap}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>${esc(t(label))}</label>`;
    function renderCaps(access, panel) {
      q('panel').innerHTML = Object.keys(PANEL_LABELS).map((c) => box('mu-panelcap', c, PANEL_LABELS[c], panel[c], c === 'users' && cfg.role() !== 'owner')).join('');
      q('global').innerHTML = capList.map((c) => box('mu-gcap', c, CAP_LABELS[c], access.global.includes(c))).join('');
    }
    function readCaps() {
      const panel = {};
      document.querySelectorAll('[data-mu-panelcap]').forEach((b) => { panel[b.dataset.muPanelcap] = b.checked; });
      const global = [...document.querySelectorAll('[data-mu-gcap]')].filter((b) => b.checked).map((b) => b.dataset.muGcap);
      const instances = {};
      document.querySelectorAll('[data-mu-inst]').forEach((sel) => {
        if (sel.value === 'default' || sel.value === 'custom') return;
        instances[sel.dataset.muInst] = sel.value === 'none' ? [] : PRESET_CAPS[sel.value] || [];
      });
      return { panel, access: { global, instances } };
    }

    async function openDialog(username) {
      editing = username || null;
      const user = username ? users.find((u) => u.username === username) : null;
      q('title').textContent = user ? `${t('Edit')} ${user.username}` : t('Add user');
      q('nameRow').style.display = user ? 'none' : '';
      q('username').value = ''; q('password').value = ''; q('password2').value = '';
      q('password').placeholder = user ? t('Leave blank to keep the current one') : '';
      q('status').textContent = '';
      const access = user ? user.access : { global: PRESET_CAPS.viewer, instances: {} };
      const panel = user ? user.panel : PRESET_PANEL.viewer;
      const gp = presetOf(access.global);
      q('preset').value = !user ? 'viewer' : gp === 'administrator' && panel.users ? 'administrator' : gp === 'none' ? 'custom' : gp;
      renderCaps(access, panel);
      let names = [];
      try { names = await cfg.instances(); } catch (_) {}
      q('instances').innerHTML = names.map((n) => {
        const cur = access.instances[n];
        const custom = cur !== undefined && presetOf(cur) === 'custom';
        return `<tr><td>${esc(n)}</td><td><select data-mu-inst="${esc(n)}"><option value="default">${esc(t('Use default'))}</option><option value="none">${esc(t('No access'))}</option><option value="viewer">${esc(t('Viewer'))}</option><option value="operator">${esc(t('Operator'))}</option><option value="manager">${esc(t('Manager'))}</option><option value="administrator">${esc(t('Full'))}</option>${custom ? `<option value="custom" selected disabled>${esc(t('Custom'))}</option>` : ''}</select></td></tr>`;
      }).join('') || `<tr><td colspan="2" class="mu-hint">${esc(t('No instances yet.'))}</td></tr>`;
      for (const n of names) {
        const cur = access.instances[n];
        if (cur === undefined) continue;
        const p = presetOf(cur);
        const sel = document.querySelector(`[data-mu-inst="${CSS.escape(n)}"]`);
        if (sel && p !== 'custom') sel.value = p;
      }
      q('back').classList.add('open');
    }

    async function save() {
      const say = (m) => { q('status').textContent = m; };
      const password = q('password').value;
      if (password && password.length < 8) return say(t('Password must be at least 8 characters'));
      if (password !== q('password2').value) return say(t("Passwords don't match"));
      const settings = readCaps();
      if (!editing) {
        const username = q('username').value.trim();
        if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) return say(t('Username: 3-32 letters, digits, . _ -'));
        if (!password) return say(t('Enter a password'));
        const r = await post(cfg.base, { username, password, panel: settings.panel, access: settings.access });
        if (!r.ok) return say((await r.json()).error || t('Failed to add user'));
      } else {
        if (password) {
          const rp = await post(`${cfg.base}/${encodeURIComponent(editing)}/password`, { password });
          if (!rp.ok) return say((await rp.json()).error || t('Failed to change the password'));
        }
        const ra = await post(`${cfg.base}/${encodeURIComponent(editing)}/access`, settings);
        if (!ra.ok) return say((await ra.json()).error || t('Failed to save'));
      }
      q('back').classList.remove('open');
      load();
    }

    document.addEventListener('click', async (e) => {
      if (!cfg.el.contains(e.target) && !q('back').contains(e.target)) return;
      const rm = e.target.closest('[data-mu-remove]');
      if (rm) {
        const name = rm.dataset.muRemove;
        if (!(await cfg.confirm(t('Remove this user?'), `"${name}" ${t('will not be able to log in anymore.')}`, t('Remove'), true))) return;
        const r = await fetch(`${cfg.base}/${encodeURIComponent(name)}`, { method: 'DELETE' });
        if (!r.ok) toast((await r.json()).error || t('Failed'));
        return load();
      }
      const ed = e.target.closest('[data-mu-edit]');
      if (ed) return openDialog(ed.dataset.muEdit);
      if (e.target.closest('[data-mu="add"]')) return openDialog(null);
      if (e.target.closest('[data-mu="cancel"]')) return q('back').classList.remove('open');
      if (e.target.closest('[data-mu="save"]')) return save();
    });
    q('preset').addEventListener('change', (e) => {
      const v = e.target.value;
      if (v === 'custom') return;
      const p = PRESET_PANEL[v];
      renderCaps({ global: PRESET_CAPS[v], instances: {} }, cfg.role() === 'owner' ? p : { ...p, users: false });
    });
    return { load };
  }
  window.MeowUsers = { mount };
})();
