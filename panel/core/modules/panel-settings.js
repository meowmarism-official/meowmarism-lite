// Panel-wide settings and reverse-proxy awareness: client IPs and HTTPS detection behind a trusted proxy.
const fs = require('fs');

// file: JSON settings path; env: environment variable that forces proxy trust ('1')
function createPanelSettings({ file, env = 'MEOWMARISM_TRUST_PROXY' }) {
  let cache = null;

  function load() {
    if (!cache) {
      let saved = {};
      try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
      cache = { trustProxy: saved.trustProxy === true };
    }
    return { ...cache };
  }

  function save(next) {
    cache = { trustProxy: next.trustProxy === true };
    try { fs.writeFileSync(file, JSON.stringify(cache, null, 2), { mode: 0o600 }); } catch (_) {}
  }

  const trustProxy = () => process.env[env] === '1' || load().trustProxy;

  function clientIp(req) {
    if (trustProxy()) {
      const parts = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
    return req.socket.remoteAddress || 'unknown';
  }

  function isHttps(req) {
    return !!req.socket.encrypted || (trustProxy() && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');
  }

  return { load, save, trustProxy, clientIp, isHttps };
}

module.exports = { createPanelSettings };
