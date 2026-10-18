/*
 * Owns the chromedriver process for one test run.
 *
 * This exists because the harness used to assume a chromedriver was already
 * running on a fixed port, and that assumption leaked browsers:
 *
 *   - The session was deleted only on the success path. `main().catch(...)` and
 *     `process.exit()` both skipped it, so every failed or crashed run left a
 *     headless browser alive. A few hundred of those filled both swap devices
 *     and took the machine down.
 *   - The port was a shared singleton, so two concurrent runs meant the second
 *     failed to bind and leaked through the path above.
 *   - The driver was started from a shell with `&`, which orphaned it to PID 1
 *     with nothing left able to stop it.
 *
 * So: a random free port per run, chromedriver spawned as our own child rather
 * than inherited from a shell, and a teardown that runs whether the suite
 * passed, failed or threw. The browser session is closed first — that is what
 * makes chrome exit — and only then is the driver killed.
 *
 * A check runs before anything heavy starts, because the failure mode here is
 * invisible until it is catastrophic. It reports and refuses rather than killing
 * anything: a browser belonging to another process is not ours to reap.
 */

const { spawn } = require('node:child_process');
const net = require('node:net');

// More than this many leftover browsers means previous runs leaked and the
// machine is already in trouble. Adding another one is how it tips over.
const MAX_STALE_BROWSERS = 8;
// RSS of all chrome/chromedriver processes, in MiB.
const MAX_BROWSER_RSS_MB = 4096;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    // Port 0: the kernel hands us one nobody else is using, so two runs can
    // never collide on it.
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function sh(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => resolve(''));
    p.on('close', () => resolve(out));
  });
}

// What is already running, so a leak is visible before it becomes the problem.
async function preflight() {
  // `-x`, on the process name, and deliberately not `pgrep -f`. A full-command-line
  // match also matches OpenCode's own Electron crashpad handler, the user's Brave
  // browser, and any shell that merely mentions the word "chromium" — including
  // the one running this check. That reported a leak when there was none, and
  // would have refused a perfectly healthy run. The executable name is
  // unambiguous.
  const pids = (await sh('pgrep', ['-x', 'chromium'])).trim().split('\n')
    .map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n));
  const drivers = (await sh('pgrep', ['-x', 'chromedriver'])).trim().split('\n')
    .map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n));

  let rssKb = 0;
  if (pids.length) {
    const raw = await sh('ps', ['-o', 'rss=', '-p', pids.join(',')]);
    rssKb = raw.trim().split('\n')
      .map((l) => parseInt(l.trim(), 10))
      .filter((n) => Number.isFinite(n))
      .reduce((a, b) => a + b, 0);
  }
  const mem = await sh('free', ['-m']);
  const swapLine = (mem.split('\n').find((l) => /^Swap:/.test(l)) || '').trim().split(/\s+/);

  const report = {
    browsers: pids.length,
    drivers: drivers.length,
    rssMb: Math.round(rssKb / 1024),
    swapUsedMb: swapLine.length > 2 ? parseInt(swapLine[2], 10) : null
  };
  report.stale = report.browsers > MAX_STALE_BROWSERS || report.rssMb > MAX_BROWSER_RSS_MB;
  return report;
}

function describe(r) {
  return `${r.browsers} browser process(es), ${r.rssMb} MiB resident`
    + (r.swapUsedMb != null ? `, ${r.swapUsedMb} MiB of swap in use` : '');
}

async function startDriver() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;

  // detached:true gives the driver its own process group, so teardown can take
  // chrome with it in one signal rather than hoping chrome notices its parent
  // died. It is still our child, so we can still stop it — the thing that made
  // the old setup unrecoverable was a *shell* backgrounding it, which is not
  // what happens here.
  const child = spawn('chromedriver', [`--port=${port}`], {
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true
  });
  // Without this the child handle keeps the event loop referenced, so a script
  // that finishes its work never exits and has to be killed — which is the same
  // leak by another route. It is still ours: `exit` below stops it, and stop()
  // does too. We only asked it to stop holding the door open.
  child.unref();

  let stopped = false;
  const killGroup = (signal) => {
    if (stopped) return;
    stopped = true;
    try { process.kill(-child.pid, signal); } catch (err) {
      try { child.kill(signal); } catch (err2) { /* already gone */ }
    }
  };

  // Belt and braces. The suite's own finally does this properly, but a SIGINT
  // or an uncaught throw should not be the reason a browser outlives the run.
  const onExit = () => killGroup('SIGKILL');
  process.on('exit', onExit);

  const ready = (async () => {
    for (let i = 0; i < 100; i++) {
      try {
        const res = await fetch(`${base}/status`);
        if (res.ok) return true;
      } catch (err) { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`chromedriver did not come up on ${base}`);
  })();

  return {
    port,
    base,
    ready,
    async stop() {
      process.removeListener('exit', onExit);
      killGroup('SIGTERM');
      // Chrome sometimes needs a moment. SIGKILL is the backstop so teardown
      // cannot itself become the thing that leaks.
      await new Promise((r) => setTimeout(r, 400));
      killGroup('SIGKILL');
      try { await ready; } catch (err) { /* never came up */ }
      if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
    }
  };
}

/**
 * Runs `fn` with a chromedriver of our own on a port of our own, and tears the
 * whole thing down whatever happens. `fn` receives { base }.
 */
async function withDriver(fn) {
  const report = await preflight();
  if (report.stale) {
    console.error(`Refusing to start: ${describe(report)} already running.`);
    console.error('That is what a leaked run leaves behind; clear it before adding to it.');
    const err = new Error('too many stale browser processes');
    err.code = 'STALE_BROWSERS';
    throw err;
  }
  if (report.browsers) {
    console.log(`  (starting with ${describe(report)} already running)`);
  }

  const driver = await startDriver();
  try {
    return await fn({ base: driver.base, driver });
  } finally {
    // Deliberately not `process.exit` inside here: the caller's finally needs a
    // chance to close the browser session first, since that is what makes chrome
    // exit. Killing the driver first would leave the browser orphaned to init.
    await driver.stop();
  }
}

module.exports = { withDriver, startDriver, preflight, freePort };