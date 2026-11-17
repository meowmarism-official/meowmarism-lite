const test = require('node:test');
const assert = require('node:assert');
const { createStopWatchdog } = require('../panel/runtime/stop-watchdog');

// Manual clock: timers fire only when advance() passes their time.
function rig({ alive = true, pid = 4242 } = {}) {
  let clock = 0;
  const timers = [];
  const state = { alive, pid, signals: [], notices: [] };
  const wd = createStopWatchdog({
    getPid: () => state.pid,
    isAlive: () => state.alive,
    signal: (p, name) => { state.signals.push([p, name]); },
    notice: (text) => state.notices.push(text),
    now: () => clock,
    setTimer: (fn, ms) => { const t = { fn, at: clock + ms, live: true }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) t.live = false; },
    termGraceMs: 15000,
  });
  function advance(ms) {
    const target = clock + ms;
    for (;;) {
      const due = timers.filter((t) => t.live && t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      clock = due.at;
      due.live = false;
      due.fn();
    }
    clock = target;
  }
  return { wd, state, advance };
}

test('a process that exits on its own is never signalled', () => {
  const r = rig();
  r.wd.arm(30000);
  r.state.alive = false;
  r.advance(31000);
  assert.deepStrictEqual(r.state.signals, []);
  assert.strictEqual(r.wd.isArmed(), false);
});

test('a process that outlives the deadline gets SIGTERM, then SIGKILL after the grace period', () => {
  const r = rig();
  r.wd.arm(30000);
  r.advance(29000);
  assert.deepStrictEqual(r.state.signals, []);
  r.advance(2000);
  assert.deepStrictEqual(r.state.signals, [[4242, 'SIGTERM']]);
  r.advance(13000);
  assert.deepStrictEqual(r.state.signals, [[4242, 'SIGTERM']]);
  r.advance(2000);
  assert.deepStrictEqual(r.state.signals, [[4242, 'SIGTERM'], [4242, 'SIGKILL']]);
  assert.strictEqual(r.wd.isArmed(), false);
});

test('SIGTERM is enough when the process then exits', () => {
  const r = rig();
  r.wd.arm(1000);
  r.advance(1500);
  r.state.alive = false;
  r.advance(20000);
  assert.deepStrictEqual(r.state.signals, [[4242, 'SIGTERM']]);
});

test('the earlier deadline wins, a later request does not postpone it', () => {
  const r = rig();
  r.wd.arm(120000);
  r.wd.arm(20000);
  r.advance(21000);
  assert.deepStrictEqual(r.state.signals, [[4242, 'SIGTERM']]);
  const r2 = rig();
  r2.wd.arm(20000);
  r2.wd.arm(120000);
  r2.advance(21000);
  assert.deepStrictEqual(r2.state.signals, [[4242, 'SIGTERM']]);
});

test('disarm cancels everything, and a missing pid signals nothing', () => {
  const r = rig();
  r.wd.arm(1000);
  r.wd.disarm();
  r.advance(60000);
  assert.deepStrictEqual(r.state.signals, []);
  const r2 = rig({ pid: null });
  r2.wd.arm(1000);
  r2.advance(5000);
  assert.deepStrictEqual(r2.state.signals, []);
});

test('the log tells what was done', () => {
  const r = rig();
  r.wd.arm(1000);
  r.advance(1000);
  r.advance(15000);
  assert.strictEqual(r.state.notices.length, 2);
  assert.match(r.state.notices[0], /SIGTERM/);
  assert.match(r.state.notices[1], /SIGKILL/);
});
