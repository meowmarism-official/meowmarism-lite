// Start and stop order between instances: an instance can need other instances to be running.
// Dependencies start first and stop last.

// Groups names into layers: every name comes after the names it needs. A cycle puts what is left into one layer.
function startLayers(names, needsOf) {
  const set = new Set(names);
  const needs = new Map(names.map((n) => [n, (needsOf(n) || []).filter((d) => set.has(d) && d !== n)]));
  const layers = [];
  const done = new Set();
  let left = [...names];
  while (left.length) {
    let layer = left.filter((n) => needs.get(n).every((d) => done.has(d)));
    if (!layer.length) layer = left;
    layers.push(layer);
    layer.forEach((n) => done.add(n));
    left = left.filter((n) => !done.has(n));
  }
  return layers;
}

// Would `name` needing `list` create a loop? needsOf gives the current needs of every instance.
function makesCycle(name, list, needsOf) {
  const seen = new Set();
  const walk = (n) => {
    if (n === name) return true;
    if (seen.has(n)) return false;
    seen.add(n);
    return (needsOf(n) || []).some(walk);
  };
  return list.some(walk);
}

// Stops names so that what others need stops last: dependents go first and a layer is down before the next is asked.
// io: { stop(name), running() -> names still running, deadline (ms timestamp), sleep(ms) }
async function stopInOrder(names, needsOf, io) {
  for (const layer of startLayers(names, needsOf).reverse()) {
    for (const name of layer) await io.stop(name);
    while (Date.now() < io.deadline) {
      const still = await io.running();
      if (!layer.some((n) => still.includes(n))) break;
      await io.sleep(1500);
    }
  }
}

// Starts names so that what others need is up first; every layer but the last must be ready before the next one starts.
// io: { start(name), ready(names) -> Promise that ends when they are ready or too late }
async function startInOrder(names, needsOf, io) {
  const layers = startLayers(names, needsOf);
  for (let i = 0; i < layers.length; i++) {
    for (const name of layers[i]) io.start(name);
    if (i < layers.length - 1) await io.ready(layers[i]);
  }
}

module.exports = { startLayers, makesCycle, stopInOrder, startInOrder };
