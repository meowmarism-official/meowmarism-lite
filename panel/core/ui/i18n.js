// UI translation: exact-match dictionary (English source text -> translation) applied to the DOM.
(() => {
  const LANGS = { en: 'English', de: 'Deutsch', fr: 'Français', es: 'Español' };
  const FLAGS = {
    en: '<rect width="24" height="16" fill="#012169"/><path d="M0 0L24 16M24 0L0 16" stroke="#fff" stroke-width="3"/><path d="M0 0L24 16M24 0L0 16" stroke="#C8102E" stroke-width="1.2"/><path d="M12 0V16M0 8H24" stroke="#fff" stroke-width="5"/><path d="M12 0V16M0 8H24" stroke="#C8102E" stroke-width="3"/>',
    de: '<rect width="24" height="5.4" fill="#000"/><rect y="5.3" width="24" height="5.4" fill="#DD0000"/><rect y="10.6" width="24" height="5.4" fill="#FFCE00"/>',
    fr: '<rect width="8" height="16" fill="#0055A4"/><rect x="8" width="8" height="16" fill="#fff"/><rect x="16" width="8" height="16" fill="#EF4135"/>',
    es: '<rect width="24" height="16" fill="#AA151B"/><rect y="4" width="24" height="8" fill="#F1BF00"/>',
  };
  const loadLang = (code) => {
    if (code === 'en') return { dict: null, patterns: [] };
    try {
      const x = new XMLHttpRequest();
      x.open('GET', '/lang/' + code + '.json', false);
      x.send();
      if (x.status !== 200) return { dict: null, patterns: [] };
      const j = JSON.parse(x.responseText);
      return { dict: j.dict, patterns: j.patterns.map(([s, f, r]) => [new RegExp(s, f), r]) };
    } catch (_) { return { dict: null, patterns: [] }; }
  };

  let lang = 'en';
  try { lang = localStorage.getItem('lang') || ''; } catch (_) {}
  if (!LANGS[lang]) { const guess = (navigator.language || 'en').slice(0, 2).toLowerCase(); lang = LANGS[guess] ? guess : 'en'; }
  const { dict, patterns } = loadLang(lang);

  function translate(s) {
    if (!dict) return s;
    const core = s.trim();
    if (!core || !/[A-Za-z]{2}/.test(core)) return s;
    let out = dict[core];
    if (out === undefined) {
      for (const [re, rep] of patterns) {
        if (re.test(core)) { out = core.replace(re, rep); break; }
      }
    }
    if (out === undefined || out === core) return s;
    return s.replace(core, out);
  }

  window.t = (s, vars) => {
    let out = translate(s);
    if (vars) for (const k of Object.keys(vars)) out = out.split(`{${k}}`).join(vars[k]);
    return out;
  };
  window.i18nLang = lang;

  const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
  const SKIP = 'script,style,textarea,pre,code,[data-no-i18n],#console';
  const skipped = (el) => !el || (el.closest && el.closest(SKIP));

  function fixText(node) {
    if (skipped(node.parentElement)) return;
    const next = translate(node.nodeValue);
    if (next !== node.nodeValue) node.nodeValue = next;
  }
  function fixAttrs(el) {
    if (skipped(el)) return;
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v) { const next = translate(v); if (next !== v) el.setAttribute(a, next); }
    }
  }
  function fixTree(root) {
    if (root.nodeType === 3) { fixText(root); return; }
    if (root.nodeType !== 1) return;
    fixAttrs(root);
    root.querySelectorAll('[placeholder],[title],[aria-label],[alt]').forEach(fixAttrs);
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) fixText(w.currentNode);
  }

  function setLang(next) {
    try { localStorage.setItem('lang', next); } catch (_) {}
    location.reload();
  }

  const flagSvg = (code) => `<svg viewBox="0 0 24 16" width="20" height="14" style="border-radius:2px;flex:0 0 auto">${FLAGS[code] || ''}</svg>`;
  const style = document.createElement('style');
  style.textContent = '@media(min-width:761px){html.lang-menu-open .sidebar{width:var(--sidebar-open,208px)!important}}'
    + 'html.lang-menu-open .sidebar .side-label,html.lang-menu-open .sidebar .side-pill,html.lang-menu-open .sidebar .side-brand-text,html.lang-menu-open .sidebar .side-account-info,html.lang-menu-open .sidebar .side-meta,html.lang-menu-open .sidebar .live-row span+span,html.lang-menu-open .sidebar #updateBadge{opacity:1!important}'
    + '.lang-menu button{display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:9px 12px;border:0;border-radius:0;background:transparent;color:#9299a3;cursor:pointer;font:inherit}'
    + '.lang-menu button:hover{color:#e7e9ec;background:rgba(255,255,255,.04)}'
    + '.lang-menu button.active{color:#e7e9ec;background:rgba(255,111,196,.1);box-shadow:inset 2px 0 0 #ff6fc4}';
  style.textContent += '.lang-flag{display:block;width:18px;height:12px;border-radius:2px;flex:0 0 auto}';
  document.head.appendChild(style);

  let menu = null;
  function closeMenu() {
    if (menu) { menu.remove(); menu = null; }
    document.documentElement.classList.remove('lang-menu-open');
  }
  function openMenu(anchor) {
    closeMenu();
    document.documentElement.classList.add('lang-menu-open');
    menu = document.createElement('div');
    menu.className = 'lang-menu';
    menu.setAttribute('data-no-i18n', '');
    menu.style.cssText = 'position:fixed;z-index:200;min-width:170px;background:#17191d;border:1px solid #292d32;border-radius:8px;padding:4px 0;overflow:hidden;box-shadow:0 8px 24px rgba(0,0,0,.4);font:13px Inter,ui-sans-serif,system-ui,sans-serif';
    for (const [code, name] of Object.entries(LANGS)) {
      const item = document.createElement('button');
      item.type = 'button';
      if (code === lang) item.className = 'active';
      item.innerHTML = flagSvg(code) + '<span></span>';
      item.lastChild.textContent = name;
      item.onclick = () => { if (code === lang) closeMenu(); else setLang(code); };
      menu.appendChild(item);
    }
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    const h = menu.offsetHeight;
    const openW = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-open'), 10) || 208;
    const left = anchor.closest('.sidebar') ? (window.innerWidth > 760 ? openW + 6 : r.left) : r.right + 6;
    menu.style.left = Math.max(8, Math.min(left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(r.bottom - h, window.innerHeight - h - 8)) + 'px';
  }
  function wireToggles() {
    document.querySelectorAll('[data-lang-toggle]').forEach((el) => {
      const icon = el.querySelector('svg, img.lang-flag');
      if (icon) {
        const src = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 16">${FLAGS[lang] || ''}</svg>`);
        if (icon.tagName === 'IMG') { if (icon.getAttribute('src') !== src) icon.setAttribute('src', src); }
        else { const img = document.createElement('img'); img.className = 'lang-flag'; img.alt = ''; img.src = src; icon.replaceWith(img); }
      }
      const label = el.querySelector('[data-lang-label]');
      if (label && label.textContent !== LANGS[lang]) label.textContent = LANGS[lang];
      if (!el.dataset.langWired) {
        el.dataset.langWired = '1';
        el.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openMenu(el); });
      }
    });
  }
  document.addEventListener('click', closeMenu);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

  document.documentElement.lang = lang;
  if (dict) {
    new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'characterData') fixTree(m.target);
        else if (m.type === 'attributes') fixAttrs(m.target);
        else m.addedNodes.forEach(fixTree);
      }
    }).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }
  document.addEventListener('DOMContentLoaded', () => {
    if (dict) fixTree(document.documentElement);
    wireToggles();
    if (dict) new MutationObserver(wireToggles).observe(document.body, { childList: true, subtree: true });
  });
})();
