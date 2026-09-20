// Host facts for the panel's System page.
const os = require('os');
const fs = require('fs');

const GB = 1024 ** 3;
const round = (v) => Math.round(v * 10) / 10;

function collect({ dir = process.cwd(), extra = {} } = {}) {
  const cpus = os.cpus();
  const total = os.totalmem();
  const info = {
    hostname: os.hostname(),
    os: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    cpu: cpus[0] ? cpus[0].model.trim() : null,
    cores: cpus.length,
    load: os.loadavg().map((v) => Math.round(v * 100) / 100),
    memory: { totalGB: round(total / GB), usedGB: round((total - os.freemem()) / GB) },
    disk: null,
    node: process.version,
    hostUptimeSec: Math.round(os.uptime()),
    panelUptimeSec: Math.round(process.uptime()),
    ...extra,
  };
  for (const d of [dir, os.homedir()]) {
    try {
      const s = fs.statfsSync(d);
      info.disk = { totalGB: round((s.blocks * s.bsize) / GB), freeGB: round((s.bavail * s.bsize) / GB) };
      break;
    } catch (_) {}
  }
  return info;
}

module.exports = { collect };
