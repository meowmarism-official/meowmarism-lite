const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const harness = require('../test-support/harness');

let h;
let owner;
const argsFile = () => path.join(h.dir('inst1'), 'user_jvm_args.txt');
const read = () => fs.readFileSync(argsFile(), 'utf8');
const config = () => JSON.parse(fs.readFileSync(path.join(h.dir('inst1'), 'panel-config.json'), 'utf8'));
const post = (body, route = 'config') => h.json(owner, 'POST', `/instance/inst1/api/${route}`, body);

test('boot the panel with one instance', async () => {
  h = await harness.start();
  owner = await h.login();
  await h.workerReady();
});

test('saving a heap size rewrites user_jvm_args.txt right away', async () => {
  const r = await post({ ramMaxMB: 3072, ramMinMB: 1536 });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.deepEqual([config().ramMinMB, config().ramMaxMB], [1536, 3072]);
  assert.equal(read(), '-Xms1536M\n-Xmx3072M\n');
});

test('changing the JVM preset keeps the saved heap in the file', async () => {
  assert.equal((await post({ jvmPreset: 'aikar' })).status, 200);
  const text = read();
  assert.match(text, /^-Xms1536M$/m);
  assert.match(text, /^-Xmx3072M$/m);
  assert.match(text, /^-XX:\+UseG1GC$/m);
});

test('startup settings can be saved on the route they are read from', async () => {
  const saved = await post({ ramMaxMB: 4096 }, 'startup');
  assert.equal(saved.status, 200);
  const view = await h.json(owner, 'GET', '/instance/inst1/api/startup');
  assert.deepEqual([view.body.ramMinMB, view.body.ramMaxMB], [2048, 4096]);
  assert.match(read(), /^-Xmx4096M$/m);
});

test('an unrelated setting does not touch the arguments file', async () => {
  const before = read();
  assert.equal((await post({ autoStart: true })).status, 200);
  assert.equal(read(), before);
});

test('an installer-provided file is left alone while no heap is configured', async () => {
  const cfg = config();
  delete cfg.ramMinMB;
  delete cfg.ramMaxMB;
  fs.writeFileSync(path.join(h.dir('inst1'), 'panel-config.json'), JSON.stringify(cfg));
  fs.writeFileSync(argsFile(), '-Xmx999M\n');
  assert.equal((await post({ autoStart: false })).status, 200);
  assert.equal(read(), '-Xmx999M\n');
});

test('stop the panel', async () => { await h.stop(); });
