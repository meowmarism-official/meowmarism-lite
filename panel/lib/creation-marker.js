// A marker file while an instance is being built, so a crash during the build shows up as a failure afterwards.
const fs = require('fs');
const path = require('path');

const FILE = '.creating-instance.json';

const markerPath = (dataRoot) => path.join(dataRoot, FILE);

function begin(dataRoot, name) {
  try {
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(markerPath(dataRoot), JSON.stringify({ name, startedAt: Date.now() }));
  } catch (_) { /* the build still runs, only the crash note is lost */ }
}

function end(dataRoot) {
  try { fs.unlinkSync(markerPath(dataRoot)); } catch (_) {}
}

// Returns a finished build log with an error when the last build never ended, and removes the marker.
function interrupted(dataRoot) {
  let saved;
  try { saved = JSON.parse(fs.readFileSync(markerPath(dataRoot), 'utf8')); } catch (_) { return null; }
  end(dataRoot);
  return {
    name: saved.name || null, startedAt: saved.startedAt || null, lines: [], important: [], progress: 0, done: true, interrupted: true,
    error: 'the panel stopped while this instance was being built, nothing was created',
  };
}

module.exports = { begin, end, interrupted };
