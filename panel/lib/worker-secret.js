// Shared secret between the controller and its workers: a worker only answers requests that carry it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(os.homedir(), '.meowmarism-worker-secret');
const HEADER = 'x-meow-worker';
let cached = null;

function get() {
  if (cached) return cached;
  try { cached = fs.readFileSync(FILE, 'utf8').trim(); } catch (_) {}
  if (!cached || cached.length < 32) {
    cached = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(FILE, cached, { mode: 0o600 });
  }
  return cached;
}

function matches(value) {
  const a = Buffer.from(String(value || ''));
  const b = Buffer.from(get());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { get, matches, HEADER };
