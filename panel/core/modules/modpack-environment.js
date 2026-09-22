// Leaves out mods that Modrinth says cannot run on a multiplayer server, for packs that do not say so themselves.
// Conservative on purpose: only client_only and singleplayer_only are dropped; unknown, missing or failed lookups keep the pack's own declaration.
// Mods are identified by the SHA-512 the pack already lists (one bulk request per 100 files); nothing is downloaded to identify them.
const path = require('path');
const modrinth = require('./modrinth');
const { countMods } = require('./modpack');

const SKIP = { client_only: 'client-only', singleplayer_only: 'singleplayer-only' };
const KEEP_QUIET = new Set(['client_and_server', 'server_only', 'dedicated_server_only', 'server_only_client_optional', 'client_or_server', 'client_or_server_prefers_both']);
const BATCH = 100;
const MOD_JAR = /^mods\/[^/]+\.jar$/i;

// inspected: from inspectMrpack(); returns { inspected, report } without changing the input.
async function resolveEnvironments(inspected, { request = modrinth.request, api = modrinth.API, log = () => {} } = {}) {
  const candidates = inspected.files.filter((f) => MOD_JAR.test(f.path));
  const report = { checked: candidates.length, skipped: [], optional: [], unknown: [], failed: false };
  const found = new Map();
  const hashes = [...new Set(candidates.map((f) => f.sha512))];
  for (let i = 0; i < hashes.length; i += BATCH) {
    const batch = hashes.slice(i, i + BATCH);
    try {
      const map = await request('POST', `${api}/version_files`, { hashes: batch, algorithm: 'sha512' });
      for (const h of batch) if (map && map[h]) found.set(h, map[h]);
    } catch (err) {
      report.failed = true;
      const inBatch = new Set(batch);
      log(`Could not ask Modrinth about ${candidates.filter((f) => inBatch.has(f.sha512)).length} mods (${err.message}), keeping the pack declaration`);
    }
  }

  const skipped = [];
  const kept = [];
  for (const f of inspected.files) {
    if (!MOD_JAR.test(f.path)) { kept.push(f); continue; }
    const name = path.basename(f.path);
    const environment = found.has(f.sha512) ? found.get(f.sha512).environment : null;
    if (SKIP[environment]) {
      log(`Skipping ${name}: ${SKIP[environment]} according to Modrinth`);
      report.skipped.push({ path: f.path, environment });
      skipped.push({ path: f.path, reason: `${SKIP[environment]} according to Modrinth`, source: 'modrinth', environment });
      continue;
    }
    if (environment === 'client_only_server_optional') { log(`Keeping ${name}: server support is optional`); report.optional.push(f.path); }
    else if (!KEEP_QUIET.has(environment) && !report.failed) { log(`Could not determine environment for ${name}, keeping pack declaration`); report.unknown.push(f.path); }
    else if (!KEEP_QUIET.has(environment)) report.unknown.push(f.path);
    kept.push(f);
  }

  if (!skipped.length) return { inspected, report };
  const dropped = new Set(skipped.map((s) => s.path));
  const files = kept;
  const next = {
    ...inspected,
    files,
    skipped: [...inspected.skipped, ...skipped],
    downloadBytes: inspected.files.filter((f) => dropped.has(f.path)).reduce((sum, f) => sum - f.size, inspected.downloadBytes),
  };
  next.modCount = countMods(next);
  return { inspected: next, report };
}

module.exports = { resolveEnvironments, SKIP_ENVIRONMENTS: Object.keys(SKIP) };
