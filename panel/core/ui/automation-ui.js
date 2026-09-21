// Automation page: cards for automatic restarts, backups, sleep mode, crash handling, console buffer and lifecycle actions. Shared by every product.
// cfg: { el, sections: ['restart','backup','sleep','crash','console','lifecycle'], load() -> config object, save(patch, section), toast, t, after?(section) }
// The lifecycle card (delay, reason, schedule/cancel/force stop) keeps its element ids; the product wires those buttons.
(function () {
  const CARDS = {
    restart: `  <article class="card span-6"><div class="card-head"><div class="card-title">Daily auto-restart</div></div><div class="card-body">
    <div class="hint" style="margin-bottom:8px">Restarts the server once a day at the chosen time (with an in-chat warning countdown and an automatic backup beforehand).</div>
    <label class="hint" style="display:block;margin-bottom:6px"><input type="checkbox" id="autoRestartEnabled"> enabled</label>
    <div class="cmd-row"><input class="compact-input" type="time" id="autoRestartTime"><select class="compact-select" id="autoRestartWarnSec"><option value="60">1 min warning</option><option value="120">2 min warning</option><option value="300" selected>5 min warning</option><option value="600">10 min warning</option></select></div>
    <div class="settings-actions" style="margin-top:8px"><button class="btn primary" id="btnSaveAutoRestart">Save</button></div>
  </div></article>`,
    backup: `  <article class="card span-6"><div class="card-head"><div class="card-title">Backup settings</div></div><div class="card-body">
    <div class="hint" style="margin-bottom:8px">How often backups run automatically, how many are kept, and how much disk space must stay free after a backup.</div>
    <div class="cmd-row">
      <label class="hint">Every<input class="compact-input" type="number" min="0.25" max="168" step="0.25" id="backupIntervalHours" style="width:70px;margin:0 6px">hours</label>
      <label class="hint">Max<input class="compact-input" type="number" min="1" max="100" step="1" id="maxBackups" style="width:60px;margin:0 6px">backups</label>
      <label class="hint">Keep<input class="compact-input" type="number" min="0" max="1000" step="1" id="backupMinFreeGB" style="width:60px;margin:0 6px">GB free</label>
    </div>
    <div class="settings-actions" style="margin-top:8px"><button class="btn primary" id="btnSaveBackupCfg">Save</button></div>
  </div></article>`,
    sleep: `  <article class="card span-6"><div class="card-head"><div class="card-title">Sleep mode</div></div><div class="card-body">
    <div class="hint" style="margin-bottom:8px">Automatically stops the server when nobody's online, and wakes it back up as soon as someone tries to join (the server stays visible in the multiplayer list while asleep).</div>
    <label class="hint" style="display:block;margin-bottom:6px"><input type="checkbox" id="sleepEnabled"> enabled</label>
    <div class="cmd-row"><label class="hint">After<input class="compact-input" type="number" min="1" max="1440" step="1" id="sleepAfterMinutes" style="width:70px;margin:0 6px">minutes with no players</label></div>
    <div class="settings-actions" style="margin-top:8px"><button class="btn primary" id="btnSaveSleep">Save</button></div>
  </div></article>`,
    crash: `  <article class="card span-6"><div class="card-head"><div class="card-title">Crash auto-restart</div></div><div class="card-body">
    <div class="hint" style="margin-bottom:8px">Automatically restarts the server after an unexpected crash. Gives up after too many crashes in a row so a broken mod doesn't loop forever.</div>
    <label class="hint" style="display:block;margin-bottom:6px"><input type="checkbox" id="crashAutoRestartEnabled"> enabled</label>
    <div class="cmd-row">
      <label class="hint">Wait<input class="compact-input" type="number" min="0" max="600" step="5" id="crashAutoRestartDelaySec" style="width:70px;margin:0 6px">sec</label>
      <label class="hint">Max<input class="compact-input" type="number" min="1" max="20" step="1" id="maxCrashRestartsPerHour" style="width:60px;margin:0 6px">crashes/hour</label>
    </div>
    <div class="settings-actions" style="margin-top:8px"><button class="btn primary" id="btnSaveCrashRestart">Save</button></div>
  </div></article>`,
    console: `  <article class="card span-6"><div class="card-head"><div class="card-title">Console buffer</div></div><div class="card-body">
    <div class="hint" style="margin-bottom:8px">How many console lines are kept in memory / the live view (more = more panel RAM usage).</div>
    <div class="cmd-row"><input class="compact-input" type="number" min="100" max="50000" step="100" id="consoleBufferSize" style="width:110px"><span class="hint">lines</span></div>
    <div class="settings-actions" style="margin-top:8px"><button class="btn primary" id="btnSaveConsoleCfg">Save</button></div>
  </div></article>`,
    lifecycle: `  <article class="card span-6"><div class="card-head"><div class="card-title">Lifecycle</div><div class="card-meta">warn players before restart</div></div><div class="card-body lifecycle-grid"><div class="restart-row"><label class="hint">Delay</label><select class="compact-select" id="restartDelay"><option value="0">now</option><option value="10" selected>10 sec</option><option value="30">30 sec</option><option value="60">1 min</option><option value="300">5 min</option></select></div><div class="restart-row"><label class="hint">Reason</label><input class="compact-input" id="restartReason" value="Scheduled restart" maxlength="160"></div><label class="hint"><input type="checkbox" id="restartWarn" checked> warn players in chat</label><div class="restart-actions"><button class="btn primary" id="btnScheduleRestart">Schedule restart</button><button class="btn" id="btnCancelRestart">Cancel</button><button class="btn danger" id="btnForceStop">Force stop</button></div><div class="restart-live" id="restartLive">—</div></div></article>`,
  };
  const FIELDS = {
    restart: { saved: 'Auto-restart settings saved', save: 'btnSaveAutoRestart', fields: [['autoRestartEnabled', 'check'], ['autoRestartTime', 'text', '04:00'], ['autoRestartWarnSec', 'num', 300]] },
    backup: { saved: 'Backup settings saved', save: 'btnSaveBackupCfg', fields: [['backupIntervalHours', 'num', 6], ['maxBackups', 'num', 10], ['backupMinFreeGB', 'num', 5]] },
    sleep: { saved: 'Sleep mode settings saved', save: 'btnSaveSleep', fields: [['sleepEnabled', 'check'], ['sleepAfterMinutes', 'num', 20]] },
    crash: { saved: 'Crash auto-restart settings saved', save: 'btnSaveCrashRestart', fields: [['crashAutoRestartEnabled', 'check'], ['crashAutoRestartDelaySec', 'num', 15], ['maxCrashRestartsPerHour', 'num', 3]] },
    console: { saved: 'Console buffer setting saved', save: 'btnSaveConsoleCfg', fields: [['consoleBufferSize', 'num', 5000]] },
  };

  function mount(cfg) {
    const sections = cfg.sections || Object.keys(CARDS);
    const $ = (id) => document.getElementById(id);
    cfg.el.innerHTML = `<div class="grid">${sections.map((s) => CARDS[s]).join('')}</div>`;

    async function load() {
      try {
        const c = await cfg.load();
        for (const s of sections) {
          for (const [id, type, def] of (FIELDS[s] ? FIELDS[s].fields : [])) {
            const el = $(id);
            if (!el) continue;
            if (type === 'check') el.checked = !!c[id]; else el.value = String(c[id] ?? def);
          }
        }
      } catch (err) { console.error(err); }
    }
    for (const s of sections) {
      const spec = FIELDS[s];
      if (!spec) continue;
      $(spec.save).addEventListener('click', async () => {
        const patch = {};
        for (const [id, type] of spec.fields) patch[id] = type === 'check' ? $(id).checked : type === 'num' ? Number($(id).value) : $(id).value;
        try { await cfg.save(patch, s); cfg.toast(cfg.t(spec.saved)); if (cfg.after) cfg.after(s); } catch (err) { cfg.toast(err.message, 'error'); }
      });
    }
    return { load };
  }
  window.MeowAutomation = { mount };
})();

