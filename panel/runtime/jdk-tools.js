// JDK tools (jcmd, jfr, jstat) for hosts that only have a JRE. A Temurin JDK is unpacked into the data folder; the
// Java the server runs with is not touched, the tools attach to it from the side.
const fs = require('fs');
const path = require('path');

const ARCH = { x64: 'x64', arm64: 'aarch64' };
const DEFAULT_MAJOR = 21;

const jdkDir = (dataRoot, major) => path.join(dataRoot, 'java', `jdk-${major}`);
const hasTools = (dir) => ['jcmd', 'jfr'].every((name) => fs.existsSync(path.join(dir, 'bin', name)));

// bin folders of every JDK this panel installed
function toolDirs(dataRoot) {
  try {
    return fs.readdirSync(path.join(dataRoot, 'java'))
      .filter((name) => /^jdk-\d+$/.test(name))
      .sort((a, b) => Number(b.slice(4)) - Number(a.slice(4)))
      .map((name) => path.join(dataRoot, 'java', name, 'bin'))
      .filter((bin) => hasTools(path.dirname(bin)));
  } catch (_) { return []; }
}

function installed(dataRoot, major) {
  return hasTools(jdkDir(dataRoot, major));
}

// deps: { dataRoot, major, log(text), download(url, file), extract(tarball, dir), platform?, arch? }
async function install(deps) {
  const { dataRoot, log } = deps;
  const major = deps.major || DEFAULT_MAJOR;
  const platform = deps.platform || process.platform;
  if (platform !== 'linux') throw new Error('installing the JDK tools is only available on Linux');
  const arch = ARCH[deps.arch || process.arch];
  if (!arch) throw new Error(`unsupported CPU architecture ${deps.arch || process.arch}`);
  const dest = jdkDir(dataRoot, major);
  if (installed(dataRoot, major)) { log(`JDK ${major} tools are already installed`); return dest; }

  const part = `${dest}.part`;
  fs.rmSync(part, { recursive: true, force: true });
  fs.mkdirSync(part, { recursive: true });
  const tarball = path.join(part, 'jdk.tar.gz');
  try {
    log(`downloading JDK ${major} (Temurin)`);
    await deps.download(`https://api.adoptium.net/v3/binary/latest/${major}/ga/linux/${arch}/jdk/hotspot/normal/eclipse`, tarball);
    log('unpacking');
    await deps.extract(tarball, part);
    fs.rmSync(tarball, { force: true });
    if (!hasTools(part)) throw new Error('the download does not contain jcmd and jfr');
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(part, dest);
  } catch (err) {
    fs.rmSync(part, { recursive: true, force: true });
    throw err;
  }
  log('done');
  return dest;
}

module.exports = { install, installed, toolDirs, jdkDir, DEFAULT_MAJOR };
