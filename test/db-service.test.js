const test = require('node:test');
const assert = require('node:assert');
const { createDbService, route } = require('../panel/db-service');

function fake({ exists = true } = {}) {
  const log = [];
  const results = {
    'SHOW FULL TABLES': { columns: ['Tables_in_x', 'Table_type'], rows: [['players', 'BASE TABLE']] },
    'SHOW COLUMNS': { columns: ['Field', 'Type', 'Null', 'Key', 'Default', 'Extra'], rows: [['id', 'bigint(20)', 'NO', 'PRI', null, 'auto_increment'], ['name', 'varchar(16)', 'YES', '', null, '']] },
    'SELECT COUNT': { columns: ['n'], rows: [['2']] },
    'SELECT * FROM': { columns: ['id', 'name'], rows: [['1', 'Steve'], ['2', null]] },
  };
  const engine = {
    connection: (db) => (exists ? { host: '127.0.0.1', port: 3307, database: db, user: db, password: 'pw', jdbc: `jdbc:mariadb://127.0.0.1:3307/${db}` } : null),
    inDatabase: async (db, text) => {
      log.push({ db, text });
      const hit = Object.keys(results).find((k) => text.startsWith(k));
      return hit ? results[hit] : { columns: [], rows: [] };
    },
    ensureDatabase: async (db, user) => { log.push({ ensure: [db, user] }); return engine.connection(db) || { database: db }; },
    resetPassword: async (db) => { log.push({ reset: db }); return { database: db, password: 'new' }; },
    dropDatabase: async (db) => { log.push({ drop: db }); },
  };
  return { engine, log, service: createDbService(engine) };
}
const call = (f, method, sub, body, query) => route({ engine: f.engine, service: f.service, db: 'srv_a', user: 'srv_a', method, sub, body, query: new URLSearchParams(query || '') });

test('a database that does not exist yet can be created, nothing else works before', async () => {
  const f = fake({ exists: false });
  assert.deepStrictEqual((await call(f, 'GET', '')).body, { ok: true, exists: false, connection: null, tables: [] });
  assert.strictEqual((await call(f, 'GET', '/tables/players')).status, 404);
  assert.strictEqual((await call(f, 'POST', '/query', { sql: 'SELECT 1' })).status, 404);
  const created = await call(f, 'POST', '/create');
  assert.strictEqual(created.status, 200);
  assert.deepStrictEqual(f.log.find((l) => l.ensure).ensure, ['srv_a', 'srv_a']);
});

test('the overview lists tables and the connection', async () => {
  const f = fake();
  const out = (await call(f, 'GET', '')).body;
  assert.deepStrictEqual([out.exists, out.tables, out.connection.jdbc], [true, ['players'], 'jdbc:mariadb://127.0.0.1:3307/srv_a']);
});

test('a table comes with its columns, primary key, count and a bounded page', async () => {
  const f = fake();
  const out = (await call(f, 'GET', '/tables/players', {}, 'limit=9999&offset=10')).body;
  assert.deepStrictEqual(out.primaryKey, ['id']);
  assert.deepStrictEqual([out.total, out.columnNames, out.rows], [2, ['id', 'name'], [['1', 'Steve'], ['2', null]]]);
  assert.deepStrictEqual(out.columns[0], { name: 'id', type: 'bigint(20)', nullable: false, key: 'PRI', default: null, extra: 'auto_increment' });
  assert.ok(f.log.some((l) => l.text === 'SELECT * FROM `players` LIMIT 500 OFFSET 10'));
});

test('rows and structure are changed with escaped, validated SQL', async () => {
  const f = fake();
  await call(f, 'POST', '/tables/players/rows', { values: { name: "O'Brien" } });
  await call(f, 'PATCH', '/tables/players/rows', { key: { id: '1' }, values: { name: 'x' } });
  await call(f, 'DELETE', '/tables/players/rows', { key: { id: '1' } });
  await call(f, 'POST', '/tables/players/columns', { name: 'score', type: 'int' });
  await call(f, 'DELETE', '/tables/players/columns/score');
  await call(f, 'POST', '/tables', { name: 'logs', columns: [{ name: 'id', type: 'int' }], primaryKey: ['id'] });
  await call(f, 'DELETE', '/tables/logs');
  assert.deepStrictEqual(f.log.map((l) => l.text), [
    "INSERT INTO `players` (`name`) VALUES ('O''Brien')",
    "UPDATE `players` SET `name` = 'x' WHERE `id` = '1' LIMIT 1",
    "DELETE FROM `players` WHERE `id` = '1' LIMIT 1",
    'ALTER TABLE `players` ADD COLUMN `score` INT NULL',
    'ALTER TABLE `players` DROP COLUMN `score`',
    'CREATE TABLE `logs` (`id` INT NULL, PRIMARY KEY (`id`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
    'DROP TABLE `logs`',
  ]);
});

test('hostile names never reach the database', async () => {
  const f = fake();
  await assert.rejects(() => call(f, 'GET', `/tables/${encodeURIComponent('x`; DROP TABLE y; --')}`), /invalid name/);
  await assert.rejects(() => call(f, 'POST', '/tables', { name: 'a', columns: [{ name: 'b', type: 'int); DROP' }] }), /unsupported column type/);
  await assert.rejects(() => call(f, 'DELETE', '/tables/players/rows', { key: {} }), /primary key/);
  assert.strictEqual(f.log.length, 0);
});

test('the SQL console runs one statement and cuts long results', async () => {
  const f = fake();
  f.engine.inDatabase = async () => ({ columns: ['n'], rows: Array.from({ length: 1500 }, (_, i) => [String(i)]) });
  const out = (await call(f, 'POST', '/query', { sql: 'SELECT n FROM t' })).body;
  assert.deepStrictEqual([out.rows.length, out.truncated, out.total], [1000, true, 1500]);
  await assert.rejects(() => call(f, 'POST', '/query', { sql: '   ' }), /write a SQL statement/);
  await assert.rejects(() => call(f, 'POST', '/query', { sql: 'x'.repeat(20001) }), /too long/);
});

test('password reset, drop and unknown endpoints', async () => {
  const f = fake();
  assert.strictEqual((await call(f, 'POST', '/reset-password')).body.connection.password, 'new');
  assert.deepStrictEqual((await call(f, 'DELETE', '')).body, { ok: true, exists: false });
  assert.ok(f.log.some((l) => l.drop === 'srv_a'));
  assert.strictEqual((await call(f, 'GET', '/nope')).status, 404);
});
