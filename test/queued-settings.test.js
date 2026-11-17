const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const harness = require('../test-support/harness');

// The fake server is a shell-executable script, so this needs a Unix host.
const opts = { skip: process.platform === 'win32' ? 'needs a Unix host' : false, timeout: 60000 };

let h;
let owner;
const status = async () => (await h.json(owner, 'GET', '/instance/inst1/status')).body;
const settings = async () => (await h.json(owner, 'GET', '/instance/inst1/api/settings')).body;
const props = () => fs.readFileSync(path.join(h.dir('inst1'), 'server.properties'), 'utf8');

test('boot the panel and start the server', opts, async () => {
  h = await harness.start();
  owner = await h.login();
  await h.workerReady();
  await h.json(owner, 'POST', '/api/instances/inst1/start');
  await h.until(async () => (await status()).phase === 'ready', 'ready');
});

test('a restart setting saved while running is queued and the file stays as it was', opts, async () => {
  const r = await h.json(owner, 'POST', '/instance/inst1/api/settings', { settings: { 'max-players': 42 } });
  assert.equal(r.status, 200);
  assert.deepStrictEqual(r.body.settings.queued['max-players'], { value: 42, active: 20 });
  assert.doesNotMatch(props(), /max-players=42/);
  assert.equal((await settings()).queued['max-players'].value, 42);
});

test('a queued setting can be discarded', opts, async () => {
  await h.json(owner, 'POST', '/instance/inst1/api/settings', { settings: { 'max-players': 43 } });
  const r = await h.json(owner, 'POST', '/instance/inst1/api/settings', { discard: ['max-players'] });
  assert.equal(r.status, 200);
  assert.deepStrictEqual(r.body.settings.queued, {});
});

test('the queue is written into server.properties when the server restarts', opts, async () => {
  await h.json(owner, 'POST', '/instance/inst1/api/settings', { settings: { 'max-players': 42 } });
  await h.json(owner, 'POST', '/api/instances/inst1/restart');
  await h.until(async () => (await status()).phase !== 'ready', 'the restart to begin');
  await h.until(async () => (await status()).phase === 'ready', 'ready after the restart', 40000);
  assert.match(props(), /^max-players=42$/m);
  assert.deepStrictEqual((await settings()).queued, {});
  assert.equal(fs.existsSync(path.join(h.dir('inst1'), 'panel-queued-settings.json')), false);
});

test('shut down', opts, async () => {
  await h.json(owner, 'POST', '/instance/inst1/force-stop');
  await h.stop();
});
