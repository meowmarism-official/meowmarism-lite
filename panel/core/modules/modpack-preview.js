// What a modpack version would install, for the create dialog: downloads the .mrpack, inspects it and estimates memory. Writes nothing to an instance.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { inspectMrpack } = require('./modpack');
const { recommendMemory } = require('./modpack-memory');
const { resolveEnvironments } = require('./modpack-environment');

const CACHE_LIMIT = 30;
const SKIPPED_LIMIT = 50;

// api: createModpackApi(); download(url, dest, sha512, size) -> Promise, e.g. the verified Modrinth download.
// request: the Modrinth HTTP client used for the mod environment lookup (default: the shared one).
function createModpackPreview({ api, download, request, tmpRoot = os.tmpdir() }) {
  const cache = new Map();

  async function preview(versionId) {
    if (cache.has(versionId)) return cache.get(versionId);
    const version = await api.getVersion(versionId);
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'meow-preview-'));
    let inspected;
    try {
      const file = path.join(dir, 'pack.mrpack');
      await download(version.file.url, file, version.file.sha512, version.file.size);
      inspected = inspectMrpack(file);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const { inspected: resolved, report } = await resolveEnvironments(inspected, { request });
    const summary = {
      versionId: version.id, projectId: version.projectId, versionNumber: version.versionNumber, name: inspected.name,
      minecraft: inspected.minecraft, loader: inspected.loader, loaderVersion: inspected.loaderVersion,
      modCount: resolved.modCount, fileCount: resolved.files.length, downloadBytes: resolved.downloadBytes,
      skipped: resolved.skipped.slice(0, SKIPPED_LIMIT).map((s) => s.path), skippedCount: resolved.skipped.length,
      managedCount: resolved.skipped.filter((s) => s.reason === 'protected').length,
      environmentSkipped: report.skipped.slice(0, SKIPPED_LIMIT), environmentSkippedCount: report.skipped.length, environmentLookupFailed: report.failed,
      memory: recommendMemory(resolved),
    };
    cache.set(versionId, summary);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
    return summary;
  }

  return { preview };
}

module.exports = { createModpackPreview };
