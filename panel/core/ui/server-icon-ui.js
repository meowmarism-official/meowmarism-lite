// Server icon card: preview, upload (scaled to 64x64 in the browser) and reset. Shared by every product.
// cfg: { el, src() -> image URL, send(body) -> { ok, error? } (body: { png } or { reset: true }), toast, t }
(function () {
  function mount(cfg) {
    const { t } = cfg;
    cfg.el.innerHTML = `<article class="card" id="serverIconCard" style="margin-bottom:14px"><div class="card-body" style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
          <img id="serverIconImg" width="64" height="64" alt="" style="image-rendering:pixelated;border-radius:6px;background:#17191d;border:1px solid var(--line)">
          <div style="flex:1;min-width:220px"><div class="card-title">Server icon</div>
            <div class="hint" style="margin:4px 0 8px">Shown in the Minecraft server list. It is scaled to 64x64. Restart the server to apply it.</div>
            <div class="settings-actions"><button class="btn" id="btnIconChange">Change icon...</button> <button class="btn" id="btnIconReset">Use the meowmarism icon</button><input type="file" id="iconFile" accept="image/*" style="display:none"></div></div>
        </div></article>`;
    const $ = (id) => cfg.el.querySelector('#' + id);
    const reload = () => { $('serverIconImg').src = cfg.src(); };
    async function send(body) {
      let d;
      try { d = await cfg.send(body); } catch (err) { d = { ok: false, error: err.message }; }
      cfg.toast(d.ok ? t('Server icon saved, restart the server to apply it') : t(d.error || 'Failed'), d.ok ? 'ok' : 'error');
      reload();
    }
    $('btnIconChange').addEventListener('click', () => $('iconFile').click());
    $('btnIconReset').addEventListener('click', () => send({ reset: true }));
    $('iconFile').addEventListener('change', (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = 64; c.height = 64;
        const side = Math.min(img.width, img.height);
        c.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 64, 64);
        send({ png: c.toDataURL('image/png').split(',')[1] });
        URL.revokeObjectURL(img.src);
      };
      img.onerror = () => cfg.toast(t('That file is not an image'), 'error');
      img.src = URL.createObjectURL(file);
    });
    reload();
    return { reload };
  }
  window.MeowServerIcon = { mount };
})();
