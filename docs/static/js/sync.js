/* -----------------------------------------------------------------------------
   Sync

   What this syncs is a *snapshot*, not records. That is a deliberate choice and
   it is what makes the whole thing tractable:

   deleteItem() erases a record outright — there is no tombstone, no deletedAt.
   So a record-level merge ("last write wins on updatedAt") cannot tell a row
   deleted on the phone from one that never existed on the laptop, and would
   resurrect it every time the two devices met. Tombstones plus a garbage
   collection policy is the alternative, and it is a much larger thing to get
   right for no benefit at this scale.

   With snapshots, a delete is simply an absence, and absence travels. Two
   devices keep one file; whichever was written last is the truth. The cost is
   the one worth stating plainly: if both devices change things before either
   syncs, one set of changes is overwritten. The local copy is backed up before
   that happens, so nothing is lost without a trace.

   The file is transport-independent on purpose. Moving from a home server to
   Syncthing to anything else is a matter of pointing at a different URL, which
   is the answer to "how easy is it to switch devices in future".
   -------------------------------------------------------------------------- */

const SYNC_FORMAT = 1;
const SYNC_FILE = 'sorted-snapshot.json';

const SYNC_SETTINGS_KEY = 'sorted-sync-settings';
const SYNC_DEVICE_KEY = 'sorted-sync-device';
// The local copy is kept before any pull overwrites it. Without this, a sync
// that pulls a stale-but-newer-timestamped file takes unsynced local work with
// it, silently.
const SYNC_BACKUP_KEY = 'sorted-sync-backup';
const SYNC_TOUCHED_KEY = 'sorted-sync-touched';

// Which transports the app knows about. Only `lan` is implemented; the others
// are listed so the shape of the setting is visible and adding one is a matter
// of writing a `read`/`write` pair against the same two functions.
//
//  - lan        an always-on machine on the same Wi-Fi, reachable over HTTP
//  - tailscale  the same HTTP file over Tailscale, so it works off the home
//               network without exposing anything to the internet
//  - syncthing  a folder something else already syncs (not built yet)
//  - cloud      a hosted file, which would contradict "no cloud, no login"
const SYNC_TRANSPORTS = {
  lan: {
    label: 'Home server',
    available: true,
    blurb: 'An always-on machine on the same Wi-Fi',
    needsUrl: true,
    urlHint: 'http://192.168.1.10:8787/sorted-snapshot.json'
  },
  // Not a different mechanism: the same one HTTP file, reached over Tailscale's
  // private network instead of the home Wi-Fi. The sync host runs exactly as it
  // does for LAN, and the address is the machine's Tailscale IP, which is stable
  // wherever the machine is. So it works from a phone that is not at home, with
  // nothing exposed to the internet and no port forwarding.
  tailscale: {
    label: 'Tailscale',
    available: true,
    blurb: 'The same file over your private network, from anywhere',
    needsUrl: true,
    urlHint: 'http://100.x.y.z:8787/sorted-snapshot.json'
  },
  // A shared folder and nothing else. No server to leave running and no
  // address to type, which is the whole appeal: the folder is already there on
  // both machines because something else is keeping it there, and Sorted reads
  // and writes the same one file inside it. Listed because it was asked for,
  // still marked not built until the read side is written and tested.
  syncthing: {
    label: 'Syncthing folder',
    available: false,
    blurb: 'A folder you already sync, no server to keep running',
    needsUrl: true,
    urlHint: 'file:// path to the synced folder'
  },
  cloud: {
    label: 'Cloud',
    available: false,
    blurb: 'Works anywhere, but needs an account',
    needsUrl: true,
    urlHint: 'https://…'
  }
};

// What somebody actually does, for each one.
//
// This was missing and the card was asking the impossible: one address box, with
// nothing saying where the address comes from. "Paste an address" is only a step
// if someone knows which address, and only that somebody can tell.
//
// The two marked not built list the steps they will take rather than pretending
// otherwise — a blank option tells you nothing, and a wrong one costs an
// afternoon.
const SYNC_SETUP_STEPS = {
  lan: [
    'Put this phone and the computer on the same Wi-Fi.',
    'On the computer, open a terminal in the Sorted folder.',
    'Run <code>node tools/sync-host.mjs</code> and leave it running.',
    'It prints one line beginning <code>http://</code>. Copy that whole line.',
    'Paste it above, then tap <strong>Sync now</strong>.'
  ],
  tailscale: [
    'Install Tailscale on the computer that stays on, and sign in.',
    'Install Tailscale on this phone, and sign in to the same account.',
    'On the computer, run <code>node tools/sync-host.mjs</code> and leave it running.',
    'Open Tailscale on the computer and copy its IP — it starts <code>100.</code>',
    'Paste <code>http://that-ip:8787/sorted-snapshot.json</code> above, then tap <strong>Sync now</strong>.'
  ],
  syncthing: [
    'Install Syncthing on the computer and on this phone, and pair them.',
    'Pick a folder both of them sync.',
    'Tell Sorted which folder, then tap <strong>Sync now</strong>.'
  ],
  cloud: [
    'Sign in to a cloud drive that can be read and written from a phone.',
    'Give Sorted access to one file in it.',
    'Paste that file\'s address above, then tap <strong>Sync now</strong>.'
  ]
};

// ---------------------------------------------------------------- settings

function syncSettings() {
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(SYNC_SETTINGS_KEY) || 'null'); } catch (err) {
    // A corrupt setting is not worth failing to open Settings over.
    stored = null;
  }
  const set = stored && typeof stored === 'object' ? stored : {};
  const transport = SYNC_TRANSPORTS[set.transport] ? set.transport : 'lan';
  return {
    transport: transport,
    url: typeof set.url === 'string' ? set.url.trim() : '',
    auto: set.auto === true
  };
}

function setSyncSettings(patch) {
  const next = Object.assign(syncSettings(), patch || {});
  localStorage.setItem(SYNC_SETTINGS_KEY, JSON.stringify(next));
  return next;
}

// A stable id for this install, so a snapshot can say where it came from. Not
// used to resolve conflicts — there is no conflict resolution here, only a
// timestamp — but it makes a restored file legible when something looks wrong.
function syncDeviceId() {
  let id = localStorage.getItem(SYNC_DEVICE_KEY);
  if (!id) {
    id = 'device-' + Math.random().toString(36).slice(2, 10);
    localStorage.setItem(SYNC_DEVICE_KEY, id);
  }
  return id;
}

// ---------------------------------------------------------------- snapshot

function syncNowStamp() {
  return new Date().toISOString();
}

// When the data last changed — not when the snapshot was built.
//
// This distinction is the whole of whether sync can work. Stamping with the
// current time makes a fresh snapshot newer than the server on every pass, so
// the app would push every time, could never notice it had nothing to send, and
// could never pull: the server's file would always look stale.
//
// A deletion is the awkward case, and it is why records' own `updatedAt` is not
// enough on its own. Removing the newest bill leaves every surviving record
// untouched, so the data would look unchanged and the deletion would never
// travel. So writes record a stamp of their own here, and the snapshot carries
// whichever is later.
let syncApplying = false;

// Set by the database layer after anything that changes the data, including a
// delete and including a wipe. Guarded against the pull itself: applying a
// snapshot writes every row, and without the guard each sync would end by
// marking the local copy newer than the file it came from and immediately want
// to push it back.
function syncTouch() {
  if (syncApplying) return;
  localStorage.setItem(SYNC_TOUCHED_KEY, syncNowStamp());
}

function syncDataStamp(data) {
  const touched = Date.parse(localStorage.getItem(SYNC_TOUCHED_KEY) || '');
  let latest = Number.isFinite(touched) ? touched : 0;
  for (const name of STORES) {
    for (const item of (data && data[name]) || []) {
      const t = Date.parse(item && item.updatedAt);
      if (Number.isFinite(t) && t > latest) latest = t;
    }
  }
  return latest ? new Date(latest).toISOString() : syncNowStamp();
}

// Set while a snapshot is being written into the database, so the writes it
// makes don't count as a local change. Set here rather than inside syncNow()
// because the restore path needs it too.
async function applySyncSnapshot(snapshot) {
  syncApplying = true;
  try {
    await importDataToDB(snapshot.data, 'replace');
    localStorage.setItem(SYNC_TOUCHED_KEY, snapshot.updatedAt);
  } finally {
    syncApplying = false;
  }
  await loadPeople();
  await loadAccounts();
}

// Every record, in a form that is safe to compare and to write out. Ids and
// timestamps are kept: the export/import path already understands them, and
// re-deriving them here would mean two formats to keep in step.
async function buildSyncSnapshot() {
  const data = await getAllData();
  const counts = {};
  for (const name of STORES) counts[name] = (data[name] || []).length;
  return {
    format: SYNC_FORMAT,
    deviceId: syncDeviceId(),
    // When the data last changed, not when this was built — see syncDataStamp().
    updatedAt: syncDataStamp(data),
    counts: counts,
    data: data
  };
}

function isSyncSnapshot(value) {
  return !!value && typeof value === 'object'
    && value.format === SYNC_FORMAT
    && value.data && typeof value.data === 'object'
    && !Array.isArray(value.data)
    && typeof value.updatedAt === 'string';
}

// The newest of the two stamps, treating an unreadable one as older. A file with
// a corrupt timestamp is not a reason to refuse a sync, but it is not a reason
// to overwrite the local copy either.
function syncStamp(value) {
  const t = Date.parse(value && value.updatedAt);
  return Number.isFinite(t) ? t : 0;
}

async function readSyncSnapshot(url) {
  const res = await syncFetch(url, { method: 'GET' });
  if (res.status === 404) return null;          // nothing there yet
  if (!res.ok) throw new Error('Host said ' + res.status);
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch (err) {
    throw new Error("That file isn't a Sorted snapshot");
  }
  if (!isSyncSnapshot(parsed)) throw new Error("That file isn't a Sorted snapshot");
  return parsed;
}

async function writeSyncSnapshot(url, snapshot) {
  const res = await syncFetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(snapshot)
  });
  if (!res.ok) throw new Error('Host said ' + res.status);
  return true;
}

// ---------------------------------------------------------------- transport

// On the phone the page's own origin is https://localhost, so an http:// request
// to a machine on the Wi-Fi is blocked three times over: cleartext is off by
// default on modern Android, mixed content is off unless the app opts in, and
// CORS applies on top. CapacitorHttp is the documented way to make a request
// through the native layer instead of the WebView, and it sidesteps the first
// two. The browser build has none of this and goes straight to fetch.
async function syncFetch(url, options) {
  const cap = window.Capacitor;
  if (cap && cap.isNativePlatform && cap.isNativePlatform() && cap.CapacitorHttp) {
    const response = await cap.CapacitorHttp.request({
      url: url,
      method: options.method || 'GET',
      headers: options.headers || {},
      data: options.body,
      // Without this a PUT body arrives as form-encoded and the host reads
      // garbage rather than JSON.
      serializer: 'json',
      connectTimeout: 4000,
      readTimeout: 8000
    });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      text: async () => (typeof response.data === 'string'
        ? response.data : JSON.stringify(response.data))
    };
  }
  return fetch(url, options);
}

// ---------------------------------------------------------------- syncing

// One pass. Reports what it did rather than throwing on the ordinary outcomes,
// because "already up to date" is a result, not a failure.
async function syncNow() {
  const settings = syncSettings();
  const transport = SYNC_TRANSPORTS[settings.transport];
  if (!transport || !transport.available) {
    return { ok: false, error: 'That sync option is not available yet.' };
  }
  if (!settings.url) {
    return { ok: false, error: 'No address set for the sync.' };
  }

  let remote = null;
  try {
    remote = await readSyncSnapshot(settings.url);
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err), where: 'host' };
  }

  const local = await buildSyncSnapshot();

  if (!remote) {
    await writeSyncSnapshot(settings.url, local);
    return { ok: true, did: 'created', at: local.updatedAt };
  }

  const localT = syncStamp(local);
  const remoteT = syncStamp(remote);

  if (remoteT > localT) {
    // Keep what is here before it goes, always. This is the only thing standing
    // between a stale remote and lost local work.
    localStorage.setItem(SYNC_BACKUP_KEY, JSON.stringify(local));
    // replace, not merge. A snapshot is the whole truth, so merging would keep
    // the rows this device has that the file doesn't — which is exactly the
    // resurrection problem snapshots exist to avoid. It does mean a pull
    // rewrites every row and mints fresh ids for them, with person and account
    // references remapped to match: coherent, but a replacement rather than an
    // update.
    await applySyncSnapshot(remote);
    return { ok: true, did: 'pulled', at: remote.updatedAt, backup: true };
  }
  if (localT > remoteT) {
    await writeSyncSnapshot(settings.url, local);
    return { ok: true, did: 'pushed', at: local.updatedAt };
  }
  return { ok: true, did: 'none', at: local.updatedAt };
}

// When the local copy was replaced by a pull, so a settings page can offer it
// back. Held in localStorage rather than a file so it is available even if the
// filesystem permissions are not.
function syncBackup() {
  try { return JSON.parse(localStorage.getItem(SYNC_BACKUP_KEY) || 'null'); }
  catch (err) { return null; }
}

async function restoreSyncBackup() {
  const backup = syncBackup();
  if (!backup || !isSyncSnapshot(backup)) {
    return { ok: false, error: 'There is no backup to restore' };
  }
  await applySyncSnapshot(backup);
  localStorage.removeItem(SYNC_BACKUP_KEY);
  return { ok: true, at: backup.updatedAt };
}