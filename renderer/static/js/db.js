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

async function importData(data) {
  const db = await openDB();
  
  for (const [storeName, items] of Object.entries(data)) {
    if (STORES.includes(storeName) && Array.isArray(items)) {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      
      items.forEach(item => {
        const { id, ...rest } = item;
        store.add(rest);
      });
    }
  }
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
