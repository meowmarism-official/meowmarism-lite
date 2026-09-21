// Which build is running: the product version plus a channel and commit, so two builds of the same version are told apart.
// A release archive carries the commit in panel/build.json (git replaces $Format:%h$ when it makes the archive).
// A git checkout reports its HEAD and counts as a release only when HEAD is exactly a tag.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } };
const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();

// installDir: the folder with package.json and panel/
function getBuildInfo(installDir) {
  const version = readJson(path.join(installDir, 'package.json'))?.version || null;
  const stamped = readJson(path.join(installDir, 'panel', 'build.json'))?.commit;
  const stampedOk = typeof stamped === 'string' && /^[0-9a-f]{7,40}$/.test(stamped);
  let commit = stampedOk ? stamped : null;
  let channel = stampedOk ? 'release' : 'dev';
  if (!stampedOk && fs.existsSync(path.join(installDir, '.git'))) {
    try {
      commit = git(installDir, ['rev-parse', '--short=8', 'HEAD']);
      try { git(installDir, ['describe', '--tags', '--exact-match', 'HEAD']); channel = 'release'; } catch (_) {}
    } catch (_) {}
  }
  return { version, channel, commit, label: version ? `${version}${channel === 'dev' ? '-dev' : ''}` : null };
}

module.exports = { getBuildInfo };
