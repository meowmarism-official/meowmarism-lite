const test = require('node:test');
const assert = require('node:assert');
const harness = require('../test-support/harness');

// The API through a real controller and worker with the fake server; needs a Unix host.
const opts = { skip: process.platform === 'win32' ? 'needs a Unix host' : false, timeout: 60000 };

let h;
let owner;
let token;
const api = (method, p, body, auth = token) => fetch(`${h.base}/api/v1${p}`, {
  method,
  headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

test('boot the panel and log in', opts, async () => {
  h = await harness.start();
  owner = await h.login();
  await h.workerReady();
});

test('the API does not exist until it is switched on', opts, async () => {
  const r = await api('GET', '/instances', undefined, 'mmk_0000000000000000_' + 'a'.repeat(32));
  assert.equal(r.status, 404);
});

test('the owner switches it on and creates a token; the secret is shown once', opts, async () => {
  const on = await h.json(owner, 'POST', '/api/optional-features', { api: true });
  assert.equal(on.status, 200);
  assert.equal(on.body.enabled, true);
  const made = await h.json(owner, 'POST', '/api/api-admin/tokens', { name: 'ci', scopes: ['read', 'power', 'console', 'settings', 'events'] });
  assert.equal(made.status, 201);
  token = made.body.token;
  assert.match(token, /^mmk_/);
  const state = await h.json(owner, 'GET', '/api/optional-features');
  assert.equal(state.body.tokens.length, 1);
  assert.ok(!JSON.stringify(state.body).includes(token), 'the token is not listed again');
});

test('the token works without a login cookie, nothing else does', opts, async () => {
  const none = await api('GET', '/instances', undefined, null);
  assert.equal(none.status, 401);
  const list = await api('GET', '/instances');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.instances.map((i) => i.name), ['inst1']);
});

test('start, read the state, send a command, read the console and stop through the API', opts, async () => {
  assert.equal((await api('POST', '/instances/inst1/start', {})).status, 200);
  await h.until(async () => (await api('GET', '/instances/inst1')).body.phase === 'ready', 'ready');
  const info = await api('GET', '/instances/inst1');
  assert.equal(info.body.running, true);
  assert.equal((await api('POST', '/instances/inst1/command', { cmd: 'say hello' })).status, 200);
  await h.until(async () => JSON.stringify((await api('GET', '/instances/inst1/console?lines=50')).body.lines || []).includes('ran: say hello'), 'the command output');
  assert.equal((await api('POST', '/instances/inst1/say', { message: 'from the api' })).status, 200);
  await h.until(async () => JSON.stringify((await api('GET', '/instances/inst1/console?lines=50')).body.lines || []).includes('ran: say from the api'), 'the say output');
  const metrics = await api('GET', '/instances/inst1/metrics');
  assert.equal(metrics.status, 200);
  assert.equal(metrics.body.phase, 'ready');
  assert.equal((await api('POST', '/instances/inst1/stop', {})).status, 200);
  await h.until(async () => (await api('GET', '/instances/inst1')).body.running === false, 'stopped');
});

test('a restart-only setting is queued through the API', opts, async () => {
  await api('POST', '/instances/inst1/start', {});
  await h.until(async () => (await api('GET', '/instances/inst1')).body.phase === 'ready', 'ready again');
  const r = await api('POST', '/instances/inst1/settings', { settings: { 'max-players': 33 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.settings.queued['max-players'].value, 33);
});

test('a token without a scope is refused by the controller and an unknown token is refused', opts, async () => {
  const limited = await h.json(owner, 'POST', '/api/api-admin/tokens', { name: 'ro', scopes: ['read'] });
  const denied = await api('POST', '/instances/inst1/command', { cmd: 'say no' }, limited.body.token);
  assert.equal(denied.status, 403);
  assert.equal((await api('GET', '/instances', undefined, 'mmk_0000000000000000_' + 'b'.repeat(32))).status, 401);
});

test('the event stream delivers an event after a stop', opts, async () => {
  const controller = new AbortController();
  const res = await fetch(`${h.base}/api/v1/events`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /event-stream/);
  const reader = res.body.getReader();
  let seen = '';
  const reading = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      seen += Buffer.from(value).toString('utf8');
      if (seen.includes('server.stopped')) return;
    }
  })();
  await new Promise((r) => setTimeout(r, 2500));
  await api('POST', '/instances/inst1/stop', {});
  await Promise.race([reading, new Promise((_, reject) => setTimeout(() => reject(new Error('no server.stopped event')), 20000))]);
  controller.abort();
  assert.match(seen, /event: server\.stopped/);
});

test('switching the API off shuts the door again, revoking a token ends its access', opts, async () => {
  const state = await h.json(owner, 'GET', '/api/optional-features');
  const id = state.body.tokens.find((k) => k.name === 'ci').id;
  assert.equal((await h.json(owner, 'DELETE', `/api/api-admin/tokens/${id}`)).status, 200);
  assert.equal((await api('GET', '/instances')).status, 401);
  await h.json(owner, 'POST', '/api/optional-features', { api: false });
  assert.equal((await api('GET', '/instances')).status, 404);
});

test('shut down', opts, async () => {
  await h.json(owner, 'POST', '/instance/inst1/force-stop');
  await h.stop();
});
