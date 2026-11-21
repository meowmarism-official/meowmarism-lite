// The managed MariaDB: the panel downloads it (or uses the system one), runs it on localhost only and talks to it
// through its command line client. One shared root account stays inside the panel; every database gets its own user.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const sql = require('../core/modules/db-sql');

const DEFAULT_PORT = 3307;
const SERIES = '11.4';
const API = 'https://downloads.mariadb.org/rest-api/mariadb';
const READY_TIMEOUT_MS = 90000;
const MAX_OUTPUT = 16 * 1024 * 1024;
const EXE = process.platform === 'win32' ? '.exe' : '';

function firstExisting(candidates) {
  return candidates.find((file) => { try { return fs.statSync(file).isFile(); } catch (_) { return false; } }) || null;
}

function findOnPath(names, pathEnv) {
  for (const dir of String(pathEnv || '').split(path.delimiter).filter(Boolean)) {
    const hit = firstExisting(names.map((n) => path.join(dir, n + EXE)));
    if (hit) return hit;
  }
  return null;
}

// The newest 11.4 release that has a Linux x86_64 tarball.
function pickRelease(meta) {
  const versions = Object.keys(meta.releases || {}).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    const file = (meta.releases[version].files || []).find((f) => /linux-systemd-x86_64\.tar\.gz$/.test(f.file_name));
    if (file && file.checksum && file.checksum.sha256sum) {
      return { version, name: file.file_name, sha256: file.checksum.sha256sum, url: `https://archive.mariadb.org/mariadb-${version}/bintar-linux-systemd-x86_64/${file.file_name}` };
    }
  }
  return null;
}

// deps: { dataRoot, credsFile, port?, pathEnv?, log(text), download(url, file), extract(archive, dir), getText(url), sha256(file), platform?, arch? }
function createMariaDb(deps) {
  const { dataRoot, credsFile, log } = deps;
  const port = deps.port || DEFAULT_PORT;
  const root = path.join(dataRoot, 'mariadb');
  const serverDir = path.join(root, 'server');
  const dataDir = path.join(root, 'data');
  const errorLog = path.join(root, 'error.log');
  let child = null;
  let startPromise = null;
  let ready = false;
  let lastError = null;

  function tools() {
    const own = {
      server: firstExisting([path.join(serverDir, 'bin', `mariadbd${EXE}`)]),
      client: firstExisting([path.join(serverDir, 'bin', `mariadb${EXE}`), path.join(serverDir, 'bin', `mysql${EXE}`)]),
      installDb: firstExisting([path.join(serverDir, 'scripts', 'mariadb-install-db'), path.join(serverDir, 'bin', `mariadb-install-db${EXE}`)]),
    };
    if (own.server && own.client && own.installDb) return { ...own, source: 'panel', basedir: serverDir };
    const env = deps.pathEnv !== undefined ? deps.pathEnv : process.env.PATH;
    const sys = {
      server: findOnPath(['mariadbd', 'mysqld'], env),
      client: findOnPath(['mariadb', 'mysql'], env),
      installDb: findOnPath(['mariadb-install-db', 'mysql_install_db'], env),
    };
    return sys.server && sys.client && sys.installDb ? { ...sys, source: 'system', basedir: null } : null;
  }

  function readCreds() {
    try {
      const saved = JSON.parse(fs.readFileSync(credsFile, 'utf8'));
      return { rootPassword: saved.rootPassword || null, databases: saved.databases && typeof saved.databases === 'object' ? saved.databases : {} };
    } catch (_) { return { rootPassword: null, databases: {} }; }
  }
  function writeCreds(creds) {
    fs.mkdirSync(path.dirname(credsFile), { recursive: true });
    const tmp = `${credsFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(creds, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, credsFile);
  }

  // Runs one SQL text through the client and returns the first result as { columns, rows }.
  function run(text, { user = 'root', password = null, db = null, timeoutMs = 30000 } = {}) {
    const t = tools();
    if (!t) return Promise.reject(new Error('MariaDB is not installed'));
    const args = ['--no-defaults', '--protocol=tcp', '--host=127.0.0.1', `--port=${port}`, `--user=${user}`, '--batch', '--default-character-set=utf8mb4', '--connect-timeout=5'];
    if (db) { sql.ident(db); args.push(`--database=${db}`); }
    args.push(`--execute=${text}`);
    return new Promise((resolve, reject) => {
      const env = { ...process.env };
      delete env.MYSQL_PWD;
      if (password) env.MYSQL_PWD = password;
      const proc = spawn(t.client, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      let overflow = false;
      const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('the query took too long')); }, timeoutMs);
      proc.stdout.on('data', (d) => { if (out.length + d.length > MAX_OUTPUT) overflow = true; else out += d; });
      proc.stderr.on('data', (d) => { if (err.length < 8192) err += d; });
      proc.on('error', (e) => { clearTimeout(timer); reject(e); });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (overflow) return reject(new Error('the result is too large, add a LIMIT'));
        if (code !== 0) return reject(new Error(err.replace(/^.*?(ERROR \d+.*)$/s, '$1').trim().split('\n')[0] || `the client exited with ${code}`));
        return resolve(sql.parseBatch(out));
      });
    });
  }

  const asRoot = (text, options = {}) => {
    const { rootPassword } = readCreds();
    return run(text, { ...options, user: 'root', password: rootPassword });
  };

  async function install() {
    const platform = deps.platform || process.platform;
    const arch = deps.arch || process.arch;
    if (tools()) { log('MariaDB is already available'); return; }
    if (platform !== 'linux' || arch !== 'x64') throw new Error('the panel can only download MariaDB for Linux on x86_64; install mariadb-server with your package manager and the panel will use it');
    log('looking up the latest MariaDB release');
    const release = pickRelease(JSON.parse(await deps.getText(`${API}/${SERIES}/`)));
    if (!release) throw new Error('no MariaDB download was found');
    const part = `${serverDir}.part`;
    fs.rmSync(part, { recursive: true, force: true });
    fs.mkdirSync(part, { recursive: true });
    const archive = path.join(part, 'mariadb.tar.gz');
    try {
      log(`downloading MariaDB ${release.version} (about 360 MB)`);
      await deps.download(release.url, archive);
      log('checking the download');
      if ((await deps.sha256(archive)) !== release.sha256) throw new Error('the MariaDB download is corrupt (checksum mismatch)');
      log('unpacking');
      await deps.extract(archive, part);
      fs.rmSync(archive, { force: true });
      fs.rmSync(serverDir, { recursive: true, force: true });
      fs.renameSync(part, serverDir);
    } catch (err) {
      fs.rmSync(part, { recursive: true, force: true });
      throw err;
    }
    log('MariaDB installed');
  }

  function initialize(t) {
    if (fs.existsSync(path.join(dataDir, 'mysql'))) return Promise.resolve();
    log('creating the database storage');
    fs.mkdirSync(dataDir, { recursive: true });
    const args = process.platform === 'win32' ? [`--datadir=${dataDir}`] : ['--no-defaults', `--datadir=${dataDir}`, '--auth-root-authentication-method=normal', '--skip-test-db'];
    if (t.basedir) args.push(`--basedir=${t.basedir}`);
    return new Promise((resolve, reject) => {
      const proc = spawn(t.installDb, args, { cwd: t.basedir || undefined, stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      proc.stdout.on('data', (d) => { if (err.length < 4000) err += d; });
      proc.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
      proc.on('error', reject);
      proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`creating the storage failed: ${err.trim().split('\n').slice(-3).join(' ')}`))));
    });
  }

  // Before the first normal start the only root account becomes root@127.0.0.1 with a password; the panel connects over TCP.
  function bootstrapRoot(t, password) {
    const text = [
      'FLUSH PRIVILEGES',
      "DROP USER IF EXISTS ''@'localhost'",
      "DROP USER IF EXISTS 'root'@'localhost'",
      "DROP USER IF EXISTS 'root'@'::1'",
      `CREATE USER IF NOT EXISTS 'root'@'127.0.0.1' IDENTIFIED BY ${sql.str(password)}`,
      `ALTER USER 'root'@'127.0.0.1' IDENTIFIED BY ${sql.str(password)}`,
      "GRANT ALL PRIVILEGES ON *.* TO 'root'@'127.0.0.1' WITH GRANT OPTION",
      'FLUSH PRIVILEGES',
    ].join(';\n') + ';\n';
    const args = ['--no-defaults', '--bootstrap', '--skip-networking', `--datadir=${dataDir}`];
    if (t.basedir) args.push(`--basedir=${t.basedir}`);
    return new Promise((resolve, reject) => {
      const proc = spawn(t.server, args, { cwd: t.basedir || undefined, stdio: ['pipe', 'pipe', 'pipe'] });
      let err = '';
      proc.stdout.on('data', (d) => { if (err.length < 4000) err += d; });
      proc.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
      proc.on('error', reject);
      proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`securing the root account failed: ${err.trim().split('\n').slice(-2).join(' ')}`))));
      proc.stdin.end(text);
    });
  }

  async function waitReady(deadline) {
    while (Date.now() < deadline) {
      if (!child) throw new Error(`MariaDB stopped while starting${lastError ? `: ${lastError}` : ''}`);
      try {
        await run('SELECT 1', { user: 'root', password: readCreds().rootPassword, timeoutMs: 4000 });
        return;
      } catch (err) {
        if (/Access denied/i.test(err.message)) throw new Error('the root password of the database does not match, remove the data folder to start over');
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    throw new Error('MariaDB did not become ready in time');
  }

  async function doStart() {
    const t = tools();
    if (!t) throw new Error('MariaDB is not installed');
    const known = readCreds().rootPassword;
    if (known) {
      try {
        await run('SELECT 1', { user: 'root', password: known, timeoutMs: 3000 });
        ready = true;
        log('MariaDB is already running');
        return;
      } catch (_) { /* not running, start it below */ }
    }
    await initialize(t);
    if (!readCreds().rootPassword) {
      const password = sql.newPassword();
      log('securing the root account');
      await bootstrapRoot(t, password);
      writeCreds({ ...readCreds(), rootPassword: password });
    }
    const args = ['--no-defaults', `--datadir=${dataDir}`, `--port=${port}`, '--bind-address=127.0.0.1', '--skip-name-resolve',
      '--character-set-server=utf8mb4', '--collation-server=utf8mb4_unicode_ci', '--max-connections=100', '--innodb-buffer-pool-size=128M',
      `--log-error=${errorLog}`, `--pid-file=${path.join(root, 'mariadb.pid')}`];
    if (t.basedir) args.push(`--basedir=${t.basedir}`);
    log('starting MariaDB');
    lastError = null;
    const proc = spawn(t.server, args, { cwd: t.basedir || undefined, stdio: ['ignore', 'ignore', 'pipe'] });
    child = proc;
    proc.stderr.on('data', (d) => { lastError = String(d).trim().split('\n').slice(-1)[0] || lastError; });
    proc.on('exit', () => { if (child === proc) { child = null; ready = false; } });
    proc.on('error', (err) => { lastError = err.message; if (child === proc) child = null; });
    await waitReady(Date.now() + READY_TIMEOUT_MS);
    ready = true;
    log('MariaDB is running');
  }

  function start() {
    if (child || ready) return startPromise || Promise.resolve();
    startPromise = doStart().catch(async (err) => {
      const proc = child;
      child = null;
      ready = false;
      if (proc) { try { proc.kill('SIGKILL'); } catch (_) {} }
      throw new Error(lastError && !err.message.includes(lastError) ? `${err.message} (${lastError})` : err.message);
    });
    return startPromise;
  }

  async function stop() {
    const proc = child;
    if (!proc) {
      if (ready) { try { await asRoot('SHUTDOWN', { timeoutMs: 8000 }); } catch (_) {} ready = false; }
      return;
    }
    const exited = new Promise((resolve) => proc.once('exit', resolve));
    try { await asRoot('SHUTDOWN', { timeoutMs: 8000 }); } catch (_) { proc.kill('SIGTERM'); }
    const killer = setTimeout(() => proc.kill('SIGKILL'), 30000);
    await exited;
    clearTimeout(killer);
    child = null;
    ready = false;
  }

  // Creates (or updates) a database with its own user and returns how to connect to it.
  async function ensureDatabase(db, user) {
    const creds = readCreds();
    const password = (creds.databases[db] && creds.databases[db].password) || sql.newPassword();
    for (const statement of sql.createDatabase({ db, user, password })) await asRoot(statement);
    creds.databases[db] = { user, password };
    writeCreds(creds);
    return connection(db);
  }

  function connection(db) {
    const entry = readCreds().databases[db];
    if (!entry) return null;
    return { host: '127.0.0.1', port, database: db, user: entry.user, password: entry.password, jdbc: `jdbc:mariadb://127.0.0.1:${port}/${db}` };
  }

  async function resetPassword(db) {
    const creds = readCreds();
    const entry = creds.databases[db];
    if (!entry) throw new Error('no such database');
    const password = sql.newPassword();
    for (const statement of sql.createDatabase({ db, user: entry.user, password })) await asRoot(statement);
    creds.databases[db] = { user: entry.user, password };
    writeCreds(creds);
    return connection(db);
  }

  async function dropDatabase(db) {
    const creds = readCreds();
    const entry = creds.databases[db];
    if (!entry) throw new Error('no such database');
    for (const statement of sql.dropDatabase({ db, user: entry.user })) await asRoot(statement);
    delete creds.databases[db];
    writeCreds(creds);
  }

  // Runs SQL as the user of one database, so a query can never reach another database.
  function inDatabase(db, text, options = {}) {
    const entry = readCreds().databases[db];
    if (!entry) return Promise.reject(new Error('no such database'));
    return run(text, { ...options, user: entry.user, password: entry.password, db });
  }

  async function sizes() {
    const out = await asRoot('SELECT table_schema AS db, COALESCE(SUM(data_length + index_length), 0) AS bytes, COUNT(*) AS tables FROM information_schema.tables GROUP BY table_schema');
    return Object.fromEntries(out.rows.map(([db, bytes, tables]) => [db, { bytes: Number(bytes), tables: Number(tables) }]));
  }

  function status() {
    const t = tools();
    return { installed: !!t, source: t ? t.source : null, running: ready, port, error: lastError, canDownload: (deps.platform || process.platform) === 'linux' && (deps.arch || process.arch) === 'x64' };
  }

  return { tools, status, install, start, stop, run, asRoot, inDatabase, ensureDatabase, connection, resetPassword, dropDatabase, sizes, readCreds, dirs: { root, serverDir, dataDir } };
}

module.exports = { createMariaDb, pickRelease, DEFAULT_PORT };
