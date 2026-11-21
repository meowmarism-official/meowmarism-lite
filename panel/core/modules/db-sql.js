// SQL building and result parsing for the managed MariaDB. Pure functions; every name is validated, every value escaped.
const crypto = require('crypto');

const NAME_RE = /^[A-Za-z0-9_]{1,64}$/;
const TYPES = {
  int: 'INT', bigint: 'BIGINT', smallint: 'SMALLINT', tinyint: 'TINYINT', boolean: 'BOOLEAN',
  double: 'DOUBLE', float: 'FLOAT', decimal: 'DECIMAL', varchar: 'VARCHAR', text: 'TEXT', longtext: 'LONGTEXT',
  date: 'DATE', datetime: 'DATETIME', timestamp: 'TIMESTAMP', uuid: 'UUID', json: 'JSON', blob: 'BLOB',
};
const SIZED = new Set(['varchar', 'decimal']);
const MAX_ROWS = 500;

function ident(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new Error(`invalid name: ${String(name).slice(0, 40)}`);
  return `\`${name}\``;
}

// A SQL string literal; backslashes and quotes are doubled and NUL bytes dropped.
function str(value) {
  return `'${String(value).replace(/\0/g, '').replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

function literal(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('invalid number');
    return String(value);
  }
  return str(value);
}

const newPassword = () => crypto.randomBytes(18).toString('base64url');

// srv_<instance>, shortened with a hash when the instance name is long.
function instanceDbName(instanceName) {
  const base = String(instanceName).replace(/[^A-Za-z0-9_]/g, '_');
  const name = `srv_${base}`;
  if (name.length <= 32) return name;
  return `${name.slice(0, 23)}_${crypto.createHash('sha1').update(base).digest('hex').slice(0, 8)}`;
}
const SHARED_DB = 'network';

function createDatabase({ db, user, password }) {
  return [
    `CREATE DATABASE IF NOT EXISTS ${ident(db)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    `CREATE USER IF NOT EXISTS ${str(user)}@'%' IDENTIFIED BY ${str(password)}`,
    `ALTER USER ${str(user)}@'%' IDENTIFIED BY ${str(password)}`,
    `GRANT ALL PRIVILEGES ON ${ident(db)}.* TO ${str(user)}@'%'`,
    'FLUSH PRIVILEGES',
  ].map((s) => { ident(db); if (!NAME_RE.test(user)) throw new Error('invalid user name'); return s; });
}

function dropDatabase({ db, user }) {
  if (!NAME_RE.test(user)) throw new Error('invalid user name');
  return [`DROP DATABASE IF EXISTS ${ident(db)}`, `DROP USER IF EXISTS ${str(user)}@'%'`, 'FLUSH PRIVILEGES'];
}

function columnSql(col) {
  const type = TYPES[String(col.type || '').toLowerCase()];
  if (!type) throw new Error(`unsupported column type: ${String(col.type).slice(0, 20)}`);
  const key = String(col.type).toLowerCase();
  let out = `${ident(col.name)} ${type}`;
  if (SIZED.has(key)) {
    const size = key === 'decimal' ? String(col.size || '10,2') : String(col.size || 255);
    if (!/^\d{1,3}(,\d{1,2})?$/.test(size)) throw new Error('invalid column size');
    out += `(${size})`;
  }
  out += col.nullable === false ? ' NOT NULL' : ' NULL';
  if (col.autoIncrement) out += ' AUTO_INCREMENT';
  if (col.default !== undefined && col.default !== null && col.default !== '') {
    out += ` DEFAULT ${col.default === 'CURRENT_TIMESTAMP' ? 'CURRENT_TIMESTAMP' : literal(col.default)}`;
  }
  return out;
}

// spec: { name, columns: [{ name, type, size?, nullable?, autoIncrement?, default? }], primaryKey?: [column names] }
function createTable(spec) {
  if (!Array.isArray(spec.columns) || !spec.columns.length) throw new Error('a table needs at least one column');
  const names = spec.columns.map((c) => c.name);
  if (new Set(names).size !== names.length) throw new Error('column names must be unique');
  const parts = spec.columns.map(columnSql);
  const pk = spec.primaryKey || [];
  for (const k of pk) if (!names.includes(k)) throw new Error(`primary key column ${k} does not exist`);
  if (pk.length) parts.push(`PRIMARY KEY (${pk.map(ident).join(', ')})`);
  return `CREATE TABLE ${ident(spec.name)} (${parts.join(', ')}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;
}

const addColumn = (table, col) => `ALTER TABLE ${ident(table)} ADD COLUMN ${columnSql(col)}`;
const dropColumn = (table, column) => `ALTER TABLE ${ident(table)} DROP COLUMN ${ident(column)}`;
const dropTable = (table) => `DROP TABLE ${ident(table)}`;
const listTables = () => 'SHOW FULL TABLES WHERE Table_type = \'BASE TABLE\'';
const describeTable = (table) => `SHOW COLUMNS FROM ${ident(table)}`;

function selectRows(table, { limit = 50, offset = 0 } = {}) {
  const l = Math.min(MAX_ROWS, Math.max(1, Math.floor(Number(limit)) || 50));
  const o = Math.max(0, Math.floor(Number(offset)) || 0);
  return `SELECT * FROM ${ident(table)} LIMIT ${l} OFFSET ${o}`;
}
const countRows = (table) => `SELECT COUNT(*) AS n FROM ${ident(table)}`;

function where(key) {
  const entries = Object.entries(key || {});
  if (!entries.length) throw new Error('a row needs its primary key');
  return entries.map(([c, v]) => (v === null ? `${ident(c)} IS NULL` : `${ident(c)} = ${literal(v)}`)).join(' AND ');
}

function insertRow(table, values) {
  const entries = Object.entries(values || {});
  if (!entries.length) return `INSERT INTO ${ident(table)} () VALUES ()`;
  return `INSERT INTO ${ident(table)} (${entries.map(([c]) => ident(c)).join(', ')}) VALUES (${entries.map(([, v]) => literal(v)).join(', ')})`;
}
function updateRow(table, key, values) {
  const entries = Object.entries(values || {});
  if (!entries.length) throw new Error('nothing to change');
  return `UPDATE ${ident(table)} SET ${entries.map(([c, v]) => `${ident(c)} = ${literal(v)}`).join(', ')} WHERE ${where(key)} LIMIT 1`;
}
const deleteRow = (table, key) => `DELETE FROM ${ident(table)} WHERE ${where(key)} LIMIT 1`;

// Output of `mariadb --batch`: a header line, then tab separated rows. NULL prints as NULL; \t \n \\ are escaped.
function unescapeCell(cell) {
  return cell.replace(/\\([tn0\\])/g, (_, c) => ({ t: '\t', n: '\n', 0: '\0', '\\': '\\' }[c]));
}
function parseBatch(output) {
  const lines = String(output || '').split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (!lines.length) return { columns: [], rows: [] };
  const columns = lines[0].split('\t');
  const rows = lines.slice(1).map((line) => line.split('\t').map((c) => (c === 'NULL' ? null : unescapeCell(c))));
  return { columns, rows };
}

module.exports = {
  NAME_RE, TYPES, MAX_ROWS, SHARED_DB, ident, str, literal, newPassword, instanceDbName,
  createDatabase, dropDatabase, createTable, addColumn, dropColumn, dropTable, listTables, describeTable,
  selectRows, countRows, insertRow, updateRow, deleteRow, parseBatch,
};
