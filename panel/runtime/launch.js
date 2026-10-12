// How an instance's Minecraft server is launched: JVM arguments file, Java binary, CPU/RAM limits.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const AIKAR_FLAGS = [
  '-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', '-XX:MaxGCPauseMillis=200', '-XX:+UnlockExperimentalVMOptions',
  '-XX:+DisableExplicitGC', '-XX:+AlwaysPreTouch', '-XX:G1NewSizePercent=30', '-XX:G1MaxNewSizePercent=40',
  '-XX:G1HeapRegionSize=8M', '-XX:G1ReservePercent=20', '-XX:G1HeapWastePercent=5', '-XX:G1MixedGCCountTarget=4',
  '-XX:InitiatingHeapOccupancyPercent=15', '-XX:G1MixedGCLiveThresholdPercent=90', '-XX:G1RSetUpdatingPauseTimePercent=5',
  '-XX:SurvivorRatio=32', '-XX:+PerfDisableSharedMem', '-XX:MaxTenuringThreshold=1',
  '-Dusing.aikars.flags=https://mcflags.emc.gs', '-Daikars.new.flags=true',
];
const PRESETS = { default: [], aikar: AIKAR_FLAGS };

let cgroupChecked = null;
function cgroupAvailable() {
  if (cgroupChecked !== null) return cgroupChecked;
  try { execFileSync('systemd-run', ['--user', '--scope', '--quiet', 'true'], { stdio: 'ignore', timeout: 4000 }); cgroupChecked = true; }
  catch (_) { cgroupChecked = false; }
  return cgroupChecked;
}
let tasksetChecked = null;
function tasksetAvailable() {
  if (tasksetChecked !== null) return tasksetChecked;
  try { execFileSync('taskset', ['--version'], { stdio: 'ignore', timeout: 2000 }); tasksetChecked = true; }
  catch (_) { tasksetChecked = false; }
  return tasksetChecked;
}

function parseExtraArgs(text) {
  const args = String(text || '').split(/\s+/).filter(Boolean);
  for (const a of args) if (!a.startsWith('-')) throw new Error(`JVM argument must start with "-": ${a}`);
  return args;
}

function jvmArgsFile(cfg) {
  const max = Math.max(512, Math.round(cfg.ramMaxMB));
  const min = Math.min(max, Math.max(256, Math.round(cfg.ramMinMB || max / 2)));
  const lines = [`-Xms${min}M`, `-Xmx${max}M`, ...(PRESETS[cfg.jvmPreset] || []), ...parseExtraArgs(cfg.extraJvmArgs)];
  return lines.join('\n') + '\n';
}

// Keeps user_jvm_args.txt equal to the panel config. Does nothing until a heap
// size is configured, so an installer-provided file is left alone.
function syncJvmArgsFile(dir, cfg) {
  if (!cfg.ramMaxMB) return false;
  fs.writeFileSync(path.join(dir, 'user_jvm_args.txt'), jvmArgsFile(cfg));
  return true;
}

function readDetectedMemory(dir) {
  try {
    const text = fs.readFileSync(path.join(dir, 'user_jvm_args.txt'), 'utf8');
    const toMB = (v, u) => Math.round(Number(v) * ({ k: 1 / 1024, m: 1, g: 1024 }[u.toLowerCase()] || 1));
    const xms = text.match(/-Xms(\d+)([kKmMgG])/);
    const xmx = text.match(/-Xmx(\d+)([kKmMgG])/);
    return { ramMinMB: xms ? toMB(xms[1], xms[2]) : null, ramMaxMB: xmx ? toMB(xmx[1], xmx[2]) : null };
  } catch (_) { return { ramMinMB: null, ramMaxMB: null }; }
}

function limitsMode(cfg) {
  const wants = Number(cfg.cpuCores) > 0 || Number(cfg.hardMemLimitMB) > 0;
  if (!wants) return 'none';
  if (cgroupAvailable()) return 'cgroup';
  if (Number(cfg.cpuCores) > 0 && tasksetAvailable()) return 'taskset';
  return 'unavailable';
}

function buildLaunch(cfg, baseEnv) {
  const env = { ...baseEnv };
  if (cfg.javaPath) env.PATH = `${path.dirname(cfg.javaPath)}${path.delimiter}${env.PATH || ''}`;
  const inner = ['./run.sh', 'nogui'];
  const mode = limitsMode(cfg);
  if (mode === 'cgroup') {
    const props = [];
    if (Number(cfg.cpuCores) > 0) props.push('-p', `CPUQuota=${Math.round(Number(cfg.cpuCores) * 100)}%`);
    if (Number(cfg.hardMemLimitMB) > 0) props.push('-p', `MemoryMax=${Math.round(Number(cfg.hardMemLimitMB))}M`);
    return { cmd: 'systemd-run', args: ['--user', '--scope', '--quiet', ...props, '--', ...inner], env, mode };
  }
  if (mode === 'taskset') {
    const n = Math.max(1, Math.min(os.cpus().length, Math.round(Number(cfg.cpuCores))));
    return { cmd: 'taskset', args: ['-c', `0-${n - 1}`, ...inner], env, mode };
  }
  return { cmd: inner[0], args: inner.slice(1), env, mode };
}

// Minimum Java major a Minecraft version needs; null when unknown (never block on a guess).
function requiredJavaMajor(mcVersion) {
  const m = String(mcVersion || '').match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  const major = Number(m[1]), minor = Number(m[2]), patch = Number(m[3] || 0);
  if (major >= 26) return 25;
  if (major !== 1) return null;
  if (minor >= 21 || (minor === 20 && patch >= 5)) return 21;
  if (minor >= 18) return 17;
  if (minor === 17) return 16;
  return 8;
}

const javaCache = new Map();
function javaMajor(javaPath) {
  const key = javaPath || 'java';
  const hit = javaCache.get(key);
  if (hit && Date.now() - hit.at < 10000) return hit.value;
  let value = null;
  try {
    const r = require('child_process').spawnSync(key, ['-version'], { encoding: 'utf8', timeout: 8000 });
    const m = `${r.stderr || ''}${r.stdout || ''}`.match(/version "(\d+)(?:\.(\d+))?/);
    if (m) value = m[1] === '1' ? Number(m[2]) : Number(m[1]);
  } catch (_) {}
  javaCache.set(key, { at: Date.now(), value });
  return value;
}

module.exports = { requiredJavaMajor, javaMajor, PRESETS, jvmArgsFile, syncJvmArgsFile, readDetectedMemory, limitsMode, buildLaunch, parseExtraArgs, cgroupAvailable, tasksetAvailable };
