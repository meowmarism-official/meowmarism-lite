// Local user store: a small JSON-backed database of accounts with panel-wide permissions and per-instance capabilities.
//
// Accounts are "owner" (exactly one) or "member". What a member may do is a set of permissions:
// a few panel-wide ones plus instance capabilities, granted as a default and optionally overridden per instance.
const fs = require('fs');
const crypto = require('crypto');

const SCRYPT_KEYLEN = 64;

const PANEL_CAPS = ['users', 'create', 'update'];
const INSTANCE_CAPS = ['view', 'console', 'power', 'files', 'mods', 'backups', 'settings', 'remove'];
const PRESETS = {
  none: [],
  view: ['view'],
  operator: ['view', 'console', 'power'],
  manager: ['view', 'console', 'power', 'files', 'mods', 'backups', 'settings'],
  full: INSTANCE_CAPS,
};

function cleanCaps(caps) {
  const set = new Set(Array.isArray(caps) ? caps : []);
  if (set.size) set.add('view');
  return INSTANCE_CAPS.filter((c) => set.has(c));
}
function defaultAccess() { return { global: [], instances: {} }; }
function defaultPanel() { return { users: false, create: false, update: false }; }
function cleanPanel(panel) {
  return Object.fromEntries(PANEL_CAPS.map((c) => [c, !!panel?.[c]]));
}
function cleanAccess(access) {
  return {
    global: cleanCaps(access?.global),
    instances: Object.fromEntries(Object.entries(access?.instances || {}).map(([k, v]) => [k, cleanCaps(v)])),
  };
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

// Capabilities a user has on one instance: the per-instance override if set,
// else their default. The owner always has everything.
function effectiveCaps(user, instanceName) {
  if (!user) return [];
  if (user.role === 'owner') return INSTANCE_CAPS;
  const access = user.access || defaultAccess();
  return access.instances?.[instanceName] ?? access.global ?? [];
}
function hasPanelCap(user, cap) {
  if (!user) return false;
  if (user.role === 'owner') return true;
  return !!user.panel?.[cap];
}

function createUserStore(file) {
  function save(users) {
    fs.writeFileSync(file, JSON.stringify(users, null, 2), { mode: 0o600 });
  }
  function load() {
    let users;
    try { users = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (_) { return []; }
    return users;
  }
  const publicView = (u) => ({ username: u.username, role: u.role, createdAt: u.createdAt, panel: u.panel || defaultPanel(), access: u.access || defaultAccess() });

  function findUser(username) { return load().find((u) => u.username === username) || null; }
  function hasAnyUser() { return load().length > 0; }
  function hasOwner() { return load().some((u) => u.role === 'owner'); }
  function listUsers() { return load().map(publicView); }

  // First-time setup only: refuses if an owner already exists.
  function upsertOwner(username, password) {
    const users = load();
    if (users.some((u) => u.role === 'owner')) return false;
    const existing = users.find((u) => u.username === username);
    const passwordHash = hashPassword(password);
    if (existing) { existing.passwordHash = passwordHash; existing.role = 'owner'; }
    else users.push({ username, passwordHash, role: 'owner', createdAt: Date.now() });
    save(users);
    return true;
  }
  function createMember(username, password, settings = {}) {
    const users = load();
    if (users.some((u) => u.username === username)) return false;
    users.push({
      username, passwordHash: hashPassword(password), role: 'member', createdAt: Date.now(),
      panel: cleanPanel(settings.panel), access: cleanAccess(settings.access),
    });
    save(users);
    return true;
  }
  function resetOwner(username, password) {
    const users = load().filter((u) => u.role === 'owner' || u.username !== username);
    const owner = users.find((u) => u.role === 'owner');
    const passwordHash = hashPassword(password);
    if (owner) { owner.username = username; owner.passwordHash = passwordHash; }
    else users.push({ username, passwordHash, role: 'owner', createdAt: Date.now() });
    save(users);
    return true;
  }

  function setPassword(username, password) {
    const users = load();
    const target = users.find((u) => u.username === username);
    if (!target || target.role === 'owner') return false;
    target.passwordHash = hashPassword(password);
    save(users);
    return true;
  }
  function setSettings(username, settings) {
    const users = load();
    const target = users.find((u) => u.username === username);
    if (!target || target.role === 'owner') return false;
    if (settings.panel) target.panel = cleanPanel(settings.panel);
    if (settings.access) target.access = cleanAccess(settings.access);
    save(users);
    return true;
  }
  function deleteMember(username) {
    const users = load();
    const target = users.find((u) => u.username === username);
    if (!target || target.role === 'owner') return false;
    save(users.filter((u) => u.username !== username));
    return true;
  }
  function verifyUser(username, password) {
    const user = findUser(username);
    return user ? verifyPassword(password, user.passwordHash) : false;
  }
  return { findUser, hasAnyUser, hasOwner, listUsers, upsertOwner, resetOwner, createMember, setPassword, setSettings, deleteMember, verifyUser };
}

module.exports = { createUserStore, effectiveCaps, hasPanelCap, PANEL_CAPS, INSTANCE_CAPS, PRESETS };
