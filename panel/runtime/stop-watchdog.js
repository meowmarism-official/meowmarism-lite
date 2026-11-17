// Ends a server process that outlives its stop: SIGTERM at the deadline, SIGKILL if it still lives after a grace period.
// deps: { getPid, isAlive(pid), signal(pid, name), notice(text), now?, setTimer?, clearTimer?, termGraceMs? }
function createStopWatchdog(deps) {
  const { getPid, isAlive, signal, notice } = deps;
  const now = deps.now || Date.now;
  const setTimer = deps.setTimer || setTimeout;
  const clearTimer = deps.clearTimer || clearTimeout;
  const termGraceMs = deps.termGraceMs ?? 15000;
  let timer = null;
  let deadline = Infinity;
  let termSent = false;

  function disarm() {
    if (timer) clearTimer(timer);
    timer = null;
    deadline = Infinity;
    termSent = false;
  }

  function schedule(delayMs) {
    if (timer) clearTimer(timer);
    deadline = now() + delayMs;
    timer = setTimer(fire, delayMs);
    if (timer && timer.unref) timer.unref();
  }

  function fire() {
    timer = null;
    const pid = getPid();
    if (!pid || !isAlive(pid)) { disarm(); return; }
    if (!termSent) {
      termSent = true;
      notice(`--- server process ${pid} is still running after stop, sending SIGTERM ---`);
      signal(pid, 'SIGTERM');
      schedule(termGraceMs);
      return;
    }
    notice(`--- server process ${pid} ignored SIGTERM, sending SIGKILL ---`);
    signal(pid, 'SIGKILL');
    disarm();
  }

  // The earliest requested deadline wins; arming later than the current one does nothing.
  function arm(delayMs) {
    if (termSent) return;
    if (now() + delayMs >= deadline) return;
    schedule(delayMs);
  }

  return { arm, disarm, isArmed: () => timer != null };
}

module.exports = { createStopWatchdog };
