const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createProfiler, INSTALL_HINT } = require('../panel/runtime/profiler');

const DUMP = `jdk.ExecutionSample {
  startTime = 18:56:07.119 (2026-11-17)
  sampledThread = "Server thread" (javaThreadId = 51)
  state = "STATE_RUNNABLE"
  stackTrace = [
    net.minecraft.A.compute(Ctx) line: 12
    dev.example.mod.Tick.run(Level) line: 55
  ]
}

jdk.GarbageCollection {
  startTime = 18:56:07.335 (2026-11-17)
  duration = 4.45 ms
  sumOfPauses = 4.45 ms
  longestPause = 4.45 ms
}
`;

function rig({ withTools = true, pid = 4242, jcmdFails = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prof-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  if (withTools) for (const name of ['jcmd', 'jfr', 'java']) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\n', { mode: 0o755 });
  const calls = [];
  const exec = (file, args, options, cb) => {
    calls.push([path.basename(file), ...args]);
    if (path.basename(file) === 'jcmd') {
      if (jcmdFails) { setImmediate(() => cb(new Error('boom'), '', 'Could not attach to the process')); return; }
      fs.writeFileSync(args.find((a) => a.startsWith('filename=')).slice('filename='.length), 'JFR');
      setImmediate(() => cb(null, 'Started recording 1.', ''));
    } else {
      setImmediate(() => cb(null, DUMP, ''));
    }
  };
  const saved = process.env.PATH;
  const profiler = createProfiler({ getPid: () => pid, javaPath: () => path.join(bin, 'java'), execFile: exec, tmpDir: dir, wait: () => new Promise((r) => setTimeout(r, 1)) });
  return { profiler, calls, dir, restore: () => { process.env.PATH = saved; } };
}

const until = async (check) => { for (let i = 0; i < 400; i++) { if (check()) return; await new Promise((r) => setTimeout(r, 5)); } throw new Error('timed out'); };

test('a profile records, reads the dump and summarizes who uses the time', async () => {
  const r = rig();
  const started = r.profiler.start(10);
  assert.strictEqual(started.state, 'running');
  await until(() => r.profiler.state().state === 'done');
  const result = r.profiler.state().result;
  assert.strictEqual(result.samples, 1);
  assert.strictEqual(result.durationSec, 10);
  assert.strictEqual(result.serverThread.owners[0].name, 'dev.example.mod');
  assert.deepStrictEqual(result.gc, { count: 1, totalPauseMs: 4.5, longestMs: 4.5 });
  const [jcmd, jfr] = r.calls;
  assert.deepStrictEqual(jcmd.slice(0, 3), ['jcmd', '4242', 'JFR.start']);
  assert.ok(jcmd.includes('duration=10s') && jcmd.includes('settings=profile'));
  assert.strictEqual(jfr[0], 'jfr');
  assert.deepStrictEqual(fs.readdirSync(r.dir).filter((f) => f.endsWith('.jfr')), [], 'the recording is removed afterwards');
});

test('the length is kept between 5 and 60 seconds', async () => {
  const a = rig();
  assert.strictEqual(a.profiler.start(1).seconds, 5);
  await until(() => a.profiler.state().state === 'done');
  const b = rig();
  assert.strictEqual(b.profiler.start(600).seconds, 60);
  const c = rig();
  assert.strictEqual(c.profiler.start('nonsense').seconds, 10);
});

test('without a JDK nothing starts and the answer says what to install', () => {
  const r = rig({ withTools: false });
  const saved = process.env.PATH;
  process.env.PATH = '';
  try {
    assert.strictEqual(r.profiler.tools().profile, false);
    assert.throws(() => r.profiler.start(10), (e) => e.message === INSTALL_HINT);
  } finally { process.env.PATH = saved; }
});

test('a stopped server cannot be profiled', () => {
  const r = rig({ pid: null });
  assert.throws(() => r.profiler.start(10), /not running/);
});

test('a second profile is refused while one is running', async () => {
  const r = rig();
  r.profiler.start(10);
  assert.throws(() => r.profiler.start(10), /already running/);
  await until(() => r.profiler.state().state === 'done');
  assert.doesNotThrow(() => r.profiler.start(10));
});

test('a failing jcmd ends in an error state with its message', async () => {
  const r = rig({ jcmdFails: true });
  r.profiler.start(10);
  await until(() => r.profiler.state().state === 'error');
  assert.match(r.profiler.state().error, /Could not attach/);
});
