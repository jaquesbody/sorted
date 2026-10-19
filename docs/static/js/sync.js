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

// Which transports the app knows about.
//
//  - lan         an always-on machine on the same Wi-Fi, reachable over HTTP
//  - tailscale   the same HTTP file over Tailscale, so it works off the home
//                network without exposing anything to the internet
//  - syncthing   a folder something else already keeps in step
//  - cloud       a folder inside the person's own drive, which the same picker
//                reaches because the drive app publishes it as a place to save
//
// The last two are the same mechanism — a folder the person chooses, in which
// Sorted reads and writes one file — and they are listed separately because the
// two things they are called are how people find their own route. What is on the
// other end is not Sorted's business and is never asked about.
//
// `needsUrl` and `needsFolder` are what the card lays itself out from, so a
// route that has no address cannot show an address box and leave someone
// wondering what to type in it.
const SYNC_TRANSPORTS = {
  lan: {
    label: 'Home server',
    available: true,
    blurb: 'An always-on machine on the same Wi-Fi',
    needsUrl: true,
    urlHint: 'e.g. http://192.168.1.10:8787/sorted-snapshot.json'
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
    urlHint: 'e.g. http://100.101.102.103:8787/sorted-snapshot.json'
  },
  // A shared folder and nothing else. No server to leave running and no address
  // to type, which is the whole appeal: the folder is already there on both
  // machines because something else is keeping it there, and Sorted reads and
  // writes the same one file inside it.
  syncthing: {
    label: 'Syncthing',
    available: true,
    blurb: 'A folder you already sync, no server to keep running',
    needsFolder: true
  },
  // The same folder, living in a drive the person already pays for. Sorted has
  // no account and no server of its own here: the file goes into their own
  // drive, through their own drive app, which is the only reason this is not a
  // contradiction of "no cloud, no login".
  cloud: {
    label: 'Cloud',
    available: true,
    blurb: 'A folder in your own drive: Google Drive, Proton Drive, OneDrive',
    needsFolder: true
  }
};

// What somebody actually does, for each one.
//
// This was missing and the card was asking the impossible: one address box, with
// nothing saying where the address comes from. "Paste an address" is only a step
// if someone knows which address, and only that somebody can tell.
//
// Written to be followed by someone who has never opened a terminal, which is
// where the first pass failed: it named the two things to install without saying
// where from, and gave a command that only works from inside a folder nobody had
// been told to stand in. The text below is the user's, with the gaps filled.
//
// Two things were taken out at his ask and are worth not putting back: the
// aside that explained why the terminal has to be new (the word "new" stays;
// the reason reads as homework), and the aside about Node being missing or too
// old, which he called wordy. What is left under each command is one line.
//
// The steps are his own wording, tidied: he asked for no em dashes in them, for
// nodejs.org and git-scm.com to be links, and for Tailscale to carry its own
// instructions rather than sending the reader back to Home server.

// A line inside a step, set below the line above it. "Install two things" is not
// one sentence, and run together it read like one.
function setupPart(html) {
  return '<span class="setup-part">' + html + '</span>';
}

// A command, set apart from the sentence and given its own button.
//
// The button reads the command out of the <code> beside it rather than carrying
// a second copy in an attribute: one place holds the text, so the two cannot
// drift apart.
//
// <wbr> after each slash is where a long command is allowed to break. Without it
// the browser has no break opportunity inside a URL and falls back to cutting a
// word in half — "sorted.g" at the end of one line and "it" at the start of the
// next, for the clone address. A <wbr> is not a character: the text, and so what
// Copy puts on the clipboard, is exactly the command.
function setupCommand(command) {
  const wrappable = escapeHTML(command).replace(/\//g, '/<wbr>');
  return '<span class="setup-copy"><code>' + wrappable + '</code>'
    + '<button type="button" class="btn btn-ghost btn-copy"'
    + ' onclick="copySetupCommand(this)">Copy</button></span>';
}

// The line under a command that says the one thing that goes wrong with it.
function setupAside(html) {
  return '<span class="setup-aside">' + html + '</span>';
}

const SYNC_SETUP_STEPS = {
  lan: [
    'On a computer that stays on, and on the same Wi-Fi as this phone, install two things:'
      + setupPart('<strong>Node.js</strong>: get it from <a href="https://nodejs.org/en/download" target="_blank" rel="noopener">nodejs.org</a> and run the installer. It is the same download on Windows, Mac and Linux.')
      + setupPart('<strong>The Sorted folder</strong>: open a <strong>new</strong> terminal, paste this in and press enter:'
        + setupCommand('git clone https://github.com/jaquesbody/sorted.git')
        + setupAside('If it says <strong>git</strong> is not recognised, install Git from <a href="https://git-scm.com/install/" target="_blank" rel="noopener">git-scm.com</a> first, then run it again.')),

    'Start the sync host, in that same terminal:'
      + setupCommand('node sorted/tools/sync-host.mjs')
      + setupAside('Then leave it running.'),

    'It prints an address for each network it can see. Copy the Wi-Fi one: the address starting <strong>192.168.</strong>',

    'Paste it into the <strong>Address</strong> box above.',

    'Tap <strong>Sync now</strong>. Done.'
  ],
  tailscale: [
    'Install and set up <strong>Tailscale</strong> on the computer that stays on and on this phone, sign in on both, and connect them.',

    'On that computer, install two things:'
      + setupPart('<strong>Node.js</strong>: get it from <a href="https://nodejs.org/en/download" target="_blank" rel="noopener">nodejs.org</a> and run the installer.')
      + setupPart('<strong>The Sorted folder</strong>: open a <strong>new</strong> terminal, paste this in and press enter:'
        + setupCommand('git clone https://github.com/jaquesbody/sorted.git')
        + setupAside('If it says <strong>git</strong> is not recognised, install Git from <a href="https://git-scm.com/install/" target="_blank" rel="noopener">git-scm.com</a> first, then run it again.')),

    'Start the sync host, in that same terminal:'
      + setupCommand('node sorted/tools/sync-host.mjs')
      + setupAside('Then leave it running.'),

    'In Tailscale, find that computer\'s IP address. It starts with <strong>100.</strong>',

    'Paste it into the <strong>Address</strong> box above:'
      + setupPart('<code>http://100.101.102.103:8787/<wbr>sorted-snapshot.json</code>'),

    'Tap <strong>Sync now</strong>. Done.'
  ],
  syncthing: [
    'Install and set up <strong>Syncthing</strong> on the devices you want to connect, creating and then linking a specific <strong>Sorted</strong> folder.',

    'Tap <strong>Choose folder</strong> above and locate that <strong>Sorted</strong> folder.',

    'Tap <strong>Sync now</strong>.',

    'Repeat step 2 on the other devices. Done.'
  ],
  cloud: [
    'Install and set up the drive you use: <strong>Google Drive</strong>, <strong>Proton Drive</strong> or <strong>OneDrive</strong>, and sign in.',

    'Tap <strong>Choose folder</strong> above and then create/locate a specific <strong>Sorted</strong> folder inside that drive.',

    'Tap <strong>Sync now</strong>.',

    'Repeat step 2 on the other devices. Done.'
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
    // The folder route's whole setting: where the picker put us, and what to
    // call it on screen. Kept beside the address rather than instead of it, so
    // switching between a server and a folder does not lose either answer.
    folderUri: typeof set.folderUri === 'string' ? set.folderUri : '',
    folderName: typeof set.folderName === 'string' ? set.folderName : '',
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
  if (!res.ok) throw new Error('The host answered ' + res.status + '.');
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch (err) {
    throw new Error("That file isn't a Sorted snapshot");
  }
  if (!isSyncSnapshot(parsed)) throw new Error("That file isn't a Sorted snapshot");
  return parsed;
}

// A write can only fail at the address, and the host answers exactly one path,
// so the two cases are "wrong path" and "something else went wrong over there".
// "Host said 404" named neither.
async function writeSyncSnapshot(url, snapshot) {
  const res = await syncFetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(snapshot)
  });
  if (res.status === 404) {
    throw new Error('Nothing at that address on the host. It should end with /sorted-snapshot.json.');
  }
  if (!res.ok) throw new Error('The host answered ' + res.status + ', so nothing was saved.');
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
  const opts = options || {};
  // A probe has to report, not hang. fetch() has no timeout of its own, and an
  // address that silently drops packets — a machine that is off, a phone on the
  // wrong network — leaves the browser sitting there for over a minute before it
  // finally says "Failed to fetch". Only the probe passes a limit; syncing
  // itself does not, so a slow but working sync is never cut short.
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 0;
  if (cap && cap.isNativePlatform && cap.isNativePlatform() && cap.CapacitorHttp) {
    const response = await cap.CapacitorHttp.request({
      url: url,
      method: opts.method || 'GET',
      headers: opts.headers || {},
      data: opts.body,
      // Without this a PUT body arrives as form-encoded and the host reads
      // garbage rather than JSON.
      serializer: 'json',
      connectTimeout: timeoutMs || 4000,
      readTimeout: timeoutMs || 8000
    });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      text: async () => (typeof response.data === 'string'
        ? response.data : JSON.stringify(response.data))
    };
  }
  if (timeoutMs && typeof AbortController === 'function') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, Object.assign({}, opts, { signal: controller.signal }));
    } finally {
      clearTimeout(timer);
    }
  }
  return fetch(url, opts);
}

// ---------------------------------------------------------------- the folder

// The second transport, and the one with no address in it.
//
// On Android a small native plugin wraps the system folder picker and the one
// file inside whatever folder comes back. In a browser there is nothing to wrap,
// because a page cannot read a folder at all — so the two folder routes are not
// offered there, rather than offered and then explained away.
let syncFolderCap = null;

function syncFolderPlugin() {
  const cap = window.Capacitor;
  if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) return null;
  if (typeof cap.registerPlugin !== 'function') return null;
  if (!syncFolderCap) syncFolderCap = cap.registerPlugin('SortedFolder');
  return syncFolderCap;
}

// Whether this build can use a folder at all. One function, because three places
// have to agree about it: the dropdown, the card, and the sync itself.
function syncFolderHere() {
  return !!syncFolderPlugin();
}

// What "ready to sync" means for a route: an address for the two that have one,
// a folder for the two that do not.
function syncRouteReady(transport, settings) {
  if (!transport || !transport.available) return false;
  return transport.needsFolder ? !!settings.folderUri : !!settings.url;
}

// Reading a folder the person chose. "No file" is the ordinary first-run answer
// rather than an error: the first sync creates it.
async function folderReadSnapshot(uri) {
  const plugin = syncFolderPlugin();
  if (!plugin) throw new Error('Syncing to a folder needs the phone app.');
  const res = await plugin.read({ uri: uri });
  if (!res || !res.exists) return null;
  let parsed;
  try { parsed = JSON.parse(res.data); } catch (err) {
    throw new Error("The file in that folder isn't a Sorted snapshot.");
  }
  if (!isSyncSnapshot(parsed)) throw new Error("The file in that folder isn't a Sorted snapshot.");
  return parsed;
}

async function folderWriteSnapshot(uri, snapshot) {
  const plugin = syncFolderPlugin();
  if (!plugin) throw new Error('Syncing to a folder needs the phone app.');
  await plugin.write({ uri: uri, data: JSON.stringify(snapshot) });
  return true;
}

// ---------------------------------------------------------------- diagnosis

// fetch() says "Failed to fetch" for every one of: nothing listening, the wrong
// network, and a request the platform refused. Three different problems, one
// sentence that names none of them — and the address is the common cause. So
// name the address, and say what to look at.
function syncHostBase(url) {
  try { return new URL(url).origin; } catch (err) { return null; }
}

function syncReachMessage(url, err) {
  const raw = String((err && err.message) || err);
  const isTransport = /failed to fetch|networkerror|network error|load failed|timed? ?out|abort/i.test(raw);
  if (!isTransport) return raw;
  return 'No answer from ' + (syncHostBase(url) || url)
    + '. Is the host running, and can this device reach it?';
}

// What a failed sync asks: is there a Sorted host at the other end, and what
// does it hold? The host answers /health with exactly that, and it is the
// difference between "the machine is not running", "something else is on that
// port" and "the host is fine, the address is not its file" — three outcomes
// that reach the user as one sentence if nobody asks.
//
// There is no button for this any more. Adding one made the card longer for
// everybody to answer a question only a failure asks, so the failure asks it.
async function syncTestAddress() {
  const settings = syncSettings();
  const transport = SYNC_TRANSPORTS[settings.transport];
  if (!transport || !transport.available) {
    return { state: 'unavailable', message: 'That sync option is not available yet.' };
  }
  const url = settings.url;
  if (!url) return { state: 'empty', message: 'Put the address in first.' };
  const base = syncHostBase(url);
  if (!base) {
    return { state: 'malformed', message: 'That is not a web address. Copy the whole line the host printed.' };
  }
  // The host answers two paths: the snapshot and /health. Two of the ways this
  // is got wrong are visible without asking it anything, and they are the two
  // cheapest to fix.
  if (!/\/sorted-snapshot\.json$/.test(new URL(url).pathname)) {
    return { state: 'wrong-path', message: 'The address has to end with /sorted-snapshot.json — that is the only file the host serves.' };
  }

  let res;
  try {
    res = await syncFetch(base + '/health', { method: 'GET', timeoutMs: 6000 });
  } catch (err) {
    return { state: 'unreachable', message: 'No answer from ' + base + '. Is the host running, and can this device reach it?' };
  }
  let body = null;
  try { body = JSON.parse(await res.text()); } catch (err) { body = null; }
  if (!res.ok || !body || body.ok !== true) {
    return { state: 'not-the-host', message: 'Something answered at ' + base + ', but it is not the Sorted host.' };
  }
  if (body.snapshot) {
    return { state: 'ready-with-file', message: 'The host is running, and it already holds a snapshot. Sync now compares the two.' };
  }
  return { state: 'ready-empty', message: 'The host is running, with nothing in its folder yet. Sync now puts your data there.' };
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
  // A route that reads a folder has no address, and a route that fetches an
  // address has no folder. Asking each for the setting it actually uses is what
  // stops the wrong one's absence reading as "not set up".
  const byFolder = !!transport.needsFolder;
  if (byFolder && !settings.folderUri) {
    return { ok: false, error: 'No folder has been chosen yet.' };
  }
  if (!byFolder && !settings.url) {
    return { ok: false, error: 'No address set for the sync.' };
  }

  const readRemote = byFolder
    ? () => folderReadSnapshot(settings.folderUri)
    : () => readSyncSnapshot(settings.url);
  const writeRemote = byFolder
    ? (snapshot) => folderWriteSnapshot(settings.folderUri, snapshot)
    : (snapshot) => writeSyncSnapshot(settings.url, snapshot);

  let remote = null;
  try {
    remote = await readRemote();
  } catch (err) {
    const detail = String((err && err.message) || err);
    // A folder says what went wrong in the plugin's own words — a grant that has
    // lapsed, a folder that has been deleted or unmounted — and asking again
    // would only add jargon to a sentence that is already actionable. It is the
    // HTTP route that arrives here as "Failed to fetch": the browser's wording,
    // the same for a dead machine, a wrong network and a refused request, so
    // that one asks the host itself before reporting anything. A failure is rare
    // and the answer is what makes it fixable, so the extra round trip is worth
    // it; the probe gives up after six seconds either way.
    if (byFolder) {
      return { ok: false, error: detail, where: 'folder', detail: detail };
    }
    let message = syncReachMessage(settings.url, err);
    if (message !== detail) {
      const found = await syncTestAddress();
      message = found.state === 'ready-with-file' || found.state === 'ready-empty'
        // It answered, so the host is up and the file is the problem, which is
        // not a state any of the four messages describes.
        ? 'The host is running at ' + (syncHostBase(settings.url) || settings.url) + ', but it did not serve that file. Try Sync now again.'
        : found.message;
    }
    return { ok: false, error: message, where: 'host', detail: detail };
  }

  const local = await buildSyncSnapshot();

  if (!remote) {
    await writeRemote(local);
    return { ok: true, did: 'created', at: local.updatedAt };
  }

  const localT = syncStamp(local);
  const remoteT = syncStamp(remote);

  if (remoteT > localT) {
    // Keep what is here before it goes, always. This is the only thing standing
    // between a stale remote and lost local work.
    stashReplacedCopy(local);
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
    await writeRemote(local);
    return { ok: true, did: 'pushed', at: local.updatedAt };
  }
  return { ok: true, did: 'none', at: local.updatedAt };
}

// When the local copy was replaced by a pull, so a settings page can offer it
// back. Held in localStorage rather than a file so it is available even if the
// filesystem permissions are not.
// Keep what is here before it is replaced, always. Both paths that wipe the
// data go through this one — a pull, and the user's own "Replace all stored
// data" button — because the alternative is a database with no way back.
//
// The import path did not do this. Its replace commits store by store, so a
// failure in the seventh leaves stores one to six already the file's and the rest
// the old set, and the user reads "Import failed" with half their data gone and
// no copy anywhere. Now a replace stashes first, and the Restore button in the
// Sync card is what gets it back.
//
// In localStorage, not a file: it has to be available even if the export ever
// fails, and a backup nobody can reach is not a backup. The quota is 5MB-ish and
// a snapshot with receipts can exceed it, so the write is guarded and its
// failure never stops the import that called it.
function stashReplacedCopy(snapshot) {
  try {
    localStorage.setItem(SYNC_BACKUP_KEY, JSON.stringify(snapshot));
    return true;
  } catch (err) {
    console.warn('Could not keep a copy of the current data:', err);
    return false;
  }
}

// The current data as a snapshot, so what `stashReplacedCopy` keeps is the same
// shape restoreSyncBackup() expects. A plain `getAllData()` would keep the rows
// but not the envelope, and restore would refuse it as "not a Sorted snapshot" —
// which reads to the user as their data being gone twice over.
async function buildReplacedCopy() {
  return { format: SYNC_FORMAT, updatedAt: new Date().toISOString(), data: await getAllData() };
}

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