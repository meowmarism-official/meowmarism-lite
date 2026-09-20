// Time series of numeric samples: raw points for the last hour plus one-minute averages for a week, persisted to a JSON file.
const fs = require('fs');
const path = require('path');

const RAW_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * MINUTE_MS;

// keys: numeric fields of a sample; file: optional persistence path
function createMetrics({ keys, file }) {
  let raw = [];
  let minutes = [];
  let bucket = null;

  function load() {
    if (!file) return;
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(saved.raw)) raw = saved.raw;
      if (Array.isArray(saved.minutes)) minutes = saved.minutes;
    } catch (_) {}
  }

  function save() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ raw, minutes }));
      fs.renameSync(tmp, file);
    } catch (_) {}
  }

  function flushBucket() {
    if (!bucket || !bucket.n) return;
    const p = { t: bucket.t };
    for (const k of keys) p[k] = bucket.sum[k] / bucket.n;
    minutes.push(p);
    bucket = null;
  }

  function add(sample, now = Date.now()) {
    const p = { t: now };
    for (const k of keys) p[k] = Number(sample[k]) || 0;
    raw.push(p);
    while (raw.length && raw[0].t < now - RAW_MS) raw.shift();
    const start = Math.floor(now / MINUTE_MS) * MINUTE_MS;
    if (bucket && bucket.t !== start) flushBucket();
    if (!bucket) bucket = { t: start, n: 0, sum: Object.fromEntries(keys.map((k) => [k, 0])) };
    bucket.n++;
    for (const k of keys) bucket.sum[k] += p[k];
    while (minutes.length && minutes[0].t < now - WEEK_MS) minutes.shift();
  }

  // Points within the last rangeMs, averaged down to at most maxPoints.
  function series(rangeMs, maxPoints = 240, now = Date.now()) {
    const src = rangeMs <= RAW_MS ? raw : minutes;
    const from = now - rangeMs;
    const pts = src.filter((p) => p.t >= from);
    if (pts.length <= maxPoints) return pts;
    const size = Math.ceil(pts.length / maxPoints);
    const out = [];
    for (let i = 0; i < pts.length; i += size) {
      const chunk = pts.slice(i, i + size);
      const p = { t: chunk[Math.floor(chunk.length / 2)].t };
      for (const k of keys) p[k] = chunk.reduce((a, x) => a + x[k], 0) / chunk.length;
      out.push(p);
    }
    return out;
  }

  load();
  return { add, series, save, flush: flushBucket };
}

module.exports = { createMetrics };
