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

// Which transports the app knows about. Three, not four.
//
// The first pass listed the mechanism twice for each half: "Home server" and
// "Tailscale" were the same HTTP file on two networks, and "Syncthing" and
// "Cloud" were the same chosen thing carrying the file. Four names for two
// mechanisms, and two of the four needed a computer left running. They are now
// the three the user asked for:
//
//  - syncthing   a folder something else already keeps in step
//  - cloud       one file in the person's own drive
//  - network     a computer that serves the file, on Wi-Fi or Tailscale
//
// The last one holds both addresses because they are the same file on the same
// host, reached two ways. Trying the Wi-Fi one and then the Tailscale one is not
// a conflict: whichever answers is the one the write goes back to.
//
// `needsUrl`, `needsFolder` and `needsFile` are what the card lays itself out
// from, so a route that has no address cannot show an address box and leave
// someone wondering what to type in it.
const SYNC_TRANSPORTS = {
  syncthing: {
    label: 'Syncthing',
    available: true,
    blurb: 'A folder you already sync, no server to keep running',
    needsFolder: true
  },
  cloud: {
    label: 'Cloud',
    available: true,
    blurb: 'One file in your own drive: Google Drive, Proton Drive, OneDrive',
    needsFile: true
  },
  network: {
    label: 'Network',
    available: true,
    blurb: 'A computer on your Wi-Fi, or the same file over Tailscale',
    needsUrl: true,
    urlHint: 'e.g. http://192.168.1.10:8787/sorted-snapshot.json'
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
  network: [
    'On a computer that stays on, and on the same Wi-Fi as this phone, install two things:'
      + setupPart('<strong>Node.js</strong>: get it from <a href="https://nodejs.org/en/download" target="_blank" rel="noopener">nodejs.org</a> and run the installer. It is the same download on Windows, Mac and Linux.')
      + setupPart('<strong>The Sorted folder</strong>: open a <strong>new</strong> terminal, paste this in and press enter:'
        + setupCommand('git clone https://github.com/jaquesbody/sorted.git')
        + setupAside('If it says <strong>git</strong> is not recognised, install Git from <a href="https://git-scm.com/install/" target="_blank" rel="noopener">git-scm.com</a> first, then run it again.')),

    'Start the sync host, in that same terminal:'
      + setupCommand('node sorted/tools/sync-host.mjs')
      + setupAside('Then leave it running.'),

    'It prints an address for each network it can see. Copy the Wi-Fi one, the address starting <strong>192.168.</strong>, into the <strong>Wi-Fi</strong> box above.',

    'To sync away from home, install and set up <strong>Tailscale</strong> on the computer and this phone, sign in on both, and connect them. Then copy that computer\'s address starting <strong>100.</strong> into the <strong>Tailscale</strong> box above.'
      + setupPart('<span class="setup-example">http://100.101.102.103:8787/<wbr>sorted-snapshot.json</span>'),

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

    'On the first device, tap <strong>Save new copy</strong> above and save <strong>sorted-snapshot.json</strong> into that drive.',

    'Tap <strong>Sync now</strong>.',

    'On the other devices, tap <strong>Choose file</strong> above and pick that same file, then tap <strong>Sync now</strong>. Done.',

    'Run <strong>Save new copy</strong> once, and on one device only. It makes a new file in the drive each time it is used, and every other device has to point at that same file with <strong>Choose file</strong>. Once the first copy is made, later devices just choose that file and press <strong>Sync now</strong>.'
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

  // Two routes became one, and the old names have to keep working. A phone that
  // was set up on "Home server" keeps its address in the Wi-Fi box; one set up
  // on "Tailscale" keeps its address in the Tailscale box. A setting written
  // before the split has only `url`, and it was the Wi-Fi one by default.
  const legacy = set.transport;
  let transport = legacy === 'lan' || legacy === 'tailscale' ? 'network' : legacy;
  if (!SYNC_TRANSPORTS[transport]) transport = 'network';

  let urlLan = typeof set.urlLan === 'string' ? set.urlLan.trim() : '';
  let urlTailscale = typeof set.urlTailscale === 'string' ? set.urlTailscale.trim() : '';
  const oldUrl = typeof set.url === 'string' ? set.url.trim() : '';
  if (legacy === 'lan' && !urlLan) urlLan = oldUrl;
  else if (legacy === 'tailscale' && !urlTailscale) urlTailscale = oldUrl;
  else if (legacy !== 'lan' && legacy !== 'tailscale' && !urlLan && !urlTailscale) urlLan = oldUrl;

  return {
    transport: transport,
    urlLan: urlLan,
    urlTailscale: urlTailscale,
    // Kept for callers and settings written before the addresses were split.
    // New code asks for one of the two boxes, never this.
    url: urlLan || urlTailscale,
    // The folder route's whole setting: where the picker put us, and what to
    // call it on screen. Kept beside the addresses rather than instead of them,
    // so switching routes does not lose an answer.
    folderUri: typeof set.folderUri === 'string' ? set.folderUri : '',
    folderName: typeof set.folderName === 'string' ? set.folderName : '',
    // The Cloud route's setting, and a different shape from a folder on purpose:
    // the system's Save-to picker creates one document and hands back that
    // document's URI, which is what Proton and others expose. A folder tree
    // needs a provider that publishes a browseable tree, and Proton does not.
    fileUri: typeof set.fileUri === 'string' ? set.fileUri : '',
    fileName: typeof set.fileName === 'string' ? set.fileName : '',
    // A document the Save-to picker has just made is empty on purpose, and some
    // providers (Proton) cannot be read until their first upload has finished.
    // The first sync after Save new copy therefore writes without reading.
    // `fileOwned` marks the device that made the file, so a later read that
    // fails with the provider's pending-upload error is this device's own
    // upload still finishing rather than a dead file. Only that device gets the
    // leniency; on any other device the same answer is a fault.
    fileNew: set.fileNew === true,
    fileOwned: set.fileOwned === true,
    // When this device last wrote the document successfully. Proton keeps
    // uploading after the write returns, and a second write during that window
    // fails with "that file could not be opened for writing". This is what tells
    // an empty or pending read apart from a document that really is empty.
    filePushedAt: typeof set.filePushedAt === 'string' ? set.filePushedAt : ''
  };
}

function setSyncSettings(patch) {
  const asked = patch || {};
  const next = Object.assign({}, syncSettings(), asked);
  // A caller from before the addresses were split passes one `url` and, often,
  // one of the old transport names. That address is mapped to the box its
  // transport named, and only when the patch does not also carry a box of its
  // own. Reading the patch rather than the merged settings matters: merging has
  // already copied the patch over the fields this compares.
  if (typeof asked.url === 'string'
      && typeof asked.urlLan !== 'string' && typeof asked.urlTailscale !== 'string') {
    if (asked.transport === 'tailscale') next.urlTailscale = asked.url.trim();
    else next.urlLan = asked.url.trim();
  }
  delete next.url;
  localStorage.setItem(SYNC_SETTINGS_KEY, JSON.stringify(next));
  return syncSettings();
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
  // A stamp never moves backwards, and a change always moves it forwards.
  //
  // The ordinary case is "now". The case that matters is a copy pulled from a
  // device whose clock is ahead: the local stamp then sits in the future, and
  // writing "now" over it would make the next real change look older than the
  // copy it was made on top of, so the next sync would pull that copy back over
  // the change. One millisecond past the stamp already here is enough to say
  // "newer than the thing I was made from" without inventing a wider gap.
  const previous = Date.parse(localStorage.getItem(SYNC_TOUCHED_KEY) || '');
  const now = Date.now();
  const next = Number.isFinite(previous) && previous >= now ? previous + 1 : now;
  localStorage.setItem(SYNC_TOUCHED_KEY, new Date(next).toISOString());
  scheduleAutoSync();
}

// A push settles the local stamp on the snapshot that was sent. Without this,
// an install with rows but no stamp of its own (one upgraded from before this
// existed) gives every build "now": the first push is right, but the next pass
// sees a newer local stamp and pushes the same data again, forever. The guard
// keeps a change made while the write was in flight, because that stamp is
// newer than the one that went out.
function syncRecordPushed(stamp) {
  const pushed = Date.parse(stamp || '');
  if (!Number.isFinite(pushed)) return;
  const current = Date.parse(localStorage.getItem(SYNC_TOUCHED_KEY) || '');
  if (Number.isFinite(current) && current >= pushed) return;
  localStorage.setItem(SYNC_TOUCHED_KEY, new Date(pushed).toISOString());
}

function syncDataStamp(data) {
  const touched = Date.parse(localStorage.getItem(SYNC_TOUCHED_KEY) || '');
  let latest = Number.isFinite(touched) ? touched : 0;
  let rows = 0;
  for (const name of STORES) {
    for (const item of (data && data[name]) || []) {
      rows++;
      const t = Date.parse(item && item.updatedAt);
      if (Number.isFinite(t) && t > latest) latest = t;
    }
  }
  if (latest) return new Date(latest).toISOString();
  // Never written to, and nothing in it: the beginning of time, so any real
  // file wins. Stamping this "now" was the worst fault in the whole route — a
  // fresh install is newer than every snapshot ever taken, so a new phone
  // pushed its empty database over the copy it was set up to receive, and the
  // phone that held the data pulled the empty file back. An install with rows
  // but no timestamps keeps the old answer: its age is unknown, and "now" is at
  // least never a reason to lose what is on the device.
  return rows === 0 ? new Date(0).toISOString() : syncNowStamp();
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

// How many records a snapshot actually holds. The file says so in `counts`, but
// that is written by whichever device wrote it and is not evidence; counting the
// rows is.
function syncRowCount(snapshot) {
  let rows = 0;
  for (const name of STORES) rows += ((snapshot && snapshot.data && snapshot.data[name]) || []).length;
  return rows;
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
//
// Where CapacitorHttp lives is the whole of whether any of this works. The
// bundle that ships as capacitor.js exports it as `CapacitorHttp` on its exports
// object and registers it as a plugin, so it is at
// `Capacitor.Plugins.CapacitorHttp`. It has never been at `Capacitor.CapacitorHttp`
// — and reading that instead sent every phone down the WebView path, where the
// https page's request to an http host is refused as mixed content before a
// packet leaves the device. Both address routes failed on every Android build
// from 2.99.3 to 2.100.2 for that reason, and the error arrived as the
// browser's "Failed to fetch", which reads as a dead host.
function syncNativeHttp(cap) {
  if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) return null;
  const plugins = cap.Plugins || {};
  return plugins.CapacitorHttp || cap.CapacitorHttp || null;
}

async function syncFetch(url, options) {
  const cap = window.Capacitor;
  const opts = options || {};
  // A probe has to report, not hang. fetch() has no timeout of its own, and an
  // address that silently drops packets — a machine that is off, a phone on the
  // wrong network — leaves the browser sitting there for over a minute before it
  // finally says "Failed to fetch". Only the probe passes a limit; syncing
  // itself does not, so a slow but working sync is never cut short.
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 0;
  const http = syncNativeHttp(cap);
  if (http) {
    const response = await http.request({
      url: url,
      method: opts.method || 'GET',
      headers: opts.headers || {},
      data: opts.body,
      // Without this a PUT body arrives as form-encoded and the host reads
      // garbage rather than JSON.
      serializer: 'json',
      // A phone that has just changed network, or a Tailscale path that has to
      // come up over mobile data, can take longer than a browser would to make
      // the connection. Cutting it off at five seconds is what made a working
      // tailnet look like a dead host when Wi-Fi was switched off.
      connectTimeout: timeoutMs || 10000,
      // A snapshot with receipts in it can be several megabytes, and this is the
      // one request that has to finish rather than be cut off. The probe keeps
      // its own shorter limit.
      readTimeout: timeoutMs || 60000
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
// file inside whatever folder comes back. On a desktop browser Chrome and Edge
// have the File System Access API, which returns a handle to a folder or a file
// that can be used again after a reload; sync-browser.js wraps it in the same
// shape. Firefox and Safari have neither, so the routes are not offered there.
let syncFolderCap = null;

function syncFolderPlugin() {
  const cap = window.Capacitor;
  const native = !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
  if (native) {
    if (!cap || typeof cap.registerPlugin !== 'function') return null;
    if (!syncFolderCap) syncFolderCap = cap.registerPlugin('SortedFolder');
    return syncFolderCap;
  }
  if (!syncFolderCap && typeof createSortedBrowserSync === 'function') {
    syncFolderCap = createSortedBrowserSync(SYNC_FILE);
  }
  return syncFolderCap;
}

// Whether this build can use a folder at all. One function, because three places
// have to agree about it: the dropdown, the card, and the sync itself.
function syncFolderHere() {
  return !!syncFolderPlugin();
}

// What "ready to sync" means for a route: an address it can try, a folder, or
// a file. One question per mechanism, asked of the setting that mechanism
// actually uses, so the wrong one's absence never reads as "not set up".
function syncRouteReady(transport, settings) {
  if (!transport || !transport.available) return false;
  if (transport.needsFolder) return !!settings.folderUri;
  if (transport.needsFile) return !!settings.fileUri;
  return !!(settings.urlLan || settings.urlTailscale);
}

// The addresses a Network route will try, in order. Wi-Fi first, because it is
// the one that works at home with nothing else running, then Tailscale, which
// works anywhere the tailnet is up. Both point at the same file on the same
// host, so trying one after the other is a fallback, not a conflict.
function syncAddresses(settings) {
  const s = settings || syncSettings();
  return [s.urlLan, s.urlTailscale].filter((url) => !!url);
}

// A first attempt can fail because the phone is still moving between Wi-Fi and
// mobile data, or because Tailscale has not finished bringing the path up. One
// retry a moment later is the difference between "the app gave up" and "the app
// waited for the network".
function readSyncSnapshotWithRetry(url, tries) {
  return readSyncSnapshot(url).catch((err) => {
    if (tries <= 1 || !syncIsTransportError(err)) throw err;
    return new Promise((resolve) => setTimeout(resolve, 1200))
      .then(() => readSyncSnapshotWithRetry(url, tries - 1));
  });
}

// Read from whichever address answers first, not from Wi-Fi first and Tailscale
// only after it gives up. At home the Wi-Fi address is immediate; away from home
// it is a machine that is not there, and waiting for its timeout before trying
// the address that does work is why leaving the house felt like a sync that had
// stopped working. Both addresses point at the same file on the same host, so
// the first answer is the right answer.
function readAnyAddress(urls) {
  return new Promise((resolve) => {
    const results = [];
    let left = urls.length;
    let decided = false;
    const finish = (value) => {
      if (decided) return;
      decided = true;
      resolve(value);
    };
    urls.forEach((url) => {
      readSyncSnapshotWithRetry(url, 2).then(
        (snapshot) => {
          results.push({ url: url, snapshot: snapshot });
          // A file is the strongest answer and settles it at once. An empty
          // answer has to wait: the other address may still produce the file.
          if (snapshot) finish({ chosen: url, remote: snapshot, attempts: [] });
        },
        (err) => { results.push({ url: url, err: err }); }
      ).finally(() => {
        left -= 1;
        if (left > 0 || decided) return;
        const empty = results.find((one) => !one.err);
        finish({
          chosen: empty ? empty.url : null,
          remote: null,
          attempts: results.filter((one) => one.err)
        });
      });
    });
  });
}

// Reading a folder the person chose. "No file" is the ordinary first-run answer
// rather than an error: the first sync creates it.
async function folderReadSnapshot(uri) {
  const plugin = syncFolderPlugin();
  if (!plugin) throw new Error('Syncing to a folder needs a folder picker.');
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
  if (!plugin) throw new Error('Syncing to a folder needs a folder picker.');
  await plugin.write({ uri: uri, data: JSON.stringify(snapshot) });
  return true;
}

// The Cloud route, which is one document rather than a folder.
//
// The distinction is not cosmetic. A folder tree works only with a provider
// that publishes a browseable tree through the system picker: Google Drive and
// OneDrive do, Proton does not. A single document is created by the system's
// Save-to list and read back by its Open list, both of which Proton appears in.
//
// A document created by ACTION_CREATE_DOCUMENT is empty until something is
// written to it, so empty is the ordinary first-run answer here rather than a
// corrupt file.
async function fileReadSnapshot(uri) {
  const plugin = syncFolderPlugin();
  if (!plugin) throw new Error('Syncing to a file needs a file picker.');
  const res = await plugin.readFile({ uri: uri });
  if (!res || !res.exists) return null;
  if (!String(res.data || '').trim()) return null;
  let parsed;
  try { parsed = JSON.parse(res.data); } catch (err) {
    throw new Error("That file isn't a Sorted snapshot.");
  }
  if (!isSyncSnapshot(parsed)) throw new Error("That file isn't a Sorted snapshot.");
  return parsed;
}

async function fileWriteSnapshot(uri, snapshot) {
  const plugin = syncFolderPlugin();
  if (!plugin) throw new Error('Syncing to a file needs a file picker.');
  await plugin.writeFile({ uri: uri, data: JSON.stringify(snapshot) });
  return true;
}

// Proton Drive's provider answers a read of a document it has not uploaded yet
// with this, rather than with an empty file. The document exists and is fine;
// its first upload is still queued. Only the device that created it treats that
// as "nothing here yet" (see fileOwned in syncSettings), because on any other
// device it is a fault worth reporting.
function isPendingUploadError(err) {
  const text = String((err && err.message) || err);
  return /cannot get drive link|upload id/i.test(text);
}

// What to say when a document is still unreadable long after this device's own
// write. It is not a failed sync and it is not a reason to write again: the
// grant the app holds is on a document the drive has moved on from, and picking
// the same file again is the one thing that gets a working one.
function pendingFileMessage() {
  return 'The drive is still holding that file from an earlier upload. Tap Choose file, pick the same file, then press Sync now.';
}

// Proton keeps uploading after the write returns. Opening the same document for
// writing during that window fails with this, which is a wait rather than a
// fault. It is also the message the user saw after a copy had in fact uploaded.
function isPendingUploadWriteError(err) {
  const text = String((err && err.message) || err);
  return /could not be opened for writing/i.test(text);
}

// A provider can lose the descriptor under a write. Proton Drive replaces the
// document when another device has just uploaded to it, and the descriptor the
// phone opened before that replacement comes back as EBADF. The plugin retries
// once itself; this is the same fault seen from the page.
function isDeadDescriptorError(err) {
  const text = String((err && err.message) || err);
  return /ebadf|bad file descriptor|epipe|broken pipe/i.test(text);
}

// How long after a write this device still treats an empty or pending read as
// its own upload in flight. Long enough for a large snapshot on a slow link,
// short enough that a genuinely empty document is written to again.
const FILE_PENDING_MS = 120000;

function fileOwnUploadRecent(settings) {
  const pushed = Date.parse((settings && settings.filePushedAt) || '');
  return Number.isFinite(pushed) && Date.now() - pushed < FILE_PENDING_MS;
}

// ---------------------------------------------------------------- diagnosis

// fetch() says "Failed to fetch" for every one of: nothing listening, the wrong
// network, and a request the platform refused. Three different problems, one
// sentence that names none of them — and the address is the common cause. So
// name the address, and say what to look at.
function syncHostBase(url) {
  try { return new URL(url).origin; } catch (err) { return null; }
}

// Tailscale hands out addresses in 100.64.0.0/10. Recognising them is what lets
// a failure say the one thing that is specific to that route: the tailnet has to
// be up on both ends, and the computer's firewall has to allow the port on that
// interface. Without it the message is the same "no answer" a wrong Wi-Fi
// address gets, and the fix is somewhere else entirely.
function syncIsTailscaleAddress(url) {
  try {
    const host = new URL(url).hostname;
    const parts = host.split('.').map((one) => Number(one));
    if (parts.length !== 4 || parts.some((one) => !Number.isInteger(one))) return false;
    return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
  } catch (err) {
    return false;
  }
}

function syncTailscaleHint(urls) {
  if (!urls.some((url) => syncIsTailscaleAddress(url))) return '';
  return ' Check Tailscale is connected on this device and on the computer, including on mobile data, and that the computer allows port 8787 on its Tailscale network.';
}

// The failures that mean "the request never got an answer", as opposed to "the
// answer was wrong". They are worth one retry on a phone, which may still be
// moving between networks, and worth the same sentence to the reader.
function syncIsTransportError(err) {
  const raw = String((err && err.message) || err);
  return /failed to fetch|networkerror|network error|load failed|timed? ?out|abort|failed to connect|connect failed|connection refused|connection reset|unreachable|unable to resolve host|no route to host|socket|cleartext/i.test(raw);
}

function syncReachMessage(url, err) {
  const raw = String((err && err.message) || err);
  // The native HTTP plugin fails in OkHttp's words rather than the browser's:
  // "Failed to connect to /192.168.1.10:8787", "Unable to resolve host",
  // "Network is unreachable", "CLEARTEXT communication not permitted". They are
  // the same class of failure as "Failed to fetch" and are worth the same
  // sentence, which names the address because that is the part that is fixable.
  if (!syncIsTransportError(err)) return raw;
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
async function syncTestAddressAt(url) {
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
    res = await syncFetch(base + '/health', { method: 'GET', timeoutMs: 10000 });
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

// The Network route has two addresses and either may be the one that answers,
// so one failure has to describe both. A specific answer still beats "nothing
// answered": it is the one that says what to fix.
async function syncTestAddress() {
  const settings = syncSettings();
  const transport = SYNC_TRANSPORTS[settings.transport];
  if (!transport || !transport.available) {
    return { state: 'unavailable', message: 'That sync option is not available yet.' };
  }
  if (!transport.needsUrl) {
    return { state: 'unavailable', message: 'That sync option does not use an address.' };
  }
  const urls = syncAddresses(settings);
  if (!urls.length) return { state: 'empty', message: 'Put the address in first.' };
  const results = [];
  for (const url of urls) results.push(await syncTestAddressAt(url));
  return results.find((one) => one.state !== 'unreachable' && one.state !== 'unavailable')
    || results[0];
}

// Both addresses failed to serve the file. Ask each one why, then say the most
// useful thing: a host that is up but serving the wrong path is a different
// problem from a machine that is not answering at all.
async function syncNetworkFailure(attempts) {
  const results = [];
  for (const attempt of attempts) {
    results.push({ url: attempt.url, found: await syncTestAddressAt(attempt.url) });
  }
  const up = results.find((r) => r.found.state === 'ready-with-file' || r.found.state === 'ready-empty');
  if (up) {
    return 'The host is running at ' + (syncHostBase(up.url) || up.url)
      + ', but it did not serve that file. Try Sync now again.';
  }
  const specific = results.find((r) => r.found.state === 'not-the-host'
    || r.found.state === 'wrong-path' || r.found.state === 'malformed');
  if (specific) return specific.found.message;
  const hint = syncTailscaleHint(attempts.map((a) => a.url));
  if (results.length === 1) {
    const only = results[0];
    if (only.found.state === 'unreachable' && hint) {
      return 'No answer from ' + (syncHostBase(only.url) || only.url) + '.' + hint;
    }
    return only.found.message;
  }
  const names = attempts.map((a) => syncHostBase(a.url) || a.url);
  if (hint) return 'No answer from ' + names.join(' or ') + '.' + hint;
  return 'No answer from ' + names.join(' or ') + '. Is the host running, and can this device reach it?';
}

// ---------------------------------------------------------------- syncing

// One pass at a time. The manual button, a change of data, a return to the app
// and the poll can all ask for a sync in the same second; two passes on the same
// database would read the same remote and both decide to write. A promise chain
// is enough: each pass starts after the one before it has finished.
let syncChain = Promise.resolve();

function syncNow() {
  // An explicit pass makes a queued automatic one redundant. Dropping it here
  // also keeps the manual button from doing the same work twice when it is
  // pressed during the debounce.
  cancelAutoSync();
  const pass = syncChain.then(() => syncNowOnce());
  syncChain = pass.catch(() => {});
  return pass;
}

// One pass. Reports what it did rather than throwing on the ordinary outcomes,
// because "already up to date" is a result, not a failure.
//
// A drive can replace the document under a write. Proton does it whenever
// another device has just uploaded, and the descriptor the phone opened before
// the replacement dies with EBADF. The plugin retries that write on its own; if
// it still fails, the pass starts again from a fresh read rather than writing
// again, because this device's copy may now be older than what the other device
// has just put there.
async function syncNowOnce() {
  const first = await syncPassOnce(false);
  if (!first || !first.retryWrite) return first;
  await new Promise((resolve) => setTimeout(resolve, 900));
  return syncPassOnce(true);
}

async function syncPassOnce(retried) {
  const settings = syncSettings();
  const transport = SYNC_TRANSPORTS[settings.transport];
  if (!transport || !transport.available) {
    return { ok: false, error: 'That sync option is not available yet.' };
  }
  // One question per mechanism, asked of the setting that mechanism actually
  // uses, so the wrong one's absence never reads as "not set up".
  const byFolder = !!transport.needsFolder;
  const byFile = !!transport.needsFile;
  if (byFolder && !settings.folderUri) {
    return { ok: false, error: 'No folder has been chosen yet.' };
  }
  if (byFile && !settings.fileUri) {
    return { ok: false, error: 'No file has been chosen yet.' };
  }
  if (!byFolder && !byFile && !syncAddresses(settings).length) {
    return { ok: false, error: 'No address set for the sync.' };
  }

  let remote = null;
  let writeRemote = null;
  let fileWaiting = false;

  if (byFolder) {
    writeRemote = (snapshot) => folderWriteSnapshot(settings.folderUri, snapshot);
    try {
      remote = await folderReadSnapshot(settings.folderUri);
    } catch (err) {
      const detail = String((err && err.message) || err);
      return { ok: false, error: detail, where: 'folder', detail: detail };
    }
  } else if (byFile) {
    // A write that fails while the provider is still processing the last upload
    // is worth one retry rather than a toast. Proton is the one that does this,
    // and a moment later the same write succeeds.
    writeRemote = async (snapshot) => {
      try {
        return await fileWriteSnapshot(settings.fileUri, snapshot);
      } catch (err) {
        if (!isPendingUploadWriteError(err)) throw err;
        await new Promise((resolve) => setTimeout(resolve, 1500));
        return fileWriteSnapshot(settings.fileUri, snapshot);
      }
    };
    // A document just made by Save new copy is empty, and Proton cannot serve a
    // read of it until its first upload has finished. Reading it anyway is what
    // produced "Cannot get drive link with upload id" on the first sync, while
    // the drive app sat there saying "Waiting to upload". The first pass writes
    // instead of reading.
    //
    // After that first write the document is this device's own upload, and it
    // stays unreadable for a while. Writing again during that window is what
    // produced "that file could not be opened for writing" even though the copy
    // had already reached the drive. So an empty or pending read straight after
    // our own write means "wait", not "write it again".
    if (!settings.fileNew) {
      try {
        remote = await fileReadSnapshot(settings.fileUri);
      } catch (err) {
        const detail = String((err && err.message) || err);
        // A read that fails for any other reason is the provider's answer, and
        // repeating it would only say the same thing twice.
        if (!isPendingUploadError(err)) {
          return { ok: false, error: detail, where: 'file', detail: detail };
        }
        // Proton answers a read of a document it is still uploading with
        // "Cannot get drive link with upload id". Straight after this device's
        // own write that is the upload in flight, and the honest answer is to
        // wait. At any other time it means the document has been replaced under
        // us: Proton replaces it when another device uploads, and the old
        // document never becomes readable again. Writing again does not fix
        // that; it produces "could not be opened for writing" and re-arms the
        // wait, which is how the card sat on "Waiting for the drive to finish
        // uploading" long after the drive had in fact taken the copy. The way
        // out is a fresh grant on the same file, which is one tap.
        if (settings.fileOwned && fileOwnUploadRecent(settings)) {
          fileWaiting = true;
          remote = null;
        } else {
          return { ok: false, error: pendingFileMessage(), where: 'file', detail: detail };
        }
      }
      if (remote === null && settings.fileOwned && fileOwnUploadRecent(settings)) {
        fileWaiting = true;
      }
    }
  } else {
    // Whichever address answers first. A file found at either is the file; if
    // neither has one, the first address that answered is where the first copy
    // is created. Writes go back to whichever address answered the read, so a
    // phone that reached the host over Tailscale does not then try to write over
    // Wi-Fi from somewhere else.
    const found = await readAnyAddress(syncAddresses(settings));
    if (!found.chosen) {
      // A folder says what went wrong in the plugin's own words, but an address
      // arrives here as "Failed to fetch": the browser's wording, the same for a
      // dead machine, a wrong network and a refused request. Ask each address
      // instead, because that is what makes it fixable.
      const error = await syncNetworkFailure(found.attempts);
      return {
        ok: false,
        error: error,
        where: 'host',
        detail: found.attempts.map((a) => String((a.err && a.err.message) || a.err)).join('; ')
      };
    }
    remote = found.remote;
    writeRemote = (snapshot) => writeSyncSnapshot(found.chosen, snapshot);
  }

  const local = await buildSyncSnapshot();
  const where = byFolder ? 'folder' : (byFile ? 'file' : 'host');

  // The drive has the copy already; it is still uploading it. Nothing to do and
  // nothing to report. The next pass reads it once the drive has finished.
  if (fileWaiting) return { ok: true, did: 'waiting', at: local.updatedAt };

  if (!remote) {
    const failed = await writeLocalSnapshot(writeRemote, local, where, byFile, retried);
    if (failed) return failed;
    syncRecordPushed(local.updatedAt);
    // The new document now has a snapshot in it, so the next pass reads and
    // compares like any other. Recording when it was written is what lets that
    // next pass know a pending read is its own upload rather than an empty file.
    if (byFile) noteFileWritten();
    return { ok: true, did: 'created', at: local.updatedAt };
  }

  const localT = syncStamp(local);
  const remoteT = syncStamp(remote);

  // An empty file never replaces a device that has data in it. That is the
  // failure this release exists to fix: a fresh install wrote an empty snapshot
  // into the folder, and every phone that read it either reported "nothing
  // usable" or had its data replaced by nothing. A local install that is empty
  // *and* has been written to still pushes, because that is somebody deleting
  // everything on purpose and its stamp says so; an install that has never been
  // written to is stamped at the epoch, so it can only ever pull.
  if (syncRowCount(remote) === 0 && syncRowCount(local) > 0) {
    const failed = await writeLocalSnapshot(writeRemote, local, where, byFile, retried);
    if (failed) return failed;
    syncRecordPushed(local.updatedAt);
    if (byFile) noteFileWritten();
    return { ok: true, did: 'pushed', at: local.updatedAt };
  }

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
    const failed = await writeLocalSnapshot(writeRemote, local, where, byFile, retried);
    if (failed) return failed;
    syncRecordPushed(local.updatedAt);
    if (byFile) noteFileWritten();
    return { ok: true, did: 'pushed', at: local.updatedAt };
  }
  return { ok: true, did: 'none', at: local.updatedAt };
}

// One write, with the provider's "still busy" answer turned into something the
// reader can act on rather than the raw sentence from the content resolver.
async function writeLocalSnapshot(writeRemote, snapshot, where, byFile, retried) {
  try {
    await writeRemote(snapshot);
    return null;
  } catch (err) {
    const detail = String((err && err.message) || err);
    if (byFile && isPendingUploadWriteError(err)) {
      // The document is busy uploading. Treat that as a write that has just
      // happened, so the 15-second poll does not ask again every time; the next
      // real attempt waits for the upload window to pass. A new document is no
      // longer new either: whatever the provider did with it, the next pass
      // should read before deciding to write.
      //
      // The answer is "waiting", not a failure: the write was accepted, the
      // upload is the thing still in flight, and the pass reports that rather
      // than letting the caller fall through to compare or write again. Falling
      // through was the loop that kept the card on "Waiting for the drive to
      // finish uploading" long after the window had had its chance to pass: the
      // busy answer refreshed the write time, the next pass read, saw the same
      // pending upload, and waited again, with a fresh write queued in between.
      setSyncSettings({ fileNew: false, filePushedAt: new Date().toISOString() });
      return {
        ok: false,
        did: 'waiting',
        error: 'The drive is still finishing the last upload. Wait a moment, then press Sync now.',
        where: 'file',
        detail: detail
      };
    }
    if (byFile && isDeadDescriptorError(err) && !retried) {
      // The document was replaced under the write. Starting the pass again
      // reads first, which is the only safe answer: this device's copy may now
      // be older than the one that replaced it.
      return { ok: false, retryWrite: true, where: 'file', detail: detail };
    }
    if (byFile && isDeadDescriptorError(err)) {
      return {
        ok: false,
        error: 'The drive lost hold of that file while Sorted was writing it. Press Sync now to try again.',
        where: 'file',
        detail: detail
      };
    }
    return { ok: false, error: detail, where: where, detail: detail };
  }
}

// The document now holds a snapshot this device wrote. Both facts matter: it is
// no longer new, and the time of the write is what tells a later pending read
// apart from a document that really is empty.
function noteFileWritten() {
  setSyncSettings({ fileNew: false, filePushedAt: new Date().toISOString() });
}

// ---------------------------------------------------------------- automatic

// Sync on its own, rather than only when a button is pressed.
//
// Four moments matter:
//   - after a change, once the typing has stopped (a debounce, so an import or
//     a quick edit is one pass rather than ten);
//   - when the app comes back to the front, which on Android is the only reliable
//     "the phone is being used again" signal;
//   - on first load, so a new device pulls without being asked; and
//   - every 15 seconds while the app is visible, so a device that is already
//     open picks up what another device wrote without a refresh.
//
// A failure is silent. The manual buttons are where a reason is reported; an
// automatic pass that popped a toast every time the host was asleep would be
// worse than not syncing. The only visible effect of an automatic pull is that
// the page is redrawn with the new data.
let syncAutoTimer = null;
let syncAutoRunning = false;
let syncAutoPoll = null;

function cancelAutoSync() {
  if (syncAutoTimer) {
    clearTimeout(syncAutoTimer);
    syncAutoTimer = null;
  }
}

function scheduleAutoSync(delay) {
  if (typeof syncConfigured !== 'function' || !syncConfigured()) return;
  startAutoSyncPoll();
  if (syncAutoTimer) clearTimeout(syncAutoTimer);
  const wait = Number.isFinite(delay) ? Math.max(0, delay) : 1800;
  syncAutoTimer = setTimeout(() => {
    syncAutoTimer = null;
    autoSyncNow();
  }, wait);
}

async function autoSyncNow() {
  if (syncAutoRunning) return;
  if (typeof syncConfigured !== 'function' || !syncConfigured()) return;
  if (typeof document !== 'undefined' && document.hidden) return;
  syncAutoRunning = true;
  let pulled = false;
  try {
    const res = await syncNow();
    pulled = !!(res && res.ok && res.did === 'pulled');
  } catch (err) {
    // Deliberately silent. The manual buttons report; this is the background.
  } finally {
    syncAutoRunning = false;
  }
  if (!pulled) return;
  // A pull replaces the whole database. Redrawing is what makes that visible,
  // but not over an open form: the modal belongs to the person using it.
  if (typeof renderPage === 'function' && !document.querySelector('.modal.active')) {
    await renderPage();
  }
}

function startAutoSyncPoll() {
  if (syncAutoPoll || typeof setInterval !== 'function') return;
  // Nothing to poll until a route is set up. Starting a timer that only wakes
  // to discover that would be a wake-up every 15 seconds for the life of a tab
  // that never syncs.
  if (typeof syncConfigured !== 'function' || !syncConfigured()) return;
  syncAutoPoll = setInterval(() => {
    if (typeof document !== 'undefined' && document.hidden) return;
    // A change or a return to the app has already queued a pass; do not stack
    // a poll behind it.
    if (syncAutoTimer || syncAutoRunning) return;
    autoSyncNow();
  }, 15000);
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