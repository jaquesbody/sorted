/*
 * The folder and file routes, in a desktop browser.
 *
 * On Android these are a Capacitor plugin: the system picker hands back a tree
 * or a document URI, and the plugin reads and writes through the content
 * resolver. A page has no such thing, which is why the browser build used to
 * offer the Network route and nothing else.
 *
 * Chrome and Edge on a desktop do have an equivalent, and it is a close one:
 * the File System Access API returns a handle to a directory or a file, and
 * that handle can be stored and used again after a reload. Syncthing keeps a
 * folder in step on the desktop exactly as it does on a phone, and a drive's
 * desktop app keeps a folder in step, so both routes become testable there.
 *
 * The handles live in their own small IndexedDB database rather than in the
 * app's, because adding a store to the app's database is a schema migration for
 * something that is not app data. The settings keep a short synthetic id
 * (`browser:dir`, `browser:file`); the handle itself never goes in
 * localStorage, which cannot hold one.
 *
 * Firefox and Safari do not implement the pickers. There `provider()` returns
 * null and the card does not offer these routes, which is the same answer the
 * browser gave before: not offered rather than offered and then explained.
 */

const BROWSER_SYNC_HANDLE_DB = 'sorted-sync-handles';
const BROWSER_SYNC_HANDLE_STORE = 'handles';
const BROWSER_SYNC_DIR_URI = 'browser:dir';
const BROWSER_SYNC_FILE_URI = 'browser:file';

let browserSyncHandleDb = null;

function openBrowserSyncHandleDB() {
  if (browserSyncHandleDb) return browserSyncHandleDb;
  browserSyncHandleDb = new Promise((resolve, reject) => {
    const request = indexedDB.open(BROWSER_SYNC_HANDLE_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(BROWSER_SYNC_HANDLE_STORE)) {
        db.createObjectStore(BROWSER_SYNC_HANDLE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  // A failed open must not poison the cache for the next attempt.
  browserSyncHandleDb.catch(() => { browserSyncHandleDb = null; });
  return browserSyncHandleDb;
}

async function loadBrowserSyncHandle(key) {
  const db = await openBrowserSyncHandleDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BROWSER_SYNC_HANDLE_STORE, 'readonly');
    const request = tx.objectStore(BROWSER_SYNC_HANDLE_STORE).get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function saveBrowserSyncHandle(key, handle) {
  const db = await openBrowserSyncHandleDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BROWSER_SYNC_HANDLE_STORE, 'readwrite');
    tx.objectStore(BROWSER_SYNC_HANDLE_STORE).put(handle, key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function dropBrowserSyncHandle(key) {
  const db = await openBrowserSyncHandleDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BROWSER_SYNC_HANDLE_STORE, 'readwrite');
    tx.objectStore(BROWSER_SYNC_HANDLE_STORE).delete(key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

function browserSyncSupported() {
  return typeof window !== 'undefined'
    && typeof window.showDirectoryPicker === 'function'
    && typeof window.showOpenFilePicker === 'function'
    && typeof window.showSaveFilePicker === 'function'
    && window.isSecureContext !== false;
}

// Closing a picker is a decision, not a fault. Android's plugin answers with
// `cancelled`; the browser throws AbortError, which would otherwise reach the
// card as "The user aborted a request."
function browserPickerCancelled(err) {
  return !!err && (err.name === 'AbortError' || err.code === 20);
}

// A handle can be remembered across a reload, but the permission to use it can
// lapse. Asking again is allowed only while the page has the user's attention
// (a click), which is exactly the manual Sync now press; an automatic sync has
// no gesture and has to wait for one rather than opening a permission prompt
// nobody asked for.
async function ensureBrowserSyncPermission(handle, mode, noun) {
  const thing = noun === 'file' ? 'file' : 'folder';
  if (!handle) {
    const err = new Error('That ' + thing + ' needs to be chosen again. Open Settings, choose it, then press Sync now.');
    err.needsPermission = true;
    throw err;
  }
  if (typeof handle.queryPermission !== 'function') return true;
  const options = { mode: mode || 'readwrite' };
  let state = await handle.queryPermission(options);
  if (state === 'granted') return true;
  const active = !!(navigator.userActivation && navigator.userActivation.isActive);
  if (state === 'prompt' && active && typeof handle.requestPermission === 'function') {
    state = await handle.requestPermission(options);
  }
  if (state !== 'granted') {
    const err = new Error('Sorted needs permission to use that ' + thing + '. Press Sync now to allow it.');
    err.needsPermission = true;
    throw err;
  }
  return true;
}

async function readBrowserFileHandle(handle, fileName, noun) {
  await ensureBrowserSyncPermission(handle, 'readwrite', noun);
  try {
    const fileHandle = fileName === null ? handle : await handle.getFileHandle(fileName);
    const file = await fileHandle.getFile();
    return { exists: true, data: await file.text() };
  } catch (err) {
    if (err && err.name === 'NotFoundError') return { exists: false };
    if (err && err.name === 'NotAllowedError') {
      const denied = new Error('Sorted can no longer use that ' + (noun === 'file' ? 'file' : 'folder') + '. Choose it again.');
      denied.needsPermission = true;
      throw denied;
    }
    throw err;
  }
}

async function writeBrowserFileHandle(handle, fileName, data, noun) {
  await ensureBrowserSyncPermission(handle, 'readwrite', noun);
  const fileHandle = fileName === null ? handle : await handle.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(data);
  } finally {
    await writable.close();
  }
  return { ok: true };
}

/*
 * The provider the rest of the app talks to, shaped exactly like the Android
 * plugin's: pick/read/write/forget for a folder, and pickFile/createFile/
 * readFile/writeFile for one document. Keeping the shape identical is what lets
 * syncNow() have one code path per mechanism rather than one per platform.
 */
function createSortedBrowserSync(fileName) {
  if (!browserSyncSupported()) return null;
  const JSON_TYPES = [{
    description: 'Sorted snapshot',
    accept: { 'application/json': ['.json'] }
  }];

  return {
    pick: async () => {
      try {
        const handle = await window.showDirectoryPicker({ id: 'sorted-sync-folder', mode: 'readwrite' });
        await saveBrowserSyncHandle('dir', handle);
        return { uri: BROWSER_SYNC_DIR_URI, name: handle.name || 'the folder you chose' };
      } catch (err) {
        if (browserPickerCancelled(err)) return { cancelled: true };
        throw err;
      }
    },

    read: async () => {
      const handle = await loadBrowserSyncHandle('dir');
      return readBrowserFileHandle(handle, fileName, 'folder');
    },

    write: async (options) => {
      const handle = await loadBrowserSyncHandle('dir');
      return writeBrowserFileHandle(handle, fileName, (options && options.data) || '', 'folder');
    },

    forget: async (options) => {
      const uri = String((options && options.uri) || '');
      await dropBrowserSyncHandle(uri === BROWSER_SYNC_FILE_URI ? 'file' : 'dir');
      return { ok: true };
    },

    pickFile: async () => {
      try {
        const picked = await window.showOpenFilePicker({ multiple: false, types: JSON_TYPES });
        const handle = picked && picked[0];
        if (!handle) return { cancelled: true };
        await saveBrowserSyncHandle('file', handle);
        return { uri: BROWSER_SYNC_FILE_URI, name: handle.name || fileName };
      } catch (err) {
        if (browserPickerCancelled(err)) return { cancelled: true };
        throw err;
      }
    },

    createFile: async () => {
      try {
        const handle = await window.showSaveFilePicker({ suggestedName: fileName, types: JSON_TYPES });
        await saveBrowserSyncHandle('file', handle);
        return { uri: BROWSER_SYNC_FILE_URI, name: handle.name || fileName };
      } catch (err) {
        if (browserPickerCancelled(err)) return { cancelled: true };
        throw err;
      }
    },

    readFile: async () => {
      const handle = await loadBrowserSyncHandle('file');
      return readBrowserFileHandle(handle, null, 'file');
    },

    writeFile: async (options) => {
      const handle = await loadBrowserSyncHandle('file');
      return writeBrowserFileHandle(handle, null, (options && options.data) || '', 'file');
    }
  };
}
