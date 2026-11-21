const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const launch = require('../panel/runtime/launch');
const { generateVelocityConfig } = require('../panel/runtime/velocity-config');
const marker = require('../panel/lib/creation-marker');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vfix-'));

test('Java for Velocity follows its own version, Minecraft versions are unchanged', () => {
  assert.strictEqual(launch.requiredJavaMajor('4.3.1'), 25);
  assert.strictEqual(launch.requiredJavaMajor('3.4.0'), 17);
  assert.strictEqual(launch.requiredJavaMajor('1.21.1'), 21);
  assert.strictEqual(launch.requiredJavaMajor('1.20.4'), 17);
  assert.strictEqual(launch.requiredJavaMajor('26.1.2'), 25);
  assert.strictEqual(launch.requiredJavaMajor(''), null);
});

test('a Velocity that exits at once fails fast with its own output, without spinning', async () => {
  const dir = tmp();
  const lines = [];
  const started = Date.now();
  await assert.rejects(
    () => generateVelocityConfig(dir, process.execPath, (l) => lines.push(l), { args: ['-e', "console.error('UnsupportedClassVersionError: class file version 69.0'); process.exit(1)"] }),
    /did not write its configuration: .*UnsupportedClassVersionError/,
  );
  assert.ok(Date.now() - started < 8000, 'it did not wait for the full timeout');
  assert.ok(lines.some((l) => l.includes('UnsupportedClassVersionError')), 'the output reaches the build log');
});

test('a missing Java binary fails fast too', async () => {
  const started = Date.now();
  await assert.rejects(() => generateVelocityConfig(tmp(), path.join(os.tmpdir(), 'no-such-java'), () => {}), /did not write its configuration/);
  assert.ok(Date.now() - started < 8000);
});

test('a Velocity that writes its files is stopped and the build goes on', async () => {
  const dir = tmp();
  const script = "const fs=require('fs');fs.writeFileSync('velocity.toml','bind=1');fs.writeFileSync('forwarding.secret','s');setInterval(()=>{},1000)";
  await generateVelocityConfig(dir, process.execPath, () => {}, { args: ['-e', script] });
  assert.ok(fs.existsSync(path.join(dir, 'velocity.toml')) && fs.existsSync(path.join(dir, 'forwarding.secret')));
});

test('nothing is started when the configuration already exists', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'velocity.toml'), 'x');
  fs.writeFileSync(path.join(dir, 'forwarding.secret'), 'y');
  await generateVelocityConfig(dir, path.join(os.tmpdir(), 'no-such-java'), () => assert.fail('it must not start anything'));
});

test('a build that never ended shows up as a failure after the restart, once', () => {
  const root = tmp();
  assert.strictEqual(marker.interrupted(root), null);
  marker.begin(root, 'proxy');
  const log = marker.interrupted(root);
  assert.deepStrictEqual([log.name, log.done, log.interrupted, /nothing was created/.test(log.error)], ['proxy', true, true, true]);
  assert.strictEqual(marker.interrupted(root), null, 'the marker is gone after it was reported');
  marker.begin(root, 'a');
  marker.end(root);
  assert.strictEqual(marker.interrupted(root), null, 'a finished build leaves no marker');
});

// The panel's own Java is used when the instance has none and the system has none or too little.
const unix = { skip: process.platform === 'win32' ? 'needs shell scripts' : false };
function fakeJava(dataRoot, folder, major) {
  const dir = path.join(dataRoot, 'java', folder, 'bin');
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, 'java');
  fs.writeFileSync(bin, `#!/bin/sh\necho 'openjdk version "${major}.0.1" 2024-01-01' >&2\n`, { mode: 0o755 });
  return bin;
}

test('the panel finds its own Java runtimes, smallest sufficient first', unix, () => {
  const root = tmp();
  fakeJava(root, '21', 21);
  fakeJava(root, 'jdk-25', 25);
  fs.mkdirSync(path.join(root, 'java', 'notes'), { recursive: true });
  assert.deepStrictEqual(launch.panelJavas(root).map((j) => j.major), [21, 25]);
  assert.strictEqual(launch.findPanelJava(root, 17).major, 21);
  assert.strictEqual(launch.findPanelJava(root, 25).bin, path.join(root, 'java', 'jdk-25', 'bin', 'java'));
  assert.strictEqual(launch.findPanelJava(root, 26), null);
  assert.deepStrictEqual(launch.panelJavas(path.join(root, 'missing')), []);
});

test('a runtime that does not run as the version in its folder name is not used', unix, () => {
  const root = tmp();
  fakeJava(root, '25', 17);
  assert.strictEqual(launch.findPanelJava(root, 25), null);
});
