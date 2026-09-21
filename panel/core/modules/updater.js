// Panel self-update: latest release lookup, download, safe swap of panel/, a start test and rollback.
// The previous panel/ stays as panel.old until the new version has run healthily.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn, execFileSync } = require('child_process');
const { getBuildInfo } = require('./build-info');

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
    const build = getBuildInfo(installDir);
    const version = build.version;
    const force = refresh && (!versionCache || Date.now() - versionCache.at > 30 * 1000);
    let checkError = null;
    if (force || !versionCache || Date.now() - versionCache.at > 5 * 60 * 1000) {
      try { await refreshVersionCache(); } catch (err) { checkError = err.message || 'could not reach GitHub'; }
    }
    const latestVersion = versionCache?.tag ? versionCache.tag.replace(/^v/, '') : null;
    return {
      version, channel: build.channel, commit: build.commit, label: build.label, latestVersion,
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

  const retry = (fn) => {
    let last;
    for (let i = 0; i < 3; i++) { try { return fn(); } catch (err) { last = err; } }
    throw last;
  };
  const remove = (p) => fs.rmSync(p, { recursive: true, force: true });

  // Puts panel.old and package.json.old back as the live install. The panel folder is never left missing:
  // if the old one cannot be moved into place, the folder that was moved away is moved back.
  function restoreOldVersion() {
    const live = path.join(installDir, 'panel');
    const old = path.join(installDir, 'panel.old');
    const failed = path.join(installDir, 'panel.failed');
    const oldPkg = path.join(installDir, 'package.json.old');
    if (!fs.existsSync(old)) return false;
    remove(failed);
    const movedAway = fs.existsSync(live);
    if (movedAway) retry(() => fs.renameSync(live, failed));
    try {
      retry(() => fs.renameSync(old, live));
    } catch (err) {
      if (movedAway) { try { fs.renameSync(failed, live); } catch (_) {} }
      throw err;
    }
    if (fs.existsSync(oldPkg)) retry(() => fs.renameSync(oldPkg, path.join(installDir, 'package.json')));
    return true;
  }

  function rollbackInstall(reason, from, to) {
    if (!restoreOldVersion()) return false;
    try { fs.writeFileSync(RESULT, JSON.stringify({ rolledBack: true, reason, from, to, at: Date.now() })); } catch (_) {}
    return true;
  }

  async function selfUpdate() {
    state.step = 'Looking up the latest release';
    const tag = process.env.MEOW_UPDATE_TAG || await fetchLatestTag();
    if (!tag) throw new Error('no release found');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meowmarism-update-'));
    try {
      return await installRelease(tag, tmp);
    } catch (err) {
      remove(tmp);
      throw err;
    }
  }

  async function installRelease(tag, tmp) {
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
    const release = extracted && path.join(tmp, extracted);
    if (!release || !fs.existsSync(path.join(release, 'panel', 'controller.js')) || !readJson(path.join(release, 'package.json'))?.version) throw new Error('unexpected release layout');
    try { checkSyntax(path.join(release, 'panel')); } catch (_) { throw new Error('the downloaded release failed its syntax check'); }

    state.step = 'Stopping servers';
    const token = hooks.stop ? await hooks.stop() : null;
    const restoreServers = () => { if (hooks.restore) hooks.restore(token); };

    state.step = 'Installing';
    const livePanel = path.join(installDir, 'panel');
    const newPanel = path.join(installDir, 'panel.new');
    const oldPanel = path.join(installDir, 'panel.old');
    const failedPanel = path.join(installDir, 'panel.failed');
    const pkg = path.join(installDir, 'package.json');
    const oldPkg = path.join(installDir, 'package.json.old');
    const fromVersion = readJson(pkg)?.version || null;
    try {
      remove(newPanel); remove(oldPanel); remove(oldPkg); remove(failedPanel);
      fs.cpSync(path.join(release, 'panel'), newPanel, { recursive: true });
      retry(() => fs.renameSync(livePanel, oldPanel));
      try {
        retry(() => fs.renameSync(newPanel, livePanel));
      } catch (err) {
        retry(() => fs.renameSync(oldPanel, livePanel));
        throw err;
      }
      if (fs.existsSync(pkg)) fs.copyFileSync(pkg, oldPkg);
      fs.copyFileSync(path.join(release, 'package.json'), pkg);
    } catch (err) {
      try { restoreOldVersion(); } catch (_) {}
      remove(newPanel); remove(failedPanel); remove(oldPkg);
      restoreServers();
      throw new Error(`installing failed, the old version is still active (${err.message})`);
    }

    state.step = 'Testing the new version';
    if (!(await probeNewVersion(livePanel))) {
      rollbackInstall('the new version failed its start test', fromVersion, tag);
      remove(failedPanel);
      restoreServers();
      throw new Error('the new version failed its start test, the old version is still active');
    }
    try {
      try { fs.unlinkSync(RESULT); } catch (_) {}
      fs.writeFileSync(MARKER, JSON.stringify({ from: fromVersion, to: tag, boots: 0, at: Date.now() }));
    } catch (err) {
      rollbackInstall('the update could not be recorded', fromVersion, tag);
      remove(failedPanel);
      restoreServers();
      throw new Error(`could not record the update, the old version is still active (${err.message})`);
    }
    remove(tmp);
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
