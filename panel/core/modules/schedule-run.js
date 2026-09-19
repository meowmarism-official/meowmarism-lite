// Runs one scheduled task against an instance runtime. The product supplies the backup and the restart-with-warning behavior.
// ctx: { runtime, createBackup(reason), restart(warnSec, reason), onError(err) }
function runTask(task, ctx) {
  const a = task.action;
  const { runtime } = ctx;
  const running = runtime.isRunning();
  if (a.type === 'backup') {
    Promise.resolve(ctx.createBackup('scheduled')).catch((err) => ctx.onError(err));
    return 'backup started';
  }
  if (a.type === 'start') return running ? 'skipped (already running)' : (runtime.start() ? 'started' : 'could not start');
  if (!running) return 'skipped (server not running)';
  if (a.type === 'restart') {
    ctx.restart(a.warnSec || 0, `Scheduled: ${task.name}`);
    return 'restart scheduled';
  }
  if (a.type === 'stop') {
    if (a.warnSec > 0) {
      runtime.command(`say Server stops in ${a.warnSec}s`);
      setTimeout(() => runtime.stop('scheduled'), a.warnSec * 1000);
    } else runtime.stop('scheduled');
    return 'stop requested';
  }
  if (a.type === 'command') {
    runtime.command(a.command);
    return 'command sent';
  }
  return 'nothing to do';
}

module.exports = { runTask };
