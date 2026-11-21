// Backups, mods, files, access, startup and automation wiring.
const BACKUPS = MeowBackups.mount({
  el: $('backupsRoot'),
  load: async () => (await fetch('/api/backups')).json(),
  create: () => fetch('/api/backup', { method: 'POST' }),
  remove: (name) => fetch('/api/backups/' + encodeURIComponent(name), { method: 'DELETE' }),
  restore: (name) => fetch(`/api/backups/${encodeURIComponent(name)}/restore`, { method: 'POST' }),
  downloadHref: (name) => `/api/backups/${encodeURIComponent(name)}`,
  t, esc,
  confirm: (title, message, label, danger) => modalConfirm(title, message, label, danger),
});
const loadBackups = () => BACKUPS.load();

// --- Mods ---
const MODS = MeowMods.mount({
  el: $('modsRoot'),
  load: async () => (await fetch('/api/mods')).json(),
  toggle: (name, enable) => fetch('/api/mods/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, enable }) }),
  modrinthBase: () => `${window.__BASE || ''}/api/modrinth`,
  t, esc, toast,
  refreshMs: 15000, isVisible: () => currentPage === 'mods',
});
const loadMods = () => MODS.load();
const MR = MODS.modrinth;

// --- Files ---
const FILES = MeowFiles.mount({
  el: $('filesRoot'),
  base: () => `${window.__BASE || ''}/api/files`,
  rootName: () => INST_NAME,
  t, esc, toast,
  confirm: (title, message, label, danger) => modalConfirm(title, message, label, danger),
  isVisible: () => $('page-files')?.classList.contains('active'),
});
document.querySelector('[data-page="files"]')?.addEventListener('click', () => FILES.load('.'));

// Link back to the controller (instance list) - assumes it's on the same
// host, default controller port. Overridable if a worker ever needs a
// different controller address.
$('backToController').href = '/';

// --- Access (whitelist / ops / bans) ---
const ACCESS = MeowAccess.mount({
  el: $('accessRoot'),
  load: async () => (await fetch(`${window.__BASE || ''}/api/access`)).json(),
  act: (list, action, name) => post('/api/access', { list, action, name }),
  t, esc, toast,
  isVisible: () => currentPage === 'access',
});
ACCESS.load();
document.querySelector('[data-page="access"]')?.addEventListener('click', () => ACCESS.load());

// --- Startup (memory, JVM flags, Java, limits, autostart) ---
async function loadStartup() {
  try {
    const c = await (await fetch('/api/startup')).json();
    $('stAutoStart').checked = !!c.autoStart;
    $('stRamMin').value = c.ramMinMB || '';
    $('stRamMax').value = c.ramMaxMB || '';
    $('stPreset').value = c.jvmPreset || 'default';
    $('stExtra').value = c.extraJvmArgs || '';
    $('stJava').value = c.javaPath || '';
    $('stCpu').value = c.cpuCores || 0;
    $('stHardMem').value = c.hardMemLimitMB || 0;
    const modes = { cgroup: 'Limits are enforced with systemd cgroups.', taskset: 'CPU limits are enforced by pinning to cores; the RAM limit is not enforced on this host.', none: 'This host cannot enforce CPU or RAM limits for a process (needs systemd user cgroups).' };
    $('stLimitsHint').textContent = modes[c.limitsPossible] || '';
    const j = c.java || {};
    const short = j.required && (j.found == null || j.found < j.required);
    $('stJavaHint').textContent = j.required ? (short ? t('Minecraft {mc} needs Java {need}, found {found}.', { mc: INST_MC(), need: j.required, found: j.found == null ? t('none') : j.found }) : t('Java {found} is installed (Java {need} needed).', { need: j.required, found: j.found })) : '';
    $('stJavaHint').style.color = short ? 'var(--red)' : '';
    $('stJavaActions').style.display = short ? '' : 'none';
    $('btnInstallJava').textContent = t('Install Java {need}', { need: j.required });
  } catch (err) { console.error(err); }
}
$('btnSaveStartup')?.addEventListener('click', () => {
  const body = { autoStart: $('stAutoStart').checked, jvmPreset: $('stPreset').value, extraJvmArgs: $('stExtra').value, javaPath: $('stJava').value, cpuCores: Number($('stCpu').value) || 0, hardMemLimitMB: Number($('stHardMem').value) || 0 };
  if ($('stRamMax').value) { body.ramMaxMB = Number($('stRamMax').value); body.ramMinMB = Number($('stRamMin').value) || undefined; }
  fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then((r) => r.json()).then((d) => { if (d.ok) { toast('Startup settings saved'); loadStartup(); } else toast(d.error || 'Could not save', 'error'); });
});

// --- Automation (scheduled restarts, backups, sleep, crash handling) ---
async function loadAutomation() { loadStartup(); return AUTOMATION.load(); }

// --- Update check ---




// --- Network (proxy instances) ---
const NETWORK = MeowNetwork.mount({
  el: $('networkRoot'),
  load: async () => (await fetch(`${location.origin}/_meta/api/proxy/${encodeURIComponent(INST_NAME)}`, { cache: 'no-store' })).json(),
  save: async (body) => {
    const r = await fetch(`${location.origin}/_meta/api/proxy/${encodeURIComponent(INST_NAME)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  },
  t, esc, toast,
  templates: {
    list: async () => (await fetch(`${location.origin}/_meta/api/templates`, { cache: 'no-store' })).json(),
    remove: async (name) => { const r = await fetch(`${location.origin}/_meta/api/templates/${encodeURIComponent(name)}`, { method: 'DELETE' }); if (!r.ok) throw new Error(t('Could not remove the template')); },
    add: async (body) => {
      const r = await fetch(`${location.origin}/_meta/api/instances`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, proxy: INST_NAME }) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    },
    creation: async () => (await fetch(`${location.origin}/_meta/api/create-log`, { cache: 'no-store' })).json(),
  },
});

// --- Database (optional feature) ---
const DATABASE = MeowDatabase.mount({
  el: $('databaseRoot'),
  t, esc, toast,
  confirm: (title, message, label) => modalConfirm(title, message, label, true),
  status: async () => (await fetch(`${location.origin}/_meta/api/database/status`, { cache: 'no-store' })).json(),
  targets: (st) => [{ id: 'server', label: 'This server' }, ...(st && st.shared ? [{ id: 'shared', label: 'Whole network' }] : [])],
  api: async (target, method, sub, body) => {
    const base = target === 'shared' ? '/api/database/shared' : `/api/database/server/${encodeURIComponent(INST_NAME)}`;
    const r = await fetch(`${location.origin}/_meta${base}${sub || ''}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  },
});

// --- Start order (which servers this one needs) ---
async function loadDeps() {
  const box = $('depList');
  if (!box) return;
  try {
    const list = (await (await fetch(`${location.origin}/_meta/api/instances`, { cache: 'no-store' })).json()).instances || [];
    const mine = list.find((i) => i.name === INST_NAME);
    const picked = new Set((mine && mine.dependsOn) || []);
    const others = list.filter((i) => i.name !== INST_NAME);
    box.innerHTML = others.length
      ? others.map((i) => `<label class="hint" style="display:block"><input type="checkbox" data-dep="${esc(i.name)}" ${picked.has(i.name) ? 'checked' : ''}> ${esc(i.name)}</label>`).join('')
      : `<div class="hint">${esc(t('No other instances yet.'))}</div>`;
  } catch (_) { /* leave the list empty */ }
}
$('btnSaveDeps')?.addEventListener('click', async () => {
  try {
    const dependsOn = [...document.querySelectorAll('#depList [data-dep]:checked')].map((b) => b.dataset.dep);
    const r = await fetch(`${location.origin}/_meta/api/instances/${encodeURIComponent(INST_NAME)}/dependencies`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dependsOn }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    toast(t('Saved'));
  } catch (e) { toast(e.message, 'error'); }
});
document.addEventListener('DOMContentLoaded', () => { loadDeps(); });
