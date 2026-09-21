// Starts a real controller with a temporary HOME, one instance and a fake Minecraft server, and talks to it over HTTP.
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });

// A stand-in for run.sh: prints the ready line, answers commands and exits on "stop".
const FAKE_SERVER = `#!/usr/bin/env node
process.stdout.write('[00:00:00] [Server thread/INFO]: Starting minecraft server version 1.21.1\\n');
setTimeout(() => process.stdout.write('[00:00:01] [Server thread/INFO]: Done (0.5s)! For help, type "help"\\n'), 600);
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line === 'stop') { process.stdout.write('[00:00:02] [Server thread/INFO]: Stopping the server\\n'); process.exit(0); }
    if (line) process.stdout.write('[00:00:02] [Server thread/INFO]: ran: ' + line + '\\n');
  }
});
`;

const FAKE_JAVA = '#!/bin/sh\necho \'openjdk version "21.0.1" 2024-01-16\' >&2\n';

// options: instances (names), config ({ name: panel-config overrides }), hooks (path of a MEOW_TEST_HOOKS module)
async function start({ instances = ['inst1'], config = {}, hooks = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meow-int-'));
  const controllerPort = await freePort();
  const workerBase = await freePort();
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'java'), FAKE_JAVA, { mode: 0o755 });
  const registry = [];
  for (let n = 0; n < instances.length; n++) {
    const dir = path.join(home, 'instances', instances[n]);
    fs.mkdirSync(path.join(dir, 'world'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'world', 'level.dat'), 'level v1');
    const mcPort = await freePort();
    fs.writeFileSync(path.join(dir, 'server.properties'), `server-port=${mcPort}\nlevel-name=world\nmotd=test\n`);
    fs.writeFileSync(path.join(dir, 'run.sh'), FAKE_SERVER, { mode: 0o755 });
    fs.copyFileSync(path.join(REPO, 'panel', 'core', 'brand', 'server-icon.png'), path.join(dir, 'server-icon.png'));
    fs.writeFileSync(path.join(dir, 'panel-config.json'), JSON.stringify({ javaPath: path.join(bin, 'java'), backupIntervalHours: 6, maxBackups: 10, ...(config[instances[n]] || {}) }));
    registry.push({ id: `id${n}`, name: instances[n], dir, port: mcPort, panelPort: workerBase + n, mcVersion: '1.21.1', loader: 'vanilla', loaderVersion: '', createdAt: 1 });
  }
  fs.writeFileSync(path.join(home, '.meowmarism-instances.json'), JSON.stringify(registry));
  require(path.join(REPO, 'panel', 'lib', 'db.js')).createUserStore(path.join(home, '.meowmarism-controller-users.json')).upsertOwner('owner', 'ownerpass123');

  const child = spawn(process.execPath, [path.join(REPO, 'panel', 'controller.js')], {
    env: { ...process.env, HOME: home, USERPROFILE: home, CONTROLLER_PORT: String(controllerPort), WORKER_PORT_BASE: String(workerBase), ...(hooks ? { MEOW_TEST_HOOKS: hooks } : {}) },
    cwd: path.join(REPO, 'panel'),
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${controllerPort}`;
  for (let i = 0; i < 60; i++) {
    try { await fetch(base + '/'); break; } catch (_) { await sleep(200); }
  }

  async function login(username = 'owner', password = 'ownerpass123') {
    const r = await fetch(base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    if (!r.ok) throw new Error(`login failed for ${username}: ${r.status}`);
    return (r.headers.get('set-cookie') || '').split(';')[0];
  }
  const call = (cookie, method, p, body) => fetch(base + p, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  // A dropped connection counts as status 0 (the request was refused before it got an answer).
  const json = async (cookie, method, p, body) => {
    try { const r = await call(cookie, method, p, body); return { status: r.status, body: await r.json().catch(() => ({})) }; } catch (_) { return { status: 0, body: {} }; }
  };
  async function until(check, what, timeoutMs = 20000) {
    const end = Date.now() + timeoutMs;
    let last;
    while (Date.now() < end) { last = await check(); if (last) return last; await sleep(250); }
    throw new Error(`timed out waiting for ${what}`);
  }
  const workerReady = (name = 'inst1') => until(async () => (await json(await login(), 'GET', `/instance/${name}/status`)).status === 200, `the worker of ${name}`);
  const workerSecret = () => fs.readFileSync(path.join(home, '.meowmarism-worker-secret'), 'utf8').trim();
  const stop = async () => { child.kill(); await sleep(300); fs.rmSync(home, { recursive: true, force: true }); };
  return { home, base, registry, login, call, json, until, workerReady, workerSecret, stop, dir: (name) => path.join(home, 'instances', name), controller: child };
}

module.exports = { start, sleep, freePort, FAKE_SERVER };
