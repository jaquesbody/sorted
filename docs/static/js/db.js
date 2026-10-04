// Sorted v2 - IndexedDB Database Layer

const DB_NAME = 'sorted-v2-db';
// v2 added `people`; v3 `accounts` and `transfers`; v4 `income`. None of the
// bumps changed an existing store: new rows get their own generated id, so the
// old stores keep the key generator they were created with and no record is
// rewritten. Adding a store is the cheapest migration IndexedDB offers —
// creating one touches nothing else.
const DB_VERSION = 4;
const STORES = ['spend', 'due', 'savings', 'recurring', 'people', 'accounts', 'transfers', 'income'];

// Cash isn't a payment method, it's an account with notes in it. Same concept
// as a bank account, so it goes through the same code rather than being a
// special case threaded through every form and report.
const CASH_TYPE = 'cash';

// A globally unique id for new rows. The stores were created with
// autoIncrement, so old rows keep their numbers — but two devices would
// eventually hand out the same number, and syncing later would collide.
// Every new row gets a UUID instead; put() with an explicit key works fine
// in an autoIncrement store, the generator simply never runs.
function newId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  // Not a secure context (a plain-http LAN address, say), so randomUUID is
  // unavailable. getRandomValues isn't, though.
  const bytes = new Uint8Array(16);
  if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// One cached connection for the page's lifetime. Every operation used to
// open a fresh IndexedDB connection and never close it — enough leaked
// connections piled up that deleteDatabase() blocked and memory grew on
// heavy use. Failures drop the cache so the next call can retry.
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      STORES.forEach(name => {
        if (!db.objectStoreNames.contains(name)) {
          // People and accounts always get an explicit id (their rows are
          // created with one already), so there's no reason to give those
          // stores a key generator. Transfers can arrive by import with an id
          // already attached, so it gets one too. Nothing else changes:
          // existing stores are left alone.
          const store = db.createObjectStore(name, ['people', 'accounts', 'transfers', 'income'].includes(name)
            ? { keyPath: 'id' }
            : { keyPath: 'id', autoIncrement: true });
          store.createIndex('category', 'category', { unique: false });
          store.createIndex('date', 'date', { unique: false });
        }
      });
    };

    request.onsuccess = () => {
      const db = request.result;
      // Another tab requesting a schema upgrade, or a forced close, drops
      // the cache so the next operation opens a fresh connection.
      db.onversionchange = () => { db.close(); dbPromise = null; };
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };
    request.onerror = () => { dbPromise = null; reject(request.error); };
  });
  return dbPromise;
}

// Drops the cached connection so the next read opens a fresh one. Android
// suspends the WebView when the app goes to the background and can close the
// database underneath it; a connection left cached after that rejects every
// operation rather than reopening, and the app then looks like its data has
// gone. Nothing is lost — the records are on disk — but a re-open is needed.
function resetDbConnection() {
  if (dbPromise) {
    Promise.resolve(dbPromise).then((db) => { try { db.close(); } catch (err) { /* already gone */ } })
      .catch(() => { /* never opened */ });
  }
  dbPromise = null;
  return null;
}

async function getAll(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getItem(storeName, id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const request = store.get(normaliseId(id));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Rows created before ids were UUIDs have *numeric* keys, and a data
// attribute always hands us back a string — so looking a legacy row up as
// "3" when it was stored as 3 finds nothing, and the row can't be opened.
// Numbers are turned back into numbers; everything else passes through.
function normaliseId(id) {
  return (typeof id === 'string' && /^-?\d+$/.test(id)) ? Number(id) : id;
}

async function addItem(storeName, item) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    // An id is minted only if the caller didn't bring one — importing mints
    // per row so ids stay unique to this device, and seeding follows the
    // same path as any other add.
    const record = { createdAt: new Date().toISOString(), ...item };
    if (record.id === undefined || record.id === null) record.id = newId();
    const request = store.add(record);
    // The id the record itself carries, not request.id: that's only populated
    // when the store's key generator made the key, and every new row now
    // brings its own.
    request.onsuccess = () => resolve(record.id);
    request.onerror = () => reject(request.error);
  });
}

async function updateItem(storeName, item) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    // The id has to be normalised here too, not just on read and delete. An
    // edit arrives with the id as it came off a data attribute — a string —
    // and putting a legacy row back under the string "3" when it was stored
    // as the number 3 silently creates a *second* row instead of editing the
    // first. The original keeps rendering unchanged, so the edit looks like it
    // did nothing, and Delete then appears to do nothing too. Same trap as
    // getItem/deleteItem, one layer up.
    const record = { ...item, id: normaliseId(item.id), updatedAt: new Date().toISOString() };
    const request = store.put(record);
    request.onsuccess = () => resolve(record.id);
    request.onerror = () => reject(request.error);
  });
}

async function deleteItem(storeName, id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = store.delete(normaliseId(id));
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// The next date this item is due, given how often it repeats. Monthly is the
// default: every row that predates the frequency field is simply recurring,
// and rolling a yearly bill forward a month at a time was the old behaviour for
// all of them.
function nextDueDate(dueDate, frequency) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dueDate || '');
  let y, mo, d;
  if (m) {
    y = Number(m[1]); mo = Number(m[2]); d = Number(m[3]);
  } else {
    const t = new Date();
    y = t.getFullYear(); mo = t.getMonth() + 1; d = t.getDate();
  }
  // Annual keeps the month and the day and only moves the year, so a bill due
  // 29 February rolls to 28 February rather than into March.
  const stepMonths = frequency === 'annually' ? 12 : 1;
  const total = (y * 12 + (mo - 1)) + stepMonths;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const lastDay = new Date(ny, nm, 0).getDate();
  return localISO(new Date(ny, nm - 1, Math.min(d, lastDay)));
}

// Paying a bill: the payment lands in Spend. A recurring bill then rolls
// forward to the same day next month instead of disappearing — one tap
// records this month's payment and next month's due date appears.
// Both writes run in a single transaction, so a failure can never leave
// the bill in both lists or in neither.
// The payment is attributed to whoever is using the app at the moment
// (passed in as payerId) — "who paid for it" is the whole point of the
// attribution — falling back to the bill's own person when nobody is
// selected, which is a better guess than nobody.
// Paying a bill settles it where it stands. It used to instead write a
// *payment* into Spend, roll the bill forward and delete it if it was one-off —
// and that single decision produced the duplicate this release exists to fix.
//
// A bill that has been paid is still a bill. Moving its payment into Spend
// meant the same money sat in two categories at once: the payment counted in
// the spending average, while the bill counted again as a bill in every month
// it projected into. On a £500 rent that is £500 of forecast costs that was
// never going to be spent, every month, forever.
//
// So the bill stays in Bills and is marked paid. Two consequences, both
// handled here rather than left to the caller:
//
//   - A past month stays reviewable. This was the original reason for the
//     Spend copy, and it is why the bill is kept rather than deleted.
//   - A recurring bill must leave a *fresh payable row* behind. If it only
//     stayed put, its next occurrence would exist purely as an inert
//     projection — nothing to tap, so next month's rent could never be
//     settled. A recurring bill therefore becomes two rows: this one, settled,
//     and the next one, real.
async function markDuePaid(dueItem, payerId) {
  const { id, ...rest } = dueItem;
  const repeats = dueItem.frequency === 'monthly'
    || dueItem.frequency === 'annually'
    || dueItem.recurring === true;

  if (repeats) {
    // Read before writing, on its own transaction. The next occurrence is only
    // added if it is not already there: adding one unconditionally left two rows
    // dated the same day whenever the following month had been entered by hand,
    // and the month's total counted that bill twice.
    const next = nextDueDate(rest.dueDate, dueItem.frequency);
    const already = (await getAll('due')).some((r) => r.dueDate === next);
    if (!already) {
      await addItem('due', {
        ...rest,
        paid: false,
        personId: payerId || rest.personId || null,
        dueDate: next
      });
    }
  }

  await updateItem('due', {
    ...rest,
    id,
    paid: true,
    personId: payerId || rest.personId || null
  });
}

// Everything, for the backup. Driven off STORES so a new store can't be
// forgotten here — people missing from a backup would strip every entry's
// attribution on the next restore.
async function getAllData() {
  const out = {};
  for (const name of STORES) out[name] = await getAll(name);
  return out;
}

// Wipe every store and start over: the "remove all data" action in Settings.
// Clearing store by store rather than deleteDatabase(), because
// deleteDatabase() blocks on this page's own open connection and the version
// handshake would have to be redone. Records are counted first so the caller
// can refuse an accidental wipe, and the result comes back for the toast.
//
// The people go too, deliberately: a "remove all data" that left everyone's
// names behind wouldn't be one, and the PINs go with them (they're in
// localStorage, dropped by the caller) or the app would sit locked against
// people who no longer exist.
async function clearAllData() {
  const counts = {};
  for (const name of STORES) counts[name] = (await getAll(name)).length;

  const db = await openDB();
  for (const name of STORES) {
    const tx = db.transaction(name, 'readwrite');
    tx.objectStore(name).clear();
    await txDone(tx);
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { total, counts };
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// Identity for merge dedupe: enough to tell two logical entries apart
// (title + money + when) without relying on ids, which are reassigned on
// import. Deliberately heuristic — same naive spirit as the OCR guesses.
// A receipt's image is not part of the key: the same bill photographed twice
// is one entry, not two.
function importKeyOf(item) {
  const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();
  return [
    norm(item.title),
    norm(item.amount),
    norm(item.date || item.dueDate || ''),
    norm(item.current),
    norm(item.target)
  ].join('|');
}

// Coerce one imported entry into something the app can store and show:
// numbers as numbers (string amounts used to poison Reports totals with
// concatenation), ISO dates only, sane booleans, category defaulted.
// Returns null when the entry is unusable — no title, no money, or a
// missing/garbage date on spend/bills (those rows would render
// "NaN days" or vanish from every list while Reports still counted
// them). Unknown fields pass through untouched.
function sanitizeItem(storeName, item) {
  const out = { ...item };
  delete out.id; // ids are reassigned on import

  const str = (v) => String(v == null ? '' : v).trim();
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const bool = (v) => (typeof v === 'string' ? v === 'true' : !!v);
  const isoDate = (v) => {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(str(v));
    if (!m) return null;
    const [y, mo, d] = m[1].split('-').map(Number);
    const dt = new Date(y, mo - 1, d); // round-trip rejects 31 Feb etc.
    return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d
      ? m[1] : null;
  };

  if (storeName === 'people') {
    const name = str(item.name).slice(0, 40);
    if (!name) return null;
    out.name = name;
    // Colour is a hex from the app's own palette, or the neutral default.
    out.colour = /^#[0-9a-f]{6}$/i.test(str(item.colour)) ? str(item.colour) : PERSON_COLOURS[0];
    return out;
  }

  if (storeName === 'accounts') {
    const name = str(item.name).slice(0, 40);
    if (!name) return null;
    out.name = name;
    // Anything that isn't 'cash' is a bank account. An unknown type would
    // otherwise produce an account that behaves like neither.
    out.type = str(item.type) === CASH_TYPE ? CASH_TYPE : 'bank';
    // Opening and adjustment are the two things a person types; the balance
    // shown is derived from them plus activity, so neither is ever stored as
    // a result. Coerced here so a hand-edited file can't make a balance NaN.
    const money = (v) => { const n = num(v); return n === null ? 0 : n; };
    out.opening = money(item.opening);
    out.adjustment = money(item.adjustment);
    if ('personId' in item) out.personId = item.personId || null;
    if (typeof item.archived === 'boolean') out.archived = item.archived;
    return out;
  }

  if (storeName === 'income') {
    const title = str(item.title).slice(0, 100);
    const amount = num(item.amount);
    const date = isoDate(item.date);
    // No title, no money or no date is not an income entry. The date matters
    // most: income drives the whole forecast, and an undated entry would land
    // in a month the arithmetic has no way to choose.
    if (!title || amount === null || amount <= 0 || !date) return null;
    out.title = title;
    out.amount = amount;
    out.date = date;
    out.category = ['salary', 'sale', 'other'].includes(str(item.category)) ? str(item.category) : 'other';
    if (item.frequency === 'monthly' || item.frequency === 'annually') out.frequency = item.frequency;
    return out;
  }

  if (storeName === 'transfers') {
    const amount = num(item.amount);
    const fromId = str(item.fromId);
    const toId = str(item.toId);
    // A transfer that isn't money moving between two places isn't a transfer.
    if (!amount || amount <= 0) return null;
    if (!fromId || !toId || fromId === toId) return null;
    out.amount = amount;
    out.fromId = fromId;
    out.toId = toId;
    // A transfer with no date lands today rather than being dropped: it still
    // moves the balances, and a balance that ignores an untdated movement is
    // worse than one dated approximately.
    out.date = isoDate(item.date) || localISO();
    if (item.note !== undefined) out.note = str(item.note).slice(0, 100);
    return out;
  }

  // Who this entry belongs to. The value is kept as it came: on import,
  // stripSourceId() translates the file's id into one of this device's, and
  // anything it can't match ends up null rather than dangling.
  out.personId = item.personId || null;
  // Which account the money came out of, for the same reason. Kept separate
  // from personId: whose it was, and where it came from, are different
  // questions and conflating them would make a shared joint account
  // impossible to express.
  out.accountId = item.accountId || null;

  out.title = str(item.title).slice(0, 100);
  if (!out.title) return null;
  out.category = str(item.category).slice(0, 60) || 'General';

  if (storeName === 'spend' || storeName === 'due') {
    const amount = num(item.amount);
    if (amount === null || amount <= 0) return null;
    out.amount = amount;
    // due entries written by older versions may carry `date` only
    const date = isoDate(storeName === 'spend' ? item.date : (item.dueDate || item.date));
    if (!date) return null;
    if (storeName === 'spend') out.date = date; else out.dueDate = date;
    if ('recurring' in item) out.recurring = bool(item.recurring);
    if ('confirmed' in item) out.confirmed = bool(item.confirmed);
    if ('paid' in item) out.paid = bool(item.paid);
    if ('frequency' in item) out.frequency = str(item.frequency).slice(0, 20);
    // Receipt images ride along with the entry, so a backup taken on one
    // device still shows its photos on another. Only a self-contained image
    // data URL is accepted — anything else is dropped rather than rendered.
    if (item.receipt && typeof item.receipt === 'object' && /^data:image\/(png|jpe?g|webp|gif);base64,/.test(str(item.receipt.dataUrl))) {
      out.receipt = {
        dataUrl: item.receipt.dataUrl,
        name: str(item.receipt.name).slice(0, 200),
        addedAt: str(item.receipt.addedAt)
      };
    } else if ('receipt' in item) {
      delete out.receipt;
    }
  } else if (storeName === 'savings') {
    const target = num(item.target);
    const current = num(item.current);
    if (target === null || target <= 0) return null;
    out.target = target;
    out.current = current !== null && current >= 0 ? current : 0;
    // A monthly contribution, so the forecast can draw a savings line instead
    // of guessing at a schedule the goal doesn't carry. Absent means "work it
    // out from what's left and the time remaining", which is why null and 0 are
    // different: 0 is a goal you're deliberately not putting into.
    if (typeof item.monthly === 'number' && Number.isFinite(item.monthly) && item.monthly >= 0) {
      out.monthly = Math.round(item.monthly * 100) / 100;
    }
  }

  if ('notes' in item) out.notes = str(item.notes).slice(0, 1000);
  return out;
}

// Identity colours for people. Deliberately not the app's semantic colours
// (accent blue, danger red, success green, warning amber) — a person isn't a
// state, and a red dot beside a number would be read as "overdue".
const PERSON_COLOURS = [
  '#8b5cf6', // violet
  '#14b8a6', // teal
  '#ec4899', // pink
  '#84cc16', // lime
  '#06b6d4', // cyan
  '#f97316', // orange
  '#d946ef', // fuchsia
  '#a3a3a3'  // neutral, once the palette wraps
];

// Next colour in the palette for a new person, spread out rather than handed
// out in order so the first two people don't both land on violet.
function nextPersonColour(existing) {
  if (existing.length === 0) return PERSON_COLOURS[0];
  const stride = 3;
  let i = (existing.length * stride) % PERSON_COLOURS.length;
  return PERSON_COLOURS[i];
}

// mode 'merge'  — keep everything stored, add only entries not already there
//                 (existing wins; duplicates inside the file are skipped too)
// mode 'replace' — restore semantics: the file becomes the data set; every
//                 store is cleared first, even ones missing from the file.
// Sanitisation runs up front so replace mode never clears anything it
// can't back with usable entries.
//
// People are written before the entries that point at them, in both modes.
// Ids are minted per device, so a backup's personIds mean nothing here; the
// only identity that survives the trip is a name, so people are matched on
// name and every personId in the file is translated to the local id of
// whoever it matched. Anyone in the file who isn't matched becomes a new
// person; a personId with no matching person becomes unattributed rather
// than a dangling reference the UI would render as a blank.
async function importDataToDB(data, mode = 'merge') {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error("That file isn't a Sorted backup");
  }

  const fileStores = STORES.filter(name => Array.isArray(data[name]));
  if (fileStores.length === 0) {
    throw new Error('No Sorted data found in that file');
  }

  // Keep the source id alongside each sanitised row, purely so the people
  // pass below can translate personIds. It is stripped before anything is
  // written.
  let dropped = 0;
  const usable = {};
  for (const storeName of fileStores) {
    usable[storeName] = [];
    for (const item of data[storeName]) {
      if (!item || typeof item !== 'object') { dropped++; continue; }
      const clean = sanitizeItem(storeName, item);
      if (!clean) { dropped++; continue; }
      clean._sourceId = item.id;
      usable[storeName].push(clean);
    }
  }
  const totalUsable = Object.values(usable).reduce((n, arr) => n + arr.length, 0);
  if (totalUsable === 0) throw new Error('Nothing usable in that file');

  const db = await openDB();
  let imported = 0;
  let skipped = 0;

  // People and accounts are both matched by name, and both have to be written
  // before anything that references them. Doing that for two stores with one
  // helper is what keeps them from drifting apart — accounts started life as a
  // copy of the people code and would have needed the same id-map plumbing in
  // a third place.
  const idMaps = {};
  const NAMED = {
    people: (r) => r.name.toLowerCase(),
    // Type is part of the key so two bank accounts that happen to share a name
    // stay two accounts, while "Cash" on two devices is still one Cash.
    accounts: (r) => `${r.type || 'bank'}|${r.name.toLowerCase()}`
  };

  for (const storeName of ['people', 'accounts']) {
    idMaps[storeName] = await writeNamedStore(storeName, NAMED[storeName], usable[storeName], mode, fileStores.includes(storeName));
    imported += idMaps[storeName].imported;
    skipped += idMaps[storeName].skipped;
  }
  // The .idMap, not the wrapper: the wrapper is the write's bookkeeping, the
  // map is the translation from the file's ids to ours.
  const personMap = idMaps.people.idMap;
  const accountMap = idMaps.accounts.idMap;

  const remaining = STORES.filter((name) => name !== 'people' && name !== 'accounts');

  if (mode === 'replace') {
    // Everything is the file's. The named stores are already written above.
    for (const storeName of remaining) {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      store.clear();
      (usable[storeName] || []).forEach((item) => {
        const record = stripSourceId(item, personMap, accountMap);
        if (storeName === 'transfers' && (!record.fromId || !record.toId)) { skipped++; return; }
        store.add(record);
        imported++;
      });
      await txDone(tx);
    }
  } else {
    for (const storeName of fileStores.filter((n) => remaining.includes(n))) {
      // Read existing keys on their own transaction first — mixing an await
      // into the readwrite transaction below would let it auto-commit early.
      const seen = new Set((await getAll(storeName)).map(importKeyOf));

      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);

      usable[storeName].forEach(item => {
        // A transfer whose endpoints didn't resolve to accounts we hold would
        // move money between places that don't exist. Drop it: a missing
        // transfer is visible and fixable, a balance that silently drifts
        // because of one is neither.
        if (storeName === 'transfers') {
          const mapped = stripSourceId(item, personMap, accountMap);
          if (!mapped.fromId || !mapped.toId || mapped.fromId === mapped.toId) { skipped++; return; }
          const key = importKeyOf(mapped);
          if (seen.has(key)) { skipped++; return; }
          seen.add(key);
          store.add(mapped);
          imported++;
          return;
        }
        const key = importKeyOf(item);
        if (seen.has(key)) {
          skipped++;
          return;
        }
        seen.add(key);
        store.add(stripSourceId(item, personMap, accountMap));
        imported++;
      });

      await txDone(tx);
    }
  }

  if (imported === 0 && skipped === 0) throw new Error('Nothing to import in that file');
  return { imported, skipped, dropped };
}

// Writes one name-keyed store (people, accounts) and returns a map from the
// file's ids to this device's. In replace mode the store is wiped and every
// row in the file is written; in merge mode a row whose name we already hold
// points at the one we have rather than making a second.
async function writeNamedStore(storeName, keyOf, rows, mode, inFile) {
  const db = await openDB();
  const idMap = {};
  let imported = 0;
  let skipped = 0;

  if (!inFile) return { idMap, imported, skipped };

  // Only merge needs to know what this device already holds; replace wipes it.
  const existing = mode === 'merge'
    ? new Map((await getAll(storeName)).map((r) => [keyOf(r), r.id]))
    : new Map();

  const tx = db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);
  if (mode === 'replace') store.clear();

  for (const row of rows) {
    const key = keyOf(row);
    if (existing.has(key)) {
      idMap[row._sourceId] = existing.get(key);
      skipped++;
      continue;
    }
    const record = stripSourceId(row);
    store.add(record);
    idMap[row._sourceId] = record.id;
    existing.set(key, record.id);
    imported++;
  }

  await txDone(tx);
  return { idMap, imported, skipped };
}

// Drop the bookkeeping fields before a row is stored, and point its references
// at whichever local rows the file's ids turned out to mean. Imported rows are
// new rows on this device, so they get a fresh id from the same generator
// addItem() uses — leaving them to the store's counter would put numbers back
// into a store that's meant to hold UUIDs.
function stripSourceId(item, personMap, accountMap) {
  const { _sourceId, ...rest } = item;
  if (personMap && 'personId' in rest) rest.personId = personMap[item.personId] || null;
  if (accountMap) {
    if ('accountId' in rest) rest.accountId = accountMap[item.accountId] || null;
    // A transfer names its two endpoints. An endpoint we can't match means the
    // movement would land in an account that doesn't exist, so the transfer is
    // dropped rather than half-applied.
    if (rest.fromId !== undefined) rest.fromId = accountMap[rest.fromId] || null;
    if (rest.toId !== undefined) rest.toId = accountMap[rest.toId] || null;
  }
  return { id: newId(), ...rest };
}