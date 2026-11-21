const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTemplates } = require('../panel/templates');

function rig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-'));
  const dir = path.join(root, 'Lobby');
  const put = (rel, text = 'x') => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  put('server.jar'); put('run.sh'); put('server.properties', 'level-name=lobbyworld\nserver-port=25566\n');
  put('plugins/a.jar'); put('plugins/A/config.yml', 'k: v'); put('config/paper-global.yml', 'proxies: {}');
  put('lobbyworld/level.dat'); put('lobbyworld/session.lock'); put('lobbyworld_nether/level.dat'); put('world/level.dat');
  put('logs/latest.log'); put('crash-reports/c.txt'); put('backups/b.zip'); put('.upgrade/latest.json'); put('usercache.json'); put('panel-config.json', '{}'); put('panel-events.json', '[]');
  const inst = { name: 'Lobby', dir, loader: 'paper', mcVersion: '1.21.1', loaderVersion: '120' };
  return { root, dir, inst, templates: createTemplates({ root: path.join(root, 'templates') }) };
}
const has = (dir, rel) => fs.existsSync(path.join(dir, rel));

test('a template keeps software, plugins, configs and the world, and leaves runtime files out', () => {
  const t = rig();
  const info = t.templates.save({ name: 'lobby', inst: t.inst, description: 'main lobby', ramMB: 2048 });
  assert.deepStrictEqual([info.loader, info.mcVersion, info.loaderVersion, info.includeWorld, info.ramMB, info.sourceInstance], ['paper', '1.21.1', '120', true, 2048, 'Lobby']);
  const out = path.join(t.root, 'new');
  t.templates.restore('lobby', out);
  for (const keep of ['server.jar', 'run.sh', 'server.properties', 'plugins/a.jar', 'plugins/A/config.yml', 'config/paper-global.yml', 'lobbyworld/level.dat', 'lobbyworld_nether/level.dat', 'world/level.dat']) assert.ok(has(out, keep), keep);
  for (const gone of ['logs', 'crash-reports', 'backups', '.upgrade', 'usercache.json', 'panel-config.json', 'panel-events.json', 'lobbyworld/session.lock']) assert.ok(!has(out, gone), gone);
});

test('without the world only the level folders named in server.properties are left out', () => {
  const t = rig();
  t.templates.save({ name: 'empty', inst: t.inst, includeWorld: false });
  const out = path.join(t.root, 'new');
  t.templates.restore('empty', out);
  assert.ok(!has(out, 'lobbyworld') && !has(out, 'lobbyworld_nether'));
  assert.ok(has(out, 'world/level.dat'), 'a folder that is not the level stays');
  assert.ok(has(out, 'plugins/a.jar'));
});

test('templates are listed, found by name and removed; names are validated', () => {
  const t = rig();
  assert.deepStrictEqual(t.templates.list(), []);
  t.templates.save({ name: 'b', inst: t.inst });
  t.templates.save({ name: 'a', inst: t.inst });
  assert.deepStrictEqual(t.templates.list().map((x) => x.name), ['a', 'b']);
  assert.strictEqual(t.templates.get('a').name, 'a');
  assert.strictEqual(t.templates.get('../a'), null);
  assert.throws(() => t.templates.save({ name: 'a', inst: t.inst }), /already exists/);
  for (const bad of ['', 'a b', '../x', 'x'.repeat(41)]) assert.throws(() => t.templates.save({ name: bad, inst: t.inst }), /template name/);
  assert.strictEqual(t.templates.remove('a'), true);
  assert.strictEqual(t.templates.remove('a'), false);
  assert.deepStrictEqual(t.templates.list().map((x) => x.name), ['b']);
});

test('restoring needs an existing template and never overwrites a folder', () => {
  const t = rig();
  assert.throws(() => t.templates.restore('nope', path.join(t.root, 'x')), /no such template/);
  t.templates.save({ name: 'a', inst: t.inst });
  const out = path.join(t.root, 'taken');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'server.jar'), 'mine');
  assert.throws(() => t.templates.restore('a', out));
  assert.strictEqual(fs.readFileSync(path.join(out, 'server.jar'), 'utf8'), 'mine');
});
