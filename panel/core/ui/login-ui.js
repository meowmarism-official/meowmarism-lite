// Login page: username, password, "remember me" and the plain-HTTP warning. Shared by every product.
// cfg: { edition, url (POST endpoint), after() }
(function () {
  function mount(cfg) {
    document.body.insertAdjacentHTML('afterbegin', `<div class="http-warn" id="httpWarn" style="max-width:340px;margin:16px auto 0">This panel is reached over plain HTTP on a public address, so passwords and sessions can be intercepted. Put it behind HTTPS (see the README).</div>
<div class="card">
  <h1><span class="wordmark">meowmarism</span> <span class="edition">${cfg.edition}</span></h1>
  <form id="loginForm">
    <div class="field"><label for="username">Username</label><input id="username" autocomplete="username" required></div>
    <div class="field"><label for="password">Password</label><input id="password" type="password" autocomplete="current-password" required></div>
    <label class="toggle-row">
      <span class="toggle"><input type="checkbox" id="remember" checked><span class="toggle-track"></span><span class="toggle-thumb"></span></span>
      Remember me
    </label>
    <button type="submit">Log in</button>
  </form>
  <div class="error" id="error"></div>
  <p style="text-align:center;margin:14px 0 0"><a href="#" data-lang-toggle data-no-i18n style="color:var(--muted);font-size:12px;text-decoration:none"><span data-lang-label></span></a></p>
</div>`);
    const h = location.hostname;
    const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1\]?$|\[?f[cd])/i.test(h) || h.endsWith('.local') || h.endsWith('.lan') || !h.includes('.');
    if (location.protocol === 'http:' && !local) document.getElementById('httpWarn').style.display = 'block';
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = document.getElementById('error');
      errEl.style.display = 'none';
      const body = { username: document.getElementById('username').value, password: document.getElementById('password').value, remember: document.getElementById('remember').checked };
      const r = await fetch(cfg.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (r.ok) { cfg.after(); return; }
      const d = await r.json().catch(() => ({}));
      errEl.textContent = window.t(d.error || 'Login failed');
      errEl.style.display = 'block';
    });
  }
  window.MeowLogin = { mount };
})();
