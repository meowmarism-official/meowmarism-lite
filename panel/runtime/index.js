// LITE runtime: the server is a host process.
const { assertRuntime } = require('../core/modules/runtime-contract');
const { createProcessRuntime } = require('./process');
const { createProcessMetrics } = require('./metrics');

// ctx: everything createProcessRuntime takes, plus hasJstat()
function createRuntime(ctx) {
  let metrics = null;
  const proc = createProcessRuntime({ ...ctx, serverPid: (force) => (metrics ? metrics.pid(force) : null) });
  metrics = createProcessMetrics({ getChild: proc.getChild, hasJstat: ctx.hasJstat, jstatPath: ctx.jstatPath });
  const stats = () => {
    const s = metrics.stats();
    return s ? { cpuPercent: s.cpuPercent, memoryMB: s.rssMB } : null;
  };
  return assertRuntime({ ...proc, stats, metrics });
}

module.exports = { createRuntime };
