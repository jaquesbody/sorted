// Sorted v2 - IndexedDB Database Layer

const DB_NAME = 'sorted-v2-db';
// v2 adds the `people` store. Nothing else changed: new rows get their own
// generated id, so the existing stores keep the key generator they were
// created with and no record has to be rewritten.
const DB_VERSION = 2;
const STORES = ['spend', 'due', 'savings', 'recurring', 'people'];

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
          // People always get an explicit id (a person's row is created with
          // one already), so there's no reason to give this store a key
          // generator. Nothing else changes: existing stores are left alone.
          const store = db.createObjectStore(name, name === 'people'
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
    const request = store.put({ ...item, updatedAt: new Date().toISOString() });
    request.onsuccess = () => resolve(request.result);
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

// Same day next month, clamped to the month's length (31 Jan → 28 Feb).
// Missing/unparseable dueDates roll from today's date instead.
function nextDueDate(dueDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dueDate || '');
  let y, mo, d;
  if (m) {
    y = Number(m[1]); mo = Number(m[2]); d = Number(m[3]);
  } else {
    const t = new Date();
    y = t.getFullYear(); mo = t.getMonth() + 1; d = t.getDate();
  }
  const ny = mo === 12 ? y + 1 : y;
  const nm = mo === 12 ? 1 : mo + 1;
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
async function markDuePaid(dueItem, payerId) {
  const { id, ...rest } = dueItem;
  const db = await openDB();
  const tx = db.transaction(['spend', 'due'], 'readwrite');
  const now = new Date().toISOString();

  tx.objectStore('spend').add({
    // An id of its own, like any other new row — left to the store's counter
    // this would be the one row in the app that came out as a number.
    id: newId(),
    ...rest,
    personId: payerId || rest.personId || null,
    date: localISO(),
    confirmed: true,
    paid: true,
    createdAt: now
  });

  if (dueItem.recurring) {
    tx.objectStore('due').put({
      ...rest,
      id,
      dueDate: nextDueDate(rest.dueDate),
      updatedAt: now
    });
  } else {
    tx.objectStore('due').delete(id);
  }

  await txDone(tx);
}

// Everything, for the backup. Driven off STORES so a new store can't be
// forgotten here — people missing from a backup would strip every entry's
// attribution on the next restore.
async function getAllData() {
  const out = {};
  for (const name of STORES) out[name] = await getAll(name);
  return out;
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

  // Who this entry belongs to. The value is kept as it came: on import,
  // stripSourceId() translates the file's id into one of this device's, and
  // anything it can't match ends up null rather than dangling.
  out.personId = item.personId || null;

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

  const personMap = {};
  // Only merge needs to know who this device already holds; replace wipes them.
  const sourceByName = mode === 'merge'
    ? new Map((await getAll('people')).map((p) => [p.name.toLowerCase(), p.id]))
    : new Map();

  if (mode === 'replace') {
    // Everything is the file's, including the people.
    const peopleTx = db.transaction('people', 'readwrite');
    const peopleStore = peopleTx.objectStore('people');
    peopleStore.clear();
    (usable.people || []).forEach((person) => {
      const record = stripSourceId(person);
      peopleStore.add(record);
      personMap[person._sourceId] = record.id;
      imported++;
    });
    await txDone(peopleTx);

    for (const storeName of STORES) {
      if (storeName === 'people') continue;
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      store.clear();
      (usable[storeName] || []).forEach((item) => {
        store.add(stripSourceId(item, personMap));
        imported++;
      });
      await txDone(tx);
    }
  } else {
    // People first, so their local ids exist before the entries use them.
    const known = new Set(sourceByName.keys());
    const tx = db.transaction('people', 'readwrite');
    const store = tx.objectStore('people');
    (usable.people || []).forEach((person) => {
      const key = person.name.toLowerCase();
      if (known.has(key)) {
        // Already have this person (in this file twice, or already stored):
        // point at the one we hold rather than making a second.
        personMap[person._sourceId] = sourceByName.get(key);
        skipped++;
        return;
      }
      known.add(key);
      const record = stripSourceId(person);
      store.add(record);
      personMap[person._sourceId] = record.id;
      sourceByName.set(key, record.id);
      imported++;
    });
    await txDone(tx);

    for (const storeName of fileStores) {
      if (storeName === 'people') continue;
      // Read existing keys on their own transaction first — mixing an await
      // into the readwrite transaction below would let it auto-commit early.
      const seen = new Set((await getAll(storeName)).map(importKeyOf));

      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);

      usable[storeName].forEach(item => {
        const key = importKeyOf(item);
        if (seen.has(key)) {
          skipped++;
          return;
        }
        seen.add(key);
        store.add(stripSourceId(item, personMap));
        imported++;
      });

      await txDone(tx);
    }
  }

  if (imported === 0 && skipped === 0) throw new Error('Nothing to import in that file');
  return { imported, skipped, dropped };
}

// Drop the bookkeeping fields before a row is stored, and point its personId
// at whichever local person the file's id turned out to mean. Imported rows
// are new rows on this device, so they get a fresh id from the same generator
// addItem() uses — leaving them to the store's counter would put numbers back
// into a store that's meant to hold UUIDs.
function stripSourceId(item, personMap) {
  const { _sourceId, ...rest } = item;
  if (personMap && 'personId' in rest) rest.personId = personMap[item.personId] || null;
  return { id: newId(), ...rest };
}

// Seeding runs at most once per page load, shared across callers. The
// pre-memo version awaited getAll() inside each call, so two renders
// interleave could both see an empty store and seed the samples twice;
// the synchronous memo makes that impossible, skips the existence check
// on every later render, and is dropped on failure so a retry is possible.
let seedPromise = null;

function seedIfEmpty() {
  if (!seedPromise) {
    seedPromise = doSeed().catch((err) => {
      seedPromise = null;
      throw err;
    });
  }
  return seedPromise;
}

async function doSeed() {
  const [spend, due, savings] = await Promise.all([
    getAll('spend'), getAll('due'), getAll('savings')
  ]);
  // Only a genuinely untouched database gets samples — checking spend
  // alone used to re-seed everything (duplicate bills included) whenever
  // only the spend entries had been cleared.
  if (spend.length > 0 || due.length > 0 || savings.length > 0) return;

  // Dates are generated relative to today so a fresh install always looks
  // current: spend lands inside the current month and the bills sit one
  // overdue and one upcoming, instead of ageing out as the calendar moves.
  const iso = localISO; // utils.js — local dates, unlike toISOString()
  const daysFromNow = (n) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return iso(d);
  };
  // Spread through the current month — fraction 0 ≈ today, 1 = the 1st —
  // so the sample spend can never fall outside "this month" on the dashboard.
  const thisMonth = (fraction) => {
    const now = new Date();
    const elapsed = now.getDate();
    const day = Math.max(1, elapsed - Math.round(elapsed * fraction));
    return iso(new Date(now.getFullYear(), now.getMonth(), day));
  };

  // Sample spend data
  await addItem('spend', {
    title: 'Electricity: Co-op Energy',
    date: thisMonth(0.1),
    amount: 283.65,
    category: 'Utilities',
    recurring: true,
    frequency: 'monthly',
    confirmed: true,
    paid: true
  });
  
  await addItem('spend', {
    title: 'Fuel: Spar',
    date: thisMonth(0.5),
    amount: 40.05,
    category: 'Motor',
    recurring: false,
    confirmed: true,
    paid: true
  });
  
  await addItem('spend', {
    title: 'Beer: Cash',
    date: thisMonth(0.85),
    amount: 10.00,
    category: 'Entertainment',
    recurring: false,
    confirmed: false,
    paid: false
  });
  
  // Sample due data — one upcoming, one already overdue so the bills page
  // demonstrates both states.
  await addItem('due', {
    title: 'Mortgage',
    dueDate: daysFromNow(6),
    amount: 98.00,
    category: 'Mortgage',
    recurring: true,
    frequency: 'monthly'
  });
  
  await addItem('due', {
    title: 'Electricity: Co-op Energy',
    dueDate: daysFromNow(-4),
    amount: 24.10,
    category: 'Utilities',
    recurring: true,
    frequency: 'monthly'
  });
  
  // Sample savings
  await addItem('savings', {
    title: 'Holiday Fund',
    category: 'Holiday',
    current: 60.00,
    target: 500.00,
  });
  
  await addItem('savings', {
    title: 'Car Fund',
    category: 'Car',
    current: 40.00,
    target: 500.00,
  });
}
