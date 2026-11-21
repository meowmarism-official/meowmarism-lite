// Velocity proxy support: surgical edits of velocity.toml and of the files of servers behind the proxy.
const crypto = require('crypto');

const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const HOST_RE = /^[A-Za-z0-9.-]{1,253}$/;
const quoteKey = (key) => (BARE_KEY.test(key) ? key : JSON.stringify(key));
const newlineOf = (text) => (text.includes('\r\n') ? '\r\n' : '\n');

// Index range of a [section] body: after its header line up to the next header or the end.
function sectionRange(text, name) {
  const header = new RegExp(`^\\[${name.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}\\][ \\t]*\\r?$`, 'm').exec(text);
  if (!header) return null;
  const start = header.index + header[0].length;
  const next = /^\[/m.exec(text.slice(start));
  return { header: header.index, start, end: next ? start + next.index : text.length };
}

function topEnd(text) {
  const first = /^\[/m.exec(text);
  return first ? first.index : text.length;
}

function readTop(text, key) {
  const top = text.slice(0, topEnd(text));
  const m = new RegExp(`^${key}[ \\t]*=[ \\t]*(.*?)[ \\t]*\\r?$`, 'm').exec(top);
  return m ? m[1] : null;
}

function setTop(text, key, literal) {
  const end = topEnd(text);
  const top = text.slice(0, end);
  const nl = newlineOf(text);
  const line = new RegExp(`^${key}[ \\t]*=.*$`, 'm');
  if (line.test(top)) return top.replace(line, `${key} = ${literal}`) + text.slice(end);
  const lead = top && !/\n$/.test(top) ? top + nl : top;
  return `${lead}${key} = ${literal}${nl}${text.slice(end)}`;
}

const readString = (literal) => { try { return JSON.parse(literal); } catch (_) { return null; } };

function readBindPort(text) {
  const value = readString(readTop(text, 'bind') || '');
  const m = /:(\d{1,5})$/.exec(value || '');
  return m ? Number(m[1]) : null;
}

function withBindPort(text, port) {
  const host = /^(.*):\d+$/.exec(readString(readTop(text, 'bind') || '') || '');
  return setTop(text, 'bind', JSON.stringify(`${host ? host[1] : '0.0.0.0'}:${port}`));
}

const withForwardingMode = (text, mode) => setTop(text, 'player-info-forwarding-mode', JSON.stringify(mode));
const readForwardingMode = (text) => readString(readTop(text, 'player-info-forwarding-mode') || '');

function replaceSection(text, name, body) {
  const nl = newlineOf(text);
  const block = `[${name}]${nl}${body}${nl}`;
  const range = sectionRange(text, name);
  if (!range) return `${text.replace(/\s*$/, '')}${nl}${nl}${block}`;
  return `${text.slice(0, range.header)}${block}${nl}${text.slice(range.end).replace(/^\s+/, '')}`;
}

// servers: [{ name, host, port }], tryOrder: names the proxy sends joining players to in order.
function withServers(text, servers, tryOrder) {
  for (const s of servers) {
    if (!BARE_KEY.test(s.name)) throw new Error(`invalid server name ${s.name}`);
    if (!HOST_RE.test(s.host) || !Number.isInteger(s.port) || s.port < 1 || s.port > 65535) throw new Error(`invalid address for ${s.name}`);
  }
  const names = new Set(servers.map((s) => s.name));
  const order = tryOrder.filter((n) => names.has(n));
  const body = [
    ...servers.map((s) => `${quoteKey(s.name)} = ${JSON.stringify(`${s.host}:${s.port}`)}`),
    '',
    `try = [${order.map((n) => `${nl()}    ${JSON.stringify(n)}`).join(',')}${order.length ? nl() : ''}]`,
  ].join(newlineOf(text));
  return replaceSection(text, 'servers', body);
  function nl() { return newlineOf(text); }
}

// hosts: { 'play.example.com': ['lobby'] }; entries naming an unknown server are dropped.
function withForcedHosts(text, hosts, serverNames) {
  const known = new Set(serverNames);
  const lines = [];
  for (const [host, targets] of Object.entries(hosts || {})) {
    if (!HOST_RE.test(host)) throw new Error(`invalid host name ${host}`);
    const kept = targets.filter((n) => known.has(n));
    if (kept.length) lines.push(`${JSON.stringify(host)} = [${kept.map((n) => JSON.stringify(n)).join(', ')}]`);
  }
  return replaceSection(text, 'forced-hosts', lines.join(newlineOf(text)));
}

function readServers(text) {
  const range = sectionRange(text, 'servers');
  if (!range) return { servers: [], tryOrder: [] };
  const body = text.slice(range.start, range.end);
  const servers = [];
  for (const m of body.matchAll(/^[ \t]*("(?:[^"\\]|\\.)*"|[A-Za-z0-9_-]+)[ \t]*=[ \t]*"([^"]*)"[ \t]*\r?$/gm)) {
    const name = m[1].startsWith('"') ? readString(m[1]) : m[1];
    const addr = /^(.*):(\d+)$/.exec(m[2]);
    if (name !== 'try' && addr) servers.push({ name, host: addr[1], port: Number(addr[2]) });
  }
  const tryMatch = /^[ \t]*try[ \t]*=[ \t]*\[([^\]]*)\]/m.exec(body);
  const tryOrder = tryMatch ? [...tryMatch[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]) : [];
  return { servers, tryOrder };
}

const newSecret = () => crypto.randomBytes(9).toString('base64url');

// Paper and Purpur: config/paper-global.yml, block proxies.velocity.
function withPaperVelocity(yaml, { secret, enabled = true }) {
  const nl = newlineOf(yaml);
  const lines = yaml.split(/\r?\n/);
  const proxies = lines.findIndex((l) => /^proxies:\s*$/.test(l));
  if (proxies === -1) return null;
  let end = lines.length;
  for (let i = proxies + 1; i < lines.length; i++) if (/^\S/.test(lines[i])) { end = i; break; }
  const velocity = lines.findIndex((l, i) => i > proxies && i < end && /^ {2}velocity:\s*$/.test(l));
  if (velocity === -1) return null;
  let blockEnd = end;
  for (let i = velocity + 1; i < end; i++) if (/^ {0,2}\S/.test(lines[i])) { blockEnd = i; break; }
  const wanted = { enabled: String(enabled), 'online-mode': 'true', secret: JSON.stringify(secret) };
  const seen = new Set();
  for (let i = velocity + 1; i < blockEnd; i++) {
    const m = /^( {4})([a-z-]+):/.exec(lines[i]);
    if (m && wanted[m[2]] !== undefined) { lines[i] = `${m[1]}${m[2]}: ${wanted[m[2]]}`; seen.add(m[2]); }
  }
  const missing = Object.keys(wanted).filter((k) => !seen.has(k)).map((k) => `    ${k}: ${wanted[k]}`);
  lines.splice(velocity + 1, 0, ...missing);
  return lines.join(nl);
}

function readPaperVelocity(yaml) {
  const lines = yaml.split(/\r?\n/);
  const proxies = lines.findIndex((l) => /^proxies:\s*$/.test(l));
  if (proxies === -1) return null;
  const out = { enabled: false, secret: '' };
  let inside = false;
  for (let i = proxies + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break;
    if (/^ {2}velocity:\s*$/.test(lines[i])) { inside = true; continue; }
    if (inside && /^ {0,2}\S/.test(lines[i])) break;
    const m = inside && /^ {4}(enabled|secret):\s*(.*?)\s*$/.exec(lines[i]);
    if (m) out[m[1]] = m[1] === 'enabled' ? m[2] === 'true' : String(readString(m[2].replace(/^'(.*)'$/, '"$1"')) ?? m[2]);
  }
  return out;
}

// server.properties of a server behind the proxy: the proxy authenticates players and the server listens locally only.
function withBackendProperties(text, { behind }) {
  const set = (t, key, value) => {
    const re = new RegExp(`^${key}=.*$`, 'm');
    return re.test(t) ? t.replace(re, `${key}=${value}`) : `${t ? t.replace(/\r?\n?$/, '\n') : ''}${key}=${value}\n`;
  };
  let out = set(text, 'online-mode', behind ? 'false' : 'true');
  out = set(out, 'server-ip', behind ? '127.0.0.1' : '');
  return out;
}

module.exports = {
  readBindPort, withBindPort, withForwardingMode, readForwardingMode, withServers, withForcedHosts, readServers,
  newSecret, withPaperVelocity, readPaperVelocity, withBackendProperties,
};
