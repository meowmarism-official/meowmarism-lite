// Starts a fresh Velocity once so it writes velocity.toml and forwarding.secret, then stops it.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const WAIT_MS = 90000;
const SETTLE_MS = 1500;

const lastLines = (text) => String(text).trim().split('\n').filter(Boolean).slice(-3).join(' | ');

// command and args are replaceable for tests; the real call runs java -jar server.jar.
async function generateVelocityConfig(dir, javaBin, log, { args = ['-jar', 'server.jar'] } = {}) {
  const ready = () => fs.existsSync(path.join(dir, 'velocity.toml')) && fs.existsSync(path.join(dir, 'forwarding.secret'));
  if (ready()) return;
  log('generating the Velocity configuration');
  const proc = spawn(javaBin || 'java', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let gone = false;
  const keep = (chunk) => { output = (output + chunk).slice(-2000); };
  proc.stdout.on('data', keep);
  proc.stderr.on('data', keep);
  const exited = new Promise((resolve) => {
    proc.once('exit', () => { gone = true; resolve(); });
    proc.once('error', (err) => { gone = true; keep(err.message); resolve(); });
  });
  const deadline = Date.now() + WAIT_MS;
  while (!gone && !ready() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300));
  if (!gone) {
    await new Promise((r) => setTimeout(r, ready() ? SETTLE_MS : 0));
    proc.kill('SIGTERM');
    const killer = setTimeout(() => proc.kill('SIGKILL'), 10000);
    await exited;
    clearTimeout(killer);
  }
  if (!ready()) {
    const why = lastLines(output) || (gone ? 'it exited without output' : 'it did not answer in time');
    log(`Velocity output: ${why}`);
    throw new Error(`Velocity did not write its configuration: ${why}`);
  }
}

module.exports = { generateVelocityConfig };
