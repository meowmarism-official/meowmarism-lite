// Step-by-step dialog for creating an instance, with a progress view while it is created. Shared by every product.
// cfg: { steps: [{ title, hint, html, validate?() -> message | falsy, onShow?() }], createLabel, create() -> Promise (throws on failure),
//   progress() -> Promise<{ lines, progress, done, error, name }>, openHref?(name), onFinished?(), onOpen?(), t, esc, openButton, focusEl? }
// A step may have when() -> boolean; inactive steps are skipped by Next/Back and hidden in the step dots. The last step must always be active; Back on the first active step closes the dialog.
(function () {
  function mount(cfg) {
    const { t, esc } = cfg;
    const n = cfg.steps.length;
    const $ = (id) => document.getElementById(id);
    let creating = false;
    let current = 1;
    const active = (k) => !cfg.steps[k - 1].when || !!cfg.steps[k - 1].when();
    const nextActive = (k) => { let j = k + 1; while (j < n && !active(j)) j++; return j; };
    const prevActive = (k) => { for (let j = k - 1; j >= 1; j--) if (active(j)) return j; return null; };
    const firstActive = () => { let j = 1; while (!active(j)) j++; return j; };

    const stepHtml = cfg.steps.map((s, i) => {
      const k = i + 1;
      const first = k === 1;
      const last = k === n;
      const left = first ? `<button class="btn" id="w-cancel1">${esc(t('Cancel'))}</button>` : `<button class="btn" id="w-back${k}">${esc(t('Back'))}</button>`;
      const right = last ? `<button class="btn primary" id="w-create">${esc(t(cfg.createLabel))}</button>` : `<button class="btn primary" id="w-next${k}">${esc(t('Next'))}</button>`;
      return `
    <div id="step${k}"${first ? '' : ' style="display:none"'}>
      <h2>${esc(t(s.title))}</h2>
      <p class="step-hint">${esc(t(s.hint))}</p>
      ${s.html}
      ${last ? '' : `<p class="hint" id="w${k}-error" style="color:var(--red);display:none"></p>`}
      <div class="wizard-actions">${left}${right}</div>
      ${last ? '<p class="hint" id="createStatus"></p>' : ''}
    </div>`;
    }).join('\n');

    document.body.insertAdjacentHTML('beforeend', `
<div class="wizard-back" id="wizardBack">
  <div class="wizard">
    <div class="steps">${cfg.steps.map((_, i) => `<span id="stepDot${i + 1}"></span>`).join('')}</div>
${stepHtml}

    <div id="step${n + 1}" style="display:none">
      <h2 id="creatingTitle">Creating instance&hellip;</h2>
      <p class="step-hint" id="creatingHint">${esc(t('Downloading and installing the server software - this can take a few minutes.'))}</p>
      <div class="progress-track"><div class="progress-fill" id="creatingBar" style="width:5%"></div></div>
      <div class="console" id="creatingConsole"></div>
      <div class="wizard-actions">
        <span></span>
        <a class="btn primary" id="creatingOpen" style="display:none">${esc(t('Open instance'))}</a>
        <button class="btn" id="creatingClose" style="display:none">${esc(t('Close'))}</button>
      </div>
    </div>
  </div>
</div>`);

    function showStep(k) {
      current = k;
      for (let i = 1; i <= n + 1; i++) $(`step${i}`).style.display = i === k ? '' : 'none';
      refresh();
      if (cfg.steps[k - 1] && cfg.steps[k - 1].onShow) cfg.steps[k - 1].onShow();
    }
    function refresh() {
      for (let i = 1; i <= n; i++) {
        const dot = $(`stepDot${i}`);
        dot.style.display = active(i) ? '' : 'none';
        dot.classList.toggle('done', current >= i);
      }
    }
    function error(k, msg) {
      const el = $(`w${k}-error`);
      if (!el) return;
      if (!msg) { el.style.display = 'none'; el.textContent = ''; return; }
      el.textContent = t(msg); el.style.display = '';
    }
    function open() {
      $('wizardBack').classList.add('open');
      showStep(firstActive());
      $('createStatus').textContent = '';
      for (let i = 1; i < n; i++) error(i, null);
      if (cfg.onOpen) cfg.onOpen();
    }
    function close() { if (!creating) $('wizardBack').classList.remove('open'); }

    $('w-cancel1').addEventListener('click', close);
    for (let k = 1; k < n; k++) {
      $(`w-next${k}`).addEventListener('click', () => {
        const msg = cfg.steps[k - 1].validate && cfg.steps[k - 1].validate();
        if (msg) return error(k, msg);
        error(k, null);
        showStep(nextActive(k));
      });
    }
    for (let k = 2; k <= n; k++) $(`w-back${k}`).addEventListener('click', () => { const p = prevActive(k); if (p == null) close(); else showStep(p); });

    $('w-create').addEventListener('click', async () => {
      const msg = cfg.steps[n - 1].validate && cfg.steps[n - 1].validate();
      if (msg) { $('createStatus').textContent = t(msg); return; }
      $('w-create').disabled = true;
      let name;
      try { name = await cfg.create(); } catch (err) { $('w-create').disabled = false; $('createStatus').textContent = err.message || t('Failed to create'); return; }
      $('w-create').disabled = false;
      startCreationView(name);
    });

    function startCreationView(name) {
      creating = true;
      showStep(n + 1);
      $('creatingTitle').textContent = `${t('Creating')} "${name}"…`;
      $('creatingHint').textContent = t('Downloading and installing the server software - this can take a few minutes.');
      $('creatingBar').style.width = '5%';
      $('creatingBar').className = 'progress-fill';
      $('creatingConsole').innerHTML = '';
      $('creatingOpen').style.display = 'none';
      $('creatingClose').style.display = 'none';
      let shown = 0;
      const box = $('creatingConsole');
      const poll = setInterval(async () => {
        let s;
        try { s = await cfg.progress(); } catch (_) { return; }
        const lines = s.lines || [];
        for (let i = shown; i < lines.length; i++) {
          const div = document.createElement('div');
          div.textContent = lines[i];
          box.appendChild(div);
        }
        if (lines.length > shown) { shown = lines.length; box.scrollTop = box.scrollHeight; }
        $('creatingBar').style.width = `${s.progress || 0}%`;
        if (s.phase && !s.done) $('creatingHint').textContent = t(s.phase);
        if (!s.done) return;
        clearInterval(poll);
        creating = false;
        if (s.error) {
          $('creatingTitle').textContent = `${t('Failed to create')} "${name}"`;
          $('creatingHint').textContent = s.error;
          $('creatingBar').className = 'progress-fill err';
        } else {
          $('creatingTitle').textContent = `"${s.name || name}" ${t('is ready')}`;
          $('creatingHint').textContent = t('Installed and registered - start it whenever you want.');
          $('creatingBar').style.width = '100%';
          $('creatingBar').className = 'progress-fill done';
          if (s.name && cfg.openHref) { $('creatingOpen').href = cfg.openHref(s.name); $('creatingOpen').style.display = ''; }
        }
        $('creatingClose').style.display = '';
        if (cfg.onFinished) cfg.onFinished(s);
      }, 1000);
    }
    $('creatingClose').addEventListener('click', close);

    return { open, close, showStep, error, refresh };
  }
  window.MeowWizard = { mount };
})();
