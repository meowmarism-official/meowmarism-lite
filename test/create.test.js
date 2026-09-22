// Creating an instance from a modpack, end to end against the real controller with fake Modrinth and a fake runtime install.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const harness = require('../test-support/harness');

const HOOKS = path.join(__dirname, '..', 'test-support', 'modpack-hooks.js');
const CORE_ICON = path.join(__dirname, '..', 'panel', 'core', 'brand', 'server-icon.png');

async function withController(env, fn) {
  const h = await harness.start({ hooks: HOOKS, env });
  try {
    const cookie = await h.login();
    const instancesRoot = path.join(h.home, 'meowmarism', 'instances');
    const create = async (body) => {
      const r = await h.json(cookie, 'POST', '/api/instances', { name: 'Pack', port: 25570, ramMB: 4096, ...body });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      const log = await h.until(async () => { const l = (await h.json(cookie, 'GET', '/api/create-log')).body; return l.done && l; }, 'the creation to finish');
      return log;
    };
    const names = async () => (await h.json(cookie, 'GET', '/api/instances')).body.instances.map((i) => i.name);
    const dirOf = (name) => path.join(instancesRoot, name);
    await fn({ h, cookie, create, names, dirOf, instancesRoot });
  } finally { await h.stop(); }
}
const nothingLeft = (dirOf, name) => {
  assert.ok(!fs.existsSync(dirOf(name)), 'no final folder');
  assert.ok(!fs.existsSync(`${dirOf(name)}.creating`), 'no staging folder');
};

test('a NeoForge pack becomes a complete instance with its source recorded', async () => {
  await withController({}, async ({ create, names, dirOf, h, cookie }) => {
    const log = await create({ name: 'Pack', modpack: { versionId: 'v1' } });
    assert.equal(log.error, null);
    assert.equal(log.phase, 'Ready');
    assert.ok((await names()).includes('Pack'));
    const dir = dirOf('Pack');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.installed-with.json'), 'utf8')), { loader: 'neoforge', mcVersion: '1.21.1', loaderVersion: '21.1.5' });
    assert.equal(fs.readFileSync(path.join(dir, 'mods', 'a.jar'), 'utf8'), 'jar');
    assert.equal(fs.readFileSync(path.join(dir, 'mods', 'b.jar'), 'utf8'), 'jar');
    assert.equal(fs.readFileSync(path.join(dir, 'config', 'a.cfg'), 'utf8'), 'x');
    assert.match(fs.readFileSync(path.join(dir, 'run.sh'), 'utf8'), /launcher made by the runtime/, 'the pack cannot replace the launcher');
    const meta = JSON.parse(fs.readFileSync(path.join(dir, '.meowmarism-modpack.json'), 'utf8'));
    assert.deepEqual([meta.source.type, meta.source.projectId, meta.source.versionId, meta.loader], ['modrinth-modpack', 'p1', 'v1', 'neoforge']);
    assert.equal(fs.readFileSync(path.join(dir, 'eula.txt'), 'utf8'), 'eula=true\n');
    assert.match(fs.readFileSync(path.join(dir, 'server.properties'), 'utf8'), /^server-port=25570$/m);
    assert.ok(fs.existsSync(path.join(dir, 'panel-config.json')));
    assert.ok(!fs.existsSync(`${dir}.creating`));
    const entry = JSON.parse(fs.readFileSync(path.join(h.home, '.meowmarism-instances.json'), 'utf8')).find((i) => i.name === 'Pack');
    assert.deepEqual([entry.loader, entry.mcVersion, entry.loaderVersion], ['neoforge', '1.21.1', '21.1.5']);
    assert.ok(!('modpack' in entry) && !('source' in entry), 'the pack source lives only in .meowmarism-modpack.json');
    await h.workerReady('Pack');
    const pack = await h.until(async () => (await h.json(cookie, 'GET', '/instance/Pack/snapshot')).body.stats, 'the worker stats');
    assert.equal(pack.modpack, true, 'the page can tell this is a modpack instance');
    assert.equal((await h.json(cookie, 'GET', '/instance/inst1/snapshot')).body.stats.modpack, false);
  });
});

test('a Fabric pack uses the loader and versions the pack asks for', async () => {
  await withController({}, async ({ create, names, dirOf }) => {
    const log = await create({ name: 'Fab', modpack: { versionId: 'vf' }, loader: 'vanilla', mcVersion: '9.9.9' });
    assert.equal(log.error, null);
    assert.ok((await names()).includes('Fab'));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dirOf('Fab'), '.installed-with.json'), 'utf8')), { loader: 'fabric', mcVersion: '1.20.1', loaderVersion: '0.16.9' });
    assert.equal(fs.readFileSync(path.join(dirOf('Fab'), 'config', 'f.cfg'), 'utf8'), 'fabric');
  });
});

test('a Quilt pack is refused before anything is created', async () => {
  await withController({}, async ({ create, names, dirOf }) => {
    const log = await create({ name: 'Quilt', modpack: { versionId: 'vq' } });
    assert.match(log.error, /Quilt.*cannot run/);
    assert.ok(!(await names()).includes('Quilt'));
    nothingLeft(dirOf, 'Quilt');
  });
});

test('a Forge pack installs exactly the Forge version it names', async () => {
  await withController({}, async ({ create, names, dirOf }) => {
    const log = await create({ name: 'Forged', modpack: { versionId: 'vg' } });
    assert.equal(log.error, null);
    assert.ok((await names()).includes('Forged'));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dirOf('Forged'), '.installed-with.json'), 'utf8')), { loader: 'forge', mcVersion: '1.20.1', loaderVersion: '47.4.0' });
  });
});

test('a Forge version that does not exist for that Minecraft version is refused, not replaced by another', async () => {
  await withController({}, async ({ create, names, dirOf }) => {
    const log = await create({ name: 'Nope', modpack: { versionId: 'vu' } });
    assert.match(log.error, /Forge 99.9.9 is not available for Minecraft 1.20.1/);
    assert.ok(!(await names()).includes('Nope'));
    nothingLeft(dirOf, 'Nope');
  });
});

test('the server software failing leaves neither staging nor instance', async () => {
  await withController({ MEOW_TEST_FAIL: 'software' }, async ({ create, names, dirOf }) => {
    const log = await create({ name: 'Pack', modpack: { versionId: 'v1' } });
    assert.match(log.error, /server software download failed/);
    assert.ok(!(await names()).includes('Pack'));
    nothingLeft(dirOf, 'Pack');
  });
});

test('a modpack file failing to download leaves neither staging nor instance', async () => {
  await withController({ MEOW_TEST_FAIL: 'file' }, async ({ create, names, dirOf }) => {
    const log = await create({ name: 'Pack', modpack: { versionId: 'v1' } });
    assert.match(log.error, /mod download failed/);
    assert.ok(!(await names()).includes('Pack'));
    nothingLeft(dirOf, 'Pack');
  });
});

test('the final rename failing leaves no instance and no registry entry', async () => {
  await withController({ MEOW_TEST_FAIL: 'rename' }, async ({ create, names, dirOf, h }) => {
    const log = await create({ name: 'Pack', modpack: { versionId: 'v1' } });
    assert.match(log.error, /rename failed/);
    assert.ok(!(await names()).includes('Pack'));
    nothingLeft(dirOf, 'Pack');
    assert.ok(!JSON.parse(fs.readFileSync(path.join(h.home, '.meowmarism-instances.json'), 'utf8')).some((i) => i.name === 'Pack'));
  });
});

test('a failing registry write is an error and removes the finished folder', async () => {
  await withController({}, async ({ create, dirOf, h }) => {
    const registry = path.join(h.home, '.meowmarism-instances.json');
    fs.rmSync(registry);
    fs.mkdirSync(registry);
    const log = await create({ name: 'Pack', modpack: { versionId: 'v1' } });
    assert.ok(log.error, 'the failure is reported');
    nothingLeft(dirOf, 'Pack');
  });
});

test('a pack\'s own server.properties and icon are kept, only the port is forced', async () => {
  await withController({}, async ({ create, dirOf }) => {
    const log = await create({ name: 'Props', modpack: { versionId: 'vp' }, port: 25580 });
    assert.equal(log.error, null);
    const props = fs.readFileSync(path.join(dirOf('Props'), 'server.properties'), 'utf8');
    assert.match(props, /^motd=from the pack$/m);
    assert.match(props, /^max-players=7$/m);
    assert.match(props, /^server-port=25580$/m);
    assert.ok(!/server-port=1111/.test(props));
    assert.equal(fs.readFileSync(path.join(dirOf('Props'), 'server-icon.png'), 'utf8'), 'pack-icon-bytes');
  });
});

test('a pack without an icon gets the Meowmarism one', async () => {
  await withController({}, async ({ create, dirOf }) => {
    await create({ name: 'Plain', modpack: { versionId: 'v1' } });
    assert.deepEqual(fs.readFileSync(path.join(dirOf('Plain'), 'server-icon.png')), fs.readFileSync(CORE_ICON));
    assert.match(fs.readFileSync(path.join(dirOf('Plain'), 'server.properties'), 'utf8'), /^motd=hosted by meowmarism/m);
  });
});

test('the instance only shows up after everything is installed, and the phases are visible', async () => {
  await withController({}, async ({ h, cookie, names, dirOf }) => {
    const hold = path.join(h.home, '.hold-create');
    fs.writeFileSync(hold, '');
    const r = await h.json(cookie, 'POST', '/api/instances', { name: 'Slow', port: 25590, ramMB: 4096, modpack: { versionId: 'v1' } });
    assert.equal(r.status, 202);
    const mid = await h.until(async () => { const l = (await h.json(cookie, 'GET', '/api/create-log')).body; return l.phase === 'Installing NeoForge' && l; }, 'the software install phase');
    assert.equal(mid.done, false);
    assert.ok(!(await names()).includes('Slow'), 'not listed while installing');
    assert.ok(!fs.existsSync(dirOf('Slow')), 'no final folder yet');
    assert.ok(fs.existsSync(`${dirOf('Slow')}.creating`), 'work happens in the staging folder');
    fs.rmSync(hold);
    const done = await h.until(async () => { const l = (await h.json(cookie, 'GET', '/api/create-log')).body; return l.done && l; }, 'the creation to finish');
    assert.equal(done.error, null);
    assert.ok((await names()).includes('Slow'));
    assert.ok(!fs.existsSync(`${dirOf('Slow')}.creating`));
  });
});

test('mods Modrinth lists as client-only are left out and the log says so', async () => {
  await withController({ MEOW_TEST_ENVIRONMENT: 'client_only' }, async ({ create, dirOf, h, cookie }) => {
    const preview = (await h.json(cookie, 'GET', '/api/modpacks/versions/v1/preview')).body;
    assert.equal(preview.environmentSkippedCount, 2);
    assert.deepEqual(preview.environmentSkipped.map((e) => e.environment), ['client_only', 'client_only']);
    assert.equal(preview.modCount, 0);
    const log = await create({ name: 'Pack', modpack: { versionId: 'v1' } });
    assert.equal(log.error, null);
    assert.ok(log.lines.some((l) => l.includes('Skipping a.jar: client-only according to Modrinth')));
    assert.ok(!fs.existsSync(path.join(dirOf('Pack'), 'mods', 'a.jar')) && !fs.existsSync(path.join(dirOf('Pack'), 'mods', 'b.jar')));
    assert.equal(fs.readFileSync(path.join(dirOf('Pack'), 'config', 'a.cfg'), 'utf8'), 'x', 'overrides are not filtered');
  });
});

test('a server-capable environment keeps the mods, and a failing Modrinth lookup does not stop the install', async () => {
  await withController({ MEOW_TEST_ENVIRONMENT: 'client_only_server_optional' }, async ({ create, dirOf }) => {
    const log = await create({ name: 'Pack', modpack: { versionId: 'v1' } });
    assert.equal(log.error, null);
    assert.ok(log.lines.some((l) => l.includes('Keeping a.jar: server support is optional')));
    assert.ok(fs.existsSync(path.join(dirOf('Pack'), 'mods', 'a.jar')));
  });
  await withController({ MEOW_TEST_ENVIRONMENT: 'fail' }, async ({ create, dirOf }) => {
    const log = await create({ name: 'Pack', modpack: { versionId: 'v1' } });
    assert.equal(log.error, null);
    assert.ok(log.lines.some((l) => /Could not ask Modrinth about 2 mods/.test(l)));
    assert.ok(fs.existsSync(path.join(dirOf('Pack'), 'mods', 'a.jar')) && fs.existsSync(path.join(dirOf('Pack'), 'mods', 'b.jar')));
  });
});
