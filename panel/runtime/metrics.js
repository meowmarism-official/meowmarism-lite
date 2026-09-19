// LITE runtime metrics: stats of the server process (java) read from /proc, plus jstat heap and GC numbers.
const fs = require('fs');
const { execFile } = require('child_process');

// deps: { getChild: () => ChildProcess | null, hasJstat: () => boolean }
function createProcessMetrics({ getChild, hasJstat }) {
  let cachedPid = null;
  let cachedPidAt = 0;
  let prevCpu = null;
  let prevIo = null;
  let javaCache = { pid: null, at: 0, data: null };
  let javaGcPrev = null;
  let javaProbeInFlight = false;

  function procInfo(pid) {
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
      const ppid = Number(status.match(/^PPid:\s+(\d+)$/m)?.[1] || 0);
      return { pid: Number(pid), ppid, cmdline, status };
    } catch (_) {
      return null;
    }
  }

  // The child is the launcher (run.sh), so look for a java process below it.
  function findServerPid() {
    const child = getChild();
    if (!child?.pid) return null;
    const rootPid = child.pid;
    const infos = [];
    try {
      for (const entry of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        const info = procInfo(entry);
        if (info) infos.push(info);
      }
    } catch (_) {
      return rootPid;
    }
    const descendants = new Set([rootPid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const info of infos) {
        if (!descendants.has(info.pid) && descendants.has(info.ppid)) {
          descendants.add(info.pid);
          changed = true;
        }
      }
    }
    const java = infos.find((info) => descendants.has(info.pid) && /(^|\s|\/)java(?:\s|$)/i.test(info.cmdline));
    return java?.pid || rootPid;
  }

  function pid() {
    const child = getChild();
    if (!child?.pid) {
      cachedPid = null;
      cachedPidAt = 0;
      return null;
    }
    const now = Date.now();
    if (cachedPid && now - cachedPidAt < 2000 && fs.existsSync(`/proc/${cachedPid}/stat`)) return cachedPid;
    cachedPid = findServerPid();
    cachedPidAt = now;
    return cachedPid;
  }

  function stats() {
    const serverPid = pid();
    if (!serverPid) return null;
    const child = getChild();
    const result = {
      pid: serverPid,
      launcherPid: child?.pid || null,
      rssMB: null,
      threads: null,
      cpuPercent: null,
      readBps: null,
      writeBps: null,
      readBytes: null,
      writeBytes: null,
      voluntaryCtx: null,
      involuntaryCtx: null,
    };

    try {
      const status = fs.readFileSync(`/proc/${serverPid}/status`, 'utf8');
      const rss = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
      const threads = status.match(/^Threads:\s+(\d+)$/m);
      const voluntary = status.match(/^voluntary_ctxt_switches:\s+(\d+)$/m);
      const involuntary = status.match(/^nonvoluntary_ctxt_switches:\s+(\d+)$/m);
      if (rss) result.rssMB = Number(rss[1]) / 1024;
      if (threads) result.threads = Number(threads[1]);
      if (voluntary) result.voluntaryCtx = Number(voluntary[1]);
      if (involuntary) result.involuntaryCtx = Number(involuntary[1]);
    } catch (_) {}

    try {
      const stat = fs.readFileSync(`/proc/${serverPid}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      const fields = stat.slice(close + 2).split(' ');
      const ticks = Number(fields[11]) + Number(fields[12]);
      const now = Date.now();
      if (prevCpu && prevCpu.pid === serverPid) {
        const dt = (now - prevCpu.at) / 1000;
        const tickRate = 100;
        if (dt > 0) result.cpuPercent = Math.max(0, ((ticks - prevCpu.ticks) / tickRate / dt) * 100);
      }
      prevCpu = { pid: serverPid, ticks, at: now };
    } catch (_) {}

    try {
      const io = fs.readFileSync(`/proc/${serverPid}/io`, 'utf8');
      const readBytes = Number(io.match(/^read_bytes:\s+(\d+)$/m)?.[1] || 0);
      const writeBytes = Number(io.match(/^write_bytes:\s+(\d+)$/m)?.[1] || 0);
      const now = Date.now();
      result.readBytes = readBytes;
      result.writeBytes = writeBytes;
      if (prevIo && prevIo.pid === serverPid) {
        const dt = Math.max(0.001, (now - prevIo.at) / 1000);
        result.readBps = Math.max(0, (readBytes - prevIo.readBytes) / dt);
        result.writeBps = Math.max(0, (writeBytes - prevIo.writeBytes) / dt);
      }
      prevIo = { pid: serverPid, at: now, readBytes, writeBytes };
    } catch (_) {}

    if (result.cpuPercent != null) result.cpuPercent = Number(result.cpuPercent.toFixed(2));
    return result;
  }

  function openFiles(serverPid) {
    if (!serverPid) return null;
    try {
      return fs.readdirSync(`/proc/${serverPid}/fd`).length;
    } catch (_) {
      return null;
    }
  }

  function javaStats(serverPid) {
    if (!serverPid) return null;
    const now = Date.now();
    const stale = javaCache.pid !== serverPid || now - javaCache.at >= 5000;
    if (stale && !javaProbeInFlight && hasJstat()) {
      javaProbeInFlight = true;
      execFile('jstat', ['-gc', String(serverPid)], { timeout: 900 }, (err, stdout) => {
        javaProbeInFlight = false;
        const sampledAt = Date.now();
        if (err) { javaCache = { pid: serverPid, at: sampledAt, data: null }; return; }
        try {
          const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
          if (lines.length < 2) { javaCache = { pid: serverPid, at: sampledAt, data: null }; return; }
          const headers = lines[0].trim().split(/\s+/);
          const values = lines[1].trim().split(/\s+/).map(Number);
          const m = Object.fromEntries(headers.map((h, i) => [h, values[i]]));
          const heapUsedKB = [m.S0U, m.S1U, m.EU, m.OU].filter(Number.isFinite).reduce((a, b) => a + b, 0);
          const heapCapKB = [m.S0C, m.S1C, m.EC, m.OC].filter(Number.isFinite).reduce((a, b) => a + b, 0);
          const gcTimeSec = Number(m.GCT) || 0;
          const prev = javaGcPrev && javaGcPrev.pid === serverPid ? javaGcPrev : null;
          const dtSec = prev ? Math.max(.001, (sampledAt - prev.at) / 1000) : null;
          const gcDeltaMs = prev ? Math.max(0, (gcTimeSec - prev.gcTimeSec) * 1000) : 0;
          javaGcPrev = { pid: serverPid, at: sampledAt, gcTimeSec };
          const data = {
            sampledAt,
            heapUsedMB: heapUsedKB / 1024,
            heapCapacityMB: heapCapKB / 1024,
            heapPercent: heapCapKB > 0 ? (heapUsedKB / heapCapKB) * 100 : null,
            metaspaceUsedMB: Number.isFinite(m.MU) ? m.MU / 1024 : null,
            metaspaceCapacityMB: Number.isFinite(m.MC) ? m.MC / 1024 : null,
            youngGcCount: Number.isFinite(m.YGC) ? m.YGC : null,
            fullGcCount: Number.isFinite(m.FGC) ? m.FGC : null,
            concurrentGcCount: Number.isFinite(m.CGC) ? m.CGC : null,
            gcTimeSec,
            gcDeltaMs,
            gcLoadPercent: dtSec ? Math.min(100, (gcDeltaMs / (dtSec * 1000)) * 100) : 0,
          };
          for (const [k, v] of Object.entries(data)) if (typeof v === 'number' && Number.isFinite(v)) data[k] = Number(v.toFixed(2));
          javaCache = { pid: serverPid, at: sampledAt, data };
        } catch (_) { javaCache = { pid: serverPid, at: sampledAt, data: null }; }
      });
    }
    return javaCache.pid === serverPid ? javaCache.data : null;
  }

  function reset() {
    cachedPid = null;
    cachedPidAt = 0;
    prevCpu = null;
    prevIo = null;
    javaCache = { pid: null, at: 0, data: null };
    javaGcPrev = null;
  }

  return { pid, stats, openFiles, javaStats, reset };
}

module.exports = { createProcessMetrics };
