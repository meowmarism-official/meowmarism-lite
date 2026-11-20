// API tokens for the optional HTTP API: random secrets shown once, only their hash is stored, each token has scopes.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCOPES = {
  read: 'Read status, players, metrics, diagnostics and settings',
  power: 'Start, stop, restart and force-stop servers',
  console: 'Read the console log and send commands, start a profile',
  settings: 'Change settings (restart-only ones are queued)',
  backups: 'List and create backups',
  files: 'Read files of an instance',
  events: 'Receive events and manage webhooks',
};

const TOKEN_FORMAT = /^mmk_([a-f0-9]{16})_([A-Za-z0-9_-]{32})$/;
const TOUCH_INTERVAL_MS = 60 * 1000;

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

// file: JSON path; now: clock for tests
function createApiTokens({ file, now = Date.now }) {
  let tokens = load();

  function load() {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(saved) ? saved.filter((t) => t && t.id && t.hash) : [];
    } catch (_) { return []; }
  }

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  const view = (t) => ({
    id: t.id, name: t.name, scopes: t.scopes, instances: t.instances, createdAt: t.createdAt,
    lastUsedAt: t.lastUsedAt, expiresAt: t.expiresAt,
  });

  // The returned token is the only time the secret exists in clear text.
  function create({ name, scopes, instances = null, expiresInDays = null }) {
    const label = String(name || '').trim();
    if (!label || label.length > 60) throw new Error('name must be 1 to 60 characters');
    const list = [...new Set(Array.isArray(scopes) ? scopes : [])];
    if (!list.length) throw new Error('pick at least one scope');
    const unknown = list.filter((s) => !SCOPES[s]);
    if (unknown.length) throw new Error(`unknown scope: ${unknown.join(', ')}`);
    let allow = null;
    if (instances != null) {
      if (!Array.isArray(instances) || instances.some((i) => typeof i !== 'string' || !i)) throw new Error('instances must be a list of names');
      allow = [...new Set(instances)];
      if (!allow.length) allow = null;
    }
    let expiresAt = null;
    if (expiresInDays != null) {
      const days = Number(expiresInDays);
      if (!Number.isFinite(days) || days <= 0 || days > 3650) throw new Error('expiry must be between 1 and 3650 days');
      expiresAt = now() + Math.round(days * 86400000);
    }
    const id = crypto.randomBytes(8).toString('hex');
    const secret = crypto.randomBytes(24).toString('base64url');
    const record = { id, name: label, scopes: list, instances: allow, createdAt: now(), lastUsedAt: null, expiresAt, hash: sha256(secret) };
    tokens.push(record);
    save();
    return { token: `mmk_${id}_${secret}`, ...view(record) };
  }

  // Returns the token record (without hash) or null for anything that is not a valid, unexpired token.
  function verify(raw) {
    const m = TOKEN_FORMAT.exec(String(raw || ''));
    if (!m) return null;
    const record = tokens.find((t) => t.id === m[1]);
    if (!record) return null;
    const given = Buffer.from(sha256(m[2]), 'hex');
    const stored = Buffer.from(record.hash, 'hex');
    if (given.length !== stored.length || !crypto.timingSafeEqual(given, stored)) return null;
    if (record.expiresAt && record.expiresAt <= now()) return null;
    if (!record.lastUsedAt || now() - record.lastUsedAt >= TOUCH_INTERVAL_MS) {
      record.lastUsedAt = now();
      try { save(); } catch (_) {}
    }
    return view(record);
  }

  const list = () => tokens.map(view);

  function revoke(id) {
    const before = tokens.length;
    tokens = tokens.filter((t) => t.id !== id);
    if (tokens.length === before) return false;
    save();
    return true;
  }

  return { create, verify, list, revoke };
}

// A token may act on an instance when its allow-list is empty or names it.
const allowsInstance = (token, name) => !token.instances || token.instances.includes(name);
const hasScope = (token, scope) => token.scopes.includes(scope);

module.exports = { createApiTokens, SCOPES, allowsInstance, hasScope };
