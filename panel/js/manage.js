// Scheduler, server software upgrade and instance deletion.
// --- Scheduler ---
const SCHEDULE = MeowSchedule.mount({
  el: $('scheduleRoot'),
  base: () => `${window.__BASE || ''}/api/schedule`,
  t, esc, toast, fmtDate,
  confirm: (title, message, label, danger) => modalConfirm(title, message, label, danger),
  isVisible: () => currentPage === 'schedule',
});
SCHEDULE.load();


// --- Server software upgrade ---
const CTRL = location.origin + '/_meta';
const INST_NAME = decodeURIComponent((location.pathname.match(/^\/instance\/([^/]+)/) || [])[1] || '');
let swState = null, swPoll = null;
const swUrl = (p) => `${CTRL}/api/instances/${encodeURIComponent(INST_NAME)}${p}`;
async function swLoad() {
  try {
    const d = await (await fetch(swUrl('/upgrade-status'))).json();
    if (d.error && !d.current) return;
    swState = d;
    const c = d.current;
    $('swCurrent').textContent = `${c.loader}${c.loaderVersion ? ' ' + c.loaderVersion : ''} · Minecraft ${c.mcVersion}`;
    const l = d.latest;
    $('btnRollback').style.display = l && !l.rolledBack ? '' : 'none';
    $('swLast').textContent = l ? (l.rolledBack ? t('Last upgrade was rolled back.') : t('Last upgrade: Minecraft {from} to {to}.', { from: l.from.mcVersion, to: l.to.mcVersion })) : '';
  } catch (err) { /* controller not reachable, leave the card as it is */ }
}
async function upgFillLoaders() {
  const c = swState.current;
  const noVersion = ['vanilla', 'paper', 'purpur'].includes(c.loader);
  $('upgLoaderWrap').style.display = noVersion ? 'none' : '';
  if (noVersion) return;
  $('upgLoader').innerHTML = `<option>${t('Loading...')}</option>`;
  const d = await (await fetch(`${CTRL}/api/loader-versions?loader=${encodeURIComponent(c.loader)}&mc=${encodeURIComponent($('upgMc').value)}`)).json();
  const list = Array.isArray(d) ? d : d.versions || [];
  $('upgLoader').innerHTML = list.map((v) => `<option value="${esc(v)}"${v === c.loaderVersion ? ' selected' : ''}>${esc(v)}</option>`).join('') || `<option value="">${t('none found')}</option>`;
}
async function upgOpen() {
  await swLoad();
const INST_MC = () => (swState && swState.current && swState.current.mcVersion) || '';
$('btnInstallJava').addEventListener('click', async () => {
  $('btnInstallJava').disabled = true;
  const r = await fetch(`${CTRL}/api/instances/${encodeURIComponent(INST_NAME)}/java`, { method: 'POST' });
  const d = await r.json();
  if (!r.ok) { toast(t(d.error || 'Failed'), 'error'); $('btnInstallJava').disabled = false; return; }
  toast(t('Installing Java...'));
  const poll = setInterval(async () => {
    try {
      const s = await (await fetch(`${CTRL}/api/instances/${encodeURIComponent(INST_NAME)}/java-status`)).json();
      if (s.done && !s.running) {
        clearInterval(poll);
        $('btnInstallJava').disabled = false;
        toast(s.error ? t(s.error) : t('Java installed'), s.error ? 'error' : 'ok');
        loadStartup();
      }
    } catch (_) { /* keep polling */ }
  }, 2000);
});
  if (!swState) return;
  const c = swState.current;
  $('upgError').style.display = 'none';
  $('upgLog').style.display = 'none';
  $('upgForm').style.display = 'grid';
  $('upgStart').style.display = '';
  $('upgStart').disabled = false;
  $('upgCancel').textContent = t('Cancel');
  $('upgTitle').textContent = t('Upgrade server software');
  $('upgDown').checked = false;
  $('upgMc').innerHTML = `<option>${t('Loading...')}</option>`;
  $('upgBack').classList.add('open');
  const d = await (await fetch(`${CTRL}/api/loader-versions?loader=${encodeURIComponent(c.loader)}`)).json();
  const versions = d.mcVersions || [];
  $('upgMc').innerHTML = versions.map((v) => `<option value="${esc(v)}"${v === c.mcVersion ? ' selected' : ''}>${esc(v)}${v === c.mcVersion ? ' (' + t('current') + ')' : ''}</option>`).join('');
  await upgFillLoaders();
}
function upgCompare(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}
$('upgMc').addEventListener('change', () => {
  upgFillLoaders();
  $('upgDownWrap').style.display = swState && upgCompare($('upgMc').value, swState.current.mcVersion) < 0 ? '' : 'none';
});
function upgWatch(kind) {
  $('upgForm').style.display = 'none';
  $('upgLog').style.display = '';
  $('upgStart').style.display = 'none';
  $('upgCancel').textContent = t('Close');
  $('upgCancel').disabled = true;
  $('upgTitle').textContent = t(kind === 'rollback' ? 'Rolling back...' : 'Upgrading...');
  clearInterval(swPoll);
  swPoll = setInterval(async () => {
    try {
      const d = await (await fetch(swUrl('/upgrade-status'))).json();
      $('upgLog').textContent = (d.lines || []).map((l) => t(l)).join('\n');
      $('upgLog').scrollTop = $('upgLog').scrollHeight;
      if (d.done && !d.running) {
        clearInterval(swPoll);
        $('upgCancel').disabled = false;
        $('upgTitle').textContent = d.error ? t('Failed') : t('Done');
        swLoad();
        loadBackups && loadBackups();
      }
    } catch (_) { /* the panel restarts at the end, keep polling */ }
  }, 1500);
}
$('btnUpgrade').addEventListener('click', upgOpen);
$('upgCancel').addEventListener('click', () => $('upgBack').classList.remove('open'));
$('upgStart').addEventListener('click', async () => {
  const body = { mcVersion: $('upgMc').value, loaderVersion: $('upgLoaderWrap').style.display === 'none' ? '' : $('upgLoader').value, allowDowngrade: $('upgDown').checked };
  $('upgStart').disabled = true;
  const r = await fetch(swUrl('/upgrade'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) { $('upgError').textContent = t(d.error || 'Failed'); $('upgError').style.display = ''; $('upgStart').disabled = false; return; }
  upgWatch('upgrade');
});
$('btnRollback').addEventListener('click', async () => {
  const l = swState && swState.latest;
  if (!l) return;
  const ok = await modalConfirm('Roll back the upgrade?', t('This restores Minecraft {from} and the world from the backup taken before the upgrade. Everything played since the upgrade is lost.', { from: l.from.mcVersion }), 'Roll back', true);
  if (!ok) return;
  const r = await fetch(swUrl('/upgrade/rollback'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ restoreWorld: true }) });
  const d = await r.json();
  if (!r.ok) { toast(t(d.error || 'Failed'), 'error'); return; }
  $('upgBack').classList.add('open');
  upgWatch('rollback');
});
swLoad();


// --- Delete instance ---
$('btnDeleteInstance').addEventListener('click', () => {
  $('delMsg').textContent = t('This deletes the folder of "{name}" with the world, mods and settings.', { name: INST_NAME });
  $('delName').value = '';
  $('delBackups').checked = false;
  $('delGo').disabled = true;
  $('delError').style.display = 'none';
  $('delBack').classList.add('open');
  $('delName').focus();
});
$('delName').addEventListener('input', () => { $('delGo').disabled = $('delName').value !== INST_NAME; });
$('delCancel').addEventListener('click', () => $('delBack').classList.remove('open'));
$('delGo').addEventListener('click', async () => {
  $('delGo').disabled = true;
  const r = await fetch(`${CTRL}/api/instances/${encodeURIComponent(INST_NAME)}?files=1&backups=${$('delBackups').checked ? 1 : 0}`, { method: 'DELETE' });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.ok === false) { $('delError').textContent = t(d.error || 'Failed'); $('delError').style.display = ''; $('delGo').disabled = $('delName').value !== INST_NAME; return; }
  location.href = '/';
});
