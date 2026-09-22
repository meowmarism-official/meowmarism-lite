// Loads the real panel in a real browser and looks for what the Node tests cannot see: script errors and values that never arrive.
// Skipped when puppeteer-core or Chrome is missing (npm ci --prefix test/browser installs the first, CI has the second).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const harness = require('../../test-support/harness');

let puppeteer = null;
try { puppeteer = require('puppeteer-core'); } catch (_) {}
const CHROME = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', 'C:/Program Files/Google/Chrome/Application/chrome.exe']
  .find((p) => p && fs.existsSync(p));
const opts = { skip: puppeteer && CHROME ? false : 'needs puppeteer-core (npm ci --prefix test/browser) and Chrome' };

let h;
let browser;
let page;
let problems;

const numberLike = /^\d+(\.\d+)?%$/;
const text = (selector) => page.$eval(selector, (el) => el.textContent.trim());
const waitFor = (fn, arg, timeout = 15000) => page.waitForFunction(fn, { timeout }, arg);

test('open the panel and the instance page in a browser', opts, async () => {
  h = await harness.start();
  const cookie = await h.login();
  browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  page = await browser.newPage();
  await page.setViewport({ width: 1300, height: 900 });
  problems = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => { if (msg.type() === 'error') problems.push(`console: ${msg.text()}`); });
  page.on('dialog', (dialog) => { problems.push(`native dialog: ${dialog.message()}`); dialog.dismiss(); });
  const [name, value] = cookie.split('=');
  await page.setCookie({ name, value, url: h.base });

  await page.goto(`${h.base}/server`, { waitUntil: 'networkidle2' });
  await waitFor(() => /^v\d/.test((document.getElementById('sideVersion') || {}).textContent || ''));
  assert.match(await text('#sideVersion'), /^v\d+\.\d+/, 'the panel shows its version');

  await h.workerReady();
  await page.goto(`${h.base}/instance/inst1/overview`, { waitUntil: 'networkidle2' });
  assert.ok(await page.$eval('#shellSidebar', (el) => el.getBoundingClientRect().width > 30), 'the sidebar is visible');
});

test('with the server stopped, CPU and RAM show real values instead of placeholders', opts, async () => {
  await waitFor(() => /^\d+(\.\d+)?%$/.test(document.getElementById('overviewCpu').textContent.trim()));
  await waitFor(() => /^\d+(\.\d+)?%$/.test(document.getElementById('overviewRam').textContent.trim()));
  assert.match(await text('#overviewCpu'), numberLike);
  assert.match(await text('#overviewRam'), numberLike);
  assert.notEqual(await text('#overviewLoad'), 'sampling…');
});

test('the Performance page has its values, and they are still there after coming back', opts, async () => {
  await page.click('[data-page="performance"]');
  await waitFor(() => document.getElementById('page-performance').classList.contains('active'));
  await waitFor(() => /^\d+(\.\d+)?%$/.test(document.getElementById('perfCpu').textContent.trim()));
  assert.match(await text('#perfCpu'), numberLike);
  assert.match(await text('#perfCores'), /^\d+ cores$/);
  assert.match(await text('#perfRam'), numberLike);
  await page.click('[data-page="overview"]');
  await waitFor(() => document.getElementById('page-overview').classList.contains('active'));
  assert.match(await text('#overviewCpu'), numberLike);
});

test('navigating to Players and Manage works', opts, async () => {
  for (const id of ['players', 'manage', 'console', 'events']) {
    await page.click(`[data-page="${id}"]`);
    await waitFor((x) => document.getElementById(`page-${x}`).classList.contains('active'), id);
    assert.equal(await page.evaluate(() => location.pathname.split('/').pop()), id, `the address shows ${id}`);
  }
});

test('the Update page shows the panel version and the core version', opts, async () => {
  await page.goto(`${h.base}/update`, { waitUntil: 'networkidle2' });
  const core = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'panel', 'core', 'core.json'), 'utf8'));
  await waitFor((expected) => (document.getElementById('upd-core') || {}).textContent === expected, `v${core.version}`);
  assert.match(await text('#upd-current'), /^v\d/);
  assert.equal(await text('#upd-core-commit'), `commit ${core.commit.slice(0, 8)}`);
});

test('nothing went wrong in the browser', opts, async () => {
  assert.deepEqual(problems, [], problems.join('\n'));
});

// A separate, self-contained instance: the installed product is already the latest, but a newer compatible
// core exists. The UI must still say "update available" and show the core as the thing that changed.
test('a core-only update is offered when only the core is behind, even though the product is current', opts, async () => {
  const HOOKS = path.join(__dirname, '..', '..', 'test-support', 'modpack-hooks.js');
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')).version;
  const core = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'panel', 'core', 'core.json'), 'utf8'));
  const update = { releaseTag: `v${pkgVersion}`, publishedAt: '2026-01-01T00:00:00Z', core: { version: '9.9.9', commit: 'f'.repeat(40) }, branchProductVersion: pkgVersion };
  const h2 = await harness.start({ hooks: HOOKS, env: { MEOW_TEST_UPDATE: JSON.stringify(update) } });
  const cookie = await h2.login();
  const b2 = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const p2 = await b2.newPage();
    const [name, value] = cookie.split('=');
    await p2.setCookie({ name, value, url: h2.base });
    await p2.goto(`${h2.base}/server`, { waitUntil: 'networkidle2' });
    await p2.waitForFunction(() => document.getElementById('updatePill') && document.getElementById('updatePill').style.display !== 'none', { timeout: 15000 });
    await p2.goto(`${h2.base}/update`, { waitUntil: 'networkidle2' });
    await p2.waitForFunction((v) => new RegExp(`^v${v}`).test((document.getElementById('upd-current') || {}).textContent || ''), { timeout: 15000 }, pkgVersion.replace(/\./g, '\\.'));
    assert.match(await p2.$eval('#upd-current', (el) => el.textContent), new RegExp(`^v${pkgVersion.replace(/\./g, '\\.')}`), 'the product itself is already current');
    const diffs = await p2.$eval('#upd-diffs', (el) => el.textContent);
    assert.match(diffs, /9\.9\.9/, 'the update page names the newer core version');
    assert.match(diffs, new RegExp(core.version.replace('.', '\\.')), 'and the currently installed core version');
    assert.equal(await p2.$eval('#upd-uptodate', (el) => el.style.display), 'none');
    assert.equal(await p2.$eval('#upd-now', (el) => el.style.display), '', 'the single Update now button is offered');
  } finally {
    await b2.close();
    await h2.stop();
  }
});

test('shut down', async () => {
  if (browser) await browser.close();
  if (h) await h.stop();
});
