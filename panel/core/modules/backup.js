// World backups: create/list/prune, and restore. The process-management
// state (the running child, sendCommand, broadcast/timeline) still lives in
// server.js, so this module takes those as injected dependencies instead of
// reaching for module-level globals - keeps this file testable/movable on
// its own.
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

// Pass { SERVER_DIR, WORLD_DIR, BACKUP_DIR, panelConfig }; returns the backup API.
function createBackups({ SERVER_DIR, WORLD_DIR, BACKUP_DIR, panelConfig }) {

let ZSTD_AVAILABLE = false;
try { execFileSync('zstd', ['--version'], { stdio: 'ignore' }); ZSTD_AVAILABLE = true; } catch (_) {}
const BACKUP_EXT = ZSTD_AVAILABLE ? '.tar.zst' : '.tar.gz';
const BACKUP_NAME_RE = /^[a-zA-Z0-9._-]+\.tar\.(gz|zst)$/;
const MIN_FREE_DISK_GB_FOR_BACKUP = 5;

// Age-tiered retention: keep every backup for the first few hours (fine
// rollback granularity for "oops" moments), then thin older ones down to
// one per hour, then one per day - instead of N near-identical full-size
// snapshots piling up forever. panelConfig.maxBackups is still enforced as
// a hard cap on top of this.
const BACKUP_TIERS = [
  { maxAgeHours: 3, bucketHours: 0 },
  { maxAgeHours: 24, bucketHours: 1 },
  { maxAgeHours: Infinity, bucketHours: 24 },
];

const state = { backupInProgress: false, lastBackupAt: null, lastBackupError: null };

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

// zstd -T0 uses all cores and, at level 6, is both faster and smaller than
// gzip for a Minecraft world (already-compressed region files benefit little
// from higher levels, so we don't pay for those diminishing returns).
function tarCreateArgs(dest, names = ['world']) {
  const common = ['--warning=no-file-changed', '--warning=no-file-removed'];
  if (ZSTD_AVAILABLE) return [...common, '--use-compress-program=zstd -T0 -6', '-cf', dest, '-C', SERVER_DIR, ...names];
  return [...common, '-czf', dest, '-C', SERVER_DIR, ...names];
}

// The world folder is the level-name from server.properties; Paper and Purpur keep Nether and End in sibling folders.
function levelName() {
  try {
    const m = /^level-name=(.*)$/m.exec(fs.readFileSync(path.join(SERVER_DIR, 'server.properties'), 'utf8'));
    const name = m ? m[1].trim() : '';
    return name && /^[\w .-]+$/.test(name) && name !== '.' && name !== '..' ? name : 'world';
  } catch (_) { return 'world'; }
}
function worldDirNames() {
  const level = levelName();
  return [level, `${level}_nether`, `${level}_the_end`].filter((n) => fs.existsSync(path.join(SERVER_DIR, n)));
}
function archiveTopLevel(file) {
  const args = file.endsWith('.tar.zst') ? ['--use-compress-program=zstd -d', '-tf', file] : ['-tzf', file];
  const out = execFileSync('tar', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return [...new Set(out.split('\n').map((l) => l.split('/')[0]).filter((n) => n && n !== '.' && n !== '..'))];
}
function tarExtractArgs(file, destDir) {
  if (file.endsWith('.tar.zst')) return ['--use-compress-program=zstd -d', '-xf', file, '-C', destDir];
  return ['-xzf', file, '-C', destDir];
}
// GNU tar exits 1 for harmless "file changed while reading" warnings when
// CREATING an archive from a live, concurrently-written world - that special
// meaning is specific to archive creation/comparison, not extraction, so
// restore uses a stricter check that only accepts a clean 0.
function tarCreateSucceeded(code) { return code === 0 || code === 1; }
function tarExtractSucceeded(code) { return code === 0; }

// Parsed from the filename rather than mtime, so recompressing a backup in
// place (which touches mtime) doesn't make it look freshly-created to the
// age-tiered pruning below.
function parseBackupTimestamp(name) {
  const m = name.match(/-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.tar\.(gz|zst)$/);
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isFinite(t) ? t : null;
}

function listBackups() {
  ensureBackupDir();
  return fs.readdirSync(BACKUP_DIR)
    .filter((f) => BACKUP_NAME_RE.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(BACKUP_DIR, f));
      return { name: f, sizeMB: +(st.size / 1024 / 1024).toFixed(1), createdAt: parseBackupTimestamp(f) ?? st.mtimeMs };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

function pruneBackups() {
  const backups = listBackups(); // newest first
  const now = Date.now();
  const keepNames = new Set();
  const seenBuckets = new Set();
  for (const b of backups) {
    const ageHours = (now - b.createdAt) / 3600000;
    const tier = BACKUP_TIERS.find((t) => ageHours <= t.maxAgeHours) || BACKUP_TIERS[BACKUP_TIERS.length - 1];
    if (tier.bucketHours === 0) { keepNames.add(b.name); continue; }
    const bucketKey = `${tier.bucketHours}:${Math.floor(ageHours / tier.bucketHours)}`;
    if (!seenBuckets.has(bucketKey)) { seenBuckets.add(bucketKey); keepNames.add(b.name); }
  }
  let kept = backups.filter((b) => keepNames.has(b.name));
  if (kept.length > panelConfig.maxBackups) {
    const dropped = kept.slice(panelConfig.maxBackups);
    kept = kept.slice(0, panelConfig.maxBackups);
    for (const b of dropped) keepNames.delete(b.name);
  }
  for (const b of backups) {
    if (!keepNames.has(b.name)) { try { fs.unlinkSync(path.join(BACKUP_DIR, b.name)); } catch (_) {} }
  }
}

function dirSizeBytes(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) { try { total += fs.statSync(p).size; } catch (_) {} }
    }
  }
  return total;
}

function diskFreeGB() {
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const s = fs.statfsSync(SERVER_DIR);
    const blockSize = Number(s.bsize || s.frsize || 0);
    return (Number(s.bavail) * blockSize) / 1024 ** 3;
  } catch (_) { return null; }
}

// A boolean gate here meant a concurrent caller (e.g. "back up before
// restart" firing while an auto-backup was already running) saw
// backupInProgress=true, bailed out with `false` immediately, and the
// restart proceeded as if no backup was needed at all. Tracking the
// in-flight promise instead means every caller genuinely awaits the same
// backup finishing before moving on.
let currentBackupPromise = null;

// deps: { broadcast, broadcastEvent, pushTimeline, runtime }
function createBackup(reason, deps) {
  if (currentBackupPromise) return currentBackupPromise;
  currentBackupPromise = runBackup(reason, deps).finally(() => { currentBackupPromise = null; });
  return currentBackupPromise;
}

function runBackup(reason, deps) {
  return (async () => {
    const names = worldDirNames();
    if (!names.length) {
      deps.broadcast(`--- backup skipped: no ${levelName()}/ directory found ---`);
      return false;
    }
    const freeGB = diskFreeGB();
    const reserveGB = Number.isFinite(panelConfig.backupMinFreeGB) ? panelConfig.backupMinFreeGB : MIN_FREE_DISK_GB_FOR_BACKUP;
    const worldGB = names.reduce((sum, n) => sum + dirSizeBytes(path.join(SERVER_DIR, n)), 0) / 1024 ** 3;
    if (freeGB != null && freeGB - worldGB < reserveGB) {
      const msg = `not enough disk space (${freeGB.toFixed(1)} GB free, world ~${worldGB.toFixed(1)} GB, ${reserveGB} GB must stay free)`;
      deps.broadcast(`--- backup skipped: ${msg} ---`);
      state.lastBackupError = msg;
      deps.pushTimeline('backup', 'World backup skipped', msg, 'error', { reason });
      return false;
    }
    ensureBackupDir();
    state.backupInProgress = true;
    deps.broadcastEvent('backup', { state: 'started', reason });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = `world-${stamp}${BACKUP_EXT}`;
    const dest = path.join(BACKUP_DIR, file);
    const startedAtMs = Date.now();

    const live = deps.runtime.isReady();
    if (live) { deps.runtime.command('save-off'); deps.runtime.command('save-all flush'); await delay(1500); }

    deps.broadcast(`--- backing up world -> backups/${file} (${reason}, ${ZSTD_AVAILABLE ? 'zstd -T0' : 'gzip'}) ---`);
    const ok = await new Promise((resolve) => {
      const tar = spawn('tar', tarCreateArgs(dest, names));
      tar.on('error', (err) => {
        state.lastBackupError = String(err);
        deps.broadcast(`--- backup failed: ${err} ---`);
        deps.broadcastEvent('backup', { state: 'error', error: String(err) });
        resolve(false);
      });
      tar.on('exit', (code) => {
        if (tarCreateSucceeded(code)) {
          const tookSec = ((Date.now() - startedAtMs) / 1000).toFixed(1);
          state.lastBackupAt = Date.now();
          state.lastBackupError = null;
          pruneBackups();
          const sizeMB = fs.existsSync(dest) ? +(fs.statSync(dest).size / 1024 / 1024).toFixed(1) : null;
          deps.broadcast(`--- backup done: ${file} (${sizeMB} MB in ${tookSec}s) ---`);
          deps.broadcastEvent('backup', { state: 'done', file, sizeMB, tookSec: Number(tookSec) });
          deps.pushTimeline('backup', 'World backup created', `${file} · ${sizeMB} MB · ${tookSec}s · ${reason}`, 'good', { file, sizeMB, tookSec: Number(tookSec), reason });
          resolve(true);
        } else {
          state.lastBackupError = `tar exited with code ${code}`;
          try { fs.unlinkSync(dest); } catch (_) {}
          deps.broadcast(`--- backup failed: tar exited with code ${code} ---`);
          deps.broadcastEvent('backup', { state: 'error', error: state.lastBackupError });
          deps.pushTimeline('backup', 'World backup failed', state.lastBackupError, 'error', { reason });
          resolve(false);
        }
      });
    });

    state.backupInProgress = false;
    if (live) deps.runtime.command('save-on');
    return ok;
  })();
}

// Restore, meowbackup-style: move the current world aside with an atomic
// rename instead of tar-backing-it-up-then-deleting. A rename either
// succeeds instantly or throws before anything is touched - there's no
// window where a failed safety copy leaves you with neither the old world
// nor the new one, unlike the tar-based safety backup this replaced.
// deps: { broadcast, pushTimeline, runtime }
const MAX_PRE_RESTORE_DIRS = 3;

// Keeps only the last few world.pre-restore-* directories - each is a full
// uncompressed world, so leaving every one from every restore ever done
// would quietly eat tens of GB over time.
function prunePreRestoreDirs() {
  try {
    const groups = new Map();
    for (const f of fs.readdirSync(SERVER_DIR)) {
      const at = f.indexOf('.pre-restore-');
      if (at > 0) groups.set(f.slice(0, at), [...(groups.get(f.slice(0, at)) || []), f]);
    }
    for (const dirs of groups.values()) {
      for (const d of dirs.sort().reverse().slice(MAX_PRE_RESTORE_DIRS)) fs.rmSync(path.join(SERVER_DIR, d), { recursive: true, force: true });
    }
  } catch (_) {}
}

async function restoreBackup(name, deps) {
  if (!BACKUP_NAME_RE.test(name)) throw new Error('invalid backup name');
  const file = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(file)) throw new Error('backup not found');
  // Wait out any in-flight backup rather than refusing outright - it'll
  // finish in a few seconds either way, and this is simpler than asking the
  // caller to retry.
  if (currentBackupPromise) { deps.broadcast('--- waiting for the current backup to finish before restoring ---'); await currentBackupPromise; }

  if (deps.runtime.isRunning()) {
    deps.broadcast('--- stopping server for world restore ---');
    await deps.runtime.stopAndWait();
  }

  state.backupInProgress = true;
  deps.broadcast(`--- restoring world from backups/${name} ---`);
  deps.pushTimeline('restore', 'World restore started', name, 'warn', { name });
  const aside = [];
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const n of archiveTopLevel(file)) {
      const from = path.join(SERVER_DIR, n);
      if (!fs.existsSync(from)) continue;
      const to = `${from}.pre-restore-${stamp}`;
      fs.renameSync(from, to);
      aside.push([from, to]);
      deps.broadcast(`--- previous ${n} moved aside to ${path.basename(to)} ---`);
    }
    await new Promise((resolve, reject) => {
      const ex = spawn('tar', tarExtractArgs(file, SERVER_DIR));
      ex.on('exit', (code) => (tarExtractSucceeded(code) ? resolve() : reject(new Error(`tar exited with code ${code}`))));
      ex.on('error', reject);
    });
    deps.broadcast(`--- restore done: ${name} ---`);
    deps.pushTimeline('restore', 'World restore finished', name, 'good', { name });
    pruneBackups();
    prunePreRestoreDirs();
  } catch (err) {
    // Extraction failed (or didn't fully succeed) - roll back to the world
    // we moved aside instead of leaving a missing/partial world/ in place.
    try {
      for (const [from, to] of aside) {
        if (fs.existsSync(from)) fs.rmSync(from, { recursive: true, force: true });
        if (fs.existsSync(to)) fs.renameSync(to, from);
      }
      if (aside.length) deps.broadcast(`--- restore failed, rolled back to the previous world ---`);
    } catch (rollbackErr) {
      deps.broadcast(`--- restore failed AND rollback failed: ${rollbackErr.message} - previous worlds are in ${aside.map(([, to]) => path.basename(to)).join(', ')} ---`);
    }
    deps.broadcast(`--- restore failed: ${err.message} ---`);
    deps.pushTimeline('restore', 'World restore failed', err.message, 'error', { name });
    throw err;
  } finally {
    state.backupInProgress = false;
  }
}

let autoBackupTimer = null;
function rescheduleAutoBackup(deps) {
  if (autoBackupTimer) clearInterval(autoBackupTimer);
  const ms = Math.max(0.25, Number(panelConfig.backupIntervalHours) || 6) * 60 * 60 * 1000;
  autoBackupTimer = setInterval(() => { if (deps.runtime.isRunning()) createBackup('auto', deps); }, ms).unref();
}
let pruneTimer = null;
function startPruneTimer(deps) {
  if (pruneTimer) clearInterval(pruneTimer);
  // Only prune alongside an active server - while stopped or asleep nothing
  // is writing to world/, so there's nothing new to make room for.
  pruneTimer = setInterval(() => { if (!state.backupInProgress && deps.runtime.isRunning()) pruneBackups(); }, 30 * 60000).unref();
}
function dispose() {
  if (autoBackupTimer) clearInterval(autoBackupTimer);
  if (pruneTimer) clearInterval(pruneTimer);
  autoBackupTimer = pruneTimer = null;
}

return {
  BACKUP_EXT, BACKUP_NAME_RE, MIN_FREE_DISK_GB_FOR_BACKUP,
  state, ensureBackupDir, listBackups, pruneBackups,
  tarCreateArgs, tarExtractArgs, tarCreateSucceeded, tarExtractSucceeded,
  createBackup, restoreBackup, rescheduleAutoBackup, startPruneTimer, dispose, worldDirNames, levelName,
};
}

module.exports = { createBackups };
