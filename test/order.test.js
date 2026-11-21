const test = require('node:test');
const assert = require('node:assert');
const { startLayers, makesCycle, stopInOrder, startInOrder } = require('../panel/lib/order');

const needs = (map) => (n) => map[n] || [];

test('dependencies come in earlier layers, independent instances share the first', () => {
  const layers = startLayers(['Proxy', 'Standby', 'Hub', 'Lobby'], needs({ Proxy: ['Standby', 'Hub'], Hub: ['Standby'] }));
  assert.deepStrictEqual(layers, [['Standby', 'Lobby'], ['Hub'], ['Proxy']]);
});

test('stopping is the same layers the other way round', () => {
  const layers = startLayers(['Proxy', 'Standby'], needs({ Proxy: ['Standby'] })).reverse();
  assert.deepStrictEqual(layers, [['Proxy'], ['Standby']]);
});

test('needs that are not in the list are ignored, and self references too', () => {
  assert.deepStrictEqual(startLayers(['A', 'B'], needs({ A: ['Gone', 'A'], B: ['A'] })), [['A'], ['B']]);
  assert.deepStrictEqual(startLayers([], needs({})), []);
  assert.deepStrictEqual(startLayers(['A'], needs({})), [['A']]);
});

test('a loop does not hang, the rest goes together', () => {
  const layers = startLayers(['A', 'B', 'C'], needs({ A: ['B'], B: ['A'] }));
  assert.deepStrictEqual(layers, [['C'], ['A', 'B']]);
});

test('a new need that would close a loop is found, others are fine', () => {
  const map = { Proxy: ['Standby'], Standby: [] };
  assert.strictEqual(makesCycle('Standby', ['Proxy'], needs(map)), true);
  assert.strictEqual(makesCycle('Standby', ['Hub'], needs(map)), false);
  assert.strictEqual(makesCycle('A', ['A'], needs({})), true);
  assert.strictEqual(makesCycle('Hub', ['Proxy'], needs(map)), false);
});

test('a stop runs dependents first and waits for each layer to be down before the next', async () => {
  const up = new Set(['Proxy', 'Standby', 'Hub']);
  const events = [];
  await stopInOrder(['Standby', 'Proxy', 'Hub'], needs({ Proxy: ['Standby'], Hub: ['Standby'] }), {
    stop: (n) => { events.push(`stop ${n}`); setTimeout(() => { up.delete(n); events.push(`down ${n}`); }, 20); },
    running: async () => [...up],
    deadline: Date.now() + 5000,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 10))),
  });
  const at = (e) => events.indexOf(e);
  assert.ok(at('down Proxy') < at('stop Standby') && at('down Hub') < at('stop Standby'), events.join(', '));
  assert.strictEqual(up.size, 0);
});

test('a stop does not wait past its deadline', async () => {
  const started = Date.now();
  await stopInOrder(['A', 'B'], needs({ A: ['B'] }), { stop: () => {}, running: async () => ['A', 'B'], deadline: Date.now() + 100, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))) });
  assert.ok(Date.now() - started < 2000);
});

test('a start brings dependencies up and ready before their dependents', async () => {
  const events = [];
  await startInOrder(['Proxy', 'Standby', 'Lobby'], needs({ Proxy: ['Standby'] }), {
    start: (n) => events.push(`start ${n}`),
    ready: async (names) => { events.push(`ready ${names.join('+')}`); },
  });
  assert.deepStrictEqual(events, ['start Standby', 'start Lobby', 'ready Standby+Lobby', 'start Proxy']);
});
