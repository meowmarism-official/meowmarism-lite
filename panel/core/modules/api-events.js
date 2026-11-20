// Events of the optional HTTP API: a small hub with a replay buffer, and the rules that turn status snapshots into events.

function createEventHub({ buffer = 200, now = Date.now } = {}) {
  let seq = 0;
  const recent = [];
  const subscribers = new Set();

  function publish(type, data = {}) {
    const event = { id: ++seq, at: now(), type, ...data };
    recent.push(event);
    if (recent.length > buffer) recent.shift();
    for (const fn of subscribers) { try { fn(event); } catch (_) {} }
    return event;
  }

  function subscribe(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }

  // Events after an id, for a client that reconnects with Last-Event-ID.
  const since = (id) => recent.filter((e) => e.id > Number(id || 0));

  return { publish, subscribe, since, size: () => subscribers.size };
}

// summary: { running, phase, crashAt, lagCount, lag: { delayMs, ticksBehind } }. The first call for an instance only sets the baseline.
function diffStatus(prev, next) {
  if (!prev) return [];
  const events = [];
  if (!prev.running && next.running) events.push({ type: 'server.starting' });
  if (next.running && next.phase === 'ready' && prev.phase !== 'ready') events.push({ type: 'server.ready' });
  if (next.running && next.phase === 'stopping' && prev.phase !== 'stopping') events.push({ type: 'server.stopping' });
  if (prev.running && !next.running) {
    if (next.crashAt && next.crashAt !== prev.crashAt) events.push({ type: 'server.crashed' });
    else events.push({ type: 'server.stopped' });
  }
  if ((next.lagCount || 0) > (prev.lagCount || 0) && next.lag) {
    events.push({ type: 'server.lag', delayMs: next.lag.delayMs, ticksBehind: next.lag.ticksBehind });
  }
  return events;
}

const EVENT_TYPES = ['server.starting', 'server.ready', 'server.stopping', 'server.stopped', 'server.crashed', 'server.lag'];

module.exports = { createEventHub, diffStatus, EVENT_TYPES };
