const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const harness = require('../test-support/harness');

// The fake servers are shell scripts and the checks read the process table, so these need a Unix host.
const opts = { skip: process.platform === 'win32' ? 'needs a Unix host' : false, timeout: 60000 };

// Saves the world, then never exits: a thread that is not a daemon keeps the JVM alive.
const HANGING_SERVER = `#!/usr/bin/env node
process.stdout.write('[00:00:00] [Server thread/INFO]: Starting minecraft server version 1.21.1\\n');
setTimeout(() => process.stdout.write('[00:00:01] [Server thread/INFO]: Done (0.5s)! For help, type "help"\\n'), 300);
process.stdin.on('data', (d) => {
  if (String(d).includes('stop')) {
    process.stdout.write('[00:00:02] [Server thread/INFO]: Stopping the server\\n');
    process.stdout.write('[00:00:02] [Server thread/INFO]: ThreadedAnvilChunkStorage: All dimensions are saved\\n');
  }
});
setInterval(() => {}, 1000);
`;

// The launcher exits on stop while its java child lives on, like a wrapper script around a stuck JVM.
const LAUNCHER_ONLY_EXITS = `#!/bin/sh
DIR="$(cd "$(dirname "$0")" && pwd)"
echo '[00:00:00] [Server thread/INFO]: Starting minecraft server version 1.21.1'
mkdir -p "$DIR/jvm"
printf '#!/bin/sh\\nwhile true; do sleep 1; done\\n' > "$DIR/jvm/java"
chmod +x "$DIR/jvm/java"
"$DIR/jvm/java" &
echo $! > "$DIR/java.pid"
sleep 1
echo '[00:00:01] [Server thread/INFO]: Done (0.5s)! For help, type "help"'
while read line; do
  if [ "$line" = "stop" ]; then
    echo '[00:00:02] [Server thread/INFO]: Stopping the server'
    echo '[00:00:02] [Server thread/INFO]: ThreadedAnvilChunkStorage: All dimensions are saved'
    exit 0
  fi
done
`;

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };

let h;
let owner;
const status = async () => (await h.json(owner, 'GET', '/instance/inst1/status')).body;

test('boot the panel with a short stop grace', opts, async () => {
  h = await harness.start({ config: { inst1: { stopAfterSaveSec: 5 } } });
  owner = await h.login();
  await h.workerReady();
});

test('a server that saves but never exits is ended after the grace period', opts, async () => {
  fs.writeFileSync(path.join(h.dir('inst1'), 'run.sh'), HANGING_SERVER, { mode: 0o755 });
  await h.json(owner, 'POST', '/api/instances/inst1/start');
  await h.until(async () => (await status()).phase === 'ready', 'ready');
  await h.json(owner, 'POST', '/api/instances/inst1/stop');
  await h.until(async () => (await status()).phase === 'stopping', 'the stopping phase');
  assert.equal((await status()).running, true, 'still running right after the stop request');
  await h.until(async () => (await status()).running === false, 'the watchdog to end the server', 30000);
  const log = JSON.stringify((await h.json(owner, 'GET', '/instance/inst1/snapshot')).body.console || []);
  assert.match(log, /SIGTERM/);
});

test('the panel keeps saying stopping while the java process outlives the launcher', opts, async () => {
  fs.writeFileSync(path.join(h.dir('inst1'), 'run.sh'), LAUNCHER_ONLY_EXITS, { mode: 0o755 });
  await h.json(owner, 'POST', '/api/instances/inst1/start');
  await h.until(async () => (await status()).phase === 'ready', 'ready', 30000);
  const javaPid = Number(fs.readFileSync(path.join(h.dir('inst1'), 'java.pid'), 'utf8').trim());
  assert.ok(alive(javaPid), 'the fake java is running');
  await h.json(owner, 'POST', '/api/instances/inst1/stop');
  await harness.sleep(2000);
  const during = await status();
  assert.equal(during.running, true, 'java is alive, so the server is not stopped');
  assert.equal(during.phase, 'stopping');
  assert.ok(alive(javaPid));
  await h.until(async () => (await status()).running === false, 'the lingering java to be ended', 30000);
  assert.equal(alive(javaPid), false, 'the java process is really gone');
});

test('a restart waits for the lingering java before starting again', opts, async () => {
  await h.json(owner, 'POST', '/api/instances/inst1/start');
  await h.until(async () => (await status()).phase === 'ready', 'ready', 30000);
  await h.json(owner, 'POST', '/api/instances/inst1/restart');
  await h.until(async () => (await status()).phase === 'ready', 'ready after the restart', 40000);
  await h.json(owner, 'POST', '/instance/inst1/force-stop');
  await h.until(async () => (await status()).running === false, 'force stop');
});

test('shut down', opts, async () => { await h.stop(); });
