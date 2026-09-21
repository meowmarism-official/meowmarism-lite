// Command palette (Ctrl+K) and the "g" + letter page shortcuts. Shared by every product.
// cfg: { goto(page), focusConsole?(), focusSearch?(), extra() -> [{ label, sub, key, run }], esc, t? }
(function () {
  const PAGES = [
    { label: 'Overview', sub: 'Go to live server overview', key: 'G O', page: 'overview' },
    { label: 'Performance', sub: 'CPU, RAM, network and tick telemetry', key: 'G P', page: 'performance' },
    { label: 'Players', sub: 'Online players and history', key: 'G U', page: 'players' },
    { label: 'Console', sub: 'Live console and commands', key: 'G C', page: 'console', console: true },
    { label: 'Settings', sub: 'server.properties', key: 'G S', page: 'settings' },
    { label: 'Events & Audit', sub: 'Timeline, health and lifecycle', key: 'G E', page: 'events' },
  ];
  const CHORDS = { o: 'overview', p: 'performance', u: 'players', c: 'console', s: 'settings', e: 'events' };

  function mount(cfg) {
    document.body.insertAdjacentHTML('beforeend', '<div class="palette-backdrop" id="paletteBackdrop"><div class="palette" role="dialog" aria-modal="true" aria-label="Command palette"><input class="palette-input" id="paletteInput" placeholder="Go to page, find player, run action…" autocomplete="off"><div class="palette-list" id="paletteList"></div></div></div>');
    const $ = (id) => document.getElementById(id);
    const { esc } = cfg;
    let index = 0;

    function actions() {
      const pages = PAGES.map((p) => ({ label: p.label, sub: p.sub, key: p.key, run: () => { cfg.goto(p.page); if (p.console && cfg.focusConsole) setTimeout(cfg.focusConsole, 0); } }));
      return [...pages, ...(cfg.extra ? cfg.extra() : [])];
    }
    function render() {
      const q = $('paletteInput').value.trim().toLowerCase();
      const filtered = actions().filter((a) => !q || `${a.label} ${a.sub}`.toLowerCase().includes(q)).slice(0, 18);
      index = Math.max(0, Math.min(index, Math.max(0, filtered.length - 1)));
      $('paletteList').innerHTML = filtered.map((a, i) => `<button class="palette-item ${i === index ? 'active' : ''}" data-pal="${i}"><span><div class="palette-main">${esc(a.label)}</div><div class="palette-sub">${esc(a.sub || '')}</div></span><span class="palette-key">${esc(a.key || '')}</span></button>`).join('');
      $('paletteList')._actions = filtered;
    }
    function open() { index = 0; $('paletteBackdrop').classList.add('open'); $('paletteInput').value = ''; render(); setTimeout(() => $('paletteInput').focus(), 0); }
    function close() { $('paletteBackdrop').classList.remove('open'); }
    const run = (a) => { if (a) { close(); a.run(); } };

    $('paletteInput').addEventListener('input', () => { index = 0; render(); });
    $('paletteInput').addEventListener('keydown', (e) => {
      const acts = $('paletteList')._actions || [];
      const n = Math.max(1, acts.length);
      if (e.key === 'ArrowDown') { e.preventDefault(); index = (index + 1) % n; render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); index = (index - 1 + n) % n; render(); }
      else if (e.key === 'Enter') { e.preventDefault(); run(acts[index]); }
      else if (e.key === 'Escape') close();
    });
    $('paletteList').addEventListener('click', (e) => {
      const b = e.target.closest('[data-pal]');
      if (b) run(($('paletteList')._actions || [])[Number(b.dataset.pal)]);
    });
    $('paletteBackdrop').addEventListener('mousedown', (e) => { if (e.target === $('paletteBackdrop')) close(); });

    let chord = '';
    let chordTimer = null;
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); open(); return; }
      if (e.target.matches('input,textarea,select') || e.target.isContentEditable) return;
      if (e.key === '/') { e.preventDefault(); cfg.goto('console'); if (cfg.focusSearch) setTimeout(cfg.focusSearch, 0); return; }
      const k = e.key.toLowerCase();
      if (chord === 'g' && CHORDS[k]) { e.preventDefault(); cfg.goto(CHORDS[k]); chord = ''; clearTimeout(chordTimer); return; }
      if (k === 'g') { chord = 'g'; clearTimeout(chordTimer); chordTimer = setTimeout(() => { chord = ''; }, 900); }
    });
    return { open, close };
  }
  window.MeowPalette = { mount };
})();
