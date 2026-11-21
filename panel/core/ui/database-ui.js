// Database page: connection details, tables, rows and a SQL console for one database (this server or the whole network).
// cfg: { el, t, esc, toast, confirm(title, message, label), status() -> { enabled, installed, running, error, job }, targets() -> [{ id, label }],
//        api(target, method, sub, body) -> data (throws on error) }
(function () {
  const TYPES = ['int', 'bigint', 'smallint', 'tinyint', 'boolean', 'double', 'float', 'decimal', 'varchar', 'text', 'longtext', 'date', 'datetime', 'timestamp', 'uuid', 'json', 'blob'];
  const PAGE = 50;

  function mount(cfg) {
    const { t, esc, toast } = cfg;
    let status = null;
    let targets = [];
    let target = null;
    let view = { overview: null, table: null, offset: 0, tab: 'tables', form: null, colForm: null, edit: null, sql: '', result: null, revealed: false };
    const $ = (id) => cfg.el.querySelector(`#${id}`);
    const call = (method, sub, body) => cfg.api(target, method, sub, body);

    function notReady() {
      if (!status || !status.enabled) return `<div class="card"><div class="card-title">${esc(t('Database'))}</div><p class="hint" style="margin:0">${esc(t('The database is switched off. Switch it on under Update, Optional features.'))}</p></div>`;
      if (status.job && status.job.running) return `<div class="card"><div class="card-title">${esc(t('Database'))}</div><p class="hint">${esc(t('The database is being installed and started. This can take a few minutes.'))}</p><pre class="db-log">${esc((status.job.lines || []).slice(-6).join('\n'))}</pre></div>`;
      if (!status.running) return `<div class="card"><div class="card-title">${esc(t('Database'))}</div><p class="hint" style="margin:0">${esc(status.error || (status.job && status.job.error) || t('The database is not running.'))}</p></div>`;
      return null;
    }

    function connectionCard() {
      const c = view.overview.connection;
      const row = (label, value) => `<div class="kv-row"><div class="kv-key">${esc(t(label))}</div><div class="kv-val db-mono">${esc(value)}</div></div>`;
      return `<div class="card"><div class="card-title">${esc(t('Connection'))}</div>
        ${row('Host', c.host)}${row('Port', String(c.port))}${row('Database', c.database)}${row('User', c.user)}
        <div class="kv-row"><div class="kv-key">${esc(t('Password'))}</div><div class="kv-val db-mono">${view.revealed ? esc(c.password) : '••••••••••••'}</div></div>
        ${row('JDBC URL', c.jdbc)}
        <div class="row" style="margin-top:10px"><button class="btn small" id="dbReveal">${esc(view.revealed ? t('Hide password') : t('Show password'))}</button><button class="btn small" id="dbReset">${esc(t('New password'))}</button><button class="btn small danger" id="dbDrop">${esc(t('Delete database'))}</button></div>
        <p class="hint" style="margin-bottom:0">${esc(t('Only this machine can connect. Give these details to the plugin that needs a database.'))}</p></div>`;
    }

    function tableList() {
      const items = view.overview.tables.map((n) => `<button class="db-table${view.table && view.table.name === n ? ' active' : ''}" data-open="${esc(n)}">${esc(n)}</button>`).join('');
      return `<div class="card db-side"><div class="api-head"><div class="card-title" style="margin:0">${esc(t('Tables'))}</div><button class="btn small" id="dbNewTable">${esc(t('New table'))}</button></div>${items || `<div class="hint">${esc(t('No tables yet.'))}</div>`}</div>`;
    }

    function newTableForm() {
      const f = view.form;
      const cols = f.columns.map((c, i) => `<div class="db-col">
        <input data-c="${i}" data-k="name" value="${esc(c.name)}" placeholder="${esc(t('column'))}">
        <select data-c="${i}" data-k="type">${TYPES.map((x) => `<option ${x === c.type ? 'selected' : ''}>${x}</option>`).join('')}</select>
        <input data-c="${i}" data-k="size" value="${esc(c.size)}" placeholder="${esc(t('size'))}" ${['varchar', 'decimal'].includes(c.type) ? '' : 'disabled'} style="width:70px">
        <label class="api-check slim"><input type="checkbox" data-c="${i}" data-k="pk" ${c.pk ? 'checked' : ''}> ${esc(t('key'))}</label>
        <label class="api-check slim"><input type="checkbox" data-c="${i}" data-k="ai" ${c.ai ? 'checked' : ''}> ${esc(t('auto'))}</label>
        <label class="api-check slim"><input type="checkbox" data-c="${i}" data-k="notnull" ${c.notnull ? 'checked' : ''}> ${esc(t('required'))}</label>
        <input data-c="${i}" data-k="default" value="${esc(c.default)}" placeholder="${esc(t('default'))}" style="width:90px">
        <button class="btn small danger" data-delcol="${i}">×</button></div>`).join('');
      return `<div class="card api-form"><div class="api-form-title">${esc(t('New table'))}</div>
        <div class="field"><label>${esc(t('Name'))}</label><input id="dbTableName" value="${esc(f.name)}" placeholder="players"></div>
        <div class="field"><label>${esc(t('Columns'))}</label>${cols}<button class="btn small" id="dbAddFormCol">${esc(t('Add column'))}</button></div>
        <div class="row"><button class="btn primary" id="dbCreateTable">${esc(t('Create table'))}</button><button class="btn" id="dbCancelForm">${esc(t('Cancel'))}</button></div></div>`;
    }

    function cellInput(col, value, idPrefix) {
      return `<div class="db-cell"><input data-f="${esc(col.name)}" value="${value === null || value === undefined ? '' : esc(value)}" placeholder="${col.nullable ? 'NULL' : ''}"><label title="NULL"><input type="checkbox" data-null="${esc(col.name)}" ${value === null ? 'checked' : ''}>∅</label></div>`;
    }

    function tableView() {
      const d = view.table;
      const head = d.columnNames.map((n) => {
        const c = d.columns.find((x) => x.name === n) || {};
        return `<th>${esc(n)}${c.key === 'PRI' ? ' 🔑' : ''}<div class="card-meta">${esc(c.type || '')}</div><button class="db-x" data-dropcol="${esc(n)}" title="${esc(t('Delete column'))}">×</button></th>`;
      }).join('');
      const canEdit = d.primaryKey.length > 0;
      const keyOf = (row) => Object.fromEntries(d.primaryKey.map((k) => [k, row[d.columnNames.indexOf(k)]]));
      const body = d.rows.map((row, i) => {
        if (view.edit && view.edit.index === i) {
          return `<tr class="editing">${d.columnNames.map((n, j) => `<td>${cellInput(d.columns.find((c) => c.name === n) || { name: n }, row[j])}</td>`).join('')}<td class="db-act"><button class="btn small primary" data-save="${i}">${esc(t('Save'))}</button><button class="btn small" data-cancel>${esc(t('Cancel'))}</button></td></tr>`;
        }
        return `<tr>${row.map((v) => `<td>${v === null ? '<span class="db-null">NULL</span>' : esc(v)}</td>`).join('')}<td class="db-act">${canEdit ? `<button class="btn small" data-edit="${i}">${esc(t('Edit'))}</button><button class="btn small danger" data-del="${i}">${esc(t('Remove'))}</button>` : ''}</td></tr>`;
      }).join('');
      const adding = view.edit && view.edit.index === 'new';
      const addRow = adding ? `<tr class="editing">${d.columnNames.map((n) => `<td>${cellInput(d.columns.find((c) => c.name === n) || { name: n }, undefined)}</td>`).join('')}<td class="db-act"><button class="btn small primary" data-save="new">${esc(t('Add'))}</button><button class="btn small" data-cancel>${esc(t('Cancel'))}</button></td></tr>` : '';
      const cf = view.colForm;
      const colBar = cf ? `<div class="db-col" style="margin-bottom:8px"><input id="dbColName" value="${esc(cf.name)}" placeholder="${esc(t('column'))}"><select id="dbColType">${TYPES.map((x) => `<option ${x === cf.type ? 'selected' : ''}>${x}</option>`).join('')}</select><input id="dbColSize" value="${esc(cf.size)}" placeholder="${esc(t('size'))}" style="width:70px" ${['varchar', 'decimal'].includes(cf.type) ? '' : 'disabled'}><button class="btn small primary" id="dbColSave">${esc(t('Add column'))}</button><button class="btn small" id="dbColCancel">${esc(t('Cancel'))}</button></div>` : '';
      const last = Math.min(d.total, view.offset + PAGE);
      return `<div class="card"><div class="api-head"><div><div class="card-title" style="margin:0">${esc(d.name)}</div><div class="card-meta">${d.total} ${esc(t('rows'))}${canEdit ? '' : ` · ${esc(t('no primary key, rows cannot be edited here'))}`}</div></div>
        <div class="row"><button class="btn small" id="dbAddRow">${esc(t('Add row'))}</button><button class="btn small" id="dbAddColumn">${esc(t('Add column'))}</button><button class="btn small danger" id="dbDropTable">${esc(t('Delete table'))}</button></div></div>
        ${colBar}<div class="db-scroll"><table class="db-grid"><thead><tr>${head}<th></th></tr></thead><tbody>${addRow}${body}</tbody></table></div>
        <div class="row" style="margin-top:8px"><button class="btn small" id="dbPrev" ${view.offset ? '' : 'disabled'}>‹</button><span class="card-meta">${d.total ? view.offset + 1 : 0}–${last} / ${d.total}</span><button class="btn small" id="dbNext" ${last < d.total ? '' : 'disabled'}>›</button></div></div>`;
    }

    function sqlView() {
      const r = view.result;
      let out = '';
      if (r && r.error) out = `<div class="net-note bad">${esc(r.error)}</div>`;
      else if (r) out = r.columns.length
        ? `<div class="db-scroll"><table class="db-grid"><thead><tr>${r.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${r.rows.map((row) => `<tr>${row.map((v) => `<td>${v === null ? '<span class="db-null">NULL</span>' : esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${r.truncated ? `<div class="hint">${esc(t('Showing the first rows only.'))}</div>` : ''}`
        : `<div class="hint">${esc(t('Done.'))}</div>`;
      return `<div class="card"><div class="card-title">${esc(t('SQL console'))}</div><textarea id="dbSql" class="db-sql" rows="5" spellcheck="false" placeholder="SELECT * FROM players LIMIT 10">${esc(view.sql)}</textarea>
        <div class="row" style="margin:8px 0"><button class="btn primary" id="dbRun">${esc(t('Run'))}</button></div>${out}</div>`;
    }

    function render() {
      const blocked = notReady();
      if (blocked) { cfg.el.innerHTML = blocked; return; }
      const tabs = targets.length > 1 ? `<div class="db-tabs">${targets.map((x) => `<button class="btn small${x.id === target ? ' primary' : ''}" data-target="${esc(x.id)}">${esc(t(x.label))}</button>`).join('')}</div>` : '';
      if (!view.overview) { cfg.el.innerHTML = `${tabs}<div class="hint">${esc(t('Loading...'))}</div>`; wire(); return; }
      if (!view.overview.exists) {
        cfg.el.innerHTML = `${tabs}<div class="card"><div class="card-title">${esc(t('Database'))}</div><p class="hint">${esc(t('There is no database here yet.'))}</p><button class="btn primary" id="dbCreate">${esc(t('Create database'))}</button></div>`;
        wire();
        return;
      }
      const main = view.tab === 'sql' ? sqlView() : (view.form ? newTableForm() : (view.table ? tableView() : `<div class="card"><p class="hint" style="margin:0">${esc(t('Pick a table or create one.'))}</p></div>`));
      cfg.el.innerHTML = `<div class="db-page">${tabs}
        <div class="db-modes"><button class="btn small${view.tab === 'tables' ? ' primary' : ''}" data-tab="tables">${esc(t('Tables'))}</button><button class="btn small${view.tab === 'sql' ? ' primary' : ''}" data-tab="sql">${esc(t('SQL console'))}</button></div>
        ${connectionCard()}
        ${view.tab === 'sql' ? main : `<div class="db-layout">${tableList()}<div>${main}</div></div>`}</div>`;
      wire();
    }

    async function act(fn, ok) {
      try { await fn(); if (ok) toast(ok); } catch (e) { toast(e.message, 'error'); }
    }

    async function reload() {
      view.overview = await call('GET', '');
      if (view.table) {
        if (!view.overview.tables.includes(view.table.name)) view.table = null;
        else view.table = await call('GET', `/tables/${encodeURIComponent(view.table.name)}?limit=${PAGE}&offset=${view.offset}`);
      }
      render();
    }

    async function openTable(name, offset = 0) {
      view.offset = offset;
      view.edit = null;
      view.form = null;
      view.table = await call('GET', `/tables/${encodeURIComponent(name)}?limit=${PAGE}&offset=${offset}`);
      render();
    }

    function readRow() {
      const values = {};
      cfg.el.querySelectorAll('tr.editing [data-f]').forEach((input) => {
        const name = input.dataset.f;
        const isNull = cfg.el.querySelector(`tr.editing [data-null="${CSS.escape(name)}"]`).checked;
        if (isNull) values[name] = null;
        else if (input.value !== '' || (view.edit && view.edit.index !== 'new')) values[name] = input.value;
      });
      return values;
    }

    function formSpec() {
      const f = view.form;
      return {
        name: $('dbTableName').value.trim(),
        columns: f.columns.map((c) => ({ name: c.name.trim(), type: c.type, size: c.size || undefined, nullable: !(c.notnull || c.pk), autoIncrement: c.ai, default: c.default || undefined })),
        primaryKey: f.columns.filter((c) => c.pk).map((c) => c.name.trim()),
      };
    }

    function wire() {
      cfg.el.querySelectorAll('[data-target]').forEach((b) => b.addEventListener('click', () => act(async () => { target = b.dataset.target; view = { ...view, overview: null, table: null, form: null, edit: null, result: null, revealed: false }; render(); await reload(); })));
      cfg.el.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { view.tab = b.dataset.tab; render(); }));
      $('dbCreate')?.addEventListener('click', () => act(async () => { await call('POST', '/create'); await reload(); }));
      $('dbReveal')?.addEventListener('click', () => { view.revealed = !view.revealed; render(); });
      $('dbReset')?.addEventListener('click', () => act(async () => {
        if (!(await cfg.confirm(t('Create a new password?'), t('Programs using the old password lose access until you update them.'), t('New password')))) return;
        await call('POST', '/reset-password'); view.revealed = true; await reload();
      }));
      $('dbDrop')?.addEventListener('click', () => act(async () => {
        if (!(await cfg.confirm(t('Delete this database?'), t('All tables and rows in it are deleted for good.'), t('Delete database')))) return;
        await call('DELETE', ''); view.table = null; await reload();
      }));
      cfg.el.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => act(() => openTable(b.dataset.open))));
      $('dbNewTable')?.addEventListener('click', () => { view.form = { name: '', columns: [{ name: 'id', type: 'bigint', size: '', pk: true, ai: true, notnull: true, default: '' }] }; view.table = null; render(); });
      $('dbCancelForm')?.addEventListener('click', () => { view.form = null; render(); });
      $('dbAddFormCol')?.addEventListener('click', () => { view.form.name = $('dbTableName').value; view.form.columns.push({ name: '', type: 'varchar', size: '255', pk: false, ai: false, notnull: false, default: '' }); render(); });
      cfg.el.querySelectorAll('[data-delcol]').forEach((b) => b.addEventListener('click', () => { view.form.name = $('dbTableName').value; view.form.columns.splice(Number(b.dataset.delcol), 1); render(); }));
      cfg.el.querySelectorAll('[data-c]').forEach((el) => el.addEventListener('change', () => {
        const col = view.form.columns[Number(el.dataset.c)];
        const key = el.dataset.k;
        col[key] = el.type === 'checkbox' ? el.checked : el.value;
        if (key === 'type') col.size = col.type === 'varchar' ? '255' : (col.type === 'decimal' ? '10,2' : '');
        view.form.name = $('dbTableName').value;
        render();
      }));
      $('dbCreateTable')?.addEventListener('click', () => act(async () => { const spec = formSpec(); await call('POST', '/tables', spec); view.form = null; await reload(); await openTable(spec.name); }));
      $('dbDropTable')?.addEventListener('click', () => act(async () => {
        if (!(await cfg.confirm(t('Delete this table?'), `${view.table.name}: ${t('All rows in it are deleted for good.')}`, t('Delete table')))) return;
        await call('DELETE', `/tables/${encodeURIComponent(view.table.name)}`); view.table = null; await reload();
      }));
      $('dbAddColumn')?.addEventListener('click', () => { view.colForm = { name: '', type: 'varchar', size: '255' }; render(); });
      $('dbColCancel')?.addEventListener('click', () => { view.colForm = null; render(); });
      $('dbColType')?.addEventListener('change', (e) => { view.colForm.name = $('dbColName').value; view.colForm.type = e.target.value; view.colForm.size = e.target.value === 'varchar' ? '255' : (e.target.value === 'decimal' ? '10,2' : ''); render(); });
      $('dbColSave')?.addEventListener('click', () => act(async () => {
        const f = { name: $('dbColName').value.trim(), type: $('dbColType').value, size: $('dbColSize').value || undefined };
        await call('POST', `/tables/${encodeURIComponent(view.table.name)}/columns`, f);
        view.colForm = null;
        await openTable(view.table.name, view.offset);
      }));
      cfg.el.querySelectorAll('[data-dropcol]').forEach((b) => b.addEventListener('click', () => act(async () => {
        if (!(await cfg.confirm(t('Delete this column?'), `${b.dataset.dropcol}: ${t('Its values in every row are deleted for good.')}`, t('Delete column')))) return;
        await call('DELETE', `/tables/${encodeURIComponent(view.table.name)}/columns/${encodeURIComponent(b.dataset.dropcol)}`);
        await openTable(view.table.name, view.offset);
      })));
      $('dbAddRow')?.addEventListener('click', () => { view.edit = { index: 'new' }; render(); });
      cfg.el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => { view.edit = { index: Number(b.dataset.edit) }; render(); }));
      cfg.el.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', () => { view.edit = null; render(); }));
      cfg.el.querySelectorAll('[data-save]').forEach((b) => b.addEventListener('click', () => act(async () => {
        const d = view.table;
        const base = `/tables/${encodeURIComponent(d.name)}/rows`;
        if (b.dataset.save === 'new') await call('POST', base, { values: readRow() });
        else {
          const row = d.rows[Number(b.dataset.save)];
          await call('PATCH', base, { key: Object.fromEntries(d.primaryKey.map((k) => [k, row[d.columnNames.indexOf(k)]])), values: readRow() });
        }
        await openTable(d.name, view.offset);
      })));
      cfg.el.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => act(async () => {
        const d = view.table;
        if (!(await cfg.confirm(t('Delete this row?'), t('The row is deleted for good.'), t('Remove')))) return;
        const row = d.rows[Number(b.dataset.del)];
        await call('DELETE', `/tables/${encodeURIComponent(d.name)}/rows`, { key: Object.fromEntries(d.primaryKey.map((k) => [k, row[d.columnNames.indexOf(k)]])) });
        await openTable(d.name, view.offset);
      })));
      $('dbPrev')?.addEventListener('click', () => act(() => openTable(view.table.name, Math.max(0, view.offset - PAGE))));
      $('dbNext')?.addEventListener('click', () => act(() => openTable(view.table.name, view.offset + PAGE)));
      $('dbRun')?.addEventListener('click', async () => {
        view.sql = $('dbSql').value;
        try { view.result = await call('POST', '/query', { sql: view.sql }); } catch (e) { view.result = { error: e.message }; }
        if (view.result && !view.result.error) { try { view.overview = await call('GET', ''); } catch (_) {} }
        render();
      });
    }

    async function load() {
      try { status = await cfg.status(); } catch (_) { return; }
      targets = cfg.targets(status);
      if (!target || !targets.some((x) => x.id === target)) target = targets[0] && targets[0].id;
      const blocked = notReady();
      if (blocked || !target) { render(); return; }
      render();
      try { await reload(); } catch (e) { toast(e.message, 'error'); }
    }

    return { load };
  }
  window.MeowDatabase = { mount };
})();
