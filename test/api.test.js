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
  const state = { enabled, up: new Set(up), calls: [], summaries, dbCalls: [], instCalls: [] };
  const api = createApi({
    tokens, webhooks, hub,
    isEnabled: () => state.enabled,
    loadInstances: () => INSTANCES,
    workerUp: (inst) => state.up.has(inst.name),
    version: () => '9.9.9',
    clientIp: () => '1.2.3.4',
    sendJson: (res, status, data) => { res.out = { status, data }; },
    instances: {
      create: async (data) => { state.instCalls.push(['create', data]); if (data.name === 'busy') throw Object.assign(new Error('another instance is already being created'), { code: 409 }); },
      creation: () => ({ done: false, progress: 20, phase: 'Installing Paper', lines: [] }),
      versions: async (loader, mc) => { state.instCalls.push(['versions', loader, mc]); return ['1.21.1', '1.20.4']; },
      remove: async (inst, options) => { state.instCalls.push(['remove', inst.name, options]); return { status: 200, body: { ok: true, deletedFiles: options.files, deletedBackups: false } }; },
      upgrade: async (inst, data, rollback) => { state.instCalls.push(['upgrade', inst.name, data, rollback]); if (data.mcVersion === 'bad') throw new Error('that Minecraft version is not available for this loader'); },
      upgradeStatus: (inst) => ({ running: false, lines: [], current: { mcVersion: inst.mcVersion } }),
      templates: {
        list: () => [{ name: 'lobby', loader: 'paper', mcVersion: '1.21.1' }],
        save: async (inst, data) => { state.instCalls.push(['template', inst.name, data]); if (!data.name) throw new Error('a template name has 1 to 40 letters, digits, - or _'); return { name: data.name, sourceInstance: inst.name }; },
        remove: (name) => { state.instCalls.push(['template-remove', name]); return name === 'lobby'; },
      },
      network: {
        describe: (inst) => ({ backends: [], tryOrder: [], forcedHosts: {}, port: 25565, ready: true, proxy: inst.name }),
        apply: (inst, request, allowed) => { state.instCalls.push(['network', inst.name, request, allowed('survival'), allowed('creative')]); return { changed: [], proxyChanged: true, errors: [] }; },
      },
    },
    database: {
      status: () => ({ enabled: true, running: true, port: 3307 }),
      handle: async (request) => { state.dbCalls.push(request); return { status: 200, body: { ok: true, echo: request.sub } }; },
    },
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

test('database routes need the database scope and reach the service with the right target', async () => {
  const t = rig({ up: [] });
  const none = t.make(['read']);
  assert.strictEqual((await t.request('GET', '/api/v1/instances/survival/database', { token: none })).status, 403);
  assert.strictEqual((await t.request('GET', '/api/v1/database', { token: none })).status, 403);
  const token = t.make(['database']);
  assert.deepStrictEqual((await t.request('GET', '/api/v1/database', { token })).data, { ok: true, enabled: true, running: true, port: 3307 });
  const r = await t.request('POST', '/api/v1/instances/survival/database/tables/players/rows', { token, body: { values: { name: 'a' } } });
  assert.strictEqual(r.status, 200, 'the instance panel does not have to run');
  const call = t.state.dbCalls[0];
  assert.deepStrictEqual([call.kind, call.instance, call.method, call.sub, call.body], ['server', 'survival', 'POST', '/tables/players/rows', { values: { name: 'a' } }]);
  await t.request('DELETE', '/api/v1/instances/survival/database/tables/players/rows', { token, body: { key: { id: 1 } } });
  assert.deepStrictEqual([t.state.dbCalls[1].method, t.state.dbCalls[1].body], ['DELETE', { key: { id: 1 } }]);
  await t.request('GET', '/api/v1/instances/survival/database', { token });
  assert.strictEqual(t.state.dbCalls[2].sub, '');
});

test('the network database is closed to tokens that are limited to instances, and other instances stay hidden', async () => {
  const t = rig();
  const limited = t.make(['database'], { instances: ['creative'] });
  assert.strictEqual((await t.request('GET', '/api/v1/database/shared/tables', { token: limited })).status, 403);
  assert.strictEqual((await t.request('GET', '/api/v1/instances/survival/database', { token: limited })).status, 404);
  assert.strictEqual((await t.request('GET', '/api/v1/instances/creative/database', { token: limited })).status, 200);
  const open = t.make(['database']);
  const r = await t.request('GET', '/api/v1/database/shared/tables/x?limit=5', { token: open });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual([t.state.dbCalls.at(-1).kind, t.state.dbCalls.at(-1).sub, t.state.dbCalls.at(-1).instance, t.state.dbCalls.at(-1).query.get('limit')], ['shared', '/tables/x', null, '5']);
});

test('instances can be created, listed in versions, upgraded and deleted with the instances scope', async () => {
  const t = rig({ up: [] });
  const token = t.make(['instances']);
  assert.strictEqual((await t.request('POST', '/api/v1/instances', { token: t.make(['read']), body: { name: 'x' } })).status, 403);
  const versions = await t.request('GET', '/api/v1/versions?loader=paper&mc=1.21', { token });
  assert.deepStrictEqual(versions.data.versions, ['1.21.1', '1.20.4']);
  assert.deepStrictEqual(t.state.instCalls[0], ['versions', 'paper', '1.21']);
  const made = await t.request('POST', '/api/v1/instances', { token, body: { name: 'new', loader: 'paper', mcVersion: '1.21.1' } });
  assert.strictEqual(made.status, 202);
  assert.deepStrictEqual(t.state.instCalls[1], ['create', { name: 'new', loader: 'paper', mcVersion: '1.21.1' }]);
  const busy = await t.request('POST', '/api/v1/instances', { token, body: { name: 'busy' } });
  assert.deepStrictEqual([busy.status, busy.data.error], [409, 'another instance is already being created']);
  assert.strictEqual((await t.request('GET', '/api/v1/creation', { token })).data.phase, 'Installing Paper');

  const up = await t.request('POST', '/api/v1/instances/survival/software', { token, body: { mcVersion: '1.21.1' } });
  assert.strictEqual(up.status, 202);
  assert.deepStrictEqual(t.state.instCalls.at(-1), ['upgrade', 'survival', { mcVersion: '1.21.1' }, false]);
  const bad = await t.request('POST', '/api/v1/instances/survival/software', { token, body: { mcVersion: 'bad' } });
  assert.deepStrictEqual([bad.status, bad.data.ok], [400, false]);
  await t.request('POST', '/api/v1/instances/survival/software/rollback', { token, body: { restoreWorld: true } });
  assert.deepStrictEqual(t.state.instCalls.at(-1), ['upgrade', 'survival', { restoreWorld: true }, true]);
  assert.strictEqual((await t.request('GET', '/api/v1/instances/survival/software', { token })).data.current.mcVersion, '1.21.1');

  const noConfirm = await t.request('DELETE', '/api/v1/instances/survival', { token, body: {} });
  assert.strictEqual(noConfirm.status, 400);
  const wrong = await t.request('DELETE', '/api/v1/instances/survival', { token, body: { confirm: 'creative' } });
  assert.strictEqual(wrong.status, 400);
  const gone = await t.request('DELETE', '/api/v1/instances/survival', { token, body: { confirm: 'survival', files: true } });
  assert.deepStrictEqual([gone.status, gone.data.deletedFiles], [200, true]);
  assert.deepStrictEqual(t.state.instCalls.at(-1), ['remove', 'survival', { files: true, backups: false }]);
});

test('a token limited to instances cannot create instances and only changes its own', async () => {
  const t = rig({ up: [] });
  const limited = t.make(['instances'], { instances: ['creative'] });
  assert.strictEqual((await t.request('POST', '/api/v1/instances', { token: limited, body: { name: 'x' } })).status, 403);
  assert.strictEqual((await t.request('DELETE', '/api/v1/instances/survival', { token: limited, body: { confirm: 'survival' } })).status, 404);
  assert.strictEqual((await t.request('POST', '/api/v1/instances/survival/software', { token: limited, body: { mcVersion: '1' } })).status, 404);
  assert.strictEqual(t.state.instCalls.length, 0);
});

test('the network of a proxy is read and set through the API, limited to the instances of the token', async () => {
  const t = rig({ up: [] });
  const token = t.make(['instances'], { instances: ['survival'] });
  assert.strictEqual((await t.request('GET', '/api/v1/instances/survival/network', { token })).status, 400);
  assert.strictEqual((await t.request('POST', '/api/v1/instances/survival/network', { token, body: { servers: [] } })).status, 400);
  assert.strictEqual((await t.request('GET', '/api/v1/instances/creative/network', { token })).status, 404);
  assert.strictEqual(t.state.instCalls.length, 0);
});

test('mods and plugins go through the instance panel with the mods capability', async () => {
  const t = rig();
  assert.strictEqual((await t.request('GET', '/api/v1/instances/survival/mods', { token: t.make(['read']) })).status, 403);
  const token = t.make(['mods']);
  await t.request('GET', '/api/v1/instances/survival/mods', { token });
  await t.request('GET', '/api/v1/instances/survival/mods/search?q=sodium&kind=mod', { token });
  await t.request('POST', '/api/v1/instances/survival/mods/install', { token, body: { projectId: 'AANobbMI' } });
  await t.request('POST', '/api/v1/instances/survival/mods/toggle', { token, body: { name: 'a.jar', enable: false } });
  await t.request('POST', '/api/v1/instances/survival/mods/update', { token, body: { all: true } });
  assert.deepStrictEqual(t.state.calls.map((c) => [c.method, c.path, c.caps.join()]), [
    ['GET', '/api/mods', 'view,mods'],
    ['GET', '/api/modrinth/search?q=sodium&kind=mod', 'view,mods'],
    ['POST', '/api/modrinth/install', 'view,mods'],
    ['POST', '/api/mods/toggle', 'view,mods'],
    ['POST', '/api/modrinth/update', 'view,mods'],
  ]);
  assert.deepStrictEqual(t.state.calls[2].body, { projectId: 'AANobbMI' });
});

test('templates are listed, saved from an instance and deleted through the API', async () => {
  const t = rig({ up: [] });
  const token = t.make(['instances']);
  assert.strictEqual((await t.request('GET', '/api/v1/templates', { token: t.make(['read']) })).status, 403);
  assert.deepStrictEqual((await t.request('GET', '/api/v1/templates', { token })).data.templates.map((x) => x.name), ['lobby']);
  const saved = await t.request('POST', '/api/v1/instances/survival/template', { token, body: { name: 'hub', includeWorld: false } });
  assert.deepStrictEqual([saved.status, saved.data.template.sourceInstance], [201, 'survival']);
  assert.deepStrictEqual(t.state.instCalls.at(-1), ['template', 'survival', { name: 'hub', includeWorld: false }]);
  assert.strictEqual((await t.request('POST', '/api/v1/instances/survival/template', { token, body: {} })).status, 400);
  assert.strictEqual((await t.request('DELETE', '/api/v1/templates/lobby', { token })).status, 200);
  assert.strictEqual((await t.request('DELETE', '/api/v1/templates/nope', { token })).status, 404);
});

test('a token limited to instances cannot delete templates and only saves from its own instances', async () => {
  const t = rig({ up: [] });
  const limited = t.make(['instances'], { instances: ['creative'] });
  assert.strictEqual((await t.request('DELETE', '/api/v1/templates/lobby', { token: limited })).status, 403);
  assert.strictEqual((await t.request('POST', '/api/v1/instances/survival/template', { token: limited, body: { name: 'x' } })).status, 404);
  assert.strictEqual((await t.request('POST', '/api/v1/instances/creative/template', { token: limited, body: { name: 'x' } })).status, 201);
});

test('the startup configuration is read and changed through the settings scope, Java and JVM flags also need files', async () => {
  const t = rig();
  assert.strictEqual((await t.request('GET', '/api/v1/instances/survival/config', { token: t.make(['read']) })).status, 403);
  const token = t.make(['settings']);
  await t.request('GET', '/api/v1/instances/survival/config', { token });
  await t.request('POST', '/api/v1/instances/survival/config', { token, body: { ramMaxMB: 4096 } });
  assert.strictEqual((await t.request('POST', '/api/v1/instances/survival/config', { token, body: { extraJvmArgs: '-Dfoo=bar' } })).status, 403);
  const both = t.make(['settings', 'files']);
  await t.request('POST', '/api/v1/instances/survival/config', { token: both, body: { extraJvmArgs: '-Dfoo=bar' } });
  assert.deepStrictEqual(t.state.calls.map((c) => [c.method, c.path, c.caps.join()]), [['GET', '/api/config', 'view,settings'], ['POST', '/api/config', 'view,settings'], ['POST', '/api/config', 'view,settings,files']]);
  assert.deepStrictEqual(t.state.calls[2].body, { extraJvmArgs: '-Dfoo=bar' });
});

test('a token limited to instances cannot manage webhooks', async () => {
  const t = rig();
  const token = t.make(['events'], { instances: ['survival'] });
  assert.strictEqual((await t.request('GET', '/api/v1/webhooks', { token })).status, 403);
  assert.strictEqual((await t.request('POST', '/api/v1/webhooks', { token, body: { url: 'https://example.com/h' } })).status, 403);
  assert.strictEqual((await t.request('DELETE', '/api/v1/webhooks/abc123', { token })).status, 403);
});

test('a malformed instance name is a 400, not a crash', async () => {
  const t = rig();
  const r = await t.request('GET', '/api/v1/instances/%E0%A4%A', { token: t.make(['read']) });
  assert.strictEqual(r.status, 400);
});
