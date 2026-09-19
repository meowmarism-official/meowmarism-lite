// What every product runtime (LITE: host process, PROFESSIONAL: Docker container) must provide for one instance.
// Shared modules only talk to this object.
const METHODS = {
  isRunning: 'true while the server process or container is up',
  isReady: 'true once the server accepts players',
  start: 'start the server, returns false when it cannot start',
  stop: 'graceful stop (saves the world), returns false when nothing runs',
  restart: 'graceful stop, then start',
  kill: 'stop immediately without saving',
  stopAndWait: 'graceful stop, resolves once the server is down',
  command: 'send a console command, returns false when nothing runs',
  stats: 'current use of the server as { cpuPercent, memoryMB }, or null when nothing runs',
};

function assertRuntime(runtime) {
  const missing = Object.keys(METHODS).filter((m) => typeof runtime[m] !== 'function');
  if (missing.length) throw new Error(`runtime is missing: ${missing.join(', ')}`);
  return runtime;
}

module.exports = { METHODS, assertRuntime };
