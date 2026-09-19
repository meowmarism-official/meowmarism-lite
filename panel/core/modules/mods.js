// Installed mods or plugins of one instance: list the jars and move them between the active and the disabled folder.
const fs = require('fs');
const path = require('path');

const SAFE_NAME = /^[a-zA-Z0-9._+ -]+\.jar$/;

function createMods({ modsDir, disabledDir }) {
  const listDir = (dir) => {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.jar'))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        // ctime changes on rename, so it is when the file was last placed into this folder
        return { name: f, sizeMB: +(st.size / 1024 / 1024).toFixed(2), addedAt: st.ctimeMs };
      })
      .sort((a, b) => b.addedAt - a.addedAt);
  };

  function toggle(name, enable) {
    if (!SAFE_NAME.test(String(name || ''))) throw new Error('invalid mod filename');
    const from = enable ? disabledDir : modsDir;
    const to = enable ? modsDir : disabledDir;
    const src = path.join(from, name);
    if (!fs.existsSync(src)) throw new Error(`mod not found in ${enable ? 'disabled_mods' : path.basename(modsDir)}`);
    fs.mkdirSync(to, { recursive: true });
    fs.renameSync(src, path.join(to, name));
  }

  return { list: () => ({ enabled: listDir(modsDir), disabled: listDir(disabledDir) }), toggle };
}

module.exports = { createMods };
