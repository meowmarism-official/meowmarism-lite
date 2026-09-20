// Panel self-update: latest release lookup, download, safe swap of panel/, a start test and rollback.
// The previous panel/ stays as panel.old until the new version has run healthily.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn, execFileSync } = require('child_process');

const MAX_BOOTS = 3;
const CONFIRM_AFTER_MS = Number(process.env.MEOW_CONFIRM_MS) || 60000;

function getText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 10000, headers: { 'User-Agent': 'meowmarism' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { resolve(getText(res.headers.location)); return; }
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); res.resume(); return; }
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(data));
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const get = (u) => {
      https.get(u, { timeout: 30000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { get(res.headers.location); return; }
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode} for ${u}`)); res.resume(); return; }
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve()));
        out.on('error', reject);
      }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
    };
    get(url);
  });
}

// Versions have three or four numbers: 0.1.8 and 0.1.8.1 (a fix of that release).
const parseTag = (t) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?$/.exec(t);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] || 0)] : [];
};
const newestFirst = (a, b) => { const x = parseTag(a), y = parseTag(b); return (y[0] - x[0]) || (y[1] - x[1]) || (y[2] - x[2]) || (y[3] - x[3]); };
const isNewer = (latest, current) => parseTag(latest).length > 0 && parseTag(current).length > 0 && newestFirst(current, latest) > 0;

function checkSyntax(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) checkSyntax(full);
    else if (entry.name.endsWith('.js')) execFileSync(process.execPath, ['--check', full], { stdio: 'ignore' });
  }
}

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } };

// repo: 'owner/name'; panelDir: the installed panel/ folder; statePrefix: '.meowmarism' in the home directory;
// probePath: a URL path the new version answers with 200 when healthy;
// hooks: { stop() -> token (before the swap), restore(token) (when the swap fails) }
function createUpdater({ repo, panelDir, statePrefix, probePath = '/', hooks = {} }) {
  const installDir = path.resolve(panelDir, '..');
  const MARKER = path.join(os.homedir(), `${statePrefix}-update-pending.json`);
  const RESULT = path.join(os.homedir(), `${statePrefix}-update-result.json`);
  const state = { running: false, error: null, step: null };
  let versionCache = null;

  async function fetchLatestTag() {
    let names = [];
    try {
      const releases = JSON.parse(await getText(`https://api.github.com/repos/${repo}/releases?per_page=30`));
      names = releases.filter((r) => !r.draft && !r.prerelease).map((r) => r.tag_name);
    } catch (_) {}
    if (!names.length) {
      try {
        names = JSON.parse(await getText(`https://api.github.com/repos/${repo}/tags?per_page=100`)).map((t) => t.name);
      } catch (_) {
        const html = await getText(`https://github.com/${repo}/tags`);
        names = [...html.matchAll(/\/releases\/tag\/(v\d+(?:\.\d+){2,3})/g)].map((m) => m[1]);
      }
    }
    return names.filter((n) => parseTag(n).length === 4).sort(newestFirst)[0] || null;
  }

  async function refreshVersionCache() {
    const cache = { at: Date.now(), tag: await fetchLatestTag(), publishedAt: null, url: null };
    if (cache.tag) {
      cache.url = `https://github.com/${repo}/releases/tag/${cache.tag}`;
      try { cache.publishedAt = JSON.parse(await getText(`https://api.github.com/repos/${repo}/releases/tags/${cache.tag}`)).published_at || null; } catch (_) {}
    }
    versionCache = cache;
  }

  // Installed and latest version; the lookup is cached for five minutes.
  async function versionInfo(refresh) {
    let version = null;
    try { version = JSON.parse(fs.readFileSync(path.join(installDir, 'package.json'), 'utf8')).version; } catch (_) {}
    const force = refresh && (!versionCache || Date.now() - versionCache.at > 30 * 1000);
    let checkError = null;
    if (force || !versionCache || Date.now() - versionCache.at > 5 * 60 * 1000) {
      try { await refreshVersionCache(); } catch (err) { checkError = err.message || 'could not reach GitHub'; }
    }
    const latestVersion = versionCache?.tag ? versionCache.tag.replace(/^v/, '') : null;
    return {
      version, latestVersion,
      publishedAt: versionCache?.publishedAt || null,
      releaseUrl: versionCache?.url || `https://github.com/${repo}/releases/latest`,
      checkedAt: versionCache?.at || null,
      checkError,
      updateAvailable: !!(version && latestVersion && isNewer(latestVersion, version)),
    };
  }

  function probeNewVersion(dir) {
    return new Promise((resolve) => {
      const port = 21000 + Math.floor(Math.random() * 20000);
      const child = spawn(process.execPath, [path.join(dir, 'controller.js')], {
        env: { ...process.env, MEOW_PROBE: '1', CONTROLLER_PORT: String(port), MEOWMARISM_HOST: '127.0.0.1' },
        stdio: 'ignore',
      });
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearInterval(poll);
        clearTimeout(limit);
        try { child.kill('SIGTERM'); } catch (_) {}
        resolve(ok);
      };
      child.on('exit', () => finish(false));
      const poll = setInterval(() => {
        http.get({ host: '127.0.0.1', port, path: probePath, timeout: 1500 }, (res) => { res.resume(); if (res.statusCode === 200) finish(true); }).on('error', () => {});
      }, 500);
      const limit = setTimeout(() => finish(false), 25000);
    });
  }

  function rollbackInstall(reason, from, to) {
    const live = path.join(installDir, 'panel');
    const old = path.join(installDir, 'panel.old');
    if (!fs.existsSync(old)) return false;
    fs.rmSync(path.join(installDir, 'panel.failed'), { recursive: true, force: true });
    fs.renameSync(live, path.join(installDir, 'panel.failed'));
    fs.renameSync(old, live);
    const oldPkg = path.join(installDir, 'package.json.old');
    if (fs.existsSync(oldPkg)) fs.renameSync(oldPkg, path.join(installDir, 'package.json'));
    fs.writeFileSync(RESULT, JSON.stringify({ rolledBack: true, reason, from, to, at: Date.now() }));
    return true;
  }

  async function selfUpdate() {
    state.step = 'Looking up the latest release';
    const tag = process.env.MEOW_UPDATE_TAG || await fetchLatestTag();
    if (!tag) throw new Error('no release found');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meowmarism-update-'));
    const tarball = path.join(tmp, 'release.tar.gz');
    state.step = 'Downloading';
    if (process.env.MEOW_UPDATE_TARBALL) fs.copyFileSync(process.env.MEOW_UPDATE_TARBALL, tarball);
    else await downloadFile(`https://github.com/${repo}/archive/refs/tags/${tag}.tar.gz`, tarball);
    state.step = 'Checking the download';
    await new Promise((resolve, reject) => {
      const p = spawn('tar', ['-xzf', tarball, '-C', tmp]);
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('could not extract the release'))));
      p.on('error', reject);
    });
    const extracted = fs.readdirSync(tmp).find((n) => n.startsWith('meowmarism-') && fs.statSync(path.join(tmp, n)).isDirectory());
    if (!extracted || !fs.existsSync(path.join(tmp, extracted, 'panel', 'controller.js'))) throw new Error('unexpected release layout');
    try { checkSyntax(path.join(tmp, extracted, 'panel')); } catch (_) { throw new Error('the downloaded release failed its syntax check'); }

    state.step = 'Stopping servers';
    const token = hooks.stop ? await hooks.stop() : null;

    state.step = 'Installing';
    const livePanel = path.join(installDir, 'panel');
    const newPanel = path.join(installDir, 'panel.new');
    const oldPanel = path.join(installDir, 'panel.old');
    let fromVersion = null;
    try { fromVersion = JSON.parse(fs.readFileSync(path.join(installDir, 'package.json'), 'utf8')).version; } catch (_) {}
    try {
      fs.rmSync(newPanel, { recursive: true, force: true });
      fs.rmSync(oldPanel, { recursive: true, force: true });
      fs.cpSync(path.join(tmp, extracted, 'panel'), newPanel, { recursive: true });
      fs.renameSync(livePanel, oldPanel);
      try {
        fs.renameSync(newPanel, livePanel);
      } catch (err) {
        fs.renameSync(oldPanel, livePanel);
        throw err;
      }
      try { fs.copyFileSync(path.join(installDir, 'package.json'), path.join(installDir, 'package.json.old')); } catch (_) {}
      fs.copyFileSync(path.join(tmp, extracted, 'package.json'), path.join(installDir, 'package.json'));
    } catch (err) {
      if (hooks.restore) hooks.restore(token);
      throw new Error(`installing failed, the old version is still active (${err.message})`);
    }

    state.step = 'Testing the new version';
    if (!(await probeNewVersion(livePanel))) {
      rollbackInstall('the new version failed its start test', fromVersion, tag);
      fs.rmSync(path.join(installDir, 'panel.failed'), { recursive: true, force: true });
      if (hooks.restore) hooks.restore(token);
      throw new Error('the new version failed its start test, the old version is still active');
    }
    try { fs.unlinkSync(RESULT); } catch (_) {}
    fs.writeFileSync(MARKER, JSON.stringify({ from: fromVersion, to: tag, boots: 0, at: Date.now() }));
    fs.rmSync(tmp, { recursive: true, force: true });
    state.step = 'Restarting';
    process.exit(0);
  }

  // Returns false when an update is already running.
  function start() {
    if (state.running) return false;
    state.running = true;
    state.error = null;
    selfUpdate().catch((err) => { state.running = false; state.step = null; state.error = err.message || 'update failed'; });
    return true;
  }

  // First thing on boot: a version that keeps crashing is swapped back for the old one.
  function bootCheck() {
    if (process.env.MEOW_PROBE) return;
    const marker = readJson(MARKER);
    if (!marker) return;
    marker.boots = (marker.boots || 0) + 1;
    try { fs.writeFileSync(MARKER, JSON.stringify(marker)); } catch (_) {}
    if (marker.boots > MAX_BOOTS) {
      try {
        if (rollbackInstall('the new version kept crashing on startup', marker.from, marker.to)) {
          fs.unlinkSync(MARKER);
          process.exit(1);
        }
      } catch (_) {}
      try { fs.unlinkSync(MARKER); } catch (_) {}
    }
  }

  function confirmHealthy() {
    if (process.env.MEOW_PROBE || !fs.existsSync(MARKER)) return;
    const t = setTimeout(() => {
      try { fs.unlinkSync(MARKER); } catch (_) {}
      fs.rmSync(path.join(installDir, 'panel.old'), { recursive: true, force: true });
      fs.rmSync(path.join(installDir, 'package.json.old'), { force: true });
      fs.rmSync(path.join(installDir, 'panel.failed'), { recursive: true, force: true });
    }, CONFIRM_AFTER_MS);
    if (t.unref) t.unref();
  }

  function lastResult() {
    const r = readJson(RESULT);
    return r && Date.now() - r.at < 7 * 24 * 3600 * 1000 ? r : null;
  }

  return { versionInfo, start, status: () => ({ ...state, lastResult: lastResult() }), bootCheck, confirmHealthy };
}

module.exports = { createUpdater, parseTag, newestFirst, isNewer };
