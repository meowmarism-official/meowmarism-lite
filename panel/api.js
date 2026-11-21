// The optional HTTP API of LITE: /api/v1 on the controller port, authenticated by bearer tokens with scopes.
// It checks the token, then asks the worker of an instance for the work. The worker enforces the matching capability again.
const http = require('http');
const { allowsInstance, hasScope, SCOPES } = require('./core/modules/api-tokens');
const { diffStatus } = require('./core/modules/api-events');
const { buildPlayerCommand, playerName } = require('./core/modules/players');

const PREFIX = '/api/v1';
const POLL_MS = 2000;
const MAX_STREAMS_PER_TOKEN = 5;
const BAD_TOKEN_LIMIT = 20;
const REQUESTS_PER_MINUTE = 300;

// The worker capability that backs each scope.
const CAP = { read: 'view', power: 'power', console: 'console', settings: 'settings', backups: 'backups', files: 'files', events: 'view' };
const BODY_METHODS = ['POST', 'PATCH', 'DELETE'];

const cleanText = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(Object.assign(new Error('the request body is too large'), { status: 413 })); req.destroy(); return; }
      body += chunk;
    });
    req.on('end', () => {
      if (!body.trim()) { resolve({}); return; }
      try { resolve(JSON.parse(body)); } catch (_) { reject(Object.assign(new Error('the body is not valid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

// deps: { tokens, webhooks, hub, isEnabled(), loadInstances(), workerUp(inst), workerSecret, version(), clientIp(req), database: { status(), handle(request) },
//         instances: { create, creation, versions, remove, upgrade, upgradeStatus, templates: { list, save, remove }, network: { describe, apply } }, callWorker? }
function createApi(deps) {
  const { tokens, webhooks, hub, isEnabled, loadInstances, workerUp, version, clientIp } = deps;
  const windows = new Map();
  const streams = new Map();
  let pollTimer = null;
  const baselines = new Map();

  function hit(key, limit, windowMs) {
    const now = Date.now();
    const entry = windows.get(key);
    if (!entry || now - entry.at >= windowMs) { windows.set(key, { at: now, count: 1 }); return true; }
    entry.count++;
    return entry.count <= limit;
  }

  function callWorker(inst, caps, method, workerPath, body, timeoutMs = 15000) {
    if (deps.callWorker) return deps.callWorker(inst, caps, method, workerPath, body, timeoutMs);
    return new Promise((resolve) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request({
        host: '127.0.0.1', port: inst.panelPort, path: workerPath, method, timeout: timeoutMs,
        headers: {
          [deps.workerSecret.HEADER]: deps.workerSecret.get(), 'x-meow-caps': caps.join(','),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = text;
          if (String(res.headers['content-type'] || '').includes('json')) { try { parsed = JSON.parse(text || '{}'); } catch (_) {} }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', (err) => resolve({ status: 0, body: { error: err.message } }));
      req.end(payload || undefined);
    });
  }

  const send = (res, status, data) => deps.sendJson(res, status, data);
  const fail = (res, status, error) => send(res, status, { ok: false, error });

  function answer(res, result) {
    if (!result.status) { fail(res, 502, 'the instance panel did not answer'); return; }
    send(res, result.status, typeof result.body === 'object' && result.body !== null ? result.body : { ok: result.status < 400, text: String(result.body) });
  }

  async function overview(inst) {
    const meta = { name: inst.name, loader: inst.loader, mcVersion: inst.mcVersion, port: inst.port };
    if (!workerUp(inst)) return { ...meta, panel: 'off', running: false, phase: 'offline' };
    const r = await callWorker(inst, ['view'], 'GET', '/api/summary', undefined, 2500);
    if (!r.status || r.status >= 400) return { ...meta, panel: 'unreachable', running: false, phase: 'unknown' };
    return { ...meta, panel: 'on', ...r.body };
  }

  // Each route: scope needed, a path pattern and the handler. params are the captured parts of the pattern.
  const routes = [];
  const route = (method, pattern, scope, handler, options = {}) => routes.push({ method, pattern: new RegExp(`^${pattern}$`), scope, handler, ...options });
  const toWorker = (cap, method, workerPath, withBody = false) => async (ctx) => answer(ctx.res, await callWorker(ctx.inst, [cap], method, workerPath(ctx), withBody ? ctx.body : undefined));
  const forward = (scope, method, workerPath, withBody) => (ctx) => toWorker(CAP[scope], method, workerPath, withBody)(ctx);

  route('GET', '', null, async ({ res, token }) => send(res, 200, { ok: true, version: version(), scopes: token.scopes, instances: token.instances }));
  route('GET', '/instances', 'read', async ({ res, token }) => {
    const list = loadInstances().filter((i) => allowsInstance(token, i.name));
    send(res, 200, { ok: true, instances: await Promise.all(list.map(overview)) });
  });
  route('GET', '/instances/([^/]+)', 'read', async (ctx) => send(ctx.res, 200, { ok: true, ...(await overview(ctx.inst)) }));
  route('POST', '/instances/([^/]+)/(start|stop|restart|force-stop)', 'power', (ctx) => toWorker('power', 'POST', (c) => `/${c.params[1]}`, true)({ ...ctx, body: {} }));
  route('POST', '/instances/([^/]+)/command', 'console', async (ctx) => {
    const cmd = cleanText(ctx.body.cmd, 1000).replace(/^\//, '');
    if (!cmd || /[\r\n]/.test(String(ctx.body.cmd))) return fail(ctx.res, 400, 'cmd must be one command on a single line');
    return answer(ctx.res, await callWorker(ctx.inst, ['console'], 'POST', '/command', { cmd }));
  });
  route('POST', '/instances/([^/]+)/say', 'console', async (ctx) => {
    const message = cleanText(ctx.body.message, 256);
    if (!message) return fail(ctx.res, 400, 'message is required');
    return answer(ctx.res, await callWorker(ctx.inst, ['console'], 'POST', '/command', { cmd: `say ${message}` }));
  });
  route('POST', '/instances/([^/]+)/players/([^/]+)/action', 'console', async (ctx) => {
    let cmd;
    try { cmd = buildPlayerCommand(String(ctx.body.action || ''), decodeURIComponent(ctx.params[1]), ctx.body.value, ctx.body.reason); } catch (err) { return fail(ctx.res, 400, err.message); }
    return answer(ctx.res, await callWorker(ctx.inst, ['console'], 'POST', '/command', { cmd }));
  });
  route('POST', '/instances/([^/]+)/players/([^/]+)/message', 'console', async (ctx) => {
    let name;
    try { name = playerName(decodeURIComponent(ctx.params[1])); } catch (err) { return fail(ctx.res, 400, err.message); }
    const message = cleanText(ctx.body.message, 256);
    if (!message) return fail(ctx.res, 400, 'message is required');
    return answer(ctx.res, await callWorker(ctx.inst, ['console'], 'POST', '/command', { cmd: `tell ${name} ${message}` }));
  });
  route('GET', '/instances/([^/]+)/console', 'console', forward('console', 'GET', (c) => `/api/console?lines=${encodeURIComponent(c.url.searchParams.get('lines') || '200')}`));
  route('GET', '/instances/([^/]+)/players', 'read', async (ctx) => send(ctx.res, 200, { ok: true, ...((await overview(ctx.inst)).players || { online: 0, list: [] }) }));
  route('GET', '/instances/([^/]+)/metrics', 'read', async (ctx) => {
    const s = await overview(ctx.inst);
    send(ctx.res, 200, { ok: true, running: s.running, phase: s.phase, tps: s.tps ?? null, mspt: s.mspt ?? null, tick: s.tick ?? null, lag: s.lag ?? null, cpuPercent: s.cpuPercent ?? null, memoryMB: s.memoryMB ?? null, java: s.java ?? null });
  });
  route('GET', '/instances/([^/]+)/diagnostics', 'read', forward('read', 'GET', (c) => `/api/diagnostics${c.url.searchParams.get('refresh') === '1' ? '?refresh=1' : ''}`));
  route('POST', '/instances/([^/]+)/diagnostics/profile', 'console', forward('console', 'POST', () => '/api/diagnostics/profile', true));
  route('GET', '/instances/([^/]+)/settings', 'read', forward('read', 'GET', () => '/api/settings'));
  route('POST', '/instances/([^/]+)/settings', 'settings', forward('settings', 'POST', () => '/api/settings', true));
  route('GET', '/instances/([^/]+)/backups', 'backups', forward('backups', 'GET', () => '/api/backups'));
  route('POST', '/instances/([^/]+)/backups', 'backups', forward('backups', 'POST', () => '/api/backup', true));
  route('GET', '/instances/([^/]+)/files', 'files', forward('files', 'GET', (c) => `/api/files?path=${encodeURIComponent(c.url.searchParams.get('path') || '.')}`));
  route('GET', '/instances/([^/]+)/files/content', 'files', forward('files', 'GET', (c) => `/api/files/content?path=${encodeURIComponent(c.url.searchParams.get('path') || '')}`));

  // Instances: create, delete, change the software, link servers to a proxy.
  const guard = async (ctx, work) => {
    try { return await work(); } catch (err) { return fail(ctx.res, err.code || 400, err.message || 'the request failed'); }
  };
  route('GET', '/versions', 'instances', (ctx) => guard(ctx, async () => {
    const loader = String(ctx.url.searchParams.get('loader') || '');
    const mc = ctx.url.searchParams.get('mc') || undefined;
    return send(ctx.res, 200, { ok: true, loader, versions: await deps.instances.versions(loader, mc) });
  }));
  route('POST', '/instances', 'instances', (ctx) => {
    if (ctx.token.instances) return fail(ctx.res, 403, 'creating instances needs a token without instance limits');
    return guard(ctx, async () => {
      await deps.instances.create(ctx.body);
      return send(ctx.res, 202, { ok: true, note: 'the instance is being built, follow GET /api/v1/creation' });
    });
  });
  route('GET', '/templates', 'instances', async ({ res }) => send(res, 200, { ok: true, templates: deps.instances.templates.list() }));
  route('DELETE', '/templates/([A-Za-z0-9_-]+)', 'instances', (ctx) => {
    if (ctx.token.instances) return fail(ctx.res, 403, 'deleting templates needs a token without instance limits');
    return deps.instances.templates.remove(ctx.params[0]) ? send(ctx.res, 200, { ok: true }) : fail(ctx.res, 404, 'no such template');
  });
  route('POST', '/instances/([^/]+)/template', 'instances', (ctx) => guard(ctx, async () => send(ctx.res, 201, { ok: true, template: await deps.instances.templates.save(ctx.inst, ctx.body) })), { noWorker: true });
  route('GET', '/creation', 'instances', async ({ res }) => send(res, 200, { ok: true, ...deps.instances.creation() }));
  route('DELETE', '/instances/([^/]+)', 'instances', (ctx) => guard(ctx, async () => {
    if (ctx.body.confirm !== ctx.inst.name) return fail(ctx.res, 400, 'confirm must be the name of the instance');
    const out = await deps.instances.remove(ctx.inst, { files: ctx.body.files === true, backups: ctx.body.backups === true });
    return send(ctx.res, out.status, out.body);
  }), { noWorker: true });
  route('GET', '/instances/([^/]+)/software', 'instances', (ctx) => send(ctx.res, 200, { ok: true, ...deps.instances.upgradeStatus(ctx.inst) }), { noWorker: true });
  route('POST', '/instances/([^/]+)/software', 'instances', (ctx) => guard(ctx, async () => {
    await deps.instances.upgrade(ctx.inst, ctx.body, false);
    return send(ctx.res, 202, { ok: true });
  }), { noWorker: true });
  route('POST', '/instances/([^/]+)/software/rollback', 'instances', (ctx) => guard(ctx, async () => {
    await deps.instances.upgrade(ctx.inst, ctx.body, true);
    return send(ctx.res, 202, { ok: true });
  }), { noWorker: true });
  route('GET', '/instances/([^/]+)/network', 'instances', (ctx) => guard(ctx, async () => {
    if (ctx.inst.loader !== 'velocity') return fail(ctx.res, 400, 'only a proxy has a network');
    return send(ctx.res, 200, { ok: true, ...deps.instances.network.describe(ctx.inst) });
  }), { noWorker: true });
  route('POST', '/instances/([^/]+)/network', 'instances', (ctx) => guard(ctx, async () => {
    if (ctx.inst.loader !== 'velocity') return fail(ctx.res, 400, 'only a proxy has a network');
    return send(ctx.res, 200, { ok: true, ...deps.instances.network.apply(ctx.inst, ctx.body, (name) => allowsInstance(ctx.token, name)) });
  }), { noWorker: true });

  // Startup configuration of an instance: memory, JVM flags, Java path, auto start.
  route('GET', '/instances/([^/]+)/config', 'settings', async (ctx) => answer(ctx.res, await callWorker(ctx.inst, ['view', 'settings'], 'GET', '/api/config')));
  route('POST', '/instances/([^/]+)/config', 'settings', async (ctx) => {
    const launch = ['extraJvmArgs', 'javaPath'].some((k) => ctx.body[k] !== undefined);
    if (launch && !hasScope(ctx.token, 'files')) return fail(ctx.res, 403, 'changing Java or JVM arguments needs the files scope too');
    return answer(ctx.res, await callWorker(ctx.inst, launch ? ['view', 'settings', 'files'] : ['view', 'settings'], 'POST', '/api/config', ctx.body));
  });

  // Mods and plugins of one instance, through its panel.
  const modCaps = ['view', 'mods'];
  const mods = (method, sub, workerPath, { body = false, slow = false } = {}) => route(method, `/instances/([^/]+)/mods${sub}`, 'mods', async (ctx) => answer(ctx.res, await callWorker(ctx.inst, modCaps, method, workerPath(ctx), body ? ctx.body : undefined, slow ? 180000 : 30000)));
  const query = (ctx) => (ctx.url.search || '');
  mods('GET', '', () => '/api/mods');
  mods('POST', '/toggle', () => '/api/mods/toggle', { body: true });
  mods('GET', '/search', (ctx) => `/api/modrinth/search${query(ctx)}`);
  mods('GET', '/versions', (ctx) => `/api/modrinth/versions${query(ctx)}`);
  mods('GET', '/updates', () => '/api/modrinth/updates', { slow: true });
  mods('POST', '/install', () => '/api/modrinth/install', { body: true, slow: true });
  mods('POST', '/update', () => '/api/modrinth/update', { body: true, slow: true });

  // Databases: the same routes the panel uses, below instances/:name/database and database/shared.
  async function databaseRoute(ctx, kind, sub) {
    if (kind === 'shared' && ctx.token.instances) return fail(ctx.res, 403, 'the network database needs a token without instance limits');
    try {
      const out = await deps.database.handle({ kind, instance: ctx.inst ? ctx.inst.name : null, method: ctx.req.method, sub: sub || '', body: ctx.body, query: ctx.url.searchParams });
      return send(ctx.res, out.status, out.body);
    } catch (err) { return fail(ctx.res, 400, err.message); }
  }
  route('GET', '/database', 'database', async ({ res }) => send(res, 200, { ok: true, ...deps.database.status() }));
  for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
    route(method, '/instances/([^/]+)/database(/.*)?', 'database', (ctx) => databaseRoute(ctx, 'server', ctx.params[1]), { noWorker: true });
    route(method, '/database/shared(/.*)?', 'database', (ctx) => databaseRoute(ctx, 'shared', ctx.params[0]));
  }

  route('GET', '/events', 'events', (ctx) => {
    const { req, res, token, url } = ctx;
    if ((streams.get(token.id) || 0) >= MAX_STREAMS_PER_TOKEN) return fail(res, 429, 'too many open event streams for this token');
    streams.set(token.id, (streams.get(token.id) || 0) + 1);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const write = (e) => { if (!e.instance || allowsInstance(token, e.instance)) res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`); };
    res.write(': connected\n\n');
    for (const e of hub.since(req.headers['last-event-id'] || url.searchParams.get('since') || 0)) write(e);
    const off = hub.subscribe(write);
    const beat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
    req.on('close', () => {
      clearInterval(beat);
      off();
      streams.set(token.id, Math.max(0, (streams.get(token.id) || 1) - 1));
    });
  });
  route('GET', '/webhooks', 'events', async ({ res }) => send(res, 200, { ok: true, webhooks: webhooks.list() }));
  route('POST', '/webhooks', 'events', async ({ res, body }) => {
    try { send(res, 201, { ok: true, webhook: webhooks.add({ url: body.url, events: body.events, name: body.name }) }); } catch (err) { fail(res, 400, err.message); }
  });
  route('POST', '/webhooks/([a-f0-9]+)/test', 'events', async ({ res, params }) => {
    const ok = await webhooks.test(params[0]);
    if (ok === null) return fail(res, 404, 'no such webhook');
    return send(res, 200, { ok });
  });
  route('DELETE', '/webhooks/([a-f0-9]+)', 'events', async ({ res, params }) => (webhooks.remove(params[0]) ? send(res, 200, { ok: true }) : fail(res, 404, 'no such webhook')));

  function bearer(req) {
    const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
    return m ? m[1] : null;
  }

  // Returns true when the request belonged to the API (answered or refused), false to let other routes look at it.
  async function handle(req, res, url) {
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return false;
    if (!isEnabled()) { fail(res, 404, 'the API is not enabled'); return true; }
    const ip = clientIp(req);
    const token = bearer(req) ? tokens.verify(bearer(req)) : null;
    if (!token) {
      if (!hit(`fail:${ip}`, BAD_TOKEN_LIMIT, 5 * 60 * 1000)) { fail(res, 429, 'too many failed attempts, try again later'); return true; }
      res.setHeader('WWW-Authenticate', 'Bearer');
      fail(res, 401, 'missing or invalid token');
      return true;
    }
    if (!hit(`tok:${token.id}`, REQUESTS_PER_MINUTE, 60 * 1000)) { res.setHeader('Retry-After', '60'); fail(res, 429, 'rate limit reached for this token'); return true; }

    const rest = url.pathname.slice(PREFIX.length);
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.pattern.exec(rest);
      if (!m) continue;
      if (r.scope && !hasScope(token, r.scope)) { fail(res, 403, `this token lacks the ${r.scope} scope`); return true; }
      const ctx = { req, res, url, token, params: m.slice(1), body: {} };
      if (rest.startsWith('/instances/')) {
        const name = decodeURIComponent(m[1]);
        ctx.inst = loadInstances().find((i) => i.name === name);
        if (!ctx.inst || !allowsInstance(token, ctx.inst.name)) { fail(res, 404, 'no such instance'); return true; }
        const overviewOnly = req.method === 'GET' && rest === `/instances/${m[1]}`;
        if (!overviewOnly && !r.noWorker && !workerUp(ctx.inst)) { fail(res, 409, 'the panel of this instance is not running'); return true; }
      }
      try {
        if (BODY_METHODS.includes(req.method)) ctx.body = await readJson(req);
        await r.handler(ctx);
      } catch (err) {
        if (!res.headersSent) fail(res, err.status || 500, err.status ? err.message : 'the request failed');
      }
      return true;
    }
    fail(res, 404, 'no such endpoint');
    return true;
  }

  async function poll() {
    if (!isEnabled()) { baselines.clear(); return; }
    for (const inst of loadInstances()) {
      if (!workerUp(inst)) continue;
      const r = await callWorker(inst, ['view'], 'GET', '/api/summary', undefined, 2000);
      if (!r.status || r.status >= 400) continue;
      const next = { running: r.body.running, phase: r.body.phase, crashAt: r.body.crashAt, lagCount: r.body.lag?.count || 0, lag: r.body.lag?.last };
      for (const e of diffStatus(baselines.get(inst.name), next)) {
        const event = hub.publish(e.type, { instance: inst.name, ...Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'type')) });
        webhooks.deliver(event).catch(() => {});
      }
      baselines.set(inst.name, next);
    }
  }

  function start() {
    if (pollTimer) return;
    pollTimer = setInterval(() => { poll().catch(() => {}); }, POLL_MS);
    pollTimer.unref();
  }

  function stop() { clearInterval(pollTimer); pollTimer = null; }

  return { handle, start, stop, poll, SCOPES };
}

module.exports = { createApi, PREFIX };
