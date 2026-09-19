// LITE runtime: the server is a host process.
const { assertRuntime } = require('../core/modules/runtime-contract');
const { createProcessRuntime } = require('./process');

const createRuntime = (ctx) => assertRuntime(createProcessRuntime(ctx));

module.exports = { createRuntime };
