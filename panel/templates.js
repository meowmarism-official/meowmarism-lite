// Server templates: a copy of a stopped instance (software, plugins or mods, configs, optionally the world) to build new servers from.
const fs = require('fs');
const path = require('path');

const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;
const SKIP_DIRS = new Set(['logs', 'crash-reports', 'cache', 'backups', '.upgrade', 'plugins-old', 'mods-old']);
const SKIP_FILES = new Set(['session.lock', 'usercache.json', 'panel-queued-settings.json']);

function levelName(dir) {
  try {
    const m = /^level-name=(.*)$/m.exec(fs.readFileSync(path.join(dir, 'server.properties'), 'utf8'));
    return (m && m[1].trim()) || 'world';
  } catch (_) { return 'world'; }
}

// root: folder that holds the templates
function createTemplates({ root }) {
  const dirOf = (name) => path.join(root, name);
  const filesOf = (name) => path.join(root, name, 'files');

  function meta(name) {
    try { return JSON.parse(fs.readFileSync(path.join(dirOf(name), 'template.json'), 'utf8')); } catch (_) { return null; }
  }

  function list() {
    try {
      return fs.readdirSync(root).filter((n) => NAME_RE.test(n)).map(meta).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
    } catch (_) { return []; }
  }

  const get = (name) => (NAME_RE.test(String(name)) ? meta(String(name)) : null);

  // inst: { name, dir, loader, mcVersion, loaderVersion }; the instance must be stopped
  function save({ name, inst, includeWorld = true, description = '', ramMB = null }) {
    if (!NAME_RE.test(String(name))) throw new Error('a template name has 1 to 40 letters, digits, - or _');
    if (get(name)) throw new Error('a template with this name already exists');
    const level = levelName(inst.dir);
    const worlds = new Set([level, `${level}_nether`, `${level}_the_end`]);
    const target = dirOf(name);
    const part = `${target}.part`;
    fs.rmSync(part, { recursive: true, force: true });
    try {
      fs.mkdirSync(part, { recursive: true });
      fs.cpSync(inst.dir, path.join(part, 'files'), {
        recursive: true,
        filter: (src) => {
          const rel = path.relative(inst.dir, src);
          if (!rel) return true;
          const top = rel.split(path.sep)[0];
          const base = path.basename(src);
          if (SKIP_DIRS.has(top) || SKIP_FILES.has(base)) return false;
          if (/^panel-.*\.json$/.test(base) && rel === base) return false;
          if (!includeWorld && worlds.has(top)) return false;
          return true;
        },
      });
      const info = {
        name, loader: inst.loader, mcVersion: inst.mcVersion, loaderVersion: inst.loaderVersion || '', includeWorld: !!includeWorld,
        description: String(description || '').slice(0, 200), sourceInstance: inst.name, ramMB: ramMB || null, createdAt: Date.now(),
      };
      fs.writeFileSync(path.join(part, 'template.json'), JSON.stringify(info, null, 2));
      fs.renameSync(part, target);
      return info;
    } catch (err) {
      fs.rmSync(part, { recursive: true, force: true });
      throw err;
    }
  }

  function remove(name) {
    if (!get(name)) return false;
    fs.rmSync(dirOf(name), { recursive: true, force: true });
    return true;
  }

  // Copies the files of a template into dest, which must not exist yet.
  function restore(name, dest) {
    if (!get(name)) throw new Error('no such template');
    fs.cpSync(filesOf(name), dest, { recursive: true, errorOnExist: true, force: false });
  }

  return { list, get, save, remove, restore };
}

module.exports = { createTemplates, NAME_RE };
