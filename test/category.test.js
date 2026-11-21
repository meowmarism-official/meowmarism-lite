const test = require('node:test');
const assert = require('node:assert');
const harness = require('../test-support/harness');

test('an instance category is saved, trimmed and shown in the list', { skip: process.platform === 'win32' }, async () => {
  const h = await harness.start();
  try {
    const cookie = await h.login();
    const r = await h.json(cookie, 'POST', '/api/instances/inst1/category', { category: '  Lobby  ' });
    assert.deepEqual([r.status, r.body.category], [200, 'Lobby']);
    const list = (await h.json(cookie, 'GET', '/api/instances')).body.instances;
    assert.equal(list.find((i) => i.name === 'inst1').category, 'Lobby');
  } finally { await h.stop(); }
});
