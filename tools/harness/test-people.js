// The risky part of the people work: upgrading a database that already has
// data in it, and the import round trip that re-points personIds.
const { withDriver } = require('./driver');
const openedSessions = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, extra) => { ok ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n + (extra ? ' -> ' + JSON.stringify(extra) : ''))); };

async function runSuite(driverBase) {
  const caps = { capabilities: { alwaysMatch: { browserName: 'chrome', 'goog:chromeOptions': {
    binary: '/usr/bin/chromium', args: ['--headless=new', '--no-sandbox', '--disable-gpu', '--window-size=412,915'] } } } };
  const res = await fetch(`${driverBase}/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(caps) });
  const sid = (await res.json()).value.sessionId;
  openedSessions.push(sid);
  const send = async (p, m, b) => {
    const r = await fetch(`${driverBase}/session/${sid}${p}`, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    const j = await r.json();
    if (j.value && j.value.error) throw new Error(p + ' ' + JSON.stringify(j.value).slice(0, 300));
    return j.value;
  };
  const run = (s) => send('/execute/sync', 'POST', { script: `return (async function(){ ${s} })();`, args: [] });

  console.log('\n# upgrading a database that already has data');
  // IndexedDB needs a real origin, so get onto the app's own page first.
  await send('/url', 'POST', { url: 'http://127.0.0.1:8141/index.html?native' });
  await sleep(1800);

  // Build a v1-shaped database by hand: numeric ids, no people store.
  const upgraded = await run(`
    await new Promise((resolve, reject) => {
      const del = indexedDB.deleteDatabase('sorted-v2-db');
      del.onsuccess = resolve; del.onerror = reject;
      del.onblocked = () => setTimeout(resolve, 500);
    });
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('sorted-v2-db', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of ['spend', 'due', 'savings', 'recurring']) {
          const s = db.createObjectStore(name, { keyPath: 'id', autoIncrement: true });
          s.createIndex('category', 'category', { unique: false });
          s.createIndex('date', 'date', { unique: false });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('spend', 'readwrite');
        tx.objectStore('spend').add({ title: 'Old entry', amount: 12.5, date: localISO(new Date()), category: 'Food', confirmed: true, paid: false });
        tx.objectStore('spend').add({ title: 'Another old one', amount: 4, date: localISO(new Date()), category: 'Motor', confirmed: false, paid: false });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
    return true;
  `);
  check('seeded a v1 database with two rows', upgraded === true);

  // Now reload: the app opens at DB_VERSION 2 and has to upgrade in place.
  await send('/url', 'POST', { url: 'http://127.0.0.1:8141/index.html?native' });
  await sleep(2000);
  const after = await run(`
    const spend = await getAll('spend');
    const people = await getAll('people');
    return {
      version: DB_VERSION,
      count: spend.length,
      ids: spend.map((s) => s.id),
      people: people.length,
      personIds: spend.map((s) => s.personId === undefined ? 'missing' : s.personId),
      firstStillThere: !!spend.find((s) => s.title === 'Old entry')
    };
  `);
  check('existing rows survive the upgrade', after.count === 2 && after.firstStillThere, after);
  check('people store created', after.people === 0, after);
  // Rows from before the feature have no personId key at all rather than a
  // null one. Nothing rewrites existing rows, and every reader treats a
  // missing person the same as "Anyone".
  check('pre-existing rows read as unattributed', after.personIds.every((p) => p === null || p === 'missing'), after);

  const minted = await run(`
    // New rows get their own id, and they're not numbers any more.
    const id = await addItem('spend', { title: 'New after upgrade', amount: 9, date: localISO(new Date()), category: 'Food' });
    const people = [];
    const personId = await addItem('people', { name: 'Sarah', colour: PERSON_COLOURS[1] });
    people.push({ id: personId, name: 'Sarah' });
    await addItem('spend', { title: 'Sarah buys', amount: 3, date: localISO(new Date()), category: 'Food', personId });
    const spend = await getAll('spend');
    const fetched = await getItem('spend', id);
    return {
      id, idType: typeof id, people,
      uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
      fetchable: !!fetched,
      personId
    };
  `);
  check('new id is a UUID, not a number', minted.uuid && minted.idType === 'string', minted);
  check('the new row is fetchable by that id', minted.fetchable, minted);
  check('a person gets their own id', !!minted.personId, minted);

  console.log('\n# import: people come across and ids get re-pointed');
  const roundTrip = await run(`
    // Export on this device, wipe it, restore. The personId in the file is
    // meaningless on "another device" — it has to be matched by name.
    const backup = await getAllData();
    return JSON.parse(JSON.stringify(backup));
  `);
  // Wipe from a fresh page load so the app's cached connection isn't holding
  // the database open, then import the JSON as that "other device".
  await send('/url', 'POST', { url: 'http://127.0.0.1:8141/index.html?native' });
  await sleep(1200);
  await run(`
    await new Promise((resolve) => {
      const req = indexedDB.deleteDatabase('sorted-v2-db');
      req.onsuccess = resolve; req.onerror = resolve;
      req.onblocked = () => setTimeout(resolve, 500);
    });
  `);
  await send('/url', 'POST', { url: 'http://127.0.0.1:8141/index.html?native' });
  await sleep(1500);
  const restored = await run(`
    const res = await importDataToDB(${JSON.stringify(roundTrip)}, 'replace');
    const people = await getAll('people');
    const spend = await getAll('spend');
    const sarah = people.find((p) => p.name === 'Sarah');
    const hers = spend.filter((s) => s.title === 'Sarah buys');
    return {
      res, people: people.map((p) => p.name), spendCount: spend.length,
      hasSarah: !!sarah,
      remapped: hers.length === 1 && hers[0].personId === sarah.id,
      unattributed: spend.filter((s) => !s.personId).length,
      dangling: spend.filter((s) => s.personId && !people.some((p) => p.id === s.personId)).length
    };
  `);
  check('people restored', restored.hasSarah && restored.people.length === 1, restored);
  check('entries restored', restored.spendCount === 4, restored);
  check('personId re-pointed at the local person', restored.remapped, restored);
  check('unattributed entries stay unattributed', restored.unattributed === 3, restored);
  check('no dangling person references', restored.dangling === 0, restored);

  console.log('\n# merge: the same person is not duplicated');
  const merged = await run(`
    const before = (await getAll('people')).length;
    const res = await importDataToDB(${JSON.stringify(roundTrip)}, 'merge');
    const after = (await getAll('people')).length;
    return { before, after, res };
  `);
  check('merging the same file adds no second Sarah', merged.after === merged.before, merged);

  console.log('\n# legacy rows with numeric keys are still reachable');
  // The user's live install has every row keyed by a number. A data attribute
  // hands the id back as a string, and "3" is not the key 3 — this is the
  // difference between a row opening and silently doing nothing.
  const legacy = await run(`
    await new Promise((resolve) => {
      const req = indexedDB.deleteDatabase('sorted-v2-db');
      req.onsuccess = resolve; req.onerror = resolve;
      req.onblocked = () => setTimeout(resolve, 500);
    });
    return true;
  `);
  void legacy;
  await send('/url', 'POST', { url: 'http://127.0.0.1:8141/index.html?native' });
  await sleep(1500);
  const legacyRows = await run(`
    // Hand-write rows with numeric keys, the way the pre-UUID build did.
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('sorted-v2-db', DB_VERSION);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('spend', 'readwrite');
        const store = tx.objectStore('spend');
        const a = store.add({ title: 'Legacy numeric row', amount: 7, date: localISO(new Date()), category: 'Food', confirmed: false, paid: false, createdAt: '2026-09-05T10:00:00.000Z' });
        const b = store.add({ title: 'Second legacy row', amount: 9, date: localISO(new Date()), category: 'Food', confirmed: false, paid: false, createdAt: '2026-09-06T10:00:00.000Z' });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
    dbPromise = null;
    const rows = await getAll('spend');
    const numeric = rows.filter((r) => typeof r.id === 'number');
    const first = numeric[0];
    // Read it back the way a row click does: from the data attribute, as a string.
    const viaString = await getItem('spend', String(first.id));
    currentPage = 'spend'; renderPage();
    await new Promise((r) => setTimeout(r, 600));
    const row = [...document.querySelectorAll('.item-row')].find((el) => el.dataset.editId === String(first.id));
    const datasetId = row ? row.dataset.editId : null;
    // Paying a bill settles it in Bills rather than writing a payment into
    // Spend, so the string-id check follows the settled bill now. That Spend
    // copy was the double count this release removed.
    const bill = await addItem('due', { title: 'Legacy bill', amount: 12, category: 'Utilities', dueDate: localISO(new Date()), recurring: true });
    await markPaid(bill);
    const settled = (await getAll('due')).find((d) => d.title === 'Legacy bill' && d.paid === true);
    return {
      numericCount: numeric.length,
      viaString: !!viaString,
      datasetId,
      renderedRow: !!row,
      paymentIdType: settled ? typeof settled.id : 'none'
    };
  `);
  check('numeric-keyed rows are written as numbers', legacyRows.numericCount >= 2, legacyRows);
  check('a numeric id read as a string still finds its row', legacyRows.viaString, legacyRows);
  check('such a row renders with a matching data-edit-id', legacyRows.renderedRow && legacyRows.datasetId !== null, legacyRows);
  check('a settled bill gets a string id like everything else', legacyRows.paymentIdType === 'string', legacyRows);

  console.log(`\n${pass} passed, ${fail} failed`);
  return fail;
}

// Teardown in the same order as everywhere else: close the session (which is
// what makes chrome exit), then let withDriver stop the driver, then exit.
// process.exit() inside the try would skip the session close — the exact leak
// this replaces, where a failed run left a browser alive.
let exitCode = 1;
withDriver(async ({ base, driver }) => {
  // See test.js: the port is not accepting the moment the driver is spawned.
  await driver.ready;
  let failures = 1;
  try {
    failures = await runSuite(base);
  } finally {
    for (const id of openedSessions.splice(0)) {
      try { await fetch(`${base}/session/${id}`, { method: 'DELETE' }); }
      catch (err) { /* the driver is going away anyway */ }
    }
  }
  exitCode = failures ? 1 : 0;
}).catch((e) => {
  console.error(e);
  exitCode = e && e.code === 'STALE_BROWSERS' ? 2 : 1;
}).finally(() => {
  process.exit(exitCode);
});
