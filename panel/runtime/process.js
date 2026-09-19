// LITE runtime: one Minecraft server as a host process. The panel state around it (phase, players, metrics, timeline) reacts through hooks.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const launchLib = require('./launch');

function portBusy(port) {
  const r = spawnSync(process.execPath, ['-e', "const s=require('net').createServer();s.once('error',()=>process.exit(1));s.listen(Number(process.argv[1]),'0.0.0.0',()=>s.close(()=>process.exit(0)))", String(port)], { timeout: 5000 });
  return r.status === 1;
}

// ctx: { serverDir, logFile, propertiesFile, mcVersion, panelConfig, hooks }
function createProcessRuntime(ctx) {
  const { serverDir, logFile, propertiesFile, mcVersion, panelConfig, hooks } = ctx;
  let child = null;
  let intent = null;

  function startBlock() {
    const needJava = launchLib.requiredJavaMajor(mcVersion);
    const haveJava = launchLib.javaMajor(panelConfig.javaPath);
    if (needJava && (haveJava == null || haveJava < needJava)) {
      return `Minecraft ${mcVersion} needs Java ${needJava}, but ${haveJava == null ? 'no Java was found' : `Java ${haveJava} is installed`}. Install Java ${needJava} under Automation > Startup.`;
    }
    hooks.releasePort();
    const mcPort = Number((fs.existsSync(propertiesFile) ? fs.readFileSync(propertiesFile, 'utf8').match(/^server-port\s*=\s*(\d+)/m) : null)?.[1]) || 25565;
    if (portBusy(mcPort)) {
      return `Port ${mcPort} is already used by another program. Change the port under Settings (server-port) or stop the program that uses it.`;
    }
    return null;
  }

  function start() {
    if (child) return false;
    hooks.startAttempt();
    const block = startBlock();
    if (block) { hooks.blocked(block); return false; }
    hooks.willSpawn();

    const logStream = fs.createWriteStream(logFile, { flags: 'w' });
    if (panelConfig.ramMaxMB) {
      try { fs.writeFileSync(path.join(serverDir, 'user_jvm_args.txt'), launchLib.jvmArgsFile(panelConfig)); }
      catch (err) { hooks.notice(`--- could not write JVM arguments: ${err.message} ---`); }
    }
    const launch = launchLib.buildLaunch(panelConfig, process.env);
    const proc = spawn(launch.cmd, launch.args, { cwd: serverDir, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'] });
    child = proc;
    intent = null;
    hooks.spawned(proc, launch);

    const pipe = (stream, isErr) => stream.on('data', (d) => {
      const text = d.toString();
      logStream.write(text);
      text.split(/\r?\n/).forEach((line) => { if (line.length) hooks.line(line, isErr); });
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
      child = null;
      intent = null;
      logStream.end();
      hooks.exited(info);
    });

    return true;
  }

  function stop(why = 'stop') {
    if (!child || !child.stdin.writable) return false;
    intent = why;
    hooks.stopping(why);
    child.stdin.write('stop\n');
    return true;
  }

  // The launcher (run.sh) is not always the JVM, so the real java pid is killed as well when known.
  function kill(javaPid) {
    if (!child) return false;
    intent = 'force-stop';
    try {
      if (javaPid && javaPid !== child.pid) { try { process.kill(javaPid, 'SIGKILL'); } catch (_) {} }
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
    restart(why = 'restart') {
      if (!child) return start();
      child.once('exit', () => setTimeout(start, 700));
      return stop(why);
    },
    stopAndWait: () => new Promise((resolve) => {
      if (!child) { resolve(); return; }
      child.once('exit', () => resolve());
      stop();
    }),
  };
}

module.exports = { createProcessRuntime, portBusy };
