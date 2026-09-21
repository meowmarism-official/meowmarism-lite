const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const harness = require('./helpers/harness');

// Backups use GNU tar and the fake server is a shell script, so the full flows need a Unix host.
const unix = { skip: process.platform === 'win32' ? 'needs a Unix host' : false };
const HOOKS = path.join(__dirname, 'helpers', 'upgrade-hooks.js');

let h;
let owner;
let dir;
const U = '/api/instances/inst1';
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const versionOf = async () => (await h.json(owner, 'GET', '/api/instances')).body.instances.find((i) => i.name === 'inst1').mcVersion;
const upgradeStatus = async () => (await h.json(owner, 'GET', `${U}/upgrade-status`)).body;
const finished = () => h.until(async () => { const s = await upgradeStatus(); return s.done && !s.running ? s : null; }, 'the upgrade to finish', 30000);

test('boot the panel with test hooks', async () => {
  h = await harness.start({ instances: ['inst1', 'lowdisk'], config: { lowdisk: { backupMinFreeGB: 999999 } }, hooks: HOOKS });
  owner = await h.login();
  dir = h.dir('inst1');
  await h.workerReady('inst1');
  await h.workerReady('lowdisk');
  fs.writeFileSync(path.join(dir, 'run.sh'), '#!/bin/sh\n# version 1.21.1\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'server.jar'), 'jar 1.21.1');
});

test('an upgrade needs the Settings and Files permissions', async () => {
  await h.json(owner, 'POST', '/api/users', { username: 'viewer', password: 'viewerpass123', panel: {}, access: { global: [], instances: { inst1: ['view'] } } });
  await h.json(owner, 'POST', '/api/users', { username: 'setonly', password: 'setonlypass1', panel: {}, access: { global: [], instances: { inst1: ['view', 'settings'] } } });
  for (const [name, pass] of [['viewer', 'viewerpass123'], ['setonly', 'setonlypass1']]) {
    const cookie = await h.login(name, pass);
    assert.equal((await h.json(cookie, 'POST', `${U}/upgrade`, { mcVersion: '1.21.4' })).status, 403, name);
    assert.equal((await h.json(cookie, 'POST', `${U}/upgrade/rollback`, {})).status, 403, name);
  }
  const viewer = await h.login('viewer', 'viewerpass123');
  assert.equal((await h.json(viewer, 'GET', `${U}/upgrade-status`)).status, 200, 'a viewer may read the status');
  assert.equal(await versionOf(), '1.21.1', 'nothing changed');
});

test('a version that does not exist is refused before anything happens', async () => {
  const r = await h.json(owner, 'POST', `${U}/upgrade`, { mcVersion: '9.9.9' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /not available/);
  assert.equal(read('run.sh').includes('1.21.1'), true);
});

test('going back to an older version needs an explicit confirmation', async () => {
  const r = await h.json(owner, 'POST', `${U}/upgrade`, { mcVersion: '1.20.4' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /older Minecraft version/);
  assert.equal(await versionOf(), '1.21.1');
});

test('the same version is refused, and so is a missing one', async () => {
  assert.equal((await h.json(owner, 'POST', `${U}/upgrade`, { mcVersion: '1.21.1' })).status, 400);
  assert.equal((await h.json(owner, 'POST', `${U}/upgrade`, {})).status, 400);
});

test('nothing to roll back before the first upgrade', async () => {
  const r = await h.json(owner, 'POST', `${U}/upgrade/rollback`, {});
  assert.equal(r.status, 400);
  assert.match(r.body.error, /nothing to roll back/);
});

test('a failing backup stops the upgrade before it changes anything', unix, async () => {
  const before = fs.readFileSync(path.join(h.dir('lowdisk'), 'world', 'level.dat'), 'utf8');
  const r = await h.json(owner, 'POST', '/api/instances/lowdisk/upgrade', { mcVersion: '1.21.4' });
  assert.equal(r.status, 202);
  const s = await h.until(async () => { const v = (await h.json(owner, 'GET', '/api/instances/lowdisk/upgrade-status')).body; return v.done && !v.running ? v : null; }, 'the failed upgrade');
  assert.match(s.error, /backup failed, nothing was changed/);
  assert.equal(fs.existsSync(path.join(h.dir('lowdisk'), 'run.sh')), true);
  assert.equal(fs.readFileSync(path.join(h.dir('lowdisk'), 'world', 'level.dat'), 'utf8'), before);
  const list = (await h.json(owner, 'GET', '/api/instances')).body.instances;
  assert.equal(list.find((i) => i.name === 'lowdisk').mcVersion, '1.21.1');
  assert.equal(fs.existsSync(path.join(h.dir('lowdisk'), '.upgrade', 'latest.json')), false, 'no upgrade was recorded');
});

test('a failing download restores the old launch files and keeps the version', unix, async () => {
  const r = await h.json(owner, 'POST', `${U}/upgrade`, { mcVersion: '1.99.0' });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  const s = await finished();
  assert.match(s.error, /download failed/);
  assert.equal(read('run.sh'), '#!/bin/sh\n# version 1.21.1\nexit 0\n', 'the launch file is the old one again');
  assert.equal(read('server.jar'), 'jar 1.21.1');
  assert.equal(await versionOf(), '1.21.1');
  assert.equal(fs.existsSync(path.join(dir, '.upgrade', 'latest.json')), false, 'a failed upgrade is not recorded as done');
});

test('a second upgrade while one is running is refused with 409', unix, async () => {
  fs.writeFileSync(path.join(dir, '.hold'), '');
  const first = await h.json(owner, 'POST', `${U}/upgrade`, { mcVersion: '1.21.3' });
  assert.equal(first.status, 202);
  await h.until(async () => (await upgradeStatus()).running, 'the upgrade to be running');
  const second = await h.json(owner, 'POST', `${U}/upgrade`, { mcVersion: '1.21.4' });
  assert.equal(second.status, 409);
  const start = await h.json(owner, 'POST', `${U}/start`);
  assert.equal(start.status, 409, 'the server cannot be started during an upgrade');
  fs.rmSync(path.join(dir, '.hold'));
  const s = await finished();
  assert.equal(s.error, null);
  assert.equal(await versionOf(), '1.21.3');
});

test('a successful upgrade takes a backup, swaps the launch files and records the way back', unix, async () => {
  assert.equal(read('run.sh').includes('1.21.3'), true);
  const latest = (await upgradeStatus()).latest;
  assert.equal(latest.from.mcVersion, '1.21.1');
  assert.equal(latest.to.mcVersion, '1.21.3');
  assert.ok(latest.backup, 'a world backup was taken first');
});

test('rolling back without the world restores the launch files but keeps the world', unix, async () => {
  fs.writeFileSync(path.join(dir, 'world', 'level.dat'), 'level v2 (played after the upgrade)');
  const r = await h.json(owner, 'POST', `${U}/upgrade/rollback`, { restoreWorld: false });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  const s = await finished();
  assert.equal(s.error, null, s.error);
  assert.equal(await versionOf(), '1.21.1');
  assert.equal(read('run.sh'), '#!/bin/sh\n# version 1.21.1\nexit 0\n');
  assert.equal(read('world/level.dat'), 'level v2 (played after the upgrade)');
  assert.equal((await upgradeStatus()).latest.rolledBack, true);
  await h.workerReady('inst1');
  assert.equal((await h.json(owner, 'POST', `${U}/upgrade/rollback`, {})).status, 400, 'a rollback cannot be done twice');
});

test('rolling back with the world restores the world from before the upgrade', unix, async () => {
  const up = await h.json(owner, 'POST', `${U}/upgrade`, { mcVersion: '1.21.4' });
  assert.equal(up.status, 202, JSON.stringify(up.body));
  assert.equal((await finished()).error, null);
  await h.workerReady('inst1');
  fs.writeFileSync(path.join(dir, 'world', 'level.dat'), 'damaged after the upgrade');
  const r = await h.json(owner, 'POST', `${U}/upgrade/rollback`, { restoreWorld: true });
  assert.equal(r.status, 202);
  const s = await finished();
  assert.equal(s.error, null, s.error);
  assert.equal(read('world/level.dat'), 'level v2 (played after the upgrade)', 'the world is the one saved right before the second upgrade');
  assert.equal(await versionOf(), '1.21.1');
});

test('an upgrade is refused while the Minecraft server runs', unix, async () => {
  await h.workerReady('inst1');
  fs.writeFileSync(path.join(dir, 'run.sh'), harness.FAKE_SERVER, { mode: 0o755 });
  const started = await h.json(owner, 'POST', `${U}/start`);
  assert.ok(started.status < 300, `start returned ${started.status}`);
  await h.until(async () => (await h.json(owner, 'GET', '/instance/inst1/status')).body.running === true, 'the server to run');
  const r = await h.json(owner, 'POST', `${U}/upgrade`, { mcVersion: '1.21.4' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /stop the Minecraft server first/);
  await h.json(owner, 'POST', '/instance/inst1/force-stop');
});

test('shut down', async () => { await h.stop(); });
