const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('node:stream');
const { createApiTokens } = require('../panel/core/modules/api-tokens');
const { createWebhooks } = require('../panel/core/modules/api-webhooks');
const { createEventHub } = require('../panel/core/modules/api-events');
const { createApi } = require('../panel/api');

const INSTANCES = [
  { id: 'a', name: 'survival', panelPort: 9001, loader: 'paper', mcVersion: '1.21.1', port: 25565 },
  { id: 'b', name: 'creative', panelPort: 9002, loader: 'vanilla', mcVersion: '1.21.1', port: 25566 },
];

function rig({ enabled = true, up = ['survival', 'creative'], summaries = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apit-'));
  const tokens = createApiTokens({ file: path.join(dir, 't.json') });
  const posts = [];
  const webhooks = createWebhooks({ file: path.join(dir, 'h.json'), backoffMs: [], post: async (url, req) => { posts.push({ url, ...req }); return { status: 200 }; } });
  const hub = createEventHub();
  const state = { enabled, up: new Set(up), calls: [], summaries };
  const api = createApi({
    tokens, webhooks, hub,
    isEnabled: () => state.enabled,
    loadInstances: () => INSTANCES,
    workerUp: (inst) => state.up.has(inst.name),
    version: () => '9.9.9',
    clientIp: () => '1.2.3.4',
    sendJson: (res, status, data) => { res.out = { status, data }; },
    callWorker: async (inst, caps, method, p, body) => {
      state.calls.push({ inst: inst.name, caps, method, path: p, body });
      if (p === '/api/summary') return { status: 200, body: state.summaries[inst.name] || { running: false, phase: 'offline', lag: { count: 0 } } };
      return { status: 200, body: { ok: true } };
    },
  });
  const request = async (method, url, { token, body, headers = {} } = {}) => {
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
    req.method = method;
    req.headers = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers };
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, writeHead() {}, write() {}, end() {} };
    const handled = await api.handle(req, res, new URL(url, 'http://localhost'));
    return { handled, status: res.out?.status, data: res.out?.data, headers: res.headers };
  };
  const make = (scopes, extra = {}) => tokens.create({ name: 't', scopes, ...extra }).token;
  return { api, tokens, webhooks, hub, state, request, make, posts };
}

test('the API only answers on /api/v1 and is invisible until it is enabled', async () => {
  const off = rig({ enabled: false });
  assert.strictEqual((await off.request('GET', '/something')).handled, false);
  const r = await off.request('GET', '/api/v1/instances', { token: off.make(['read']) });
  assert.strictEqual(r.status, 404);
  assert.match(r.data.error, /not enabled/);
});

test('a missing, malformed or revoked token gets 401 with a challenge', async () => {
  const t = rig();
  const none = await t.request('GET', '/api/v1/instances');
  assert.strictEqual(none.status, 401);
  assert.strictEqual(none.headers['WWW-Authenticate'], 'Bearer');
  assert.strictEqual((await t.request('GET', '/api/v1/instances', { token: 'mmk_nonsense' })).status, 401);
  const made = t.tokens.create({ name: 'gone', scopes: ['read'] });
  t.tokens.revoke(made.id);
  assert.strictEqual((await t.request('GET', '/api/v1/instances', { token: made.token })).status, 401);
});

test('the root tells the token what it may do', async () => {
  const t = rig();
  const r = await t.request('GET', '/api/v1', { token: t.make(['read', 'power']) });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual([r.data.version, r.data.scopes], ['9.9.9', ['read', 'power']]);
});

test('the instance list shows only the instances of the token, and marks a stopped panel', async () => {
  const t = rig({ up: ['survival'], summaries: { survival: { running: true, phase: 'ready', tps: 20 } } });
  const all = await t.request('GET', '/api/v1/instances', { token: t.make(['read']) });
  assert.deepStrictEqual(all.data.instances.map((i) => [i.name, i.panel, i.phase]), [['survival', 'on', 'ready'], ['creative', 'off', 'offline']]);
  const one = await t.request('GET', '/api/v1/instances', { token: t.make(['read'], { instances: ['creative'] }) });
  assert.deepStrictEqual(one.data.instances.map((i) => i.name), ['creative']);
});

test('a token without the scope is refused, and a hidden instance does not exist for it', async () => {
  const t = rig();
  const readOnly = t.make(['read']);
  const denied = await t.request('POST', '/api/v1/instances/survival/start', { token: readOnly, body: {} });
  assert.strictEqual(denied.status, 403);
  assert.match(denied.data.error, /power/);
  assert.strictEqual(t.state.calls.length, 0);
  const limited = t.make(['read'], { instances: ['creative'] });
  assert.strictEqual((await t.request('GET', '/api/v1/instances/survival', { token: limited })).status, 404);
  assert.strictEqual((await t.request('GET', '/api/v1/instances/missing', { token: readOnly })).status, 404);
});

test('power actions reach the worker with only the power capability', async () => {
  const t = rig();
  const token = t.make(['power']);
  for (const action of ['start', 'stop', 'restart', 'force-stop']) {
    const r = await t.request('POST', `/api/v1/instances/survival/${action}`, { token, body: {} });
    assert.strictEqual(r.status, 200, action);
  }
  assert.deepStrictEqual(t.state.calls.map((c) => [c.path, c.caps.join()]), [['/start', 'power'], ['/stop', 'power'], ['/restart', 'power'], ['/force-stop', 'power']]);
});

test('actions on an instance whose panel is not running say so', async () => {
  const t = rig({ up: [] });
  const r = await t.request('POST', '/api/v1/instances/survival/start', { token: t.make(['power']), body: {} });
  assert.strictEqual(r.status, 409);
  const info = await t.request('GET', '/api/v1/instances/survival', { token: t.make(['read']) });
  assert.strictEqual(info.status, 200, 'the overview still works');
  assert.strictEqual(info.data.panel, 'off');
});

test('a console command is sent as one line without the leading slash', async () => {
  const t = rig();
  const token = t.make(['console']);
  assert.strictEqual((await t.request('POST', '/api/v1/instances/survival/command', { token, body: { cmd: '/time set day' } })).status, 200);
  assert.deepStrictEqual(t.state.calls[0].body, { cmd: 'time set day' });
  assert.strictEqual(t.state.calls[0].caps.join(), 'console');
  const multi = await t.request('POST', '/api/v1/instances/survival/command', { token, body: { cmd: 'say a\nstop' } });
  assert.strictEqual(multi.status, 400);
  assert.strictEqual((await t.request('POST', '/api/v1/instances/survival/command', { token, body: {} })).status, 400);
  assert.strictEqual(t.state.calls.length, 1);
});

test('say and tell build their command safely', async () => {
  const t = rig();
  const token = t.make(['console']);
  await t.request('POST', '/api/v1/instances/survival/say', { token, body: { message: 'hello\u0000 world' } });
  assert.strictEqual(t.state.calls[0].body.cmd, 'say hello  world');
  await t.request('POST', '/api/v1/instances/survival/players/Steve/message', { token, body: { message: 'hi there' } });
  assert.strictEqual(t.state.calls[1].body.cmd, 'tell Steve hi there');
  const bad = await t.request('POST', '/api/v1/instances/survival/players/Ste%20ve%3Bstop/message', { token, body: { message: 'x' } });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(t.state.calls.length, 2);
});

test('player actions become commands, even for offline players, and unknown ones are refused', async () => {
  const t = rig();
  const token = t.make(['console']);
  await t.request('POST', '/api/v1/instances/survival/players/Steve/action', { token, body: { action: 'kick', reason: 'AFK' } });
  await t.request('POST', '/api/v1/instances/survival/players/Alex/action', { token, body: { action: 'gamemode', value: 'creative' } });
  await t.request('POST', '/api/v1/instances/survival/players/Alex/action', { token, body: { action: 'whitelist-add' } });
  assert.deepStrictEqual(t.state.calls.map((c) => c.body.cmd), ['kick Steve AFK', 'gamemode creative Alex', 'whitelist add Alex']);
  assert.strictEqual((await t.request('POST', '/api/v1/instances/survival/players/Steve/action', { token, body: { action: 'explode' } })).status, 400);
  assert.strictEqual((await t.request('POST', '/api/v1/instances/survival/players/Steve/action', { token, body: { action: 'gamemode', value: 'banana' } })).status, 400);
});

test('settings, backups, files and diagnostics are forwarded with their capability', async () => {
  const t = rig();
  const token = t.make(['read', 'settings', 'backups', 'files', 'console']);
  await t.request('GET', '/api/v1/instances/survival/settings', { token });
  await t.request('POST', '/api/v1/instances/survival/settings', { token, body: { settings: { 'max-players': 40 } } });
  await t.request('GET', '/api/v1/instances/survival/backups', { token });
  await t.request('POST', '/api/v1/instances/survival/backups', { token, body: {} });
  await t.request('GET', '/api/v1/instances/survival/files?path=config%2Fa.toml', { token });
  await t.request('GET', '/api/v1/instances/survival/files/content?path=server.properties', { token });
  await t.request('GET', '/api/v1/instances/survival/console?lines=50', { token });
  await t.request('POST', '/api/v1/instances/survival/diagnostics/profile', { token, body: { seconds: 10 } });
  assert.deepStrictEqual(t.state.calls.map((c) => [c.method, c.path, c.caps.join()]), [
    ['GET', '/api/settings', 'view'], ['POST', '/api/settings', 'settings'],
    ['GET', '/api/backups', 'backups'], ['POST', '/api/backup', 'backups'],
    ['GET', '/api/files?path=config%2Fa.toml', 'files'], ['GET', '/api/files/content?path=server.properties', 'files'],
    ['GET', '/api/console?lines=50', 'console'], ['POST', '/api/diagnostics/profile', 'console'],
  ]);
  assert.deepStrictEqual(t.state.calls[1].body, { settings: { 'max-players': 40 } });
});

test('metrics and players come from the instance summary', async () => {
  const t = rig({ summaries: { survival: { running: true, phase: 'ready', tps: 19.5, mspt: 31, cpuPercent: 40, memoryMB: 2048, players: { online: 2, list: [{ name: 'Steve' }] }, lag: { count: 0 } } } });
  const token = t.make(['read']);
  const m = await t.request('GET', '/api/v1/instances/survival/metrics', { token });
  assert.deepStrictEqual([m.data.tps, m.data.mspt, m.data.cpuPercent, m.data.memoryMB], [19.5, 31, 40, 2048]);
  const p = await t.request('GET', '/api/v1/instances/survival/players', { token });
  assert.deepStrictEqual([p.data.online, p.data.list[0].name], [2, 'Steve']);
});

test('too many wrong tokens from one address are slowed down', async () => {
  const t = rig();
  let last;
  for (let i = 0; i < 25; i++) last = await t.request('GET', '/api/v1/instances', { token: 'mmk_0000000000000000_' + 'a'.repeat(32) });
  assert.strictEqual(last.status, 429);
  const good = await t.request('GET', '/api/v1/instances', { token: t.make(['read']) });
  assert.strictEqual(good.status, 200, 'a valid token is still served');
});

test('webhooks are managed through the API with the events scope, and the secret is shown once', async () => {
  const t = rig();
  assert.strictEqual((await t.request('GET', '/api/v1/webhooks', { token: t.make(['read']) })).status, 403);
  const token = t.make(['events']);
  const made = await t.request('POST', '/api/v1/webhooks', { token, body: { url: 'https://example.com/h', events: ['server.ready'] } });
  assert.strictEqual(made.status, 201);
  assert.match(made.data.webhook.secret, /^whsec_/);
  const listed = await t.request('GET', '/api/v1/webhooks', { token });
  assert.ok(!('secret' in listed.data.webhooks[0]));
  assert.strictEqual((await t.request('POST', '/api/v1/webhooks', { token, body: { url: 'ftp://x' } })).status, 400);
  const tested = await t.request('POST', `/api/v1/webhooks/${made.data.webhook.id}/test`, { token, body: {} });
  assert.strictEqual(tested.data.ok, true);
  assert.strictEqual((await t.request('DELETE', `/api/v1/webhooks/${made.data.webhook.id}`, { token })).status, 200);
  assert.strictEqual((await t.request('DELETE', '/api/v1/webhooks/abc123', { token })).status, 404);
});

test('status changes found by polling become events and webhook deliveries', async () => {
  const t = rig({ summaries: { survival: { running: false, phase: 'offline', lag: { count: 0 } } } });
  t.webhooks.add({ url: 'https://example.com/h', events: ['server.ready', 'server.lag'] });
  await t.api.poll();
  assert.strictEqual(t.hub.since(0).length, 0, 'the first poll only sets the baseline');
  t.state.summaries.survival = { running: true, phase: 'starting', lag: { count: 0 } };
  await t.api.poll();
  t.state.summaries.survival = { running: true, phase: 'ready', lag: { count: 1, last: { delayMs: 6720, ticksBehind: 134 } } };
  await t.api.poll();
  assert.deepStrictEqual(t.hub.since(0).map((e) => [e.type, e.instance]), [['server.starting', 'survival'], ['server.ready', 'survival'], ['server.lag', 'survival']]);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(t.posts.map((p) => p.headers['X-Meowmarism-Event']), ['server.ready', 'server.lag']);
  t.state.enabled = false;
  t.state.summaries.survival = { running: false, phase: 'offline', lag: { count: 1 } };
  await t.api.poll();
  assert.strictEqual(t.hub.since(0).length, 3, 'nothing is published while the API is off');
});
