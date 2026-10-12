const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createProperties } = require('../panel/core/modules/properties');

function setup(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'props-'));
  const file = path.join(dir, 'server.properties');
  fs.writeFileSync(file, text);
  return { file, props: createProperties({ file, isRunning: () => false, command: () => {} }) };
}

test('an escaped colon in the MOTD is shown without the backslash', () => {
  const { props } = setup('motd=hosted by meowmarism \\:3\n');
  assert.strictEqual(props.state().values.motd, 'hosted by meowmarism :3');
});

test('saving the MOTD writes the Java-escaped form and reads back unchanged', () => {
  const { file, props } = setup('motd=old\nserver-port=25566\n');
  props.apply({ motd: 'hosted by meowmarism :3' });
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^motd=hosted by meowmarism \\:3$/m);
  assert.match(text, /^server-port=25566$/m);
  assert.strictEqual(props.state().values.motd, 'hosted by meowmarism :3');
});

test('unicode and backslashes survive a round trip', () => {
  const { props } = setup('motd=x\n');
  props.apply({ motd: 'Käse \\o/ = #1' });
  assert.strictEqual(props.state().values.motd, 'Käse \\o/ = #1');
});
