// README screenshots, regenerated. The old shot5.js seeded nothing — it
// edited the rows a "sample data" button used to leave behind, and that
// button is gone, so this draws the household itself.
//
// Phone layout, dark theme, 412px at 2x, sized to the content:
// chromedriver's /screenshot cannot exceed the window and the window cannot
// exceed the virtual screen, but Emulation.setDeviceMetricsOverride can.
const fs = require('fs');
const path = require('path');

const { withDriver } = require('./driver.js');

const OUT = process.argv[2];
const BASE = 'http://127.0.0.1:8141';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The household the README describes: Gareth and Kim, a current account and
// some cash, two goals, and a month with bills already paid. Written through
// the app's own API rather than straight into IndexedDB, so every write takes
// the same path a form does.
const SEED = `
  const d = new Date();
  const y = d.getFullYear(), m = d.getMonth();
  const gareth = await addItem('people', { name: 'Gareth', colour: PERSON_COLOURS[0] });
  const kim = await addItem('people', { name: 'Kim', colour: PERSON_COLOURS[3] });
  // Opening figures chosen so the household stays comfortably solvent after
  // the bills below have been paid and the goals filled — a README showing a
  // negative total tells the wrong story about the app.
  const current = await addItem('accounts', { name: 'Current account', type: 'bank', opening: 5350 });
  const cash = await addItem('accounts', { name: 'Cash', type: 'cash', opening: 120 });
  await addItem('income', { title: 'Salary', amount: 2140, category: 'salary',
    frequency: 'monthly', date: localISO(new Date(y, m, 1)), accountId: current, personId: gareth });

  // A month with bills already paid, and two still to come.
  const bills = [
    ['Rent', 875, 3, true, gareth],
    ['Electric', 96.40, 11, true, gareth],
    ['Water', 34.10, 18, false, kim],
    ['Broadband', 32, 22, false, gareth]
  ];
  for (const [title, amount, day, paid, person] of bills) {
    const made = await addItem('due', { title, amount,
      dueDate: localISO(new Date(y, m, day)), frequency: 'monthly',
      category: title === 'Rent' ? 'General' : 'Utilities', accountId: current,
      paid: false, personId: person });
    if (paid) await markPaid(made);
  }

  // Spending, ticked off. The lunch is deliberately left unticked so the
  // Pending filter and the tick itself are visible on the Spend shot.
  const spends = [
    ['Groceries', 42.18, 'Eating out', cash, kim, true, 4],
    ['Co-op', 8.76, 'Eating out', cash, gareth, true, 6],
    ['Fuel', 61.20, 'Motor', current, gareth, true, 8],
    ['Lunch', 9.40, 'Eating out', current, kim, false, 9],
    ['Cinema', 22.00, 'Entertainment', current, kim, true, 12]
  ];
  for (const [title, amount, category, accountId, person, confirmed, day] of spends) {
    await addItem('spend', { title, amount, category, accountId, personId: person,
      date: localISO(new Date(y, m, day)), confirmed });
  }

  await addItem('savings', { title: 'Japan 2027', category: 'Holiday',
    target: 4200, current: 850, accountId: current });
  await addItem('savings', { title: 'Living room', category: 'Home',
    target: 1400, current: 1400, accountId: current });
  await addItem('savings', { title: 'Christmas', category: 'Christmas',
    target: 600, current: 240, accountId: cash });

  await addItem('transfers', { amount: 250, fromId: current, toId: cash,
    date: localISO(new Date(y, m, 2)) });
  await loadAccounts();
  setCurrentPersonId(gareth);
`;

async function main() {
  const caps = { capabilities: { alwaysMatch: { browserName: 'chrome', 'goog:chromeOptions': {
    binary: '/usr/bin/chromium',
    args: ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
      '--force-device-scale-factor=2', '--window-size=412,915'] } } } };

  return withDriver(async ({ base, driver }) => {
    // See test.js: the port is not accepting the moment the driver is spawned.
    await driver.ready;
    const res = await fetch(`${base}/session`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(caps) });
    const created = (await res.json()).value;
    const sid = created.sessionId;
    const [dbgHost, dbgPort] = created.capabilities['goog:chromeOptions'].debuggerAddress.split(':');

    const send = async (p, meth, b) => {
      const r = await fetch(`${base}/session/${sid}${p}`, {
        method: meth, headers: { 'content-type': 'application/json' },
        body: b ? JSON.stringify(b) : undefined });
      const j = await r.json();
      if (j.value && j.value.error) throw new Error(p + ' ' + JSON.stringify(j.value).slice(0, 200));
      return j.value;
    };
    const run = (s) => send('/execute/sync', 'POST', {
      script: `return (async function(){ ${s} })();`, args: [] });

    try {
      await send('/url', 'POST', { url: `${BASE}/index.html?native` });
      await sleep(1200);
      // The notice is armed by a fresh localStorage, so re-arming it here is
      // what puts it under a popup in every shot. The notice itself is not
      // what these show: mark it seen and dismiss it if it is already up.
      await run(`
        localStorage.clear();
        localStorage.setItem('SORTED_PRIVACY_SEEN', '1');
        setThemePreference('dark');
        document.getElementById('privacy-notice').remove();
        1;`);
      await send('/url', 'POST', { url: `${BASE}/index.html?native` });
      await sleep(900);
      await run(`
        localStorage.setItem('SORTED_PRIVACY_SEEN', '1');
        const n = document.getElementById('privacy-notice');
        if (n) n.remove();
        1;`);

      // The DevTools endpoint, for the capture itself.
      const targets = await (await fetch(`http://${dbgHost}:${dbgPort}/json/list`)).json();
      const page = targets.find((t) => t.type === 'page' && t.url.includes('8141'))
        || targets.find((t) => t.type === 'page');
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
      let id = 0;
      const pending = new Map();
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      };
      const cdp = (method, params = {}) => new Promise((resolve, reject) => {
        const n = ++id;
        pending.set(n, (msg) => (msg.error
          ? reject(new Error(method + ' ' + msg.error.message)) : resolve(msg.result)));
        ws.send(JSON.stringify({ id: n, method, params }));
      });

      await run(`
        for (const s of ['accounts','due','spend','income','savings','transfers','people']) {
          for (const x of await getAll(s)) await deleteItem(s, x.id);
        }
        1;`);
      await run(SEED);

      // A receipt on one row, so the paperclip shows on the Spend shot.
      await run(`
        const c = document.createElement('canvas'); c.width = 520; c.height = 720;
        const x = c.getContext('2d');
        x.fillStyle = '#fdfdfb'; x.fillRect(0, 0, 520, 720);
        x.fillStyle = '#16181d'; x.font = 'bold 34px sans-serif'; x.fillText('SPAR', 40, 70);
        x.font = '22px sans-serif';
        x.fillText('13 Sep 2026', 40, 120);
        x.fillText('Unleaded', 40, 190); x.fillText('TOTAL GBP 40.05', 40, 250);
        x.fillRect(40, 285, 440, 2);
        const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
        const prepared = await prepareReceipt(new File([blob], 'spar.png', { type: 'image/png' }));
        const item = (await getAll('spend')).find((i) => /Co-op/i.test(i.title));
        if (item) await updateItem('spend', { ...item, receipt: prepared.receipt });
        1;`);

      await cdp('Page.enable');
      const written = [];
      // destination key -> file name. Bills is 'due' internally: asking for
      // 'bills' simply does not switch the page, which is how the Bills shot
      // ended up showing Spend a second time.
      const shots = [['dashboard', 'dashboard'], ['spend', 'spend'], ['due', 'bills'],
        ['savings', 'savings'], ['reports', 'reports'], ['settings', 'settings']];
      for (const [destination, name] of shots) {
        // navigate(), not currentPage =: setting the variable skips the nav
        // sync, which left the bottom bar highlighting the wrong destination.
        await run(`navigate('${destination}'); 1;`);
        await sleep(destination === 'reports' ? 2200 : 1000);
        const h = Math.ceil(await run(`
          const last = document.querySelector('.content').lastElementChild;
          return last.getBoundingClientRect().bottom + 52 + 20 + 84;`));
        await cdp('Emulation.setDeviceMetricsOverride', {
          width: 412, height: h, deviceScaleFactor: 2, mobile: true });
        await sleep(450);
        const { data } = await cdp('Page.captureScreenshot',
          { format: 'png', captureBeyondViewport: true });
        fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(data, 'base64'));
        written.push(`${name}.png  824 x ${h * 2}`);
        await cdp('Emulation.clearDeviceMetricsOverride');
      }

      ws.close();
      return written;
    } finally {
      // Teardown order from the README: the browser session first — that is
      // what makes chrome exit — then the driver, which withDriver does.
      try { await fetch(`${base}/session/${sid}`, { method: 'DELETE' }); } catch (err) { /* gone */ }
    }
  });
}

main()
  .then((written) => console.log(written.join('\n')))
  .catch((e) => { console.error(e); process.exit(1); });
