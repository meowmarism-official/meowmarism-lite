// Modrinth integration: search, install (with required dependencies), update detection by file hash.
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const API = 'https://api.modrinth.com/v2';
const UA = 'meowmarism (https://github.com/meowmarism-official/meowmarism-lite)';
const MAX_JAR_BYTES = 300 * 1024 * 1024;
const SAFE_JAR = /^[\w.+\-()[\] ]+\.jar$/;
const SAFE_ZIP = /^(?!\.)[^\/:*?"<>|\x00-\x1f]{1,150}\.zip$/;
const KINDS = ['mod', 'datapack', 'resourcepack', 'shader', 'modpack'];
const kindOf = (k) => (KINDS.includes(k) ? k : 'mod');

function loadersFor(loader) {
  if (loader === 'purpur') return ['purpur', 'paper', 'spigot', 'bukkit'];
  if (loader === 'paper') return ['paper', 'spigot', 'bukkit'];
  if (loader === 'vanilla') return [];
  return [loader];
}
const projectTypeFor = (loader) => (loader === 'paper' || loader === 'purpur' ? 'plugin' : 'mod');

function request(method, url, body, redirects = 3) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      method, hostname: u.hostname, path: u.pathname + u.search, timeout: 20000,
      headers: { 'User-Agent': UA, Accept: 'application/json', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) { res.resume(); resolve(request(method, new URL(res.headers.location, url).href, body, redirects - 1)); return; }
      let data = '';
      res.on('data', (c) => { data += c; if (data.length > 8 * 1024 * 1024) req.destroy(new Error('response too large')); });
      res.on('end', () => {
        if (res.statusCode >= 400) { reject(new Error(`Modrinth answered ${res.statusCode}`)); return; }
        try { resolve(JSON.parse(data || 'null')); } catch (_) { reject(new Error('unexpected answer from Modrinth')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Modrinth timed out')));
    if (payload) req.write(payload);
    req.end();
  });
}

function downloadVerified(url, dest, sha512, size) {
  return new Promise((resolve, reject) => {
    const go = (u, hops) => {
      const parsed = new URL(u);
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'cdn.modrinth.com') { reject(new Error('refusing to download from an unexpected host')); return; }
      https.get(u, { headers: { 'User-Agent': UA }, timeout: 30000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops > 0) { res.resume(); go(new URL(res.headers.location, u).href, hops - 1); return; }
        if (res.statusCode !== 200) { res.resume(); reject(new Error(`download failed (${res.statusCode})`)); return; }
        const part = `${dest}.part`;
        const out = fs.createWriteStream(part);
        const hash = crypto.createHash('sha512');
        let bytes = 0;
        res.on('data', (c) => {
          bytes += c.length;
          if (bytes > MAX_JAR_BYTES) { res.destroy(new Error('file is too large')); return; }
          hash.update(c);
        });
        res.pipe(out);
        res.on('error', (err) => { out.destroy(); fs.rmSync(part, { force: true }); reject(err); });
        out.on('finish', () => {
          if (sha512 && hash.digest('hex') !== sha512) { fs.rmSync(part, { force: true }); reject(new Error('checksum mismatch, download discarded')); return; }
          if (size && bytes !== size) { fs.rmSync(part, { force: true }); reject(new Error('size mismatch, download discarded')); return; }
          fs.renameSync(part, dest);
          resolve();
        });
      }).on('error', reject).on('timeout', function () { this.destroy(new Error('download timed out')); });
    };
    go(url, 3);
  });
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const imageCache = new Map();
let imageCacheBytes = 0;
const MAX_IMAGE_CACHE_BYTES = 48 * 1024 * 1024;

// Fetches an image from Modrinth's CDN so the browser never talks to a third party. Small in-memory cache.
function fetchImage(rawUrl) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(rawUrl); } catch (_) { reject(new Error('bad url')); return; }
    if (u.protocol !== 'https:' || u.hostname !== 'cdn.modrinth.com') { reject(new Error('unexpected host')); return; }
    const hit = imageCache.get(u.href);
    if (hit) { imageCache.delete(u.href); imageCache.set(u.href, hit); resolve(hit); return; }
    https.get(u.href, { headers: { 'User-Agent': UA }, timeout: 15000 }, (res) => {
      const type = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (res.statusCode !== 200 || !IMAGE_TYPES.has(type)) { res.resume(); reject(new Error('not an image')); return; }
      const chunks = [];
      let bytes = 0;
      res.on('data', (c) => {
        bytes += c.length;
        if (bytes > MAX_IMAGE_BYTES) { res.destroy(new Error('image too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        const entry = { type, buf: Buffer.concat(chunks) };
        imageCache.set(u.href, entry);
        imageCacheBytes += entry.buf.length;
        while (imageCache.size > 150 || imageCacheBytes > MAX_IMAGE_CACHE_BYTES) {
          const oldest = imageCache.keys().next().value;
          imageCacheBytes -= imageCache.get(oldest).buf.length;
          imageCache.delete(oldest);
        }
        resolve(entry);
      });
      res.on('error', reject);
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('image timed out')); });
  });
}

function sha1File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

function createModrinth({ modsDir, disabledDir, oldDir, datapackDir, mcVersion, loader }) {
  const loaders = loadersFor(loader);
  const type = projectTypeFor(loader);
  const hashCache = new Map();
  let identCache = null;

  const supported = (kind) => !!mcVersion && (kindOf(kind) !== 'mod' || loaders.length > 0);
  const installable = (kind) => kindOf(kind) === 'mod' || (kindOf(kind) === 'datapack' && !!datapackDir);
  const vfilter = (kind) => {
    const k = kindOf(kind);
    const games = `game_versions=${encodeURIComponent(JSON.stringify([mcVersion]))}`;
    if (k === 'mod') return `loaders=${encodeURIComponent(JSON.stringify(loaders))}&${games}`;
    if (k === 'datapack') return `loaders=${encodeURIComponent(JSON.stringify(['datapack']))}&${games}`;
    return games;
  };

  function listJars(dir) {
    try { return fs.readdirSync(dir).filter((f) => f.endsWith('.jar')); } catch (_) { return []; }
  }
  async function hashOf(dir, name) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    const key = `${full}:${st.size}:${st.mtimeMs}`;
    if (!hashCache.has(key)) hashCache.set(key, await sha1File(full));
    return hashCache.get(key);
  }

  async function identify(force) {
    if (!force && identCache && Date.now() - identCache.at < 120000) return identCache.value;
    const entries = [];
    for (const [dir, enabled] of [[modsDir, true], [disabledDir, false]]) {
      for (const name of listJars(dir)) entries.push({ name, enabled, hash: await hashOf(dir, name) });
    }
    const map = entries.length ? await request('POST', `${API}/version_files`, { hashes: entries.map((e) => e.hash), algorithm: 'sha1' }) : {};
    const value = entries.map((e) => ({ ...e, version: map[e.hash] || null }));
    identCache = { at: Date.now(), value };
    return value;
  }

  const SORTS = new Set(['relevance', 'downloads', 'follows', 'newest', 'updated']);

  async function identifyDatapacks() {
    if (!datapackDir) return [];
    let names = [];
    try { names = fs.readdirSync(datapackDir).filter((n) => /\.zip$/i.test(n)); } catch (_) { return []; }
    const entries = [];
    for (const name of names) entries.push({ name, hash: await hashOf(datapackDir, name) });
    const map = entries.length ? await request('POST', `${API}/version_files`, { hashes: entries.map((e) => e.hash), algorithm: 'sha1' }) : {};
    return entries.map((e) => ({ ...e, version: map[e.hash] || null }));
  }

  async function installedProjectIds(kind) {
    const list = kindOf(kind) === 'datapack' ? await identifyDatapacks().catch(() => []) : await identify(false).catch(() => []);
    return new Set(list.filter((e) => e.version).map((e) => e.version.project_id));
  }

  async function search(query, offset, sort, kind) {
    const k = kindOf(kind);
    if (!supported(k)) return { hits: [], total: 0 };
    const facets = k === 'mod'
      ? [[`project_type:${type}`], [`versions:${mcVersion}`], loaders.map((l) => `categories:${l}`)]
      : [[`project_type:${k}`], [`versions:${mcVersion}`]];
    const url = `${API}/search?query=${encodeURIComponent(query || '')}&limit=20&offset=${Math.max(0, Number(offset) || 0)}&index=${SORTS.has(sort) ? sort : 'relevance'}&facets=${encodeURIComponent(JSON.stringify(facets))}`;
    const r = await request('GET', url);
    const installedProjects = await installedProjectIds(k);
    return {
      total: r.total_hits,
      kind: k,
      installable: installable(k),
      hits: r.hits.map((h) => ({ projectId: h.project_id, slug: h.slug, title: h.title, description: h.description, author: h.author, downloads: h.downloads, follows: h.follows, categories: (h.display_categories || h.categories || []).slice(0, 4), updated: h.date_modified, icon: h.icon_url, installed: installedProjects.has(h.project_id) })),
    };
  }

  async function project(projectId) {
    const id = encodeURIComponent(projectId);
    const [p, members] = await Promise.all([
      request('GET', `${API}/project/${id}`),
      request('GET', `${API}/project/${id}/members`).catch(() => []),
    ]);
    const installedIds = await installedProjectIds(p.project_type);
    const link = (v) => (typeof v === 'string' && /^https?:\/\//i.test(v) ? v : null);
    return {
      projectId: p.id,
      slug: p.slug,
      type: p.project_type,
      title: p.title,
      description: p.description,
      body: String(p.body || '').slice(0, 60000),
      icon: p.icon_url,
      downloads: p.downloads,
      followers: p.followers,
      categories: p.categories || [],
      loaders: p.loaders || [],
      gameVersions: (p.game_versions || []).slice(-40),
      license: p.license ? { id: p.license.id, name: p.license.name } : null,
      environment: { client: p.client_side, server: p.server_side },
      links: { site: `https://modrinth.com/${p.project_type}/${p.slug}`, source: link(p.source_url), issues: link(p.issues_url), wiki: link(p.wiki_url), discord: link(p.discord_url) },
      gallery: (p.gallery || []).slice(0, 12).map((g) => ({ url: g.url, title: g.title, description: g.description, featured: g.featured })),
      published: p.published,
      updated: p.updated,
      team: (Array.isArray(members) ? members : []).slice(0, 8).map((m) => ({ name: m.user && m.user.username, role: m.role })),
      installed: installedIds.has(p.id),
      installable: installable(p.project_type === 'plugin' ? 'mod' : p.project_type),
    };
  }

  async function projectVersions(projectId, kind) {
    const list = await request('GET', `${API}/project/${encodeURIComponent(projectId)}/version?${vfilter(kind)}`);
    return list.map((v) => ({ id: v.id, number: v.version_number, name: v.name, channel: v.version_type, published: v.date_published, downloads: v.downloads, gameVersions: (v.game_versions || []).slice(-3), file: (v.files.find((f) => f.primary) || v.files[0] || {}).filename, size: (v.files.find((f) => f.primary) || v.files[0] || {}).size }));
  }

  async function latestCompatible(projectId) {
    const list = await request('GET', `${API}/project/${encodeURIComponent(projectId)}/version?${vfilter()}`);
    return list.find((v) => v.version_type === 'release') || list[0] || null;
  }

  async function installVersion(version, log, state) {
    const file = version.files.find((f) => f.primary) || version.files[0];
    if (!file || !SAFE_JAR.test(file.filename)) throw new Error(`unsupported file: ${file ? file.filename : 'none'}`);
    const dest = path.join(modsDir, file.filename);
    if (state.done.has(version.project_id)) return;
    state.done.add(version.project_id);
    fs.mkdirSync(modsDir, { recursive: true });
    if (!fs.existsSync(dest)) {
      await downloadVerified(file.url, dest, file.hashes && file.hashes.sha512, file.size);
      log.push({ file: file.filename, version: version.version_number, projectId: version.project_id });
    }
    for (const dep of version.dependencies || []) {
      if (dep.dependency_type !== 'required' || !dep.project_id || state.done.has(dep.project_id) || state.installedProjects.has(dep.project_id)) continue;
      const depVersion = dep.version_id ? await request('GET', `${API}/version/${encodeURIComponent(dep.version_id)}`) : await latestCompatible(dep.project_id);
      if (!depVersion) { log.push({ warning: `no compatible version of a required dependency (${dep.project_id})` }); continue; }
      await installVersion(depVersion, log, state);
    }
  }

  async function installDatapack(projectId, versionId) {
    if (!datapackDir) throw new Error('this server has no world folder for datapacks');
    const list = versionId ? [await request('GET', `${API}/version/${encodeURIComponent(versionId)}`)] : await request('GET', `${API}/project/${encodeURIComponent(projectId)}/version?${vfilter('datapack')}`);
    const version = versionId ? list[0] : (list.find((v) => v.version_type === 'release') || list[0]);
    if (!version) throw new Error(`no datapack version for Minecraft ${mcVersion}`);
    if (!version.game_versions.includes(mcVersion)) throw new Error('that version is not compatible with this server');
    const file = version.files.find((f) => f.primary) || version.files[0];
    if (!file || !SAFE_ZIP.test(file.filename)) throw new Error(`unsupported file: ${file ? file.filename : 'none'}`);
    fs.mkdirSync(datapackDir, { recursive: true });
    const dest = path.join(datapackDir, file.filename);
    const log = [];
    if (!fs.existsSync(dest)) {
      await downloadVerified(file.url, dest, file.hashes && file.hashes.sha512, file.size);
      log.push({ file: file.filename, version: version.version_number, projectId: version.project_id });
    }
    return log;
  }

  async function install(projectId, versionId, kind) {
    const k = kindOf(kind);
    if (k === 'datapack') return installDatapack(projectId, versionId);
    if (k !== 'mod') throw new Error('this kind of project cannot be installed on a server');
    if (!supported()) throw new Error('this server type has no Modrinth support');
    const version = versionId ? await request('GET', `${API}/version/${encodeURIComponent(versionId)}`) : await latestCompatible(projectId);
    if (!version) throw new Error(`no version compatible with Minecraft ${mcVersion} (${loader})`);
    if (!version.game_versions.includes(mcVersion) || !version.loaders.some((l) => loaders.includes(l))) throw new Error('that version is not compatible with this server');
    const installedProjects = new Set((await identify(true).catch(() => [])).filter((e) => e.version).map((e) => e.version.project_id));
    const log = [];
    await installVersion(version, log, { done: new Set(), installedProjects });
    identCache = null;
    return log;
  }

  async function updates() {
    if (!supported()) return { updates: [], incompatible: [], unknown: [] };
    const idents = (await identify(true)).filter((e) => e.enabled);
    const known = idents.filter((e) => e.version);
    const latest = known.length ? await request('POST', `${API}/version_files/update`, { hashes: known.map((e) => e.hash), algorithm: 'sha1', loaders, game_versions: [mcVersion] }) : {};
    const ids = [...new Set(known.map((e) => e.version.project_id))];
    const titles = {};
    if (ids.length) for (const p of await request('GET', `${API}/projects?ids=${encodeURIComponent(JSON.stringify(ids))}`)) titles[p.id] = p.title;
    const result = { updates: [], incompatible: [], unknown: idents.filter((e) => !e.version).map((e) => e.name) };
    for (const e of known) {
      let next = latest[e.hash];
      if (next && next.version_type !== 'release' && e.version.version_type === 'release') next = await latestCompatible(e.version.project_id).catch(() => null);
      const base = { file: e.name, projectId: e.version.project_id, title: titles[e.version.project_id] || e.name, current: e.version.version_number };
      if (!next) result.incompatible.push(base);
      else if (next.id !== e.version.id) result.updates.push({ ...base, latest: next.version_number, versionId: next.id });
    }
    return result;
  }

  async function applyUpdates(files) {
    const { updates: list } = await updates();
    const todo = files === 'all' ? list : list.filter((u) => files.includes(u.file));
    const log = [];
    const installedProjects = new Set((await identify(false)).filter((e) => e.version).map((e) => e.version.project_id));
    const state = { done: new Set(), installedProjects };
    for (const u of todo) {
      const version = await request('GET', `${API}/version/${encodeURIComponent(u.versionId)}`);
      const before = log.length;
      const stateOne = { done: new Set(state.done), installedProjects };
      stateOne.done.delete(version.project_id);
      await installVersion(version, log, stateOne);
      for (const id of stateOne.done) state.done.add(id);
      const added = log.slice(before).filter((x) => x.file);
      if (added.length && !added.some((x) => x.file === u.file)) {
        fs.mkdirSync(oldDir, { recursive: true });
        const from = path.join(modsDir, u.file);
        if (fs.existsSync(from)) fs.renameSync(from, path.join(oldDir, u.file));
      }
    }
    identCache = null;
    return log;
  }

  return { supported, installable, loaders, type, search, project, projectVersions, install, updates, applyUpdates };
}

module.exports = { createModrinth, loadersFor, projectTypeFor, fetchImage, request, downloadVerified, API };
