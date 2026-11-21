const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMariaDb, pickRelease } = require('../panel/runtime/mariadb');
const sql = require('../panel/core/modules/db-sql');

test('the newest release with a Linux x86_64 tarball and a checksum is picked', () => {
  const file = (name, sha256sum) => ({ file_name: name, checksum: { sha256sum } });
  const meta = { releases: {
    '11.4.9': { files: [file('mariadb-11.4.9-linux-systemd-x86_64.tar.gz', 'aa')] },
    '11.4.14': { files: [file('mariadb-11.4.14.tar.gz', 'bb')] },
    '11.4.13': { files: [file('mariadb-11.4.13-linux-systemd-x86_64.tar.gz', 'cc'), file('mariadb-11.4.13-winx64.zip', 'dd')] },
  } };
  assert.deepStrictEqual(pickRelease(meta), { version: '11.4.13', name: 'mariadb-11.4.13-linux-systemd-x86_64.tar.gz', sha256: 'cc', url: 'https://archive.mariadb.org/mariadb-11.4.13/bintar-linux-systemd-x86_64/mariadb-11.4.13-linux-systemd-x86_64.tar.gz' });
  assert.strictEqual(pickRelease({ releases: { '1.0': { files: [] } } }), null);
});

function engine(overrides = {}) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mdb-'));
  const lines = [];
  return { dataRoot, lines, db: createMariaDb({ dataRoot, credsFile: path.join(dataRoot, 'db.json'), log: (l) => lines.push(l), pathEnv: '', ...overrides }) };
}

test('without MariaDB the status says so, and installing refuses on unsupported hosts', async () => {
  const { db } = engine({ platform: 'darwin' });
  assert.deepStrictEqual([db.status().installed, db.status().running, db.status().canDownload], [false, false, false]);
  await assert.rejects(() => db.install(), /package manager/);
  await assert.rejects(() => db.run('SELECT 1'), /not installed/);
});

test('a corrupt download is refused and leaves nothing behind', async () => {
  const meta = { releases: { '11.4.13': { files: [{ file_name: 'mariadb-11.4.13-linux-systemd-x86_64.tar.gz', checksum: { sha256sum: 'expected' } }] } } };
  const { db, dataRoot } = engine({
    platform: 'linux', arch: 'x64',
    getText: async () => JSON.stringify(meta),
    download: async (url, file) => fs.writeFileSync(file, 'junk'),
    sha256: async () => 'something else',
    extract: async () => { throw new Error('must not unpack'); },
  });
  await assert.rejects(() => db.install(), /corrupt/);
  assert.ok(!fs.existsSync(path.join(dataRoot, 'mariadb', 'server.part')));
  assert.ok(!fs.existsSync(path.join(dataRoot, 'mariadb', 'server')));
});

// Needs a real MariaDB: MEOW_TEST_MARIADB_BIN points at its bin folder.
const real = process.env.MEOW_TEST_MARIADB_BIN;
test('against a real MariaDB: databases, users, tables and rows', { skip: real ? false : 'set MEOW_TEST_MARIADB_BIN', timeout: 180000 }, async () => {
  const { db } = engine({ pathEnv: real, port: 33907 });
  try {
    await db.start();
    assert.strictEqual(db.status().running, true);
    assert.ok(db.readCreds().rootPassword, 'the root password was set and stored');
    await assert.rejects(() => db.run('SELECT 1', { user: 'root', password: null }), /Access denied/);

    const a = await db.ensureDatabase('srv_a', 'srv_a');
    const net = await db.ensureDatabase('network', 'network');
    assert.deepStrictEqual([a.host, a.port, a.database, a.user], ['127.0.0.1', 33907, 'srv_a', 'srv_a']);
    assert.match(a.jdbc, /^jdbc:mariadb:\/\/127\.0\.0\.1:33907\/srv_a$/);

    await db.inDatabase('srv_a', sql.createTable({ name: 'players', columns: [{ name: 'id', type: 'bigint', nullable: false, autoIncrement: true }, { name: 'name', type: 'varchar', size: 16 }, { name: 'note', type: 'text' }], primaryKey: ['id'] }));
    await db.inDatabase('srv_a', sql.insertRow('players', { name: "O'Brien", note: 'two\nlines\tand tab \\ slash' }));
    await db.inDatabase('srv_a', sql.insertRow('players', { name: 'Steve' }));
    const rows = await db.inDatabase('srv_a', sql.selectRows('players'));
    assert.deepStrictEqual(rows.columns, ['id', 'name', 'note']);
    assert.deepStrictEqual(rows.rows, [['1', "O'Brien", 'two\nlines\tand tab \\ slash'], ['2', 'Steve', null]]);
    await db.inDatabase('srv_a', sql.updateRow('players', { id: 2 }, { name: 'Alex' }));
    await db.inDatabase('srv_a', sql.deleteRow('players', { id: 1 }));
    assert.deepStrictEqual((await db.inDatabase('srv_a', sql.countRows('players'))).rows, [['1']]);
    assert.deepStrictEqual((await db.inDatabase('srv_a', sql.listTables())).rows.map((r) => r[0]), ['players']);
    assert.strictEqual((await db.inDatabase('srv_a', sql.describeTable('players'))).rows.find((r) => r[0] === 'id')[3], 'PRI');

    await assert.rejects(() => db.inDatabase('srv_a', 'SELECT * FROM network.x'), /denied|doesn't exist/i);
    await assert.rejects(() => db.run('SELECT 1', { user: 'srv_a', password: 'wrong' }), /Access denied/);
    await assert.rejects(() => db.inDatabase('srv_a', 'CREATE USER x IDENTIFIED BY \'y\''), /denied/i);
    await db.inDatabase('network', 'CREATE TABLE shared (k INT)');

    const sizes = await db.sizes();
    assert.ok(sizes.srv_a.tables === 1 && sizes.network.tables === 1);

    const before = db.connection('srv_a').password;
    const after = await db.resetPassword('srv_a');
    assert.notStrictEqual(after.password, before);
    await assert.rejects(() => db.run('SELECT 1', { user: 'srv_a', password: before }), /Access denied/);
    assert.strictEqual((await db.inDatabase('srv_a', sql.countRows('players'))).rows[0][0], '1');

    await db.dropDatabase('srv_a');
    await assert.rejects(() => db.run('SELECT 1', { user: 'srv_a', password: after.password }), /Access denied/);
    assert.strictEqual(db.connection('srv_a'), null);
    assert.ok(net.password);
  } finally { await db.stop(); }
  assert.strictEqual(db.status().running, false);
});
