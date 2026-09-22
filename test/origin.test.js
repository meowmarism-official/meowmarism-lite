// Writes that come from a page on another site are refused; tools and same-site pages are not affected.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const harness = require('../test-support/harness');

const send = (base, method, path, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = http.request(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
    let data = '';
    res.on('data', (c) => { data += c; });
    res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
  });
  req.on('error', reject);
  req.end(body ? JSON.stringify(body) : undefined);
});
const login = { username: 'owner', password: 'ownerpass123' };

test('cross-origin writes are refused, same-origin and header-less ones work', async () => {
  const h = await harness.start();
  try {
    const host = new URL(h.base).host;
    const evil = await send(h.base, 'POST', '/auth/login', { headers: { Origin: 'https://evil.example' }, body: login });
    assert.equal(evil.status, 403);
    assert.match(evil.body, /cross-origin request refused/);
    assert.ok(!evil.headers['set-cookie'], 'no session is created for a foreign page');

    for (const origin of ['null', 'not a url', `https://${host}.evil.example`]) {
      assert.equal((await send(h.base, 'POST', '/auth/login', { headers: { Origin: origin }, body: login })).status, 403, origin);
    }

    const same = await send(h.base, 'POST', '/auth/login', { headers: { Origin: `http://${host}` }, body: login });
    assert.equal(same.status, 200);
    const plain = await send(h.base, 'POST', '/auth/login', { body: login });
    assert.equal(plain.status, 200, 'a request without Origin (curl, scripts) still works');

    const cookie = plain.headers['set-cookie'][0].split(';')[0];
    const attack = { headers: { Cookie: cookie, Origin: 'https://evil.example' } };
    assert.equal((await send(h.base, 'POST', '/api/instances', { ...attack, body: { name: 'x', port: 25999 } })).status, 403);
    assert.equal((await send(h.base, 'POST', '/instance/inst1/command', { ...attack, body: { cmd: 'stop' } })).status, 403);
    assert.equal((await send(h.base, 'DELETE', '/api/instances/inst1', attack)).status, 403);
    assert.equal((await send(h.base, 'POST', '/api/settings', { ...attack, body: { trustProxy: true } })).status, 403);

    const read = await send(h.base, 'GET', '/api/instances', { headers: { Cookie: cookie, Origin: 'https://evil.example' } });
    assert.equal(read.status, 200, 'reads are not affected');
  } finally { await h.stop(); }
});

test('a forwarded host is only trusted when the panel is told to trust its proxy', async () => {
  const h = await harness.start();
  try {
    const cookie = (await send(h.base, 'POST', '/auth/login', { body: login })).headers['set-cookie'][0].split(';')[0];
    const viaProxy = { headers: { Cookie: cookie, Origin: 'https://panel.example.com', 'X-Forwarded-Host': 'panel.example.com' } };
    assert.equal((await send(h.base, 'POST', '/api/settings', { ...viaProxy, body: { trustProxy: false } })).status, 403, 'refused while proxy trust is off');
    const enable = await send(h.base, 'POST', '/api/settings', { headers: { Cookie: cookie }, body: { trustProxy: true } });
    assert.equal(enable.status, 200);
    assert.equal((await send(h.base, 'POST', '/api/settings', { ...viaProxy, body: { trustProxy: true } })).status, 200, 'accepted once the proxy is trusted');
    const other = await send(h.base, 'POST', '/api/settings', { headers: { Cookie: cookie, Origin: 'https://evil.example', 'X-Forwarded-Host': 'panel.example.com' }, body: { trustProxy: true } });
    assert.equal(other.status, 403, 'an origin that does not match the forwarded host is still refused');
  } finally { await h.stop(); }
});
