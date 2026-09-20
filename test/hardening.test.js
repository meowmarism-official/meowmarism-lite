const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'meow-http-'));
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const raw = (port, text) => new Promise((resolve) => {
  const sock = net.connect(port, '127.0.0.1', () => sock.write(text));
  let out = '';
  sock.on('data', (d) => { out += d; });
  sock.on('close', () => resolve(out));
  sock.on('error', () => resolve(out));
  setTimeout(() => { sock.destroy(); resolve(out); }, 1500);
});
const status = (res) => Number((/^HTTP\/1\.1 (\d+)/.exec(res) || [])[1] || 0);

let child;
let port;

test('start the panel', async () => {
  port = await freePort();
  child = spawn(process.execPath, [path.join(__dirname, '..', 'panel', 'controller.js')], {
    env: { ...process.env, HOME: home, USERPROFILE: home, CONTROLLER_PORT: String(port), WORKER_PORT_BASE: String(port + 100) },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) { if (await raw(port, 'GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')) return; await new Promise((r) => setTimeout(r, 200)); }
  assert.fail('panel did not start');
});

test('a malformed request target gets 400 and does not crash the panel', async () => {
  const res = await raw(port, 'GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
  assert.equal(status(res), 400);
  assert.ok(child.exitCode === null, 'panel is still running');
});

test('a malformed cookie does not crash the panel', async () => {
  const res = await raw(port, 'GET /api/instances HTTP/1.1\r\nHost: x\r\nCookie: meow_session=%E0%A4%A\r\nConnection: close\r\n\r\n');
  assert.ok(status(res) > 0);
  assert.ok(child.exitCode === null, 'panel is still running');
});

test('a malformed percent sequence in a path does not crash the panel', async () => {
  const res = await raw(port, 'GET /api/users/%E0%A4%A HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
  assert.ok(status(res) > 0);
  assert.ok(child.exitCode === null, 'panel is still running');
});

test('stop the panel', () => { child.kill(); });
