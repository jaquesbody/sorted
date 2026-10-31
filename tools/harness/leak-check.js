// Proves the teardown holds on the paths that used to leak: a thrown error, and
// a process.exit() with a session still open. Both used to leave a headless
// browser behind, and a few hundred of those filled both swap devices.
const { withDriver } = require('./driver');

const mode = process.argv[2];
const caps = { capabilities: { alwaysMatch: { browserName: 'chrome',
  'goog:chromeOptions': { binary: '/usr/bin/chromium',
    args: ['--headless=new', '--no-sandbox', '--disable-gpu', '--window-size=412,915'] } } } };

withDriver(async ({ base, driver }) => {
  // See test.js: the port is not accepting the moment the driver is spawned.
  await driver.ready;
  const res = await fetch(`${base}/session`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(caps) });
  const sid = (await res.json()).value.sessionId;
  // Prove a browser really is up before we abandon it.
  await fetch(`${base}/session/${sid}/url`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'http://127.0.0.1:8141/index.html' }) });
  console.log(`  session ${sid} open`);
  if (mode === 'throw') throw new Error('deliberate failure with a session open');
  if (mode === 'exit') { console.log('  hard exit with a session open'); process.exit(1); }
  await fetch(`${base}/session/${sid}`, { method: 'DELETE' });
}).catch((e) => { console.error('  caught:', e.message); process.exit(1); })
  .finally(() => { console.log('  teardown finished'); });
