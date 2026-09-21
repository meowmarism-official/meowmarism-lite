// Modrinth modpack lookups: search, project details and downloadable versions. Uses the shared Modrinth HTTP client.
const modrinth = require('./modrinth');

const SORTS = new Set(['relevance', 'downloads', 'follows', 'newest', 'updated']);
const LOADERS = new Set(['fabric', 'forge', 'neoforge', 'quilt']);
// Environments that may run on a dedicated server; client_only, singleplayer_only and unknown are left out.
const SERVER_ENVIRONMENTS = ['client_and_server', 'server_only', 'server_only_client_optional', 'dedicated_server_only', 'client_only_server_optional', 'client_or_server', 'client_or_server_prefers_both'];
const ID = /^[\w-]{1,64}$/;
const MC_VERSION = /^[\w.+-]{1,32}$/;
const PAGE = 20;

const fail = (message) => Object.assign(new Error(message), { status: 400 });

function createModpackApi({ request = modrinth.request, api = modrinth.API } = {}) {
  const idOf = (value) => { if (!ID.test(String(value || ''))) throw fail('invalid modpack id'); return String(value); };

  async function searchModpacks({ query = '', offset = 0, sort = 'relevance', loader = '', mcVersion = '' } = {}) {
    const facets = [['project_type:modpack'], SERVER_ENVIRONMENTS.map((e) => `environment:${e}`)];
    if (LOADERS.has(loader)) facets.push([`categories:${loader}`]);
    if (mcVersion) { if (!MC_VERSION.test(mcVersion)) throw fail('invalid Minecraft version'); facets.push([`versions:${mcVersion}`]); }
    const url = `${api}/search?query=${encodeURIComponent(String(query).slice(0, 100))}&limit=${PAGE}&offset=${Math.max(0, Number(offset) || 0)}`
      + `&index=${SORTS.has(sort) ? sort : 'relevance'}&facets=${encodeURIComponent(JSON.stringify(facets))}`;
    const d = await request('GET', url);
    return {
      total: Number(d && d.total_hits) || 0,
      hits: ((d && d.hits) || []).map((h) => ({
        id: h.project_id, slug: h.slug, title: h.title, description: h.description, icon: h.icon_url || '',
        author: h.author, downloads: h.downloads, follows: h.follows, categories: h.display_categories || h.categories || [],
        mcVersions: h.versions || [], environment: h.environment || [], updated: h.date_modified,
      })),
    };
  }

  async function getModpack(idOrSlug) {
    const p = await request('GET', `${api}/project/${encodeURIComponent(idOf(idOrSlug))}`);
    if (!p || p.project_type !== 'modpack') throw fail('not a modpack');
    return {
      id: p.id, slug: p.slug, title: p.title, description: p.description, body: p.body || '', icon: p.icon_url || '',
      downloads: p.downloads, followers: p.followers, categories: p.categories || [],
      mcVersions: p.game_versions || [], loaders: (p.loaders || []).filter((l) => LOADERS.has(l)),
      serverSide: p.server_side, clientSide: p.client_side, updated: p.updated,
    };
  }

  // A version is offered only when its own environment allows a server and it carries a .mrpack on Modrinth's CDN with a SHA-512 and a size.
  function toVersion(v) {
    if (!v || !SERVER_ENVIRONMENTS.includes(v.environment)) return null;
    const files = v.files || [];
    const file = files.find((f) => f.primary && /\.mrpack$/i.test(f.filename || '')) || files.find((f) => /\.mrpack$/i.test(f.filename || ''));
    if (!file || !file.hashes || !file.hashes.sha512 || !Number.isInteger(file.size)) return null;
    let host = '';
    try { const u = new URL(file.url); host = u.protocol === 'https:' ? u.hostname : ''; } catch (_) {}
    if (host !== 'cdn.modrinth.com') return null;
    return {
      id: v.id, projectId: v.project_id, name: v.name, versionNumber: v.version_number, type: v.version_type,
      environment: v.environment, mcVersions: v.game_versions || [], loaders: (v.loaders || []).filter((l) => LOADERS.has(l)),
      published: v.date_published, downloads: v.downloads,
      file: { url: file.url, filename: file.filename, size: file.size, sha512: file.hashes.sha512 },
    };
  }

  async function getVersions(idOrSlug, { loader = '', mcVersion = '' } = {}) {
    const params = [];
    if (LOADERS.has(loader)) params.push(`loaders=${encodeURIComponent(JSON.stringify([loader]))}`);
    if (mcVersion) { if (!MC_VERSION.test(mcVersion)) throw fail('invalid Minecraft version'); params.push(`game_versions=${encodeURIComponent(JSON.stringify([mcVersion]))}`); }
    const list = await request('GET', `${api}/project/${encodeURIComponent(idOf(idOrSlug))}/version${params.length ? `?${params.join('&')}` : ''}`);
    return (Array.isArray(list) ? list : []).map(toVersion).filter(Boolean);
  }

  async function getVersion(versionId) {
    const v = toVersion(await request('GET', `${api}/version/${encodeURIComponent(idOf(versionId))}`));
    if (!v) throw fail('this version has no installable modpack file');
    return v;
  }

  return { searchModpacks, getModpack, getVersions, getVersion };
}

module.exports = { createModpackApi };
