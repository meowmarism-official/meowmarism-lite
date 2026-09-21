// Installs the contents of a modpack into an instance folder: downloads, overrides, server overrides. Not the server software.
// All-or-nothing: everything is staged and verified first, then moved into place; a failure leaves the folder as it was.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { inspectMrpack, buildInstallPlan, ALLOWED_HOSTS } = require('./modpack');
const { openZip } = require('./zip-read');
const { createFiles } = require('./files');

const STAGING = '.meowmarism-modpack.tmp';
const BACKUP = '.meowmarism-modpack.old';
const META_FILE = '.meowmarism-modpack.json';
const CONCURRENCY = 4;

// Default downloader: https only, allowlisted hosts (also after redirects), never more than maxBytes.
function httpDownload(url, dest, { maxBytes, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const go = (u, hops) => {
      let parsed;
      try { parsed = new URL(u); } catch (_) { reject(new Error('invalid download URL')); return; }
      if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.hostname)) { reject(new Error('refusing to download from an unexpected host')); return; }
      https.get(u, { headers: { 'User-Agent': 'meowmarism modpack installer' }, timeout: timeoutMs }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops > 0) { res.resume(); go(new URL(res.headers.location, u).href, hops - 1); return; }
        if (res.statusCode !== 200) { res.resume(); reject(new Error(`download failed (${res.statusCode})`)); return; }
        const out = fs.createWriteStream(dest);
        let bytes = 0;
        res.on('data', (c) => { bytes += c.length; if (maxBytes != null && bytes > maxBytes) res.destroy(new Error('download is larger than declared')); });
        res.on('error', (err) => { out.destroy(); reject(err); });
        res.pipe(out);
        out.on('finish', resolve);
        out.on('error', reject);
      }).on('error', reject).on('timeout', function () { this.destroy(new Error('download timed out')); });
    };
    go(url, 3);
  });
}

function sha512Of(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha512');
    fs.createReadStream(file).on('data', (c) => hash.update(c)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}

// mrpack: Buffer or path. source: { projectId, versionId, packVersion } is stored next to the instance.
// download(url, dest, { maxBytes }) must write the file at dest (default: httpDownload).
async function installModpack({ mrpack, inspected, instanceDir, source = {}, download = httpDownload, log = () => {}, progress = () => {} }) {
  const buf = Buffer.isBuffer(mrpack) ? mrpack : fs.readFileSync(mrpack);
  const info = inspected || inspectMrpack(buf);
  const plan = buildInstallPlan(info, instanceDir);
  const zip = openZip(buf);
  const root = path.resolve(instanceDir);
  const { safePath } = createFiles({ root });
  const staging = path.join(root, STAGING);
  const backup = path.join(root, BACKUP);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.rmSync(backup, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  const moved = [];
  const createdDirs = [];
  const makeDir = (dir) => {
    const missing = [];
    for (let d = dir; !fs.existsSync(d) && d !== path.dirname(d); d = path.dirname(d)) missing.unshift(d);
    fs.mkdirSync(dir, { recursive: true });
    createdDirs.push(...missing);
  };
  const replaced = [];
  try {
    // Overrides win over downloads at the same path, so those downloads are not fetched at all.
    const overridden = new Set(plan.overrides.map((o) => o.path));
    const downloads = plan.downloads.filter((d) => !overridden.has(d.path));
    const staged = [];
    const total = downloads.length + plan.overrides.length;
    let done = 0, bytes = 0, failed = false;
    const tick = (phase) => progress({ phase, done, total, bytes });

    log(`Downloading ${downloads.length} files (${plan.downloadBytes} bytes)…`);
    let next = 0;
    async function worker() {
      while (!failed && next < downloads.length) {
        const index = next++;
        const d = downloads[index];
        const file = path.join(staging, `d${index}`);
        let lastError;
        let ok = false;
        for (const url of d.urls) {
          try {
            await download(url, file, { maxBytes: d.size });
            const stat = fs.statSync(file);
            if (stat.size !== d.size) throw new Error(`size mismatch for ${d.path}`);
            if (await sha512Of(file) !== d.sha512) throw new Error(`checksum mismatch for ${d.path}`);
            ok = true;
            break;
          } catch (err) { lastError = err; fs.rmSync(file, { force: true }); log(`${d.path}: ${err.message}`); }
        }
        if (!ok) { failed = true; throw lastError || new Error(`no working download for ${d.path}`); }
        staged.push({ path: d.path, file });
        done++; bytes += d.size; tick('downloads');
      }
    }
    const results = await Promise.allSettled(Array.from({ length: Math.min(CONCURRENCY, downloads.length) }, worker));
    const rejected = results.find((r) => r.status === 'rejected');
    if (rejected) throw rejected.reason;

    log(`Extracting ${plan.overrides.length} override files…`);
    // Normal overrides first, server overrides last: the map keeps the winner per path.
    const ordered = [...plan.overrides].sort((a, b) => (a.source === b.source ? 0 : a.source === 'overrides' ? -1 : 1));
    const finals = new Map(staged.map((s) => [s.path, s.file]));
    ordered.forEach((o, index) => {
      const file = path.join(staging, `o${index}`);
      fs.writeFileSync(file, zip.read(o.entry));
      finals.set(o.path, file);
      done++; tick('overrides');
    });

    log('Moving files into place…');
    fs.mkdirSync(backup, { recursive: true });
    let n = 0;
    for (const [rel, file] of finals) {
      const dest = safePath(rel);
      if (!dest) throw new Error(`path leaves the instance folder: ${rel}`);
      makeDir(path.dirname(dest));
      if (!safePath(rel)) throw new Error(`path leaves the instance folder: ${rel}`);
      if (fs.existsSync(dest)) {
        const saved = path.join(backup, String(n++));
        fs.renameSync(dest, saved);
        replaced.push({ dest, saved });
      }
      fs.renameSync(file, dest);
      moved.push(dest);
    }
    const meta = {
      source: { type: 'modrinth-modpack', ...source },
      name: plan.name, packVersion: source.packVersion || plan.versionId,
      minecraft: plan.minecraft, loader: plan.loader, loaderVersion: plan.loaderVersion, installedAt: new Date().toISOString(),
    };
    const metaFile = path.join(root, META_FILE);
    fs.writeFileSync(`${metaFile}.part`, JSON.stringify(meta, null, 2));
    fs.renameSync(`${metaFile}.part`, metaFile);
    progress({ phase: 'done', done: total, total, bytes });
    return { plan, meta, files: finals.size };
  } catch (err) {
    for (const dest of moved) fs.rmSync(dest, { force: true });
    for (const { dest, saved } of replaced.reverse()) { try { fs.renameSync(saved, dest); } catch (_) {} }
    for (const dir of createdDirs.reverse()) { try { fs.rmdirSync(dir); } catch (_) {} }
    fs.rmSync(path.join(root, `${META_FILE}.part`), { force: true });
    throw err;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(backup, { recursive: true, force: true });
  }
}

module.exports = { installModpack, httpDownload, META_FILE };
