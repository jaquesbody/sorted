/* =============================================================================
   db.js
   IndexedDB wrapper for Sorted. No backend, no cloud — local only,
   per protocol.md 3.3 / non-goal "no cloud storage."
   ============================================================================= */

const DB_NAME = 'sorted-db';
const DB_VERSION = 1;
const STORES = ['spend', 'due', 'savings'];

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      STORES.forEach((name) => {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'id', autoIncrement: true });
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

async function addItem(storeName, item) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = store.add(item);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function updateItem(storeName, item) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = store.put(item);
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

/* -----------------------------------------------------------------------------
   Mark a Due item paid: creates the matching Spend entry, removes the Due
   entry. This is the single source of truth for "confirmed and paid" moving
   an item from Due to Spend — see project.md Architecture Decisions.
   ----------------------------------------------------------------------------- */

async function markDuePaid(dueItem) {
  const { id, ...rest } = dueItem;
  await addItem('spend', {
    ...rest,
    date: new Date().toISOString().slice(0, 10),
    confirmed: true,
    paid: true,
  });
  await deleteItem('due', id);
}

/* -----------------------------------------------------------------------------
   First-run seed — matches the mockup data used throughout the build so the
   app looks the same on first load, not empty.
   ----------------------------------------------------------------------------- */

async function seedIfEmpty() {
  const existingSpend = await getAll('spend');
  if (existingSpend.length > 0) return;

  await addItem('spend', {
    title: 'Electricity: Co-op Energy',
    date: '2026-04-16',
    amount: 283.65,
    category: 'Utilities',
    recurring: true,
    frequency: 'monthly',
    confirmed: true,
    paid: true,
  });
  await addItem('spend', {
    title: 'Fuel: Spar',
    date: '2026-08-26',
    amount: 40.05,
    category: 'Motor',
    recurring: false,
    frequency: null,
    confirmed: true,
    paid: true,
  });
  await addItem('spend', {
    title: 'Beer: cash',
    date: '2026-08-29',
    amount: 10.00,
    category: 'Entertainment',
    recurring: false,
    frequency: null,
    confirmed: false,
    paid: false,
  });

  await addItem('due', {
    title: 'Mortgage',
    dueDate: '2026-09-03',
    amount: 98.00,
    category: 'Mortgage',
    recurring: true,
    frequency: 'monthly',
  });
  await addItem('due', {
    title: 'Electricity: Co-op Energy',
    dueDate: '2026-09-16',
    amount: 24.10,
    category: 'Utilities',
    recurring: true,
    frequency: 'monthly',
  });

  await addItem('savings', {
    title: 'Holiday',
    category: 'Holiday',
    current: 60.00,
    target: 500.00,
  });
  await addItem('savings', {
    title: 'Car',
    category: 'Car',
    current: 40.00,
    target: 500.00,
  });
}
