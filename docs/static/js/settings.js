/* =============================================================================
   settings.js
   Device-level settings that are not finance data, so they live in
   localStorage rather than IndexedDB: the light/dark choice and the passcode
   that locks the app on launch and after a set idle period.

   Passcodes are never stored in the clear — only a salted SHA-256 of the
   digits (crypto.subtle is available over https, in Electron's file:// and in
   the Android WebView). Note this is a shoulder-surfing screen, not real
   security: the key lives next to the data it protects, on the same device.
   ============================================================================= */

const THEME_KEY = 'sorted-theme';
const PASSCODE_KEY = 'sorted-passcode';
const TIMEOUT_KEY = 'sorted-lock-timeout';
const PERSON_PINS_KEY = 'sorted-person-pins';

// Idle periods offered in Settings. 0 means "lock the moment the app is
// backgrounded" — the launch/foreground lock is handled separately and always
// applies when a passcode is set.
const LOCK_TIMEOUTS = [
  { value: 0, label: 'Immediately' },
  { value: 1, label: '1 min' },
  { value: 5, label: '5 min' },
  { value: 30, label: '30 min' }
];
const DEFAULT_TIMEOUT = 5;

// Theme
// 'light' | 'dark' | 'system'. Unset defaults to dark, which is what the app
// has always looked like — a first run shouldn't change under anyone.
function getThemePreference() {
  const stored = localStorage.getItem(THEME_KEY);
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'dark';
}

function getEffectiveTheme() {
  const pref = getThemePreference();
  if (pref !== 'system') return pref;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function setThemePreference(pref) {
  if (pref !== 'light' && pref !== 'dark' && pref !== 'system') return;
  localStorage.setItem(THEME_KEY, pref);
  applyTheme();
}

function applyTheme() {
  const theme = getEffectiveTheme();
  document.documentElement.dataset.theme = theme;

  // The Android status bar and the PWA chrome read theme-color; the Electron
  // window background needs telling separately so it can't flash the old one.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#f4f5f7' : '#0d0d0f');
  if (window.sortedBridge && window.sortedBridge.setWindowBackground) {
    window.sortedBridge.setWindowBackground(theme === 'light' ? '#f4f5f7' : '#0d0d0f');
  }

  // The trend chart is painted to a canvas with colours read from the CSS
  // variables, so it has to be redrawn rather than restyled.
  if (typeof onThemeChanged === 'function') onThemeChanged(theme);
}

// 'system' means the OS can flip the theme while the app is open.
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (getThemePreference() === 'system') applyTheme();
});

/* Passcode
   --------------------------------------------------------------------------
   There is no app-wide passcode. There is a switch — whether a PIN is needed
   at all — and each person's own PIN.

   The two-key model was dropped because nobody could tell the keys apart:
   one locked the app and meant nothing, the other locked it and meant who had
   walked in, and nothing on screen said which was which. A per-person PIN is
   also the only kind of key this app can act on, because it is the only one
   that identifies somebody, which is what spending, payments and savings need
   attributing to.

   Storage used to hold a salted hash of the code. It now holds a switch, and a
   record written by an older build is read as "the switch was on" and rewritten
   without the hash. The code itself is dropped on purpose: nothing asks for it
   any more, and a key nothing can ask for is a key nobody can use.
   ------------------------------------------------------------------------ */
function getPasscodeRecord() {
  try {
    const raw = localStorage.getItem(PASSCODE_KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw);
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
    if (typeof rec.on === 'boolean') return rec;
    // An older build stored a salted hash of a code. Reading it as "on" and
    // rewriting it as a switch keeps the lock on for somebody who had one.
    if (typeof rec.hash === 'string' && typeof rec.salt === 'string') {
      const migrated = { on: true };
      localStorage.setItem(PASSCODE_KEY, JSON.stringify(migrated));
      return migrated;
    }
    return null;
  } catch (err) {
    return null;
  }
}

// The switch is derived as well as stored, because the data it belongs to may
// predate the switch. A person's PIN is written by its own feature and always
// was, so somebody who set PINs under an earlier build has PINs and no record
// of the switch — and defaulting them to unlocked would silently drop the lock
// they already had. People holding PINs therefore means the switch is on, and an
// explicit `{on:false}` is what turns that off.
function isPasscodeSet() {
  const rec = getPasscodeRecord();
  if (rec) return rec.on === true;
  return anyPersonPins();
}

// Turning it on needs at least one person to have a PIN. With nobody holding a
// key the app would lock and nothing could open it, and the only way back in
// would be clearing storage — a lock that costs you your own data is not a lock.
// Written explicitly either way, so an off is distinguishable from "nothing
// recorded" — which means "derive it from the people who have PINs".
function setPasscodeEnabled(on) {
  if (on) {
    if (!anyPersonPins()) return false;
    localStorage.setItem(PASSCODE_KEY, JSON.stringify({ on: true }));
  } else {
    localStorage.setItem(PASSCODE_KEY, JSON.stringify({ on: false }));
    localStorage.removeItem(TIMEOUT_KEY);
    // Turning the passcode off must never leave the app locked. With the key gone
    // there is nothing that could open it, and a lock nobody can open is a way to
    // lose your own data.
    if (locked) unlockApp();
  }
  return true;
}

function getLockTimeoutMinutes() {
  const raw = Number(localStorage.getItem(TIMEOUT_KEY));
  return LOCK_TIMEOUTS.some((t) => t.value === raw) ? raw : DEFAULT_TIMEOUT;
}

function setLockTimeoutMinutes(minutes) {
  const n = Number(minutes);
  if (!LOCK_TIMEOUTS.some((t) => t.value === n)) return; // a bad value would silently fall back
  localStorage.setItem(TIMEOUT_KEY, String(n));
}

// A passcode is digits only — the keypad can't enter anything else, and
// checking here keeps a hand-typed value from silently setting something the
// lock screen can never be opened with.
function normalisePasscode(value) {
  return String(value || '').replace(/\D/g, '');
}

async function hashPasscode(passcode, salt) {
  const data = salt + '|' + passcode;
  if (window.crypto && window.crypto.subtle && window.TextEncoder) {
    const buf = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Fallback for a context without crypto.subtle: still salted and still not
  // plain text, just not a cryptographic digest.
  let h = 5381;
  for (let i = 0; i < data.length; i++) h = ((h * 33) ^ data.charCodeAt(i)) >>> 0;
  return 'fb' + h.toString(16);
}

function randomSalt() {
  const bytes = new Uint8Array(16);
  if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// One length, because the keypad draws a fixed number of dots and submits
// itself — it has to know the length before anything is typed. With no app
// passcode to set it, the length is whatever the PINs already use, and four
// until the first one is set.
function getPasscodeLength() {
  for (const rec of Object.values(getPersonPinRecords())) {
    const len = Number(rec.length);
    if (Number.isInteger(len) && len >= 4 && len <= 8) return len;
  }
  return 4;
}

/* Per-person PINs
   --------------------------------------------------------------------------
   Additive on purpose: the app passcode above keeps working exactly as it
   did, so nobody can be locked out by the existence of this feature. A person
   may additionally set a PIN, and entering it at the lock screen both unlocks
   and switches to them.

   What a PIN is, stated plainly because it is easy to over-read: it says who
   you are, not that you're allowed in. Anyone who gets into the app can reset
   anyone's PIN from Settings without knowing it, and can still switch the
   top-bar chip afterwards. It is a convenience for attribution on a shared
   device, and a four-digit family PIN is not a security boundary.

   PINs live in localStorage, like the app passcode and for the same reason:
   they are a device setting, not finance data, and they deliberately do not
   travel in a backup — the same reason a forgotten app passcode means clearing
   storage. A person removed from the app has theirs dropped with them.
   ------------------------------------------------------------------------ */

function getPersonPinRecords() {
  try {
    const raw = localStorage.getItem(PERSON_PINS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    // Drop anything malformed rather than letting it break every unlock.
    const out = {};
    for (const [id, rec] of Object.entries(parsed)) {
      if (rec && typeof rec.hash === 'string' && typeof rec.salt === 'string') out[id] = rec;
    }
    return out;
  } catch (err) {
    return {};
  }
}

function getPersonPin(personId) {
  return getPersonPinRecords()[personId] || null;
}

function hasPersonPin(personId) {
  return !!getPersonPin(personId);
}

function anyPersonPins() {
  return Object.keys(getPersonPinRecords()).length > 0;
}

// Every PIN is the same length. The lock screen's keypad shows a fixed number of
// dots and submits on its own, so it has to know the length before anything is
// typed — a four-digit PIN could never be entered through a six-digit pad. One
// length for all of them is the only way to keep that.
function getRequiredPinLength() {
  return getPasscodeLength();
}

// A PIN already in use by someone else. Two people sharing a PIN would make
// the unlock ambiguous and silently attribute one person's spending to the
// other, which is the one outcome this feature must never produce. Returns the
// id of the person already using it, or null when the PIN is free.
async function isPersonPinTaken(pin, exceptPersonId) {
  const clean = normalisePasscode(pin);
  for (const [id, rec] of Object.entries(getPersonPinRecords())) {
    if (id === exceptPersonId) continue;
    if ((await hashPasscode(clean, rec.salt)) === rec.hash) return id;
  }
  return null;
}

async function setPersonPin(personId, pin) {
  const clean = normalisePasscode(pin);
  if (clean.length !== getRequiredPinLength()) return 'length';
  if (await isPersonPinTaken(clean, personId)) return 'taken';
  const salt = randomSalt();
  const records = getPersonPinRecords();
  records[personId] = { salt, hash: await hashPasscode(clean, salt), length: clean.length };
  localStorage.setItem(PERSON_PINS_KEY, JSON.stringify(records));
  return null;
}

function clearPersonPin(personId) {
  const records = getPersonPinRecords();
  if (!(personId in records)) return false;
  delete records[personId];
  if (Object.keys(records).length === 0) localStorage.removeItem(PERSON_PINS_KEY);
  else localStorage.setItem(PERSON_PINS_KEY, JSON.stringify(records));
  return true;
}

function clearAllPersonPins() {
  localStorage.removeItem(PERSON_PINS_KEY);
}

// Which person, if any, this entry belongs to. Deliberately does not fall back
// to "nothing to check, so let anyone in": the lock screen only appears when
// there is something to match against, and treating "nothing to check" as
// success would unlock on any digits at all.
async function matchAnyPasscode(pin) {
  const clean = normalisePasscode(pin);
  for (const [id, rec] of Object.entries(getPersonPinRecords())) {
    if ((await hashPasscode(clean, rec.salt)) === rec.hash) {
      return { ok: true, personId: id };
    }
  }
  return { ok: false, personId: null };
}

// The app locks when the switch is on and somebody holds a PIN. Both halves
// matter: with nobody holding a key the app must not lock, because the only way
// back in would be clearing storage — and a person removed from the app takes
// their PIN with them, so "on with no PIN" is a state the app can be put in.
function isLockEnabled() {
  return isPasscodeSet() && anyPersonPins();
}

// Lock screen
let locked = false;
let lastActivity = Date.now();
let entry = '';

function isLocked() {
  return locked;
}

function showLockScreen() {
  locked = true;
  entry = '';
  document.body.classList.add('is-locked');

  // A modal left open behind the lock would still be there on unlock, and the
  // passcode field on Settings must not survive into the next lock.
  if (typeof closeModal === 'function' && document.getElementById('modal').classList.contains('active')) {
    closeModal();
  }
  if (typeof closeViewer === 'function') closeViewer();

  const screen = document.getElementById('lock-screen');
  screen.hidden = false;
  renderLockDots();
  setLockError('');
}

function lockApp() {
  if (!isLockEnabled() || locked) return;
  showLockScreen();
}

function unlockApp() {
  locked = false;
  entry = '';
  lastActivity = Date.now();
  document.body.classList.remove('is-locked');
  document.getElementById('lock-screen').hidden = true;
  if (typeof renderPage === 'function') renderPage();
}

function renderLockDots() {
  const wrap = document.getElementById('lock-dots');
  if (!wrap) return;
  const len = getPasscodeLength();
  let html = '';
  for (let i = 0; i < len; i++) html += `<span class="lock-dot${i < entry.length ? ' filled' : ''}"></span>`;
  wrap.innerHTML = html;
}

function setLockError(message, shake) {
  const el = document.getElementById('lock-error');
  if (!el) return;
  el.textContent = message || '';
  if (!shake) return;
  el.classList.remove('shake');
  // Restart the animation — reading offsetWidth forces the reflow that lets
  // the class be re-added on a second wrong attempt.
  void el.offsetWidth;
  el.classList.add('shake');
}

async function submitLockEntry() {
  const match = await matchAnyPasscode(entry);
  if (match.ok) {
    // A person's PIN identifies them, so unlocking as them switches the app to
    // them — the whole point of having it. The app passcode claims no
    // identity, so whoever was in use stays in use.
    if (match.personId) {
      localStorage.setItem('sorted-current-person', match.personId);
    }
    unlockApp();
    return;
  }
  setLockError('Wrong passcode', true);
  entry = '';
  renderLockDots();
  setTimeout(() => setLockError(''), 1600);
}

function pressKey(key) {
  if (!locked) return;
  setLockError('');
  const len = getPasscodeLength();

  if (key === 'back') entry = entry.slice(0, -1);
  else if (key === 'clear') entry = '';
  else if (entry.length < len) entry += key;

  renderLockDots();
  if (key !== 'back' && key !== 'clear' && entry.length === len) submitLockEntry();
}

document.getElementById('keypad').addEventListener('click', (e) => {
  const key = e.target.closest('.key');
  if (key) pressKey(key.dataset.key);
});

// Hardware keyboard support: the app is also used on a laptop, where typing
// the passcode is quicker than reaching for the on-screen pad.
document.addEventListener('keydown', (e) => {
  if (!locked) return;
  if (/^\d$/.test(e.key)) { e.preventDefault(); pressKey(e.key); }
  else if (e.key === 'Backspace') { e.preventDefault(); pressKey('back'); }
  else if (e.key === 'Escape') { e.preventDefault(); pressKey('clear'); }
  // The pad is the only focusable thing on screen — keep Tab from wandering
  // into the app underneath.
  else if (e.key === 'Tab') e.preventDefault();
});

// Idle lock
// lastActivity only advances while unlocked, so time spent on the lock screen
// can't push the app further into the locked state.
function noteActivity() {
  if (!locked) lastActivity = Date.now();
}

function checkIdle() {
  if (locked || !isLockEnabled()) return;
  const minutes = getLockTimeoutMinutes();
  // "Immediately" means as soon as the app is put away — checked on
  // visibilitychange, since a backgrounded WebView may not tick reliably.
  if (minutes === 0) return;
  if (Date.now() - lastActivity >= minutes * 60 * 1000) lockApp();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { lastActivity = Math.min(lastActivity, Date.now()); return; }
  checkIdle();
  noteActivity();
});

['pointerdown', 'keydown', 'wheel'].forEach((evt) => {
  document.addEventListener(evt, noteActivity, { passive: true });
});

// Fifteen seconds is often enough for the idle check to feel instant on
// return, and cheap enough to sit in a backgrounded WebView.
setInterval(checkIdle, 15000);

// Launch
// Called from app.js at the end of its own run, before the first render — a
// page must never paint behind the lock screen, and the two need to happen in
// that order. index.html has already set data-theme before first paint.
function initLock() {
  if (isLockEnabled()) showLockScreen();
  else document.getElementById('lock-screen').hidden = true;
}
