// What the panel and the HTTP API do with a database: browse and change tables and rows, run SQL.
// Everything runs as the database's own user, so it can never reach another database.
const sql = require('./core/modules/db-sql');

const QUERY_ROW_LIMIT = 1000;
const MAX_PAGE = sql.MAX_ROWS;

function column(row) {
  return { name: row[0], type: row[1], nullable: row[2] === 'YES', key: row[3] || '', default: row[4], extra: row[5] || '' };
}

function createDbService(engine) {
  const q = (db, text) => engine.inDatabase(db, text);

  async function tables(db) {
    return (await q(db, sql.listTables())).rows.map((r) => r[0]);
  }

  async function table(db, name, { limit = 50, offset = 0 } = {}) {
    const columns = (await q(db, sql.describeTable(name))).rows.map(column);
    const total = Number((await q(db, sql.countRows(name))).rows[0][0]);
    const page = await q(db, sql.selectRows(name, { limit: Math.min(MAX_PAGE, Number(limit) || 50), offset }));
    return { name, columns, primaryKey: columns.filter((c) => c.key === 'PRI').map((c) => c.name), total, columnNames: page.columns, rows: page.rows };
  }

  async function run(db, statement) {
    await q(db, statement);
    return { ok: true };
  }

  async function query(db, text) {
    const statement = String(text || '').trim();
    if (!statement) throw new Error('write a SQL statement first');
    if (statement.length > 20000) throw new Error('the statement is too long');
    const out = await q(db, statement);
    return { columns: out.columns, rows: out.rows.slice(0, QUERY_ROW_LIMIT), truncated: out.rows.length > QUERY_ROW_LIMIT, total: out.rows.length };
  }

  return {
    tables, table, query,
    createTable: (db, spec) => run(db, sql.createTable(spec)),
    dropTable: (db, name) => run(db, sql.dropTable(name)),
    addColumn: (db, name, col) => run(db, sql.addColumn(name, col)),
    dropColumn: (db, name, col) => run(db, sql.dropColumn(name, col)),
    insertRow: (db, name, values) => run(db, sql.insertRow(name, values)),
    updateRow: (db, name, key, values) => run(db, sql.updateRow(name, key, values)),
    deleteRow: (db, name, key) => run(db, sql.deleteRow(name, key)),
  };
}

// Maps a request below a database to the service. sub: path after the database, e.g. '/tables/players/rows'.
// Returns { status, body }. connection() and the lifecycle calls come from deps: { engine, service, db, user, exists() }.
async function route({ engine, service, db, user, method, sub, body = {}, query = new URLSearchParams() }) {
  const ok = (data = {}) => ({ status: 200, body: { ok: true, ...data } });
  const bad = (status, error) => ({ status, body: { ok: false, error } });
  const have = !!engine.connection(db);
  const m = (re) => re.exec(sub || '');
  let x;

  if (method === 'GET' && !sub) {
    if (!have) return ok({ exists: false, connection: null, tables: [] });
    return ok({ exists: true, connection: engine.connection(db), tables: await service.tables(db) });
  }
  if (method === 'POST' && sub === '/create') return ok({ exists: true, connection: await engine.ensureDatabase(db, user) });
  if (!have) return bad(404, 'this database has not been created yet');
  if (method === 'POST' && sub === '/reset-password') return ok({ connection: await engine.resetPassword(db) });
  if (method === 'DELETE' && !sub) { await engine.dropDatabase(db); return ok({ exists: false }); }
  if (method === 'POST' && sub === '/query') return ok(await service.query(db, body.sql));
  if (method === 'POST' && sub === '/tables') return ok(await service.createTable(db, body));
  if ((x = m(/^\/tables\/([^/]+)$/))) {
    if (method === 'GET') return ok(await service.table(db, decodeURIComponent(x[1]), { limit: query.get('limit') || 50, offset: query.get('offset') || 0 }));
    if (method === 'DELETE') return ok(await service.dropTable(db, decodeURIComponent(x[1])));
  }
  if ((x = m(/^\/tables\/([^/]+)\/columns$/)) && method === 'POST') return ok(await service.addColumn(db, decodeURIComponent(x[1]), body));
  if ((x = m(/^\/tables\/([^/]+)\/columns\/([^/]+)$/)) && method === 'DELETE') return ok(await service.dropColumn(db, decodeURIComponent(x[1]), decodeURIComponent(x[2])));
  if ((x = m(/^\/tables\/([^/]+)\/rows$/))) {
    const name = decodeURIComponent(x[1]);
    if (method === 'POST') return ok(await service.insertRow(db, name, body.values));
    if (method === 'PATCH') return ok(await service.updateRow(db, name, body.key, body.values));
    if (method === 'DELETE') return ok(await service.deleteRow(db, name, body.key));
  }
  return bad(404, 'no such endpoint');
}

module.exports = { createDbService, route, QUERY_ROW_LIMIT };
