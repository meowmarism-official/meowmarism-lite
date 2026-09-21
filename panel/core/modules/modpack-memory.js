// Meowmarism's memory recommendation for a modpack server. A plain estimate, not a Modrinth value: the user can always change it.
const STEP_MB = 512;
const MAX_MB = 16384;
const MB_PER_MOD = 12;
const MODS_CAP_MB = 6144;
const LOADER_MB = { forge: 768, neoforge: 768, fabric: 256, quilt: 256 };

const roundUp = (mb) => Math.ceil(mb / STEP_MB) * STEP_MB;

function minorVersion(minecraft) {
  const m = /^1\.(\d+)/.exec(String(minecraft || ''));
  return m ? Number(m[1]) : 99;
}

function recommendMemory({ minecraft, loader, modCount, downloadBytes } = {}) {
  const mods = Math.max(0, Number(modCount) || 0);
  const baseMB = minorVersion(minecraft) >= 18 ? 2048 : 1536;
  const loaderMB = LOADER_MB[loader] || 0;
  const modsMB = Math.min(MODS_CAP_MB, mods * MB_PER_MOD);
  const packSizeMB = Math.min(1024, Math.round(Math.max(0, Number(downloadBytes) || 0) / 1048576 * 0.1));
  const total = baseMB + loaderMB + modsMB + packSizeMB;
  const recommendedMB = Math.min(MAX_MB, Math.max(2048, roundUp(total)));
  const minimumMB = Math.min(recommendedMB, Math.max(2048, roundUp(total * 0.75)));
  return { minimumMB, recommendedMB, reason: { baseMB, loaderMB, modsMB, packSizeMB } };
}

module.exports = { recommendMemory };
