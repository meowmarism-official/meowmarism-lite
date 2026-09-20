// Online players and session history from console output, plus the console commands for player actions.
const NAME_RE = /^[A-Za-z0-9_]{1,16}$/;
const MODES = ['survival', 'creative', 'adventure', 'spectator'];

function playerName(value) {
  const name = String(value || '').trim();
  if (!NAME_RE.test(name)) throw new Error('invalid player name');
  return name;
}

function safeReason(value, fallback) {
  const reason = String(value || '').replace(/[\r\n]/g, ' ').trim().slice(0, 160);
  return reason || fallback;
}

function buildPlayerCommand(action, player, value, reason) {
  const name = playerName(player);
  switch (action) {
    case 'kick': return `kick ${name} ${safeReason(reason, 'Kicked by an operator')}`;
    case 'ban': return `ban ${name} ${safeReason(reason, 'Banned by an operator')}`;
    case 'op': return `op ${name}`;
    case 'deop': return `deop ${name}`;
    case 'whitelist-add': return `whitelist add ${name}`;
    case 'whitelist-remove': return `whitelist remove ${name}`;
    case 'pardon': return `pardon ${name}`;
    case 'kill': return `kill ${name}`;
    case 'clear-effects': return `effect clear ${name}`;
    case 'heal': return `effect give ${name} minecraft:instant_health 1 10 true`;
    case 'feed': return `effect give ${name} minecraft:saturation 1 10 true`;
    case 'gamemode': {
      const mode = String(value || '');
      if (!MODES.includes(mode)) throw new Error('invalid gamemode');
      return `gamemode ${mode} ${name}`;
    }
    default: throw new Error('unsupported player action');
  }
}

// hooks: { onJoin(name, source), onLeave(name, durationMs) } are called for log-detected changes only
function createPlayerTracker(hooks = {}) {
  const players = new Map();
  const history = new Map();

  function getHistory(name) {
    let h = history.get(name);
    if (!h) {
      h = { name, firstSeenAt: Date.now(), lastSeenAt: Date.now(), joins: 0, leaves: 0, totalPlayMs: 0, activeSince: null, sessions: [] };
      history.set(name, h);
    }
    return h;
  }

  function join(name, source = 'log', announce = true) {
    const now = Date.now();
    const h = getHistory(name);
    h.lastSeenAt = now;
    if (!h.activeSince) {
      h.activeSince = now;
      h.joins++;
      h.sessions.push({ joinedAt: now, leftAt: null, durationMs: null, source });
      if (h.sessions.length > 100) h.sessions.shift();
      if (announce && hooks.onJoin) hooks.onJoin(name, source);
    }
    return h;
  }

  function leave(name, source = 'log', announce = true) {
    const now = Date.now();
    const h = getHistory(name);
    h.lastSeenAt = now;
    if (h.activeSince) {
      const durationMs = Math.max(0, now - h.activeSince);
      h.totalPlayMs += durationMs;
      h.leaves++;
      const active = [...h.sessions].reverse().find((x) => x.leftAt == null);
      if (active) { active.leftAt = now; active.durationMs = durationMs; }
      h.activeSince = null;
      if (announce && hooks.onLeave) hooks.onLeave(name, durationMs);
    }
    return h;
  }

  function parseLine(line) {
    let match = line.match(/\]: ([A-Za-z0-9_]{1,16}) joined the game\s*$/);
    if (match) {
      const name = match[1];
      join(name, 'log', true);
      players.set(name, { name, joinedAt: getHistory(name).activeSince || Date.now(), lastSeenAt: Date.now(), source: 'log' });
      return;
    }
    match = line.match(/\]: ([A-Za-z0-9_]{1,16}) left the game\s*$/);
    if (match) {
      leave(match[1], 'log', true);
      players.delete(match[1]);
      return;
    }
    match = line.match(/There are\s+(\d+)\s+of a max of\s+(\d+)\s+players online:\s*(.*)$/i);
    if (match) {
      const names = match[3].split(',').map((n) => n.trim()).filter((n) => NAME_RE.test(n));
      const seen = new Set(names);
      for (const name of names) {
        const old = players.get(name);
        if (!old) join(name, 'list', false);
        players.set(name, { name, joinedAt: old?.joinedAt || getHistory(name).activeSince || Date.now(), lastSeenAt: Date.now(), source: 'list' });
      }
      for (const name of [...players.keys()]) {
        if (!seen.has(name)) { leave(name, 'list', false); players.delete(name); }
      }
    }
  }

  // Ends every open session and empties the online list, e.g. when the server stops.
  function reset(source = 'shutdown') {
    for (const name of [...players.keys()]) leave(name, source, false);
    players.clear();
  }

  function stats(maxPlayers = null) {
    const now = Date.now();
    const day = new Date(); day.setHours(0, 0, 0, 0);
    const histories = [...history.values()];
    const done = histories.flatMap((h) => h.sessions).filter((x) => Number.isFinite(Number(x.durationMs)));
    return {
      online: players.size,
      max: maxPlayers,
      uniqueToday: histories.filter((h) => h.lastSeenAt >= day.getTime()).length,
      averageSessionSec: done.length ? Math.round(done.reduce((a, x) => a + Number(x.durationMs), 0) / done.length / 1000) : 0,
      longestSessionSec: Math.round(Math.max(0, ...done.map((x) => Number(x.durationMs) || 0), ...histories.filter((h) => h.activeSince).map((h) => now - h.activeSince)) / 1000),
      knownPlayers: histories.length,
      list: [...players.values()].sort((a, b) => a.name.localeCompare(b.name)).map((p) => {
        const h = getHistory(p.name);
        return {
          name: p.name,
          joinedAt: p.joinedAt,
          sessionSec: Math.max(0, Math.floor((now - p.joinedAt) / 1000)),
          firstSeenAt: h.firstSeenAt,
          lastSeenAt: h.lastSeenAt,
          joins: h.joins,
          totalPlaySec: Math.floor((h.totalPlayMs + (h.activeSince ? now - h.activeSince : 0)) / 1000),
        };
      }),
    };
  }

  function detail(name) {
    const h = getHistory(playerName(name));
    return { ...h, totalPlaySec: Math.floor((h.totalPlayMs + (h.activeSince ? Date.now() - h.activeSince : 0)) / 1000), online: players.has(h.name) };
  }

  const snapshot = () => [...history.entries()];
  function restore(entries) {
    if (!Array.isArray(entries)) return;
    for (const [name, h] of entries) if (NAME_RE.test(name) && h && typeof h === 'object') history.set(name, { ...h, activeSince: null });
  }

  return { players, history, getHistory, join, leave, parseLine, reset, stats, detail, snapshot, restore };
}

module.exports = { createPlayerTracker, buildPlayerCommand, playerName };
