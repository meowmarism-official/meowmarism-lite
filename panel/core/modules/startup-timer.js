// Measures how long a server takes from the start request until it is ready, per key (an instance id or container name).
const STALE_MS = 10 * 60 * 1000;

function createStartupTimers() {
  const map = new Map();
  const get = (key) => {
    let t = map.get(key);
    if (!t) { t = { requestedAt: null, readyAt: null, startupMs: null }; map.set(key, t); }
    return t;
  };
  return {
    begin(key) {
      const t = get(key);
      t.requestedAt = Date.now();
      t.readyAt = null;
    },
    // Returns the startup time in ms; fallbackMs is used when no start request was seen (a start from outside the panel).
    ready(key, fallbackMs = null) {
      const t = get(key);
      if (t.readyAt) return t.startupMs;
      if (t.requestedAt && Date.now() - t.requestedAt > STALE_MS) t.requestedAt = null;
      t.readyAt = Date.now();
      t.startupMs = t.requestedAt ? t.readyAt - t.requestedAt : fallbackMs;
      t.requestedAt = null;
      return t.startupMs;
    },
    stopped(key) {
      const t = get(key);
      t.requestedAt = null;
      t.readyAt = null;
    },
    pending: (key) => get(key).requestedAt != null,
    info(key) {
      const t = get(key);
      return { readyAt: t.readyAt, startupMs: t.startupMs };
    },
    forget(key) { map.delete(key); },
  };
}

module.exports = { createStartupTimers };
