// Prefixes fetch and EventSource URLs with the instance path when the page is served through the controller.
(() => {
  const m = location.pathname.match(/^\/instance\/[^/]+/);
  const BASE = m ? m[0] : '';
  window.__BASE = BASE;
  if (!BASE) return;
  const prefix = (u) => (typeof u === 'string' && u.startsWith('/') && !u.startsWith(BASE + '/') ? BASE + u : u);
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (u, o) => nativeFetch(prefix(u), o);
  const NativeES = window.EventSource;
  window.EventSource = function (u, o) { return new NativeES(prefix(u), o); };
  window.EventSource.prototype = NativeES.prototype;
  const fixLinks = (root) => root.querySelectorAll('a[href^="/"]:not([data-no-prefix])').forEach((a) => {
    const h = a.getAttribute('href');
    if (!h.startsWith(BASE + '/')) a.setAttribute('href', BASE + h);
  });
  document.addEventListener('DOMContentLoaded', () => {
    fixLinks(document);
    new MutationObserver(() => fixLinks(document)).observe(document.body, { childList: true, subtree: true });
  });
})();
