const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const harness = require('../test-support/harness');

// Through the real controller with a real MariaDB; MEOW_TEST_MARIADB_BIN points at its bin folder.
const real = process.env.MEOW_TEST_MARIADB_BIN;
const opts = { skip: real ? false : 'set MEOW_TEST_MARIADB_BIN', timeout: 240000 };

test('the database stays off until enabled, then serves server and network databases and the API', opts, async () => {
  const h = await harness.start({ env: { PATH: `${real}${path.delimiter}${process.env.PATH}`, MEOW_DB_PORT: '33911', MEOW_AUTO_DB: '0' } });
  try {
    const cookie = await h.login();
    const status = (await h.json(cookie, 'GET', '/api/database/status')).body;
    assert.deepEqual([status.enabled, status.running, status.installed, status.source], [false, false, true, 'system']);
    const off = await h.json(cookie, 'GET', '/api/database/server/inst1');
    assert.equal(off.status, 404);
    assert.match(off.body.error, /not enabled/);

    assert.equal((await h.json(cookie, 'POST', '/api/database/enable', { enabled: true })).status, 200);
    await h.until(async () => (await h.json(cookie, 'GET', '/api/database/status')).body.running, 'the database to run');

    const empty = (await h.json(cookie, 'GET', '/api/database/server/inst1')).body;
    assert.deepEqual([empty.exists, empty.tables], [false, []]);
    const made = (await h.json(cookie, 'POST', '/api/database/server/inst1/create')).body;
    assert.equal(made.connection.database, 'srv_inst1');
    assert.equal(made.connection.port, 33911);

    const mk = await h.json(cookie, 'POST', '/api/database/server/inst1/tables', { name: 'players', columns: [{ name: 'id', type: 'int', nullable: false, autoIncrement: true }, { name: 'name', type: 'varchar', size: 16 }], primaryKey: ['id'] });
    assert.equal(mk.status, 200, JSON.stringify(mk.body));
    await h.json(cookie, 'POST', '/api/database/server/inst1/tables/players/rows', { values: { name: "O'Brien" } });
    await h.json(cookie, 'POST', '/api/database/server/inst1/tables/players/rows', { values: { name: 'Steve' } });
    await h.json(cookie, 'PATCH', '/api/database/server/inst1/tables/players/rows', { key: { id: '2' }, values: { name: 'Alex' } });
    const table = (await h.json(cookie, 'GET', '/api/database/server/inst1/tables/players')).body;
    assert.deepEqual([table.total, table.primaryKey, table.rows], [2, ['id'], [['1', "O'Brien"], ['2', 'Alex']]]);
    const q = (await h.json(cookie, 'POST', '/api/database/server/inst1/query', { sql: 'SELECT COUNT(*) AS n FROM players' })).body;
    assert.deepEqual(q.rows, [['2']]);
    const denied = await h.json(cookie, 'POST', '/api/database/server/inst1/query', { sql: 'SELECT * FROM network.x' });
    assert.equal(denied.status, 400);

    assert.equal((await h.json(cookie, 'POST', '/api/database/shared/create')).status, 200);
    assert.equal((await h.json(cookie, 'POST', '/api/database/shared/query', { sql: 'CREATE TABLE motd (k INT)' })).status, 200);

    const token = (await h.json(cookie, 'POST', '/api/api-admin/tokens', { name: 'db', scopes: ['database'] })).body.token;
    await h.json(cookie, 'POST', '/api/optional-features', { api: true });
    const viaApi = await fetch(`${h.base}/api/v1/instances/inst1/database/tables/players`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(viaApi.status, 200);
    assert.equal((await viaApi.json()).total, 2);
    const shared = await fetch(`${h.base}/api/v1/database/shared`, { headers: { Authorization: `Bearer ${token}` } });
    assert.deepEqual((await shared.json()).tables, ['motd']);

    assert.equal((await h.json(cookie, 'POST', '/api/database/enable', { enabled: false })).status, 200);
    await h.until(async () => !(await h.json(cookie, 'GET', '/api/database/status')).body.running, 'the database to stop');
  } finally { await h.stop(); }
});
