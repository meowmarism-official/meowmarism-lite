// LITE profiler: records the server JVM with Java Flight Recorder through jcmd and reads the recording with jfr.
// Both tools come with a JDK; a plain JRE does not have them.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { parseJfrText, summarizeProfile } = require('../core/modules/diagnostics');

const MIN_SECONDS = 5;
const MAX_SECONDS = 60;
const INSTALL_HINT = 'The JDK tools (jcmd, jfr, jstat) are missing. The panel can download them, or install a JDK yourself, e.g. sudo apt install openjdk-21-jdk-headless';

function findTool(name, dirs) {
  for (const dir of dirs) {
    if (!dir) continue;
    for (const file of [name, `${name}.exe`]) {
      const full = path.join(dir, file);
      try { fs.accessSync(full, fs.constants.X_OK); return full; } catch (_) {}
    }
  }
  return null;
}

function run(exec, file, args, options) {
  return new Promise((resolve, reject) => {
    exec(file, args, options, (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim() || err.message)) : resolve(String(stdout))));
  });
}

// deps: { getPid(), javaPath(), extraDirs?(), execFile?, tmpDir?, wait?(ms), now? }
function createProfiler(deps) {
  const exec = deps.execFile || execFile;
  const tmpDir = deps.tmpDir || os.tmpdir();
  const wait = deps.wait || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now || Date.now;
  let current = { state: 'idle' };

  // The directory of the running java is searched first, because that is the JDK that can attach to it.
  function tools() {
    const dirs = [];
    const pid = deps.getPid();
    if (pid) { try { dirs.push(path.dirname(fs.realpathSync(`/proc/${pid}/exe`))); } catch (_) {} }
    const javaPath = deps.javaPath();
    if (javaPath) dirs.push(path.dirname(javaPath));
    dirs.push(...(deps.extraDirs ? deps.extraDirs() : []));
    dirs.push(...String(process.env.PATH || '').split(path.delimiter));
    const jcmd = findTool('jcmd', dirs);
    const jfr = findTool('jfr', dirs);
    const jstat = findTool('jstat', dirs);
    return { jcmd, jfr, jstat, profile: !!(jcmd && jfr), installable: process.platform === 'linux', hint: jcmd && jfr ? null : INSTALL_HINT };
  }

  async function waitForFile(file, timeoutMs) {
    const end = now() + timeoutMs;
    let lastSize = -1;
    while (now() < end) {
      try {
        const size = fs.statSync(file).size;
        if (size > 0 && size === lastSize) return;
        lastSize = size;
      } catch (_) { lastSize = -1; }
      await wait(1000);
    }
    throw new Error('the recording did not finish in time');
  }

  async function record(pid, seconds, found, startedAt) {
    const file = path.join(tmpDir, `meow-profile-${pid}-${startedAt}.jfr`);
    try {
      await run(exec, found.jcmd, [String(pid), 'JFR.start', `name=meow-diag-${startedAt}`, 'settings=profile', `duration=${seconds}s`, `filename=${file}`], { timeout: 20000 });
      await waitForFile(file, seconds * 1000 + 30000);
      current = { ...current, state: 'reading' };
      const text = await run(exec, found.jfr, ['print', '--events', 'jdk.ExecutionSample,jdk.GarbageCollection', '--stack-depth', '24', file], { timeout: 120000, maxBuffer: 256 * 1024 * 1024 });
      const result = summarizeProfile(parseJfrText(text), { durationSec: seconds });
      current = { state: 'done', seconds, startedAt, finishedAt: now(), result };
    } catch (err) {
      current = { state: 'error', seconds, startedAt, finishedAt: now(), error: err.message };
    } finally {
      try { fs.unlinkSync(file); } catch (_) {}
    }
  }

  // Returns the new state, or throws an Error whose message tells why nothing was started.
  function start(seconds) {
    if (current.state === 'running' || current.state === 'reading') throw new Error('a profile is already running');
    const pid = deps.getPid();
    if (!pid) throw new Error('the server is not running');
    const found = tools();
    if (!found.profile) throw new Error(found.hint);
    const secs = Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Math.round(Number(seconds) || 10)));
    const startedAt = now();
    current = { state: 'running', seconds: secs, startedAt };
    record(pid, secs, found, startedAt);
    return current;
  }

  return { start, tools, state: () => current };
}

module.exports = { createProfiler, findTool, INSTALL_HINT, MIN_SECONDS, MAX_SECONDS };
