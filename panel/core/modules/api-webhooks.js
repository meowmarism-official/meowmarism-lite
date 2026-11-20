// Webhooks of the optional HTTP API: a registry of target URLs and signed, retried deliveries of events.
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { EVENT_TYPES } = require('./api-events');

const MAX_HOOKS = 20;

// One request, no redirects. Resolves with the status code; rejects on network errors and timeouts.
function defaultPost(url, { headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request(target, { method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }, timeout: timeoutMs }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

const sign = (secret, timestamp, body) => `sha256=${crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

// file: JSON path; post/wait/now/backoffMs can be replaced in tests
function createWebhooks({ file, post = defaultPost, wait = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, backoffMs = [1000, 5000], timeoutMs = 5000 }) {
  let hooks = load();

  function load() {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(saved) ? saved : [];
    } catch (_) { return []; }
  }

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(hooks, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  const view = (h) => ({ id: h.id, name: h.name, url: h.url, events: h.events, createdAt: h.createdAt, lastStatus: h.lastStatus, lastAt: h.lastAt, failures: h.failures });

  function add({ url, events = ['*'], name = '' }) {
    if (hooks.length >= MAX_HOOKS) throw new Error(`at most ${MAX_HOOKS} webhooks`);
    let target;
    try { target = new URL(String(url || '')); } catch (_) { throw new Error('the URL is not valid'); }
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('the URL must start with http:// or https://');
    if (target.username || target.password) throw new Error('the URL must not contain a user name or password');
    if (String(url).length > 500) throw new Error('the URL is too long');
    const list = Array.isArray(events) && events.length ? [...new Set(events)] : ['*'];
    const unknown = list.filter((e) => e !== '*' && !EVENT_TYPES.includes(e));
    if (unknown.length) throw new Error(`unknown event: ${unknown.join(', ')}`);
    const hook = {
      id: crypto.randomBytes(6).toString('hex'), name: String(name || '').trim().slice(0, 60), url: target.toString(),
      events: list.includes('*') ? ['*'] : list, secret: `whsec_${crypto.randomBytes(24).toString('base64url')}`,
      createdAt: now(), lastStatus: null, lastAt: null, failures: 0,
    };
    hooks.push(hook);
    save();
    return { ...view(hook), secret: hook.secret };
  }

  const list = () => hooks.map(view);

  function remove(id) {
    const before = hooks.length;
    hooks = hooks.filter((h) => h.id !== id);
    if (hooks.length === before) return false;
    save();
    return true;
  }

  async function sendTo(hook, event) {
    const body = JSON.stringify(event);
    const timestamp = Math.floor(now() / 1000);
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'meowmarism-webhook',
      'X-Meowmarism-Event': event.type,
      'X-Meowmarism-Delivery': crypto.randomBytes(8).toString('hex'),
      'X-Meowmarism-Timestamp': String(timestamp),
      'X-Meowmarism-Signature': sign(hook.secret, timestamp, body),
    };
    let status = null;
    for (let attempt = 0; attempt <= backoffMs.length; attempt++) {
      try {
        status = (await post(hook.url, { headers, body, timeoutMs })).status;
        if (status >= 200 && status < 300) break;
      } catch (err) { status = err.message || 'error'; }
      if (attempt < backoffMs.length) await wait(backoffMs[attempt]);
    }
    const ok = typeof status === 'number' && status >= 200 && status < 300;
    hook.lastStatus = status;
    hook.lastAt = now();
    hook.failures = ok ? 0 : hook.failures + 1;
    try { save(); } catch (_) {}
    return ok;
  }

  // Delivers to every hook that wants this event; resolves when all attempts are done.
  function deliver(event) {
    const targets = hooks.filter((h) => h.events.includes('*') || h.events.includes(event.type));
    return Promise.all(targets.map((h) => sendTo(h, event)));
  }

  async function test(id) {
    const hook = hooks.find((h) => h.id === id);
    if (!hook) return null;
    return sendTo(hook, { id: 0, at: now(), type: 'webhook.test' });
  }

  return { add, list, remove, deliver, test };
}

// What a receiver does: recompute the signature over "<timestamp>.<raw body>" and compare in constant time.
function verifySignature(secret, timestamp, body, header) {
  const expected = Buffer.from(sign(secret, timestamp, body));
  const given = Buffer.from(String(header || ''));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

module.exports = { createWebhooks, verifySignature };
