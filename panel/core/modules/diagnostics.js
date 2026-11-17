// Performance diagnostics shared by every product: reading tick and lag lines, and turning a Java Flight Recorder
// dump (jfr print) into a short summary of who uses the time. Pure functions, no process access.

const INFRASTRUCTURE = [
  'java.', 'javax.', 'jdk.', 'sun.', 'com.sun.', 'net.minecraft.', 'com.mojang.', 'it.unimi.', 'com.google.',
  'org.apache.', 'org.slf4j.', 'org.spongepowered.', 'net.neoforged.', 'cpw.mods.', 'io.netty.', 'org.objectweb.',
  'net.minecraftforge.', 'net.fabricmc.', 'org.lwjgl.', 'org.joml.', 'org.jetbrains.',
];
const SERVER_THREAD = /^Server thread/;

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Output of the vanilla /tick query command (Minecraft 1.20.3 and later). Returns null when the text has neither line.
function parseTickQuery(text) {
  const out = {};
  const rate = String(text).match(/Target tick rate:\s*([0-9.]+)\s*per second\.\s*Average time per tick:\s*([0-9.]+)\s*ms/i);
  if (rate) { out.targetRate = num(rate[1]); out.avgMs = num(rate[2]); }
  const pct = String(text).match(/P50:\s*([0-9.]+)\s*ms\s*P95:\s*([0-9.]+)\s*ms\s*P99:\s*([0-9.]+)\s*ms(?:,\s*sample:\s*(\d+))?/i);
  if (pct) { out.p50Ms = num(pct[1]); out.p95Ms = num(pct[2]); out.p99Ms = num(pct[3]); if (pct[4]) out.sample = num(pct[4]); }
  return Object.keys(out).length ? out : null;
}

// Ticks per second implied by the average tick time: a server that keeps up reports its target rate.
function tpsFrom(tick) {
  if (!tick || tick.avgMs == null) return null;
  const target = tick.targetRate ?? 20;
  if (tick.avgMs <= 0) return target;
  return Math.min(target, Math.round((1000 / tick.avgMs) * 10) / 10);
}

function parseLagLine(text) {
  const m = String(text).match(/Can't keep up!.*?Running\s+(\d+)ms\s+or\s+(\d+)\s+ticks behind/i);
  return m ? { delayMs: Number(m[1]), ticksBehind: Number(m[2]) } : null;
}

function toMs(text) {
  const m = String(text).match(/([0-9.]+)\s*(ns|us|µs|ms|s)\b/);
  if (!m) return 0;
  const v = Number(m[1]);
  return { ns: v / 1e6, us: v / 1e3, 'µs': v / 1e3, ms: v, s: v * 1000 }[m[2]];
}

// Text of `jfr print --events jdk.ExecutionSample,jdk.GarbageCollection --stack-depth N`.
function parseJfrText(text) {
  const samples = [];
  const gc = { count: 0, totalPauseMs: 0, longestMs: 0 };
  let event = null;
  let sample = null;
  let inStack = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!event) {
      if (line === 'jdk.ExecutionSample {') { event = 'sample'; sample = { thread: '', frames: [] }; inStack = false; }
      else if (line === 'jdk.GarbageCollection {') { event = 'gc'; gc.count++; }
      continue;
    }
    if (event === 'sample') {
      if (inStack) {
        if (line === ']') inStack = false;
        else if (line !== '...' && line) sample.frames.push(line);
        continue;
      }
      const thread = line.match(/^sampledThread = "(.*)"/);
      if (thread) sample.thread = thread[1];
      else if (line.startsWith('stackTrace = [')) inStack = true;
      else if (line === '}') { if (sample.frames.length) samples.push(sample); event = null; sample = null; }
    } else if (event === 'gc') {
      const pause = line.match(/^sumOfPauses = (.*)$/);
      const longest = line.match(/^longestPause = (.*)$/);
      if (pause) gc.totalPauseMs += toMs(pause[1]);
      else if (longest) gc.longestMs = Math.max(gc.longestMs, toMs(longest[1]));
      else if (line === '}') event = null;
    }
  }
  gc.totalPauseMs = Math.round(gc.totalPauseMs * 10) / 10;
  gc.longestMs = Math.round(gc.longestMs * 10) / 10;
  return { samples, gc };
}

// "net.minecraft.X.run(Args) line: 12" -> "net.minecraft.X.run"
function methodOf(frame) {
  const m = String(frame).match(/^([^\s(]+)\(/);
  return m ? m[1] : String(frame).split(' ')[0];
}

function classOf(frame) {
  const method = methodOf(frame);
  const dot = method.lastIndexOf('.');
  return dot > 0 ? method.slice(0, dot) : method;
}

// The innermost frame that belongs to neither the JDK nor Minecraft and its libraries is the mod or plugin to blame.
function ownerOf(frames) {
  for (const frame of frames) {
    const cls = classOf(frame);
    if (INFRASTRUCTURE.some((prefix) => cls.startsWith(prefix))) continue;
    const parts = cls.split('.');
    return parts.length > 3 ? parts.slice(0, 3).join('.') : parts.slice(0, -1).join('.') || cls;
  }
  return frames.some((f) => classOf(f).startsWith('net.minecraft.')) ? 'Minecraft' : 'JDK / runtime';
}

function groupName(thread) {
  return String(thread).replace(/\d+/g, 'N');
}

function top(counter, total, limit) {
  return [...counter].sort((a, b) => b[1] - a[1]).slice(0, limit)
    .map(([name, samples]) => ({ name, samples, percent: Math.round((samples / total) * 1000) / 10 }));
}

function summarizeProfile(parsed, { limit = 12, durationSec = null } = {}) {
  const { samples, gc } = parsed;
  const total = samples.length;
  const threads = new Map();
  const owners = new Map();
  const serverMethods = new Map();
  const serverOwners = new Map();
  let serverTotal = 0;
  const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);
  for (const s of samples) {
    bump(threads, groupName(s.thread));
    const owner = ownerOf(s.frames);
    bump(owners, owner);
    if (SERVER_THREAD.test(s.thread)) {
      serverTotal++;
      bump(serverMethods, methodOf(s.frames[0]));
      bump(serverOwners, owner);
    }
  }
  return {
    samples: total,
    durationSec,
    threads: total ? top(threads, total, 8) : [],
    owners: total ? top(owners, total, limit) : [],
    serverThread: serverTotal ? {
      samples: serverTotal,
      methods: top(serverMethods, serverTotal, limit),
      owners: top(serverOwners, serverTotal, limit),
    } : null,
    gc,
  };
}

module.exports = { parseTickQuery, tpsFrom, parseLagLine, parseJfrText, summarizeProfile, ownerOf, methodOf };
