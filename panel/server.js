const safeDecode = (s) => { try { return decodeURIComponent(s); } catch (_) { return String(s); } };
const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync, execFile } = require('child_process');
const os = require('os');
const crypto = require('crypto');

const cfg = require('./lib/config');
const launchLib = require('./runtime/launch');
const scheduler = require('./core/modules/scheduler');
const { runTask } = require('./core/modules/schedule-run');
const { createModrinth, fetchImage } = require('./core/modules/modrinth');
const {
  SERVER_DIR, LOG_FILE, PROPERTIES_FILE, WORLD_DIR, BACKUP_DIR, CONFIG_FILE,
  HISTORY_FILE, METRICS_FILE, MODS_DIR, DISABLED_MODS_DIR, INSTANCE_LOADER, INSTANCE_MC_VERSION, WHITELIST_FILE, OPS_FILE,
  BANNED_PLAYERS_FILE, INSTANCES_FILE, panelConfig,
} = cfg;
const saveConfig = cfg.saveConfig;

// Instance creation/registry/lifecycle now lives entirely in controller.js -
// this worker process only ever manages the one Minecraft install at
// SERVER_DIR. See controller.js for why (each instance gets its own worker
// process now, instead of one process juggling multiple SERVER_DIRs).


const BACKUP_BEFORE_RESTART = true;

const savePanelConfig = saveConfig; // alias - every call site below still says savePanelConfig()


const PORT = Number(process.env.PANEL_PORT) || 8090;
const FAST_SAMPLE_MS = 50; // 20 internal samples / second
const PUBLISH_MS = 1000;   // one packet / second containing the real 50 ms samples
const HISTORY_MAX = 900;   // 15 minutes at one point / second
const HISTORY_5S_MAX = 720; // 1 hour at one point / 5 seconds
const HISTORY_1M_MAX = 1440; // 24 hours at one point / minute
const HISTORY_10M_MAX = 1008; // 7 days at one point / 10 minutes
const RING_MAX = 5000;
const CACHE_WINDOW_MS = 5 * 60 * 1000; // raw recovery cache
const SNAPSHOT_WINDOW_MS = 60 * 1000;  // initial snapshot stays small
const RAW_CACHE_MAX = Math.ceil(CACHE_WINDOW_MS / FAST_SAMPLE_MS) + 200;
const INSTANCE_ID = crypto.randomUUID();

let child = null;
const startupTimers = require('./core/modules/startup-timer').createStartupTimers();
const serverIcon = require('./core/modules/server-icon').createServerIcon({ dir: SERVER_DIR, defaultIcon: path.join(__dirname, 'core', 'brand', 'server-icon.png') });
let startedAt = null;
let lastExitAt = null;
let restartCount = 0;
let serverPhase = 'offline';
let readyAt = null;
let startupDurationMs = null;
let lastReadyAt = null;
let lastStartupDurationMs = null;
const panelStartedAt = Date.now();
const clients = new Set();
const tailListeners = new Set();
const ringBuffer = [];
const recentConsole = [];
const rawSampleCache = [];
const history = [];
const history5s = [];
const history1m = [];
const history10m = [];
let history5sBucket = [];
let history1mBucket = [];
let history10mBucket = [];
let consoleSeq = 0;
let statsSeq = 0;
let rawSampleSeq = 0;
let smoothState = null;
let minecraftVersion = null;
let lagWarningCount = 0;
let lastLagWarning = null;
let lastTps = null;
let lastMspt = null;
let lastWorldStats = null;
let lastCrash = null;
let recentCrashTimestamps = [];
let lastExitInfo = null;
let eventSeq = 0;
let auditSeq = 0;
const timelineEvents = [];
const auditEntries = [];
const { createPlayerTracker, buildPlayerCommand, playerName: normalizePlayerName } = require('./core/modules/players');
const tracker = createPlayerTracker({
  onJoin: (name, source) => pushTimeline('player_join', `${name} joined`, source === 'log' ? 'Joined the server' : 'Detected online from /list', 'info', { player: name }),
  onLeave: (name, durationMs) => pushTimeline('player_leave', `${name} left`, `Session ${Math.floor(durationMs / 1000)}s`, 'info', { player: name, durationMs }),
});
const { players, history: playerHistory } = tracker;
const EVENT_MAX = 2500;
const AUDIT_MAX = 2500;

// timelineEvents/auditEntries/playerHistory otherwise only live in memory -
// a panel restart (deploys do this routinely) silently wiped "Full
// timeline" and player session history despite the UI implying they're
// durable. Periodic + on-exit snapshot to disk fixes that without needing
// a real database for what's still fairly small, append-mostly data.
function loadHistory() {
  try {
    const saved = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    if (Array.isArray(saved.timelineEvents)) timelineEvents.push(...saved.timelineEvents);
    if (Array.isArray(saved.auditEntries)) auditEntries.push(...saved.auditEntries);
    if (Array.isArray(saved.playerHistory)) for (const [k, v] of saved.playerHistory) playerHistory.set(k, v);
    eventSeq = Number(saved.eventSeq) || timelineEvents.reduce((m, e) => Math.max(m, e.seq || 0), 0);
    auditSeq = Number(saved.auditSeq) || auditEntries.reduce((m, e) => Math.max(m, e.seq || 0), 0);
  } catch (_) { /* no history yet */ }
}
function saveHistory() {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify({
      timelineEvents: timelineEvents.slice(-EVENT_MAX),
      auditEntries: auditEntries.slice(-AUDIT_MAX),
      playerHistory: [...playerHistory.entries()],
      eventSeq, auditSeq,
    }));
  } catch (_) {}
}
loadHistory();
setInterval(saveHistory, 60000).unref();

// Performance history survives restarts; the time the panel was down is drawn as a flat zero line.
const METRIC_KEYS = ['t', 'samples', 'cpu', 'ram', 'disk', 'procCpu', 'procRam', 'rx', 'tx', 'players'];
const slimPoint = (p) => Object.fromEntries(METRIC_KEYS.filter((k) => p[k] !== undefined).map((k) => [k, p[k]]));
const zeroPoint = (t) => ({ t, samples: 0, cpu: 0, ram: 0, disk: 0, procCpu: 0, procRam: 0, rx: 0, tx: 0, players: 0 });
function saveMetrics() {
  try {
    fs.writeFileSync(METRICS_FILE, JSON.stringify({
      savedAt: Date.now(),
      fiveSecond: history5s.map(slimPoint), oneMinute: history1m.map(slimPoint), tenMinute: history10m.map(slimPoint),
    }));
  } catch (_) {}
}
function loadMetrics() {
  try {
    const saved = JSON.parse(fs.readFileSync(METRICS_FILE, 'utf8'));
    const now = Date.now();
    for (const [target, list, step] of [[history5s, saved.fiveSecond, 5000], [history1m, saved.oneMinute, 60000], [history10m, saved.tenMinute, 600000]]) {
      if (!Array.isArray(list) || !list.length) continue;
      target.push(...list);
      const last = target[target.length - 1].t;
      if (now - last > step * 2) target.push(zeroPoint(last + step), zeroPoint(now - step));
    }
  } catch (_) { /* first start */ }
}
loadMetrics();
setInterval(saveMetrics, 60000).unref();
// Under the controller, SIGTERM is how a worker gets stopped - graceful
// shutdown means actually stopping the Minecraft process first (not just
// killing the panel out from under it), with a hard timeout so a stuck
// server can't block the worker from ever exiting.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    saveHistory();
    saveMetrics();
    if (child && child.stdin && child.stdin.writable) {
      const forceExit = setTimeout(() => process.exit(0), 20000);
      child.once('exit', () => { clearTimeout(forceExit); process.exit(0); });
      child.stdin.write('stop\n');
    } else {
      process.exit(0);
    }
  });
}
let restartPlan = null;
let restartPlanTimer = null;
let restartPlanTicker = null;
let detectedFeatures = { engine: 'unknown', spark: false, plugins: [], jmx: false, jstat: false, jcmd: false, scannedAt: 0 };
let featureScanAt = 0;
let lastPerfProbeAt = 0;

let previousCpuSample = takeCpuSample();
let previousNetSample = takeNetworkSample();
let latestStats = null;
let fastSamples = [];
const propertiesApi = require('./core/modules/properties').createProperties({
  file: PROPERTIES_FILE,
  isRunning: () => !!child,
  command: (text) => sendCommand(text),
});
const accessApi = require('./core/modules/access').createAccess({
  dir: SERVER_DIR,
  isRunning: () => !!child,
  command: (text) => sendCommand(text),
});
const readServerProperties = () => propertiesApi.read();
const buildSettingsState = () => propertiesApi.state();
function applySettingsPatch(patch) {
  const state = propertiesApi.apply(patch);
  latestStats = null;
  broadcastEvent('settings', state);
  return state;
}

function trimArray(arr, max) {
  if (arr.length > max) arr.splice(0, arr.length - max);
}

function broadcastIfReady(name, payload) {
  try { broadcastEvent(name, payload); } catch (_) {}
}

function pushTimeline(type, title, detail = '', severity = 'info', meta = {}) {
  const entry = { seq: ++eventSeq, at: Date.now(), type, title, detail, severity, meta };
  timelineEvents.push(entry);
  trimArray(timelineEvents, EVENT_MAX);
  broadcastIfReady('timeline', entry);
  return entry;
}

function pushAudit(action, target = '', detail = '', meta = {}) {
  const entry = { seq: ++auditSeq, at: Date.now(), actor: 'panel', action, target, detail, meta };
  auditEntries.push(entry);
  trimArray(auditEntries, AUDIT_MAX);
  broadcastIfReady('audit', entry);
  return entry;
}

const getPlayerHistory = tracker.getHistory;
const recordPlayerJoin = tracker.join;
const recordPlayerLeave = tracker.leave;

function classifyConsoleLine(text) {
  const line = String(text || '');
  let level = 'info', category = 'general';
  if (/^\[stderr\]|\b(?:ERROR|SEVERE|FATAL)\b|Exception|Caused by:/i.test(line)) level = 'error';
  else if (/\bWARN(?:ING)?\b|Can'?t keep up!/i.test(line)) level = 'warn';
  else if (/^---/.test(line)) level = 'system';
  if (/\]: <[A-Za-z0-9_]{1,16}> /.test(line)) category = 'chat';
  else if (/ joined the game| left the game/.test(line)) category = 'player';
  else if (/issued server command:|\bcommand\b/i.test(line)) category = 'command';
  else if (/Starting minecraft server|Done \(|Stopping server|Saving players/i.test(line)) category = 'lifecycle';
  else if (/TPS|MSPT|Can'?t keep up!/i.test(line)) category = 'performance';
  return { level, category };
}

function scanFeatures(force = false) {
  const now = Date.now();
  if (!force && now - featureScanAt < 30_000) return detectedFeatures;
  featureScanAt = now;
  const names = [];
  try { names.push(...fs.readdirSync(SERVER_DIR).map((x) => String(x))); } catch (_) {}
  const plugins = [];
  try {
    const pluginDir = path.join(SERVER_DIR, 'plugins');
    for (const name of fs.readdirSync(pluginDir)) if (/\.jar$/i.test(name)) plugins.push(name);
  } catch (_) {}
  const haystack = [...names, ...plugins].join(' ').toLowerCase();
  let engine = detectedFeatures.engine && detectedFeatures.engine !== 'unknown' ? detectedFeatures.engine : 'vanilla';
  if (haystack.includes('purpur')) engine = 'purpur';
  else if (haystack.includes('paper')) engine = 'paper';
  else if (haystack.includes('fabric')) engine = 'fabric';
  else if (haystack.includes('forge') || haystack.includes('neoforge')) engine = haystack.includes('neoforge') ? 'neoforge' : 'forge';
  const pid = findCachedServerPid();
  let cmdline = '';
  if (pid) { try { cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '); } catch (_) {} }
  const prevJstat = detectedFeatures.jstat, prevJcmd = detectedFeatures.jcmd;
  detectedFeatures = {
    engine,
    spark: plugins.some((x) => /^spark(?:-|\.)/i.test(x)) || /\bspark\b/i.test(haystack),
    plugins: plugins.sort().slice(0, 100),
    jmx: /com\.sun\.management\.jmxremote/i.test(cmdline),
    jstat: prevJstat !== false, // keep last known good value (default true) until the async recheck below says otherwise
    jcmd: prevJcmd !== false,
    scannedAt: now,
  };
  // Run off the sync path - these can take up to 350ms each and would
  // otherwise stall the event loop (and every SSE stream) for that long.
  execFile('jstat', ['-help'], { timeout: 350 }, (err) => { detectedFeatures.jstat = !err; });
  execFile('jcmd', ['-h'], { timeout: 350 }, (err) => { detectedFeatures.jcmd = !err; });
  return detectedFeatures;
}


// Returns whatever's cached immediately (never blocks) and, if the cache is
// stale, kicks off a background refresh for next time. jstat -gc can take
// up to ~900ms; running it synchronously stalled the whole event loop -
// including every SSE stream - for that long, often visible as a display
// delay spike.
function buildHealthSnapshot({ cpu, memory, disk }) {
  const state = (value, warn, bad) => !Number.isFinite(Number(value)) ? 'unknown' : Number(value) >= bad ? 'high' : Number(value) >= warn ? 'elevated' : 'normal';
  const now = Date.now();
  const recentLag = timelineEvents.filter((e) => e.type === 'lag' && e.at >= now - 10 * 60_000).length;
  const tps = lastTps?.one;
  return {
    cpu: { state: state(cpu, 75, 92), value: cpu },
    memory: { state: state(memory, 80, 93), value: memory },
    disk: { state: state(disk, 85, 95), value: disk },
    tps: { state: !Number.isFinite(Number(tps)) ? 'unknown' : tps < 17 ? 'high' : tps < 19.5 ? 'elevated' : 'normal', value: tps ?? null },
    lag: { state: recentLag >= 3 ? 'high' : recentLag ? 'elevated' : 'normal', last10m: recentLag },
    crashes: { state: lastCrash && now - lastCrash.at < 24 * 60 * 60_000 ? 'elevated' : 'normal', last: lastCrash },
  };
}

function currentRestartPlanState() {
  if (!restartPlan) return null;
  return { ...restartPlan, remainingSec: Math.max(0, Math.ceil((restartPlan.executeAt - Date.now()) / 1000)) };
}

function clearRestartPlan(reason = 'cancelled') {
  if (restartPlanTimer) clearTimeout(restartPlanTimer);
  if (restartPlanTicker) clearInterval(restartPlanTicker);
  restartPlanTimer = null; restartPlanTicker = null;
  const old = restartPlan;
  restartPlan = null;
  if (old) {
    pushTimeline('restart_cancelled', 'Scheduled restart cancelled', reason, 'info');
    broadcastIfReady('restart-plan', null);
  }
  return !!old;
}

function scheduleRestart(delaySec = 10, reason = 'Scheduled restart', warnPlayers = true) {
  clearRestartPlan('replaced');
  delaySec = Math.max(0, Math.min(3600, Math.round(Number(delaySec) || 0)));
  const now = Date.now();
  restartPlan = { createdAt: now, executeAt: now + delaySec * 1000, delaySec, reason: String(reason || 'Scheduled restart').slice(0, 160), warnPlayers: !!warnPlayers, warned: [] };
  pushTimeline('restart_scheduled', `Restart scheduled in ${delaySec}s`, restartPlan.reason, 'warn', { executeAt: restartPlan.executeAt });
  pushAudit('restart.schedule', 'server', `${delaySec}s · ${restartPlan.reason}`);
  const warnAt = [300, 120, 60, 30, 10, 5, 4, 3, 2, 1];
  restartPlanTicker = setInterval(() => {
    if (!restartPlan) return;
    const remain = Math.max(0, Math.ceil((restartPlan.executeAt - Date.now()) / 1000));
    if (restartPlan.warnPlayers && child && warnAt.includes(remain) && !restartPlan.warned.includes(remain)) {
      restartPlan.warned.push(remain);
      sendCommand(`say Restart in ${remain}s${restartPlan.reason ? ` - ${restartPlan.reason}` : ''}`);
    }
    broadcastIfReady('restart-plan', currentRestartPlanState());
  }, 1000);
  restartPlanTimer = setTimeout(async () => {
    if (!restartPlan) return;
    const plan = restartPlan;
    restartPlan = null;
    if (restartPlanTicker) clearInterval(restartPlanTicker);
    restartPlanTicker = null; restartPlanTimer = null;
    pushTimeline('restart', 'Server restart started', plan.reason, 'warn');
    if (BACKUP_BEFORE_RESTART) {
      broadcast('--- taking a backup before restarting ---');
      await createBackup('pre-restart');
    }
    restartServer('scheduled');
    broadcastIfReady('restart-plan', null);
  }, delaySec * 1000);
  broadcastIfReady('restart-plan', currentRestartPlanState());
  return currentRestartPlanState();
}

function forceStopServer() {
  if (!child) return false;
  const javaPid = findCachedServerPid();
  pushTimeline('force_stop', 'Force stop requested', `SIGKILL sent to pid ${javaPid || child.pid}`, 'warn');
  pushAudit('server.force-stop', 'server');
  return runtime.kill(javaPid);
}

function maybeProbePerformance() {
  if (!child || serverPhase !== 'ready') return;
  const now = Date.now();
  if (now - lastPerfProbeAt < 30_000) return;
  lastPerfProbeAt = now;
  const f = scanFeatures();
  if (f.spark) sendCommand('spark tps');
  else if (f.engine === 'paper' || f.engine === 'purpur') sendCommand('tps');
}

const parsePlayerLine = tracker.parseLine;

function trimRecentConsole(now = Date.now()) {
  const cutoff = now - CACHE_WINDOW_MS;
  while (recentConsole.length && recentConsole[0].at < cutoff) recentConsole.shift();
}

function trimRawSampleCache(now = Date.now()) {
  const cutoff = now - CACHE_WINDOW_MS;
  while (rawSampleCache.length && rawSampleCache[0].at < cutoff) rawSampleCache.shift();
  if (rawSampleCache.length > RAW_CACHE_MAX) {
    rawSampleCache.splice(0, rawSampleCache.length - RAW_CACHE_MAX);
  }
}

function detectServerLifecycle(line) {
  const text = String(line || '');

  const versionMatch = text.match(/Starting minecraft server version\s+(.+?)\s*$/i);
  if (versionMatch) minecraftVersion = versionMatch[1].trim();
  if (/\bPurpur\b/i.test(text)) detectedFeatures.engine = 'purpur';
  else if (/\bPaper\b/i.test(text)) detectedFeatures.engine = 'paper';
  else if (/\bFabric\b/i.test(text)) detectedFeatures.engine = 'fabric';

  const lagMatch = text.match(/Can't keep up!.*?Running\s+(\d+)ms\s+or\s+(\d+)\s+ticks behind/i);
  if (lagMatch) {
    lagWarningCount++;
    lastLagWarning = { at: Date.now(), delayMs: Number(lagMatch[1]), ticksBehind: Number(lagMatch[2]) };
    pushTimeline('lag', 'Server fell behind', `${lastLagWarning.ticksBehind} ticks · ${lastLagWarning.delayMs} ms`, lastLagWarning.delayMs >= 5000 ? 'error' : 'warn', lastLagWarning);
  }

  const tpsLine = /\bTPS\b/i.test(text) ? [...text.matchAll(/(?<![\w.])([0-9]+(?:\.[0-9]+)?)(?![\w.])/g)].map((m) => Number(m[1])).filter((n) => Number.isFinite(n) && n >= 0 && n <= 20.5) : [];
  if (tpsLine.length) {
    const vals = tpsLine.slice(-3);
    lastTps = { at: Date.now(), one: vals[0] ?? null, five: vals[1] ?? vals[0] ?? null, fifteen: vals[2] ?? vals[1] ?? vals[0] ?? null };
  }
  const msptMatch = text.match(/\bMSPT\b[^0-9]*([0-9]+(?:\.[0-9]+)?)/i);
  if (msptMatch) lastMspt = { at: Date.now(), current: Number(msptMatch[1]) };
  const worldMatch = text.match(/(?:chunks?|loaded chunks?)\D+(\d+).*?(?:entities|entity count)\D+(\d+)/i);
  if (worldMatch) lastWorldStats = { at: Date.now(), chunks: Number(worldMatch[1]), entities: Number(worldMatch[2]) };

  const readyMatch = text.match(/Done \(([0-9.]+)s\)!.*(?:help|type)/i);
  if (readyMatch && child) {
    const now = Date.now();
    const parsedMs = Math.round(Number(readyMatch[1]) * 1000);
    serverPhase = 'ready'; readyAt = now;
    startupDurationMs = startupTimers.ready('server', Number.isFinite(parsedMs) ? parsedMs : null);
    lastReadyAt = readyAt; lastStartupDurationMs = startupDurationMs;
    pushTimeline('ready', 'Server ready', `Startup ${startupDurationMs != null ? (startupDurationMs / 1000).toFixed(2) + 's' : 'complete'}`, 'good', { startupDurationMs });
    broadcastStatus();
    return;
  }
  if (child && /(?:Stopping server|Stopping the server|Saving players)/i.test(text) && serverPhase !== 'stopping') {
    serverPhase = 'stopping';
    pushTimeline('stopping', 'Server stopping', 'Clean shutdown sequence started', 'info');
    broadcastStatus();
  }
}

function broadcast(line) {
  detectServerLifecycle(line);
  parsePlayerLine(line);
  ringBuffer.push(line);
  if (ringBuffer.length > panelConfig.consoleBufferSize) ringBuffer.shift();

  const cls = classifyConsoleLine(line);
  const entry = { seq: ++consoleSeq, at: Date.now(), line, level: cls.level, category: cls.category };
  recentConsole.push(entry);
  trimRecentConsole(entry.at);

  const data = JSON.stringify(entry);
  for (const res of clients) {
    if (res.view && !res.view.console) continue;
    if (dropSlowClient(res)) continue;
    res.write(`event: console\ndata: ${data}\n\n`);
  }
  for (const listener of tailListeners) listener(line);
}

// Resolves a user-supplied relative path against SERVER_DIR and refuses
// anything that would escape it (symlinks, ../, absolute paths, etc.).
const filesApi = require('./core/modules/files').createFiles({ root: SERVER_DIR });

const backupLib = require('./core/modules/backup').createBackups({ SERVER_DIR, WORLD_DIR, BACKUP_DIR, panelConfig });
const { BACKUP_EXT, BACKUP_NAME_RE, listBackups, pruneBackups, ensureBackupDir } = backupLib;
const backupState = backupLib.state; // { backupInProgress, lastBackupAt, lastBackupError }

const runtime = require('./runtime').createRuntime({
  serverDir: SERVER_DIR,
  logFile: LOG_FILE,
  propertiesFile: PROPERTIES_FILE,
  mcVersion: INSTANCE_MC_VERSION,
  panelConfig,
  hasJstat: () => scanFeatures().jstat,
  hooks: {
    getPhase: () => serverPhase,
    startAttempt: () => { lastStartBlock = null; startupTimers.begin('server'); },
    blocked: (msg) => {
      lastStartBlock = msg;
      broadcast(`--- cannot start: ${msg} ---`);
      pushTimeline('start_blocked', 'Server did not start', msg, 'error');
    },
    releasePort: () => stopSleepProxy(),
    willSpawn: () => clearRestartPlan('server starting'),
    notice: (text) => broadcast(text),
    spawned: onProcessSpawned,
    line: (text, isErr) => broadcast(isErr ? `[stderr] ${text}` : text),
    spawnError: onProcessError,
    stopping: onProcessStopping,
    exited: onProcessExit,
  },
});

const backupDeps = {
  broadcast: (...a) => broadcast(...a),
  broadcastEvent: (...a) => broadcastEvent(...a),
  pushTimeline: (...a) => pushTimeline(...a),
  runtime,
};
function createBackup(reason) { return backupLib.createBackup(reason, backupDeps); }
function restoreBackup(name) { return backupLib.restoreBackup(name, backupDeps); }

backupLib.rescheduleAutoBackup(backupDeps);
backupLib.startPruneTimer(backupDeps);

function checkAutoRestart() {
  if (!panelConfig.autoRestartEnabled || !child) return;
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const today = now.toISOString().slice(0, 10);
  if (hhmm === panelConfig.autoRestartTime && panelConfig.lastAutoRestartDate !== today) {
    panelConfig.lastAutoRestartDate = today;
    savePanelConfig();
    scheduleRestart(panelConfig.autoRestartWarnSec || 300, 'Nightly restart', true);
  }
}
setInterval(checkAutoRestart, 30000).unref();

function runScheduledTask(task) {
  const result = runTask(task, {
    runtime,
    createBackup,
    restart: (warnSec, reason) => scheduleRestart(warnSec, reason, true),
    onError: (err) => pushAudit('schedule.error', 'server', `${task.name} · ${err.message}`),
  });
  task.lastRunAt = Date.now();
  task.lastResult = result;
  savePanelConfig();
  pushAudit('schedule.run', 'server', `${task.name} · ${result}`);
  return result;
}
setInterval(() => {
  for (const task of panelConfig.schedule || []) if (scheduler.isDue(task)) runScheduledTask(task);
}, 20000).unref();

function dropSlowClient(res) {
  if (res.writableLength <= 2 * 1024 * 1024) return false;
  clients.delete(res);
  res.destroy();
  return true;
}

function broadcastEvent(name, payload) {
  const data = JSON.stringify(payload);
  for (const res of clients) {
    if (dropSlowClient(res)) continue;
    res.write(`event: ${name}\ndata: ${data}\n\n`);
  }
}

function broadcastStatus() {
  broadcastEvent('status', {
    running: !!child,
    startedAt,
    lastExitAt,
    restartCount,
    phase: serverPhase,
    readyAt,
    startupDurationMs,
    lastReadyAt,
    lastStartupDurationMs,
    sleeping: sleeping(),
  });
}

// --- Sleep mode: when nobody's online for a while, stop the real server and
// bind a tiny fake server on the same port that answers server-list pings
// and, on an actual join attempt, wakes the real server back up. ---
let sleepProxy = null;
let zeroPlayersSinceMs = Date.now();

function mcVarInt(value) {
  const bytes = [];
  let v = value;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    bytes.push(b);
  } while (v !== 0);
  return Buffer.from(bytes);
}
function mcReadVarInt(buf, offset) {
  let value = 0, position = 0, idx = offset, byte;
  do {
    if (idx >= buf.length) return null;
    byte = buf[idx++];
    value |= (byte & 0x7f) << position;
    position += 7;
    if (position >= 32) throw new Error('VarInt too big');
  } while ((byte & 0x80) !== 0);
  return { value, next: idx };
}
function mcString(str) {
  const b = Buffer.from(str, 'utf8');
  return Buffer.concat([mcVarInt(b.length), b]);
}
function mcPacket(id, dataBuf) {
  const body = Buffer.concat([mcVarInt(id), dataBuf]);
  return Buffer.concat([mcVarInt(body.length), body]);
}

function sleepPort() {
  const props = readServerProperties();
  return Number(props['server-port']) || 25565;
}

const SLEEP_MAX_PACKET = 8 * 1024;
const SLEEP_MAX_BUFFER = 16 * 1024;
function startSleepProxy() {
  if (sleepProxy) return;
  const port = sleepPort();
  const server = net.createServer((socket) => {
    socket.setTimeout(5000, () => socket.destroy());
    let buf = Buffer.alloc(0);
    let state = 0; // 0 = handshake, 1 = status, 2 = login
    let clientProtocol = -1;
    socket.on('data', (chunk) => {
      if (buf.length + chunk.length > SLEEP_MAX_BUFFER) { socket.destroy(); return; }
      buf = Buffer.concat([buf, chunk]);
      try {
        for (;;) {
          const len = mcReadVarInt(buf, 0);
          if (len && (len.value < 0 || len.value > SLEEP_MAX_PACKET)) { socket.destroy(); return; }
          if (!len || buf.length < len.next + len.value) return;
          const packet = buf.slice(len.next, len.next + len.value);
          buf = buf.slice(len.next + len.value);
          const pid = mcReadVarInt(packet, 0);
          if (!pid) continue;
          const body = packet.slice(pid.next);
          if (state === 0 && pid.value === 0x00) {
            const proto = mcReadVarInt(body, 0);
            clientProtocol = proto ? proto.value : -1;
            const addrLen = mcReadVarInt(body, proto ? proto.next : 0);
            const afterAddr = (addrLen ? addrLen.next + addrLen.value : body.length) + 2; // + port short
            const next = mcReadVarInt(body, afterAddr);
            state = next ? next.value : 1;
          } else if (state === 1 && pid.value === 0x00) {
            const json = JSON.stringify({
              version: { name: 'Sleeping', protocol: clientProtocol },
              players: { max: 0, online: 0, sample: [] },
              description: { text: '§bServer is sleeping - join to wake it up!' },
            });
            socket.write(mcPacket(0x00, mcString(json)));
          } else if (state === 1 && pid.value === 0x01) {
            socket.write(mcPacket(0x01, body));
            socket.end();
          } else if (state === 2) {
            const msg = JSON.stringify({ text: '§eServer is waking up…\n§7Reconnect in about 20 seconds.' });
            socket.write(mcPacket(0x00, mcString(msg)));
            socket.end();
            wakeUp('join attempt');
          }
        }
      } catch (_) { socket.destroy(); }
    });
    socket.on('error', () => {});
  });
  server.on('error', (err) => {
    broadcast(`--- sleep proxy failed to bind :${port} - ${err.message} ---`);
  });
  server.listen(port, '0.0.0.0', () => {
    broadcast(`--- sleeping - listening on :${port}, waiting for a join to wake up ---`);
  });
  sleepProxy = server;
}

function stopSleepProxy() {
  if (!sleepProxy) return;
  try { sleepProxy.close(); } catch (_) {}
  sleepProxy = null;
}

function goToSleep() {
  if (!child || sleeping()) return;
  pushTimeline('sleep', 'Server going to sleep', `No players for ${panelConfig.sleepAfterMinutes} min`, 'info');
  stopServer('sleep');
}

function wakeUp(reason) {
  stopSleepProxy();
  if (child) return;
  pushTimeline('wake', 'Server waking up', reason, 'good');
  startServer();
}

function sleeping() { return !!sleepProxy; }

function checkSleep() {
  if (!panelConfig.sleepEnabled || !child) { zeroPlayersSinceMs = Date.now(); return; }
  if (players.size > 0) { zeroPlayersSinceMs = Date.now(); return; }
  const idleMs = Date.now() - zeroPlayersSinceMs;
  if (idleMs >= Math.max(1, Number(panelConfig.sleepAfterMinutes) || 20) * 60000) goToSleep();
}
setInterval(checkSleep, 30000).unref();

let modrinthInstance = null;
function modrinth() {
  if (!modrinthInstance) modrinthInstance = createModrinth({ modsDir: MODS_DIR, disabledDir: DISABLED_MODS_DIR, oldDir: path.join(SERVER_DIR, MODS_DIR.endsWith('plugins') ? 'plugins-old' : 'mods-old'), datapackDir: path.join(WORLD_DIR, 'datapacks'), mcVersion: INSTANCE_MC_VERSION, loader: INSTANCE_LOADER });
  return modrinthInstance;
}
let launchMode = 'none';
let lastStartBlock = null;
function startServer() { return runtime.start(); }

function onProcessSpawned(proc, launch) {
  launchMode = launch.mode;
  child = proc;
  startedAt = Date.now();
  serverPhase = 'starting';
  readyAt = null;
  startupDurationMs = null;
  propertiesApi.clearPending();
  players.clear();
  lastTps = null;
  lastLagWarning = null;
  procMetrics.reset();

  pushTimeline('start', 'Server starting', `Launcher PID ${proc.pid}`, 'info');
  broadcast(`--- server starting (pid ${proc.pid}) ---`);
  broadcastStatus();
  propertiesApi.bump();
  broadcastEvent('settings', buildSettingsState());
}

function onProcessError(err, noPid) {
  serverPhase = 'error';
  broadcast(`--- failed to start server: ${err.message} ---`);
  if (noPid) { child = null; startedAt = null; }
  broadcastStatus();
}

function onProcessExit({ code, signal, reason, intent }) {
  const wasCrash = !intent && ((code != null && code !== 0) || !!signal);
  broadcast(`--- server process exited (${reason}) ---`);
  lastExitInfo = { at: Date.now(), code, signal, reason, intentional: !!intent, intent };
  if (wasCrash) {
    lastCrash = { ...lastExitInfo, runtimeMs: startedAt ? Date.now() - startedAt : null, lastConsole: recentConsole.slice(-100) };
    pushTimeline('crash', 'Server crashed', `${reason}${lastCrash.runtimeMs != null ? ` · runtime ${Math.floor(lastCrash.runtimeMs / 1000)}s` : ''}`, 'error', { code, signal });
  } else if (intent !== 'sleep') {
    pushTimeline('stop', 'Server offline', `${reason}${intent ? ` · ${intent}` : ''}`, 'info', { code, signal, intent });
  }
  for (const name of [...players.keys()]) recordPlayerLeave(name, 'shutdown', false);
  child = null;
  startedAt = null;
  startupTimers.stopped('server');
  serverPhase = 'offline';
  readyAt = null;
  startupDurationMs = null;
  lastExitAt = Date.now();
  players.clear();
  procMetrics.reset();
  broadcastStatus();
  if (intent === 'sleep') startSleepProxy();
  if (wasCrash) maybeAutoRestartAfterCrash();
}

function maybeAutoRestartAfterCrash() {
  if (!panelConfig.crashAutoRestartEnabled) return;
  const now = Date.now();
  recentCrashTimestamps = recentCrashTimestamps.filter((t) => now - t < 3600000);
  recentCrashTimestamps.push(now);
  const limit = Math.max(1, Number(panelConfig.maxCrashRestartsPerHour) || 3);
  if (recentCrashTimestamps.length > limit) {
    broadcast(`--- crashed ${recentCrashTimestamps.length}x in the last hour, giving up on auto-restart (needs a manual look) ---`);
    pushTimeline('crash', 'Auto-restart disabled', `${recentCrashTimestamps.length} crashes in the last hour - check what's wrong before starting manually`, 'error');
    return;
  }
  const delaySec = Math.max(0, Number(panelConfig.crashAutoRestartDelaySec) || 15);
  broadcast(`--- auto-restarting in ${delaySec}s after crash (attempt ${recentCrashTimestamps.length}/${limit} this hour) ---`);
  setTimeout(() => { if (!child) startServer(); }, delaySec * 1000);
}

function stopServer(intent = 'stop') { return runtime.stop(intent); }

function onProcessStopping(intent) {
  serverPhase = 'stopping';
  pushTimeline('stop_requested', intent === 'restart' || intent === 'scheduled' ? 'Restart requested' : 'Stop requested', intent, 'info');
  broadcastStatus();
}

function restartServer(intent = 'restart') {
  restartCount++;
  clearRestartPlan('restart executing');
  pushAudit('server.restart', 'server', intent);
  if (child) {
    child.once('exit', () => setTimeout(startServer, 700));
    return stopServer(intent);
  }
  return startServer();
}

function sendCommand(cmd) { return runtime.command(cmd); }

function takeCpuSample() {
  return os.cpus().map((cpu) => {
    const times = cpu.times;
    const total = times.user + times.nice + times.sys + times.idle + times.irq;
    return { idle: times.idle, total };
  });
}

function cpuUsage() {
  const current = takeCpuSample();
  const perCore = current.map((cpu, i) => {
    const prev = previousCpuSample[i] || cpu;
    const totalDelta = cpu.total - prev.total;
    const idleDelta = cpu.idle - prev.idle;
    if (totalDelta <= 0) return 0;
    return Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100));
  });
  previousCpuSample = current;
  const usage = perCore.length
    ? perCore.reduce((sum, value) => sum + value, 0) / perCore.length
    : 0;
  return {
    usage: Number(usage.toFixed(1)),
    perCore: perCore.map((value) => Number(value.toFixed(1))),
  };
}

function diskStats() {
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const s = fs.statfsSync(SERVER_DIR);
    const blockSize = Number(s.bsize || s.frsize || 0);
    const total = Number(s.blocks) * blockSize;
    const available = Number(s.bavail) * blockSize;
    const used = total - available;
    if (!Number.isFinite(total) || total <= 0) return null;
    return {
      totalGB: total / 1024 ** 3,
      usedGB: used / 1024 ** 3,
      freeGB: available / 1024 ** 3,
      percent: (used / total) * 100,
    };
  } catch (_) {
    return null;
  }
}

function readTemperature() {
  const candidates = [];
  function addTempFile(file) {
    try {
      const raw = Number(fs.readFileSync(file, 'utf8').trim());
      const value = raw > 1000 ? raw / 1000 : raw;
      if (Number.isFinite(value) && value > 0 && value < 125) candidates.push(value);
    } catch (_) {}
  }

  try {
    for (const name of fs.readdirSync('/sys/class/thermal')) {
      if (/^thermal_zone\d+$/.test(name)) addTempFile(path.join('/sys/class/thermal', name, 'temp'));
    }
  } catch (_) {}
  try {
    for (const hwmon of fs.readdirSync('/sys/class/hwmon')) {
      const dir = path.join('/sys/class/hwmon', hwmon);
      for (const file of fs.readdirSync(dir)) {
        if (/^temp\d+_input$/.test(file)) addTempFile(path.join(dir, file));
      }
    }
  } catch (_) {}
  return candidates.length ? Number(Math.max(...candidates).toFixed(1)) : null;
}

const procMetrics = runtime.metrics;
function findCachedServerPid() { return procMetrics.pid(); }
function processFastStats() { return procMetrics.stats(); }
function processOpenFiles(pid) { return procMetrics.openFiles(pid); }
function getJavaRuntimeStats(pid) { return procMetrics.javaStats(pid); }

function takeNetworkSample() {
  let rx = 0;
  let tx = 0;
  try {
    const lines = fs.readFileSync('/proc/net/dev', 'utf8').split(/\r?\n/).slice(2);
    for (const line of lines) {
      if (!line.includes(':')) continue;
      const [ifaceRaw, dataRaw] = line.split(':');
      const iface = ifaceRaw.trim();
      if (!iface || iface === 'lo') continue;
      const parts = dataRaw.trim().split(/\s+/).map(Number);
      rx += parts[0] || 0;
      tx += parts[8] || 0;
    }
  } catch (_) {}
  return { rx, tx, at: Date.now() };
}

function networkStats() {
  const current = takeNetworkSample();
  const prev = previousNetSample || current;
  const dt = Math.max(0.001, (current.at - prev.at) / 1000);
  const rxBps = Math.max(0, (current.rx - prev.rx) / dt);
  const txBps = Math.max(0, (current.tx - prev.tx) / dt);
  previousNetSample = current;
  return {
    rxBps,
    txBps,
    rxTotal: current.rx,
    txTotal: current.tx,
  };
}

function playerStats() {
  return tracker.stats(Number(readServerProperties()['max-players']) || null);
}

function ema(prev, next, alpha) {
  const n = Number(next);
  if (!Number.isFinite(n)) return Number.isFinite(Number(prev)) ? Number(prev) : null;
  if (!Number.isFinite(Number(prev))) return n;
  return Number(prev) + (n - Number(prev)) * alpha;
}

function alphaFor(dtMs, tauMs) {
  return Math.max(0.02, Math.min(1, 1 - Math.exp(-Math.max(1, dtMs) / tauMs)));
}

function decorateFastSample(sample) {
  sample.seq = ++rawSampleSeq;
  const prev = smoothState;
  const dt = prev?.at ? Math.max(1, sample.at - prev.at) : FAST_SAMPLE_MS;
  const cpuA = alphaFor(dt, 420);
  const coreA = alphaFor(dt, 320);
  const ramA = alphaFor(dt, 900);
  const netA = alphaFor(dt, 320);
  const procA = alphaFor(dt, 450);
  const ioA = alphaFor(dt, 500);
  const cores = (sample.cpu?.perCore || []).map((v, i) => ema(prev?.cores?.[i], v, coreA));
  const smooth = {
    at: sample.at,
    cpu: ema(prev?.cpu, sample.cpu?.usage, cpuA),
    cores,
    ram: ema(prev?.ram, sample.memory?.percent, ramA),
    ramUsedGB: ema(prev?.ramUsedGB, sample.memory?.usedGB, ramA),
    rx: ema(prev?.rx, sample.network?.rxBps, netA),
    tx: ema(prev?.tx, sample.network?.txBps, netA),
    procCpu: ema(prev?.procCpu, sample.server?.cpuPercent, procA),
    procRam: ema(prev?.procRam, sample.server?.rssMB, ramA),
    procRead: ema(prev?.procRead, sample.server?.readBps, ioA),
    procWrite: ema(prev?.procWrite, sample.server?.writeBps, ioA),
  };
  smoothState = smooth;
  sample.smooth = smooth;
  return sample;
}

function fastSystemSample() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const cpu = cpuUsage();

  return {
    at: Date.now(),
    cpu,
    memory: {
      totalGB: totalMem / 1024 ** 3,
      usedGB: usedMem / 1024 ** 3,
      freeGB: freeMem / 1024 ** 3,
      percent: (usedMem / totalMem) * 100,
    },
    network: networkStats(),
    server: processFastStats(),
    players: players.size,
  };
}

function summarize(samples, getter, digits = 1) {
  const values = [];
  for (const sample of samples) {
    const value = Number(getter(sample));
    if (Number.isFinite(value)) values.push(value);
  }
  if (!values.length) return { avg: null, min: null, max: null, current: null };
  const round = (value) => Number(value.toFixed(digits));
  return {
    avg: round(values.reduce((sum, value) => sum + value, 0) / values.length),
    min: round(Math.min(...values)),
    max: round(Math.max(...values)),
    current: round(values[values.length - 1]),
  };
}

function summarizePerCore(samples) {
  const coreCount = samples.reduce((max, sample) => Math.max(max, sample.cpu?.perCore?.length || 0), 0);
  const avg = [];
  const min = [];
  const max = [];
  const current = [];
  for (let i = 0; i < coreCount; i++) {
    const summary = summarize(samples, (sample) => sample.cpu?.perCore?.[i], 1);
    avg.push(summary.avg ?? 0);
    min.push(summary.min ?? 0);
    max.push(summary.max ?? 0);
    current.push(summary.current ?? 0);
  }
  return { avg, min, max, current };
}

function latestNonNull(samples, getter) {
  for (let i = samples.length - 1; i >= 0; i--) {
    const value = getter(samples[i]);
    if (value != null) return value;
  }
  return null;
}

function buildAggregatedStats(samples) {
  if (!samples.length) samples = [fastSystemSample()];

  const sampledAt = Date.now();
  const first = samples[0];
  const last = samples[samples.length - 1];
  const cpu = summarize(samples, (sample) => sample.cpu?.usage, 1);
  const cores = summarizePerCore(samples);
  const memPercent = summarize(samples, (sample) => sample.memory?.percent, 1);
  const memUsed = summarize(samples, (sample) => sample.memory?.usedGB, 2);
  const netRx = summarize(samples, (sample) => sample.network?.rxBps, 0);
  const netTx = summarize(samples, (sample) => sample.network?.txBps, 0);
  const procCpu = summarize(samples, (sample) => sample.server?.cpuPercent, 1);
  const procRam = summarize(samples, (sample) => sample.server?.rssMB, 1);
  const procRead = summarize(samples, (sample) => sample.server?.readBps, 0);
  const procWrite = summarize(samples, (sample) => sample.server?.writeBps, 0);
  const proc = latestNonNull(samples, (sample) => sample.server);
  const cpus = os.cpus();
  const disk = diskStats();
  const props = readServerProperties();
  const load = os.loadavg();
  const javaRuntime = getJavaRuntimeStats(proc?.pid);
  const features = scanFeatures();
  const health = buildHealthSnapshot({ cpu: cpu.avg, memory: memPercent.avg, disk: disk?.percent });

  return {
    sampledAt,
    sampleWindow: {
      sampleMs: FAST_SAMPLE_MS,
      publishMs: PUBLISH_MS,
      count: samples.length,
      from: first.at,
      to: last.at,
    },
    cpu: {
      usage: cpu.avg,
      current: cpu.current,
      min: cpu.min,
      max: cpu.max,
      perCore: cores.avg,
      perCoreCurrent: cores.current,
      perCoreMin: cores.min,
      perCoreMax: cores.max,
      cores: cpus.length,
      model: cpus[0]?.model?.trim() || 'unknown',
      speedMHz: cpus[0]?.speed || null,
      temperatureC: readTemperature(),
    },
    memory: {
      totalGB: Number((last.memory.totalGB).toFixed(2)),
      usedGB: memUsed.current,
      usedAvgGB: memUsed.avg,
      freeGB: Number((last.memory.freeGB).toFixed(2)),
      percent: memPercent.avg,
      current: memPercent.current,
      min: memPercent.min,
      max: memPercent.max,
    },
    disk: disk ? {
      totalGB: Number(disk.totalGB.toFixed(2)),
      usedGB: Number(disk.usedGB.toFixed(2)),
      freeGB: Number(disk.freeGB.toFixed(2)),
      percent: Number(disk.percent.toFixed(1)),
    } : null,
    network: {
      rxBps: netRx.avg ?? 0,
      txBps: netTx.avg ?? 0,
      rxCurrentBps: netRx.current ?? 0,
      txCurrentBps: netTx.current ?? 0,
      rxMinBps: netRx.min ?? 0,
      txMinBps: netTx.min ?? 0,
      rxPeakBps: netRx.max ?? 0,
      txPeakBps: netTx.max ?? 0,
      rxTotal: last.network.rxTotal,
      txTotal: last.network.txTotal,
    },
    load: load.map((value) => Number(value.toFixed(2))),
    system: {
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      uptimeSec: Math.floor(os.uptime()),
      panelUptimeSec: Math.floor((Date.now() - panelStartedAt) / 1000),
      node: process.version,
      cpus: cpus.length,
    },
    server: proc ? {
      pid: proc.pid,
      launcherPid: proc.launcherPid,
      cpuPercent: procCpu.avg,
      cpuCurrent: procCpu.current,
      cpuMin: procCpu.min,
      cpuMax: procCpu.max,
      rssMB: procRam.current,
      rssAvgMB: procRam.avg,
      rssMinMB: procRam.min,
      rssMaxMB: procRam.max,
      threads: proc.threads,
      openFiles: processOpenFiles(proc.pid),
      readBps: procRead.avg,
      writeBps: procWrite.avg,
      readCurrentBps: procRead.current,
      writeCurrentBps: procWrite.current,
      readBytes: proc.readBytes,
      writeBytes: proc.writeBytes,
      voluntaryCtx: proc.voluntaryCtx,
      involuntaryCtx: proc.involuntaryCtx,
      java: javaRuntime,
    } : null,
    minecraft: {
      motd: props.motd || null,
      port: Number(props['server-port']) || 25565,
      difficulty: props.difficulty || null,
      gamemode: props.gamemode || null,
      viewDistance: Number(props['view-distance']) || null,
      simulationDistance: Number(props['simulation-distance']) || null,
      pvp: props.pvp == null ? null : props.pvp === 'true',
      whitelist: props['white-list'] == null ? null : props['white-list'] === 'true',
      version: minecraftVersion,
      tps: lastTps,
      mspt: lastMspt,
      world: lastWorldStats,
      features,
      lag: { warningCount: lagWarningCount, last: lastLagWarning },
    },
    health,
    crash: lastCrash ? { at: lastCrash.at, code: lastCrash.code, signal: lastCrash.signal, reason: lastCrash.reason, runtimeMs: lastCrash.runtimeMs } : null,
    restartPlan: currentRestartPlanState(),
    players: playerStats(),
    panel: {
      eventClients: clients.size,
      tailClients: tailListeners.size,
      bufferedLines: ringBuffer.length,
      cacheWindowMs: CACHE_WINDOW_MS,
      snapshotWindowMs: SNAPSHOT_WINDOW_MS,
      rawCacheSamples: rawSampleCache.length,
      latestRawSeq: rawSampleSeq,
      consoleCacheLines: recentConsole.length,
      instanceId: INSTANCE_ID,
    },
  };
}


function buildClientSampleSeries(samples) {
  if (!samples?.length) return [];
  const firstAt = samples[0]?.at || Date.now();
  return samples.map((sample) => ({
    seq: sample.seq,
    at: sample.at,
    offsetMs: Math.max(0, (sample.at || firstAt) - firstAt),
    cpu: Number.isFinite(Number(sample.cpu?.usage)) ? Number(sample.cpu.usage) : null,
    cpuSmooth: Number.isFinite(Number(sample.smooth?.cpu)) ? Number(sample.smooth.cpu.toFixed(2)) : null,
    cores: Array.isArray(sample.cpu?.perCore) ? sample.cpu.perCore : [],
    coresSmooth: Array.isArray(sample.smooth?.cores) ? sample.smooth.cores.map((v) => Number(v.toFixed(2))) : [],
    ram: Number.isFinite(Number(sample.memory?.percent)) ? Number(Number(sample.memory.percent).toFixed(2)) : null,
    ramSmooth: Number.isFinite(Number(sample.smooth?.ram)) ? Number(sample.smooth.ram.toFixed(2)) : null,
    ramUsedGB: Number.isFinite(Number(sample.memory?.usedGB)) ? Number(Number(sample.memory.usedGB).toFixed(3)) : null,
    ramUsedSmoothGB: Number.isFinite(Number(sample.smooth?.ramUsedGB)) ? Number(sample.smooth.ramUsedGB.toFixed(3)) : null,
    rx: Number.isFinite(Number(sample.network?.rxBps)) ? Math.round(Number(sample.network.rxBps)) : 0,
    rxSmooth: Number.isFinite(Number(sample.smooth?.rx)) ? Math.round(Number(sample.smooth.rx)) : 0,
    tx: Number.isFinite(Number(sample.network?.txBps)) ? Math.round(Number(sample.network.txBps)) : 0,
    txSmooth: Number.isFinite(Number(sample.smooth?.tx)) ? Math.round(Number(sample.smooth.tx)) : 0,
    procCpu: sample.server?.cpuPercent != null && Number.isFinite(Number(sample.server.cpuPercent)) ? Number(Number(sample.server.cpuPercent).toFixed(2)) : null,
    procCpuSmooth: sample.smooth?.procCpu != null && Number.isFinite(Number(sample.smooth.procCpu)) ? Number(sample.smooth.procCpu.toFixed(2)) : null,
    procRam: sample.server?.rssMB != null && Number.isFinite(Number(sample.server.rssMB)) ? Number(Number(sample.server.rssMB).toFixed(2)) : null,
    procRamSmooth: sample.smooth?.procRam != null && Number.isFinite(Number(sample.smooth.procRam)) ? Number(sample.smooth.procRam.toFixed(2)) : null,
    procRead: sample.server?.readBps != null && Number.isFinite(Number(sample.server.readBps)) ? Math.round(Number(sample.server.readBps)) : null,
    procReadSmooth: sample.smooth?.procRead != null && Number.isFinite(Number(sample.smooth.procRead)) ? Math.round(Number(sample.smooth.procRead)) : null,
    procWrite: sample.server?.writeBps != null && Number.isFinite(Number(sample.server.writeBps)) ? Math.round(Number(sample.server.writeBps)) : null,
    procWriteSmooth: sample.smooth?.procWrite != null && Number.isFinite(Number(sample.smooth.procWrite)) ? Math.round(Number(sample.smooth.procWrite)) : null,
    players: Number.isFinite(Number(sample.players)) ? Number(sample.players) : players.size,
  }));
}

function collectFastSample() {
  try {
    fastSamples.push(decorateFastSample(fastSystemSample()));
    const maxBufferedSamples = Math.ceil((PUBLISH_MS / FAST_SAMPLE_MS) * 3);
    if (fastSamples.length > maxBufferedSamples) {
      fastSamples.splice(0, fastSamples.length - maxBufferedSamples);
    }
  } catch (err) {
    console.error('fast stats sample failed:', err);
  }
}

function aggregateHistoryBucket(points) {
  if (!points.length) return null;
  const avg = (key) => {
    const vals = points.map((p) => Number(p[key])).filter(Number.isFinite);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  return {
    t: points[points.length - 1].t,
    samples: points.reduce((sum, p) => sum + (Number(p.samples) || 0), 0),
    cpu: avg('cpu'), ram: avg('ram'), disk: avg('disk'), procCpu: avg('procCpu'), procRam: avg('procRam'),
    rx: avg('rx'), tx: avg('tx'), players: avg('players'),
  };
}

function pushHistoryTiers(point) {
  history5sBucket.push(point);
  history1mBucket.push(point);
  if (history5sBucket.length >= 5) {
    const p = aggregateHistoryBucket(history5sBucket.splice(0, history5sBucket.length));
    if (p) history5s.push(p);
    if (history5s.length > HISTORY_5S_MAX) history5s.shift();
  }
  if (history1mBucket.length >= 60) {
    const p = aggregateHistoryBucket(history1mBucket.splice(0, history1mBucket.length));
    if (p) history1m.push(p);
    if (history1m.length > HISTORY_1M_MAX) history1m.shift();
    if (p) {
      history10mBucket.push(p);
      if (history10mBucket.length >= 10) {
        const q = aggregateHistoryBucket(history10mBucket.splice(0, history10mBucket.length));
        if (q) history10m.push(q);
        if (history10m.length > HISTORY_10M_MAX) history10m.shift();
      }
    }
  }
}

function publishAggregatedStats() {
  try {
    const samples = fastSamples.length ? fastSamples.splice(0, fastSamples.length) : [decorateFastSample(fastSystemSample())];
    const sampleSeries = buildClientSampleSeries(samples);
    rawSampleCache.push(...sampleSeries);
    trimRawSampleCache();
    trimRecentConsole();

    latestStats = buildAggregatedStats(samples);
    const historyPoint = {
      t: latestStats.sampledAt,
      samples: latestStats.sampleWindow.count,
      cpu: latestStats.cpu.usage,
      cpuCurrent: latestStats.cpu.current,
      cpuMin: latestStats.cpu.min,
      cpuMax: latestStats.cpu.max,
      ram: latestStats.memory.percent,
      ramCurrent: latestStats.memory.current,
      ramMin: latestStats.memory.min,
      ramMax: latestStats.memory.max,
      disk: latestStats.disk?.percent ?? null,
      procCpu: latestStats.server?.cpuPercent ?? 0,
      procCpuMax: latestStats.server?.cpuMax ?? 0,
      procRam: latestStats.server?.rssMB ?? 0,
      rx: latestStats.network.rxBps,
      rxPeak: latestStats.network.rxPeakBps,
      tx: latestStats.network.txBps,
      txPeak: latestStats.network.txPeakBps,
      players: latestStats.players.online,
    };
    history.push(historyPoint);
    if (history.length > HISTORY_MAX) history.shift();
    pushHistoryTiers(historyPoint);

    broadcastEvent('stats', {
      instanceId: INSTANCE_ID,
      serverTime: Date.now(),
      seq: ++statsSeq,
      sampleSeq: { from: sampleSeries[0]?.seq ?? rawSampleSeq, to: sampleSeries[sampleSeries.length - 1]?.seq ?? rawSampleSeq },
      running: !!child,
      startedAt,
      now: Date.now(),
      lastExitAt,
      restartCount,
      phase: serverPhase,
      readyAt,
      startupDurationMs,
      lastReadyAt,
      lastStartupDurationMs,
      stats: latestStats,
      samples: sampleSeries,
    });
  } catch (err) {
    console.error('stats publish failed:', err);
  }
}

function buildSnapshot(view = FULL_VIEW) {
  trimRawSampleCache();
  trimRecentConsole();
  if (!latestStats) latestStats = buildAggregatedStats([decorateFastSample(fastSystemSample())]);
  const now = Date.now();
  const recentSamples = rawSampleCache.filter((sample) => sample.at >= now - SNAPSHOT_WINDOW_MS);
  const console = recentConsole.filter((entry) => entry.at >= now - SNAPSHOT_WINDOW_MS);
  return {
    instanceId: INSTANCE_ID,
    serverTime: now,
    seq: { stats: statsSeq, console: consoleSeq, sample: rawSampleSeq },
    running: !!child,
    startedAt,
    lastExitAt,
    restartCount,
    phase: serverPhase,
    readyAt,
    startupDurationMs,
    lastReadyAt,
    lastStartupDurationMs,
    stats: latestStats,
    history,
    historyTiers: { oneSecond: history, fiveSecond: history5s, oneMinute: history1m, tenMinute: history10m },
    recentSamples,
    console: view.console ? console : [],
    settings: buildSettingsState(),
    timeline: timelineEvents.slice(-500),
    audit: view.audit ? auditEntries.slice(-500) : [],
    restartPlan: currentRestartPlanState(),
    crash: lastCrash,
    sleeping: sleeping(),
    features: scanFeatures(),
    cache: {
      windowMs: CACHE_WINDOW_MS,
      snapshotWindowMs: SNAPSHOT_WINDOW_MS,
      sampleMs: FAST_SAMPLE_MS,
      publishMs: PUBLISH_MS,
      rawFromSeq: rawSampleCache[0]?.seq ?? rawSampleSeq,
      rawToSeq: rawSampleCache[rawSampleCache.length - 1]?.seq ?? rawSampleSeq,
    },
  };
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

function serveIndex(res) {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'));
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

const FULL_VIEW = { console: true, audit: true };
function viewOf(req) {
  const h = req.headers['x-meow-caps'];
  if (h === undefined) return FULL_VIEW;
  const caps = String(h).split(',');
  return { console: caps.includes('console'), audit: caps.includes('settings') };
}

function requiredCap(method, p) {
  if (method === 'GET' && (p === '/log' || p === '/api/player-history')) return 'console';
  if (p.startsWith('/api/modrinth')) return 'mods';
  if (p.startsWith('/api/files')) return 'files';
  if (p.startsWith('/api/backups/') && method === 'GET') return 'backups';
  if (method === 'GET' || method === 'HEAD') return 'view';
  if (p === '/start' || p === '/stop' || p === '/restart' || p === '/force-stop' || p === '/api/restart-plan') return 'power';
  if (p === '/command' || p === '/player-action') return 'console';
  if (p === '/api/mods/toggle') return 'mods';
  if (p === '/api/backup' || p.startsWith('/api/backups')) return 'backups';
  return 'settings';
}

const PAGE_ROUTES = new Set(['/', '/overview', '/manage', '/schedule', '/performance', '/players', '/console', '/settings', '/mods', '/files', '/access', '/backups', '/automation', '/events', '/system']);

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (_) { res.writeHead(400); res.end('bad request'); return; }

  // The controller sends the caller's capabilities for this instance in
  // x-meow-caps. Only the controller can reach this worker (127.0.0.1), so
  // the header is trusted; direct local access has no header and is unrestricted.
  if (req.headers['x-meow-caps'] !== undefined) {
    const caps = String(req.headers['x-meow-caps']).split(',').filter(Boolean);
    const need = requiredCap(req.method, url.pathname);
    if (!caps.includes(need)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `missing permission: ${need}` }));
      return;
    }
  }

  if (PAGE_ROUTES.has(url.pathname) && req.method === 'GET') {
    serveIndex(res);
    return;
  }

  if (url.pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    res.view = viewOf(req);
    res.write(`event: snapshot\ndata: ${JSON.stringify(buildSnapshot(res.view))}\n\n`);
    clients.add(res);

    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(res);
    });
    return;
  }

  if (url.pathname === '/snapshot' && req.method === 'GET') {
    sendJson(res, 200, buildSnapshot(viewOf(req)));
    return;
  }

  if (url.pathname === '/status' && req.method === 'GET') {
    if (!latestStats) latestStats = buildAggregatedStats([fastSystemSample()]);
    sendJson(res, 200, {
      running: !!child,
      startedAt,
      now: Date.now(),
      lastExitAt,
      restartCount,
      phase: serverPhase,
      readyAt,
      startupDurationMs,
      lastReadyAt,
      lastStartupDurationMs,
      stats: latestStats,
      restartPlan: currentRestartPlanState(),
      crash: lastCrash,
      sleeping: sleeping(),
      features: scanFeatures(),
    });
    return;
  }

  if (url.pathname === '/history' && req.method === 'GET') {
    sendJson(res, 200, { sampleMs: FAST_SAMPLE_MS, publishMs: PUBLISH_MS, oneSecond: history, fiveSecond: history5s, oneMinute: history1m, tenMinute: history10m });
    return;
  }

  if (url.pathname === '/api/time' && req.method === 'GET') {
    sendJson(res, 200, { serverTime: Date.now(), instanceId: INSTANCE_ID, sampleSeq: rawSampleSeq, consoleSeq });
    return;
  }

  if (url.pathname === '/api/recover' && req.method === 'GET') {
    trimRawSampleCache();
    trimRecentConsole();
    const afterSampleSeq = Math.max(0, Number(url.searchParams.get('afterSampleSeq')) || 0);
    const afterConsoleSeq = Math.max(0, Number(url.searchParams.get('afterConsoleSeq')) || 0);
    const rawFromSeq = rawSampleCache[0]?.seq ?? rawSampleSeq;
    const consoleFromSeq = recentConsole[0]?.seq ?? consoleSeq;
    const sampleTruncated = afterSampleSeq > 0 && afterSampleSeq < rawFromSeq - 1;
    const consoleTruncated = afterConsoleSeq > 0 && afterConsoleSeq < consoleFromSeq - 1;
    const samples = rawSampleCache.filter((sample) => sample.seq > afterSampleSeq);
    const view = viewOf(req);
    const console = view.console ? recentConsole.filter((entry) => entry.seq > afterConsoleSeq) : [];
    sendJson(res, 200, {
      instanceId: INSTANCE_ID,
      serverTime: Date.now(),
      seq: { stats: statsSeq, sample: rawSampleSeq, console: consoleSeq },
      truncated: { samples: sampleTruncated, console: consoleTruncated },
      samples,
      console,
      stats: latestStats,
      historyTiers: { oneSecond: history, fiveSecond: history5s, oneMinute: history1m, tenMinute: history10m },
      lifecycle: { running: !!child, startedAt, lastExitAt, restartCount, phase: serverPhase, readyAt, startupDurationMs, lastReadyAt, lastStartupDurationMs },
      timeline: timelineEvents.slice(-500),
      audit: view.audit ? auditEntries.slice(-500) : [],
      restartPlan: currentRestartPlanState(),
      crash: lastCrash,
      features: scanFeatures(),
    });
    return;
  }

  if (url.pathname === '/api/timeline' && req.method === 'GET') {
    sendJson(res, 200, { timeline: timelineEvents.slice(-1000), audit: viewOf(req).audit ? auditEntries.slice(-1000) : [] });
    return;
  }

  if (url.pathname === '/api/player-history' && req.method === 'GET') {
    try {
      const name = normalizePlayerName(url.searchParams.get('name'));
      const h = getPlayerHistory(name);
      sendJson(res, 200, { ...h, totalPlaySec: Math.floor((h.totalPlayMs + (h.activeSince ? Date.now() - h.activeSince : 0)) / 1000), online: players.has(name) });
    } catch (err) { sendJson(res, 400, { error: err.message }); }
    return;
  }

  if (url.pathname === '/api/restart-plan' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 16 * 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        if (data.action === 'cancel') { pushAudit('restart.cancel', 'server'); clearRestartPlan('cancelled by panel'); sendJson(res, 200, { ok: true, plan: null }); return; }
        const plan = scheduleRestart(data.delaySec ?? 10, data.reason || 'Scheduled restart', data.warnPlayers !== false);
        sendJson(res, 200, { ok: true, plan });
      } catch (err) { sendJson(res, 400, { ok: false, error: err.message || 'invalid restart plan' }); }
    });
    return;
  }

  if (url.pathname === '/force-stop' && req.method === 'POST') {
    sendJson(res, 200, { ok: forceStopServer() });
    return;
  }

  if (url.pathname === '/api/settings' && req.method === 'GET') {
    sendJson(res, 200, buildSettingsState());
    return;
  }

  if (url.pathname === '/api/settings' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) req.destroy();
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        const patch = parsed.settings || parsed;
        const state = applySettingsPatch(patch);
        pushAudit('settings.apply', 'server.properties', Object.entries(patch).map(([k,v]) => `${k}=${v}`).join(', ').slice(0, 500));
        pushTimeline('settings', 'Server settings changed', `${Object.keys(patch).length} setting${Object.keys(patch).length === 1 ? '' : 's'} updated`, 'info', { keys: Object.keys(patch) });
        sendJson(res, 200, { ok: true, settings: state });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err.message || 'invalid settings' });
      }
    });
    return;
  }

  if (url.pathname === '/player-action' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 16 * 1024) req.destroy();
    });
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        if (!child) { sendJson(res, 409, { ok: false, error: 'server is not running' }); return; }
        const player = normalizePlayerName(data.player);
        if (!players.has(player)) { sendJson(res, 409, { ok: false, error: 'player is no longer online' }); return; }
        const cmd = buildPlayerCommand(String(data.action || ''), player, data.value, data.reason);
        if (!sendCommand(cmd)) { sendJson(res, 409, { ok: false, error: 'server is not running' }); return; }
        pushAudit(`player.${data.action}`, player, data.reason || data.value || '');
        pushTimeline('player_action', `${data.action} · ${player}`, data.reason || data.value || '', ['ban','kick','kill','op','deop'].includes(data.action) ? 'warn' : 'info', { player, action: data.action });
        sendJson(res, 200, { ok: true, player, action: data.action });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err.message || 'invalid player action' });
      }
    });
    return;
  }

  if (url.pathname === '/start' && req.method === 'POST') {
    pushAudit('server.start', 'server');
    const started = startServer();
    if (!started && lastStartBlock) { sendJson(res, 409, { ok: false, error: lastStartBlock }); return; }
    sendJson(res, 200, { ok: started });
    return;
  }

  if (url.pathname === '/stop' && req.method === 'POST') {
    pushAudit('server.stop', 'server');
    sendJson(res, 200, { ok: stopServer('stop') });
    return;
  }

  if (url.pathname === '/restart' && req.method === 'POST') {
    sendJson(res, 200, { ok: restartServer('restart') });
    return;
  }

  if (url.pathname === '/command' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 16 * 1024) req.destroy();
    });
    req.on('end', () => {
      try {
        const { cmd } = JSON.parse(body);
        if (typeof cmd !== 'string' || !cmd.trim()) {
          sendJson(res, 400, { ok: false, error: 'missing command' });
          return;
        }
        if (!sendCommand(cmd.trim())) {
          sendJson(res, 409, { ok: false, error: 'server is not running' });
          return;
        }
        pushAudit('command.run', 'console', cmd.trim().slice(0, 300));
        sendJson(res, 200, { ok: true });
      } catch (_) {
        sendJson(res, 400, { ok: false, error: 'invalid json' });
      }
    });
    return;
  }

  if (url.pathname === '/tail' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    });
    ringBuffer.forEach((line) => res.write(`${line}\n`));
    const listener = (line) => res.write(`${line}\n`);
    tailListeners.add(listener);
    req.on('close', () => tailListeners.delete(listener));
    return;
  }

  if (url.pathname === '/log' && req.method === 'GET') {
    if (!fs.existsSync(LOG_FILE)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('no log yet');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': 'attachment; filename="server-log.txt"',
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(LOG_FILE).pipe(res);
    return;
  }

  if (url.pathname === '/api/config' && req.method === 'GET') {
    sendJson(res, 200, panelConfig);
    return;
  }

  if (url.pathname === '/api/schedule' && req.method === 'GET') {
    sendJson(res, 200, { tasks: (panelConfig.schedule || []).map((t) => ({ ...t, nextRunAt: scheduler.nextRunAt(t) })), now: Date.now() });
    return;
  }
  if (url.pathname === '/api/schedule' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 8 * 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const list = panelConfig.schedule || (panelConfig.schedule = []);
        const existing = data.id ? list.find((t) => t.id === data.id) : null;
        if (data.id && !existing) throw new Error('task not found');
        const task = scheduler.cleanTask(data, existing);
        const caps = String(req.headers['x-meow-caps'] || '');
        if (req.headers['x-meow-caps'] && !caps.split(',').includes(scheduler.ACTION_CAP[task.action.type])) throw new Error(`this action needs the ${scheduler.ACTION_CAP[task.action.type]} permission`);
        if (existing) list[list.indexOf(existing)] = task; else list.push(task);
        if (list.length > 50) throw new Error('too many tasks');
        savePanelConfig();
        pushAudit('schedule.save', 'server', task.name);
        sendJson(res, 200, { ok: true, task });
      } catch (err) { sendJson(res, 400, { ok: false, error: err.message || 'invalid task' }); }
    });
    return;
  }
  const schedMatch = url.pathname.match(/^\/api\/schedule\/([a-f0-9]+)(\/run)?$/);
  if (schedMatch && (req.method === 'DELETE' || (req.method === 'POST' && schedMatch[2]))) {
    const list = panelConfig.schedule || [];
    const task = list.find((t) => t.id === schedMatch[1]);
    if (!task) { sendJson(res, 404, { ok: false, error: 'task not found' }); return; }
    const caps = String(req.headers['x-meow-caps'] || '');
    const need = scheduler.ACTION_CAP[task.action.type];
    if (req.headers['x-meow-caps'] && !caps.split(',').includes(need)) { sendJson(res, 403, { ok: false, error: `missing permission: ${need}` }); return; }
    if (req.method === 'DELETE') {
      panelConfig.schedule = list.filter((t) => t !== task);
      savePanelConfig();
      pushAudit('schedule.delete', 'server', task.name);
      sendJson(res, 200, { ok: true });
    } else {
      sendJson(res, 200, { ok: true, result: runScheduledTask(task) });
    }
    return;
  }

  if (url.pathname === '/api/startup' && req.method === 'GET') {
    const detected = launchLib.readDetectedMemory(SERVER_DIR);
    sendJson(res, 200, {
      autoStart: !!panelConfig.autoStart,
      ramMinMB: panelConfig.ramMinMB || detected.ramMinMB,
      ramMaxMB: panelConfig.ramMaxMB || detected.ramMaxMB,
      jvmPreset: panelConfig.jvmPreset || 'default',
      extraJvmArgs: panelConfig.extraJvmArgs || '',
      javaPath: panelConfig.javaPath || '',
      cpuCores: panelConfig.cpuCores || 0,
      hardMemLimitMB: panelConfig.hardMemLimitMB || 0,
      hostRamMB: Math.round(os.totalmem() / 1048576),
      hostCores: os.cpus().length,
      java: { required: launchLib.requiredJavaMajor(INSTANCE_MC_VERSION), found: launchLib.javaMajor(panelConfig.javaPath), path: panelConfig.javaPath || '' },
      limitsMode: launchLib.limitsMode(panelConfig),
      limitsPossible: launchLib.cgroupAvailable() ? 'cgroup' : (launchLib.tasksetAvailable() ? 'taskset' : 'none'),
    });
    return;
  }

  if (url.pathname === '/api/config' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 16 * 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        if (typeof data.autoRestartEnabled === 'boolean') panelConfig.autoRestartEnabled = data.autoRestartEnabled;
        if (typeof data.autoRestartTime === 'string' && /^\d{2}:\d{2}$/.test(data.autoRestartTime)) panelConfig.autoRestartTime = data.autoRestartTime;
        if (Number.isFinite(data.autoRestartWarnSec)) panelConfig.autoRestartWarnSec = Math.max(0, Math.min(3600, Math.round(data.autoRestartWarnSec)));
        if (Number.isFinite(data.maxBackups)) panelConfig.maxBackups = Math.max(1, Math.min(100, Math.round(data.maxBackups)));
        if (Number.isFinite(data.backupIntervalHours)) { panelConfig.backupIntervalHours = Math.max(0.25, Math.min(168, Number(data.backupIntervalHours))); backupLib.rescheduleAutoBackup(backupDeps); }
        if (Number.isFinite(data.backupMinFreeGB)) panelConfig.backupMinFreeGB = Math.max(0, Math.min(1000, Number(data.backupMinFreeGB)));
        if (Number.isFinite(data.consoleBufferSize)) panelConfig.consoleBufferSize = Math.max(100, Math.min(50000, Math.round(data.consoleBufferSize)));
        if (typeof data.sleepEnabled === 'boolean') { panelConfig.sleepEnabled = data.sleepEnabled; zeroPlayersSinceMs = Date.now(); }
        if (Number.isFinite(data.sleepAfterMinutes)) panelConfig.sleepAfterMinutes = Math.max(1, Math.min(1440, Math.round(data.sleepAfterMinutes)));
        if (typeof data.crashAutoRestartEnabled === 'boolean') panelConfig.crashAutoRestartEnabled = data.crashAutoRestartEnabled;
        if (Number.isFinite(data.crashAutoRestartDelaySec)) panelConfig.crashAutoRestartDelaySec = Math.max(0, Math.min(600, Math.round(data.crashAutoRestartDelaySec)));
        if (Number.isFinite(data.maxCrashRestartsPerHour)) panelConfig.maxCrashRestartsPerHour = Math.max(1, Math.min(20, Math.round(data.maxCrashRestartsPerHour)));
        if (typeof data.autoStart === 'boolean') panelConfig.autoStart = data.autoStart;
        const caps = String(req.headers['x-meow-caps'] || '');
        const mayEditLaunch = !req.headers['x-meow-caps'] || caps.split(',').includes('files');
        const launchKeys = ['extraJvmArgs', 'javaPath'];
        if (launchKeys.some((k) => data[k] !== undefined && data[k] !== (panelConfig[k] || '')) && !mayEditLaunch) throw new Error('changing Java or JVM arguments needs the Files permission');
        if (data.ramMaxMB !== undefined) {
          const max = Math.round(Number(data.ramMaxMB));
          if (!Number.isFinite(max) || max < 512 || max > 262144) throw new Error('maximum memory must be between 512 and 262144 MB');
          const min = data.ramMinMB ? Math.round(Number(data.ramMinMB)) : Math.round(max / 2);
          if (!Number.isFinite(min) || min < 256 || min > max) throw new Error('minimum memory must be between 256 MB and the maximum');
          panelConfig.ramMaxMB = max;
          panelConfig.ramMinMB = min;
        }
        if (typeof data.jvmPreset === 'string') {
          if (!launchLib.PRESETS[data.jvmPreset]) throw new Error('unknown JVM preset');
          panelConfig.jvmPreset = data.jvmPreset;
        }
        if (typeof data.extraJvmArgs === 'string') {
          if (data.extraJvmArgs.length > 1000) throw new Error('JVM arguments are too long');
          launchLib.parseExtraArgs(data.extraJvmArgs);
          panelConfig.extraJvmArgs = data.extraJvmArgs.trim();
        }
        if (typeof data.javaPath === 'string') {
          const jp = data.javaPath.trim();
          if (jp) {
            if (!path.isAbsolute(jp) || path.basename(jp) !== 'java') throw new Error('Java path must be an absolute path to a "java" binary');
            fs.accessSync(jp, fs.constants.X_OK);
          }
          panelConfig.javaPath = jp;
        }
        if (data.cpuCores !== undefined) {
          const c = Number(data.cpuCores);
          if (!Number.isFinite(c) || c < 0 || c > os.cpus().length) throw new Error(`CPU cores must be between 0 and ${os.cpus().length}`);
          panelConfig.cpuCores = c;
        }
        if (data.hardMemLimitMB !== undefined) {
          const m = Math.round(Number(data.hardMemLimitMB));
          if (!Number.isFinite(m) || m < 0) throw new Error('invalid memory limit');
          panelConfig.hardMemLimitMB = m;
        }
        savePanelConfig();
        pushAudit('config.update', 'panel', Object.keys(data).join(', '));
        sendJson(res, 200, { ok: true, config: panelConfig });
      } catch (err) { sendJson(res, 400, { ok: false, error: err.message || 'invalid config' }); }
    });
    return;
  }

  if (url.pathname.startsWith('/api/files')) {
    const rel = url.searchParams.get('path') || '.';
    const bad = (err) => sendJson(res, err.status || 500, { ok: false, error: err.message });
    try {
      if (url.pathname === '/api/files' && req.method === 'GET') { sendJson(res, 200, filesApi.list(rel)); return; }
      if (url.pathname === '/api/files/content' && req.method === 'GET') { sendJson(res, 200, filesApi.read(rel)); return; }
      if (url.pathname === '/api/files/download' && req.method === 'GET') {
        const info = filesApi.fileInfo(rel);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${info.name.replace(/[\r\n"]/g, '_')}"`, 'Content-Length': info.size });
        fs.createReadStream(info.resolved).pipe(res);
        return;
      }
      if (url.pathname === '/api/files/save' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > filesApi.MAX_EDIT_BYTES * 2) req.destroy(); });
        req.on('end', () => {
          try {
            const data = JSON.parse(body || '{}');
            const saved = filesApi.write(String(data.path || ''), data.text, { expectedMtime: Number(data.mtime) });
            pushAudit('files.edit', path.basename(String(data.path || '')), path.dirname(String(data.path || '')));
            sendJson(res, 200, { ok: true, ...saved });
          } catch (err) { bad(err instanceof SyntaxError ? Object.assign(err, { status: 400, message: 'bad json' }) : err); }
        });
        return;
      }
      if (url.pathname === '/api/files/upload' && req.method === 'POST') {
        const name = url.searchParams.get('name') || '';
        const dest = filesApi.uploadTarget(rel, name);
        filesApi.receiveUpload(req, dest, (err, size) => {
          if (err) { sendJson(res, err.status || 500, { ok: false, error: err.message }); return; }
          pushAudit('files.upload', name, rel);
          sendJson(res, 200, { ok: true, name, sizeMB: +(size / 1024 / 1024).toFixed(2) });
        });
        return;
      }
      if (url.pathname === '/api/files' && req.method === 'DELETE') {
        const removed = filesApi.remove(rel);
        pushAudit('files.delete', removed.name, removed.dir);
        sendJson(res, 200, { ok: true });
        return;
      }
    } catch (err) { bad(err); return; }
  }

  if (url.pathname.startsWith('/api/modrinth')) {
    const mr = modrinth();
    const fail = (err) => sendJson(res, 502, { ok: false, error: err.message || 'Modrinth request failed' });
    if (url.pathname === '/api/modrinth/info' && req.method === 'GET') {
      sendJson(res, 200, { supported: mr.supported(), kinds: { mod: mr.supported('mod'), datapack: mr.supported('datapack'), resourcepack: mr.supported('resourcepack'), shader: mr.supported('shader'), modpack: mr.supported('modpack') }, loader: INSTANCE_LOADER, mcVersion: INSTANCE_MC_VERSION, kind: mr.type });
      return;
    }
    if (url.pathname === '/api/modrinth/search' && req.method === 'GET') {
      mr.search(url.searchParams.get('q') || '', url.searchParams.get('offset'), url.searchParams.get('sort'), url.searchParams.get('kind')).then((r) => sendJson(res, 200, r)).catch(fail);
      return;
    }
    if (url.pathname === '/api/modrinth/project' && req.method === 'GET') {
      mr.project(String(url.searchParams.get('id') || '')).then((r) => sendJson(res, 200, r)).catch(fail);
      return;
    }
    if (url.pathname === '/api/modrinth/img' && req.method === 'GET') {
      fetchImage(String(url.searchParams.get('u') || '')).then(({ type, buf }) => {
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Length': buf.length });
        res.end(buf);
      }).catch(() => { res.writeHead(404); res.end(); });
      return;
    }
    if (url.pathname === '/api/modrinth/versions' && req.method === 'GET') {
      mr.projectVersions(String(url.searchParams.get('project') || ''), url.searchParams.get('kind')).then((r) => sendJson(res, 200, { versions: r })).catch(fail);
      return;
    }
    if (url.pathname === '/api/modrinth/updates' && req.method === 'GET') {
      mr.updates().then((r) => sendJson(res, 200, r)).catch(fail);
      return;
    }
    if ((url.pathname === '/api/modrinth/install' || url.pathname === '/api/modrinth/update') && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 16 * 1024) req.destroy(); });
      req.on('end', () => {
        let data;
        try { data = JSON.parse(body || '{}'); } catch (_) { sendJson(res, 400, { ok: false, error: 'bad json' }); return; }
        const job = url.pathname.endsWith('/install')
          ? mr.install(String(data.projectId || ''), data.versionId ? String(data.versionId) : null, data.kind ? String(data.kind) : null)
          : mr.applyUpdates(data.all ? 'all' : (Array.isArray(data.files) ? data.files.map(String) : []));
        job.then((installed) => { pushAudit(url.pathname.endsWith('/install') ? 'mods.install' : 'mods.update', 'server', installed.filter((x) => x.file).map((x) => x.file).join(', ')); sendJson(res, 200, { ok: true, installed }); }).catch(fail);
      });
      return;
    }
    sendJson(res, 404, { ok: false, error: 'not found' });
    return;
  }

  if (url.pathname === '/api/mods' && req.method === 'GET') {
    try {
      const listDir = (dir) => {
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir)
          .filter((f) => f.endsWith('.jar'))
          .map((f) => {
            const st = fs.statSync(path.join(dir, f));
            // ctime reflects when the file was last placed into this folder
            // (rename on toggle updates it, unlike mtime) - closest proxy we
            // have for "added" without a dedicated manifest.
            return { name: f, sizeMB: +(st.size / 1024 / 1024).toFixed(2), addedAt: st.ctimeMs };
          })
          .sort((a, b) => b.addedAt - a.addedAt);
      };
      sendJson(res, 200, { enabled: listDir(MODS_DIR), disabled: listDir(DISABLED_MODS_DIR) });
    } catch (err) { sendJson(res, 500, { ok: false, error: err.message }); }
    return;
  }

  if (url.pathname === '/api/mods/toggle' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 16 * 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const name = String(data.name || '');
        if (!/^[a-zA-Z0-9._+ -]+\.jar$/.test(name)) throw new Error('invalid mod filename');
        const enable = !!data.enable;
        const from = enable ? DISABLED_MODS_DIR : MODS_DIR;
        const to = enable ? MODS_DIR : DISABLED_MODS_DIR;
        const src = path.join(from, name);
        if (!fs.existsSync(src)) throw new Error('mod not found in ' + (enable ? 'disabled_mods' : 'mods'));
        if (!fs.existsSync(to)) fs.mkdirSync(to, { recursive: true });
        fs.renameSync(src, path.join(to, name));
        pushAudit('mod.' + (enable ? 'enable' : 'disable'), name);
        pushTimeline('mod_toggle', `${enable ? 'Enabled' : 'Disabled'} mod`, name, 'info', { name, enable });
        sendJson(res, 200, { ok: true });
      } catch (err) { sendJson(res, 400, { ok: false, error: err.message || 'invalid mod toggle' }); }
    });
    return;
  }

  if (url.pathname === '/api/access' && req.method === 'GET') {
    sendJson(res, 200, accessApi.list());
    return;
  }

  if (url.pathname === '/api/access' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 16 * 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const player = accessApi.act(data.list, data.action, data.name, data.reason);
        pushAudit(`access.${data.list}.${data.action}`, player);
        pushTimeline('access', `${data.list} ${data.action}`, player, 'info', { list: data.list, action: data.action, name: player });
        sendJson(res, 200, { ok: true });
      } catch (err) { sendJson(res, 400, { ok: false, error: err.message || 'invalid access action' }); }
    });
    return;
  }

  if (url.pathname === '/api/server-icon' && req.method === 'GET') {
    if (!serverIcon.exists()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    fs.createReadStream(serverIcon.file).pipe(res);
    return;
  }
  if (url.pathname === '/api/server-icon' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 512 * 1024) req.destroy(); });
    req.on('end', () => {
      try {
        pushAudit('server.icon', 'server', serverIcon.apply(JSON.parse(body || '{}')));
        sendJson(res, 200, { ok: true });
      } catch (err) { sendJson(res, 400, { ok: false, error: err.message || 'invalid image' }); }
    });
    return;
  }

  if (url.pathname === '/api/backup-sync' && req.method === 'POST') {
    if (!backupLib.worldDirNames().length) { sendJson(res, 200, { ok: true, name: null, skipped: 'no world yet' }); return; }
    createBackup('pre-upgrade').then((ok) => {
      const newest = listBackups()[0];
      if (!ok || !newest) sendJson(res, 500, { ok: false, error: backupState.lastBackupError || 'the backup failed' });
      else sendJson(res, 200, { ok: true, name: newest.name });
    }).catch((err) => sendJson(res, 500, { ok: false, error: err.message }));
    return;
  }
  if (url.pathname === '/api/restore-sync' && req.method === 'POST') {
    const name = String(url.searchParams.get('name') || '');
    if (!BACKUP_NAME_RE.test(name) || !fs.existsSync(path.join(BACKUP_DIR, name))) { sendJson(res, 404, { ok: false, error: 'backup not found' }); return; }
    restoreBackup(name).then(() => sendJson(res, 200, { ok: true })).catch((err) => sendJson(res, 500, { ok: false, error: err.message }));
    return;
  }

  if (url.pathname.match(/^\/api\/backups\/[^/]+\/restore$/) && req.method === 'POST') {
    const name = safeDecode(url.pathname.split('/')[3]);
    if (!BACKUP_NAME_RE.test(name)) { sendJson(res, 400, { ok: false, error: 'invalid backup name' }); return; }
    if (!fs.existsSync(path.join(BACKUP_DIR, name))) { sendJson(res, 404, { ok: false, error: 'backup not found' }); return; }
    if (backupState.backupInProgress) { sendJson(res, 409, { ok: false, error: 'a backup is currently running' }); return; }
    restoreBackup(name).catch((err) => { /* already broadcast + logged inside restoreBackup */ });
    sendJson(res, 202, { ok: true });
    return;
  }

  if (url.pathname === '/api/backups' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ backups: listBackups(), inProgress: backupState.backupInProgress, lastBackupAt: backupState.lastBackupAt, lastBackupError: backupState.lastBackupError, maxBackups: panelConfig.maxBackups, autoIntervalMs: Math.max(0.25, Number(panelConfig.backupIntervalHours) || 6) * 60 * 60 * 1000 }));
    return;
  }

  if (url.pathname === '/api/backup' && req.method === 'POST') {
    if (backupState.backupInProgress) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'backup already in progress' }));
      return;
    }
    createBackup('manual');
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname.startsWith('/api/backups/') && req.method === 'GET') {
    const name = safeDecode(url.pathname.slice('/api/backups/'.length));
    if (!BACKUP_NAME_RE.test(name)) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('invalid backup name');
      return;
    }
    const file = path.join(BACKUP_DIR, name);
    if (!fs.existsSync(file)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('backup not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': name.endsWith('.zst') ? 'application/zstd' : 'application/gzip',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
    return;
  }

  if (url.pathname.startsWith('/api/backups/') && req.method === 'DELETE') {
    const name = safeDecode(url.pathname.slice('/api/backups/'.length));
    if (!BACKUP_NAME_RE.test(name)) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('invalid backup name');
      return;
    }
    const file = path.join(BACKUP_DIR, name);
    try { fs.unlinkSync(file); } catch (_) {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

setInterval(collectFastSample, FAST_SAMPLE_MS).unref();
setInterval(publishAggregatedStats, PUBLISH_MS).unref();
setInterval(() => { scanFeatures(); maybeProbePerformance(); }, 5000).unref();
collectFastSample();
latestStats = buildAggregatedStats(fastSamples);

// Bound to localhost only - reachable exclusively through the controller's
// reverse proxy at /instance/:id/, never directly from outside this host.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`panel listening on 127.0.0.1:${PORT}`);
});
