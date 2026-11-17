const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jdk = require('../panel/runtime/jdk-tools');

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jdk-'));

// Stands in for tar: puts a JDK layout into the target folder.
const fakeExtract = (withTools = true) => async (tarball, dir) => {
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin', 'java'), '');
  if (withTools) for (const t of ['jcmd', 'jfr', 'jstat']) fs.writeFileSync(path.join(dir, 'bin', t), '');
};

test('the JDK is downloaded, unpacked and found afterwards', async () => {
  const dataRoot = root();
  const urls = [];
  const log = [];
  const dest = await jdk.install({
    dataRoot, major: 21, log: (l) => log.push(l), platform: 'linux', arch: 'x64',
    download: async (url, file) => { urls.push(url); fs.writeFileSync(file, 'tar'); },
    extract: fakeExtract(),
  });
  assert.strictEqual(dest, path.join(dataRoot, 'java', 'jdk-21'));
  assert.match(urls[0], /binary\/latest\/21\/ga\/linux\/x64\/jdk\/hotspot/);
  assert.strictEqual(jdk.installed(dataRoot, 21), true);
  assert.deepStrictEqual(jdk.toolDirs(dataRoot), [path.join(dataRoot, 'java', 'jdk-21', 'bin')]);
  assert.deepStrictEqual(fs.readdirSync(path.join(dataRoot, 'java')), ['jdk-21'], 'no .part folder is left');
  assert.deepStrictEqual(log, ['downloading JDK 21 (Temurin)', 'unpacking', 'done']);
});

test('an installed JDK is not downloaded again', async () => {
  const dataRoot = root();
  const opts = { dataRoot, major: 21, log: () => {}, platform: 'linux', arch: 'x64', extract: fakeExtract() };
  await jdk.install({ ...opts, download: async (u, f) => fs.writeFileSync(f, 'tar') });
  let calls = 0;
  await jdk.install({ ...opts, download: async () => { calls++; } });
  assert.strictEqual(calls, 0);
});

test('a download without jcmd and jfr leaves nothing behind', async () => {
  const dataRoot = root();
  await assert.rejects(jdk.install({
    dataRoot, major: 21, log: () => {}, platform: 'linux', arch: 'x64',
    download: async (u, f) => fs.writeFileSync(f, 'tar'), extract: fakeExtract(false),
  }), /jcmd and jfr/);
  assert.deepStrictEqual(fs.readdirSync(path.join(dataRoot, 'java')), []);
  assert.deepStrictEqual(jdk.toolDirs(dataRoot), []);
});

test('a failing download is passed on and cleaned up', async () => {
  const dataRoot = root();
  await assert.rejects(jdk.install({
    dataRoot, major: 21, log: () => {}, platform: 'linux', arch: 'arm64',
    download: async () => { throw new Error('HTTP 503'); }, extract: fakeExtract(),
  }), /503/);
  assert.deepStrictEqual(fs.readdirSync(path.join(dataRoot, 'java')), []);
});

test('other systems and CPUs are refused before anything is downloaded', async () => {
  const dataRoot = root();
  const base = { dataRoot, log: () => {}, download: async () => { throw new Error('must not download'); }, extract: fakeExtract() };
  await assert.rejects(jdk.install({ ...base, platform: 'win32', arch: 'x64' }), /only available on Linux/);
  await assert.rejects(jdk.install({ ...base, platform: 'linux', arch: 'ia32' }), /unsupported CPU/);
});

test('the newest installed JDK is searched first', async () => {
  const dataRoot = root();
  for (const major of [17, 21]) {
    await jdk.install({ dataRoot, major, log: () => {}, platform: 'linux', arch: 'x64', download: async (u, f) => fs.writeFileSync(f, 'tar'), extract: fakeExtract() });
  }
  assert.deepStrictEqual(jdk.toolDirs(dataRoot).map((d) => path.basename(path.dirname(d))), ['jdk-21', 'jdk-17']);
});
