// LITE runtime: one Minecraft server as a host process. The panel state around it (phase, players, metrics, timeline) reacts through hooks.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const launchLib = require('./launch');
const { createStopWatchdog } = require('./stop-watchdog');

const SAVED_LINE = /All dimensions are saved/i;
const PID_POLL_MS = 2000;
const LINGER_POLL_MS = 1000;
const DEFAULT_STOP_TIMEOUT_SEC = 120;
const DEFAULT_AFTER_SAVE_SEC = 20;

function portBusy(port) {
  const r = spawnSync(process.execPath, ['-e', "const s=require('net').createServer();s.once('error',()=>process.exit(1));s.listen(Number(process.argv[1]),'0.0.0.0',()=>s.close(()=>process.exit(0)))", String(port)], { timeout: 5000 });
  return r.status === 1;
}

// A zombie has exited and only waits to be reaped, so it does not count as running.
function pidAlive(pid) {
  try { process.kill(pid, 0); } catch (err) { return err.code === 'EPERM'; }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch (_) { return true; }
}

function seconds(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 5 ? n : fallback;
}

// ctx: { serverDir, logFile, propertiesFile, mcVersion, panelConfig, hooks, serverPid?, port()?, portSetting?, dataRoot?, rememberJava?(bin) }
function createProcessRuntime(ctx) {
  const { serverDir, logFile, propertiesFile, mcVersion, panelConfig, hooks } = ctx;
  let child = null;
  let intent = null;
  let javaPid = null;
  let pidPoll = null;
  let lingerPoll = null;
  const stoppedListeners = [];

  const watchdog = createStopWatchdog({
    getPid: () => javaPid || child?.pid || null,
    isAlive: pidAlive,
    signal: (pid, name) => { try { process.kill(pid, name); } catch (_) {} },
    notice: (text) => hooks.notice(text),
  });

  function startBlock() {
    const needJava = launchLib.requiredJavaMajor(mcVersion);
    let haveJava = launchLib.javaMajor(panelConfig.javaPath);
    if (needJava && (haveJava == null || haveJava < needJava) && ctx.dataRoot) {
      const found = launchLib.findPanelJava(ctx.dataRoot, needJava);
      if (found) {
        panelConfig.javaPath = found.bin;
        if (ctx.rememberJava) ctx.rememberJava(found.bin);
        haveJava = found.major;
      }
    }
    if (needJava && (haveJava == null || haveJava < needJava)) {
      return `Minecraft ${mcVersion} needs Java ${needJava}, but ${haveJava == null ? 'no Java was found' : `Java ${haveJava} is installed`}. Install Java ${needJava} under Automation > Startup.`;
    }
    hooks.releasePort();
    const mcPort = ctx.port ? ctx.port() : (Number((fs.existsSync(propertiesFile) ? fs.readFileSync(propertiesFile, 'utf8').match(/^server-port\s*=\s*(\d+)/m) : null)?.[1]) || 25565);
    if (portBusy(mcPort)) {
      return `Port ${mcPort} is already used by another program. Change the port under ${ctx.portSetting || 'Settings (server-port)'} or stop the program that uses it.`;
    }
    return null;
  }

  function rememberJavaPid(proc) {
    if (!ctx.serverPid) return;
    pidPoll = setInterval(() => {
      const pid = ctx.serverPid();
      if (pid && pid !== proc.pid) javaPid = pid;
    }, PID_POLL_MS);
    pidPoll.unref();
  }

  function finish(proc, logStream, info) {
    clearInterval(pidPoll);
    clearInterval(lingerPoll);
    pidPoll = lingerPoll = null;
    watchdog.disarm();
    child = null;
    intent = null;
    javaPid = null;
    logStream.end();
    hooks.exited(info);
    for (const fn of stoppedListeners.splice(0)) fn();
  }

  // Runs fn once the server is really down (JVM gone), or at once when it is not running.
  function whenStopped(fn) {
    if (!child) fn(); else stoppedListeners.push(fn);
  }

  // The launcher is gone but the JVM is not: the server counts as running until the JVM is really gone.
  function waitForJava(proc, logStream, info) {
    const pid = javaPid;
    hooks.lingering?.(pid);
    watchdog.arm(seconds(panelConfig.stopAfterSaveSec, DEFAULT_AFTER_SAVE_SEC) * 1000);
    lingerPoll = setInterval(() => {
      if (pidAlive(pid)) return;
      finish(proc, logStream, info);
    }, LINGER_POLL_MS);
  }

  function start() {
    if (child) return false;
    hooks.startAttempt();
    const block = startBlock();
    if (block) { hooks.blocked(block); return false; }
    hooks.willSpawn();

    const logStream = fs.createWriteStream(logFile, { flags: 'w' });
    try { launchLib.syncJvmArgsFile(serverDir, panelConfig); }
    catch (err) { hooks.notice(`--- could not write JVM arguments: ${err.message} ---`); }
    const launch = launchLib.buildLaunch(panelConfig, process.env);
    const proc = spawn(launch.cmd, launch.args, { cwd: serverDir, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'] });
    child = proc;
    intent = null;
    javaPid = null;
    hooks.spawned(proc, launch);
    rememberJavaPid(proc);

    const pipe = (stream, isErr) => stream.on('data', (d) => {
      const text = d.toString();
      logStream.write(text);
      text.split(/\r?\n/).forEach((line) => {
        if (!line.length) return;
        if (intent && SAVED_LINE.test(line)) watchdog.arm(seconds(panelConfig.stopAfterSaveSec, DEFAULT_AFTER_SAVE_SEC) * 1000);
        hooks.line(line, isErr);
      });
    });
    pipe(proc.stdout, false);
    pipe(proc.stderr, true);

    proc.on('error', (err) => {
      const noPid = proc.pid === undefined;
      if (noPid) child = null;
      hooks.spawnError(err, noPid);
    });

    proc.on('exit', (code, signal) => {
      const info = { code, signal, reason: signal ? `signal ${signal}` : `code ${code}`, intent };
      if (javaPid && javaPid !== proc.pid && pidAlive(javaPid)) waitForJava(proc, logStream, info);
      else finish(proc, logStream, info);
    });

    return true;
  }

  function stop(why = 'stop') {
    if (!child || !child.stdin.writable) return false;
    intent = why;
    const pid = ctx.serverPid?.(true);
    if (pid && pid !== child.pid) javaPid = pid;
    hooks.stopping(why);
    child.stdin.write('stop\n');
    watchdog.arm(seconds(panelConfig.stopTimeoutSec, DEFAULT_STOP_TIMEOUT_SEC) * 1000);
    return true;
  }

  // The launcher (run.sh) is not always the JVM, so the real java pid is killed as well when known.
  function kill(knownJavaPid) {
    if (!child) return false;
    intent = 'force-stop';
    const target = knownJavaPid || javaPid;
    try {
      if (target && target !== child.pid) { try { process.kill(target, 'SIGKILL'); } catch (_) {} }
      child.kill('SIGKILL');
      return true;
    } catch (_) { return false; }
  }

  function command(text) {
    if (!child || !child.stdin.writable) return false;
    child.stdin.write(`${text}\n`);
    return true;
  }

  return {
    getChild: () => child,
    isRunning: () => !!child,
    isReady: () => !!child && hooks.getPhase() === 'ready',
    start,
    stop,
    kill,
    command,
    whenStopped,
    restart(why = 'restart') {
      if (!child) return start();
      const stopping = stop(why);
      if (stopping) whenStopped(() => setTimeout(start, 700));
      return stopping;
    },
    stopAndWait: () => new Promise((resolve) => {
      if (!child) { resolve(); return; }
      const forceTimer = setTimeout(() => kill(), 90000);
      whenStopped(() => { clearTimeout(forceTimer); resolve(); });
      if (!stop()) kill();
    }),
  };
}

module.exports = { createProcessRuntime, portBusy, pidAlive };
