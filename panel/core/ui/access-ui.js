// Whitelist / operators / bans page. Shared by every product.
// cfg: { el, load() -> { whitelist, ops, banned }, act(list, action, name), t, esc, toast, isVisible() }
(function () {
  const LISTS = [
    { key: 'whitelist', title: 'Whitelist', add: 'Add', cls: 'primary' },
    { key: 'ops', title: 'Operators', add: 'Add', cls: 'primary' },
    { key: 'banned', title: 'Bans', add: 'Ban', cls: 'danger' },
  ];

  function mount(cfg) {
    const { t, esc, toast } = cfg;
    cfg.el.innerHTML = `<div class="access-grid">${LISTS.map((l) => `
      <article class="card access-card"><div class="access-head">${esc(t(l.title))}</div><div class="access-body">
        <div class="access-add"><input class="access-input" data-access-input="${l.key}" placeholder="${esc(t('Player name'))}" maxlength="16"><button class="btn ${l.cls}" data-access-add="${l.key}">${esc(t(l.add))}</button></div>
        <div class="access-rows" data-access-rows="${l.key}"></div>
      </div></article>`).join('')}</div>
      <div class="access-hint">${esc(t("Changes require a running server (they're sent as console commands)."))}</div>`;

    const rows = (key) => cfg.el.querySelector(`[data-access-rows="${key}"]`);
    const input = (key) => cfg.el.querySelector(`[data-access-input="${key}"]`);

    function render(data) {
      for (const l of LISTS) {
        const names = (data[l.key] || []).map((x) => x.name || x.user || x);
        rows(l.key).innerHTML = names.map((n) => `<div class="access-row"><span>${esc(n)}</span><button class="btn danger" data-access-remove="${l.key}" data-access-name="${esc(n)}">${esc(t('Remove'))}</button></div>`).join('')
          || `<div class="access-empty">${esc(t('empty'))}</div>`;
      }
    }
    async function load() { try { render(await cfg.load()); } catch (err) { toast(err.message); } }
    async function act(list, action, name) {
      if (!name) return;
      try { await cfg.act(list, action, name); } catch (err) { toast(err.message); }
      load();
    }

    cfg.el.addEventListener('click', (e) => {
      const rm = e.target.closest('[data-access-remove]');
      if (rm) return act(rm.dataset.accessRemove, 'remove', rm.dataset.accessName);
      const add = e.target.closest('[data-access-add]');
      if (add) { const el = input(add.dataset.accessAdd); act(add.dataset.accessAdd, 'add', el.value.trim()); el.value = ''; }
    });
    cfg.el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !e.target.dataset.accessInput) return;
      const el = e.target;
      act(el.dataset.accessInput, 'add', el.value.trim());
      el.value = '';
    });
    setInterval(() => { if (cfg.isVisible()) load(); }, 15000);
    return { load };
  }
  window.MeowAccess = { mount };
})();
