// Which create-log lines matter enough to survive a noisy installer (e.g. Forge's hundreds of "Patching ..."
// lines) filling up the normal ring buffer: modpack environment decisions, loader/version choices, and
// anything that signals a problem. Products keep these in a second, small array alongside the normal one.
const IMPORTANT = [
  /^skipping /i, /^keeping /i, /^using /i, // modpack environment decisions and the loader version picked
  /could not ask modrinth/i, /could not determine environment/i, // environment lookup problems
  /is not available for minecraft/i, /checksum mismatch/i, /size mismatch/i, /no working download/i,
  /port \d+ is in use/i,
  /error/i, /fail/i, /rolled back/i, /rollback/i, // anything that signals trouble
];

const isImportantCreateLine = (line) => { const s = String(line || ''); return IMPORTANT.some((re) => re.test(s)); };

module.exports = { isImportantCreateLine };
