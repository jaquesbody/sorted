// One place to talk to chromedriver, with the viewport pinned.
//
// --window-size sets the OS window, not the CSS viewport, so a headless window
// of 412 was laying out at 493 and every width measured here was a lie. The
// user's phone is 412 CSS px wide; that is what the layout has to survive, so
// the metrics override is the only honest measurement.
const { startDriver } = require('./driver');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WIDTH = 412;
const HEIGHT = 915;

// One driver per process, started on the first session() and killed when the
// process ends. It used to assume a chromedriver was already listening on a
// fixed port, which meant these probes could not run two at a time, could not
// run at all after a driver died, and left a browser behind on any path that
// did not reach close().
let driverPromise = null;
const driver = () => (driverPromise || (driverPromise = startDriver()));

// A probe that throws must still take its browser and driver with it, and
// probe scripts are one-liners that mostly do not have a finally.
let closed = false;
const shutdown = () => {
  if (closed) return;
  closed = true;
  const d = driverPromise;
  driverPromise = null;
  if (d) d.then((x) => x.stop()).catch(() => { /* exiting anyway */ });
};
process.on('exit', shutdown);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { shutdown(); process.exit(1); });
}

async function session() {
  const drv = await driver();
  // startDriver returns as soon as the child exists; the port is not accepting
  // yet. Without this the first POST races the driver coming up.
  await drv.ready;
  const base = drv.base;
  const caps = {
    capabilities: {
      alwaysMatch: {
        browserName: 'chrome',
        'goog:chromeOptions': {
          binary: '/usr/bin/chromium',
          args: ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
        },
      },
    },
  };
  const res = await fetch(`${base}/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(caps),
  });
  const id = (await res.json()).value.sessionId;

  const send = async (p, m, b) => {
    const r = await fetch(`${base}/session/${id}${p}`, {
      method: m,
      headers: { 'content-type': 'application/json' },
      body: b ? JSON.stringify(b) : undefined,
    });
    const j = await r.json();
    if (j.value && j.value.error) throw new Error(JSON.stringify(j.value).slice(0, 400));
    return j.value;
  };

  const run = (sc) =>
    send('/execute/sync', 'POST', { script: `return (async function(){ ${sc} })();`, args: [] });

  // Emulation is not a W3C endpoint; it goes through the CDP passthrough.
  const cdp = (cmd, params = {}) =>
    send('/goog/cdp/execute', 'POST', { cmd, params }).then((r) => r && r.result);

  await cdp('Emulation.clearDeviceMetricsOverride');
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: true });

  return {
    id,
    send,
    run,
    viewport: () =>
      run('return {w: window.innerWidth, h: window.innerHeight};'),
    open: async (base, q = '') => {
      await send('/url', 'POST', { url: `${base}?native&cb=${Date.now()}${q}` });
      await sleep(2400);
    },
    shot: async (file) => {
      const data = await send('/screenshot', 'GET');
      require('fs').writeFileSync(file, Buffer.from(data, 'base64'));
      return file;
    },
    close: async () => {
      try { await fetch(`${base}/session/${id}`, { method: 'DELETE' }); }
      catch (err) { /* the driver is going away anyway */ }
    },
    driver: drv,
  };
}

module.exports = { session, sleep, shutdown, WIDTH, HEIGHT };
