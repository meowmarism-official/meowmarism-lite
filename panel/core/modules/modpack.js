// Modrinth modpacks (.mrpack): inspectMrpack() validates and describes a pack, buildInstallPlan() turns that into safe target paths.
// Neither writes anything. A pack that breaks a rule is rejected as a whole, never half-read.
const fs = require('fs');
const crypto = require('crypto');
const { openZip } = require('./zip-read');
const { createFiles } = require('./files');

const ALLOWED_HOSTS = new Set(['cdn.modrinth.com', 'github.com', 'raw.githubusercontent.com', 'gitlab.com']);
const MAX_PACK_BYTES = 1024 * 1024 * 1024;
const MAX_INDEX_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_OVERRIDE_BYTES = 4 * 1024 * 1024 * 1024;
const LOADER_KEYS = { 'fabric-loader': 'fabric', 'quilt-loader': 'quilt', forge: 'forge', neoforge: 'neoforge' };
// Files and folders Meowmarism or the loader installer generates; a pack must not replace them.
const PROTECTED_TOP = new Set([
  'panel-config.json',
  'run.sh', 'run.bat', 'start.sh', 'start.bat',
  'user_jvm_args.txt', 'args_extra.txt',
  'server.jar', 'fabric-server-launch.jar',
  'libraries',
]);

const reject = (message) => { throw new Error(`modpack rejected: ${message}`); };

// Relative, forward-slash paths only: no absolute paths, drive letters, backslashes or dot segments.
function safeRelativePath(p) {
  if (typeof p !== 'string' || !p || p.length > 260) return false;
  if (/[\\\0]/.test(p) || p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return false;
  return p.split('/').every((s) => s && s !== '.' && s !== '..');
}

function protectedPath(p) {
  const top = p.split('/')[0].toLowerCase();
  return PROTECTED_TOP.has(top) || top.startsWith('.meowmarism');
}

function checkUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (_) { return false; }
  return u.protocol === 'https:' && ALLOWED_HOSTS.has(u.hostname) && !u.username && !u.password;
}

function parseIndex(zip) {
  if (!zip.has('modrinth.index.json')) reject('modrinth.index.json is missing');
  const entry = zip.entries.find((e) => e.name === 'modrinth.index.json');
  if (entry.size > MAX_INDEX_BYTES) reject('index is too large');
  let index;
  try { index = JSON.parse(zip.read('modrinth.index.json').toString('utf8')); } catch (_) { reject('index is not valid JSON'); }
  if (!index || typeof index !== 'object') reject('index is not valid JSON');
  if (index.formatVersion !== 1) reject('unsupported format version');
  if (index.game !== 'minecraft') reject('not a Minecraft pack');
  return index;
}

function parseDependencies(deps) {
  if (!deps || typeof deps !== 'object') reject('dependencies are missing');
  const minecraft = deps.minecraft;
  if (typeof minecraft !== 'string' || !/^[\w.+-]{1,32}$/.test(minecraft)) reject('Minecraft version is missing');
  const loaders = Object.keys(LOADER_KEYS).filter((k) => k in deps);
  if (loaders.length > 1) reject('more than one loader');
  const key = loaders[0];
  const loaderVersion = key ? deps[key] : '';
  if (key && (typeof loaderVersion !== 'string' || !/^[\w.+-]{1,64}$/.test(loaderVersion))) reject('loader version is invalid');
  return { minecraft, loader: key ? LOADER_KEYS[key] : 'vanilla', loaderVersion };
}

function parseFiles(list) {
  if (!Array.isArray(list)) reject('files list is missing');
  if (list.length > MAX_FILES) reject('too many files');
  const files = [], skipped = [], seen = new Set();
  let downloadBytes = 0;
  for (const f of list) {
    if (!f || typeof f !== 'object') reject('invalid file entry');
    if (!safeRelativePath(f.path)) reject(`unsafe path: ${String(f.path).slice(0, 80)}`);
    if (seen.has(f.path)) reject(`duplicate path: ${f.path}`);
    seen.add(f.path);
    if (protectedPath(f.path)) { skipped.push({ path: f.path, reason: 'protected' }); continue; }
    const sha512 = f.hashes && f.hashes.sha512;
    if (typeof sha512 !== 'string' || !/^[0-9a-f]{128}$/i.test(sha512)) reject(`missing SHA-512 for ${f.path}`);
    const size = f.fileSize;
    if (!Number.isInteger(size) || size < 0) reject(`missing size for ${f.path}`);
    if (size > MAX_FILE_BYTES) reject(`${f.path} is too large`);
    if (!Array.isArray(f.downloads) || !f.downloads.length) reject(`no download for ${f.path}`);
    if (!f.downloads.every((u) => typeof u === 'string' && checkUrl(u))) reject(`download host not allowed for ${f.path}`);
    const server = f.env && f.env.server;
    if (server === 'unsupported') { skipped.push({ path: f.path, reason: 'client only' }); continue; }
    downloadBytes += size;
    if (downloadBytes > MAX_DOWNLOAD_BYTES) reject('download is too large');
    files.push({ path: f.path, sha512: sha512.toLowerCase(), size, urls: [...f.downloads], optional: server === 'optional' });
  }
  return { files, skipped, downloadBytes };
}

function parseOverrides(zip, prefix, skipped) {
  const out = [];
  let total = 0;
  for (const e of zip.entries) {
    if (!e.name.startsWith(prefix) || e.dir) continue;
    const rel = e.name.slice(prefix.length);
    if (!safeRelativePath(rel)) reject(`unsafe path in ${prefix}: ${rel.slice(0, 80)}`);
    if (e.size > MAX_FILE_BYTES) reject(`${rel} is too large`);
    total += e.size;
    if (total > MAX_OVERRIDE_BYTES) reject('overrides are too large');
    if (protectedPath(rel)) { skipped.push({ path: rel, reason: 'protected' }); continue; }
    out.push({ path: rel, size: e.size });
  }
  return out;
}

// Mods a pack brings: jar files in mods/ from the download list and from both override folders.
function countMods({ files, overrides, serverOverrides }) {
  const isMod = (p) => /^mods\/.+\.jar$/i.test(p);
  return new Set([...files.map((f) => f.path), ...overrides.map((o) => o.path), ...serverOverrides.map((o) => o.path)].filter(isMod)).size;
}

function inspectMrpack(source) {
  let buf = source;
  if (typeof source === 'string') {
    if (fs.statSync(source).size > MAX_PACK_BYTES) reject('file is too large');
    buf = fs.readFileSync(source);
  }
  if (!Buffer.isBuffer(buf) || buf.length > MAX_PACK_BYTES) reject('file is too large');
  let zip;
  try { zip = openZip(buf); } catch (err) { reject(err.message); }
  const index = parseIndex(zip);
  const deps = parseDependencies(index.dependencies);
  const { files, skipped, downloadBytes } = parseFiles(index.files);
  const overrides = parseOverrides(zip, 'overrides/', skipped);
  const serverOverrides = parseOverrides(zip, 'server-overrides/', skipped);
  return {
    name: typeof index.name === 'string' ? index.name.slice(0, 100) : 'Modpack',
    versionId: typeof index.versionId === 'string' ? index.versionId.slice(0, 64) : '',
    ...deps,
    files, overrides, serverOverrides, skipped,
    modCount: countMods({ files, overrides, serverOverrides }),
    downloadBytes,
  };
}

// Server overrides replace normal overrides at the same path and are applied after them; overrides are applied after the downloads.
function buildInstallPlan(inspected, instanceDir) {
  const { safePath } = createFiles({ root: instanceDir });
  const target = (rel) => {
    const dest = safePath(rel);
    if (!dest) reject(`path leaves the instance folder: ${rel}`);
    return dest;
  };
  const downloads = inspected.files.map((f) => ({ ...f, dest: target(f.path) }));
  const merged = new Map();
  for (const [source, list] of [['overrides', inspected.overrides], ['server-overrides', inspected.serverOverrides]]) {
    for (const o of list) merged.set(o.path, { path: o.path, size: o.size, source, entry: `${source}/${o.path}`, dest: target(o.path) });
  }
  return {
    name: inspected.name, versionId: inspected.versionId,
    minecraft: inspected.minecraft, loader: inspected.loader, loaderVersion: inspected.loaderVersion,
    downloads,
    overrides: [...merged.values()],
    skipped: inspected.skipped,
    modCount: inspected.modCount,
    downloadBytes: inspected.downloadBytes,
  };
}

// For the installer: a downloaded file must match the size and SHA-512 the pack declared.
function verifyDownload(entry, data) {
  if (data.length !== entry.size) throw new Error(`size mismatch for ${entry.path}`);
  if (crypto.createHash('sha512').update(data).digest('hex') !== entry.sha512) throw new Error(`checksum mismatch for ${entry.path}`);
}

module.exports = { countMods, inspectMrpack, buildInstallPlan, verifyDownload, safeRelativePath, ALLOWED_HOSTS };
