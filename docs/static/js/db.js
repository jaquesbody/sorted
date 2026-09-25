// Sorted v2 - IndexedDB Database Layer

const DB_NAME = 'sorted-v2-db';
const DB_VERSION = 1;
const STORES = ['spend', 'due', 'savings', 'recurring'];

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
          const store = db.createObjectStore(name, { keyPath: 'id', autoIncrement: true });
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
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function addItem(storeName, item) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = store.add({ ...item, createdAt: new Date().toISOString() });
    request.onsuccess = () => resolve(request.result);
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
    const request = store.delete(id);
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
async function markDuePaid(dueItem) {
  const { id, ...rest } = dueItem;
  const db = await openDB();
  const tx = db.transaction(['spend', 'due'], 'readwrite');
  const now = new Date().toISOString();

  tx.objectStore('spend').add({
    ...rest,
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

async function getAllData() {
  return {
    spend: await getAll('spend'),
    due: await getAll('due'),
    savings: await getAll('savings'),
    recurring: await getAll('recurring')
  };
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

// mode 'merge'  — keep everything stored, add only entries not already there
//                 (existing wins; duplicates inside the file are skipped too)
// mode 'replace' — restore semantics: the file becomes the data set; every
//                 store is cleared first, even ones missing from the file.
async function importDataToDB(data, mode = 'merge') {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error("That file isn't a Sorted backup");
  }

  const fileStores = STORES.filter(name => Array.isArray(data[name]));
  if (fileStores.length === 0) {
    throw new Error('No Sorted data found in that file');
  }

  const db = await openDB();
  let imported = 0;
  let skipped = 0;

  if (mode === 'replace') {
    for (const storeName of STORES) {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      store.clear();
      if (fileStores.includes(storeName)) {
        data[storeName].forEach(item => {
          if (!item || typeof item !== 'object') return;
          const { id, ...rest } = item; // strip old ids; autoIncrement assigns new ones
          store.add(rest);
          imported++;
        });
      }
      await txDone(tx);
    }
  } else {
    for (const storeName of fileStores) {
      // Read existing keys on their own transaction first — mixing an await
      // into the readwrite transaction below would let it auto-commit early.
      const seen = new Set((await getAll(storeName)).map(importKeyOf));

      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);

      data[storeName].forEach(item => {
        if (!item || typeof item !== 'object') return;
        const { id, ...rest } = item;
        const key = importKeyOf(rest);
        if (seen.has(key)) {
          skipped++;
          return;
        }
        seen.add(key);
        store.add(rest);
        imported++;
      });

      await txDone(tx);
    }
  }

  if (imported === 0 && skipped === 0) throw new Error('Nothing to import in that file');
  return { imported, skipped };
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
