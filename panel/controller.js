// Controller: the actual multi-instance supervisor. Spawns one worker
// process per running instance (each worker is just panel/server.js,
// completely unmodified, with its own MC_SERVER_DIR + PANEL_PORT) so every
// instance gets its own process, own memory, own console, own everything -
// no shared global state between instances, which a single process
// juggling multiple SERVER_DIRs could never give you cleanly.
//
// The controller itself only serves the instance list/creation UI and
// process lifecycle (start/stop/restart a worker). Once an instance is
// running, its full dashboard lives at the worker's own port - the
// controller just links you there.
const workerSecret = require('./lib/worker-secret');
const safeDecode = (s) => { try { return decodeURIComponent(s); } catch (_) { return String(s); } };
const updater = require('./core/modules/updater').createUpdater({
  repo: 'meowmarism-official/meowmarism-lite',
  panelDir: __dirname,
  statePrefix: '.meowmarism',
  probePath: '/auth/status',
  hooks: { stop: stopServersForUpdate, restore: restoreAfterFailedUpdate },
});
try { updater.bootCheck(); } catch (_) {}
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFileSync, execFile } = require('child_process');

const { INSTANCES_FILE } = require('./lib/config');
const launchLib = require('./runtime/launch');
const net = require('net');
const { checkDeletableDir } = require('./core/modules/safety');
const { parseCookies, currentSession, createSession, deleteSession, sessions, SESSION_COOKIE, SESSION_MAX_AGE_MS } = require('./lib/auth');
const { createLoginLimiter } = require('./core/modules/ratelimit');
const loginLimiter = createLoginLimiter();

const DATA_ROOT = process.env.MEOWMARISM_DATA_DIR || path.join(os.homedir(), 'meowmarism');
const INSTANCES_ROOT = path.join(DATA_ROOT, 'instances');
const CONTROLLER_PORT = Number(process.env.CONTROLLER_PORT) || 8090;
const WORKER_PORT_BASE = Number(process.env.WORKER_PORT_BASE) || 9090;

// The controller is the front door - every instance is reachable only
// through it (workers bind to 127.0.0.1 only), so login belongs here, not
// per-instance. A controller account exists independently of any instance.
const CONTROLLER_USERS_FILE = path.join(os.homedir(), '.meowmarism-controller-users.json');
const { createUserStore, effectiveCaps, hasPanelCap } = require('./lib/db');
const { createUsersApi } = require('./core/modules/users-api');
const { createPanelSettings } = require('./core/modules/panel-settings');
const systemInfo = require('./core/modules/system-info');
const controllerUsers = createUserStore(CONTROLLER_USERS_FILE);
const usersApi = createUsersApi({ store: controllerUsers, session: (req) => currentSession(req), revokeSessions: (u) => require('./lib/auth').revokeUser(u) });

// Always looked up fresh (never cached on the session) so a permission
// change applies on the user's very next request.
function sessionUser(req) {
  const s = currentSession(req);
  return s ? controllerUsers.findUser(s.username) : null;
}
function capsFor(req, instanceName) { return effectiveCaps(sessionUser(req), instanceName); }
function canPanel(req, cap) { return hasPanelCap(sessionUser(req), cap); }

const NEOFORGE_MAVEN_METADATA = 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml';
const FORGE_MAVEN_METADATA = 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml';
const MOJANG_VERSION_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const FABRIC_GAME_VERSIONS = 'https://meta.fabricmc.net/v2/versions/game';
const FABRIC_LOADER_VERSIONS = 'https://meta.fabricmc.net/v2/versions/loader';

function httpsGetText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 10000, headers: { 'User-Agent': 'meowmarism-controller' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { resolve(httpsGetText(res.headers.location)); return; }
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); res.resume(); return; }
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(data));
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const doGet = (u) => {
      https.get(u, { timeout: 30000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { doGet(res.headers.location); return; }
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode} for ${u}`)); res.resume(); return; }
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve()));
        out.on('error', reject);
      }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
    };
    doGet(url);
  });
}
function compareSemver(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d !== 0) return d; }
  return 0;
}

function loadInstances() {
  try { return JSON.parse(fs.readFileSync(INSTANCES_FILE, 'utf8')); }
  catch (_) { return []; }
}
function saveInstances(list) {
  try { fs.writeFileSync(INSTANCES_FILE, JSON.stringify(list, null, 2)); } catch (_) {}
}
function nextFreePort(instances) {
  const used = new Set(instances.map((i) => i.panelPort).filter(Boolean));
  let p = WORKER_PORT_BASE;
  while (used.has(p)) p++;
  return p;
}

const PAPER_PROJECT = 'https://fill.papermc.io/v3/projects/paper';
const PURPUR_PROJECT = 'https://api.purpurmc.org/v2/purpur';
const BUILD_LOADERS = ['vanilla', 'paper', 'purpur'];

async function listLoaderVersions(loader, mcFilter) {
  if (loader === 'paper' || loader === 'purpur') {
    let versions;
    if (loader === 'paper') {
      const groups = JSON.parse(await httpsGetText(PAPER_PROJECT)).versions;
      versions = Object.values(groups).flat();
    } else {
      versions = JSON.parse(await httpsGetText(PURPUR_PROJECT)).versions;
    }
    versions = versions.filter((v) => /^\d+\.\d+(\.\d+)?$/.test(v)).sort((a, b) => compareSemver(b, a));
    if (mcFilter) return versions.includes(mcFilter) ? [mcFilter] : [];
    return { mcVersions: versions, grouped: Object.fromEntries(versions.map((v) => [v, [v]])) };
  }
  if (loader === 'vanilla') {
    const manifest = JSON.parse(await httpsGetText(MOJANG_VERSION_MANIFEST));
    const releases = manifest.versions.filter((v) => v.type === 'release').map((v) => v.id);
    if (mcFilter) return releases.includes(mcFilter) ? [mcFilter] : [];
    return { mcVersions: releases, grouped: Object.fromEntries(releases.map((v) => [v, [v]])) };
  }
  if (loader === 'fabric') {
    const games = JSON.parse(await httpsGetText(FABRIC_GAME_VERSIONS)).filter((g) => g.stable).map((g) => g.version);
    if (mcFilter) {
      if (!games.includes(mcFilter)) return [];
      return JSON.parse(await httpsGetText(FABRIC_LOADER_VERSIONS)).filter((l) => l.stable).map((l) => l.version);
    }
    return { mcVersions: games, grouped: Object.fromEntries(games.map((v) => [v, ['(pick a version)']])) };
  }
  if (loader === 'forge') {
    const xml = await httpsGetText(FORGE_MAVEN_METADATA);
    const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
    const grouped = {};
    for (const v of versions) {
      const idx = v.indexOf('-');
      if (idx === -1) continue;
      (grouped[v.slice(0, idx)] = grouped[v.slice(0, idx)] || []).push(v.slice(idx + 1));
    }
    if (mcFilter) return (grouped[mcFilter] || []).slice().reverse();
    return { mcVersions: Object.keys(grouped).sort((a, b) => compareSemver(b, a)), grouped };
  }
  const xml = await httpsGetText(NEOFORGE_MAVEN_METADATA);
  const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]).reverse();
  const grouped = {};
  for (const v of versions) {
    const m = v.match(/^(\d+)\.(\d+)\./);
    if (!m) continue;
    const mc = m[2] === '0' ? `1.${m[1]}` : `1.${m[1]}.${m[2]}`;
    (grouped[mc] = grouped[mc] || []).push(v);
  }
  if (mcFilter) return grouped[mcFilter] || [];
  return { mcVersions: Object.keys(grouped).sort((a, b) => compareSemver(b, a)), grouped };
}

async function installNeoForgeLike(mavenBase, groupPath, artifactId, version, dir, log, javaBin) {
  const installerUrl = `${mavenBase}/${groupPath}/${artifactId}/${version}/${artifactId}-${version}-installer.jar`;
  const installerPath = path.join(dir, 'installer.jar');
  log('downloading installer');
  await downloadFile(installerUrl, installerPath);
  log('running installer');
  await new Promise((resolve, reject) => {
    const proc = spawn(javaBin || 'java', ['-jar', installerPath, '--installServer'], { cwd: dir });
    proc.stdout.on('data', (d) => log(d.toString().trim()));
    proc.stderr.on('data', (d) => log(d.toString().trim()));
    proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`installer exited with code ${code}`))));
    proc.on('error', reject);
  });
}
function writeJvmArgs(dir, ramMB) {
  if (ramMB == null) return;
  const max = Math.max(512, Math.round(ramMB));
  const min = Math.max(512, Math.round(max / 2));
  fs.writeFileSync(path.join(dir, 'user_jvm_args.txt'), `-Xms${min}M\n-Xmx${max}M\n`);
}
async function installVanilla(mcVersion, dir, ramMB, log) {
  log('looking up version manifest');
  const manifest = JSON.parse(await httpsGetText(MOJANG_VERSION_MANIFEST));
  const entry = manifest.versions.find((v) => v.id === mcVersion);
  if (!entry) throw new Error(`unknown Minecraft version ${mcVersion}`);
  const versionMeta = JSON.parse(await httpsGetText(entry.url));
  const serverUrl = versionMeta.downloads && versionMeta.downloads.server && versionMeta.downloads.server.url;
  if (!serverUrl) throw new Error(`no server download for ${mcVersion}`);
  log('downloading server.jar');
  await downloadFile(serverUrl, path.join(dir, 'server.jar'));
  fs.writeFileSync(path.join(dir, 'run.sh'), '#!/usr/bin/env sh\njava @user_jvm_args.txt -jar server.jar "$@"\n', { mode: 0o755 });
  writeJvmArgs(dir, ramMB);
}
async function installFabric(mcVersion, loaderVersion, dir, ramMB, log) {
  log('resolving fabric installer version');
  const installers = JSON.parse(await httpsGetText('https://meta.fabricmc.net/v2/versions/installer')).filter((i) => i.stable);
  if (!installers.length) throw new Error('no stable fabric installer version found');
  // loaderVersion is whatever the user actually picked in the UI - using
  // installers[0] (latest) here too, never the picked loader, silently
  // installed the newest loader regardless of what the registry then
  // claimed was chosen.
  const jarUrl = `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/${loaderVersion}/${installers[0].version}/server/jar`;
  log(`downloading fabric server jar (loader ${loaderVersion})`);
  await downloadFile(jarUrl, path.join(dir, 'fabric-server-launch.jar'));
  fs.writeFileSync(path.join(dir, 'run.sh'), '#!/usr/bin/env sh\njava @user_jvm_args.txt -jar fabric-server-launch.jar "$@"\n', { mode: 0o755 });
  writeJvmArgs(dir, ramMB);
}
async function installPaperLike(loader, mcVersion, dir, ramMB, log) {
  let url;
  let build;
  if (loader === 'paper') {
    log('looking up the latest Paper build');
    const latest = JSON.parse(await httpsGetText(`${PAPER_PROJECT}/versions/${mcVersion}/builds/latest`));
    const dl = latest.downloads && latest.downloads['server:default'];
    if (!dl) throw new Error(`no Paper build for ${mcVersion}`);
    url = dl.url;
    build = String(latest.id);
  } else {
    log('looking up the latest Purpur build');
    const info = JSON.parse(await httpsGetText(`${PURPUR_PROJECT}/${mcVersion}`));
    build = info.builds && info.builds.latest;
    if (!build) throw new Error(`no Purpur build for ${mcVersion}`);
    url = `${PURPUR_PROJECT}/${mcVersion}/${build}/download`;
  }
  log(`downloading ${loader} build ${build}`);
  await downloadFile(url, path.join(dir, 'server.jar'));
  fs.writeFileSync(path.join(dir, 'run.sh'), '#!/usr/bin/env sh\njava @user_jvm_args.txt -jar server.jar "$@"\n', { mode: 0o755 });
  writeJvmArgs(dir, ramMB);
  return build;
}
const SNAPSHOT_FILES = ['run.sh', 'run.bat', 'user_jvm_args.txt', 'server.jar', 'fabric-server-launch.jar', 'args_extra.txt'];
const upgrades = new Map();

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '0.0.0.0');
  });
}
// First port at or above `start` that no instance uses and nothing listens on.
async function findFreePort(start, instances) {
  const taken = new Set(instances.map((i) => i.port));
  for (let p = Math.max(1024, start); p <= Math.min(65535, start + 500); p++) {
    if (!taken.has(p) && await isPortFree(p)) return p;
  }
  throw new Error('no free port found');
}
const javaJobs = new Map();

// Uses the system Java when it is new enough, otherwise installs the needed one into the data folder.
async function ensureJava(mcVersion, log) {
  const need = launchLib.requiredJavaMajor(mcVersion);
  if (!need) return '';
  const have = launchLib.javaMajor();
  if (have != null && have >= need) return '';
  log(`Minecraft ${mcVersion} needs Java ${need}, this host has ${have == null ? 'none' : `Java ${have}`}`);
  return installJava(need, log);
}

// Downloads a Temurin JRE into <data>/java/<major> unless it is already there.
async function installJava(major, log) {
  const dest = path.join(DATA_ROOT, 'java', String(major));
  const bin = path.join(dest, 'bin', 'java');
  if (fs.existsSync(bin) && launchLib.javaMajor(bin) === major) { log(`Java ${major} is already installed`); return bin; }
  if (process.platform !== 'linux') throw new Error('automatic Java installation is only available on Linux');
  const arch = { x64: 'x64', arm64: 'aarch64' }[os.arch()];
  if (!arch) throw new Error(`unsupported CPU architecture ${os.arch()}`);
  fs.mkdirSync(dest, { recursive: true });
  const tarball = path.join(dest, 'jre.tar.gz');
  log(`downloading Java ${major} (Temurin)`);
  await downloadFile(`https://api.adoptium.net/v3/binary/latest/${major}/ga/linux/${arch}/jre/hotspot/normal/eclipse`, tarball);
  log('unpacking');
  await new Promise((resolve, reject) => {
    const p = spawn('tar', ['-xzf', tarball, '-C', dest, '--strip-components=1']);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('could not unpack Java'))));
    p.on('error', reject);
  });
  fs.rmSync(tarball, { force: true });
  if (launchLib.javaMajor(bin) !== major) throw new Error('the downloaded Java does not run on this host');
  return bin;
}

function workerJson(port, p, method = 'GET', timeoutMs = 10000, jsonBody = null) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, timeout: timeoutMs, headers: jsonBody ? { 'Content-Type': 'application/json', [workerSecret.HEADER]: workerSecret.get() } : { [workerSecret.HEADER]: workerSecret.get() } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }); } catch (_) { resolve({ status: res.statusCode, body: {} }); } });
    });
    req.on('error', (err) => resolve({ status: 0, body: { ok: false, error: err.message } }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: { ok: false, error: 'timed out' } }); });
    req.end(jsonBody ? JSON.stringify(jsonBody) : undefined);
  });
}

function readLatestUpgrade(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, '.upgrade', 'latest.json'), 'utf8')); } catch (_) { return null; }
}

async function restartWorkerFor(inst) {
  const w = workers.get(inst.id);
  if (w) await new Promise((resolve) => { const t = setTimeout(resolve, 15000); w.proc.once('exit', () => { clearTimeout(t); resolve(); }); w.proc.kill('SIGTERM'); });
  const fresh = loadInstances().find((i) => i.id === inst.id);
  if (fresh) startWorker(fresh);
}

function setInstanceVersions(inst, mcVersion, loaderVersion) {
  const list = loadInstances();
  const cur = list.find((i) => i.id === inst.id);
  if (cur) { cur.mcVersion = mcVersion; cur.loaderVersion = loaderVersion; saveInstances(list); }
}

async function runUpgrade(inst, target, log) {
  const from = { mcVersion: inst.mcVersion, loaderVersion: inst.loaderVersion || '' };
  log('taking a world backup first');
  const backup = await workerJson(inst.panelPort, '/api/backup-sync', 'POST', 30 * 60 * 1000);
  if (!backup.body.ok) throw new Error(`backup failed, nothing was changed (${backup.body.error || 'unknown error'})`);
  log(backup.body.name ? `backup done: ${backup.body.name}` : 'no world yet, nothing to back up');

  const stamp = String(Date.now());
  const snapDir = path.join(inst.dir, '.upgrade', stamp);
  fs.mkdirSync(snapDir, { recursive: true });
  for (const f of SNAPSHOT_FILES) if (fs.existsSync(path.join(inst.dir, f))) fs.copyFileSync(path.join(inst.dir, f), path.join(snapDir, f));
  log('saved the current launch files');

  const javaBin = await ensureJava(target.mcVersion, log);
  if (javaBin) {
    const r = await workerJson(inst.panelPort, '/api/config', 'POST', 10000, { javaPath: javaBin });
    if (!r.body.ok) throw new Error(r.body.error || 'could not save the Java path');
  }
  const built = await installServerSoftware(inst.loader, target.mcVersion, target.loaderVersion, null, inst.dir, log, javaBin);
  if (fs.existsSync(path.join(snapDir, 'user_jvm_args.txt'))) fs.copyFileSync(path.join(snapDir, 'user_jvm_args.txt'), path.join(inst.dir, 'user_jvm_args.txt'));
  const newLoaderVersion = built || target.loaderVersion || '';
  setInstanceVersions(inst, target.mcVersion, newLoaderVersion);
  fs.writeFileSync(path.join(inst.dir, '.upgrade', 'latest.json'), JSON.stringify({ at: Date.now(), snapshot: stamp, from, to: { mcVersion: target.mcVersion, loaderVersion: newLoaderVersion }, backup: backup.body.name || null, rolledBack: false }, null, 2));
  const snaps = fs.readdirSync(path.join(inst.dir, '.upgrade')).filter((n) => /^\d+$/.test(n)).sort();
  for (const old of snaps.slice(0, Math.max(0, snaps.length - 3))) fs.rmSync(path.join(inst.dir, '.upgrade', old), { recursive: true, force: true });
  log('restarting the panel of this instance');
  await restartWorkerFor(inst);
}

async function runRollback(inst, restoreWorld, log) {
  const latest = readLatestUpgrade(inst.dir);
  if (!latest || latest.rolledBack) throw new Error('nothing to roll back');
  const snapDir = path.join(inst.dir, '.upgrade', latest.snapshot);
  if (!fs.existsSync(snapDir)) throw new Error('the saved launch files are gone');
  for (const f of SNAPSHOT_FILES) if (fs.existsSync(path.join(snapDir, f))) fs.copyFileSync(path.join(snapDir, f), path.join(inst.dir, f));
  log(`restored the launch files of ${latest.from.mcVersion}`);
  if (restoreWorld && latest.backup) {
    log('restoring the world from the backup taken before the upgrade');
    const r = await workerJson(inst.panelPort, `/api/restore-sync?name=${encodeURIComponent(latest.backup)}`, 'POST', 30 * 60 * 1000);
    if (!r.body.ok) throw new Error(`the world restore failed (${r.body.error || 'unknown error'})`);
  }
  setInstanceVersions(inst, latest.from.mcVersion, latest.from.loaderVersion);
  latest.rolledBack = true;
  fs.writeFileSync(path.join(inst.dir, '.upgrade', 'latest.json'), JSON.stringify(latest, null, 2));
  await restartWorkerFor(inst);
}

async function installServerSoftware(loader, mcVersion, loaderVersion, ramMB, dir, log, javaBin) {
  fs.mkdirSync(dir, { recursive: true });
  if (loader === 'paper' || loader === 'purpur') return installPaperLike(loader, mcVersion, dir, ramMB, log);
  if (loader === 'vanilla') { await installVanilla(mcVersion, dir, ramMB, log); return; }
  if (loader === 'fabric') { await installFabric(mcVersion, loaderVersion, dir, ramMB, log); return; }
  if (loader === 'forge') await installNeoForgeLike('https://maven.minecraftforge.net', 'net/minecraftforge', 'forge', `${mcVersion}-${loaderVersion}`, dir, log, javaBin);
  else await installNeoForgeLike('https://maven.neoforged.net/releases', 'net/neoforged', 'neoforge', loaderVersion, dir, log, javaBin);
  // The NeoForge/Forge installer writes its own user_jvm_args.txt with fixed
  // defaults - override it with what was actually picked in the wizard.
  writeJvmArgs(dir, ramMB);
}

// --- Worker process lifecycle ---
const workers = new Map(); // instanceId -> { proc, port, logs: [] }
const panelCrashes = new Map(); // instanceId -> { code, signal, at, logs } - last time the worker process itself died on/right after start
let instanceCreateInProgress = false;
const RESTART_FILE = path.join(os.homedir(), '.meowmarism-restart.json');
const panelSettings = createPanelSettings({ file: path.join(os.homedir(), '.meowmarism-controller-settings.json') });
const { load: loadSettings, save: saveSettings, clientIp, isHttps } = panelSettings;
function instanceAutoStarts(inst) {
  try { return JSON.parse(fs.readFileSync(path.join(inst.dir, 'panel-config.json'), 'utf8')).autoStart === true; }
  catch (_) { return false; }
}
async function runningInstanceNames() {
  const names = [];
  for (const inst of loadInstances()) {
    const st = workers.has(inst.id) ? await fetchWorkerStatus(inst.panelPort) : null;
    if (st && st.running) names.push(inst.name);
  }
  return names;
}

// Update hooks: servers are stopped before the panel files are swapped and started again if the swap fails.
async function stopServersForUpdate() {
  const running = await runningInstanceNames();
  fs.writeFileSync(RESTART_FILE, JSON.stringify(running));
  for (const inst of loadInstances()) if (running.includes(inst.name)) await workerAction(inst.panelPort, '/stop');
  const stopDeadline = Date.now() + 3 * 60 * 1000;
  while (Date.now() < stopDeadline && (await runningInstanceNames()).length) await new Promise((r) => setTimeout(r, 1500));
  await Promise.all([...workers.values()].map((w) => new Promise((resolve) => {
    const t = setTimeout(resolve, 45000);
    w.proc.once('exit', () => { clearTimeout(t); resolve(); });
    w.proc.kill('SIGTERM');
  })));
  return running;
}
function restoreAfterFailedUpdate(running) {
  for (const inst of loadInstances()) startWorker(inst);
  setTimeout(() => { for (const inst of loadInstances()) if (running.includes(inst.name)) workerAction(inst.panelPort, '/start'); }, 3000);
  try { fs.unlinkSync(RESTART_FILE); } catch (_) {}
}

// Live view of the instance currently being created, so the wizard can show
// a console + rough progress bar instead of just a "creating..." string.
// Only one creation runs at a time (gated by instanceCreateInProgress), so a
// single slot is enough.
let creationLog = null;
function pushCreateLog(line) {
  if (!creationLog) return;
  creationLog.lines.push(line);
  if (creationLog.lines.length > 300) creationLog.lines.shift();
  const l = line.toLowerCase();
  if (l.includes('looking up') || l.includes('resolving')) creationLog.progress = Math.max(creationLog.progress, 12);
  else if (l.includes('downloading')) creationLog.progress = Math.max(creationLog.progress, 35);
  else if (l.includes('running installer')) creationLog.progress = Math.max(creationLog.progress, 70);
  else creationLog.progress = Math.min(90, creationLog.progress + 1);
}

function startWorker(inst) {
  if (workers.has(inst.id)) return;
  const logs = [];
  const proc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: path.join(__dirname),
    env: { ...process.env, MC_SERVER_DIR: inst.dir, PANEL_PORT: String(inst.panelPort), MEOW_LOADER: inst.loader || '', MEOW_MC_VERSION: inst.mcVersion || '' },
  });
  const pushLog = (line) => { logs.push(line); if (logs.length > 500) logs.shift(); };
  proc.stdout.on('data', (d) => d.toString().split(/\r?\n/).forEach((l) => l && pushLog(l)));
  proc.stderr.on('data', (d) => d.toString().split(/\r?\n/).forEach((l) => l && pushLog(`[stderr] ${l}`)));
  proc.on('exit', (code, signal) => {
    workers.delete(inst.id);
    // A crash on start (bad install, missing file, port already in use) used
    // to just vanish - the panel process disappears from `workers` the same
    // instant its exit handler runs, taking its logs with it, so there was
    // no way to see why. Stash the tail so the instance list can surface it.
    if (code !== 0 && code !== null) panelCrashes.set(inst.id, { code, signal, at: Date.now(), logs: logs.slice(-50) });
    else panelCrashes.delete(inst.id);
  });
  workers.set(inst.id, { proc, port: inst.panelPort, logs });
  panelCrashes.delete(inst.id);
}
function stopWorker(id) {
  const w = workers.get(id);
  if (!w) return false;
  w.proc.kill('SIGTERM'); // worker's own SIGTERM handler stops its Minecraft child first
  return true;
}

// The worker's own panel process and the Minecraft server it manages are two
// separate things - the panel comes up as soon as the instance exists so you
// can always open its dashboard, while the Minecraft server itself is
// started/stopped independently through the worker's own HTTP API. This is
// what lets an instance be opened/inspected even while its game server is
// stopped.
function workerAction(port, actionPath) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: actionPath, method: 'POST', timeout: 5000, headers: { [workerSecret.HEADER]: workerSecret.get() } }, (res) => {
      res.resume();
      resolve(res.statusCode < 400);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

// Reverse-proxies a request straight through to a worker on 127.0.0.1, so
// every instance is reachable from a single external port instead of one
// port per instance. Streams both ways (works for the worker's SSE feed,
// not just plain request/response) and forwards the method/headers/body
// as-is - the worker itself doesn't need to know it's behind a prefix.
function proxyToWorker(req, res, port, targetPath, caps) {
  const upstream = http.request({
    host: '127.0.0.1', port, method: req.method, path: targetPath,
    headers: { ...req.headers, 'x-forwarded-host': req.headers.host || '', 'x-forwarded-proto': 'https', 'x-meow-caps': caps.join(','), [workerSecret.HEADER]: workerSecret.get() },
  }, (upRes) => {
    res.writeHead(upRes.statusCode, upRes.headers);
    upRes.pipe(res);
  });
  upstream.on('error', () => { if (!res.headersSent) sendJson(res, 502, { ok: false, error: 'instance panel is not reachable' }); else res.end(); });
  req.pipe(upstream);
}

// Requests for an instance's own dashboard/API come in two shapes: the
// initial navigation, which is prefixed (/instance/<id>/...), and every
// absolute-path fetch()/asset/SSE request the worker's own frontend makes
// after that (e.g. /api/mods), which isn't prefixed at all because the
// worker has no idea it's being proxied under a subpath. Those are matched
// by Referer instead, which the browser sets to the /instance/<id>/ page
// that triggered them.
function resolveInstanceProxy(req, url) {
  const prefixed = url.pathname.match(/^\/instance\/([^/]+)(\/.*)?$/);
  if (prefixed) return { name: safeDecode(prefixed[1]), targetPath: (prefixed[2] || '/') + url.search };
  const isNavigation = req.headers['sec-fetch-mode'] === 'navigate' || (req.headers.accept || '').includes('text/html');
  const ref = req.headers.referer;
  if (!ref || isNavigation) return null;
  try {
    const refUrl = new URL(ref);
    const m = refUrl.pathname.match(/^\/instance\/([^/]+)\//);
    if (!m) return null;
    return { name: safeDecode(m[1]), targetPath: url.pathname + url.search };
  } catch (_) { return null; }
}

// Cheap per-instance health check: ask the worker's own /status for the
// stats it already tracks (cpu/mem/phase/crash), rather than re-deriving
// process resource usage in the controller. A worker that doesn't answer in
// time (still booting, wedged) just reports as unknown - never blocks the
// instance list.
function fetchWorkerStatus(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/status', timeout: 2500, headers: { [workerSecret.HEADER]: workerSecret.get() } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (_) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (_) { res.writeHead(400); res.end('bad request'); return; }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // /_meta/... reaches controller routes from an instance page without the Referer-based worker proxy.
  const isMeta = url.pathname.startsWith('/_meta/');
  if (isMeta) url.pathname = url.pathname.slice('/_meta'.length);
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=15552000');

  if (url.pathname === '/auth/login' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1024) req.destroy(); });
    req.on('end', () => {
      let data;
      try { data = JSON.parse(body || '{}'); } catch (_) { sendJson(res, 400, { error: 'invalid request' }); return; }
      const username = String(data.username || '');
      const password = String(data.password || '');
      const remember = !!data.remember;
      const ip = clientIp(req);
      const gate = loginLimiter.check(ip, username);
      if (!gate.allowed) {
        res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': String(gate.retryAfterSec), 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: `too many attempts, try again in ${gate.retryAfterSec} s` }));
        return;
      }
      if (!controllerUsers.verifyUser(username, password)) {
        loginLimiter.fail(ip, username);
        sendJson(res, 401, { error: 'wrong username or password' });
        return;
      }
      loginLimiter.success(ip, username);
      const token = createSession(username, controllerUsers.findUser(username)?.role);
      // Without "remember me" the cookie has no Max-Age, so it's a
      // session-only cookie the browser drops on close.
      const maxAge = remember ? `; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}` : '';
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax${isHttps(req) ? '; Secure' : ''}${maxAge}`,
      });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  if (url.pathname === '/auth/logout' && req.method === 'GET') {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token) deleteSession(token);
    res.writeHead(302, { 'Set-Cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax${isHttps(req) ? '; Secure' : ''}; Max-Age=0`, Location: '/' });
    res.end();
    return;
  }

  if (url.pathname === '/auth/status' && req.method === 'GET') {
    const s = currentSession(req);
    const u = s ? controllerUsers.findUser(s.username) : null;
    sendJson(res, 200, {
      loggedIn: !!s, username: s?.username || null, role: s?.role || null, authEnabled: controllerUsers.hasAnyUser(),
      panel: u ? Object.fromEntries(['users', 'create', 'update'].map((c) => [c, hasPanelCap(u, c)])) : {},
    });
    return;
  }

  // Bootstraps the one owner account - only works before an owner exists.
  // This is what install.sh calls during first-time setup; once an owner
  // is set, this route refuses (there is no "reclaim ownership" from the
  // web UI - reinstalling is the reset path, matching the security intent).
  if (url.pathname === '/api/auth/credentials' && req.method === 'POST') {
    if (controllerUsers.hasOwner()) { sendJson(res, 403, { error: 'an owner account already exists' }); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1024) req.destroy(); });
    req.on('end', () => {
      let data;
      try { data = JSON.parse(body || '{}'); } catch (_) { sendJson(res, 400, { error: 'invalid request' }); return; }
      const username = String(data.username || '').trim();
      const password = String(data.password || '');
      if (!username || username.length < 3) { sendJson(res, 400, { error: 'username must be at least 3 characters' }); return; }
      if (!password || password.length < 8) { sendJson(res, 400, { error: 'password must be at least 8 characters' }); return; }
      if (!controllerUsers.upsertOwner(username, password)) { sendJson(res, 403, { error: 'an owner account already exists' }); return; }
      sendJson(res, 200, { ok: true });
    });
    return;
  }


  const langMatch = req.method === 'GET' && url.pathname.match(/^\/lang\/(de|fr|es)\.json$/);
  if (langMatch) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(fs.readFileSync(path.join(__dirname, 'core', 'lang', langMatch[1] + '.json')));
    return;
  }

  const coreMatch = req.method === 'GET' && url.pathname.match(/^\/core\/(tokens\/tokens\.css|brand\/[\w.-]+\.(?:svg|png)|ui\/[\w.-]+\.(?:js|css))$/);
  if (coreMatch) {
    const file = path.join(__dirname, 'core', coreMatch[1]);
    if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    const types = { css: 'text/css; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', js: 'application/javascript; charset=utf-8' };
    res.writeHead(200, { 'Content-Type': types[path.extname(file).slice(1)], 'Cache-Control': 'public, max-age=3600' });
    fs.createReadStream(file).pipe(res);
    return;
  }

  if (url.pathname === '/i18n.js' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(fs.readFileSync(path.join(__dirname, 'core', 'ui', 'i18n.js')));
    return;
  }

  // Everything past this point - the instance list, instance creation, and
  // every proxied /instance/:id/* request - requires a controller session
  // once an account exists. Nothing is reachable without logging in first.
  if (controllerUsers.hasAnyUser() && !currentSession(req)) {
    const wantsHtml = req.method === 'GET' && (req.headers.accept || '').includes('text/html');
    if (wantsHtml) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(path.join(__dirname, 'login.html')));
    } else {
      sendJson(res, 401, { ok: false, error: 'not authenticated' });
    }
    return;
  }

  if (url.pathname === '/api/update' && req.method === 'POST') {
    if (!canPanel(req, 'update')) { sendJson(res, 403, { error: 'not allowed to update' }); return; }
    if (!updater.start()) { sendJson(res, 409, { error: 'an update is already running' }); return; }
    sendJson(res, 202, { ok: true });
    return;
  }
  if (url.pathname === '/api/update-status' && req.method === 'GET') {
    sendJson(res, 200, updater.status());
    return;
  }

  if ((url.pathname === '/api/version' || url.pathname === '/_meta/version') && req.method === 'GET') {
    const info = await updater.versionInfo(url.searchParams.get('refresh') === '1');
    sendJson(res, 200, { ...info, canUpdate: canPanel(req, 'update'), running: await runningInstanceNames() });
    return;
  }

  if (url.pathname === '/api/system-info' && req.method === 'GET') {
    if (!canPanel(req, 'users')) { sendJson(res, 403, { error: 'not allowed' }); return; }
    sendJson(res, 200, systemInfo.collect({ dir: __dirname }));
    return;
  }

  if (url.pathname === '/api/settings' && req.method === 'GET') {
    if (!canPanel(req, 'users')) { sendJson(res, 403, { error: 'not allowed to change settings' }); return; }
    sendJson(res, 200, loadSettings());
    return;
  }
  if (url.pathname === '/api/settings' && req.method === 'POST') {
    if (!canPanel(req, 'users')) { sendJson(res, 403, { error: 'not allowed to change settings' }); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let data;
      try { data = JSON.parse(body || '{}'); } catch (_) { sendJson(res, 400, { error: 'bad json' }); return; }
      const next = loadSettings();
      if (typeof data.trustProxy === 'boolean') next.trustProxy = data.trustProxy;
      saveSettings(next);
      sendJson(res, 200, next);
    });
    return;
  }

  if (usersApi.handle(req, res, url)) return;

  const proxyTarget = isMeta ? null : resolveInstanceProxy(req, url);
  if (proxyTarget) {
    const inst = loadInstances().find((i) => i.name === proxyTarget.name);
    if (!inst) { sendJson(res, 404, { ok: false, error: 'no such instance' }); return; }
    const caps = capsFor(req, inst.name);
    if (!caps.includes('view')) { sendJson(res, 403, { ok: false, error: 'no access to this instance' }); return; }
    if (!workers.has(inst.id)) { sendJson(res, 502, { ok: false, error: 'this instance\'s panel is not running' }); return; }
    proxyToWorker(req, res, inst.panelPort, proxyTarget.targetPath, caps);
    return;
  }

  if (['/', '/server', '/users', '/update', '/settings', '/system'].includes(url.pathname) && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'controller.html')));
    return;
  }

  if (url.pathname === '/api/instances' && req.method === 'GET') {
    const base = loadInstances()
      .map((i) => ({ ...i, panelUp: workers.has(i.id), caps: capsFor(req, i.name) }))
      .filter((i) => i.caps.includes('view'));
    Promise.all(base.map(async (i) => {
      if (!i.panelUp) {
        const panelCrash = panelCrashes.get(i.id);
        if (panelCrash) return { ...i, running: false, health: 'error', crash: { reason: `panel process exited (code ${panelCrash.code}${panelCrash.signal ? `, ${panelCrash.signal}` : ''})`, at: panelCrash.at, tail: panelCrash.logs } };
        return { ...i, running: false, health: 'panel-off' };
      }
      const status = await fetchWorkerStatus(i.panelPort);
      if (!status) return { ...i, running: false, health: 'starting' };
      // lastCrash on the worker is sticky history, not current state - only
      // treat it as an error while the server is actually down because of it.
      const erroredOut = !status.running && status.crash && (!status.lastExitAt || status.crash.at === status.lastExitAt);
      return {
        ...i,
        running: !!status.running,
        health: erroredOut ? 'error' : (status.running ? (status.phase || 'running') : 'stopped'),
        cpuPercent: status.stats?.server?.cpuPercent ?? null,
        rssMB: status.stats?.server?.rssMB ?? null,
        crash: erroredOut ? status.crash : null,
      };
    })).then((list) => sendJson(res, 200, { instances: list, createInProgress: instanceCreateInProgress, canCreate: canPanel(req, 'create'), hostMemMB: Math.round(os.totalmem() / 1048576) }));
    return;
  }

  if (url.pathname === '/api/create-log' && req.method === 'GET') {
    sendJson(res, 200, creationLog || { done: true, lines: [], progress: 0 });
    return;
  }

  if (url.pathname === '/api/free-port' && req.method === 'GET') {
    const start = Number(url.searchParams.get('start')) || 25565;
    findFreePort(start, loadInstances()).then((port) => sendJson(res, 200, { port, requested: start, taken: port !== start }))
      .catch((err) => sendJson(res, 500, { ok: false, error: err.message }));
    return;
  }
  if (url.pathname === '/api/loader-versions' && req.method === 'GET') {
    listLoaderVersions(String(url.searchParams.get('loader') || 'neoforge'), url.searchParams.get('mc'))
      .then((data) => sendJson(res, 200, data)).catch((err) => sendJson(res, 502, { ok: false, error: err.message }));
    return;
  }

  if (url.pathname === '/api/instances' && req.method === 'POST') {
    if (!canPanel(req, 'create')) { sendJson(res, 403, { ok: false, error: 'not allowed to create instances' }); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', async () => {
      if (instanceCreateInProgress) { sendJson(res, 409, { ok: false, error: 'another instance is already being created' }); return; }
      instanceCreateInProgress = true;
      try {
        const data = JSON.parse(body || '{}');
        const rawName = String(data.name || '').trim().replace(/[^a-zA-Z0-9]/g, '');
        const loader = ['vanilla', 'paper', 'purpur', 'fabric', 'forge', 'neoforge'].includes(data.loader) ? data.loader : 'vanilla';
        const mcVersion = String(data.mcVersion || '').trim();
        const loaderVersion = String(data.loaderVersion || '').trim();
        let mcPort = Number(data.port);
        const ramMB = Math.min(32768, Math.max(1024, Number(data.ramMB) || 4096));
        const backupIntervalHours = Math.min(168, Math.max(1, Number(data.backupIntervalHours) || 6));
        const maxBackups = Math.min(100, Math.max(1, Number(data.maxBackups) || 10));
        if (!rawName) throw new Error('invalid instance name');
        if (!mcVersion) throw new Error('invalid Minecraft version');
        if (!BUILD_LOADERS.includes(loader) && !loaderVersion) throw new Error('invalid loader version');
        if (!Number.isInteger(mcPort) || mcPort < 1 || mcPort > 65535) throw new Error('invalid port');
        const instances = loadInstances();
        const requestedPort = mcPort;
        mcPort = await findFreePort(mcPort, instances);
        // A name collision gets a numeric suffix (name02, name03, ...)
        // instead of failing outright - the first instance with that name
        // keeps the bare name.
        let name = rawName;
        if (instances.some((i) => i.name === name)) {
          let n = 2;
          while (instances.some((i) => i.name === `${rawName}${String(n).padStart(2, '0')}`)) n++;
          name = `${rawName}${String(n).padStart(2, '0')}`;
        }
        const dir = path.join(INSTANCES_ROOT, name);
        fs.mkdirSync(INSTANCES_ROOT, { recursive: true });
        if (fs.existsSync(dir)) throw new Error(`${dir} already exists`);
        instanceCreateInProgress = true;
        creationLog = { name, loader, mcVersion, startedAt: Date.now(), lines: [], progress: 5, done: false, error: null, instanceId: null, panelPort: null };
        sendJson(res, 202, { ok: true });
        try {
          const createLog = (line) => { console.log(`[create:${name}] ${line}`); pushCreateLog(line); };
          if (mcPort !== requestedPort) createLog(`port ${requestedPort} is in use, using ${mcPort} instead`);
          const javaBin = await ensureJava(mcVersion, createLog);
          const builtVersion = await installServerSoftware(loader, mcVersion, loaderVersion, ramMB, dir, createLog, javaBin);
          fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');
          fs.writeFileSync(path.join(dir, 'server.properties'), `server-port=${mcPort}\nmotd=hosted by meowmarism :3\n`);
          try { fs.copyFileSync(path.join(__dirname, 'core', 'brand', 'server-icon.png'), path.join(dir, 'server-icon.png')); } catch (_) {}
          fs.writeFileSync(path.join(dir, 'panel-config.json'), JSON.stringify({ backupIntervalHours, maxBackups, autoStart: data.autoStart === true, ...(javaBin ? { javaPath: javaBin } : {}) }, null, 2));
          const panelPort = nextFreePort(instances);
          const inst = { id: crypto.randomUUID(), name, dir, port: mcPort, panelPort, mcVersion, loader, loaderVersion: builtVersion || loaderVersion, ramMB, createdAt: Date.now() };
          instances.push(inst);
          saveInstances(instances);
          startWorker(inst);
          creationLog.progress = 100;
          creationLog.instanceId = inst.id;
          creationLog.panelPort = inst.panelPort;
        } catch (err) {
          console.error(`[create:${name}] failed: ${err.message}`);
          creationLog.error = err.message;
          if (!instances.some((i) => i.name === name)) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
        } finally {
          instanceCreateInProgress = false;
          creationLog.done = true;
        }
      } catch (err) {
        instanceCreateInProgress = false;
        sendJson(res, 400, { ok: false, error: err.message || 'invalid instance' });
      }
    });
    return;
  }

  // Instances are addressed by name in the API, not their internal id - the
  // id only matters for the workers/panelCrashes maps below.
  const upgradeMatch = url.pathname.match(/^\/api\/instances\/([^/]+)\/(upgrade|upgrade\/rollback|upgrade-status)$/);
  if (upgradeMatch) {
    const inst = loadInstances().find((i) => i.name === safeDecode(upgradeMatch[1]));
    if (!inst) { sendJson(res, 404, { ok: false, error: 'not found' }); return; }
    const caps = capsFor(req, inst.name);
    const state = upgrades.get(inst.name);
    if (upgradeMatch[2] === 'upgrade-status' && req.method === 'GET') {
      if (!caps.includes('view')) { sendJson(res, 403, { ok: false, error: 'not allowed' }); return; }
      sendJson(res, 200, { running: !!(state && state.running), lines: state ? state.lines : [], error: state ? state.error : null, done: !!(state && state.done), kind: state ? state.kind : null, latest: readLatestUpgrade(inst.dir), current: { mcVersion: inst.mcVersion, loader: inst.loader, loaderVersion: inst.loaderVersion || '' } });
      return;
    }
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false }); return; }
    if (!caps.includes('settings') || !caps.includes('files')) { sendJson(res, 403, { ok: false, error: 'upgrading needs the Settings and Files permissions' }); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', async () => {
      let data;
      try { data = JSON.parse(body || '{}'); } catch (_) { sendJson(res, 400, { ok: false, error: 'bad json' }); return; }
      try {
        if (state && state.running) throw Object.assign(new Error('an upgrade is already running for this instance'), { code: 409 });
        if (!workers.has(inst.id)) throw Object.assign(new Error('this instance\'s panel is not running'), { code: 409 });
        const status = await fetchWorkerStatus(inst.panelPort);
        if (status && status.running) throw Object.assign(new Error('stop the Minecraft server first'), { code: 409 });
        const rollback = upgradeMatch[2] === 'upgrade/rollback';
        if (rollback) { const latest = readLatestUpgrade(inst.dir); if (!latest || latest.rolledBack) throw new Error('nothing to roll back'); }
        const target = { mcVersion: String(data.mcVersion || '').trim(), loaderVersion: String(data.loaderVersion || '').trim() };
        if (!rollback) {
          if (!target.mcVersion) throw new Error('pick a Minecraft version');
          if (!BUILD_LOADERS.includes(inst.loader) && !target.loaderVersion) throw new Error('pick a loader version');
          const same = target.mcVersion === inst.mcVersion && (BUILD_LOADERS.includes(inst.loader) || target.loaderVersion === inst.loaderVersion);
          if (same && !(inst.loader === 'paper' || inst.loader === 'purpur')) throw new Error('that is already the installed version');
          if (compareSemver(target.mcVersion, inst.mcVersion) < 0 && data.allowDowngrade !== true) throw new Error('going to an older Minecraft version can damage the world, confirm it explicitly');
          const options = await listLoaderVersions(inst.loader, target.mcVersion);
          if (!Array.isArray(options) || !options.length) throw new Error('that Minecraft version is not available for this loader');
          if (!BUILD_LOADERS.includes(inst.loader) && !options.includes(target.loaderVersion)) throw new Error('that loader version does not exist for this Minecraft version');
        }
        const st = { running: true, done: false, error: null, lines: [], kind: rollback ? 'rollback' : 'upgrade' };
        upgrades.set(inst.name, st);
        const log = (line) => { st.lines.push(line); console.log(`[upgrade:${inst.name}] ${line}`); };
        sendJson(res, 202, { ok: true });
        (rollback ? runRollback(inst, data.restoreWorld === true, log) : runUpgrade(inst, target, log))
          .then(() => log('done'))
          .catch((err) => { st.error = err.message; log(`failed: ${err.message}`); })
          .finally(() => { st.running = false; st.done = true; });
      } catch (err) { sendJson(res, err.code || 400, { ok: false, error: err.message }); }
    });
    return;
  }

  const javaMatch = url.pathname.match(/^\/api\/instances\/([^/]+)\/(java|java-status)$/);
  if (javaMatch) {
    const inst = loadInstances().find((i) => i.name === safeDecode(javaMatch[1]));
    if (!inst) { sendJson(res, 404, { ok: false, error: 'not found' }); return; }
    const caps = capsFor(req, inst.name);
    const job = javaJobs.get(inst.name);
    if (javaMatch[2] === 'java-status' && req.method === 'GET') {
      if (!caps.includes('view')) { sendJson(res, 403, { ok: false, error: 'not allowed' }); return; }
      sendJson(res, 200, { running: !!(job && job.running), done: !!(job && job.done), error: job ? job.error : null, lines: job ? job.lines : [] });
      return;
    }
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false }); return; }
    if (!caps.includes('settings') || !caps.includes('files')) { sendJson(res, 403, { ok: false, error: 'installing Java needs the Settings and Files permissions' }); return; }
    if (job && job.running) { sendJson(res, 409, { ok: false, error: 'Java is already being installed' }); return; }
    const major = launchLib.requiredJavaMajor(inst.mcVersion);
    if (!major) { sendJson(res, 400, { ok: false, error: 'this Minecraft version has no known Java requirement' }); return; }
    if (!workers.has(inst.id)) { sendJson(res, 409, { ok: false, error: 'this instance\'s panel is not running' }); return; }
    const st = { running: true, done: false, error: null, lines: [] };
    javaJobs.set(inst.name, st);
    sendJson(res, 202, { ok: true });
    installJava(major, (line) => st.lines.push(line))
      .then(async (javaPath) => {
        const r = await workerJson(inst.panelPort, '/api/config', 'POST', 10000, { javaPath });
        if (!r.body.ok) throw new Error(r.body.error || 'could not save the Java path');
        st.lines.push('done');
      })
      .catch((err) => { st.error = err.message; st.lines.push(`failed: ${err.message}`); })
      .finally(() => { st.running = false; st.done = true; });
    return;
  }

  const idMatch = url.pathname.match(/^\/api\/instances\/([^/]+)(\/(start|stop|restart))?$/);
  if (idMatch && (req.method === 'POST' || req.method === 'DELETE')) {
    const name = safeDecode(idMatch[1]);
    const action = idMatch[3];
    const instances = loadInstances();
    const inst = instances.find((i) => i.name === name);
    if (!inst) { sendJson(res, 404, { ok: false, error: 'not found' }); return; }
    const id = inst.id;
    const caps = capsFor(req, inst.name);

    if (req.method === 'DELETE') {
      if (!caps.includes('remove')) { sendJson(res, 403, { ok: false, error: 'not allowed to remove this instance' }); return; }
      (async () => {
        const wantFiles = url.searchParams.get('files') === '1';
        const wantBackups = url.searchParams.get('backups') === '1';
        if (workers.has(id)) {
          const status = await fetchWorkerStatus(inst.panelPort);
          if (status?.running) { sendJson(res, 400, { ok: false, error: 'stop the server before deleting the instance' }); return; }
        }
        const backupDir = path.join(DATA_ROOT, 'backups', path.basename(path.resolve(inst.dir)));
        if (wantFiles) {
          const problem = checkDeletableDir(inst.dir, path.resolve(__dirname, '..'), os.homedir());
          if (problem) { sendJson(res, 400, { ok: false, error: problem }); return; }
        }
        const w = workers.get(id);
        if (w) await new Promise((resolve) => { const t = setTimeout(resolve, 15000); w.proc.once('exit', () => { clearTimeout(t); resolve(); }); w.proc.kill('SIGTERM'); });
        saveInstances(instances.filter((i) => i.id !== id));
        try {
          if (wantFiles) fs.rmSync(inst.dir, { recursive: true, force: true });
          if (wantFiles && wantBackups && backupDir.startsWith(path.join(DATA_ROOT, 'backups') + path.sep)) fs.rmSync(backupDir, { recursive: true, force: true });
        } catch (err) { sendJson(res, 500, { ok: false, error: `removed from the panel, but deleting the files failed: ${err.message}` }); return; }
        sendJson(res, 200, { ok: true, deletedFiles: wantFiles, deletedBackups: wantFiles && wantBackups });
      })();
      return;
    }

    if (!caps.includes('power')) { sendJson(res, 403, { ok: false, error: 'not allowed to manage this instance' }); return; }

    if ((action === 'start' || action === 'restart') && upgrades.get(inst.name)?.running) { sendJson(res, 409, { ok: false, error: 'an upgrade is running' }); return; }
    if (action === 'start') {
      if (!workers.has(id)) startWorker(inst);
      (async () => {
        // give a freshly-spawned worker a moment to open its HTTP port before
        // asking it to start the Minecraft server
        for (let i = 0; i < 20 && !workers.has(id); i++) await new Promise((r) => setTimeout(r, 100));
        await workerAction(inst.panelPort, '/start');
      })();
      sendJson(res, 202, { ok: true });
      return;
    }
    if (action === 'stop') { workerAction(inst.panelPort, '/stop').then(() => {}); sendJson(res, 202, { ok: true }); return; }
    if (action === 'restart') { workerAction(inst.panelPort, '/restart').then(() => {}); sendJson(res, 202, { ok: true }); return; }
  }

  const logMatch = url.pathname.match(/^\/api\/instances\/([^/]+)\/log$/);
  if (logMatch && req.method === 'GET') {
    const logInst = loadInstances().find((i) => i.name === safeDecode(logMatch[1]));
    if (!logInst || !capsFor(req, logInst.name).includes('console')) { sendJson(res, 403, { error: 'not allowed' }); return; }
    const w = logInst && workers.get(logInst.id);
    if (w) { sendJson(res, 200, { lines: w.logs }); return; }
    const crash = logInst && panelCrashes.get(logInst.id);
    sendJson(res, 200, { lines: crash ? crash.logs : [] });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(CONTROLLER_PORT, process.env.MEOWMARISM_HOST || '0.0.0.0', () => {
  console.log(`controller listening on :${CONTROLLER_PORT}`);
  if (process.env.MEOW_PROBE) return;
  updater.confirmHealthy();
  // Workers always start; the MC server starts only for autoStart or pre-update running instances.
  for (const inst of loadInstances()) startWorker(inst);
  let names = [];
  try {
    names = JSON.parse(fs.readFileSync(RESTART_FILE, 'utf8'));
    fs.unlinkSync(RESTART_FILE);
  } catch (_) {}
  setTimeout(() => {
    for (const inst of loadInstances()) if (instanceAutoStarts(inst) || names.includes(inst.name)) workerAction(inst.panelPort, '/start');
  }, 3000);
});
