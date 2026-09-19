// File manager with an editor for one instance folder. Shared by every product.
// cfg: { el, base() -> the files API prefix, rootName(), t, esc, toast, confirm(title, message, label, danger), isVisible() }
(function () {
  function mount(cfg) {
    const { t, esc, toast } = cfg;
    const $ = (id) => document.getElementById(id);
    const base = cfg.base;

    cfg.el.innerHTML = `<div class="settings-toolbar">
  <div><div class="card-title" id="filesBreadcrumb">/</div></div>
  <div class="settings-actions">
    <input class="compact-input" id="filesSearch" placeholder="Filter this folder...">
    <input type="file" id="filesUploadInput" style="display:none">
    <button class="btn" id="btnFilesUpload">Upload</button>
    <button class="btn" id="btnFilesRefresh">Refresh</button>
  </div>
</div>
<div class="card">
  <div class="table-wrap"><table class="data-table"><thead><tr>
    <th data-sort-key="name" style="cursor:pointer">Name</th>
    <th data-sort-key="sizeMB" style="cursor:pointer">Size</th>
    <th data-sort-key="mtime" style="cursor:pointer">Modified</th>
    <th></th>
  </tr></thead><tbody id="filesRows" data-no-i18n></tbody></table><div class="empty-state" id="filesEmpty" style="display:none">Empty folder.</div></div>
</div>
      `;
    if (!$('edBack')) document.body.insertAdjacentHTML('beforeend', `<div class="modal-back" id="edBack"><div class="ed-modal" role="dialog" aria-modal="true" aria-labelledby="edName">
  <div class="ed-head"><div style="min-width:0"><div class="ed-name" id="edName"></div><div class="ed-path" id="edPath"></div></div><span class="ed-dirty" id="edDirty" hidden>Unsaved changes</span>
    <div class="ed-actions"><a class="btn" id="edDownload" href="#" download>Download</a><button class="btn primary" id="edSave">Save</button><button class="btn" id="edClose">Close</button></div></div>
  <div class="ed-body"><pre class="ed-gutter" id="edGutter" aria-hidden="true">1</pre><div class="ed-stack"><pre class="ed-hl" id="edHl" aria-hidden="true"></pre><textarea id="edText" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off"></textarea></div></div>
  <div class="ed-status"><span id="edPos">Ln 1, Col 1</span><span id="edInfo"></span></div>
</div></div>`);

  let filesCurrentPath = '.';
  let filesEntries = [];
  let filesSortKey = 'name';
  let filesSortDir = 1;
  function fmtFileSize(mb) {
    if (mb == null) return '-';
    if (mb < 0.01) return '<10 KB';
    if (mb < 1) return `${Math.round(mb * 1024)} KB`;
    return `${mb.toFixed(1)} MB`;
  }
  function extOf(name) {
    const i = name.lastIndexOf('.');
    return i > 0 ? name.slice(i + 1).toUpperCase() : '';
  }
  function renderFiles() {
    const q = ($('filesSearch').value || '').toLowerCase();
    let entries = filesEntries.filter((e) => !q || e.name.toLowerCase().includes(q));
    entries = entries.slice().sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      let av = a[filesSortKey], bv = b[filesSortKey];
      if (filesSortKey === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      if (av == null) av = filesSortKey === 'name' ? '' : -1;
      if (bv == null) bv = filesSortKey === 'name' ? '' : -1;
      return av < bv ? -1 * filesSortDir : av > bv ? 1 * filesSortDir : 0;
    });
    const rows = $('filesRows'), empty = $('filesEmpty');
    if (!entries.length) { rows.innerHTML = ''; empty.style.display = ''; empty.textContent = q ? 'No files match.' : 'Empty folder.'; return; }
    empty.style.display = 'none';
    rows.innerHTML = entries.map((e) => {
      const childPath = filesCurrentPath === '.' ? e.name : `${filesCurrentPath}/${e.name}`;
      const type = e.isDir ? 'DIR' : (extOf(e.name) || 'FILE');
      const editable = !e.isDir && !EDIT_BLOCKED.test(e.name);
      return `<tr class="file-row${e.isDir ? ' dir' : ''}"${e.isDir ? ` data-nav-path="${esc(childPath)}"` : ''}>
        <td class="fname"><span class="tag" style="margin-right:8px;font-size:10px;padding:2px 6px">${esc(type)}</span>${esc(e.name)}</td>
        <td>${e.isDir ? '-' : fmtFileSize(e.sizeMB)}</td>
        <td>${e.mtime ? new Date(e.mtime).toLocaleString() : '-'}</td>
        <td style="text-align:right;white-space:nowrap">${e.isDir ? '' : `<button class="btn" data-edit-file="${esc(childPath)}"${editable ? '' : ' disabled title="' + esc(t('This kind of file cannot be edited here')) + '"'}>${t('Edit')}</button> <a class="btn" href="${base()}/download?path=${encodeURIComponent(childPath)}" download>${t('Download')}</a> `}<button class="btn danger" data-del-file="${esc(childPath)}" data-is-dir="${e.isDir}">Delete</button></td>
      </tr>`;
    }).join('');
  }
  async function loadFiles(p) {
    filesCurrentPath = p || '.';
    try {
      const r = await fetch(`${base()}?path=${encodeURIComponent(filesCurrentPath)}`);
      const data = await r.json();
      if (!r.ok || data.ok === false) { toast(data.error || 'Failed to list folder', 'error'); return; }
      filesCurrentPath = data.path;
      const parts = data.path === '.' ? [] : data.path.split('/');
      const crumbHtml = [`<a href="#" data-nav-path=".">${esc(cfg.rootName() || 'files')}</a>`]
        .concat(parts.map((part, i) => `<a href="#" data-nav-path="${parts.slice(0, i + 1).join('/')}">${part}</a>`))
        .join(' / ');
      $('filesBreadcrumb').innerHTML = crumbHtml;
      filesEntries = data.entries;
      renderFiles();
    } catch (err) { console.error(err); }
  }
  const EDIT_BLOCKED = /\.(jar|zip|gz|zst|tar|tgz|png|jpe?g|gif|webp|ogg|mp3|mca|mcr|dat|dat_old|nbt|class|so|dll|exe|bin|7z|rar|lock|db|sqlite|bak)$/i;
  const ED = { path: null, mtime: null, crlf: false, original: '', lang: '', busy: false };
  const edEsc = (v) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  function edLang(name) {
    const n = name.toLowerCase();
    if (/\.json5?$|\.mcmeta$/.test(n)) return 'json';
    if (/\.ya?ml$/.test(n)) return 'yaml';
    if (/\.(properties|cfg|conf|ini)$/.test(n)) return 'properties';
    if (/\.toml$/.test(n)) return 'toml';
    return '';
  }
  function edHighlight(text, lang) {
    if (!lang || text.length > 300000) return edEsc(text);
    const span = (cls, v) => `<span class="${cls}">${edEsc(v)}</span>`;
    const value = (v) => {
      const lead = v.match(/^\s*/)[0];
      const body = v.slice(lead.length);
      if (/^-?\d+(\.\d+)?$/.test(body)) return edEsc(lead) + span('hl-n', body);
      if (/^(true|false|null|~)$/i.test(body)) return edEsc(lead) + span('hl-b', body);
      if (/^(".*"|'.*')$/.test(body)) return edEsc(lead) + span('hl-s', body);
      return edEsc(v);
    };
    if (lang === 'json') {
      return edEsc(text).replace(/(&quot;|")((?:[^"\\\n]|\\.)*)(")(\s*:)?|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|\b(true|false|null)\b/g, (m, q1, str, q2, colon, num, kw) => {
        if (q1 !== undefined) return `<span class="${colon ? 'hl-k' : 'hl-s'}">${q1}${str}${q2}</span>${colon || ''}`;
        if (num !== undefined) return `<span class="hl-n">${num}</span>`;
        return `<span class="hl-b">${kw}</span>`;
      });
    }
    return text.split('\n').map((line) => {
      if (/^\s*[#;!]/.test(line) || (lang === 'yaml' && /^\s*#/.test(line))) return span('hl-c', line);
      if (lang === 'toml' && /^\s*\[.*\]\s*$/.test(line)) return span('hl-k', line);
      const sep = lang === 'yaml' ? /^(\s*-?\s*)([^:#\n]+?)(:)(\s.*|)$/ : /^(\s*)([^=:#\n]+?)(\s*[=:]\s*)(.*)$/;
      const m = sep.exec(line);
      if (m) return edEsc(m[1]) + span('hl-k', m[2]) + span('hl-p', m[3]) + value(m[4]);
      return edEsc(line);
    }).join('\n');
  }
  function edRefresh() {
    const ta = $('edText');
    const text = ta.value;
    $('edHl').innerHTML = edHighlight(text, ED.lang) + '\n';
    const lines = text.split('\n').length;
    if ($('edGutter').dataset.n !== String(lines)) {
      $('edGutter').dataset.n = String(lines);
      $('edGutter').textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
    }
    const dirty = text !== ED.original;
    $('edDirty').hidden = !dirty;
    const before = text.slice(0, ta.selectionStart).split('\n');
    $('edPos').textContent = `Ln ${before.length}, Col ${before[before.length - 1].length + 1}`;
    $('edInfo').textContent = `${text.length.toLocaleString()} ${t('characters')} · ${lines.toLocaleString()} ${t('lines')} · ${ED.crlf ? 'CRLF' : 'LF'}${ED.lang ? ' · ' + ED.lang : ''}`;
  }
  function edSync() {
    const ta = $('edText');
    $('edHl').scrollTop = ta.scrollTop; $('edHl').scrollLeft = ta.scrollLeft;
    $('edGutter').scrollTop = ta.scrollTop;
  }
  const edDirty = () => $('edText').value !== ED.original;
  async function openEditor(p) {
    const name = p.split('/').pop();
    try {
      const r = await fetch(`${base()}/content?path=${encodeURIComponent(p)}`);
      const data = await r.json();
      if (!r.ok || data.ok === false) { toast(t(data.error || 'Could not open the file'), 'error'); return; }
      if (data.tooLarge) { toast(t('This file is too large to edit here ({mb} MB). Download it instead.', { mb: data.sizeMB }), 'error'); return; }
      if (data.binary) { toast(t('This is not a text file. Download it instead.'), 'error'); return; }
      Object.assign(ED, { path: p, mtime: data.mtime, crlf: !!data.crlf, lang: edLang(name) });
      const text = String(data.text || '').replace(/\r\n/g, '\n');
      ED.original = text;
      $('edName').textContent = name;
      $('edPath').textContent = p;
      $('edDownload').href = `${base()}/download?path=${encodeURIComponent(p)}`;
      $('edText').value = text;
      $('edGutter').dataset.n = '';
      $('edBack').classList.add('open');
      edRefresh();
      $('edText').scrollTop = 0; $('edText').scrollLeft = 0; edSync();
      $('edText').focus();
    } catch (err) { console.error(err); toast(t('Could not open the file'), 'error'); }
  }
  async function edSave(force) {
    if (ED.busy || !ED.path) return;
    const text = $('edText').value;
    if (!force && ED.lang === 'json') {
      try { JSON.parse(text); } catch (err) {
        if (!(await cfg.confirm('This is not valid JSON', err.message, 'Save anyway', true))) return;
      }
    }
    ED.busy = true;
    $('edSave').disabled = true;
    try {
      const body = { path: ED.path, text: ED.crlf ? text.replace(/\n/g, '\r\n') : text };
      if (!force) body.mtime = ED.mtime;
      const r = await fetch(base() + '/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json();
      if (r.status === 409) {
        ED.busy = false; $('edSave').disabled = false;
        if (await cfg.confirm('The file changed', 'It was changed by someone else since you opened it. Overwrite it with your version?', 'Overwrite', true)) await edSave(true);
        return;
      }
      if (!r.ok || !d.ok) { toast(t(d.error || 'Save failed'), 'error'); return; }
      ED.mtime = d.mtime;
      ED.original = text;
      edRefresh();
      toast(t('Saved'));
      loadFiles(filesCurrentPath);
    } catch (err) { toast(t('Save failed'), 'error'); }
    finally { ED.busy = false; $('edSave').disabled = false; }
  }
  async function edClose() {
    if (edDirty() && !(await cfg.confirm('Discard changes?', 'Your changes to this file will be lost.', 'Discard', true))) return;
    $('edBack').classList.remove('open');
    ED.path = null;
  }
  $('edSave').addEventListener('click', () => edSave(false));
  $('edClose').addEventListener('click', edClose);
  $('edText').addEventListener('input', edRefresh);
  $('edText').addEventListener('scroll', edSync);
  $('edText').addEventListener('keyup', edRefresh);
  $('edText').addEventListener('click', edRefresh);
  $('edText').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); edSave(false); }
    else if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); document.execCommand('insertText', false, '  '); }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('edBack').classList.contains('open') && !document.querySelector('.modal-back.open:not(#edBack)')) edClose(); });
  window.addEventListener('beforeunload', (e) => { if ($('edBack').classList.contains('open') && edDirty()) { e.preventDefault(); e.returnValue = ''; } });
  document.addEventListener('click', async (e) => {
    const onDel = !!e.target.closest('[data-del-file]');
    const nav = e.target.closest('[data-nav-path]');
    if (nav && !onDel && !e.target.closest('button, a.btn') && cfg.isVisible()) { e.preventDefault(); loadFiles(nav.dataset.navPath); }
    const edit = e.target.closest('[data-edit-file]');
    if (edit && !edit.disabled) openEditor(edit.dataset.editFile);
    const sortTh = e.target.closest('[data-sort-key]');
    if (sortTh) {
      const key = sortTh.dataset.sortKey;
      if (filesSortKey === key) filesSortDir *= -1; else { filesSortKey = key; filesSortDir = 1; }
      renderFiles();
    }
    const del = e.target.closest('[data-del-file]');
    if (del) {
      const p = del.dataset.delFile;
      const isDir = del.dataset.isDir === 'true';
      if (await cfg.confirm(isDir ? 'Delete folder?' : 'Delete file?', p + (isDir ? '\n' + t('This deletes everything inside it.') : ''), 'Delete', true)) {
        fetch(`${base()}?path=${encodeURIComponent(p)}`, { method: 'DELETE' })
          .then((r) => r.json()).then((d) => { if (!d.ok) toast(d.error || 'Delete failed', 'error'); loadFiles(filesCurrentPath); });
      }
    }
  });
  $('filesSearch')?.addEventListener('input', renderFiles);
  $('btnFilesRefresh')?.addEventListener('click', () => loadFiles(filesCurrentPath));
  $('btnFilesUpload')?.addEventListener('click', () => $('filesUploadInput').click());
  $('filesUploadInput')?.addEventListener('change', async () => {
    const file = $('filesUploadInput').files[0];
    if (!file) return;
    try {
      const r = await fetch(`${base()}/upload?path=${encodeURIComponent(filesCurrentPath)}&name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
      const d = await r.json();
      if (!d.ok) toast(d.error || 'Upload failed', 'error'); else toast(`Uploaded ${file.name}`);
      loadFiles(filesCurrentPath);
    } catch (err) { toast('Upload failed', 'error'); }
    $('filesUploadInput').value = '';
  });

    return { load: loadFiles };
  }
  window.MeowFiles = { mount };
})();
