// Sorted v2 - IndexedDB Database Layer

const DB_NAME = 'sorted-v2-db';
const DB_VERSION = 1;
const STORES = ['spend', 'due', 'savings', 'recurring'];

function openDB() {
  return new Promise((resolve, reject) => {
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
    
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
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

async function markDuePaid(dueItem) {
  const { id, ...rest } = dueItem;
  await addItem('spend', {
    ...rest,
    date: new Date().toISOString().slice(0, 10),
    confirmed: true,
    paid: true
  });
  await deleteItem('due', id);
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

async function seedIfEmpty() {
  const existing = await getAll('spend');
  if (existing.length > 0) return;
  
  // Sample spend data
  await addItem('spend', {
    title: 'Electricity: Co-op Energy',
    date: '2026-08-16',
    amount: 283.65,
    category: 'Utilities',
    recurring: true,
    frequency: 'monthly',
    confirmed: true,
    paid: true
  });
  
  await addItem('spend', {
    title: 'Fuel: Spar',
    date: '2026-08-26',
    amount: 40.05,
    category: 'Motor',
    recurring: false,
    confirmed: true,
    paid: true
  });
  
  await addItem('spend', {
    title: 'Beer: Cash',
    date: '2026-08-29',
    amount: 10.00,
    category: 'Entertainment',
    recurring: false,
    confirmed: false,
    paid: false
  });
  
  // Sample due data
  await addItem('due', {
    title: 'Mortgage',
    dueDate: '2026-09-03',
    amount: 98.00,
    category: 'Mortgage',
    recurring: true,
    frequency: 'monthly'
  });
  
  await addItem('due', {
    title: 'Electricity: Co-op Energy',
    dueDate: '2026-09-16',
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
