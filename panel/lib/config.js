// Server directory + all paths derived from it, and the persisted panel
// config (panel-config.json). Single source of truth so every other module
// requires this instead of recomputing paths.
const fs = require('fs');
const path = require('path');
const os = require('os');

const SERVER_DIR = process.env.MC_SERVER_DIR || path.join(os.homedir(), 'mc-server');

const LOG_FILE = path.join(SERVER_DIR, 'console.log');
const PROPERTIES_FILE = path.join(SERVER_DIR, 'server.properties');
const WORLD_DIR = path.join(SERVER_DIR, 'world');
const DATA_ROOT = process.env.MEOWMARISM_DATA_DIR || path.join(os.homedir(), 'meowmarism');
const BACKUP_DIR = process.env.MEOW_BACKUP_DIR || path.join(DATA_ROOT, 'backups', path.basename(SERVER_DIR));
const CONFIG_FILE = path.join(SERVER_DIR, 'panel-config.json');
const HISTORY_FILE = path.join(SERVER_DIR, 'panel-history.json');
const METRICS_FILE = path.join(SERVER_DIR, 'panel-metrics.json');
const INSTANCE_LOADER = process.env.MEOW_LOADER || '';
const INSTANCE_MC_VERSION = process.env.MEOW_MC_VERSION || '';
const MODS_DIR = path.join(SERVER_DIR, ['paper', 'purpur'].includes(INSTANCE_LOADER) ? 'plugins' : 'mods');
const DISABLED_MODS_DIR = path.join(SERVER_DIR, 'disabled_mods');
const WHITELIST_FILE = path.join(SERVER_DIR, 'whitelist.json');
const OPS_FILE = path.join(SERVER_DIR, 'ops.json');
const BANNED_PLAYERS_FILE = path.join(SERVER_DIR, 'banned-players.json');

const INSTANCES_FILE = path.join(os.homedir(), '.meowmarism-instances.json');

function defaultPanelConfig() {
  return {
    autoRestartEnabled: false,
    autoRestartTime: '04:00',
    autoRestartWarnSec: 300,
    lastAutoRestartDate: null,
    maxBackups: 10,
    backupIntervalHours: 6,
    backupMinFreeGB: 5,
    consoleBufferSize: 5000,
    sleepEnabled: false,
    sleepAfterMinutes: 20,
    crashAutoRestartEnabled: true,
    crashAutoRestartDelaySec: 15,
    maxCrashRestartsPerHour: 3,
    autoStart: false,
    ramMinMB: null,
    ramMaxMB: null,
    jvmPreset: 'default',
    extraJvmArgs: '',
    javaPath: '',
    cpuCores: 0,
    hardMemLimitMB: 0,
    schedule: [],
  };
}

function loadPanelConfig() {
  try { return { ...defaultPanelConfig(), ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; }
  catch (_) { return defaultPanelConfig(); }
}

// Exported as a live, mutable object - other modules do `config.panelConfig.x = y`
// and call saveConfig(), same mutation pattern the code already used before
// the split, just centralized here instead of duplicated per file.
const panelConfig = loadPanelConfig();

function saveConfig() {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(panelConfig, null, 2)); } catch (_) {}
}

// Re-reads panel-config.json and merges it into the existing panelConfig
// object in place, so callers holding the old reference stay in sync.
// Used before crash-restart decisions, since those must reflect the file
// even if it was edited outside the panel API since process start.
function reloadPanelConfig() {
  try {
    Object.assign(panelConfig, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
  } catch (_) { /* keep current in-memory values on read/parse failure */ }
  return panelConfig;
}

module.exports = {
  SERVER_DIR, LOG_FILE, PROPERTIES_FILE, WORLD_DIR, BACKUP_DIR, CONFIG_FILE,
  HISTORY_FILE, METRICS_FILE, MODS_DIR, DISABLED_MODS_DIR, WHITELIST_FILE, OPS_FILE,
  BANNED_PLAYERS_FILE, INSTANCES_FILE, INSTANCE_LOADER, INSTANCE_MC_VERSION,
  panelConfig, saveConfig, reloadPanelConfig, defaultPanelConfig,
};
