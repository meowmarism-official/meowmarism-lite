// Session handling for local login. Credentials themselves live in lib/db.js.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SESSION_FILE = path.join(os.homedir(), '.meowmarism-sessions.json');
const sessions = new Map(); // sha256(token) -> { username, role, createdAt }
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
const SESSION_COOKIE = 'panel_session';
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

try {
  const saved = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  for (const [k, v] of Object.entries(saved)) if (Date.now() - v.createdAt <= SESSION_MAX_AGE_MS) sessions.set(k, v);
} catch (_) {}

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(SESSION_FILE, JSON.stringify(Object.fromEntries(sessions)), { mode: 0o600 }); } catch (_) {}
  }, 200);
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    try { out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim()); } catch (_) {}
  }
  return out;
}

function currentSession(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const key = hashToken(token);
  const s = sessions.get(key);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_MAX_AGE_MS) { sessions.delete(key); persist(); return null; }
  return s;
}

function createSession(username, role) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(hashToken(token), { username, role, createdAt: Date.now() });
  persist();
  return token;
}

function deleteSession(token) {
  sessions.delete(hashToken(token));
  persist();
}

setInterval(() => {
  const now = Date.now();
  for (const [key, s] of sessions) if (now - s.createdAt > SESSION_MAX_AGE_MS) sessions.delete(key);
}, 10 * 60000).unref();

function revokeUser(username) {
  for (const [key, s] of sessions) if (s.username === username) sessions.delete(key);
  persist();
}

module.exports = { revokeUser, sessions, SESSION_COOKIE, SESSION_MAX_AGE_MS, parseCookies, currentSession, createSession, deleteSession };
