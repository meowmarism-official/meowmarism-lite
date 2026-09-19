// server.properties: the known settings with labels and limits, reading, validated writing and live application.
const fs = require('fs');

const SETTINGS_SCHEMA = {
  difficulty: { label: 'Difficulty', group: 'Gameplay', type: 'select', options: ['peaceful', 'easy', 'normal', 'hard'], default: 'easy', live: (v) => `difficulty ${v}`, description: 'World difficulty. Applies live.' },
  gamemode: { label: 'Default gamemode', group: 'Gameplay', type: 'select', options: ['survival', 'creative', 'adventure', 'spectator'], default: 'survival', live: (v) => `defaultgamemode ${v}`, description: 'Default mode for new / reconnecting players.' },
  hardcore: { label: 'Hardcore', group: 'Gameplay', type: 'boolean', default: false, restart: true, description: 'Hardcore world rules. Requires restart.' },
  pvp: { label: 'PvP', group: 'Gameplay', type: 'boolean', default: true, restart: true, description: 'Allow players to damage each other.' },
  'allow-flight': { label: 'Allow flight', group: 'Gameplay', type: 'boolean', default: false, restart: true, description: 'Prevents the server from kicking players for flying.' },
  'enable-command-block': { label: 'Command blocks', group: 'Gameplay', type: 'boolean', default: false, restart: true, description: 'Enable command block execution.' },
  'spawn-animals': { label: 'Spawn animals', group: 'World', type: 'boolean', default: true, restart: true, description: 'Natural animal spawning.' },
  'spawn-monsters': { label: 'Spawn monsters', group: 'World', type: 'boolean', default: true, restart: true, description: 'Natural hostile mob spawning.' },
  'spawn-npcs': { label: 'Spawn NPCs', group: 'World', type: 'boolean', default: true, restart: true, description: 'Allow villagers and similar NPCs.' },
  'allow-nether': { label: 'Allow Nether', group: 'World', type: 'boolean', default: true, restart: true, description: 'Enable Nether dimension access.' },
  'spawn-protection': { label: 'Spawn protection', group: 'World', type: 'number', min: 0, max: 128, step: 1, default: 16, restart: true, description: 'Protected radius around world spawn. 0 disables it.' },
  'max-players': { label: 'Max players', group: 'Players', type: 'number', min: 1, max: 1000, step: 1, default: 20, restart: true, description: 'Maximum simultaneous players.' },
  'white-list': { label: 'Whitelist', group: 'Players', type: 'boolean', default: false, live: (v) => `whitelist ${v ? 'on' : 'off'}`, description: 'Allow only whitelisted players. Applies live.' },
  'enforce-whitelist': { label: 'Enforce whitelist', group: 'Players', type: 'boolean', default: false, restart: true, description: 'Kick non-whitelisted players when whitelist is active.' },
  'player-idle-timeout': { label: 'Idle timeout', group: 'Players', type: 'number', min: 0, max: 1440, step: 1, suffix: 'min', default: 0, live: (v) => `setidletimeout ${v}`, description: 'Kick idle players after this many minutes. 0 disables it.' },
  'hide-online-players': { label: 'Hide online players', group: 'Players', type: 'boolean', default: false, restart: true, description: 'Hide player list from server status responses.' },
  'view-distance': { label: 'View distance', group: 'Performance', type: 'number', min: 2, max: 32, step: 1, suffix: 'chunks', default: 10, restart: true, description: 'How far chunks are sent to clients.' },
  'simulation-distance': { label: 'Simulation distance', group: 'Performance', type: 'number', min: 2, max: 32, step: 1, suffix: 'chunks', default: 10, restart: true, description: 'Radius in which entities and blocks tick.' },
  'entity-broadcast-range-percentage': { label: 'Entity broadcast range', group: 'Performance', type: 'number', min: 10, max: 1000, step: 10, suffix: '%', default: 100, restart: true, description: 'Multiplier for entity tracking range.' },
  'network-compression-threshold': { label: 'Compression threshold', group: 'Network', type: 'number', min: -1, max: 65535, step: 1, suffix: 'bytes', default: 256, restart: true, description: '-1 disables packet compression.' },
  'rate-limit': { label: 'Rate limit', group: 'Network', type: 'number', min: 0, max: 100000, step: 1, default: 0, restart: true, description: 'Packet rate limit. 0 disables it.' },
  'enable-status': { label: 'Server list status', group: 'Network', type: 'boolean', default: true, restart: true, description: 'Answer server-list status requests.' },
  motd: { label: 'MOTD', group: 'Identity', type: 'text', maxLength: 240, default: 'A Minecraft Server', restart: true, description: 'Text shown in the multiplayer server list.' },
  'resource-pack': { label: 'Resource pack URL', group: 'Identity', type: 'text', maxLength: 2048, default: '', restart: true, description: 'Optional server resource-pack URL.' },
  'resource-pack-required': { label: 'Require resource pack', group: 'Identity', type: 'boolean', default: false, restart: true, description: 'Require players to accept the configured resource pack.' },
  'online-mode': { label: 'Online mode', group: 'Access', type: 'boolean', default: true, restart: true, description: 'Verify player accounts with Mojang/Microsoft. Disabling this allows unverified names.' },
  'enforce-secure-profile': { label: 'Enforce secure profile', group: 'Access', type: 'boolean', default: true, restart: true, description: 'Require signed player profiles when supported by this server version.' },
  'prevent-proxy-connections': { label: 'Prevent proxy connections', group: 'Access', type: 'boolean', default: false, restart: true, description: 'Vanilla proxy-connection protection.' },
  'op-permission-level': { label: 'OP permission level', group: 'Access', type: 'number', min: 1, max: 4, step: 1, default: 4, restart: true, description: 'Default permission level granted to operators.' },
  'function-permission-level': { label: 'Function permission level', group: 'Access', type: 'number', min: 1, max: 4, step: 1, default: 2, restart: true, description: 'Permission level used by datapack functions.' },
  'server-port': { label: 'Minecraft port', group: 'Network', type: 'number', min: 1, max: 65535, step: 1, default: 25565, restart: true, description: 'Game server listen port. Changing it requires clients to use the new port.' },
  'use-native-transport': { label: 'Native transport', group: 'Network', type: 'boolean', default: true, restart: true, description: 'Use optimized native networking when available.' },
  'generate-structures': { label: 'Generate structures', group: 'World', type: 'boolean', default: true, restart: true, description: 'Generate villages, strongholds and other structures in new chunks.' },
  'max-world-size': { label: 'Max world size', group: 'World', type: 'number', min: 1, max: 29999984, step: 1, suffix: 'blocks', default: 29999984, restart: true, description: 'Maximum world border coordinate the server allows.' },
  'max-tick-time': { label: 'Watchdog max tick', group: 'Advanced', type: 'number', min: -1, max: 600000, step: 1000, suffix: 'ms', default: 60000, restart: true, description: 'Watchdog limit for a single tick. -1 disables the watchdog timeout.' },
  'max-chained-neighbor-updates': { label: 'Max chained neighbor updates', group: 'Advanced', type: 'number', min: -1, max: 10000000, step: 1, default: 1000000, restart: true, description: 'Limit for chained block neighbor updates. -1 disables the limit.' },
  'broadcast-console-to-ops': { label: 'Console output to OPs', group: 'Advanced', type: 'boolean', default: true, restart: true, description: 'Send console command output to online operators.' },
  'sync-chunk-writes': { label: 'Synchronous chunk writes', group: 'Advanced', type: 'boolean', default: true, restart: true, description: 'Vanilla chunk write behavior. Requires restart.' },
};

function parseSettingValue(key, raw) {
  const schema = SETTINGS_SCHEMA[key];
  if (!schema) throw new Error(`unsupported setting: ${key}`);

  if (schema.type === 'boolean') {
    if (raw === true || raw === 'true') return true;
    if (raw === false || raw === 'false') return false;
    throw new Error(`${key} must be true or false`);
  }

  if (schema.type === 'number') {
    const value = Number(raw);
    if (!Number.isFinite(value) || !Number.isInteger(value)) throw new Error(`${key} must be an integer`);
    if (schema.min != null && value < schema.min) throw new Error(`${key} must be >= ${schema.min}`);
    if (schema.max != null && value > schema.max) throw new Error(`${key} must be <= ${schema.max}`);
    return value;
  }

  const value = String(raw ?? '');
  if (schema.type === 'select' && !schema.options.includes(value)) throw new Error(`invalid value for ${key}`);
  if (schema.maxLength && value.length > schema.maxLength) throw new Error(`${key} is too long`);
  if (/[\r\n]/.test(value)) throw new Error(`${key} cannot contain line breaks`);
  return value;
}

function serializeSettingValue(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

// file: path of server.properties; isRunning(): bool; command(text): sends a console command
function createProperties({ file, isRunning, command }) {
  let seq = 0;
  const pending = new Set();

  function read() {
    const props = {};
    try {
      const raw = fs.readFileSync(file, 'utf8');
      for (const rawLine of raw.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const idx = line.indexOf('=');
        if (idx < 0) continue;
        props[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    } catch (_) {}
    return props;
  }

  function state() {
    const props = read();
    const values = {};
    for (const [key, schema] of Object.entries(SETTINGS_SCHEMA)) {
      const raw = Object.prototype.hasOwnProperty.call(props, key) ? props[key] : schema.default;
      try { values[key] = parseSettingValue(key, raw); }
      catch (_) { values[key] = schema.default; }
    }
    return {
      seq,
      values,
      pendingRestart: [...pending],
      fields: Object.entries(SETTINGS_SCHEMA).map(([key, schema]) => ({
        key, label: schema.label, group: schema.group, type: schema.type,
        options: schema.options || null, min: schema.min ?? null, max: schema.max ?? null,
        step: schema.step ?? null, suffix: schema.suffix || null, maxLength: schema.maxLength ?? null,
        restartRequired: !!schema.restart, liveApply: !!schema.live, description: schema.description || '',
      })),
    };
  }

  function write(changes) {
    const existing = fs.readFileSync(file, 'utf8');
    const eol = existing.includes('\r\n') ? '\r\n' : '\n';
    const lines = existing.split(/\r?\n/);
    const changed = new Set(Object.keys(changes));
    const out = lines.map((line) => {
      if (!line || /^\s*#/.test(line)) return line;
      const idx = line.indexOf('=');
      if (idx < 0) return line;
      const key = line.slice(0, idx).trim();
      if (!changed.has(key)) return line;
      changed.delete(key);
      return `${key}=${serializeSettingValue(changes[key])}`;
    });
    for (const key of changed) out.push(`${key}=${serializeSettingValue(changes[key])}`);
    const tmp = `${file}.panel-${process.pid}.tmp`;
    fs.writeFileSync(tmp, out.join(eol), { mode: 0o644 });
    fs.renameSync(tmp, file);
  }

  function apply(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('settings patch must be an object');
    const parsed = {};
    for (const [key, raw] of Object.entries(patch)) parsed[key] = parseSettingValue(key, raw);
    if (!Object.keys(parsed).length) return state();
    write(parsed);
    for (const [key, value] of Object.entries(parsed)) {
      const schema = SETTINGS_SCHEMA[key];
      if (schema.restart) {
        if (isRunning()) pending.add(key); else pending.delete(key);
      } else {
        pending.delete(key);
        if (schema.live && isRunning()) command(schema.live(value));
      }
    }
    seq++;
    return state();
  }

  return { read, state, apply, clearPending: () => pending.clear(), bump: () => { seq++; }, schema: SETTINGS_SCHEMA };
}

module.exports = { createProperties, SETTINGS_SCHEMA };
