// The create dialog in a real browser, with Modrinth replaced by fixtures: source choice, modpack picker, conditional steps.
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
const HOOKS = path.join(__dirname, '..', '..', 'test-support', 'modpack-hooks.js');

let h, browser, page, problems;
const waitFor = (fn, arg) => page.waitForFunction(fn, { timeout: 15000 }, arg);
const visible = (id) => page.$eval(`#${id}`, (el) => el.style.display !== 'none');
const dots = () => page.$$eval('.wizard .steps span', (els) => els.filter((e) => e.style.display !== 'none').length);
const text = (sel) => page.$eval(sel, (el) => el.textContent.trim());

async function open(env) {
  h = await harness.start({ hooks: HOOKS, env });
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
  await waitFor(() => document.getElementById('openWizard').style.display !== 'none');
  await page.click('#openWizard');
}
async function close() {
  if (browser) await browser.close();
  if (h) await h.stop();
  browser = h = null;
}

test('the dialog starts at the source choice and the blank server flow is intact', opts, async () => {
  await open({});
  await waitFor(() => document.querySelector('#w-source .source-card'));
  assert.ok(await visible('step1'));
  await page.click('#w-next1');
  assert.ok(await visible('step2'), 'Blank server is the default and leads to the blank step');
  await page.click('#w-back2');
  assert.ok(await visible('step1'));
  assert.deepEqual(problems, []);
  await close();
});

test('the modpack flow: source, search, unsupported Quilt, version summary, memory handed on', opts, async () => {
  await open({});
  await waitFor(() => document.querySelector('#w-source .source-card'));
  assert.ok(await visible('step1'));
  assert.equal(await dots(), 4, 'source, blank, resources, backups');

  await page.click('[data-mode="modpack"]');
  assert.equal(await dots(), 4, 'source, modpack, resources, backups');
  await page.click('#w-next1');
  await waitFor(() => document.querySelectorAll('.mp-card').length === 2);
  assert.ok(await visible('step3'));

  await page.click('.mp-card[data-id="pq"]');
  await waitFor(() => document.querySelector('.mp-summary'));
  assert.match(await text('.mp-summary'), /cannot run|can run on this edition|None of/i);
  assert.match(await text('#mp-version'), /Quilt.*not supported here/);
  await page.click('.mp-back');

  await page.click('.mp-card[data-id="p1"]');
  await waitFor(() => document.querySelector('#mp-ram'));
  const facts = await text('.mp-facts');
  assert.match(facts, /1\.21\.1/);
  assert.match(facts, /NeoForge 21\.1\.5/);
  assert.match(facts, /Mods\s*2/);
  assert.equal(await page.$eval('#mp-ram', (el) => el.value), '3072');
  assert.equal(await page.$eval('#mp-name', (el) => el.value), 'test-pack');
  assert.match(await text('.mp-summary'), /1 files are ignored|ignored because Meowmarism manages them/);

  await page.$eval('#mp-ram', (el) => { el.value = '4096'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.click('#w-next3');
  await waitFor(() => document.getElementById('step4').style.display !== 'none');
  assert.equal(await page.$eval('#w-ram', (el) => el.value), '4096', 'the chosen memory reaches the resources step');

  await page.click('#w-back4');
  assert.ok(await visible('step3'), 'back skips the blank server step');
  await page.click('#w-back3');
  assert.ok(await visible('step1'));
  await page.click('[data-mode="blank"]');
  await page.click('#w-next1');
  assert.ok(await visible('step2'), 'the blank flow is intact');
  assert.deepEqual(problems, []);
  await close();
});

test('creating from a modpack in the browser, through the phases to Ready and into the instance page', opts, async () => {
  await open({});
  page.on('response', (res) => { if (res.status() === 404) problems.push(`404: ${res.url()}`); });
  const hold = path.join(h.home, '.hold-create');
  fs.writeFileSync(hold, '');
  const instancesRoot = path.join(h.home, 'meowmarism', 'instances');
  const listed = async () => (await (await fetch(`${h.base}/api/instances`, { headers: { Cookie: await cookieHeader() } })).json()).instances.map((i) => i.name);
  const cookieHeader = async () => (await page.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');

  await waitFor(() => document.querySelector('#w-source .source-card'));
  await page.click('[data-mode="modpack"]');
  await page.click('#w-next1');
  await waitFor(() => document.querySelectorAll('.mp-card').length === 2);
  await page.click('.mp-card[data-id="p1"]');
  await waitFor(() => document.querySelector('#mp-ram'));
  await page.$eval('#mp-ram', (el) => { el.value = '4096'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.$eval('#mp-name', (el) => { el.value = 'e2epack'; });
  await page.click('#w-next3');
  await waitFor(() => document.getElementById('step4').style.display !== 'none');
  await page.$eval('#w-port', (el) => { el.value = '25610'; });
  await page.click('#w-next4');
  await waitFor(() => document.getElementById('step5').style.display !== 'none');
  await page.click('#w-create');

  await waitFor(() => document.getElementById('step6').style.display !== 'none');
  await waitFor(() => document.getElementById('creatingHint').textContent.includes('Installing NeoForge'));
  assert.ok(!(await listed()).includes('e2epack'), 'not listed while installing');
  assert.ok(!fs.existsSync(path.join(instancesRoot, 'e2epack')), 'no final folder while installing');
  assert.ok(fs.existsSync(path.join(instancesRoot, 'e2epack.creating')), 'work happens in the staging folder');

  fs.rmSync(hold);
  await waitFor(() => document.getElementById('creatingTitle').textContent.includes('is ready'));
  assert.ok(await page.$eval('#creatingOpen', (el) => el.style.display !== 'none'), 'the open button is offered');
  assert.ok((await listed()).includes('e2epack'));
  assert.ok(!fs.existsSync(path.join(instancesRoot, 'e2epack.creating')));
  const entry = JSON.parse(fs.readFileSync(path.join(h.home, '.meowmarism-instances.json'), 'utf8')).find((i) => i.name === 'e2epack');
  assert.deepEqual([entry.ramMB, entry.loader, entry.mcVersion, entry.loaderVersion, entry.port], [4096, 'neoforge', '1.21.1', '21.1.5', 25610]);
  assert.match(fs.readFileSync(path.join(instancesRoot, 'e2epack', 'server.properties'), 'utf8'), /^server-port=25610$/m);

  await h.workerReady('e2epack');
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2' }), page.click('#creatingOpen')]);
  await waitFor(() => document.getElementById('page-overview').classList.contains('active'));
  assert.ok(await page.$eval('#shellSidebar', (el) => el.getBoundingClientRect().width > 30), 'the new instance page renders');
  assert.deepEqual(problems, []);
  await close();
});
