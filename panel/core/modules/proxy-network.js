// Which servers sit behind a Velocity proxy: reads and writes velocity.toml and the files of the linked servers.
const fs = require('fs');
const path = require('path');
const proxy = require('./proxy');

const NETWORK_FILE = 'panel-network.json';
const PAPER_CONFIG = path.join('config', 'paper-global.yml');
const LOCAL_HOST = '127.0.0.1';

const readText = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch (_) { return null; } };

function writeIfChanged(file, before, after) {
  if (before === after) return false;
  fs.writeFileSync(file, after);
  return true;
}

// Paper and Purpur from 1.19 on keep the proxy settings in config/paper-global.yml.
function backendSupport(inst) {
  if (inst.loader !== 'paper' && inst.loader !== 'purpur') {
    return { supported: false, reason: inst.loader === 'velocity' ? 'a proxy cannot sit behind another proxy' : 'needs a forwarding mod, which the panel does not set up yet' };
  }
  const m = /^(\d+)\.(\d+)/.exec(String(inst.mcVersion || ''));
  if (!m || !(Number(m[1]) > 1 || Number(m[2]) >= 19)) return { supported: false, reason: 'automatic setup needs Minecraft 1.19 or newer' };
  return { supported: true, reason: null };
}

function readStored(proxyDir) {
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(proxyDir, NETWORK_FILE), 'utf8'));
    return {
      servers: Array.isArray(saved.servers) ? saved.servers.filter((n) => typeof n === 'string') : [],
      tryOrder: Array.isArray(saved.tryOrder) ? saved.tryOrder.filter((n) => typeof n === 'string') : [],
      forcedHosts: saved.forcedHosts && typeof saved.forcedHosts === 'object' ? saved.forcedHosts : {},
    };
  } catch (_) { return { servers: [], tryOrder: [], forcedHosts: {} }; }
}

// proxyDir: folder of the proxy instance; instances: [{ name, loader, mcVersion, port, dir }] without the proxy itself.
function describe(proxyDir, instances) {
  const stored = readStored(proxyDir);
  const toml = readText(path.join(proxyDir, 'velocity.toml'));
  const live = toml ? proxy.readServers(toml) : { servers: [], tryOrder: [] };
  const backends = instances.map((inst) => {
    const support = backendSupport(inst);
    const linked = stored.servers.includes(inst.name);
    const entry = live.servers.find((s) => s.name === inst.name);
    return { name: inst.name, loader: inst.loader, mcVersion: inst.mcVersion, port: inst.port, ...support, linked, outOfSync: linked && (!entry || entry.port !== inst.port) };
  });
  return {
    backends,
    tryOrder: stored.tryOrder.filter((n) => stored.servers.includes(n)),
    forcedHosts: stored.forcedHosts,
    port: toml ? proxy.readBindPort(toml) : null,
    ready: toml !== null,
  };
}

function patchBackend(inst, secret, behind) {
  const yamlFile = path.join(inst.dir, PAPER_CONFIG);
  const yaml = readText(yamlFile);
  if (yaml === null) {
    if (!behind) return false;
    throw new Error('start this server once so it creates its configuration, then apply again');
  }
  const patched = proxy.withPaperVelocity(yaml, { secret, enabled: behind });
  if (patched === null) throw new Error('its paper-global.yml has no proxies.velocity section');
  const propsFile = path.join(inst.dir, 'server.properties');
  const props = readText(propsFile) || '';
  const a = writeIfChanged(yamlFile, yaml, patched);
  const b = writeIfChanged(propsFile, props, proxy.withBackendProperties(props, { behind }));
  return a || b;
}

// request: { servers: [names], tryOrder: [names], forcedHosts: { host: [names] } }
// Returns { changed: [server names that need a restart], proxyChanged, errors: [{ name, error }] }.
function apply(proxyDir, instances, request) {
  const tomlFile = path.join(proxyDir, 'velocity.toml');
  const toml = readText(tomlFile);
  if (toml === null) throw new Error('the proxy has not created velocity.toml yet, start it once');
  const byName = new Map(instances.map((i) => [i.name, i]));
  const previous = readStored(proxyDir).servers;
  const wanted = [...new Set(request.servers || [])];
  const errors = [];
  const changed = [];

  const secretFile = path.join(proxyDir, 'forwarding.secret');
  let secret = (readText(secretFile) || '').trim();
  if (!secret) { secret = proxy.newSecret(); fs.writeFileSync(secretFile, secret); }

  const linked = [];
  for (const name of wanted) {
    const inst = byName.get(name);
    if (!inst) { errors.push({ name, error: 'no such instance' }); continue; }
    const support = backendSupport(inst);
    if (!support.supported) { errors.push({ name, error: support.reason }); continue; }
    try {
      if (patchBackend(inst, secret, true)) changed.push(name);
      linked.push(inst);
    } catch (err) { errors.push({ name, error: err.message }); }
  }
  for (const name of previous) {
    const inst = byName.get(name);
    if (!inst || wanted.includes(name)) continue;
    try { if (patchBackend(inst, secret, false)) changed.push(name); } catch (err) { errors.push({ name, error: err.message }); }
  }

  const names = linked.map((i) => i.name);
  const tryOrder = (request.tryOrder || []).filter((n) => names.includes(n));
  if (!tryOrder.length && names.length) tryOrder.push(names[0]);
  const forcedHosts = {};
  for (const [host, targets] of Object.entries(request.forcedHosts || {})) {
    const kept = (Array.isArray(targets) ? targets : []).filter((n) => names.includes(n));
    if (kept.length) forcedHosts[host] = kept;
  }
  let next = proxy.withForwardingMode(toml, 'modern');
  next = proxy.withServers(next, linked.map((i) => ({ name: i.name, host: LOCAL_HOST, port: i.port })), tryOrder);
  next = proxy.withForcedHosts(next, forcedHosts, names);
  const proxyChanged = writeIfChanged(tomlFile, toml, next);
  fs.writeFileSync(path.join(proxyDir, NETWORK_FILE), JSON.stringify({ servers: names, tryOrder, forcedHosts }, null, 2));
  return { changed, proxyChanged, errors };
}

module.exports = { describe, apply, backendSupport };
