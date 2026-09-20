// HTTP routes for account management on top of the user store (see users.js).
const { hasPanelCap, INSTANCE_CAPS } = require('./users');

// store: createUserStore(...); session(req) -> { username, role } | null
function createUsersApi({ store, session }) {
  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const readJson = (req, res, limit, onData) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > limit) req.destroy(); });
    req.on('end', () => {
      let data;
      try { data = JSON.parse(body || '{}'); } catch (_) { return send(res, 400, { error: 'invalid request' }); }
      onData(data);
    });
  };
  const reply = () => ({ ok: true, users: store.listUsers(), instanceCaps: INSTANCE_CAPS });

  // Returns true when the request was an accounts route and has been answered.
  function handle(req, res, url) {
    if (!url.pathname.startsWith('/api/users')) return false;
    const s = session(req);
    const me = s ? store.findUser(s.username) : null;
    const isOwner = !!me && me.role === 'owner';
    if (!hasPanelCap(me, 'users')) { send(res, 403, { error: 'not allowed to manage users' }); return true; }
    const limit = (settings) => {
      if (!isOwner && settings?.panel) settings.panel.users = false;
      return settings;
    };

    if (url.pathname === '/api/users' && req.method === 'GET') { send(res, 200, reply()); return true; }
    if (url.pathname === '/api/users' && req.method === 'POST') {
      readJson(req, res, 8192, (data) => {
        const username = String(data.username || '').trim();
        const password = String(data.password || '');
        if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) return send(res, 400, { error: 'username: 3-32 letters, digits, . _ -' });
        if (password.length < 8) return send(res, 400, { error: 'password must be at least 8 characters' });
        if (!store.createMember(username, password, limit(data))) return send(res, 400, { error: 'that username is already taken' });
        send(res, 200, reply());
      });
      return true;
    }
    const m = url.pathname.match(/^\/api\/users\/([^/]+)(\/(password|access))?$/);
    if (!m) return false;
    const target = decodeURIComponent(m[1]);
    const action = m[3];
    if (!isOwner && hasPanelCap(store.findUser(target), 'users')) { send(res, 403, { error: 'only the owner can change this account' }); return true; }
    if (req.method === 'DELETE' && !action) {
      if (!store.deleteMember(target)) return (send(res, 400, { error: 'cannot remove that account' }), true);
      send(res, 200, reply());
      return true;
    }
    if (req.method === 'POST' && action === 'password') {
      readJson(req, res, 1024, (data) => {
        const password = String(data.password || '');
        if (password.length < 8) return send(res, 400, { error: 'password must be at least 8 characters' });
        if (!store.setPassword(target, password)) return send(res, 400, { error: 'cannot change that account' });
        send(res, 200, reply());
      });
      return true;
    }
    if (req.method === 'POST' && action === 'access') {
      readJson(req, res, 8192, (data) => {
        if (!store.setSettings(target, limit(data))) return send(res, 400, { error: 'cannot change that account' });
        send(res, 200, reply());
      });
      return true;
    }
    return false;
  }

  return { handle };
}

module.exports = { createUsersApi };
