const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const harness = require('../test-support/harness');

// The fake server is a script, so the route tests need a Unix host.
const opts = { skip: process.platform === 'win32' ? 'needs a Unix host' : false, timeout: 60000 };

// Answers "tick query" like vanilla does and can print a lag warning on request.
const TICKING_SERVER = `#!/usr/bin/env node
process.stdout.write('[00:00:00] [Server thread/INFO]: Starting minecraft server version 1.21.1\\n');
setTimeout(() => process.stdout.write('[00:00:01] [Server thread/INFO]: Done (0.5s)! For help, type "help"\\n'), 300);
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line === 'stop') process.exit(0);
    if (line === 'tick query') {
      process.stdout.write('[00:00:02] [Server thread/INFO]: Target tick rate: 20.0 per second. Average time per tick: 80.0ms (Target: 50.0ms)\\n');
      process.stdout.write('[00:00:02] [Server thread/INFO]: Percentiles: P50: 70.0ms P95: 120.5ms P99: 200.0ms, sample: 100\\n');
    }
    if (line === 'lag') process.stdout.write("[00:00:03] [Server thread/WARN]: Can't keep up! Is the server overloaded? Running 6720ms or 134 ticks behind\\n");
  }
});
`;

let h;
let owner;
const status = async () => (await h.json(owner, 'GET', '/instance/inst1/status')).body;
const diag = async (refresh = false) => (await h.json(owner, 'GET', `/instance/inst1/api/diagnostics${refresh ? '?refresh=1' : ''}`)).body;

test('boot the panel with a server that answers tick query', opts, async () => {
  h = await harness.start();
  owner = await h.login();
  await h.workerReady();
  fs.writeFileSync(path.join(h.dir('inst1'), 'run.sh'), TICKING_SERVER, { mode: 0o755 });
});

test('with the server off there is nothing to show and no profile can start', opts, async () => {
  const d = await diag();
  assert.equal(d.running, false);
  assert.equal(d.tick, null);
  const r = await h.json(owner, 'POST', '/instance/inst1/api/diagnostics/profile', { seconds: 10 });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /not running/);
});

test('a refresh asks the server for its tick times and the answer is read', opts, async () => {
  await h.json(owner, 'POST', '/api/instances/inst1/start');
  await h.until(async () => (await status()).phase === 'ready', 'ready');
  await diag(true);
  const d = await h.until(async () => { const v = await diag(); return v.tick ? v : null; }, 'the tick report');
  assert.equal(d.tick.avgMs, 80);
  assert.equal(d.tick.p99Ms, 200);
  assert.equal(d.tps, 12.5);
});

test('lag warnings are listed with their delay', opts, async () => {
  await h.json(owner, 'POST', '/instance/inst1/command', { cmd: 'lag' });
  const d = await h.until(async () => { const v = await diag(); return v.lag.count ? v : null; }, 'the lag warning');
  assert.deepEqual(d.lag.events.map((e) => [e.delayMs, e.ticksBehind]), [[6720, 134]]);
});

test('starting a profile either begins or says that a JDK is missing', opts, async () => {
  const r = await h.json(owner, 'POST', '/instance/inst1/api/diagnostics/profile', { seconds: 5 });
  if (r.status === 202) assert.equal(r.body.profile.state, 'running');
  else { assert.equal(r.status, 409); assert.match(r.body.error, /JDK|attach|jcmd/i); }
});

test('shut down', opts, async () => {
  await h.json(owner, 'POST', '/instance/inst1/force-stop');
  await h.stop();
});
