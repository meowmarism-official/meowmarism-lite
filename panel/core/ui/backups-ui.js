// World backups page: status line, "Backup now", and the list with download, restore and delete. Shared by every product.
// cfg: { el, load() -> { backups, inProgress, lastBackupAt, lastBackupError }, create(), remove(name), restore(name), downloadHref?(name),
//   t, esc, confirm(title, message, label, danger), isVisible?(), refreshMs? }
(function () {
  const fmtSize = (mb) => (mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : mb.toFixed(1) + ' MB');

  function mount(cfg) {
    const { t, esc } = cfg;
    cfg.el.innerHTML = `
        <div class="settings-toolbar"><div><div class="card-title">World backups</div><div class="settings-status" id="backupStatus">—</div></div><div class="settings-actions"><button class="btn primary" id="btnBackupNow">Backup now</button></div></div>
        <div class="card">
          <div class="card-body hint">Automatic backup on the configured interval · oldest backups beyond the configured limit are deleted automatically. A backup also runs automatically right before every scheduled restart. Manual backups can be taken any time, even while the server is running.</div>
          <div class="table-wrap"><table class="data-table"><thead><tr><th>File</th><th>Size</th><th>Created</th><th></th></tr></thead><tbody id="backupRows" data-no-i18n></tbody></table><div class="empty-state" id="backupEmpty" style="display:none">No backups yet.</div></div>
        </div>`;
    const $ = (id) => document.getElementById(id);
    let timer = null;

    async function load() {
      clearTimeout(timer);
      try {
        const data = await cfg.load();
        $('backupStatus').textContent = data.inProgress
          ? t('Backup running…')
          : (data.lastBackupError ? `${t('Last backup failed')}: ${data.lastBackupError}` : (data.lastBackupAt ? `${t('Last backup')}: ${new Date(data.lastBackupAt).toLocaleString()}` : t('No backup has run yet')));
        if (!data.backups.length) {
          $('backupRows').innerHTML = '';
          $('backupEmpty').style.display = '';
        } else {
          $('backupEmpty').style.display = 'none';
          $('backupRows').innerHTML = data.backups.map((b) => `
      <tr>
        <td>${esc(b.name)}</td>
        <td>${fmtSize(b.sizeMB)}</td>
        <td>${new Date(b.createdAt).toLocaleString()}</td>
        <td style="text-align:right;white-space:nowrap">
          ${cfg.downloadHref ? `<a class="btn" href="${cfg.downloadHref(b.name)}" download>${esc(t('Download'))}</a>` : ''}
          <button class="btn warn" data-restore-backup="${esc(b.name)}">${esc(t('Restore'))}</button>
          <button class="btn danger" data-del-backup="${esc(b.name)}">${esc(t('Delete'))}</button>
        </td>
      </tr>`).join('');
        }
        if (cfg.refreshMs && (!cfg.isVisible || cfg.isVisible())) timer = setTimeout(load, data.inProgress ? 1500 : cfg.refreshMs);
      } catch (err) { console.error(err); }
    }

    cfg.el.addEventListener('click', async (e) => {
      const now = e.target.closest('#btnBackupNow');
      if (now) { now.disabled = true; Promise.resolve(cfg.create()).catch(() => {}).finally(() => { now.disabled = false; load(); }); return; }
      const del = e.target.closest('[data-del-backup]');
      if (del) {
        if (await cfg.confirm('Delete backup?', del.dataset.delBackup, 'Delete', true)) Promise.resolve(cfg.remove(del.dataset.delBackup)).then(load);
        return;
      }
      const restore = e.target.closest('[data-restore-backup]');
      if (restore) {
        const name = restore.dataset.restoreBackup;
        if (await cfg.confirm('Restore this backup?', t('Replace the current world with "{name}"? The server will be stopped for this. The current world is safety-backed-up first.', { name }), 'Restore', true)) Promise.resolve(cfg.restore(name)).then(load);
      }
    });
    return { load };
  }
  window.MeowBackups = { mount };
})();
