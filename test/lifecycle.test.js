const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const harness = require('./helpers/harness');

// The fake server is a shell-executable script, so the lifecycle tests need a Unix host.
const opts = { skip: process.platform === 'win32' ? 'needs a Unix host' : false };

let h;
let owner;

test('boot the panel with one instance and log in', opts, async () => {
  h = await harness.start();
  owner = await h.login();
  const list = await h.json(owner, 'GET', '/api/instances');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.instances.map((i) => i.name), ['inst1']);
  await h.workerReady();
});

const status = async () => (await h.json(owner, 'GET', '/instance/inst1/status')).body;

test('start the server and wait for ready', opts, async () => {
  const r = await h.json(owner, 'POST', '/api/instances/inst1/start');
  assert.ok(r.status < 300, `start returned ${r.status}`);
  const s = await h.until(async () => { const v = await status(); return v.phase === 'ready' ? v : null; }, 'the server to be ready');
  assert.equal(s.running, true);
});

test('a console command reaches the server', opts, async () => {
  const r = await h.json(owner, 'POST', '/instance/inst1/command', { cmd: 'say hello' });
  assert.ok(r.status < 300, `command returned ${r.status}`);
  await h.until(async () => JSON.stringify((await h.json(owner, 'GET', '/instance/inst1/snapshot')).body.console || []).includes('ran: say hello'), 'the command output');
});

test('stop the server cleanly', opts, async () => {
  const r = await h.json(owner, 'POST', '/api/instances/inst1/stop');
  assert.ok(r.status < 300);
  await h.until(async () => (await status()).running === false, 'the server to stop');
});

test('restart brings it back to ready', opts, async () => {
  await h.json(owner, 'POST', '/api/instances/inst1/start');
  await h.until(async () => (await status()).phase === 'ready', 'ready after start');
  await h.json(owner, 'POST', '/api/instances/inst1/restart');
  await h.until(async () => (await status()).running === false || (await status()).phase !== 'ready', 'the restart to begin');
  await h.until(async () => (await status()).phase === 'ready', 'ready after restart');
});

test('force stop ends a running server', opts, async () => {
  const r = await h.json(owner, 'POST', '/instance/inst1/force-stop');
  assert.ok(r.status < 300, `force-stop returned ${r.status}`);
  await h.until(async () => (await status()).running === false, 'the server to be killed');
});

test('a viewer can look but not power, console or configure', opts, async () => {
  const made = await h.json(owner, 'POST', '/api/users', { username: 'viewer', password: 'viewerpass123', panel: {}, access: { global: [], instances: { inst1: ['view', 'files'] } } });
  assert.equal(made.status, 200);
  const viewer = await h.login('viewer', 'viewerpass123');
  assert.equal((await h.json(viewer, 'GET', '/instance/inst1/status')).status, 200);
  assert.equal((await h.json(viewer, 'POST', '/api/instances/inst1/start')).status, 403);
  assert.equal((await h.json(viewer, 'POST', '/instance/inst1/command', { cmd: 'stop' })).status, 403);
  assert.equal((await h.json(viewer, 'POST', '/instance/inst1/api/settings', { settings: { motd: 'x' } })).status, 403);
  assert.equal((await h.json(viewer, 'GET', '/instance/inst1/api/files?path=.')).status, 200);
  assert.equal((await h.json(viewer, 'GET', '/instance/inst1/log')).status, 403);
});

test('the worker only answers with the controller secret', opts, async () => {
  const port = h.registry[0].panelPort;
  const ask = (headers) => new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/status', headers }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
  });
  assert.equal(await ask({}), 403);
  assert.equal(await ask({ 'x-meow-worker': 'wrong' }), 403);
  assert.equal(await ask({ 'x-meow-worker': h.workerSecret() }), 200);
});

test('remove the instance and its files', opts, async () => {
  const r = await h.json(owner, 'DELETE', '/api/instances/inst1?files=1&backups=1');
  assert.ok(r.status < 300, `delete returned ${r.status}`);
  const list = await h.json(owner, 'GET', '/api/instances');
  assert.equal(list.body.instances.length, 0);
});

test('shut everything down', opts, async () => { await h.stop(); });
