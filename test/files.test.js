const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const harness = require('../test-support/harness');

const unix = { skip: process.platform === 'win32' ? 'needs symlinks' : false };
let h;
let owner;
let dir;
const F = '/instance/inst1/api/files';
const q = (p) => encodeURIComponent(p);

test('boot the panel', async () => {
  h = await harness.start();
  owner = await h.login();
  dir = h.dir('inst1');
  await h.workerReady();
});

test('list, read and save a file', async () => {
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'one');
  const list = await h.json(owner, 'GET', `${F}?path=.`);
  assert.equal(list.status, 200);
  assert.ok(JSON.stringify(list.body).includes('notes.txt'));
  const read = await h.json(owner, 'GET', `${F}/content?path=notes.txt`);
  assert.equal(read.status, 200);
  assert.equal(read.body.text ?? read.body.content, 'one');
  const saved = await h.json(owner, 'POST', `${F}/save`, { path: 'notes.txt', text: 'two', mtime: read.body.mtime });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8'), 'two');
});

test('saving over a newer version is refused', async () => {
  const read = await h.json(owner, 'GET', `${F}/content?path=notes.txt`);
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'changed elsewhere');
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(dir, 'notes.txt'), future, future);
  const saved = await h.json(owner, 'POST', `${F}/save`, { path: 'notes.txt', text: 'mine', mtime: read.body.mtime });
  assert.ok(saved.status >= 400, `expected a conflict, got ${saved.status}`);
  assert.equal(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8'), 'changed elsewhere');
});

test('an upload replaces a file completely and leaves no temp files', async () => {
  fs.writeFileSync(path.join(dir, 'server.icon.txt'), 'old');
  const r = await fetch(`${h.base}${F}/upload?path=.&name=server.icon.txt`, { method: 'POST', headers: { Cookie: owner }, body: 'new content' });
  assert.equal(r.status, 200);
  assert.equal(fs.readFileSync(path.join(dir, 'server.icon.txt'), 'utf8'), 'new content');
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.part')).length, 0);
});

test('an upload that is too large is refused and the old file survives', async () => {
  fs.writeFileSync(path.join(dir, 'keep.bin'), 'keep');
  const big = Buffer.alloc(201 * 1024 * 1024, 1);
  const r = await fetch(`${h.base}${F}/upload?path=.&name=keep.bin`, { method: 'POST', headers: { Cookie: owner }, body: big }).catch(() => ({ status: 0 }));
  assert.ok(r.status === 413 || r.status === 0 || r.status >= 400, `status ${r.status}`);
  assert.equal(fs.readFileSync(path.join(dir, 'keep.bin'), 'utf8'), 'keep');
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.part')).length, 0);
});

test('paths cannot leave the instance folder', async () => {
  fs.writeFileSync(path.join(h.home, 'secret.txt'), 'top secret');
  for (const p of ['../../secret.txt', '..', '/etc/passwd', '..%2F..%2Fsecret.txt', 'a/../../../secret.txt']) {
    const r = await h.json(owner, 'GET', `${F}/content?path=${p.includes('%') ? p : q(p)}`);
    assert.ok(r.status === 0 || r.status >= 400, `${p} returned ${r.status}`);
    assert.ok(!JSON.stringify(r.body).includes('top secret'), `${p} leaked the file`);
  }
  const w = await h.json(owner, 'POST', `${F}/save`, { path: '../../secret.txt', text: 'overwritten' });
  assert.ok(w.status === 0 || w.status >= 400);
  assert.equal(fs.readFileSync(path.join(h.home, 'secret.txt'), 'utf8'), 'top secret');
});

test('a symlink out of the folder is not followed', unix, async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'meow-out-'));
  fs.writeFileSync(path.join(outside, 'data.txt'), 'outside data');
  fs.symlinkSync(outside, path.join(dir, 'link'));
  const read = await h.json(owner, 'GET', `${F}/content?path=${q('link/data.txt')}`);
  assert.ok(read.status >= 400 && !JSON.stringify(read.body).includes('outside data'));
  const create = await h.json(owner, 'POST', `${F}/save`, { path: 'link/new/file.txt', text: 'x' });
  assert.ok(create.status >= 400);
  assert.equal(fs.existsSync(path.join(outside, 'new')), false, 'nothing may be created outside the folder');
  const up = await fetch(`${h.base}${F}/upload?path=link&name=dropped.txt`, { method: 'POST', headers: { Cookie: owner }, body: 'x' });
  assert.ok(up.status >= 400);
  assert.equal(fs.existsSync(path.join(outside, 'dropped.txt')), false);
  fs.rmSync(outside, { recursive: true, force: true });
});

test('delete removes a file and refuses paths outside', async () => {
  fs.writeFileSync(path.join(dir, 'gone.txt'), 'x');
  const del = await h.json(owner, 'DELETE', `${F}?path=gone.txt`);
  assert.equal(del.status, 200);
  assert.equal(fs.existsSync(path.join(dir, 'gone.txt')), false);
  const out = await h.json(owner, 'DELETE', `${F}?path=${q('../../secret.txt')}`);
  assert.ok(out.status >= 400);
  assert.equal(fs.existsSync(path.join(h.home, 'secret.txt')), true);
});

test('a user without the files permission is turned away', async () => {
  await h.json(owner, 'POST', '/api/users', { username: 'nofiles', password: 'nofilespass1', panel: {}, access: { global: [], instances: { inst1: ['view'] } } });
  const u = await h.login('nofiles', 'nofilespass1');
  assert.equal((await h.json(u, 'GET', `${F}?path=.`)).status, 403);
  assert.equal((await h.json(u, 'POST', `${F}/save`, { path: 'x.txt', text: 'x' })).status, 403);
});

test('shut down', async () => { await h.stop(); });
