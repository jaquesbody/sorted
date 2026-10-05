// Sorted v2 - Main Application

// Single source for the version shown in the UI. Bump this together with
// package.json and android/app/build.gradle.
const APP_VERSION = '2.31.0';
document.querySelectorAll('.app-version').forEach((el) => { el.textContent = 'v' + APP_VERSION; });

let currentPage = 'dashboard';
let viewedDate = new Date();
viewedDate.setDate(1);
// The Bills page has its own month cursor: the pages are navigated separately
// and a shared one made stepping through a bill's recurrence move the spend
// list too. The Dashboard has a third, for the same reason — the month you're
// looking at on a summary shouldn't drag the lists along with it.
let dueViewedDate = new Date();
dueViewedDate.setDate(1);
let dashViewedDate = new Date();
dashViewedDate.setDate(1);
let spendFilter = 'all';
let dueFilter = 'all'; // Bills page: 'all' | 'pending' | 'confirmed' | 'recurring'
let reportRange = 'all'; // Reports date range: 'all' | 'month' | 'year'

/* -----------------------------------------------------------------------------
   People
   Attribution, not accounts: a person is a name and a colour, and anyone can
   pick who they're currently being. There is no login and no PIN per person —
   the whole point is that a shared family device can say whose spending is
   whose. "Who's using the app" is a device setting (localStorage, like the
   theme) because it answers "who is holding the phone", and it is what stamps
   new entries and bill payments.
   -------------------------------------------------------------------------- */

const CURRENT_PERSON_KEY = 'sorted-current-person';

/* Accounts
   --------------------------------------------------------------------------
   A pool of money: a bank account, or the notes in your wallet. Cash is not a
   separate concept bolted onto this — it's an account whose type is 'cash',
   so "paid cash" is an allocation like any other and there's one thing to learn
   rather than two.

   An account's balance is never stored. What a person types is the opening
   balance plus an adjustment (transfers, interest, fees — anything the app
   can't infer), and the balance shown is derived from those plus the activity
   that follows. Storing the balance instead would mean every spend entry
   silently overwrote a manual correction, which is the one thing an editable
   number has to not do.
   -------------------------------------------------------------------------- */

// The Cash account has to exist for every install, including the ones that
// were seeded long before accounts existed — so this runs on boot rather than
// as part of the sample data, which only ever runs once on a fresh database.
async function ensureDefaults() {
  const accounts = await getAll('accounts');
  if (!accounts.some((a) => a.type === CASH_TYPE)) {
    await addItem('accounts', { name: 'Cash', type: CASH_TYPE, opening: 0, adjustment: 0, personId: null });
  }
}

let accountsCache = new Map();

async function loadAccounts() {
  const accounts = await getAll('accounts');
  accounts.sort((a, b) => {
    // Cash first among the cash accounts, then bank ones, each group by name.
    const aCash = a.type === CASH_TYPE ? 0 : 1;
    const bCash = b.type === CASH_TYPE ? 0 : 1;
    return aCash - bCash || String(a.name).localeCompare(String(b.name));
  });
  accountsCache = new Map(accounts.map((a) => [a.id, a]));
  return accountsCache;
}

function accountById(id) {
  return id ? accountsCache.get(id) || null : null;
}

function accountName(id) {
  const a = accountById(id);
  return a ? a.name : 'Unassigned';
}

// What an account holds, derived rather than stored. Money out is spend (which
// already includes paid bills, since paying one writes a spend record) and
// anything put into a savings goal, because that money left the account to sit
// somewhere else. Money in is transfers arriving and the manual adjustment.
// The last computed balances, keyed by account id.
let accountBalanceCache = new Map();

async function accountBalances() {
  const [accounts, spend, savings, transfers, income, dueItems] = await Promise.all([
    getAll('accounts'), getAll('spend'), getAll('savings'), getAll('transfers'), getAll('income'),
    getAll('due')
  ]);

  // Read straight from the store rather than the cache, so this is the order
  // the file happens to be in — which is neither stable nor the one the list
  // shows. Sorted here to match: cash first, then bank accounts by name.
  accounts.sort((a, b) => {
    const aCash = a.type === CASH_TYPE ? 0 : 1;
    const bCash = b.type === CASH_TYPE ? 0 : 1;
    return aCash - bCash || String(a.name).localeCompare(String(b.name));
  });

  const out = new Map();
  for (const a of accounts) {
    out.set(a.id, { id: a.id, name: a.name, type: a.type, personId: a.personId || null, opening: a.opening || 0, adjustment: a.adjustment || 0, spend: 0, bills: 0, savings: 0, income: 0, transferIn: 0, transferOut: 0, balance: 0 });
  }

  const get = (id) => (id ? out.get(id) || null : null);

  for (const item of spend) {
    const row = get(item.accountId);
    if (!row) continue;
    // Rows written before 2.8.3 paid a bill by writing its payment into
    // Spend. Those are still in people's data, so they are still read as bills
    // here — otherwise every bill they have already paid would silently vanish
    // from their balances. New payments never produce one of these.
    if (item.paid) row.bills += item.amount;
    else row.spend += item.amount;
  }
  // A bill that has been paid leaves the account from Bills, which is where it
  // now stays. Only paid ones count: an unpaid bill has not been paid yet.
  for (const item of dueItems) {
    if (item.paid !== true) continue;
    const row = get(item.accountId);
    if (row) row.bills += item.amount;
  }
  for (const goal of savings) {
    const row = get(goal.accountId);
    if (row) row.savings += goal.current || 0;
  }
  // Income is the one thing that arrives rather than leaves.
  for (const item of income) {
    const row = get(item.accountId);
    if (row) row.income += item.amount;
  }
  for (const t of transfers) {
    const from = get(t.fromId);
    const to = get(t.toId);
    if (from) from.transferOut += t.amount;
    if (to) to.transferIn += t.amount;
  }

  for (const row of out.values()) {
    row.balance = row.opening + row.adjustment + row.income
      + row.transferIn - row.transferOut
      - row.spend - row.bills - row.savings;
  }

  // Kept so the account editor can show the balance the row displays without
  // going back to the database to work it out. Same data, one computation.
  accountBalanceCache = new Map(out);
  return [...out.values()];
}

// Everything that moved one account, oldest first, as a flat list of dated
// entries. A balance is a single number, and a number that has moved is a
// question; this is the answer to it.
//
// Built from the same stores accountBalances() reads, so the entries always
// add up to the balance shown on the row. Anything with no date of its own — a
// goal's running total, a one-off adjustment to the opening figure — has no
// place on a timeline and is listed after the dated entries instead of being
// given a date it never had.
async function accountActivity(accountId) {
  const [spend, savings, transfers, income, dueItems] = await Promise.all([
    getAll('spend'), getAll('savings'), getAll('transfers'), getAll('income'), getAll('due')
  ]);
  const entries = [];
  const add = (date, label, amount, tone, extra) => {
    entries.push(Object.assign({ date: date || '', label, amount, tone }, extra || {}));
  };

  // The opening balance and any one-off adjustment lead the list, undated. They
  // are what the account held before anything was tracked, and leaving them out
  // would make a list that visibly fails to add up to the balance above it —
  // which is the one thing a list of movements has to be able to do.
  const opening = accountById(accountId);
  if (opening) {
    if (Number(opening.opening)) add('', 'Opening balance', Number(opening.opening), 'in', { title: '' });
    if (Number(opening.adjustment)) add('', 'Adjusted', Number(opening.adjustment), opening.adjustment < 0 ? 'out' : 'in', { title: '' });
  }

  for (const item of spend) {
    if (item.accountId !== accountId) continue;
    // A row written before 2.8.3 paid a bill by writing it into Spend. It is
    // read as a bill here for the same reason it is in accountBalances(), so
    // this list and the balance can't disagree about what a row was.
    if (item.paid) add(item.date || item.dueDate, 'Bill paid', -Number(item.amount) || 0, 'out', { title: item.title });
    else add(item.date, 'Spent', -Number(item.amount) || 0, 'out', { title: item.title });
  }
  for (const item of dueItems) {
    if (item.paid !== true || item.accountId !== accountId) continue;
    add(item.date, 'Bill paid', -Number(item.amount) || 0, 'out', { title: item.title });
  }
  for (const item of income) {
    if (item.accountId !== accountId) continue;
    add(item.date, 'Income', Number(item.amount) || 0, 'in', { title: item.title });
  }
  for (const t of transfers) {
    if (t.fromId === accountId) add(t.date, 'Moved out', -Number(t.amount) || 0, 'out', { title: accountName(t.toId) });
    if (t.toId === accountId) add(t.date, 'Moved in', Number(t.amount) || 0, 'in', { title: accountName(t.fromId) });
  }
  for (const goal of savings) {
    if (goal.accountId !== accountId) continue;
    add('', 'Saved to ' + (goal.title || 'goal'), -(Number(goal.current) || 0), 'out', { title: goal.category || '' });
  }

  const dated = entries.filter((e) => e.date).sort((a, b) => a.date.localeCompare(b.date));
  // Undated entries last: the opening balance is where the story starts, but it
  // has no date to sit in a timeline with, and showing it under a made-up date
  // would be worse than showing it in its own group.
  const undated = entries.filter((e) => !e.date);
  return dated.concat(undated);
}

// Returns the new account's id, or null when it couldn't be added. The id
// rather than a bare true, because a caller that just added an account almost
// always wants to do something with it next — and a boolean that gets passed
// to deleteItem() as an id fails at the point of use, not here.
async function addAccount(name, type, opening) {
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean) return null;
  const accounts = await getAll('accounts');
  if (accounts.some((a) => a.type === type && String(a.name).toLowerCase() === clean.toLowerCase())) return null;
  return addItem('accounts', {
    name: clean,
    type: type === CASH_TYPE ? CASH_TYPE : 'bank',
    opening: Number.isFinite(Number(opening)) ? Number(opening) : 0,
    adjustment: 0,
    personId: null
  });
}

// Removing an account must not delete the money it was holding, and it must
// not silently unallocate it either: the entries keep pointing at a row that no
// longer exists, and the app says "Unassigned" until someone re-picks one.
async function removeAccount(id) {
  await deleteItem('accounts', id);
}

function getCurrentPersonId() {
  const id = localStorage.getItem(CURRENT_PERSON_KEY);
  return id || null;
}

function setCurrentPersonId(id) {
  if (id) localStorage.setItem(CURRENT_PERSON_KEY, id);
  else localStorage.removeItem(CURRENT_PERSON_KEY);
  renderPage();
}

// People for this page render, resolved to a map. Cleared on every render so
// a rename or a removal shows up everywhere at once.
let peopleCache = new Map();

async function loadPeople() {
  const people = await getAll('people');
  people.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  peopleCache = new Map(people.map((p) => [p.id, p]));
  return peopleCache;
}

function personById(id) {
  return id ? peopleCache.get(id) || null : null;
}

// Everyone shares this one filter across Spend and Bills, so switching
// person in one place doesn't leave the other quietly showing a different
// slice. 'all' means no filter — the household.
let personFilter = 'all';

function personFilterActive() {
  return personFilter !== 'all' && peopleCache.has(personFilter);
}

function matchesPersonFilter(item) {
  return !personFilterActive() || item.personId === personFilter;
}

function setPersonFilter(id) {
  personFilter = id || 'all';
  renderPage();
}

// The dot beside a number in a list: colour plus first letter, so it is
// identifiable without spending row width on a full name. `decorative` for
// the places where the name is already right next to it (the chip, the
// picker, a filter chip) — otherwise a screen reader announces "S Sarah".
function personDot(person, size, decorative) {
  if (!person) return '';
  const initial = String(person.name).trim().charAt(0).toUpperCase() || '?';
  const px = size || 24;
  const a11y = decorative ? ' aria-hidden="true"' : ` role="img" aria-label="${escapeHTML(person.name)}"`;
  return `<span class="person-dot" style="width:${px}px;height:${px}px;font-size:${Math.round(px * 0.5)}px;background:${escapeHTML(person.colour || PERSON_COLOURS[0])};color:${readableOn(person.colour)}"
    title="${escapeHTML(person.name)}"${a11y}>${escapeHTML(initial)}</span>`;
}

// Black or white lettering on an arbitrary identity colour, by its luminance —
// so every swatch in the palette stays readable instead of assuming light text.
function readableOn(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.45 ? '#16181d' : '#ffffff';
}

// The person chip sits in the top bar (phone) and the sidebar (desktop) —
// only one of the two is ever visible, since the top bar is hidden above
// 768px and the rail is hidden below it. It lives in the chrome rather than a
// page so it stays put while you move around, and so a row's attribution is
// never a surprise because you forgot to switch.
function renderPersonChip() {
  const person = personById(getCurrentPersonId());
  const html = `<button class="person-chip" data-action="pick-person" title="Who's using the app">
      ${personDot(person, 22, true)}<span class="person-chip-name">${escapeHTML(person ? person.name : 'Anyone')}</span>
    </button>`;
  for (const id of ['topbar-person', 'sidebar-person']) {
    const slot = document.getElementById(id);
    if (slot) slot.innerHTML = html;
  }
}

function personChipsHtml() {
  const people = [...peopleCache.values()];
  const chip = (value, label, dot) => `<span class="filter-chip ${personFilter === value ? 'active' : ''}" role="button" tabindex="0" onclick="setPersonFilter('${value}')">${dot || ''}${label}</span>`;
  return [
    chip('all', 'Everyone'),
    ...people.map((p) => chip(p.id, escapeHTML(p.name), personDot(p, 16, true)))
  ].join('');
}

function openPersonPicker() {
  const people = [...peopleCache.values()];
  const current = getCurrentPersonId();
  const option = (id, label, dot) => `<button class="person-option" data-action="choose-person" data-id="${id || ''}"${id === current ? ' aria-current="true"' : ''}>${dot}<span>${label}</span></button>`;
  openModal('Who\'s using the app', `
    <p class="form-label" style="margin-bottom: 14px;">New spend and bills you add are marked as theirs, and marking a bill paid records who paid it.</p>
    <div class="person-options">
      ${option('', 'Anyone', personDot(null, 24, true))}
      ${people.map((p) => option(p.id, escapeHTML(p.name), personDot(p, 24, true))).join('')}
    </div>
    <p class="setting-hint" style="margin-top: 14px;">This isn't a login — anyone can switch. Add people in Settings.</p>
  `);
}

async function addPerson(name) {
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean) return false;
  const people = await getAll('people');
  if (people.some((p) => String(p.name).toLowerCase() === clean.toLowerCase())) return false;
  await addItem('people', { name: clean, colour: nextPersonColour(people) });
  return true;
}

async function removePerson(id) {
  // Their entries are left alone — a spend doesn't stop being real because
  // the person is removed — they just become unattributed.
  for (const store of ['spend', 'due', 'savings']) {
    const items = await getAll(store);
    for (const item of items) {
      if (item.personId === id) await updateItem(store, { ...item, personId: null });
    }
  }
  await deleteItem('people', id);
  // Their PIN goes with them. Leaving it behind would keep the app locked
  // against a person who can no longer be selected, and the record would sit
  // in localStorage pointing at an id nothing resolves any more.
  clearPersonPin(id);
  // Straight to storage rather than through setCurrentPersonId(), which
  // renders: the caller is about to re-render anyway, and this way the chip
  // doesn't flicker to "Anyone" over a page that is about to be replaced.
  if (getCurrentPersonId() === id) localStorage.removeItem(CURRENT_PERSON_KEY);
  if (personFilter === id) personFilter = 'all';
}

// The one way to change page. The nav bar, the bottom bar and the dashboard's
// stat cards all go through it, so the highlighted tab can't disagree with the
// page on screen — jumping from a dashboard card used to leave the bottom bar
// still showing Dashboard.
function navigate(page) {
  currentPage = page;
  document.querySelectorAll('.nav-item').forEach((i) => {
    i.classList.toggle('active', i.dataset.page === page);
  });
  // A tab opens at its own top. Inheriting the offset you left the last tab at
  // dropped you into the middle of a page you had never seen — the worst on the
  // longest one, Reports, where you land on a chart with no heading above it.
  scrollToTop();
  renderPage().then(scrollToTop, scrollToTop);
}

function scrollToTop() {
  window.scrollTo(0, 0);
  // The modal and the side panels scroll in their own right, and a leftover
  // offset in either shows up as a page that looks half-open.
  document.querySelectorAll('.modal-content, .modal').forEach((el) => { el.scrollTop = 0; });
}

// Navigation — delegated, so the cloned bottom-bar copy used by the
// phone layout works with the same handler and all copies stay in sync.
document.addEventListener('click', (e) => {
  const item = e.target.closest && e.target.closest('.nav-item');
  if (!item) return;
  navigate(item.dataset.page);
});

// Phone layout: the vertical rail eats a big slice of a phone screen, so
// the Android build clones the nav into a fixed bottom bar instead.
// ?native in the URL previews that layout in a desktop browser.
const IS_NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform())
  || new URLSearchParams(window.location.search).has('native');

if (IS_NATIVE) {
  const bar = document.getElementById('bottom-nav');
  const list = document.querySelector('.sidebar .nav-list');
  if (bar && list) {
    bar.appendChild(list.cloneNode(true));
    // On <html> as well as <body>: the head script sets it before first paint to
    // stop the rail flashing, and the two have to agree or the phone layout is
    // half applied depending on which one the cascade sees.
    document.documentElement.classList.add('is-native');
    document.body.classList.add('is-native');
  }
}

// Coming back to the front re-renders whatever tab you were on.
//
// Android suspends the WebView in the background, and it closes IndexedDB while
// it is away. Anything that rendered during that window failed, and nothing
// re-rendered on the way back — so you returned to a blank or stale page with
// the nav still highlighting the tab you had asked for. That is the whole of
// "the Reports tab sometimes doesn't load": the page that most needs to be
// re-read is the one with the most work in it.
let resumeRenderedAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  // Android fires this more than once for a single return to the app, and
  // re-rendering the heaviest page on each one is the last thing a phone needs.
  const now = Date.now();
  if (now - resumeRenderedAt < 1500) return;
  resumeRenderedAt = now;
  renderPage();
});

// Modal — openModal moves focus into the modal (first field, or the
// close button when there are none, so Enter can never fire a
// destructive button); closeModal puts focus back on the opener.
// Escape closes from anywhere.
const modal = document.getElementById('modal');
const modalTitle = document.getElementById('modal-title');
const modalBody = document.getElementById('modal-body');
const modalClose = document.getElementById('modal-close');
let modalReturnFocus = null;

function closeModal() {
  modal.classList.remove('active');
  if (modalReturnFocus && document.contains(modalReturnFocus)) modalReturnFocus.focus();
  modalReturnFocus = null;
}

modalClose.addEventListener('click', closeModal);
modal.addEventListener('click', (e) => {
  if (e.target === modal) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modal.classList.contains('active')) closeModal();
});

// Keyboard activation for custom buttons (nav items, filter chips,
// dashboard stat cards): Enter/Space clicks them like real buttons.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const el = e.target.closest && e.target.closest('[role="button"]');
  if (!el) return;
  e.preventDefault();
  el.click();
});

function openModal(title, content) {
  modalReturnFocus = document.activeElement;
  modalTitle.textContent = title;
  modalBody.innerHTML = content;
  modal.classList.add('active');
  const focusTarget = modal.querySelector('input:not([type="file"]), select, textarea') || modalClose;
  focusTarget.focus();
}

// The passcode lock screen is a full-screen overlay, so nothing behind it can
// be reached by pointer — but the keyboard still can. Escape is the one that
// matters: it would otherwise close whatever modal happened to be open at the
// moment the app locked, leaving it open behind the lock.
document.addEventListener('keydown', (e) => {
  if (isLocked() && e.key === 'Escape') e.stopPropagation();
}, true);

// Export/Import — Electron gets native dialogs; web/Android fall back to
// browser download + file picker. The sidebar buttons and the Settings
// buttons share these handlers so both entry points behave identically.
// Electron exposes a narrow preload bridge (no Node in the renderer).
async function handleExport() {
  if (window.sortedBridge) {
    await window.sortedBridge.exportData();
  } else {
    await exportData();
  }
}

async function handleImport() {
  if (window.sortedBridge) {
    const res = await window.sortedBridge.importData();
    if (res && res.error) showToast(res.error);
  } else {
    await importData();
  }
}

document.getElementById('export-btn').addEventListener('click', handleExport);
document.getElementById('import-btn').addEventListener('click', handleImport);

if (window.sortedBridge) {
  window.sortedBridge.onImport((data) => startImport(data));
}

// Page Rendering
// Two interactions in quick succession (saving an item, then tapping a
// filter) can leave two renders in flight; each renderer captures the
// generation it started in and only the newest one is allowed to paint.
let renderToken = 0;

async function renderPage() {
  const content = document.getElementById('content');
  // Both captured here, before the first await. Reading `currentPage` after the
  // loads meant a render could be asked for one tab and draw another, and
  // letting each render function capture `renderToken` itself meant a
  // superseded render picked up the *newest* token and was therefore allowed to
  // paint over the one that replaced it — which is how a slow page could leave
  // the wrong tab on screen with the nav highlighting the right one.
  const token = ++renderToken;
  const page = currentPage;

  try {
    // Every page needs the people list: to resolve a row's dot, to offer the
    // filter, or to stamp a form. One read, shared by the render below.
    await loadPeople();
    // Same for accounts — a row's allocation and every form's dropdown need them.
    await loadAccounts();
    // Somebody asked for a different page while these were loading.
    if (token !== renderToken) return;
    renderPersonChip();

    switch (page) {
      case 'dashboard':
        await renderDashboard(content);
        break;
      case 'spend':
        await renderSpend(content);
        break;
      case 'due':
        await renderDue(content);
        break;
      case 'savings':
        await renderSavings(content);
        break;
      case 'reports':
        await renderReports(content);
        break;
      case 'settings':
        renderSettings(content);
        // The list of what the phone has pending is a bridge call, and it must
        // not hold the page up: render from whatever is cached, then fill it in
        // when it arrives. Awaiting it here meant a bridge call that was slow —
        // or never answered, which is what a half-installed plugin does — left
        // Settings not appearing at all, showing whatever was on screen before.
        // That is the stale-screen fault from 2.23.0 in a new place.
        loadPendingReminders().then(() => {
          if (token !== renderToken) return;
          if (currentPage !== 'settings') return;
          renderSettings(content);
        });
        break;
    }
  } catch (err) {
    // A read can fail for reasons that are not about the data at all — most
    // often Android suspending the WebView and closing IndexedDB underneath a
    // render. Swallowing that left the previous page sitting there under a nav
    // highlighting the tab you had just asked for, which reads as "the tab
    // doesn't load". One retry with the connection re-opened, then say so
    // rather than leaving it blank.
    console.error('Render failed:', err);
    if (token !== renderToken) return;
    try {
      resetDbConnection();
      await loadPeople();
      await loadAccounts();
      if (token !== renderToken) return;
      console.warn('Retrying render after a connection reset');
      renderPage();
    } catch (retryErr) {
      console.error('Render failed again:', retryErr);
      if (token !== renderToken) return;
      content.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-text">Could not load this page</div>
          <p class="setting-hint" style="margin-bottom: 20px;">
            ${escapeHTML(String((retryErr && retryErr.message) || retryErr))}
          </p>
          <button class="btn btn-primary" onclick="renderPage()">Try again</button>
        </div>`;
    }
  }
}

// Dashboard
async function renderDashboard(container) {
  const token = renderToken;
  
  const [spendItems, dueItems, savingsItems] = await Promise.all([
    getAll('spend'),
    getAll('due'),
    getAll('savings')
  ]);
  
  // The month selector at the top scopes the two cards that have dates. The
  // Bills card uses the same rule as the Bills page, so the two never
  // disagree about what "September" owes.
  const spendMonth = spendItems.filter(i => isSameMonth(i.date, dashViewedDate));
  const spendYear = spendItems.filter(i => isSameYear(i.date, dashViewedDate));
  const spendMonthTotal = spendMonth.reduce((sum, i) => sum + i.amount, 0);
  const spendYearTotal = spendYear.reduce((sum, i) => sum + i.amount, 0);
  const dashYear = dashViewedDate.getFullYear();
  
  const { items: dueShown, overdueElsewhere } = billsForMonth(dueItems, dashViewedDate);
  const dueTotal = dueShown.reduce((sum, i) => sum + i.amount, 0);
  const overdueCount = dueShown.filter(i => isOverdue(i.dueDate)).length;
  
  const savingsCurrent = savingsItems.reduce((sum, i) => sum + i.current, 0);
  const savingsTarget = savingsItems.reduce((sum, i) => sum + i.target, 0);
  const savingsPct = savingsTarget > 0 ? Math.round((savingsCurrent / savingsTarget) * 100) : 0;
  
  // Category breakdowns
  const spendByCategory = groupByCategory(spendMonth, 'amount');
  const dueByCategory = groupByCategory(dueShown, 'amount');
  
  if (token !== renderToken) return;
  container.innerHTML = `
    <div class="page-toolbar">
      ${monthNavHtml('dash', dashViewedDate)}
      <button class="icon-btn icon-btn--float${syncConfigured() ? '' : ' icon-btn--quiet'}" id="sync-refresh"
              onclick="dashboardSyncNow(this)" aria-label="Sync and refresh"
              title="${syncConfigured() ? 'Sync with your server' : 'Set up sync in Settings'}">${REFRESH_SVG}</button>
    </div>

    <div class="dashboard-grid">
      <div class="stat-card" role="button" tabindex="0" onclick="navigate('spend')">
        <div class="stat-card-header">
          <span class="stat-card-title">Spent</span>
          <span class="stat-card-sub">${spendMonth.length} item${spendMonth.length === 1 ? '' : 's'}</span>
        </div>
        <div class="stat-card-value">${currency(spendMonthTotal)}</div>
        <div class="stat-card-sub">${currency(spendYearTotal)} in ${dashYear}</div>
        <div class="stat-card-progress">
          <div class="stat-card-progress-fill progress-spend" style="width: ${Math.min(100, (spendMonthTotal / 1000) * 100)}%"></div>
        </div>
        ${renderCategoryBreakdown(spendByCategory, spendMonthTotal, 'accent')}
      </div>
      
      <div class="stat-card" role="button" tabindex="0" onclick="navigate('due')">
        <div class="stat-card-header">
          <span class="stat-card-title">Bills</span>
          <span class="stat-card-sub">${dueShown.length} item${dueShown.length === 1 ? '' : 's'}</span>
        </div>
        <div class="stat-card-value" style="color: ${overdueCount > 0 ? 'var(--danger)' : 'var(--text-primary)'}">${currency(dueTotal)}</div>
        <div class="stat-card-sub">${overdueCount > 0 ? overdueCount + ' overdue' : 'Nothing overdue'}</div>
        ${overdueElsewhere.length > 0
          ? `<div class="stat-card-sub">includes ${overdueElsewhere.length} from an earlier month</div>` : ''}
        <div class="stat-card-progress">
          <div class="stat-card-progress-fill progress-due" style="width: ${Math.min(100, (dueTotal / 500) * 100)}%"></div>
        </div>
        ${renderCategoryBreakdown(dueByCategory, dueTotal, 'danger')}
      </div>
      
      <div class="stat-card" role="button" tabindex="0" onclick="navigate('savings')">
        <div class="stat-card-header">
          <span class="stat-card-title">Savings</span>
          <span class="stat-card-sub">${savingsItems.length} goals</span>
        </div>
        <div class="stat-card-value" style="color: var(--success)">${currency(savingsCurrent)}</div>
        <div class="stat-card-sub">${savingsPct}% of ${currency(savingsTarget)} target</div>
        <div class="stat-card-progress">
          <div class="stat-card-progress-fill progress-savings" style="width: ${savingsPct}%"></div>
        </div>
      </div>
    </div>
    
    <div class="chart-container">
      <div class="chart-header">
        <h2 class="chart-title">Monthly Trend</h2>
        <div class="chart-legend">
          <span class="legend-item"><span class="legend-swatch legend-recurring"></span>Recurring</span>
          <span class="legend-item"><span class="legend-swatch legend-oneoff"></span>One-off</span>
        </div>
      </div>
      <canvas id="trend-chart" class="chart-canvas"></canvas>
    </div>
  `;
  
  // Bills count towards the month they were paid in. Until 2.8.3 paying a bill
  // wrote a payment into Spend and the trend picked it up for free; when that
  // stopped, a month where the only activity was paying bills went blank —
  // which is exactly the month a trend is most worth looking at.
  const paidBills = dueItems
    .filter((d) => d.paid === true && d.dueDate)
    .map((d) => ({ ...d, date: d.dueDate, confirmed: true }));

  // Draw simple bar chart
  drawTrendChart([...spendItems, ...paidBills], dashViewedDate);
}

function groupByCategory(items, amountKey) {
  const totals = {};
  items.forEach(item => {
    totals[item.category] = (totals[item.category] || 0) + item[amountKey];
  });
  return totals;
}

// Bills for the month on screen: what's due then, plus — while you're looking
// at now or the future — anything already overdue wherever it was due. An
// unpaid bill is still payable, and dropping it the moment you tap ▶ is how a
// bill gets missed. Looking *back* is different: a past month is a record of
// what it held, and dragging the current overdue pile into it makes the
// history unreadable. Shared by the Bills page and the dashboard card so
// the two never disagree.
function billsForMonth(dueItems, date) {
  const now = new Date();
  const lookingBack = date.getFullYear() < now.getFullYear()
    || (date.getFullYear() === now.getFullYear() && date.getMonth() < now.getMonth());
  // A recurring bill's next occurrences, so stepping forward through the
  // months shows what they hold rather than an empty page. Kept out of
  // `inMonth` so the Total Due card still counts only what is actually stored
  // and actually owed — a projection is not a bill.
  const projections = projectionsForMonth(dueItems, date, 'dueDate');
  const inMonth = dueItems.filter((i) => i.paid !== true && isSameMonth(i.dueDate, date));
  // A paid bill is not overdue and is not outstanding. Left in, every future
  // month would carry this month's settled bill *and* project the next
  // occurrence of it — the same money twice, which is precisely what this
  // function's separation of stored from projected exists to prevent.
  const overdueElsewhere = lookingBack
    ? []
    : dueItems.filter((i) => i.paid !== true && isOverdue(i.dueDate) && !isSameMonth(i.dueDate, date));
  // Real and projected are handed back separately, never mixed into one list:
  // anything that sums what a month costs has to be able to tell them apart,
  // and a caller that can't is how a forecast ends up in a Total Due figure.
  const byDate = (a, b) => new Date(a.dueDate) - new Date(b.dueDate);
  const stored = [...inMonth, ...overdueElsewhere].sort(byDate);
  const items = [...stored, ...projections].sort(byDate);
  return { items, stored, projections, inMonth, overdueElsewhere };
}

function renderCategoryBreakdown(totals, grandTotal, tone) {
  const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 3);
  
  if (entries.length === 0) return '';
  
  return `
    <div class="category-breakdown">
      ${entries.map(([cat, amt]) => {
        const pct = grandTotal > 0 ? Math.round((amt / grandTotal) * 100) : 0;
        return `
          <div class="category-row">
            <span class="category-name" title="${escapeHTML(cat)}">${escapeHTML(cat)}</span>
            <div class="category-bar">
              <div class="category-bar-fill${tone ? ' tone-' + tone : ''}" style="width: ${pct}%"></div>
            </div>
            <span class="category-amount">${currency(amt)}</span>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function drawTrendChart(spendItems, focusDate) {
  const canvas = document.getElementById('trend-chart');
  if (!canvas) return;
  lastTrendItems = spendItems;
  lastTrendFocus = focusDate;

  // Size the backing store to the element's CSS box × devicePixelRatio —
  // the canvas used to sit at its default 300×150 stretched by CSS, which
  // rendered blurry and made the layout maths use the wrong width.
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const w = rect.width;
  const h = rect.height;

  // Colours follow the theme variables instead of the old hard-coded hexes.
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue('--accent').trim() || '#3d8bfd';
  const danger = css.getPropertyValue('--danger').trim() || '#ef4444';
  const muted = css.getPropertyValue('--text-secondary').trim() || '#8b8b96';
  const textPrimary = css.getPropertyValue('--text-primary').trim() || '#f0f0f5';
  const highlight = css.getPropertyValue('--chart-highlight').trim() || '#2b2b33';
  // The canvas sits inside a card, so it paints itself the card colour —
  // --bg-surface left a visible inset rectangle of a different shade.
  const surface = css.getPropertyValue('--bg-card').trim() || '#222228';
  const bodyFont = getComputedStyle(document.body).fontFamily || 'sans-serif';

  // The window ends on the month being looked at, so stepping back shows the
  // six months that led to it, and the month in question is marked.
  const end = focusDate ? new Date(focusDate.getFullYear(), focusDate.getMonth(), 1) : new Date();
  const months = [];

  for (let i = 5; i >= 0; i--) {
    const d = new Date(end.getFullYear(), end.getMonth() - i, 1);
    const inMonth = spendItems.filter((item) => isSameMonth(item.date, d));
    const sum = (list) => list.reduce((n, item) => n + item.amount, 0);
    const recurring = sum(inMonth.filter((item) => item.recurring));
    const oneOff = sum(inMonth.filter((item) => !item.recurring));
    months.push({
      label: d.toLocaleDateString('en-GB', { month: 'short' }),
      recurring,
      oneOff,
      total: recurring + oneOff,
      selected: focusDate ? isSameMonth(d, focusDate) : false
    });
  }

  const max = Math.max(...months.map(m => m.total), 100);
  const barWidth = w / months.length - 10;
  const baseline = h - 20;

  ctx.fillStyle = surface;
  ctx.fillRect(0, 0, w, h);

  months.forEach((m, i) => {
    const x = i * (barWidth + 10) + 5;
    const height = (m.total / max) * (h - 40);
    const y = baseline - height;

    // Mark the month in view before the bar, so the bar sits on top of it.
    if (m.selected) {
      ctx.fillStyle = highlight;
      ctx.fillRect(x - 3, y - 6, barWidth + 6, height + 6 + 20);
    }

    // One-off first from the baseline, recurring stacked on top of it — a
    // month's bar reads as "how much of this repeats every month".
    const oneOffHeight = max > 0 ? (m.oneOff / max) * (h - 40) : 0;
    const recurringHeight = max > 0 ? (m.recurring / max) * (h - 40) : 0;
    ctx.fillStyle = accent;
    if (oneOffHeight > 0) ctx.fillRect(x, baseline - oneOffHeight, barWidth, oneOffHeight);
    ctx.fillStyle = danger;
    if (recurringHeight > 0) ctx.fillRect(x, baseline - oneOffHeight - recurringHeight, barWidth, recurringHeight);

    // A sliver of a tiny total still has to be visible, or a month with only
    // a few pounds in it reads as no month at all.
    if (m.total > 0 && oneOffHeight + recurringHeight < 2) {
      ctx.fillStyle = accent;
      ctx.fillRect(x, baseline - 2, barWidth, 2);
    }

    ctx.fillStyle = m.selected ? textPrimary : muted;
    ctx.font = `12px ${bodyFont}`;
    ctx.textAlign = 'center';
    // Keep labels inside the canvas even when the window is narrow.
    const clamp = (cx, text) => {
      const half = ctx.measureText(text).width / 2;
      return Math.min(Math.max(cx, half + 1), w - half - 1);
    };
    ctx.fillText(m.label, clamp(x + barWidth / 2, m.label), h - 5);
    // Zero months show nothing useful — five stacked £0.00 labels used to
    // crowd the baseline (and overlap outright in narrow windows).
    if (m.total > 0) {
      ctx.fillText(currency(m.total), clamp(x + barWidth / 2, currency(m.total)), y - 10);
    }
  });
}

// Redraw the trend chart on window resize (the backing store is sized in
// device pixels, so a resize would otherwise leave it stretched).
let lastTrendItems = null;
let lastTrendFocus = null;
let trendResizeTimer = null;
window.addEventListener('resize', () => {
  if (currentPage !== 'dashboard' || !lastTrendItems) return;
  clearTimeout(trendResizeTimer);
  trendResizeTimer = setTimeout(() => drawTrendChart(lastTrendItems, lastTrendFocus), 150);
});

// settings.js calls this after a theme change: the chart is a canvas painted
// with colours read out of the CSS variables, so a restyle isn't enough.
function onThemeChanged() {
  if (currentPage === 'dashboard' && lastTrendItems) drawTrendChart(lastTrendItems, lastTrendFocus);
  if (currentPage === 'reports' && lastForecast) drawForecastChart(lastForecast);
}

// A single crisp tick, shared by the confirm (Spend) and mark-as-paid (Bills
// Due) boxes. Inline SVG rather than a "✓" character: the text glyph rendered
// thin and inconsistently placed, and read as a dot inside a circle rather
// than as a tick.
const TICK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>';

// A reached savings goal. Its own path rather than TICK_SVG, and the stroke
// attributes are on the element itself: TICK_SVG relies on .confirm-btn svg to
// set fill:none and stroke:currentColor, so reusing it under a different class
// filled the polyline solid and it rendered as a little black arrow rather than
// a tick. Stating them here means the mark looks the same wherever it's used.
const GOAL_TICK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"'
  + ' stroke-width="3" stroke-linecap="round" stroke-linejoin="round">'
  + '<polyline points="20 6.5 9.5 17 4 11.5"></polyline></svg>';

// Paperclip shown on rows that have a stored receipt.
const CLIP_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>';

// The dashboard's refresh button: sync if there is somewhere to sync to, then
// re-read either way.
//
// With no sync configured it is still worth a press — it re-reads the database,
// which is the thing you want after an import — so it works either way and just
// says which of the two it did.
async function dashboardSyncNow(btn) {
  if (btn) btn.classList.add('is-busy');
  let message = '';
  try {
    if (syncConfigured()) {
      const res = await syncNow();
      if (!res.ok) message = res.error;
      else if (res.did === 'pulled') message = 'Synced from your server';
      else if (res.did === 'pushed') message = 'Sent to your server';
      else if (res.did === 'created') message = 'Server set up';
      else message = 'Already up to date';
    }
  } catch (err) {
    message = String((err && err.message) || err);
  }
  if (btn) btn.classList.remove('is-busy');
  await renderPage();
  if (message) showToast(message);
}

function syncConfigured() {
  const s = syncSettings();
  const t = SYNC_TRANSPORTS[s.transport];
  return !!(t && t.available && s.url);
}

// The Sync card.
//
// Every transport is listed, whether or not it is built yet, because the choice
// of where the file lives is the decision and the list is how it's made. What
// isn't built says so rather than being hidden: a sync option that silently
// does nothing is worse than one that admits it isn't there yet.
//
// The snapshot file itself is the same whatever the transport, so switching is a
// matter of pointing at a different address — which is the honest answer to
// "how easy is it to change my mind later".
function syncSettingsHtml() {
  const s = syncSettings();
  const active = SYNC_TRANSPORTS[s.transport];
  const options = Object.keys(SYNC_TRANSPORTS).map((key) => {
    const t = SYNC_TRANSPORTS[key];
    return `<option value="${key}"${key === s.transport ? ' selected' : ''}>${escapeHTML(t.label)}${t.available ? '' : ' (not yet)'}</option>`;
  }).join('');

  const hasBackup = !!syncBackup();
  const status = !active
    ? 'Pick where to sync to.'
    : !active.available
      ? 'That option is not built yet.'
      : !s.url
        ? 'No address set.'
        : 'Ready';

  return `
    <div class="setting-row setting-row--inline setting-row--tight">
      <div class="setting-text">
        <div class="setting-label setting-label--title">Sync</div>
      </div>
      <div class="setting-control">
        <select class="form-input form-input--mini" id="sync-transport"
                aria-label="Where to sync to"
                onchange="setSyncSettings({transport: this.value}); renderPage();">${options}</select>
      </div>
    </div>
    <div class="setting-row setting-row--inline setting-row--tight">
      <div class="setting-text">
        <div class="setting-label">Address</div>
        <div class="setting-hint">${escapeHTML(active ? active.blurb : '')}</div>
      </div>
      <div class="setting-control setting-control--wide">
        <input class="form-input form-input--mini" id="sync-url" type="url" inputmode="url"
               placeholder="${escapeHTML(active ? active.urlHint : '')}"
               value="${escapeHTML(s.url)}"
               ${active && active.available ? '' : 'disabled'}
               onchange="setSyncSettings({url: this.value.trim()})">
      </div>
    </div>
    <div class="setting-row setting-row--inline setting-row--tight">
      <div class="setting-text">
        <div class="setting-label">Status</div>
        <div class="setting-hint">${escapeHTML(status)}</div>
      </div>
      <div class="setting-control">
        <button class="btn btn-ghost" onclick="syncFromSettings(this)"
                ${active && active.available && s.url ? '' : 'disabled'}>Sync now</button>
      </div>
    </div>
    ${hasBackup ? `
    <div class="setting-row setting-row--inline setting-row--tight">
      <div class="setting-text">
        <div class="setting-label">Replaced copy</div>
        <div class="setting-hint">Kept from the last time this device took data from the server</div>
      </div>
      <div class="setting-control">
        <button class="btn btn-ghost" onclick="restoreSyncBackupFromSettings(this)">Restore</button>
      </div>
    </div>` : ''}
    <p class="setting-hint" style="margin-top: 10px;">
      The whole of your data goes in one file, and whichever device wrote it last
      is what the other one gets. Run the host on a machine that stays on:
      <code>node tools/sync-host.mjs</code>
    </p>`;
}

async function syncFromSettings(btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Syncing…'; }
  let message;
  try {
    const res = await syncNow();
    if (!res.ok) message = res.error;
    else if (res.did === 'pulled') message = 'Took data from your server';
    else if (res.did === 'pushed') message = 'Sent your data';
    else if (res.did === 'created') message = 'Server set up';
    else message = 'Already up to date';
  } catch (err) {
    message = String((err && err.message) || err);
  }
  await renderPage();
  if (message) showToast(message, 6000);
}

async function restoreSyncBackupFromSettings(btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Restoring…'; }
  let message;
  try {
    const res = await restoreSyncBackup();
    message = res.ok ? 'Restored the copy that was replaced' : res.error;
  } catch (err) {
    message = String((err && err.message) || err);
  }
  await renderPage();
  if (message) showToast(message, 6000);
}

// The refresh arrow on the dashboard. Spins while a sync is running, so the
// button that can take a second is visibly the one doing it.
const REFRESH_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"'
  + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M21 12a9 9 0 1 1-2.64-6.36"></path><polyline points="21 3 21 9 15 9"></polyline></svg>';

// How a bill reads at a glance. Only counted down when the number is worth
// acting on: a raw "522 days" for a bill due in 2028 told the user nothing
// and looked like the app was incrementing something on its own.
// How long until it's due, in words, at every distance. This used to switch to
// "Scheduled" past a week, which is what replaced a countdown that was useful
// at any distance — a row whose date said 12 Oct and whose value said
// "Scheduled" told you nothing you couldn't already read off the date.
function dueCountdown(dueDate) {
  const days = daysUntil(dueDate);
  if (days < 0) {
    const n = Math.abs(days);
    return `<span style="color: var(--danger)">${n} day${n === 1 ? '' : 's'} overdue</span>`;
  }
  if (days === 0) return '<span style="color: var(--warning)">Due today</span>';
  if (days <= 7) return `<span style="color: var(--warning)">In ${days} day${days === 1 ? '' : 's'}</span>`;
  return `<span style="color: var(--text-secondary)">In ${days} days</span>`;
}

// What a bill is waiting for, in the fewest words that still say it.
//
// These ride on the same line as the due date, and the left of a row is about
// 164px once the amount and the tick have taken theirs. Every word here is one
// that line has to fit: "Due today" said "due" twice with the date beside it,
// and "overdue" is "late" — the row is already tinted red when it is.
function billTiming(item, isPaid) {
  if (isPaid) {
    // A settled bill is dated by its due date; the old Spend copy of a payment
    // had a date of its own. Both are read, because anyone's existing paid rows
    // are the Spend kind and anything paid from 2.8.3 is the other.
    //
    // No year, because it shares a line with the due date that already carries
    // one. A bill paid a year late reads oddly; a bill paid on time does not,
    // and the line has no room for both.
    return `Paid ${formatDate(item.date || item.dueDate).replace(/,?\s*\d{4}$/, '')}`;
  }
  const days = daysUntil(item.dueDate);
  if (days < 0) {
    const n = Math.abs(days);
    return `<span style="color: var(--danger)">${n} day${n === 1 ? '' : 's'} late</span>`;
  }
  if (days === 0) return '<span style="color: var(--warning)">Today</span>';
  if (days <= 7) return `<span style="color: var(--warning)">${days} day${days === 1 ? '' : 's'}</span>`;
  return `<span style="color: var(--text-secondary)">${days} days</span>`;
}

// The paperclip appears only when there is a picture. It used to sit on every
// row, dimmed, doubling as the way in to attach one — which meant a list of
// eight expenses had the same icon eight times and nothing said which ones had
// a receipt. Attaching one is still in the row's editor, where the rest of the
// row's detail is.
function receiptChip(item, type) {
  if (!item.receipt) return '';
  return `<button class="receipt-chip" data-action="receipt"
            data-type="${type}" data-id="${item.id}"
            title="View receipt"
            aria-label="View receipt for ${escapeHTML(item.title)}">${CLIP_SVG}</button>`;
}

// Spend Page
async function renderSpend(container) {
  const token = renderToken;
  
  const items = await getAll('spend');
  items.sort((a, b) => new Date(b.date) - new Date(a.date));
  
  const inMonth = items.filter(i => isSameMonth(i.date, viewedDate));
  const inYear = items.filter(i => isSameYear(i.date, viewedDate));
  // The totals follow the filters, so tapping a person chip changes what the
  // card is counting rather than leaving the household total above a list of
  // one person's items.
  // A recurring subscription projects its own next occurrence forward, so
  // stepping through the months shows what they'll hold. Projections sit
  // outside the totals: a forecast isn't money spent, and adding it to "Monthly
  // Total" would quietly overstate what has happened.
  // No projections on Spend. A recurring entry used to project its next
  // occurrence here, and since it was inert there was nothing to tap — a row
  // that looked like an entry you couldn't open. Spend is for the one-offs;
  // anything that repeats belongs on Bills, which projects there and is
  // payable.
  const projections = [];
  const monthItems = applySpendFilter(inMonth);
  const yearItems = applySpendFilter(inYear);
  const monthTotal = monthItems.reduce((sum, i) => sum + i.amount, 0);
  const yearTotal = yearItems.reduce((sum, i) => sum + i.amount, 0);
  
  if (token !== renderToken) return;
  container.innerHTML = `
    <div class="page-toolbar">
      ${monthNavHtml('spend', viewedDate)}
      <span class="toolbar-add">
        ${infoTipButton('spend-tip', 'Record your day-to-day or one-off spending here, then tick them off once paid. Bills that repeat every month belong on the Bills tab.')}
        <button class="btn btn-primary" onclick="openAddModal('spend')">+ Spend</button>
      </span>

    </div>
    
    <div class="stat-card" style="margin-bottom: 20px;">
      <div class="stat-card-header">
        <span class="stat-card-title">Monthly Total</span>
      </div>
      <div class="stat-card-value">${currency(monthTotal)}</div>
      <!-- Under the amount, not beside the title. Bills puts "Nothing overdue"
           on this line, and having the two cards of the same app disagree about
           where their second line goes is what makes the top of the screen jump
           as you move between tabs. Same shape, same place. -->
      <div class="stat-card-sub">Year: ${currency(yearTotal)}</div>
    </div>
    
    <div class="filter-bar" aria-label="Status">
      <span class="filter-chip ${spendFilter === 'all' ? 'active' : ''}" role="button" tabindex="0" onclick="filterSpend('all')">All</span>
      <span class="filter-chip ${spendFilter === 'confirmed' ? 'active' : ''}" role="button" tabindex="0" onclick="filterSpend('confirmed')">Confirmed</span>
      <span class="filter-chip ${spendFilter === 'pending' ? 'active' : ''}" role="button" tabindex="0" onclick="filterSpend('pending')">Pending</span>
    </div>
    <div class="filter-bar filter-bar--people" aria-label="Person">
      ${personChipsHtml()}
    </div>
    
    <div class="item-list" id="spend-list">
      ${renderSpendList(monthItems, inMonth.length > 0, monthTotal, projections)}
    </div>
  `;
}

function applySpendFilter(items) {
  const mine = items.filter(matchesPersonFilter);
  if (spendFilter === 'confirmed') return mine.filter(i => i.confirmed === true);
  if (spendFilter === 'pending') return mine.filter(i => !i.confirmed);
  if (spendFilter === 'recurring') return mine.filter(i => !!i.recurring);
  return mine;
}

function renderSpendList(monthItems, monthHasAnything, monthTotal, projections = []) {
  // Something in the month, but nothing matching: the chips above already say
  // why, so there's no need to name the filter here as well.
  if (monthItems.length === 0 && monthHasAnything) {
    return '<div class="empty-state"><div class="empty-state-text">No items match</div></div>';
  }
  // Projections follow the real rows so a month that has both reads in date
  // order rather than real-then-forecast.
  const rows = [...monthItems, ...projections]
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  return renderSpendItems(rows, monthTotal);
}

function renderSpendItems(items, total) {
  if (items.length === 0) {
    return `
      <div class="empty-state">
        <div class="empty-state-text">No spend recorded for this month</div>
        <button class="btn btn-primary" onclick="openAddModal('spend')">Add First Item</button>
      </div>
    `;
  }
  
  return items.map(item => {
    const pct = total > 0 ? Math.round((item.amount / total) * 100) : 0;
    // Same as a bill: a projected occurrence has no record behind it, so it
    // gets no actions and reads as a forecast rather than something to edit.
    const projected = !!item.projected;
    const editable = !projected && item.id;
    return `
      <div class="item-row item-row--lines${projected ? ' item-row--projected' : ''}"${editable ? ` data-edit-type="spend" data-edit-id="${item.id}"` : ''}>
        <div class="item-row-main">
          <div class="item-info">
            <div class="item-title">${escapeHTML(item.title)}</div>
            <div class="item-meta">${formatDate(item.date)}</div>
            <div class="item-meta item-meta--sub">
              ${escapeHTML(item.category)}
              ${isRecurring(item) ? `<span class="badge badge-recurring">${item.frequency === 'annually' ? 'Yearly' : 'Monthly'}</span>` : ''}
              ${projected ? '<span class="badge badge-projected">Projected</span>' : ''}
            </div>
          </div>
        </div>
        <div class="row-end">
          <div class="value-cell">${currency(item.amount)}</div>
          <div class="row-actions">
            ${editable ? receiptChip(item, 'spend') : ''}
            ${personDot(personById(item.personId))}
            ${projected ? '' : `<button class="confirm-btn" data-action="toggle" data-type="spend" data-id="${item.id}"
                    aria-pressed="${item.confirmed ? 'true' : 'false'}"
                    aria-label="${item.confirmed ? 'Unconfirm' : 'Confirm'} ${escapeHTML(item.title)}"
                    title="${item.confirmed ? 'Confirmed — tap to undo' : 'Confirm'}">${TICK_SVG}</button>`}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function filterSpend(filter) {
  spendFilter = filter;
  renderPage();
}

// Month stepper, shared by Dashboard, Spend and Bills so all three
// navigate identically — and so the control is the same width on every page
// (see .month-nav). Each page keeps its own cursor, so this takes which one to
// move rather than reaching for a shared global.
function monthCursor(which) {
  if (which === 'due') return dueViewedDate;
  if (which === 'dash') return dashViewedDate;
  return viewedDate;
}

function stepMonth(which, delta) {
  const cursor = monthCursor(which);
  cursor.setMonth(cursor.getMonth() + delta);
  renderPage();
}

// Tapping the month itself jumps back to the current month — otherwise a
// summary you're eight months from is only reachable by pressing ▶ a lot.
function goToThisMonth(which) {
  const cursor = monthCursor(which);
  const now = new Date();
  cursor.setFullYear(now.getFullYear(), now.getMonth(), 1);
  renderPage();
}

// One markup string for the selector, so the three pages can't drift apart.
function monthNavHtml(which, date) {
  return `
    <div class="month-nav">
      <button class="btn-icon" onclick="stepMonth('${which}', -1)" aria-label="Previous month">◀</button>
      <button class="month-label" onclick="goToThisMonth('${which}')" title="Back to ${escapeHTML(formatMonth(new Date()))}">${formatMonth(date)}</button>
      <button class="btn-icon" onclick="stepMonth('${which}', 1)" aria-label="Next month">▶</button>
    </div>
  `;
}

// Bills already paid in a given month, read out of Bills itself — that is where
// a settled bill lives now, so a past month stays reviewable rather than being
// just a date you stepped back to.
//
// Rows written before 2.8.3 paid a bill by writing its payment into Spend and
// rolling or deleting the bill, so those months have no paid bill here at all.
// They are still read from Spend as before, which is the only way a person's
// existing history stays visible after the model changed underneath it.
function paidBillsForMonth(dueItems, spendItems, date) {
  const settled = dueItems
    .filter((i) => i.paid === true && i.dueDate && isSameMonth(i.dueDate, date));
  const legacy = spendItems
    .filter((i) => i.paid === true && i.dueDate && isSameMonth(i.dueDate, date));
  return [...settled, ...legacy]
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
}

function applyDueFilter(outstanding, paid) {
  // The person filter applies to the list; the Total Due card deliberately
  // keeps counting the household, because what a bill is worth doesn't change
  // whose list you're looking at — and a card that dropped to £0 because of a
  // filter reads as "nothing owed".
  const mine = outstanding.filter(matchesPersonFilter);
  const minePaid = paid.filter(matchesPersonFilter);
  if (dueFilter === 'pending') return mine.map((i) => ({ item: i, paid: false }));
  if (dueFilter === 'confirmed') return minePaid.map((i) => ({ item: i, paid: true }));
  if (dueFilter === 'recurring') {
    return [...mine, ...minePaid]
      .filter((i) => i.recurring)
      .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))
      .map((i) => ({ item: i, paid: minePaid.includes(i) }));
  }
  // All: everything the month held, unpaid first, both in date order.
  return [
    ...mine.map((i) => ({ item: i, paid: false })),
    ...minePaid.map((i) => ({ item: i, paid: true }))
  ].sort((a, b) => new Date(a.item.dueDate) - new Date(b.item.dueDate));
}

function filterBills(filter) {
  dueFilter = filter;
  renderPage();
}

const BILL_FILTERS = [
  ['all', 'All'],
  ['confirmed', 'Confirmed'],
  ['pending', 'Pending'],
  ['recurring', 'Recurring']
];

// Due Page
async function renderDue(container) {
  const token = renderToken;
  
  const [all, spendItems] = await Promise.all([getAll('due'), getAll('spend')]);
  all.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
  
  // The month view exists so a recurring bill's *next* occurrences are
  // visible — a bill is only ever stored with the date it's currently due,
  // so without stepping forward there was no way to see what the following
  // few months look like.
  const { stored: outstanding, inMonth, overdueElsewhere, projections } = billsForMonth(all, dueViewedDate);
  const paid = paidBillsForMonth(all, spendItems, dueViewedDate);
  // Only the stored rows go through the filters; a forecast isn't a bill you
  // can have confirmed or pay, and letting a status chip hide it would make a
  // month look emptier than it is.
  const rows = applyDueFilter(outstanding, paid)
    .concat(projections.map((item) => ({ item, paid: false, projected: true })));
  
  // What's actually owed: the real stored rows only. Adding a forecast to this
  // figure would report money that hasn't been billed yet as though it already
  // were.
  const total = outstanding.reduce((sum, i) => sum + i.amount, 0);
  const overdue = outstanding.filter(i => isOverdue(i.dueDate));
  const upcoming = inMonth.length - inMonth.filter(i => isOverdue(i.dueDate)).length;
  
  if (token !== renderToken) return;
  container.innerHTML = `
    <div class="page-toolbar">
      ${monthNavHtml('due', dueViewedDate)}
      <span class="toolbar-add">
        ${infoTipButton('bill-tip', 'Record your recurring bills here, then tick them off once paid. Anything one-off and irregular belongs on the Spend tab.')}
        <button class="btn btn-primary" onclick="openAddModal('due')">+ Bill</button>
      </span>
    </div>
    
    <div class="stat-card" style="margin-bottom: 20px; ${overdue.length > 0 ? 'border-color: var(--danger);' : ''}">
      <div class="stat-card-header">
        <span class="stat-card-title">Total Due</span>
        <span class="stat-card-sub">${outstanding.length} unpaid</span>
      </div>
      <div class="stat-card-value" style="color: ${overdue.length > 0 ? 'var(--danger)' : 'var(--text-primary)'}">${currency(total)}</div>
      ${overdue.length > 0
        ? `<div class="stat-card-sub" style="color: var(--danger);">${overdue.length} overdue</div>`
        : `<div class="stat-card-sub">${upcoming > 0 ? 'Nothing overdue' : 'Nothing due this month'}</div>`}
      ${overdueElsewhere.length > 0
        ? `<div class="stat-card-sub">Includes ${overdueElsewhere.length} overdue from an earlier month</div>` : ''}
    </div>
    
    <div class="filter-bar" aria-label="Status">
      ${BILL_FILTERS.map(([value, label]) =>
        `<span class="filter-chip ${dueFilter === value ? 'active' : ''}" role="button" tabindex="0" onclick="filterBills('${value}')">${label}</span>`
      ).join('')}
    </div>
    <div class="filter-bar filter-bar--people" aria-label="Person">
      ${personChipsHtml()}
    </div>

    <div class="item-list">
      ${rows.length === 0 ? `
        <div class="empty-state">
          <div class="empty-state-text">${
            all.length === 0 && paid.length === 0
              ? 'No bills due'
              : personFilterActive() || dueFilter !== 'all'
                ? 'No bills match'
                : 'Nothing due this month'
          }</div>
          ${all.length > 0 || paid.length > 0
            ? '<p class="setting-hint" style="margin-bottom: 20px;">Use ◀ ▶ to see other months</p>'
            : '<button class="btn btn-primary" onclick="openAddModal(\'due\')">Add First Bill</button>'}
        </div>
      ` : rows.map(({ item, paid: isPaid, projected }) => {
        const days = daysUntil(item.dueDate);
        const isOverdueItem = !isPaid && !projected && days < 0;
        // A projection has no id to pay, open or attach anything to, so it
        // gets no buttons at all — clicking a forecast and finding you can't
        // act on it would be worse than leaving it inert.
        const editable = !projected && item.id;
        return `
          <div class="item-row item-row--lines${projected ? ' item-row--projected' : ''}"${editable ? ` data-edit-type="${isPaid && item.date ? 'spend' : 'due'}" data-edit-id="${item.id}"` : ''} style="${isOverdueItem ? 'border-color: var(--danger);' : ''}">
            <div class="item-row-main">
              <div class="item-info">
                <div class="item-title">${escapeHTML(item.title)}</div>
                <div class="item-meta">${formatDate(item.dueDate)} <span class="item-timing${isPaid ? ' item-timing--paid' : ''}">· ${billTiming(item, isPaid)}</span></div>
                <div class="item-meta item-meta--sub">
                  ${escapeHTML(item.category)}
                  ${isRecurring(item) ? `<span class="badge badge-recurring">${item.frequency === 'annually' ? 'Yearly' : 'Monthly'}</span>` : ''}
                  ${projected ? '<span class="badge badge-projected">Projected</span>' : ''}
                </div>
              </div>
            </div>
            <div class="row-end">
              <div class="value-cell">
                ${currency(item.amount)}
              </div>
              <div class="row-actions">
                ${editable ? receiptChip(item, isPaid && item.date ? 'spend' : 'due') : ''}
                ${personDot(personById(item.personId))}
                ${isPaid
                  ? `<button class="confirm-btn is-done" data-action="unpaid" data-type="due" data-id="${item.id}"
                       aria-pressed="true" aria-label="Mark ${escapeHTML(item.title)} as not paid"
                       title="Paid — tap to undo">${TICK_SVG}</button>`
                  : projected
                    ? ''
                    : `<button class="confirm-btn" data-action="paid" data-type="due" data-id="${item.id}"
                          aria-pressed="false" aria-label="Mark ${escapeHTML(item.title)} as paid" title="Mark as paid">${TICK_SVG}</button>`}
              </div>
            </div>
            ${projected
              ? `<div class="item-sub">Repeats ${item.frequency === 'annually' ? 'yearly' : 'monthly'}</div>`
              : ''}
          </div>
        `;
      }).join('')}
    </div>
  `;
}

// Savings Page
async function renderSavings(container) {
  const token = renderToken;
  
  const items = await getAll('savings');
  const totalCurrent = items.reduce((sum, i) => sum + i.current, 0);
  const totalTarget = items.reduce((sum, i) => sum + i.target, 0);
  const pct = totalTarget > 0 ? Math.round((totalCurrent / totalTarget) * 100) : 0;
  // Accounts live here because this is the page about where your money sits,
  // not because a current account is a savings goal — hence a separate section
  // rather than mixed into the goals list.
  const balances = await accountBalances();
  const totalBalance = balances.reduce((n, b) => n + b.balance, 0);
  const incomeItems = (await getAll('income'))
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const incomeTotal = incomeItems.reduce((n, i) => n + i.amount, 0);
  
  if (token !== renderToken) return;
  container.innerHTML = `
    <div class="page-toolbar page-toolbar--end page-toolbar--wrap">
      <button class="btn btn-primary" onclick="openAccountSetup()">+ Account</button>
      <button class="btn btn-primary" onclick="openIncomeSetup()">+ Income</button>
      <button class="btn btn-primary" onclick="openAddModal('savings')">+ Goal</button>
    </div>
    
    <div class="stat-card" style="margin-bottom: 20px;">
      <div class="stat-card-header">
        <span class="stat-card-title">Total Saved</span>
        <span class="stat-card-sub">${pct}% of target</span>
      </div>
      <div class="stat-card-value" style="color: var(--success)">${currency(totalCurrent)}</div>
      <div class="stat-card-sub">Target: ${currency(totalTarget)}</div>
      <div class="stat-card-progress" style="margin-top: 15px;">
        <div class="stat-card-progress-fill progress-savings" style="width: ${pct}%"></div>
      </div>
    </div>
    
    <div class="section-head">
      <span class="section-title">Accounts</span>
      <span class="stat-card-sub">${currency(totalBalance)}</span>
    </div>
    <div class="item-list">
      ${balances.map(renderAccountRow).join('')}
    </div>

    <div class="page-toolbar page-toolbar--end" style="margin-top: 10px;">
      <button class="btn btn-ghost" onclick="openTransferModal()">Move money</button>
    </div>

    <div class="section-head">
      <span class="section-title">Income</span>
      <span class="stat-card-sub">${currency(incomeTotal)}</span>
    </div>
    <div class="item-list">
      ${incomeItems.length === 0
        ? '<div class="empty-state"><div class="empty-state-text">No income recorded</div></div>'
        : incomeItems.map(renderIncomeRow).join('')}
    </div>

    <div class="section-head" id="goals-section">
      <span class="section-title">Goals</span>
    </div>
    <div class="item-list">
      ${items.length === 0 ? `
        <div class="empty-state">
          <div class="empty-state-text">No savings goals yet</div>
          <button class="btn btn-primary" onclick="openAddModal('savings')">Add First Goal</button>
        </div>
      ` : items.map(item => {
        const goalPct = item.target > 0 ? Math.round((item.current / item.target) * 100) : 0;
        // Reached means current has met or beaten the target. The whole card
        // turns green with the text flipped to black: a goal that's done
        // should look done from across the room, and the usual green-on-green
        // amount would be unreadable on a green card.
        const done = item.target > 0 && item.current >= item.target;
        return `
          <div class="item-row item-row--lines${done ? ' item-row--done' : ''}" data-edit-type="savings" data-edit-id="${item.id}">
            <div class="item-row-main">
              <div class="item-info">
                <div class="item-title">${escapeHTML(item.title)}</div>
                <div class="item-meta">${goalPct}% complete</div>
                <div class="item-meta item-meta--sub">
                  ${escapeHTML(item.category)}
                  <span class="item-timing">of ${currency(item.target)}</span>
                </div>
              </div>
            </div>
            <div class="row-end">
              <div class="value-cell value-cell--wide">
                <div class="item-amount"${done ? '' : ' style="color: var(--success)"'}>${currency(item.current)}</div>
                <div class="stat-card-progress" style="margin-top: 8px;">
                  <div class="stat-card-progress-fill progress-savings" style="width: ${Math.min(100, goalPct)}%"></div>
                </div>
              </div>
              <div class="row-actions row-actions--stack">
                ${done ? `<span class="goal-tick" role="img" aria-label="Goal reached" title="Goal reached">${GOAL_TICK_SVG}</span>` : ''}
                ${personDot(personById(item.personId))}
              </div>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

// An account row. No progress bar — a balance isn't progress towards anything,
// and a bar drawn across a number that goes up and down would imply a target
// that doesn't exist. What it does show is the three things that moved it, so
// the number can be argued with.
function renderAccountRow(row) {
  const account = accountById(row.id);
  const over = row.balance < 0;
  const parts = [
    ['Spend', row.spend],
    ['Bills', row.bills],
    ['Goals', row.savings]
  ].filter(([, v]) => v > 0);

  return `
    <div class="item-row item-row--lines item-row--account" data-account-id="${row.id}" onclick="openAccountSetup('${row.id}')">
      <div class="item-row-main">
        <div class="item-info">
          <div class="item-title">${escapeHTML(row.name)}</div>
          <div class="item-meta">${row.type === CASH_TYPE ? 'Cash' : 'Bank'}</div>
          <div class="item-meta item-meta--sub">
            <span class="item-timing">${[
              parts.map(([k, v]) => `${k} ${currency(v)}`).join(' · '),
              (row.transferIn || row.transferOut || row.adjustment) ? transferSummary(row) : ''
            ].filter(Boolean).join(' · ')}</span>
          </div>
        </div>
      </div>
      <div class="row-end">
        <div class="value-cell value-cell--wide">
          <div class="item-amount" style="color: ${over ? 'var(--danger)' : 'var(--text-primary)'};">
            ${currency(row.balance)}
          </div>
        </div>
        <div class="row-actions">
          <button class="btn btn-ghost btn-frequency" onclick="event.stopPropagation(); openAccountActivity('${row.id}')">Activity</button>
        </div>
      </div>
    </div>
  `;
}

// What else moved this balance, in one line. Only the parts that happened.
function transferSummary(row) {
  const bits = [];
  if (row.transferIn) bits.push(`${currency(row.transferIn)} in`);
  if (row.transferOut) bits.push(`${currency(row.transferOut)} out`);
  if (row.adjustment) bits.push(`${currency(row.adjustment)} adjusted`);
  return bits.join(' · ');
}

// Adding or editing an account. The opening balance is what it holds today, not
// what it held when the app started tracking: transactions that predate the
// account are not allocated to it, so an opening figure from months ago would
// double-count everything since.
// An income row. Tappable to edit, like the account rows beside it — the page
// is one place for all three, so all three behave the same way.
function renderIncomeRow(item) {
  return `
    <div class="item-row item-row--lines" onclick="openIncomeSetup('${item.id}')">
      <div class="item-row-main">
        <div class="item-info">
          <div class="item-title">${escapeHTML(item.title)}</div>
          <div class="item-meta">${formatDate(item.date)}</div>
          <div class="item-meta item-meta--sub">
            <span class="item-timing">${[
              incomeCategoryLabel(item.category),
              item.accountId ? accountName(item.accountId) : ''
            ].filter(Boolean).join(' · ')}</span>
          </div>
        </div>
      </div>
      <div class="row-end">
        <div class="value-cell value-cell--wide">
          <div class="item-amount" style="color: var(--success);">${currency(item.amount)}</div>
        </div>
        <div class="row-actions">
          <button class="btn btn-ghost btn-frequency" onclick="event.stopPropagation(); toggleIncomeRecurring('${item.id}', this)">${incomeRepeatLabel(item)}</button>
          ${personDot(personById(item.personId))}
        </div>
      </div>
    </div>
  `;
}

async function openIncomeSetup(id) {
  const item = id ? await getItem('income', id) : null;
  if (id && !item) return;
  const accounts = [...accountsCache.values()];
  const people = [...peopleCache.values()];

  openModal(item ? 'Edit income' : 'Add income', `
    <div class="form-group">
      <label class="form-label" for="income-title">What for</label>
      <input type="text" class="form-input" id="income-title" maxlength="100"
             placeholder="e.g., Salary" value="${escapeHTML(item ? item.title : '')}">
    </div>
    <div class="form-group">
      <label class="form-label" for="income-amount">Amount</label>
      <input type="number" class="form-input" id="income-amount" step="0.01" min="0"
             value="${item ? item.amount : ''}" placeholder="0.00">
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label" for="income-category">Kind</label>
        <select class="form-input" id="income-category">
          ${INCOME_CATEGORIES.map(([v, label]) => `<option value="${v}"${item && item.category === v ? ' selected' : ''}>${label}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label" for="income-frequency">Repeats</label>
        <select class="form-input" id="income-frequency">
          ${FREQUENCY_CHOICES.map((f) => `<option value="${f.value}"${(item ? (item.frequency || 'no') : 'no') === f.value ? ' selected' : ''}>${f.label}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="form-group">
      <label class="form-label" for="income-date">Date</label>
      <input type="date" class="form-input" id="income-date" value="${item ? item.date : localISO()}">
    </div>
    <div class="form-group">
      <label class="form-label" for="income-account">Into account</label>
      <select class="form-input" id="income-account">
        <option value="">Not into an account</option>
        ${accounts.map((a) => `<option value="${a.id}"${item && item.accountId === a.id ? ' selected' : ''}>${escapeHTML(a.name)}</option>`).join('')}
      </select>
    </div>
    <div class="form-group">
      <label class="form-label" for="income-person">Whose</label>
      <select class="form-input" id="income-person">
        <option value="">Anyone</option>
        ${people.map((p) => `<option value="${p.id}"${item && item.personId === p.id ? ' selected' : ''}>${escapeHTML(p.name)}</option>`).join('')}
      </select>
    </div>
    <button class="btn btn-primary" style="width: 100%; margin-top: 10px;" onclick="saveIncome('${id || ''}')">${item ? 'Save' : 'Add income'}</button>
    ${item ? `<button class="btn btn-danger" style="width: 100%; margin-top: 8px;" onclick="confirmRemoveIncome('${item.id}', this)">Delete</button>` : ''}
  `);
}

async function saveIncome(id) {
  const title = document.getElementById('income-title').value;
  const amount = Number.parseFloat(document.getElementById('income-amount').value);
  const category = document.getElementById('income-category').value;
  const frequency = document.getElementById('income-frequency').value;
  const date = document.getElementById('income-date').value;
  const accountId = document.getElementById('income-account').value || null;
  const personId = document.getElementById('income-person').value || null;

  if (!String(title || '').trim()) return showFormError('Please enter what it was for', 'income-title');
  if (!(amount > 0)) return showFormError('Please enter an amount greater than 0', 'income-amount');
  if (!date) return showFormError('Please enter a date', 'income-date');

  const fields = {
    title: String(title).trim().slice(0, 100),
    amount,
    category,
    frequency: frequency === 'no' ? null : frequency,
    date,
    accountId,
    personId
  };

  if (id) {
    const item = await getItem('income', id);
    if (!item) return;
    await updateItem('income', { ...item, ...fields, id });
    showToast('Income updated');
  } else {
    await addIncome(fields);
    showToast('Income added');
  }
  closeModal();
  await renderPage();
}

async function confirmRemoveIncome(id, btn) {
  if (btn.dataset.confirming !== '1') {
    btn.dataset.confirming = '1';
    btn.textContent = 'Really delete? Click again';
    setTimeout(() => {
      btn.dataset.confirming = '';
      btn.textContent = 'Delete';
    }, 4000);
    return;
  }
  await removeIncome(id);
  closeModal();
  showToast('Income deleted');
  await renderPage();
}

// The balance the row actually shows, so the editor and the list agree.
function accountCurrentBalance(accountId) {
  const cached = accountBalanceCache.get(accountId);
  if (cached) return Math.round(cached.balance * 100) / 100;
  const account = accountById(accountId);
  if (!account) return '';
  return Math.round((account.opening || 0) * 100) / 100;
}

// What an account has held, over time. Editing the account and reading its
// activity are different questions, so the row offers both: the row itself
// edits, and this is one tap away beside it.
async function openAccountActivity(id) {
  const account = accountById(id);
  if (!account) return;
  const entries = await accountActivity(id);
  const balance = (accountBalanceCache.get(id) || {}).balance || 0;

  const rows = entries.length === 0
    ? '<div class="empty-state"><div class="empty-state-text">Nothing recorded against this account yet</div></div>'
    : `<div class="item-list">${entries.map((e) => `
        <div class="item-row item-row--lines">
          <div class="item-row-main">
            <div class="item-info">
              <div class="item-title">${escapeHTML(e.title || e.label)}</div>
              <div class="item-meta">${e.date ? formatDate(e.date) : ''}</div>
              <div class="item-meta item-meta--sub">${e.title ? `<span class="item-timing">${escapeHTML(e.label)}</span>` : ''}</div>
            </div>
          </div>
          <div class="row-end">
            <div class="value-cell value-cell--wide">
              <div class="item-amount" style="color: var(--${e.tone === 'in' ? 'success' : 'danger'});">
                ${e.amount < 0 ? '−' : '+'}${currency(Math.abs(e.amount))}
              </div>
            </div>
          </div>
        </div>`).join('')}</div>`;

  openModal(escapeHTML(account.name), `
    <div class="stat-card" style="margin-bottom: 16px;">
      <div class="stat-card-header">
        <span class="stat-card-title">${account.type === CASH_TYPE ? 'Cash' : 'Bank'}</span>
      </div>
      <div class="stat-card-value">${currency(balance)}</div>
    </div>
    ${rows}`);
}

function openAccountSetup(id) {
  const account = id ? accountById(id) : null;
  const isCash = account ? account.type === CASH_TYPE : false;

  openModal(account ? `Edit ${escapeHTML(account.name)}` : 'Add an account', `
    <div class="form-group">
      <label class="form-label" for="account-name">Name</label>
      <input type="text" class="form-input" id="account-name" maxlength="40"
             placeholder="${isCash ? 'Cash' : 'e.g. Current account'}" value="${escapeHTML(account ? account.name : '')}">
    </div>
    ${account ? '' : `
    <div class="form-group">
      <label class="form-label" for="account-type">Type</label>
      <select class="form-input" id="account-type">
        <option value="bank">Bank account</option>
        <option value="cash"${isCash ? ' selected' : ''}>Cash</option>
      </select>
    </div>`}
    <div class="form-group">
      <label class="form-label" for="account-opening">Balance now</label>
      <input type="number" class="form-input" id="account-opening" step="0.01"
             value="${account ? accountCurrentBalance(account.id) : ''}" placeholder="0.00">
      ${account ? '<p class="setting-hint">What this account holds today. Entering a different figure corrects the balance.</p>' : ''}
    </div>
    ${account ? `
    <div class="form-group">
      <label class="form-label" for="account-adjustment">Adjustments</label>
      <input type="number" class="form-input" id="account-adjustment" step="0.01"
             value="${account.adjustment}" placeholder="0.00">
    </div>` : ''}
    ${account ? `
    <button class="btn btn-primary" style="width: 100%; margin-top: 10px;" onclick="saveAccount('${account.id}')">Save</button>
    <button class="btn btn-danger" style="width: 100%; margin-top: 8px;" onclick="confirmRemoveAccount('${account.id}', this, true)">Remove account</button>`
    : '<button class="btn btn-primary" style="width: 100%; margin-top: 10px;" onclick="saveAccount()">Add account</button>'}
  `);
}

async function saveAccount(id) {
  const name = document.getElementById('account-name').value;
  const opening = document.getElementById('account-opening').value;
  if (!String(name || '').trim()) return showFormError('Please enter a name', 'account-name');

  if (id) {
    const account = accountById(id);
    const adjustment = document.getElementById('account-adjustment')?.value;
    // "Balance now" is what the account holds today, so it has to mean that.
    // The stored opening balance is the baseline everything recorded since was
    // applied to, so with £100 of spend on the books, typing 100 into a field
    // labelled "Balance now" left the row reading 40.
    //
    // Rather than relabel the field and keep the surprise, the number is
    // converted on the way in: the figures already applied to this account are
    // added back, so what you type is what the row then shows.
    const balances = await accountBalances();
    const row = balances.find((b) => b.id === id);
    const applied = row
      ? (row.spend || 0) + (row.bills || 0) + (row.savings || 0)
        - (row.income || 0) - (row.transferIn || 0) + (row.transferOut || 0)
      : 0;
    await updateItem('accounts', {
      ...account,
      name: String(name).trim().slice(0, 40),
      opening: (Number.parseFloat(opening) || 0) + applied,
      adjustment: Number.parseFloat(adjustment) || 0
    });
    showToast('Account updated');
  } else {
    const type = document.getElementById('account-type')?.value === CASH_TYPE ? CASH_TYPE : 'bank';
    const added = await addAccount(name, type, opening);
    if (!added) return showFormError('An account with that name already exists', 'account-name');
    showToast('Account added');
  }
  closeModal();
  await renderPage();
}

// Two-step, like every other destructive control here. Reached from the account
// editor, so the modal is open and has to close on the way out.
async function confirmRemoveAccount(id, btn, fromModal) {
  const account = accountById(id);
  if (!account) return;
  if (btn.dataset.confirming !== '1') {
    const balances = await accountBalances();
    const row = balances.find((b) => b.id === id);
    const spent = (row.spend || 0) + (row.bills || 0) + (row.savings || 0);
    btn.dataset.confirming = '1';
    // Say what happens to the money, not just that the row goes. Entries keep
    // their history and show "Unassigned" until someone re-picks an account.
    btn.textContent = spent > 0
      ? `Unassign ${currency(spent)}? Tap again`
      : 'Tap again to remove';
    setTimeout(() => {
      btn.dataset.confirming = '';
      btn.textContent = 'Remove';
    }, 5000);
    return;
  }
  await removeAccount(id);
  if (fromModal) closeModal();
  showToast(`${account.name} removed`);
  await renderPage();
}

function openTransferModal() {
  const accounts = [...accountsCache.values()];
  if (accounts.length < 2) {
    showToast('Add another account first');
    return;
  }
  const options = (exclude) => accounts
    .filter((a) => a.id !== exclude)
    .map((a) => `<option value="${a.id}">${escapeHTML(a.name)}</option>`).join('');

  openModal('Move money', `
    <div class="form-group">
      <label class="form-label" for="transfer-amount">Amount</label>
      <input type="number" class="form-input" id="transfer-amount" step="0.01" min="0" placeholder="0.00">
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label" for="transfer-from">From</label>
        <select class="form-input" id="transfer-from">${options()}</select>
      </div>
      <div class="form-group">
        <label class="form-label" for="transfer-to">To</label>
        <select class="form-input" id="transfer-to">${options(accounts[0].id)}</select>
      </div>
    </div>
    <div class="form-group">
      <label class="form-label" for="transfer-date">Date</label>
      <input type="date" class="form-input" id="transfer-date" value="${localISO()}">
    </div>
    <button class="btn btn-primary" style="width: 100%; margin-top: 10px;" onclick="saveTransfer()">Move</button>
  `);
}

async function saveTransfer() {
  const amount = Number.parseFloat(document.getElementById('transfer-amount').value);
  const fromId = document.getElementById('transfer-from').value;
  const toId = document.getElementById('transfer-to').value;
  const date = document.getElementById('transfer-date').value;

  if (!(amount > 0)) return showFormError('Please enter an amount greater than 0', 'transfer-amount');
  if (fromId === toId) return showFormError('Pick two different accounts', 'transfer-to');
  if (!date) return showFormError('Please enter a date', 'transfer-date');

  await addItem('transfers', { amount, fromId, toId, date, note: '' });
  closeModal();
  showToast(`${currency(amount)} moved`);
  await renderPage();
}

// The small "i" that sits between a month stepper and its add button, on the
// two pages that mean different things by an entry: Spend is the one-offs,
// Bills is what repeats.
function infoTipButton(id, text) {
  // The dot and the button it belongs to are wrapped as one group, so the
  // toolbar's own flex gap doesn't sit between them and the pair hugs the right
  // edge together. The wrapper carries margin-left:auto, which is what puts the
  // pair opposite the month stepper.
  return `<span class="toolbar-add">
    <span class="info-tip">
      <button class="info-tip-btn" aria-label="What is this page for"
              aria-describedby="${id}" onclick="toggleInfoTip('${id}', this)">i</button>
      <span class="info-tip-body" id="${id}" role="tooltip">${escapeHTML(text)}</span>
    </span>
  </span>`;
}

function toggleInfoTip(id, btn) {
  const body = document.getElementById(id);
  if (!body) return;
  const open = body.classList.toggle('is-open');
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  // One at a time. Two open at once on a phone means they overlap the thing
  // they are explaining.
  if (open) {
    document.querySelectorAll('.info-tip-body.is-open').forEach((el) => {
      if (el.id !== id) {
        el.classList.remove('is-open');
        el.previousElementSibling?.setAttribute('aria-expanded', 'false');
      }
    });
  }
}

/* -----------------------------------------------------------------------------
   Patterns
   Everything here is arithmetic on what is already in the database. No network,
   no key, no model, nothing about you leaving the device — which is the whole
   reason these exist instead of a search API.

   They are deliberately the questions a person actually asks of their own
   statements: which day do I spend on, and is this week normal.
   -------------------------------------------------------------------------- */

const PATTERN_WEEKS = 8;
const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Midnight on the Monday of the week `d` falls in. Weeks start on Monday because
// that is how a payslip and a bank statement count them, and a Sunday-start week
// splits a weekend's spending across two.
function weekStart(d) {
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const shift = (date.getDay() + 6) % 7;   // Sunday is 0, so +6 makes Monday 0
  date.setDate(date.getDate() - shift);
  return date;
}

// The weeks in the window that actually have something recorded in them.
//
// Averaging across all eight weeks whether or not you recorded anything in them
// is wrong in a way that quietly misleads: with four weeks of data in an
// eight-week window, "your usual week" came out at £35 instead of £70, so every
// real week read as above average and the card was permanently alarmed. Empty
// weeks are not zero-spend weeks, they are unrecorded ones.
function recordedWeeks(spendItems, from, to) {
  const weeks = new Set();
  for (const item of spendItems) {
    if (!item.date) continue;
    const d = new Date(String(item.date) + 'T00:00:00');
    if (Number.isNaN(d.getTime()) || d < from || d > to) continue;
    weeks.add(weekStart(d).getTime());
  }
  return weeks;
}

// Average spend per weekday, over the last PATTERN_WEEKS weeks.
//
// Averaged over the window rather than a single recent week: one week is four
// purchases on a Saturday and tells you Saturday is expensive, when really you
// bought a sofa. Averaging the same weekday across eight weeks is the difference
// between a pattern and a coincidence — across the weeks that were recorded, so
// a fortnight of not entering anything doesn't halve every average.
function weekdayAverages(spendItems) {
  const today = new Date();
  const thisMonday = weekStart(today);
  const windowStart = new Date(thisMonday);
  windowStart.setDate(windowStart.getDate() - PATTERN_WEEKS * 7);

  const weeks = recordedWeeks(spendItems, windowStart, today);
  const divisor = weeks.size;

  const sums = new Array(7).fill(0);
  for (const item of spendItems) {
    if (!item.date) continue;
    const d = new Date(String(item.date) + 'T00:00:00');
    if (Number.isNaN(d.getTime()) || d < windowStart || d > today) continue;
    sums[(d.getDay() + 6) % 7] += Number(item.amount) || 0;
  }

  const averages = divisor
    ? sums.map((sum) => sum / divisor)
    : sums.map(() => 0);
  const total = averages.reduce((a, b) => a + b, 0);
  const busiest = averages.reduce((best, v, i) => (v > averages[best] ? i : best), 0);
  const quietest = averages.reduce((best, v, i) => (v < averages[best] ? i : best), 0);
  return {
    averages,
    total,
    busiest,
    quietest,
    weeks: PATTERN_WEEKS,
    recordedWeeks: divisor,
    // Only meaningful with enough data to be a pattern rather than a rumour.
    enough: divisor >= 3 && sums.reduce((a, b) => a + b, 0) > 0
  };
}

// This week against your ordinary one. A partial week is compared like for like:
// the same number of days into it, so a Monday isn't 80% down by lunchtime and
// called a saving.
function weekComparison(spendItems) {
  const today = new Date();
  const thisMonday = weekStart(today);
  const daysIn = (d) => (d.getDay() + 6) % 7;   // Monday 0

  const elapsed = daysIn(today) + 1;           // today counts
  const thisWeek = spendItems
    .filter((i) => i.date && new Date(String(i.date) + 'T00:00:00') >= thisMonday)
    .reduce((sum, i) => sum + (Number(i.amount) || 0), 0);

  // The previous PATTERN_WEEKS weeks, each truncated to `elapsed` days, so every
  // one is compared over the same slice of the week.
  const previousTotals = [];
  for (let w = 1; w <= PATTERN_WEEKS; w++) {
    const start = new Date(thisMonday);
    start.setDate(start.getDate() - w * 7);
    const end = new Date(start);
    end.setDate(end.getDate() + elapsed);
    let sum = 0;
    for (const item of spendItems) {
      if (!item.date) continue;
      const d = new Date(String(item.date) + 'T00:00:00');
      if (d >= start && d < end) sum += Number(item.amount) || 0;
    }
    previousTotals.push(sum);
  }

  // Only the weeks that were recorded. Averaging over empty ones is what made
  // "your usual" read as £35 when four recorded weeks said £70.
  const recorded = previousTotals.filter((v) => v > 0);
  const usual = recorded.length ? recorded.reduce((a, b) => a + b, 0) / recorded.length : 0;
  return {
    thisWeek,
    usual,
    elapsed,
    difference: thisWeek - usual,
    // Three pounds either way on a £40 week is rounding, not a change.
    notable: usual > 0 && Math.abs(thisWeek - usual) / usual > 0.15,
    enough: recorded.length >= 3
  };
}

function renderPatternsCard(patterns, week) {
  if (!patterns.enough) {
    return `<div class="setting-hint" style="padding: 8px 0;">${patterns.recordedWeeks} week${patterns.recordedWeeks === 1 ? '' : 's'} of spending so far.</div>`;
  }
  const peak = Math.max(...patterns.averages) || 1;
  const rows = patterns.averages.map((avg, i) => `
    <div class="category-row">
      <span class="category-name">${WEEKDAY_NAMES[i]}</span>
      <div class="category-bar">
        <div class="category-bar-fill" style="width: ${Math.round((avg / peak) * 100)}%"></div>
      </div>
      <span class="category-amount">${currency(avg)}</span>
    </div>`).join('');

  // One short line, because this is the only thing in the card the bars above
  // don't already show. It used to be a full sentence naming the heaviest and
  // lightest day, which is what the chart is for.
  const weekLine = week.enough
    ? (week.notable
      ? `<div class="pattern-note">This week ${week.difference > 0 ? 'up' : 'down'} ${currency(Math.abs(week.difference))}</div>`
      : `<div class="pattern-note">This week is usual</div>`)
    : '';

  return `
    ${weekLine}
    <div class="pattern-sub">Average a day, last ${patterns.weeks} weeks</div>
    ${rows}`;
}

// Asks GitHub what the newest published release is and compares it with the
// running build.
//
// The app has no server, so this is a plain unauthenticated request to one
// public URL. It sends the request and nothing else: no build id, no device
// detail, no data of yours. Nothing is downloaded or installed without asking —
// Android requires a human to confirm any install regardless, and a finance app
// quietly replacing itself is not something to do to someone by surprise.
async function checkForUpdate(btn) {
  const note = document.getElementById('update-note');
  const say = (text) => { if (note) note.textContent = text; };
  if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
  const restore = () => { if (btn) { btn.disabled = false; btn.textContent = 'Check'; } };

  const RELEASES_API = 'https://api.github.com/repos/jaquesbody/sorted/releases/latest';
  try {
    const res = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`GitHub said ${res.status}`);
    const data = await res.json();
    const latest = String(data.tag_name || '').replace(/^v/, '');
    const here = String(APP_VERSION || '');

    // Compare as numbers, not strings: "2.9.0" is older than "2.10.0" and a
    // string compare says otherwise, which is the sort of thing that quietly
    // reports "up to date" forever.
    const parts = (v) => String(v).split('.').map((n) => parseInt(n, 10) || 0);
    const [a, b] = [parts(latest), parts(here)];
    let cmp = 0;
    for (let i = 0; i < 3; i++) {
      const x = a[i] || 0, y = b[i] || 0;
      if (x !== y) { cmp = x > y ? 1 : -1; break; }
    }

    if (!latest) {
      say('Could not read the release name from GitHub.');
    } else if (cmp > 0) {
      say(`v${latest} is available — you have v${here}.`);
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Get it';
        btn.onclick = () => { window.open(data.html_url, '_blank', 'noopener'); };
        return;
      }
    } else if (cmp === 0) {
      say(`Up to date. This is v${here}.`);
    } else {
      say(`You have v${here}, which is newer than the published v${latest}.`);
    }
  } catch (err) {
    say(`Could not check: ${String((err && err.message) || err)}`);
  } finally {
    restore();
  }
}

// Reports Page
async function renderReports(container) {
  const token = renderToken;
  const [spendItems, dueItems, savingsItems] = await Promise.all([
    getAll('spend'),
    getAll('due'),
    getAll('savings')
  ]);
  const balances = await accountBalances();
  // The forecast is always the twelve months ahead of you, so it ignores the
  // range chips — asking "this month" of a chart about next year is a question
  // with no answer, not a chart with an empty bar.
  const forecast = await buildForecast();
  lastForecast = forecast;

  // Range chips scope spending and bills; savings goals have no dates,
  // so their total stays lifetime.
  const inRange = (dateStr) => reportRange === 'all' ? true
    : reportRange === 'month' ? isThisMonth(dateStr)
    : isThisYear(dateStr);
  const rangedSpend = spendItems.filter(i => inRange(i.date));
  // What is owed, so a bill already settled is out of it. A paid bill used to
  // be deleted on payment; it now stays in this store marked paid, which
  // means without this filter every past month stepped back to would report
  // rent as still due.
  const rangedDue = dueItems.filter(i => i.paid !== true && inRange(i.dueDate));

  // Computed from everything stored, not from the range chips: "which days do I
  // spend on" is a habit, and scoping it to "this month" would answer it with
  // four weeks of noise.
  const weekday = weekdayAverages(spendItems);
  const week = weekComparison(spendItems);

  const totalSpend = rangedSpend.reduce((sum, i) => sum + i.amount, 0);
  const totalDue = rangedDue.reduce((sum, i) => sum + i.amount, 0);
  const totalSavings = savingsItems.reduce((sum, i) => sum + i.current, 0);

  const chip = (value, label) =>
    `<span class="filter-chip ${reportRange === value ? 'active' : ''}" role="button" tabindex="0" onclick="setReportRange('${value}')">${label}</span>`;

  if (token !== renderToken) return;
  container.innerHTML = `
    <div class="page-toolbar">
      <div class="filter-bar">
        ${chip('all', 'All time')}
        ${chip('month', 'This month')}
        ${chip('year', 'This year')}
      </div>
    </div>
    
    <div class="reports-grid">
      <div class="report-card">
        <h2 class="report-title">Forecast</h2>
        ${renderForecastCard(forecast)}
      </div>

      <div class="report-card">
        ${reportHead('<h2 class="report-title">Spending by Category</h2>', totalSpend, 'accent')}
        ${renderReportBreakdown(groupByCategory(rangedSpend, 'amount'), totalSpend, 'accent')}
      </div>
      
      <div class="report-card">
        ${reportHead('<h2 class="report-title">Bills by Category</h2>', totalDue, 'danger')}
        ${renderReportBreakdown(groupByCategory(rangedDue, 'amount'), totalDue, 'danger')}
      </div>

      <div class="report-card">
        <h2 class="report-title">Who Spent What</h2>
        ${renderPersonBreakdown(rangedSpend, rangedDue)}
      </div>

      <div class="report-card">
        ${reportHead('<h2 class="report-title">Where Your Money Is</h2>',
          balances.reduce((n, b) => n + b.balance, 0), null)}
        ${renderBalanceBreakdown(balances)}
      </div>

      <div class="report-card">
        <h2 class="report-title">Patterns</h2>
        ${renderPatternsCard(weekday, week)}
      </div>

      <div class="report-card">
        ${reportHead(`<h2 class="report-title report-title--link" role="button" tabindex="0"
            onclick="goToGoals()" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();goToGoals();}"
            title="Go to your goals">Savings by Goal</h2>`, totalSavings, 'success')}
        ${renderSavingsBreakdown(savingsItems)}
      </div>
    </div>
  `;

  if (token === renderToken) drawForecastChart(forecast);
}

// A card's own total, sitting under its breakdown. The separate Summary card
// repeated all three in one place, which meant reading one number required
// scrolling past two other cards to find it — and the total is the thing the
// breakdown below it adds up to, so it belongs at the foot of that breakdown.
// A card's title and its total, on one line.
//
// The total used to be a row of its own below the breakdown, which cost every
// one of these cards a whole line to say something the heading already implies:
// "Spending by Category ... £123.00". On a phone that line is a fifth of the
// card. The label went with it — "Total Spent" under a heading that already
// says Spending said the same thing twice.
function reportHead(title, amount, tone) {
  return `
    <div class="report-head">
      ${title}
      <span class="report-head-total${tone ? ' tone-' + tone : ''}">${currency(amount)}</span>
    </div>`;
}

// Savings goals measured against their own target, not against each other —
// the bar answers "how far along is this goal", where the other two cards
// answer "how does this split up".
function renderSavingsBreakdown(goals) {
  if (goals.length === 0) {
    return '<div style="color: var(--text-secondary); padding: 20px 0;">No savings goals yet</div>';
  }
  return goals.map((goal) => {
    const pct = goal.target > 0 ? Math.round((goal.current / goal.target) * 100) : 0;
    return `
      <div class="category-row">
        <span class="category-name" title="${escapeHTML(goal.title)}">${escapeHTML(goal.title)}</span>
        <div class="category-bar">
          <div class="category-bar-fill tone-success" style="width: ${Math.min(100, pct)}%"></div>
        </div>
        <span class="category-amount">${currency(goal.current)}</span>
      </div>
    `;
  }).join('');
}

// From a Reports summary to the list it summarises.
function goToGoals() {
  closeModal();
  navigate('savings');
  // The goals are below the accounts and income on that page, so open straight
  // onto them rather than making someone scroll past both to get there.
  requestAnimationFrame(() => {
    const goals = document.getElementById('goals-section');
    if (goals) goals.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function setReportRange(range) {
  reportRange = range;
  renderPage();
}

function renderReportBreakdown(totals, grandTotal, tone) {
  const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  
  if (entries.length === 0) {
    return '<div style="color: var(--text-secondary); padding: 20px 0;">No data yet</div>';
  }
  
  return entries.map(([cat, amt]) => {
    const pct = grandTotal > 0 ? Math.round((amt / grandTotal) * 100) : 0;
    return `
      <div class="category-row">
        <span class="category-name" title="${escapeHTML(cat)}">${escapeHTML(cat)}</span>
        <div class="category-bar">
          <div class="category-bar-fill${tone ? ' tone-' + tone : ''}" style="width: ${pct}%"></div>
        </div>
        <span class="category-amount">${currency(amt)}</span>
      </div>
    `;
  }).join('');
}

// Each account's balance, with the three things that moved it. A balance on its
// own can't be argued with — a number that doesn't show its working is a
// number you have to trust.
function renderBalanceBreakdown(balances) {
  if (!balances.length) {
    return '<div style="color: var(--text-secondary); padding: 20px 0;">No accounts yet</div>';
  }
  return `
    ${balances.map((b) => {
      // Only the things that actually moved. A row reading "Bills £0.00,
      // Goals £0.00, In £0.00" says nothing — four zeros beside the number
      // that's already there is just noise competing with it.
      const parts = [
        ['Spend', b.spend, 'accent'],
        ['Bills', b.bills, 'danger'],
        ['Goals', b.savings, 'success'],
        ['Income', b.income, 'muted'],
        ['Moved in', b.transferIn, 'muted']
      ].filter(([, v]) => v > 0);
      return `
        <div class="account-total">
          <div class="account-total-top">
            <span class="account-total-name">${escapeHTML(b.name)}</span>
            <span class="account-total-amount${b.balance < 0 ? ' is-negative' : ''}">${currency(b.balance)}</span>
          </div>
          <div class="account-split">
            ${parts.length
              ? parts.map(([label, value, tone]) => balanceSegment(label, value, tone)).join('')
              : '<span class="account-seg">Nothing recorded yet</span>'}
          </div>
        </div>
      `;
    }).join('')}
  `;
}

function balanceSegment(label, value, tone) {
  return `<span class="account-seg">
    <i class="account-seg-swatch tone-${tone}"></i>${label} ${currency(value)}
  </span>`;
}

/* Forecast
   --------------------------------------------------------------------------
   Twelve months forward, not twelve months back. The question it answers is
   "when do I run out", which is the only question a spending app is asked once
   the entering has stopped being interesting.

   Five lines, and the relationship between them is the whole point:

     Total money     bold green   what you'd have, month by month
     Total est costs bold red     everything projected to leave, cumulatively
     Spend           thin         the one number you have to guess at
     Bills           thin         known, because a bill has a date
     Savings         thin         your own plan, per goal

   The two bold lines crossing is the answer. Everything below them exists so
   you can see which of the three is responsible.

   Transfers are absent on purpose. Money moving between your own accounts is
   not income, and counting both sides of it makes the chart say you earn what
   you spend.

   Two inputs can't be derived honestly, so both are derived anyway and both
   are editable — see `forecastSpendEstimate` and `goalMonthlyContribution`.
   ---------------------------------------------------------------------------*/

const FORECAST_MONTHS = 12;
const FORECAST_SPEND_KEY = 'sorted-forecast-spend';
// Six months is long enough to smooth a single expensive week and short enough
// that a year ago has no vote.
const FORECAST_SPEND_MONTHS = 6;

function forecastMonths(count = FORECAST_MONTHS) {
  const now = new Date();
  const out = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    out.push({
      y: d.getFullYear(),
      m: d.getMonth() + 1,
      date: d,
      label: d.toLocaleDateString('en-GB', { month: 'short' })
    });
  }
  return out;
}

// The average of your non-recurring spending over the last six months.
//
// Averaged over the months that actually have entries, not over the whole
// window: someone who started logging three months ago shouldn't have their
// spending halved by two months nobody wrote anything down.
//
// This is a bad forecast and it is labelled as one. A boiler or a car in the
// window turns every month on the chart wrong, which is exactly why it can be
// overwritten.
function averageNonRecurringSpend(spendItems) {
  const now = new Date();
  // The window ends at the end of LAST month, never today.
  //
  // A month in progress is not a month. Counting it as one dragged the average
  // down by whatever it happened to hold: six months at £100 each with £10
  // logged two days into the seventh averaged £85, because two days' spending
  // was being treated as a full month and then averaged against six real ones.
  // That is the same "average is too low at the start of the month" symptom,
  // one level further down than the empty-month case.
  //
  // Extrapolating instead — £10 over two days scaled to a month — is worse: two
  // days is not a sample, and a single big purchase on day one would predict a
  // ruinous month. An unfinished month simply does not vote.
  const cutoff = new Date(now.getFullYear(), now.getMonth() - FORECAST_SPEND_MONTHS, 1);
  const inWindow = spendItems.filter((i) => {
    // Bill payments are excluded, and this is the fix for the duplication.
    // Pre-2.8.3 rows marked a bill paid by writing its payment into Spend, so
    // averaging those alongside real spending teaches the forecast to pay the
    // same rent twice: once as a projected bill, once inside the average.
    // New payments never land here at all.
    if (i.paid === true) return false;
    const d = new Date(String(i.date || '') + 'T00:00:00');
    return !Number.isNaN(d.getTime()) && d >= cutoff && d < new Date(now.getFullYear(), now.getMonth(), 1);
  });
  if (inWindow.length === 0) return 0;
  const months = new Set(inWindow.map((i) => i.date.slice(0, 7))).size;
  return inWindow.reduce((n, i) => n + i.amount, 0) / months;
}

function getForecastSpendOverride() {
  const raw = localStorage.getItem(FORECAST_SPEND_KEY);
  if (raw === null) return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// Removed rather than stored as null: "use the average" and "I've decided it's
// zero" are different answers, and only one of them is a number.
function setForecastSpendOverride(value) {
  if (value === null || !Number.isFinite(value) || value < 0) {
    localStorage.removeItem(FORECAST_SPEND_KEY);
  } else {
    localStorage.setItem(FORECAST_SPEND_KEY, String(Math.round(value * 100) / 100));
  }
}

function forecastSpendEstimate(spendItems) {
  const override = getForecastSpendOverride();
  return override === null ? averageNonRecurringSpend(spendItems) : override;
}

// What a goal contributes to the forecast each month: only what the user said.
//
// It used to fall back to "what's left, spread over the twelve months between
// the goal's creation and a fixed horizon" — dividing by a horizon that was
// never shown and couldn't be changed. That made the forecast assert a savings
// rate nobody had decided on, and the savings form asked people to approve it
// with wording nobody could parse: "leave blank to work it out", "worked out
// from what's left and the time remaining", when there was no end date to have
// a time remaining to. The fallback is gone. A goal with an explicit monthly
// still counts; a goal without one contributes nothing, which is the honest
// answer for a self-maintained figure.
//
// Existing goals keep whatever they were given — nothing here deletes a stored
// monthly, so an entry set in an earlier version still plans the same way.
function goalMonthlyContribution(goal) {
  if (typeof goal.monthly === 'number' && Number.isFinite(goal.monthly) && goal.monthly >= 0) {
    return goal.monthly;
  }
  return 0;
}

function yearMonthIndex(date) {
  return date.getFullYear() * 12 + date.getMonth();
}

// Midnight today, local. Every date comparison in the forecast goes through
// this so a bill due "today" is never treated as yesterday's because of an
// hour boundary somewhere.
function todayMidnight() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// The days in a window of `rangeMonths` months starting `startOffset` months
// back. A window can start in the past, which is how stepping backwards works.
function forecastDayList(rangeMonths, startOffset) {
  const today = todayMidnight();
  const start = new Date(today.getFullYear(), today.getMonth() - startOffset, 1);
  const end = new Date(start.getFullYear(), start.getMonth() + rangeMonths, 0);
  const days = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) days.push(new Date(d));
  return { days, start, end };
}

// The earliest day this device holds anything at all, as midnight local, or
// null if it holds nothing. Anything earlier is not "no spending", it is "this
// app wasn't in use", and the forecast must not draw a line through it.
function earliestRecordedDate(...lists) {
  let earliest = null;
  for (const list of lists) {
    for (const item of list || []) {
      const raw = String(item.date || item.dueDate || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) continue;
      if (!earliest || raw < earliest) earliest = raw;
    }
  }
  if (!earliest) return null;
  const d = new Date(earliest + 'T00:00:00');
  return Number.isNaN(d.getTime()) ? null : d;
}

const FORECAST_RANGES = [
  { value: 1, label: '1 month' },
  { value: 3, label: '3 months' },
  { value: 6, label: '6 months' },
  { value: 12, label: '12 months' }
];

let forecastRange = 3;
let forecastOffset = 0;

function setForecastRange(value) {
  forecastRange = Number(value) || 3;
  renderPage();
}

// `forward` counts months back, which reads backwards at the call site, so it
// is spelled out here once: stepForecastMonth(-1) moves towards the present,
// +1 moves away from it. The two were the wrong way round — "back" clamped
// itself to a no-op at the current month while "forward" walked further into
// the past, so one arrow did nothing and the other did the opposite of what it
// said.
function stepForecastMonth(forward) {
  const next = forecastOffset + forward;
  // Bounded at twelve months back. Beyond that the reconstruction is guesswork
  // dressed as history, and a control that can reach the previous decade
  // invites someone to trust it.
  forecastOffset = Math.min(12, Math.max(0, next));
  renderPage();
}

function resetForecastWindow() {
  forecastOffset = 0;
  renderPage();
}

// The forecast, day by day.
//
// A row is "what your balance is on this date", which is the question a
// household actually has. The five lines are all amounts as at that day —
// the balance itself, and the running totals of what came in and went out —
// so they share one scale honestly, with no second axis and nothing squashed
// against the floor.
//
// Days before today are rebuilt from what was really recorded. Days from today
// on are projected. Stepping back therefore shows history rather than a
// forecast of history, which is the only way to tell whether the forecast has
// ever been right.
async function buildForecast(rangeMonths = forecastRange, startOffset = forecastOffset) {
  const [incomeItems, dueItems, spendItems, savingsItems] = await Promise.all([
    getAll('income'), getAll('due'), getAll('spend'), getAll('savings')
  ]);
  const balances = await accountBalances();
  const today = todayMidnight();
  // Named span, not window: shadowing the global inside a function this long is
  // asking for a bug three edits from now.
  const span = forecastDayList(rangeMonths, startOffset);
  // Nothing before this device's first entry is knowable. Stepping back six
  // months on a young database used to draw a line anyway — the walk-back adds
  // back bills and income it can see and subtracts spend it can't, which happens
  // to produce a smooth plausible curve that is entirely fiction. The chart now
  // starts where the data does, so an empty stretch is visibly empty rather
  // than confidently wrong.
  const firstKnown = earliestRecordedDate(spendItems, dueItems, incomeItems);
  const days = span.days.filter((d) => !firstKnown || d >= firstKnown);
  const start = days.length ? days[0] : span.start;
  const spendEstimate = forecastSpendEstimate(spendItems);
  const add = (map, iso, amount) => {
    if (!iso) return;
    map.set(iso, (map.get(iso) || 0) + amount);
  };

  // What really happened, keyed by day.
  const realBills = new Map();
  const realSpend = new Map();
  const realIncome = new Map();
  // A payment left in Spend by a pre-2.8.3 bill is a bill, not ordinary
  // spending. Counting it as spend put a month of rent under the blue line and
  // left Bills at zero, which put Total est costs exactly on top of Spend — and
  // two lines drawn on identical pixels read as a third colour. The purple
  // line on the graph was that, not a mystery.
  for (const item of spendItems) {
    if (item.paid === true) continue;
    add(realSpend, String(item.date || '').slice(0, 10), item.amount);
  }
  for (const item of incomeItems) add(realIncome, String(item.date || '').slice(0, 10), item.amount);
  // Paid bills only, so this agrees with accountBalances, which also only
  // deducts bills that have actually been paid. Counting an unpaid one would
  // mean the forecast started from a different balance than the balance card
  // shows, which is the sort of disagreement nobody notices until the numbers
  // are £500 apart.
  //
  // Both shapes of a paid bill count: a settled row from 2.8.3 onwards, and the
  // payment copy older bills leave in Spend. Without the second, every month
  // anyone paid bills before this release reads as having no bills at all.
  for (const item of dueItems) {
    if (item.paid !== true) continue;
    add(realBills, String(item.dueDate || '').slice(0, 10), item.amount);
  }
  for (const item of spendItems) {
    if (item.paid !== true || !item.dueDate) continue;
    add(realBills, String(item.dueDate).slice(0, 10), item.amount);
  }

  // What's coming. Built per month so a recurring bill lands on its own day,
  // which is the entire reason for this chart existing: a bill on the 1st and
  // pay on the 15th are a fortnight apart and only a day-by-day view shows the
  // gap between them.
  const plannedBills = new Map();
  const plannedIncome = new Map();
  const months = new Set(days.map((d) => `${d.getFullYear()}-${d.getMonth()}`));
  for (const key of months) {
    const [yy, mm] = key.split('-').map(Number);
    const monthDate = new Date(yy, mm, 1);
    const { inMonth, projections } = billsForMonth(dueItems, monthDate);
    // A month already past is history: only what is stored counts, because a
    // recurring bill paid last month has had its stored date rolled forward
    // and would otherwise be counted a second time as a projection.
    const rows = monthDate < new Date(today.getFullYear(), today.getMonth(), 1)
      ? inMonth
      : [...inMonth, ...projections];
    for (const row of rows) {
      if (row.paid === true) continue;
      add(plannedBills, String(row.dueDate || '').slice(0, 10), row.amount);
    }
  }

  // Income is projected only for dates that have not happened yet. This is the
  // whole of the double-count fix: a salary recorded on the 1st is already
  // inside the account balance, so projecting it forward as well counted the
  // same £1,000 twice. What is already in the bank stays in the bank; only
  // money that has not arrived yet is added.
  for (const item of incomeItems) {
    const frequency = frequencyOf(item);
    if (!frequency) {
      const iso = String(item.date || '').slice(0, 10);
      if (iso && iso > localISO(today)) add(plannedIncome, iso, item.amount);
      continue;
    }
    for (const key of months) {
      const [yy, mm] = key.split('-').map(Number);
      const occurrence = occurrenceInMonth(item.date, frequency, new Date(yy, mm, 1));
      if (occurrence && occurrence > localISO(today)) add(plannedIncome, occurrence, item.amount);
    }
  }

  const savingsPlans = savingsItems.map((goal) => ({
    from: String(goal.createdAt || '').slice(0, 10) || localISO(today),
    monthly: goalMonthlyContribution(goal)
  }));

  // The balance at the window's first day. Today's balance already contains
  // everything recorded up to today, so walking backwards means adding back
  // what was taken out and removing what was put in.
  // Money already set aside in a goal has left your available balance, so it
  // isn't part of "what you'd have". A goal tied to an account is already out of
  // that account's balance; one with no account never was, and was counting as
  // spendable from money that is sitting in the jar. Both come off here, once.
  const setAside = savingsItems.reduce((n, goal) => {
    const backed = goal.accountId && balances.some((b) => b.id === goal.accountId);
    return backed ? n : n + (goal.current || 0);
  }, 0);
  const currentBalance = balances.reduce((n, b) => n + b.balance, 0) - setAside;
  const startISO = localISO(start);
  let running = currentBalance;
  for (const d of days) {
    const iso = localISO(d);
    if (iso >= startISO && iso < localISO(today)) {
      running += (realBills.get(iso) || 0) + (realSpend.get(iso) || 0) - (realIncome.get(iso) || 0);
    }
  }

  const daysInMonth = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const series = [];
  let cumIncome = 0, cumSavings = 0;
  // Bills and spending are month to date, and reset on the first. A running
  // total across the whole window climbs without limit, so by August the line
  // said "you have spent £21,000" — which is not a comparison of anything, just
  // a bigger number. What is worth reading is how far into this month you are,
  // so each month starts again at nothing and climbs to what that month costs.
  let mtdBills = 0, mtdSpend = 0;

  for (const d of days) {
    const iso = localISO(d);
    const actual = d < today;
    let income, bills, spend, savings = 0;

    if (actual) {
      income = realIncome.get(iso) || 0;
      bills = realBills.get(iso) || 0;
      spend = realSpend.get(iso) || 0;
    } else {
      income = plannedIncome.get(iso) || 0;
      bills = plannedBills.get(iso) || 0;
      // Variable spending has no dates, so it accrues at a daily rate. That is
      // the honest way to draw a smooth line from an estimate, and it is what
      // makes the balance dip by a plausible amount between paydays rather
      // than jumping once a month.
      spend = spendEstimate / daysInMonth(d);
      // A goal is a plan, so it only accrues from today — there is no record
      // of what went in on which day, and inventing one would put a smooth
      // line through last month as though it were fact.
      if (iso >= localISO(today)) {
        savings = savingsPlans
          .filter((pl) => pl.monthly > 0 && iso >= pl.from)
          .reduce((n, pl) => n + pl.monthly / daysInMonth(d), 0);
      }
    }

    // Putting money in a jar takes it out of your available balance, so it
    // leaves Total money rather than arriving in it. It was added here, on the
    // reasoning that a jar isn't spending — true of Total est costs, which is
    // bills plus spend and has never included savings, but not true of what
    // you'd have: a plan to save £200 a month is £200 a month you will not
    // spend, and adding it back reported a balance the money can't reach.
    // Savings still isn't a cost, so it stays out of Total est costs.
    running += income - savings - bills - spend;
    cumIncome += income;
    cumSavings += savings;

    // Month to date, reset at the turn of the month.
    if (d.getDate() === 1) { mtdBills = 0; mtdSpend = 0; }
    mtdBills += bills;
    mtdSpend += spend;

    series.push({
      date: iso,
      d,
      label: d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }),
      balance: running,
      income: cumIncome,
      // Month to date, so they fall back to nothing on the 1st and tell you
      // how the current month is going rather than how far into the window you
      // have got.
      bills: mtdBills,
      spend: mtdSpend,
      savings: cumSavings,
      costs: mtdBills + mtdSpend,
      actual
    });
  }

  // The number the guides all say matters: the lowest projected balance, and
  // when it happens. Not a monthly average — a specific bad day.
  const ahead = series.filter((p) => !p.actual);
  const low = ahead.length ? ahead.reduce((a, b) => (b.balance < a.balance ? b : a)) : null;
  const short = low && low.balance < 0 ? low : null;

  return {
    series,
    days,
    rangeMonths,
    startOffset,
    opening: balances.reduce((n, b) => n + b.balance, 0),
    spendEstimate,
    average: averageNonRecurringSpend(spendItems),
    overridden: getForecastSpendOverride() !== null,
    low,
    short
  };
}

function renderForecastCard(data) {
  const { series, rangeMonths, startOffset } = data;

  const rangeChips = FORECAST_RANGES.map((r) => `
    <option value="${r.value}"${Number(rangeMonths) === r.value ? ' selected' : ''}>${r.label}</option>
  `).join('');

  const legend = [
    ['Total money', 'success', 'is-bold'],
    ['Total est costs', 'danger', 'is-bold'],
    ['Spend', 'accent', ''],
    ['Bills', 'danger', '']
  ].map(([label, tone, mod]) => `
    <span class="split-key"><i class="split-swatch tone-${tone} ${mod}"></i>${label}</span>
  `).join('');

  // The window's own dates, so stepping back is never a mystery about what you
  // are looking at.
  const from = data.days[0];
  const to = data.days[data.days.length - 1];
  const fmt = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

  return `
    <div class="forecast-nav">
      <button class="btn btn-ghost forecast-step" onclick="stepForecastMonth(1)"
              aria-label="Back one month"${startOffset >= 12 ? ' disabled' : ''}>&larr;</button>
      <div class="forecast-when">
        <div class="forecast-range">
          <select class="form-input" id="forecast-range-select" aria-label="How far ahead to project" onchange="setForecastRange(this.value)">
            ${rangeChips}
          </select>
        </div>
        <div class="forecast-span">${escapeHTML(fmt(from))} &ndash; ${escapeHTML(fmt(to))}</div>
      </div>
      <button class="btn btn-ghost forecast-step" onclick="stepForecastMonth(-1)"
              aria-label="Forward one month"${startOffset <= 0 ? ' disabled' : ''}>&rarr;</button>
    </div>

    <canvas id="forecast-chart" class="chart-canvas" style="height: 240px;"></canvas>
    <div class="split-legend">${legend}</div>

    <div class="setting-row" style="margin-top: 14px;">
      <div class="setting-text">
        <div class="setting-label">Monthly spending (${data.overridden ? 'set by you' : `${FORECAST_SPEND_MONTHS} month average`})</div>
        <div class="setting-hint">edit to see how it impacts your forecast</div>
      </div>
      <div class="setting-control">
        <input type="number" step="0.01" min="0" id="forecast-spend-input" class="form-input"
               style="width: 110px; text-align: right;" value="${round2(data.spendEstimate)}">
        <button class="btn btn-primary" onclick="saveForecastSpend()">Save</button>
        ${data.overridden ? `<button class="btn btn-ghost" onclick="useAverageSpend()">Average</button>` : ''}
      </div>
    </div>
  `;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function saveForecastSpend() {
  const input = document.getElementById('forecast-spend-input');
  const value = Number.parseFloat(input.value);
  if (!(value >= 0)) {
    showToast('Enter an amount of 0 or more');
    input.value = round2(getForecastSpendOverride() ?? 0);
    return;
  }
  setForecastSpendOverride(value);
  showToast(`Monthly spending set to ${currency(value)}`);
  renderPage();
}

function useAverageSpend() {
  setForecastSpendOverride(null);
  showToast('Using your average again');
  renderPage();
}

// Stashed so a resize or theme change can repaint without re-reading the
// database — same arrangement as the dashboard's trend chart.
let lastForecast = null;
let forecastResizeTimer = null;
window.addEventListener('resize', () => {
  if (currentPage !== 'reports' || !lastForecast) return;
  clearTimeout(forecastResizeTimer);
  forecastResizeTimer = setTimeout(() => drawForecastChart(lastForecast), 150);
});

function drawForecastChart(data) {
  const canvas = document.getElementById('forecast-chart');
  if (!canvas) return;
  const series = data.series;
  if (!series.length) return;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const w = rect.width;
  const h = rect.height;

  const css = getComputedStyle(document.documentElement);
  const surface = css.getPropertyValue('--bg-card').trim() || '#222228';
  const accent = css.getPropertyValue('--accent').trim() || '#3d8bfd';
  const danger = css.getPropertyValue('--danger').trim() || '#ef4444';
  const success = css.getPropertyValue('--success').trim() || '#22c55e';
  const muted = css.getPropertyValue('--text-secondary').trim() || '#8b8b96';
  const grid = css.getPropertyValue('--border').trim() || '#2b2b33';
  const bodyFont = getComputedStyle(document.body).fontFamily || 'sans-serif';

  ctx.fillStyle = surface;
  ctx.fillRect(0, 0, w, h);

  // Room on the left for the axis figures. This used to be 8px, because the
  // chart had two figures in the corner and neither needed a gutter.
  const padL = 42;
  const padR = 10;
  const padT = 12;
  const padB = 26;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const values = [];
  for (const p of series) values.push(p.balance, p.costs, p.spend, p.bills);
  let min = Math.min(0, ...values);
  let max = Math.max(0, ...values);
  if (max === min) max = min + 1;

  // Round figures, so the gridlines land on numbers a person would actually
  // say out loud. A scale topping out at £6,487 is not a figure anyone reads.
  //
  // The previous version computed its step a power of ten too small — £9,000
  // became £100 increments and ninety overlapping labels stacked into an
  // unreadable black smear down the left edge. A gridline has to be readable,
  // not merely present, so the count is bounded as well as the size.
  const niceStep = (span) => {
    const raw = Math.max(1, span / 5);
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / pow;
    return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * pow;
  };
  // A household balance is a thousands figure, so thousands are the default
  // step; below that, fall back to a sensible round number.
  let step = max >= 1500 ? 1000 : niceStep(max - min);
  // Bounded either way. Past about ten lines they stop being reference and
  // start being hatching.
  while ((max - min) / step > 10) step *= 2;
  if (step < 1) step = 1;

  max = Math.ceil(max * 1.04 / step) * step;
  min = Math.floor(min / step) * step;
  if (max - min < step) max = min + step * 2;

  const y = (v) => padT + plotH - ((v - min) / (max - min)) * plotH;
  const x = (i) => padL + (series.length === 1 ? plotW / 2 : (i / (series.length - 1)) * plotW);

  // Faint grey lines every step, each with its figure. This is what makes a
  // value readable off the chart rather than guessed at.
  ctx.font = `10px ${bodyFont}`;
  ctx.textBaseline = 'middle';
  for (let v = min; v <= max + 0.5; v += step) {
    const py = Math.round(y(v)) + 0.5;
    const isZero = Math.abs(v) < 0.5;
    ctx.strokeStyle = isZero ? css.getPropertyValue('--border-strong').trim() || grid : grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, py);
    ctx.lineTo(w - padR, py);
    ctx.stroke();
    ctx.fillStyle = muted;
    ctx.textAlign = 'right';
    ctx.fillText(compactMoney(v), padL - 6, py);
  }

  // Today. Everything left of this line happened; everything right of it is
  // the forecast. Without it a chart of recorded days and a chart of projected
  // ones look identical, which is how you end up reading a guess as a fact.
  const todayIdx = series.findIndex((p) => !p.actual);
  if (todayIdx > 0) {
    const tx = Math.round(x(todayIdx)) + 0.5;
    ctx.save();
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = muted;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(tx, padT);
    ctx.lineTo(tx, padT + plotH);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = muted;
    ctx.textAlign = 'left';
    ctx.font = `10px ${bodyFont}`;
    ctx.fillText('today', Math.min(tx + 4, w - padR - 26), padT + 7);
  }

  // Weight separates the two totals from the parts that make one of them up —
  // bills is red like total est costs, so colour alone will not tell them
  // apart.
  const sameSeries = (a, b) => series.every((p) => Math.abs(p[a] - p[b]) < 0.005);
  // Where a total and the part that makes it up are the same number — a window
  // with no bills at all, say — drawing both puts one line exactly on the other
  // and the overlap reads as a third colour that is not in the legend. The
  // bold one is skipped, since the thin one is on top of it anyway.
  const costsHidden = sameSeries('costs', 'spend') && sameSeries('costs', 'bills');

  const lines = [
    { key: 'balance', colour: success, width: 2.5 },
    costsHidden ? null : { key: 'costs', colour: danger, width: 2.5 },
    { key: 'spend', colour: accent, width: 1 },
    { key: 'bills', colour: danger, width: 1 }
  ].filter(Boolean);

  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const line of lines) {
    ctx.strokeStyle = line.colour;
    ctx.lineWidth = line.width;
    ctx.beginPath();
    series.forEach((p, i) => {
      const px = x(i);
      const py = y(p[line.key]);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
  }

  // Date labels, thinned to whatever the width allows. A year of daily points
  // is 365 marks and about a dozen labels.
  const targetLabels = Math.max(2, Math.floor(plotW / 62));
  const every = Math.max(1, Math.ceil(series.length / targetLabels));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `10px ${bodyFont}`;
  for (let i = 0; i < series.length; i += every) {
    const label = series[i].label;
    const half = ctx.measureText(label).width / 2;
    const cx = Math.min(Math.max(x(i), padL + half), w - padR - half);
    ctx.fillStyle = muted;
    ctx.fillText(label, cx, h - 9);
  }
}

// Axis figures are estimates of a total, so they can run to five figures. The
// full currency() string stops the chart, not the number.
function compactMoney(value) {
  const n = Number(value) || 0;
  const abs = Math.abs(n);
  if (abs >= 1000) {
    const k = n / 1000;
    return `${Math.abs(k) >= 10 ? Math.round(k) : Math.round(k * 10) / 10}k`;
  }
  return String(Math.round(n));
}

// Who spent what: one bar per person, split between what they spent and what
// they owe. The bar's length is their share of the household total, so the
// bars compare against each other; the split inside each bar is their own
// ratio, which is the part the length can't show.
//
// Entries nobody is marked against are kept as their own row rather than
// dropped: this card rolls up the same spend and bills as the two category
// cards above it, and quietly leaving the unattributed money out would make
// it disagree with them.
function renderPersonBreakdown(spendItems, dueItems) {
  const totals = new Map();
  const bucket = (id) => {
    if (!totals.has(id)) totals.set(id, { spend: 0, due: 0 });
    return totals.get(id);
  };
  spendItems.forEach((i) => { bucket(i.personId || '').spend += i.amount; });
  dueItems.forEach((i) => { bucket(i.personId || '').due += i.amount; });

  const rows = [...totals.entries()]
    .map(([id, t]) => ({ id, ...t, total: t.spend + t.due }))
    .filter((t) => t.total > 0)
    .sort((a, b) => b.total - a.total);

  if (rows.length === 0) {
    return '<div style="color: var(--text-secondary); padding: 20px 0;">No data yet</div>';
  }

  const grandTotal = rows.reduce((sum, r) => sum + r.total, 0);
  const nameOf = (id) => { const p = personById(id); return p ? p.name : 'Anyone'; };

  return `
    <div class="split-legend">
      <span class="split-key"><i class="split-swatch tone-accent"></i>Spend</span>
      <span class="split-key"><i class="split-swatch tone-danger"></i>Bills</span>
    </div>
    ${rows.map((r) => {
      const label = nameOf(r.id);
      const width = grandTotal > 0 ? (r.total / grandTotal) * 100 : 0;
      // Proportional inside the bar. A tiny slice still needs a sliver or a
      // month of only bills reads as a month of nothing.
      const spendShare = r.total > 0 ? (r.spend / r.total) * 100 : 0;
      const spendPct = r.spend > 0 ? Math.max(spendShare, 1) : 0;
      const duePct = r.due > 0 ? Math.max(100 - spendShare, 1) : 0;
      return `
        <div class="category-row" title="${escapeHTML(label)} — spend ${currency(r.spend)} (${Math.round(spendShare)}%), bills ${currency(r.due)} (${Math.round(100 - spendShare)}%)">
          <span class="category-name" title="${escapeHTML(label)}">${escapeHTML(label)}</span>
          <div class="category-bar">
            <div class="split-bar" style="width: ${width}%">
              <div class="split-seg tone-accent" style="width: ${spendPct}%"></div>
              <div class="split-seg tone-danger" style="width: ${duePct}%"></div>
            </div>
          </div>
          <span class="category-amount">${currency(r.total)}</span>
        </div>
      `;
    }).join('')}
  `;
}

// Settings Page
function renderSettings(container) {
  container.innerHTML = `
    <div class="reports-grid">
      <div class="report-card">
        <div class="setting-row setting-row--inline setting-row--tight">
          <div class="setting-text">
            <div class="setting-label setting-label--title">Appearance</div>
          </div>
          <div class="setting-control">
            ${themeSegment()}
          </div>
        </div>
      </div>

      <div class="report-card">
        ${peopleSettingsHtml()}
      </div>

      <div class="report-card">
        ${passcodeSettings()}
      </div>

      <div class="report-card">
        ${notifySettingsHtml()}
      </div>

      <div class="report-card">
        <div class="setting-row setting-row--inline setting-row--tight">
          <div class="setting-text">
            <div class="setting-label setting-label--title">Currency</div>
          </div>
          <div class="setting-control setting-control--split">
            <span class="currency-code">${escapeHTML(getCurrencyCode())}</span>
            <select class="form-input form-input--mini" id="currency-select"
                    aria-label="Currency"
                    onchange="setCurrencyCode(this.value); renderPage();">
              ${CURRENCIES.map(([code, name]) =>
                `<option value="${code}"${code === getCurrencyCode() ? 'selected' : ''}>${escapeHTML(name)}</option>`).join('')}
            </select>
          </div>
        </div>
      </div>

      <div class="report-card">
        ${syncSettingsHtml()}
      </div>

      <div class="report-card">
        <h2 class="report-title">Data Management</h2>
        <p style="color: var(--text-secondary); margin-bottom: 15px;">Export or import your financial data</p>
        <button class="btn btn-primary" onclick="handleExport()" style="width: 100%; margin-bottom: 10px;">Export Data</button>
        <button class="btn btn-ghost" onclick="handleImport()" style="width: 100%;">Import Data</button>
      </div>

      <div class="report-card">
        <p style="color: var(--text-secondary);">
          <strong>Sorted <span class="app-version">v${APP_VERSION}</span></strong><br>
          All data stored locally · no cloud, no login ·
          <a href="https://github.com/jaquesbody/sorted/releases" target="_blank" rel="noopener"
             style="color: var(--accent);">Releases on GitHub</a>
        </p>
        <div class="setting-row setting-row--inline setting-row--tight">
          <div class="setting-text">
            <div class="setting-label">Updates</div>
          </div>
          <div class="setting-control">
            <button class="btn btn-ghost" onclick="checkForUpdate(this)">Check</button>
          </div>
        </div>
        <div class="setting-hint" id="update-note"></div>
      </div>

      <div class="report-card report-card--danger">
        <h2 class="report-title">Danger zone</h2>
        <p style="color: var(--text-secondary); margin-bottom: 15px;">
          Delete everything and start from empty. There's no undo and no backup
          of its own — export first if you might want any of it.
        </p>
        <button class="btn btn-danger" onclick="confirmRemoveAllData(this)" style="width: 100%;">Delete all data</button>
      </div>
    </div>
  `;
}

// Two taps, like every other destructive control here, and the first one says
// how much would go — a number is a far better speed bump than "are you sure".
// A third step (type-to-confirm) felt like too much ceremony for something
// reached from a settings page, but silently wiping someone's whole history on
// a mis-tap is not a trade worth making.
async function confirmRemoveAllData(btn) {
  if (btn.dataset.confirming !== '1') {
    const counts = await getAllData();
    const total = Object.values(counts).reduce((a, b) => a + b.length, 0);
    if (total === 0) {
      showToast('Nothing to delete');
      return;
    }
    btn.dataset.confirming = '1';
    btn.textContent = `Delete ${total} items? Tap again`;
    setTimeout(() => {
      btn.dataset.confirming = '';
      btn.textContent = 'Delete all data';
    }, 6000);
    return;
  }

  const result = await clearAllData();
  // The PINs live in localStorage, not the database, and the people they
  // belonged to are gone — leaving them would lock the app against nobody.
  clearAllPersonPins();
  // Nothing is put back. There is no seed to re-arm: empty is what empty means,
  // so "delete all data" and a first launch both land in the same place.
  closeModal();
  navigate('dashboard');
  showToast(`${result.total} items deleted`);
  await renderPage();
  // Nothing to remind anyone about any more, and nothing saved, so the goal
  // top-up dates go too — they describe data that no longer exists.
  localStorage.removeItem(NOTIFY_GOAL_LAST_KEY);
  await refreshReminders();
}

// Bill reminders, and the honest limits of them. There is no backend, so
// nothing can fire at a set time in the background: the app checks when you put
// it away and when you pick it up. Said here rather than left for the user to
// discover, because "it didn't remind me" otherwise reads as a broken feature.
// One row per reminder, each a single line: title left, control right. The
// picker only appears while its row is on, so a row that's off is a row with
// nothing to decide, and the card is three lines tall instead of six.
function notifySettingsHtml() {
  if (!notifySupported()) {
    return '<p class="setting-hint">This browser has no notifications.</p>';
  }
  // Deliberately no "permission denied" early return here. There was one, and it
  // replaced the whole card with a paragraph — so the moment asking for
  // permission came back denied, the three switches vanished rather than
  // flipping. Re-entering the app rebuilt them from localStorage and they
  // appeared to work, which is a maddening thing to be handed. A control must
  // not vanish because a permission is off; the state is said in the line
  // underneath instead, and the switches stay where they are.

  const bills = isNotifyEnabled();
  const spend = isSpendNudgeEnabled();
  const goals = isGoalNudgeEnabled();

  // A nudge needs the same permission as bills, so while it's still unasked the
  // pickers stay hidden rather than offering a time that can't be honoured.
  const needsPermission = !notifyIsNative() && Notification.permission !== 'granted';

  const sw = (on, label, action) => `
    <button class="switch" role="switch" aria-checked="${on}" aria-label="${label}"
            onclick="${action}"></button>`;
  // The picker is always rendered, and only greyed out while its row is off.
  //
  // It used to appear and disappear with the switch, which meant the switch
  // itself moved: a row was [label][picker][switch] while on and [label][switch]
  // while off, so turning Bills off slid the switch left out from under a finger
  // still resting on it. Three rows whose controls all shift is a strong
  // candidate for "the toggles are crossed" — and it is why the control had to
  // go somewhere even with the row off. A disabled dropdown keeps the layout
  // fixed, and shows the setting you'd get if you switched the row on.
  const picker = (id, options, handler, aria, enabled) => `
    <select class="form-input form-input--mini" id="${id}" aria-label="${aria}"
            ${enabled ? '' : 'disabled'} onchange="${handler}">${options}</select>`;

  const leadOptions = NOTIFY_LEADS.map((l) =>
    `<option value="${l.value}"${l.value === getNotifyLeadDays() ? 'selected' : ''}>${l.label}</option>`).join('');
  const timeOptions = NOTIFY_TIMES.map((t) =>
    `<option value="${t.value}"${t.value === getNotifyTime() ? 'selected' : ''}>${t.label}</option>`).join('');
  const cadenceOptions = NOTIFY_GOAL_CADENCES.map((c) =>
    `<option value="${c.value}"${c.value === goalNudgeCadence().value ? 'selected' : ''}>${c.label}</option>`).join('');

  return `
    <div class="setting-row setting-row--inline setting-row--tight">
      <div class="setting-text">
        <div class="setting-label">Bills due</div>
      </div>
      <div class="setting-control">
        ${picker('notify-lead', leadOptions, 'changeNotifyLead(Number(this.value))', 'Remind me', bills && !needsPermission)}
        ${sw(bills, 'Remind me about bills due', 'toggleBillsReminders(this)')}
      </div>
    </div>

    <div class="setting-row setting-row--inline setting-row--tight">
      <div class="setting-text">
        <div class="setting-label">Record spending</div>
      </div>
      <div class="setting-control">
        ${picker('notify-spend-time', timeOptions, 'changeNotifyTime(this.value)', 'Remind me at', spend && !needsPermission)}
        ${sw(spend, 'Remind me to record spending', "toggleNudge('spend', this)")}
      </div>
    </div>

    <div class="setting-row setting-row--inline setting-row--tight">
      <div class="setting-text">
        <div class="setting-label">Savings goals</div>
      </div>
      <div class="setting-control">
        ${picker('notify-goal-cadence', cadenceOptions, 'changeGoalCadence(this.value)',
                 'Remind me every', goals && !needsPermission)}
        ${sw(goals, 'Remind me when a goal goes untouched', "toggleNudge('goal', this)")}
      </div>
    </div>

    <div class="setting-row setting-row--inline setting-row--tight">
      <div class="setting-text">
        <div class="setting-label">Check it works</div>
        <div class="setting-hint">${notifyTestHint()}</div>
      </div>
      <div class="setting-control">
        <button class="btn btn-ghost" onclick="showTestNotification(this)">Show one now</button>
      </div>
    </div>
    <div class="setting-row setting-row--inline setting-row--tight">
      <div class="setting-text">
        <div class="setting-label">Check an alarm</div>
        <div class="setting-hint">${notifyAlarmHint()}</div>
      </div>
      <div class="setting-control">
        <button class="btn btn-ghost" onclick="testReminderNow(this)">Arm one</button>
      </div>
    </div>
    ${notifyPendingHtml()}
  `;
}

// What the phone says it has pending, rather than what Sorted believes it
// asked for. The two can disagree — a permission withdrawn, an alarm dropped by
// the system's battery rules — and a switch showing "on" is not evidence that
// anything will actually arrive.
function notifyPendingHtml() {
  if (!notifyIsNative()) {
    return `<div class="setting-hint" style="padding: 10px 0 0;">
      Here they are checked when you open the app; a browser cannot wake it at a set hour.</div>`;
  }
  const pending = notifyPendingCache || [];
  if (!pending.length) {
    return `<div class="setting-hint" style="padding: 10px 0 0;">
      Nothing scheduled. ${escapeHTML(inexactAlarmNote())}</div>`;
  }
  const when = (at) => (at ? at.toLocaleString('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
  }) : 'no time set');
  const rows = pending.slice()
    .sort((a, b) => (a.at ? a.at.getTime() : 0) - (b.at ? b.at.getTime() : 0))
    .map((n) => `<div class="pending-row">
        <span class="pending-title">${escapeHTML(n.title)}</span>
        <span class="pending-when">${escapeHTML(when(n.at))}</span>
      </div>`).join('');
  return `<div class="pending-list">${rows}</div>
    <div class="setting-hint" style="padding-top: 10px;">${escapeHTML(inexactAlarmNote())}</div>`;
}

// Short on purpose. This sits in a two-column row beside a button, and a hint
// long enough to fill its column pushes the control onto a line of its own —
// which is the whole "each row on one line" rule the rest of this card keeps.
function notifyTestHint() {
  if (!notifyIsNative()) return 'Needs the phone build';
  if (!notifyPermissionCache || notifyPermissionCache.state !== 'granted') {
    return 'Turn a reminder on first';
  }
  return 'Straight away — proves Sorted can post at all';
}

function notifyAlarmHint() {
  if (!notifyIsNative()) return 'Needs the phone build';
  if (!notifyPermissionCache || notifyPermissionCache.state !== 'granted') {
    return 'Turn a reminder on first';
  }
  // Short on purpose. This sits in a two-column row, and a hint long enough to
  // fill its column pushes the control onto a line of its own.
  return 'Five minutes, inexact — see below';
}

async function showTestNotification(btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Sending\u2026'; }
  let message;
  try {
    const res = await showTestNotificationNow();
    message = res.ok
      ? 'Look at your notification shade'
      : res.error;
  } catch (err) {
    message = String((err && err.message) || err);
  }
  await renderPage();
  if (message) showToast(message, 6000);
}

async function testReminderNow(btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  let message;
  try {
    const res = await sendTestReminder();
    message = res.ok ? 'Armed for about five minutes — inexact, so not exactly then' : res.error;
  } catch (err) {
    message = String((err && err.message) || err);
  }
  await loadPendingReminders();
  await renderPage();
  if (message) showToast(message, 6000);
}

// `toggleBillsReminders` and `changeNotifyTime` used to be defined here as well
// as in notify.js. app.js loads last, so its declarations silently replaced the
// ones in notify.js — including the fix for the switch that would not repaint,
// because this copy repainted *after* two bridge calls instead of before them.
// Bills reminders therefore looked stuck on; toggling a different row forced a
// repaint that finally showed the truth, which is exactly how it was reported.
//
// Only one definition of a name may exist across these files. There is a test
// for that, because nothing else in the build catches it.

async function changeNotifyLead(days) {
  setNotifyLeadDays(days);
  await scheduleAllReminders();
}

async function changeGoalCadence(value) {
  setGoalNudgeCadence(value);
  await scheduleAllReminders();
}

// Turning everything off. Called from "Delete all data" as well, because a
// wiped database with three alarms pending would start reminding someone about
// bills they no longer have.
async function refreshReminders() {
  try {
    await scheduleAllReminders();
  } catch (err) {
    console.error('Could not reschedule reminders:', err);
  }
}

// Two marks rather than two words. "Set PIN" and "Remove" are wide enough that
// they wrap onto a second line on a phone, leaving a card of mostly empty space
// with the person's name stranded on its own. A keypad grid and a bin say the
// same thing in a square, so the row stays one line.
const KEYPAD_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none"
  stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <rect x="3.5" y="2.5" width="17" height="19" rx="2.5"></rect>
  <path d="M7.5 6.5h.01M12 6.5h.01M16.5 6.5h.01M7.5 10.5h.01M12 10.5h.01M16.5 10.5h.01M7.5 14.5h.01M12 14.5h.01M16.5 14.5h.01M8 18.5h8"></path>
</svg>`;

const BIN_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none"
  stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M4 6.5h16M9.5 6.5V4.8A1.3 1.3 0 0 1 10.8 3.5h2.4a1.3 1.3 0 0 1 1.3 1.3v1.7"></path>
  <path d="M6.5 6.5 7.4 19a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4l.9-12.5"></path>
  <path d="M10.5 10v6.5M13.5 10v6.5"></path>
</svg>`;

function peopleSettingsHtml() {
  const people = [...peopleCache.values()];
  const current = getCurrentPersonId();
  const rows = people.map((p) => `
    <div class="setting-row setting-row--inline setting-row--tight">
      <div class="setting-text">
        <div class="setting-label person-setting-label">${personDot(p, 20, true)} ${escapeHTML(p.name)}${current === p.id ? ' — using now' : ''}</div>
      </div>
      <div class="setting-control">
        <button class="btn btn-icon-sq" aria-label="${hasPersonPin(p.id) ? 'Change' : 'Set'} ${escapeHTML(p.name)}'s PIN"
                title="${hasPersonPin(p.id) ? 'Change PIN' : 'Set PIN'}"
                onclick="openPersonPinModal('${p.id}')">${KEYPAD_SVG}</button>
        <button class="btn btn-icon-sq" aria-label="Remove ${escapeHTML(p.name)}"
                title="Remove" onclick="removePersonFromSettings('${p.id}', this)">${BIN_SVG}</button>
      </div>
    </div>`).join('');

  return `
    ${rows}
    <div class="setting-row setting-row--add setting-row--inline setting-row--tight">
      <div class="setting-text">
        <div class="setting-label setting-label--title">Add someone</div>
      </div>
      <div class="setting-control">
        <input type="text" class="form-input" id="new-person-name" placeholder="Name" maxlength="40" style="width: 118px;">
        <button class="btn btn-primary" onclick="addPersonFromSettings()">Add</button>
      </div>
    </div>
    ${people.length === 0 ? '<p class="setting-hint" style="margin-top: 12px;">Until you add anyone, entries are marked as Anyone\'s.</p>' : ''}
  `;
}

// A person's PIN: the app passcode still opens the app, and this switches it to
// them. Stated in the modal because a PIN that silently does nothing when
// there's no app passcode would be the easiest thing in this feature to get
// wrong.
function openPersonPinModal(personId) {
  const person = personById(personId);
  if (!person) return;
  const required = getRequiredPinLength();
  const existing = hasPersonPin(personId);

  openModal(`${existing ? 'Change' : 'Set'} ${escapeHTML(person.name)}'s PIN`, `
    <p class="form-label">${required} digits. Entering it instead of the app passcode switches Sorted to ${escapeHTML(person.name)}.</p>
    <div class="form-group">
      <label class="form-label" for="person-pin-new">New PIN</label>
      <input type="password" inputmode="numeric" pattern="[0-9]*" maxlength="${required}" class="form-input"
             id="person-pin-new" autocomplete="new-password" placeholder="••••">
    </div>
    <div class="form-group">
      <label class="form-label" for="person-pin-confirm">Confirm PIN</label>
      <input type="password" inputmode="numeric" pattern="[0-9]*" maxlength="${required}" class="form-input"
             id="person-pin-confirm" autocomplete="new-password" placeholder="••••">
    </div>
    <button class="btn btn-primary" style="width: 100%; margin-top: 10px;" onclick="savePersonPin('${personId}')">Save PIN</button>
    ${existing ? `<button class="btn btn-ghost" style="width: 100%; margin-top: 8px;" onclick="confirmRemovePersonPin('${personId}', this)">Remove PIN</button>` : ''}
  `);
}

async function savePersonPin(personId) {
  const first = normalisePasscode(document.getElementById('person-pin-new').value);
  const second = normalisePasscode(document.getElementById('person-pin-confirm').value);
  const person = personById(personId);
  if (!person) return;

  if (first.length !== getRequiredPinLength()) {
    return showFormError(`Use ${getRequiredPinLength()} digits`, 'person-pin-new');
  }
  if (first !== second) return showFormError('Those two don’t match', 'person-pin-confirm');

  const problem = await setPersonPin(personId, first);
  if (problem === 'taken') {
    const taker = await isPersonPinTaken(first, personId);
    return showFormError(
      taker === PIN_TAKEN_BY_APP ? 'That’s the app passcode' : `That’s ${personById(taker)?.name || 'someone else'}’s PIN`,
      'person-pin-new');
  }
  if (problem) return showFormError('That PIN could not be saved', 'person-pin-new');

  closeModal();
  showToast(`${person.name}'s PIN set`);
  await renderPage();
}

// Two-step, like every other destructive control here. No PIN required: anyone
// who can reach Settings can reset anyone's PIN, which is the honest ceiling on
// what a PIN is.
function confirmRemovePersonPin(personId, btn) {
  const person = personById(personId);
  if (!person) return;
  if (btn.dataset.confirming !== '1') {
    btn.dataset.confirming = '1';
    btn.textContent = 'Tap again to remove';
    setTimeout(() => {
      btn.dataset.confirming = '';
      btn.textContent = 'Remove PIN';
    }, 5000);
    return;
  }
  clearPersonPin(personId);
  closeModal();
  showToast(`${person.name}'s PIN removed`);
  renderPage();
}

async function addPersonFromSettings() {
  const input = document.getElementById('new-person-name');
  const name = input.value.trim();
  if (!name) return showFormError('Please enter a name', 'new-person-name');
  const added = await addPerson(name);
  if (!added) {
    input.value = '';
    return showFormError('Someone with that name already exists', 'new-person-name');
  }
  input.value = '';
  showToast(`${name} added`);
  await renderPage();
}

// Two-step confirm, like every other destructive action in the app (no native
// dialogs). The first tap rewrites itself to say what will happen.
async function removePersonFromSettings(id, btn) {
  const person = personById(id);
  if (!person) return;
  if (btn.dataset.confirming !== '1') {
    btn.dataset.confirming = '1';
    btn.textContent = 'Their entries stay — remove?';
    setTimeout(() => {
      btn.dataset.confirming = '';
      btn.textContent = 'Remove';
    }, 5000);
    return;
  }
  await removePerson(id);
  showToast(`${person.name} removed`);
  await renderPage();
}

const SUN_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none"
  stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
  <circle cx="12" cy="12" r="4.2"></circle>
  <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6"></path>
</svg>`;

const MOON_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none"
  stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M20 14.2A8.4 8.4 0 0 1 9.8 4 8.5 8.5 0 1 0 20 14.2Z"></path>
</svg>`;

const SCREEN_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none"
  stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <rect x="2.8" y="4" width="18.4" height="12.5" rx="2"></rect>
  <path d="M8.5 20h7M12 16.5V20"></path>
</svg>`;

// Icons rather than the words, with the words kept for anyone who cannot see
// them. The control is a labelled group, not a row of unlabelled buttons.
function themeSegment() {
  const pref = getThemePreference();
  const opt = (value, label, icon) =>
    `<button class="segmented-option segmented-option--icon" role="radio" aria-checked="${pref === value}"
             aria-label="${label}" title="${label}" onclick="setThemePreference('${value}')">${icon}</button>`;
  return `<div class="segmented segmented--icons" role="radiogroup" aria-label="Theme">
    ${opt('light', 'Light', SUN_SVG)}${opt('dark', 'Dark', MOON_SVG)}${opt('system', 'System', SCREEN_SVG)}
  </div>`;
}

function passcodeSettings() {
  // "Lock after" and "Lock now" belong to the app lock, not to the app
  // passcode specifically — with someone's PIN set the app locks either way,
  // and hiding these would leave the idle timeout unreachable while the app is
  // in fact locking.
  const lockBlock = isLockEnabled() ? `
    <div class="setting-block">
      <div class="setting-row setting-row--left">
        <div class="setting-text">
          <div class="setting-label">Lock after</div>
        </div>
        <div class="setting-control">
          <select class="form-input" id="lock-timeout" style="width: auto;" onchange="setLockTimeoutMinutes(Number(this.value))">
            ${LOCK_TIMEOUTS.map(t => `<option value="${t.value}" ${t.value === getLockTimeoutMinutes() ? 'selected' : ''}>${t.label}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="setting-row setting-row--left">
        <div class="setting-text">
          <div class="setting-label">Lock now</div>
        </div>
        <div class="setting-control">
          <button class="btn btn-ghost" onclick="lockApp()">Lock</button>
        </div>
      </div>
    </div>
  ` : '';

  // The switch sits beside the card's own heading. Repeating it as a second
  // labelled row underneath meant the same fact stated twice, and the
  // explanation was long enough to push everything below it down a screen.
  const row = (label, hint) => `
    <div class="setting-row setting-row--inline setting-row--tight">
      <div class="setting-text">
        <div class="setting-label setting-label--title">Passcode</div>
        ${hint ? `<div class="setting-hint">${hint}</div>` : ''}
      </div>
      <div class="setting-control">
        ${isPasscodeSet()
          ? `<button class="switch" role="switch" aria-checked="true" aria-label="Remove passcode"
                   onclick="confirmRemovePasscode(this)"></button>`
          : `<button class="switch" role="switch" aria-checked="false" aria-label="Set a passcode"
                   onclick="openPasscodeSetup()"></button>`}
      </div>
    </div>`;

  return row() + lockBlock;
}

// Passcode setup is a modal rather than a field on the page: the toggle is the
// only entry point, and a form that appears under a switch you just tapped
// reads as a glitch.
function openPasscodeSetup() {
  openModal('Set a passcode', `
    <p class="form-label">4 to 8 digits. You'll need it every time the app locks.</p>
    <div class="form-group">
      <label class="form-label" for="passcode-new">New passcode</label>
      <input type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" class="form-input"
             id="passcode-new" autocomplete="new-password" placeholder="••••">
    </div>
    <div class="form-group">
      <label class="form-label" for="passcode-confirm">Confirm passcode</label>
      <input type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" class="form-input"
             id="passcode-confirm" autocomplete="new-password" placeholder="••••">
    </div>
    <div class="form-group">
      <label class="form-label" for="passcode-timeout">Lock after</label>
      <select class="form-input" id="passcode-timeout">
        ${LOCK_TIMEOUTS.map(t => `<option value="${t.value}" ${t.value === getLockTimeoutMinutes() ? 'selected' : ''}>${t.label}</option>`).join('')}
      </select>
    </div>
    <button class="btn btn-primary" style="width: 100%; margin-top: 10px;" onclick="savePasscodeSetup()">Save passcode</button>
  `);
}

async function savePasscodeSetup() {
  const first = normalisePasscode(document.getElementById('passcode-new').value);
  const second = normalisePasscode(document.getElementById('passcode-confirm').value);

  if (first.length < 4) return showFormError('Use at least 4 digits', 'passcode-new');
  if (first !== second) return showFormError('Those two don’t match', 'passcode-confirm');

  // Every PIN shares one length, because the lock screen's keypad submits on
  // its own and has to know the length up front. Changing it now would strand
  // every PIN already set, so it has to be refused rather than silently
  // breaking them — remove the PINs first, then set the new length.
  if (anyPersonPins() && isPasscodeSet() && first.length !== getPasscodeLength()) {
    return showFormError(
      `People's PINs are ${getPasscodeLength()} digits. Remove them first to change that.`, 'passcode-new');
  }

  await setPasscode(first);
  setLockTimeoutMinutes(Number(document.getElementById('passcode-timeout').value));
  closeModal();
  showToast('Passcode on — Sorted will ask for it next time');
  renderPage();
}

// Turning the passcode off needs a deliberate second tap, same as Delete in
// the item form: one mis-tap shouldn't drop someone's lock screen.
function confirmRemovePasscode(switchEl) {
  if (switchEl.dataset.confirming !== '1') {
    switchEl.dataset.confirming = '1';
    switchEl.setAttribute('aria-label', 'Tap again to remove the passcode');
    switchEl.title = 'Tap again to remove';
    const row = switchEl.closest('.setting-text');
    if (row) {
      const hint = row.querySelector('.setting-hint');
      if (hint) hint.textContent = 'Tap again to remove';
    }
    setTimeout(() => {
      switchEl.dataset.confirming = '';
      switchEl.setAttribute('aria-label', 'Remove passcode');
      switchEl.removeAttribute('title');
      renderPage();
    }, 4000);
    return;
  }
  clearPasscode();
  // Removing the app passcode does not unlock the app if people still have
  // PINs, and the toast above would otherwise imply that it did.
  showToast(anyPersonPins() ? 'Passcode removed — people’s PINs still lock it' : 'Passcode removed');
  renderPage();
}

// Modal Forms
/* How often a recurring item repeats
   --------------------------------------------------------------------------
   Stored as `frequency` on the item: 'monthly' or 'annually', or absent for a
   one-off. The older boolean `recurring` is still read and written, because
   every store on a device already holds rows that predate this and nothing
   should be rewritten to suit it — `recurring: true` with no frequency means
   monthly, which is exactly how those items behaved before.

   What the frequency buys is the future. A bill is only ever stored with the
   date it's *currently* due, so stepping forward through the months used to
   show nothing at all after the current one. A recurring item now projects its
   own next occurrences into the months on screen, up to a year ahead.
   ------------------------------------------------------------------------ */

const RECURRING_HORIZON_MONTHS = 12;

const FREQUENCY_CHOICES = [
  { value: 'no', label: 'No' },
  { value: 'monthly', label: 'Yes, monthly' },
  { value: 'annually', label: 'Yes, annually' }
];

// Monthly is the fallback for anything that was already flagged recurring.
function frequencyOf(item) {
  if (item.frequency === 'monthly' || item.frequency === 'annually') return item.frequency;
  return item.recurring === true ? 'monthly' : null;
}

function isRecurring(item) {
  return frequencyOf(item) !== null;
}

// The ISO date this item would land on in the month on screen, or null if it
// doesn't land there. Day-of-month is preserved and clamped to the target
// month's length, so the 31st still means "the 31st" except where there isn't
// one, exactly as the stored roll-forward already does.
function occurrenceInMonth(startDate, frequency, viewDate) {
  if (!startDate || !frequency) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startDate);
  if (!m) return null;
  const startYear = Number(m[1]);
  const startMonth = Number(m[2]);
  const startDay = Number(m[3]);

  const gap = (viewDate.getFullYear() - startYear) * 12 + (viewDate.getMonth() + 1 - startMonth);
  if (gap < 0) return null;                                   // the month is behind the item
  if (gap === 0) return startDate;                            // the item's own month
  if (frequency === 'annually' && gap % 12 !== 0) return null;
  if (gap > RECURRING_HORIZON_MONTHS) return null;            // nothing projected a year out

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth() + 1;
  const lastDay = new Date(year, month, 0).getDate();
  return localISO(new Date(year, month - 1, Math.min(startDay, lastDay)));
}

// The projected rows for a month: one per recurring item that lands here and
// isn't already stored here. The "isn't already stored" part is what stops a
// bill showing twice — paying a recurring bill rolls its stored date forward
// into the very month we're projecting, so without that check the paid bill
// and its own projection would both appear.
function projectionsForMonth(items, viewDate, dateKey) {
  const rows = [];
  for (const item of items) {
    // A settled bill has no future occurrences. Paying one leaves a fresh row
    // for the next date, and that row is what projects from then on — so
    // projecting the settled bill as well put the same occurrence in the month
    // twice, once real and once as a forecast.
    if (item.paid === true) continue;
    const frequency = frequencyOf(item);
    if (!frequency) continue;
    const stored = item[dateKey];
    const occurrence = occurrenceInMonth(stored, frequency, viewDate);
    if (!occurrence || occurrence === stored) continue;
    rows.push({
      ...item,
      [dateKey]: occurrence,
      id: null,
      projected: true
    });
  }
  return rows;
}

/* Income
   --------------------------------------------------------------------------
   The only thing that arrives rather than leaves. It exists so the forecast has
   a real "in" side — until this, the cashflow chart's income column was
   transfers between your own accounts, which is the same money counted twice.

   Salary, sale and other are categories rather than different types of entry:
   the form and the forecast treat all three identically, and the category is
   there so "how much of this was a one-off sale" is answerable later without
   another field.
   -------------------------------------------------------------------------- */

const INCOME_CATEGORIES = [
  ['salary', 'Salary'],
  ['sale', 'Sale'],
  ['other', 'Other']
];

function incomeCategoryLabel(value) {
  const found = INCOME_CATEGORIES.find(([v]) => v === value);
  return found ? found[1] : 'Other';
}

async function addIncome(entry) {
  return addItem('income', entry);
}

async function removeIncome(id) {
  await deleteItem('income', id);
}

// The repeat toggle offers the opposite of what its label currently says, so
// tapping it changes the label. Three things made that read as broken rather
// than as a confirmation: the button grew from 89px to 142px and slid sideways
// under the thumb; a full re-render four seconds later replaced every row on
// the page; and the "you have tapped this once" flag lived on the button
// element, so anything else that re-rendered silently threw the offer away.
// The state is here instead, the button reserves the width of its longest
// label, and the timer only touches this one button.
let incomeRepeatPending = null;
let incomeRepeatTimer = null;

function incomeRepeatLabel(item) {
  const recurring = !!item.frequency;
  if (incomeRepeatPending === item.id) return recurring ? 'Stop repeating' : 'Repeat monthly';
  return recurring ? 'Monthly' : 'One-off';
}

async function toggleIncomeRecurring(id, btn) {
  const item = await getItem('income', id);
  if (!item) return;
  clearTimeout(incomeRepeatTimer);
  if (incomeRepeatPending === id) {
    incomeRepeatPending = null;
    await updateItem('income', { ...item, frequency: item.frequency ? null : 'monthly' });
    renderPage();
    return;
  }
  incomeRepeatPending = id;
  btn.textContent = incomeRepeatLabel(item);
  incomeRepeatTimer = setTimeout(() => {
    if (incomeRepeatPending !== id) return;
    incomeRepeatPending = null;
    const row = btn.closest('.item-row');
    const again = row && row.querySelector('.btn-frequency');
    // Only if it's still on screen: the row may have been re-rendered or the
    // page changed, and writing to a detached node achieves nothing.
    if (again && document.body.contains(again)) again.textContent = incomeRepeatLabel(item);
  }, 4000);
}

// The categories offered, in the order they're meant to be scanned. Bills get
// the same list as spend: a bill is spending that hasn't happened yet, and two
// lists meant the same word could break down differently in Reports.
const CATEGORIES = ['Utilities', 'Motor', 'Entertainment', 'Shopping', 'General', 'Travel', 'One-Off'];

// Savings goals are a separate list: they're savings for a purpose, not a
// purchase, so "Utilities" or "Motor" never fit one. Reports breaks savings
// down by goal rather than by category, so these are labels, not buckets.
const SAVINGS_CATEGORIES = ['Holiday', 'Car', 'Christmas', 'One-Off', 'Other'];

// Anything an existing entry is already filed under stays offered, even once it
// is off the list. Without this, editing an entry categorised "Food" or
// "Mortgage" would show the select falling back to its first option, and
// pressing Save would quietly rewrite the category — the dropdown would change
// real data just because the list changed.
function categoryOptionsHtml(extra, list = CATEGORIES) {
  const current = extra && String(extra);
  const options = current && !list.includes(current) ? [current, ...list] : list;
  return options.map((c) => `<option value="${escapeHTML(c)}">${escapeHTML(c)}</option>`).join('');
}

function buildForm(type, editId = null, existingCategory = null) {
  // Ids are UUID strings now, so they're interpolated as JSON rather than
  // dropped into the handler bare — a bare UUID would be a syntax error, and
  // Number() on one is NaN. JSON.stringify also quotes the older numeric ids
  // that predate the change.
  //
  // That JSON has to be HTML-escaped as well: the handler lives in a
  // double-quoted attribute, so the JSON's own double quotes would close the
  // attribute early and the button would carry a truncated, invalid handler.
  // escapeHTML turns them into &quot;, which the parser turns back into "
  // before the JS is compiled — so the value survives and the code stays valid.
  const idArg = editId == null ? '' : escapeHTML(JSON.stringify(editId));
  const saveCall = editId == null
    ? `saveItem('${type}')`
    : `saveItem('${type}', ${idArg})`;
  // The receipt panel is a live region app.js fills in — it needs to exist in
  // both add and edit mode, since a stored receipt can be viewed, replaced or
  // removed after the entry is saved.
  const receiptHtml = (type === 'spend' || type === 'due') ? `
      <div class="receipt-panel" id="receipt-panel"></div>` : '';
  // Who this entry belongs to. Pre-filled with whoever is currently using the
  // app, so the common case is no taps at all and the odd case (adding a
  // bill in someone else's name) is one dropdown away.
  const peopleOptions = [...peopleCache.values()];
  const personHtml = `
      <div class="form-group">
        <label class="form-label" for="form-person">${type === 'savings' ? 'Whose goal' : 'Whose'}</label>
        <select class="form-input" id="form-person">
          <option value="">Anyone</option>
          ${peopleOptions.map((p) => `<option value="${p.id}">${escapeHTML(p.name)}</option>`).join('')}
        </select>
      </div>`;
  // Where the money came out of. Kept apart from "Whose" on purpose: whose it
  // was and where it came from are different questions, and a shared joint
  // account can't be expressed if one field has to answer both.
  const accountHtml = `
      <div class="form-group">
        <label class="form-label" for="form-account">${type === 'savings' ? 'From account' : 'From account'}</label>
        <select class="form-input" id="form-account">
          <option value="">Not from an account</option>
          ${[...accountsCache.values()].map((a) => `<option value="${a.id}">${escapeHTML(a.name)}</option>`).join('')}
        </select>
      </div>`;
  const deleteBtn = editId == null ? '' : `
      <button class="btn btn-danger" style="width: 100%; margin-top: 10px;" onclick="deleteItemFromModal('${type}', ${idArg}, this)">Delete</button>`;
  const forms = {
    spend: `
      ${receiptHtml}
      <div class="form-group">
        <label class="form-label">Title</label>
        <input type="text" class="form-input" id="form-title" placeholder="e.g., Electricity bill">
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Amount (£)</label>
          <input type="number" class="form-input" id="form-amount" step="0.01" min="0">
        </div>
        <div class="form-group">
          <label class="form-label">Date</label>
          <input type="date" class="form-input" id="form-date" value="${localISO()}">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Category</label>
        <select class="form-input" id="form-category">
          ${categoryOptionsHtml(existingCategory)}
        </select>
      </div>
      ${personHtml}
      ${accountHtml}
      <button class="btn btn-primary" style="width: 100%; margin-top: 10px;" onclick="${saveCall}">Save</button>${deleteBtn}
    `,
    due: `
      ${receiptHtml}
      <div class="form-group">
        <label class="form-label">Title</label>
        <input type="text" class="form-input" id="form-title" placeholder="e.g., Mortgage payment">
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Amount (£)</label>
          <input type="number" class="form-input" id="form-amount" step="0.01" min="0">
        </div>
        <div class="form-group">
          <label class="form-label">Due Date</label>
          <input type="date" class="form-input" id="form-dueDate">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Category</label>
          <select class="form-input" id="form-category">
            ${categoryOptionsHtml(existingCategory)}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Repeats</label>
          <select class="form-input" id="form-recurring">
            ${FREQUENCY_CHOICES.map((f) => `<option value="${f.value}">${f.label}</option>`).join('')}
          </select>
        </div>
      </div>
      ${personHtml}
      ${accountHtml}
      <button class="btn btn-primary" style="width: 100%; margin-top: 10px;" onclick="${saveCall}">Save</button>${deleteBtn}
    `,
    savings: `
      <div class="form-group">
        <label class="form-label">Goal Name</label>
        <input type="text" class="form-input" id="form-title" placeholder="e.g., Holiday fund">
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Current (£)</label>
          <input type="number" class="form-input" id="form-current" step="0.01" min="0">
        </div>
        <div class="form-group">
          <label class="form-label">Target (£)</label>
          <input type="number" class="form-input" id="form-target" step="0.01" min="0">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Category</label>
        <select class="form-input" id="form-category">
          ${categoryOptionsHtml(existingCategory, SAVINGS_CATEGORIES)}
        </select>
      </div>
      ${personHtml}
      ${accountHtml}
      <button class="btn btn-primary" style="width: 100%; margin-top: 10px;" onclick="${saveCall}">Save</button>${deleteBtn}
    `
  };
  
  return forms[type];
}

function openAddModal(type) {
  if (type !== 'spend' && type !== 'due') currentReceipt = null;
  receiptRemoved = false;
  ocrStatusText = '';
  openModal(`Add ${type.charAt(0).toUpperCase() + type.slice(1)}`, buildForm(type));
  // Default to whoever is using the app, rather than making the common case
  // a dropdown trip every time.
  const personEl = document.getElementById('form-person');
  if (personEl && getCurrentPersonId() && peopleCache.has(getCurrentPersonId())) {
    personEl.value = getCurrentPersonId();
  }
  if (type === 'spend' || type === 'due') renderReceiptPanel();
}

async function openEditModal(type, id) {
  const item = await getItem(type, id);
  if (!item) return;
  // Seeded before the form is built so the panel renders with the stored
  // receipt already in place rather than flashing empty.
  currentReceipt = item.receipt || null;
  receiptRemoved = false;
  ocrStatusText = '';
  openModal(`Edit ${type.charAt(0).toUpperCase() + type.slice(1)}`, buildForm(type, id, item.category));
  prefillForm(item);
  if (type === 'spend' || type === 'due') renderReceiptPanel();
}

function prefillForm(item) {
  const setVal = (elId, val) => {
    const el = document.getElementById(elId);
    if (el && val !== undefined && val !== null) el.value = val;
  };
  setVal('form-title', item.title);
  setVal('form-amount', item.amount);
  setVal('form-date', item.date);
  setVal('form-dueDate', item.dueDate);
  setVal('form-category', item.category);
  setVal('form-current', item.current);
  setVal('form-target', item.target);
  // Blank is a real answer here: it means "work it out". Null is what an
  // untouched goal stores, and prefill skips nulls, so the field stays empty
  // and the placeholder keeps explaining itself.
  const recurring = document.getElementById('form-recurring');
  // A row that was saved with the old yes/no flag has no frequency, but it
  // still repeats — monthly is what "yes" meant.
  if (recurring) recurring.value = frequencyOf(item) || 'no';
  setVal('form-person', item.personId || '');
  setVal('form-account', item.accountId || '');
}

/* -----------------------------------------------------------------------------
   Receipts
   A receipt used to be read for OCR and then thrown away, so there was nothing
   to go back to. It's now downscaled to a data URL and saved on the item, then
   offered again on the row (paperclip) and in the Edit popup, where it can be
   replaced or removed.
   -------------------------------------------------------------------------- */

// Longest edge kept when storing. A phone photo is 3-5MB as a base64 string;
// this keeps a receipt legible while staying small enough to sit in the export.
const RECEIPT_MAX_EDGE = 1400;

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('could not read that image'));
    img.src = src;
  });
}

async function shrinkImageToDataURL(blob) {
  const original = await blobToDataURL(blob);
  const img = await loadImage(original);
  const scale = Math.min(1, RECEIPT_MAX_EDGE / Math.max(img.width, img.height));
  if (scale >= 1) return original; // already small enough — keep the original

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.82);
}

// PDFs are flattened to a first-page image, which is both what OCR reads and
// what gets stored — one copy instead of a PDF plus a preview, and a PDF can be
// viewed with the same <img> as a photo. The full-size page comes back
// separately for OCR, so a PDF is only ever rendered once.
async function prepareReceipt(file) {
  const isPdf = typeof isPDF === 'function' && isPDF(file);
  const image = isPdf ? await pdfFirstPageToImageBlob(file) : file;
  if (!image) throw new Error('could not render that PDF');
  return {
    receipt: { dataUrl: await shrinkImageToDataURL(image), name: file.name, addedAt: new Date().toISOString() },
    source: image
  };
}

// The receipt being edited lives outside the form so re-rendering the panel
// (after a pick or a remove) doesn't have to thread it through, and so
// opening a savings form can't inherit the last receipt.
let currentReceipt = null;
// Set when the user drops the stored receipt. An edit merges over the stored
// record, so without this the "remove" would be silently undone on save.
let receiptRemoved = false;

function renderReceiptPanel(existing) {
  const panel = document.getElementById('receipt-panel');
  if (!panel) return;
  const receipt = currentReceipt;

  const preview = receipt ? `
    <div class="receipt-card">
      <img class="receipt-thumb" src="${receipt.dataUrl}" alt="Receipt for ${escapeHTML(document.getElementById('form-title')?.value || 'this item')}"
           data-action="view-receipt" title="View full size">
      <div class="receipt-meta">
        <div class="receipt-name" title="${escapeHTML(receipt.name || 'Receipt')}">${escapeHTML(receipt.name || 'Receipt')}</div>
        <div class="setting-hint">Saved with this item</div>
        <div class="receipt-actions">
          <button type="button" class="btn btn-ghost" data-action="view-receipt">View</button>
          <button type="button" class="btn btn-ghost" id="receipt-replace-btn">Replace</button>
          <button type="button" class="btn btn-ghost" id="receipt-remove-btn">Remove</button>
        </div>
      </div>
    </div>` : `
    <div class="receipt-row">
      <button type="button" class="btn btn-ghost" id="receipt-camera-btn">Take photo</button>
      <button type="button" class="btn btn-ghost" id="receipt-upload-btn">Upload file</button>
    </div>`;

  panel.innerHTML = `
    ${preview}
    <p class="ocr-status" id="ocr-status" aria-live="polite">${ocrStatusText || ''}</p>
    <input type="file" id="receipt-camera-input" accept="image/*" capture="environment" hidden>
    <input type="file" id="receipt-upload-input" accept="image/*,application/pdf" hidden>
  `;

  // "Replace" reuses the upload input rather than adding a second pair.
  const cameraBtn = document.getElementById('receipt-camera-btn');
  const uploadBtn = document.getElementById('receipt-upload-btn');
  const replaceBtn = document.getElementById('receipt-replace-btn');
  const removeBtn = document.getElementById('receipt-remove-btn');
  const cameraInput = document.getElementById('receipt-camera-input');
  const uploadInput = document.getElementById('receipt-upload-input');

  if (cameraBtn) cameraBtn.addEventListener('click', () => cameraInput.click());
  if (uploadBtn) uploadBtn.addEventListener('click', () => uploadInput.click());
  if (replaceBtn) replaceBtn.addEventListener('click', () => uploadInput.click());
  if (removeBtn) removeBtn.addEventListener('click', () => {
    currentReceipt = null;
    receiptRemoved = true;
    ocrStatusText = '';
    renderReceiptPanel();
  });

  const handleChange = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (file) await ocrPrefill(file);
  };
  cameraInput.addEventListener('change', handleChange);
  uploadInput.addEventListener('change', handleChange);
}

let ocrStatusText = '';

// The status line lives in a variable rather than the DOM because the panel is
// re-rendered after every pick — OCR's progress messages would otherwise be
// wiped by the thumbnail appearing underneath them.
function setOcrStatus(text) {
  ocrStatusText = text || '';
  const el = document.getElementById('ocr-status');
  if (el) el.textContent = ocrStatusText;
}

async function ocrPrefill(file) {
  const titleEl = document.getElementById('form-title');
  const amountEl = document.getElementById('form-amount');
  // Spend has form-date (pre-filled with today), bills have form-dueDate
  // (starts empty) — whichever the open form owns gets the receipt date.
  const dateEl = document.getElementById('form-date') || document.getElementById('form-dueDate');

  try {
    // Store the image first: even if OCR fails or guesses wrong, the photo is
    // the part the user can't recreate. For a PDF this also does the (slow)
    // render, so OCR reads the page we already have rather than doing it again.
    setOcrStatus(typeof isPDF === 'function' && isPDF(file) ? 'Rendering PDF…' : 'Reading receipt…');
    const prepared = await prepareReceipt(file);
    currentReceipt = prepared.receipt;
    setOcrStatus('Reading receipt…');
    renderReceiptPanel();

    const text = await runOCRWithTimeout(prepared.source, (msg) => setOcrStatus(msg));
    const title = guessTitleFromText(text);
    const amount = guessAmountFromText(text);
    const date = guessDateFromText(text);
    if (titleEl && !titleEl.value && title) titleEl.value = title;
    if (amountEl && !amountEl.value && amount > 0) amountEl.value = amount;
    // The date fields ship with defaults (today / empty), so unlike title and
    // amount this one is always overwritten when the receipt shows a date.
    if (dateEl && date) dateEl.value = date;
    setOcrStatus(date
      ? 'Done — check title, amount and date, then save.'
      : 'Done — check title and amount, then save.');
  } catch (err) {
    console.error('OCR failed:', err);
    setOcrStatus('Could not read that file — enter the details manually.');
  }
}

// Full-size viewer, opened from a row's paperclip or the Edit popup.
function openViewer(receipt) {
  if (!receipt || !receipt.dataUrl) return;
  const viewer = document.getElementById('viewer');
  document.getElementById('viewer-image').src = receipt.dataUrl;
  document.getElementById('viewer-caption').textContent = receipt.name || 'Receipt';
  viewer.hidden = false;
}

function closeViewer() {
  const viewer = document.getElementById('viewer');
  if (!viewer || viewer.hidden) return;
  viewer.hidden = true;
  document.getElementById('viewer-image').src = '';
}

document.getElementById('viewer-close').addEventListener('click', closeViewer);
document.getElementById('viewer').addEventListener('click', (e) => {
  if (e.target.id === 'viewer') closeViewer();
});

// In-modal validation error — replaces native alert(). Error sits at the
// top of the form, announced by role="alert", and the offending field
// gets focus.
function showFormError(message, fieldId) {
  let el = document.getElementById('form-error');
  if (!el) {
    el = document.createElement('p');
    el.id = 'form-error';
    el.className = 'form-error';
    el.setAttribute('role', 'alert');
    modalBody.insertBefore(el, modalBody.firstChild);
  }
  el.textContent = message;
  const field = fieldId && document.getElementById(fieldId);
  if (field) field.focus();
}

async function saveItem(type, editId = null) {
  document.getElementById('form-error')?.remove();
  const title = document.getElementById('form-title').value.trim();
  const amount = parseFloat(document.getElementById('form-amount')?.value || document.getElementById('form-current')?.value || 0);
  const target = parseFloat(document.getElementById('form-target')?.value || 0);
  const category = document.getElementById('form-category').value;
  const personId = document.getElementById('form-person')?.value || null;
  const accountId = document.getElementById('form-account')?.value || null;

  if (!title) {
    showFormError('Please enter a title', 'form-title');
    return;
  }

  const fields = { title, category, personId, accountId };
  // Spend has no Repeats control: what was spent is a one-off by definition,
  // and a bill is where repetition belongs. Rows saved before that are left
  // exactly as they are — the field is only written when the form actually
  // offers the choice, so editing one can't quietly strip its frequency.
  const repeatField = document.getElementById('form-recurring');
  if (type !== 'savings' && repeatField) {
    const repeatChoice = repeatField.value;
    // `recurring` is kept alongside the frequency so everything that already
    // reads the boolean (the pay-a-bill roll-forward, the recurring filters,
    // the Reports breakdowns) keeps working without a second pass over stored
    // data.
    fields.frequency = repeatChoice === 'no' ? null : repeatChoice;
    fields.recurring = repeatChoice !== 'no';
  }
  // Written only when the panel actually changed: an edit that leaves it alone
  // leaves the stored image alone (the merge below keeps it), and a removed
  // receipt is nulled out rather than left behind.
  if (currentReceipt) fields.receipt = currentReceipt;
  else if (receiptRemoved) fields.receipt = null;

  // A cleared date saved an entry that no list could show (Reports still
  // counted it) and a cleared bill date rendered "NaN days" — dates and
  // money are required, errors stay in the modal.
  if (type === 'spend') {
    const date = document.getElementById('form-date').value;
    if (!date) { showFormError('Please enter a date', 'form-date'); return; }
    if (!(amount > 0)) { showFormError('Please enter an amount greater than 0', 'form-amount'); return; }
    Object.assign(fields, { date, amount });
  } else if (type === 'due') {
    const dueDate = document.getElementById('form-dueDate').value;
    if (!dueDate) { showFormError('Please enter a due date', 'form-dueDate'); return; }
    if (!(amount > 0)) { showFormError('Please enter an amount greater than 0', 'form-amount'); return; }
    Object.assign(fields, { dueDate, amount });
  } else {
    if (!(target > 0)) { showFormError('Please enter a target greater than 0', 'form-target'); return; }
    Object.assign(fields, { current: Number.isFinite(amount) ? amount : 0, target });
  }
  
  if (editId != null) {
    // Merge over the existing record so flags the form doesn't own
    // (confirmed, paid, frequency) survive an edit.
    const existing = await getItem(type, editId);
    if (existing) {
      // Spread over the existing record so flags the form doesn't own
      // (confirmed, paid, frequency, and any monthly set in an earlier
      // version) survive an edit.
      const merged = { ...existing, ...fields, id: editId };
      await updateItem(type, merged);
    }
  } else {
    if (type === 'spend') Object.assign(fields, { confirmed: false, paid: false });

    await addItem(type, fields);
  }

  // A goal that went up is a top-up, which is what the savings nudge counts
  // days since. Only the figure moving counts — editing a target isn't money.
  if (type === 'savings') noteGoalSaves([{ id: editId, current: Number.isFinite(amount) ? amount : 0 }]);

  currentReceipt = null;
  receiptRemoved = false;
  ocrStatusText = '';
  closeModal();
  renderPage();
  // The reminders are derived from the database, so anything that writes to it
  // has to rebuild them. Off the critical path: the page is already up.
  refreshReminders();
}

// What counts as "the same bill" when deciding whether a delete should take the
// series with it. Matching on name alone would catch two different bills that
// happen to share one; matching on name and amount and frequency is what a
// household would recognise, and works on rows written before this existed.
function sameSeries(a, b) {
  return !!a && !!b
    && a.title === b.title
    && a.amount === b.amount
    && frequencyOf(a) === frequencyOf(b);
}

// Deleting a recurring bill asked one question — delete? — and the answer was
// ambiguous. The series is carried by its upcoming row, so deleting that row
// ended every future occurrence without saying so, while deleting a paid row
// erased one month and carried on. Two named choices instead.
async function confirmDeleteRecurringBill(id) {
  const bill = await getItem('due', id);
  if (!bill) return;
  const rows = (await getAll('due')).filter((r) => sameSeries(r, bill));
  const paid = rows.filter((r) => r.paid === true).length;
  const future = rows.filter((r) => r.paid !== true).length;
  // Built outside the template: a nested backtick inside an interpolation is a
  // syntax error, and this file has found that out twice already.
  const paidNote = paid === 0 ? 'nothing paid' : paid + ' paid included';

  // The old version wrote its question into the Delete button itself, so the
  // button changed width mid-tap and the question was gone by the time you
  // answered it. It's a dialog with the question as the prompt and the two
  // meanings as tickboxes.
  openModal('Delete a repeating bill', `
    <p class="form-label" style="margin-bottom: 12px;">
      ${escapeHTML(bill.title)} repeats ${bill.frequency === 'annually' ? 'yearly' : 'every month'}.
      Do you want to delete
    </p>
    <label class="choice-row">
      <input type="checkbox" class="choice-box" id="delete-single" checked onchange="syncDeleteChoices(this.id)">
      <span class="choice-text">
        <span class="choice-label">This single bill only</span>
        <span class="setting-hint">
          Removes this one and keeps the rest${future === 1
            ? '. The following month is added back on so the bill carries on.'
            : '.'}
        </span>
      </span>
    </label>
    <div class="choice-or">or</div>
    <label class="choice-row">
      <input type="checkbox" class="choice-box" id="delete-series" onchange="syncDeleteChoices(this.id)">
      <span class="choice-text">
        <span class="choice-label">This bill and all recurring versions</span>
        <span class="setting-hint">
          Removes this and every month of it, ${paidNote}. Nothing is left to project.
        </span>
      </span>
    </label>
    <button class="btn btn-danger" style="width: 100%; margin-top: 18px;"
            onclick="deleteRecurringBill('${id}')">Delete</button>
  `);
}

// Two tickboxes, one meaning: the question has two answers and no third, so
// ticking either unticks the other and you can't end up with neither. The
// changed box wins — unticking whichever was selected falls back to the other,
// because leaving both empty would leave the Delete button with no answer.
function syncDeleteChoices(changed) {
  const single = document.getElementById('delete-single');
  const series = document.getElementById('delete-series');
  if (!single || !series) return;
  if (changed === 'delete-series' && series.checked) single.checked = false;
  else if (changed === 'delete-single' && single.checked) series.checked = false;
  else if (!single.checked && !series.checked) single.checked = true;
}

async function deleteRecurringBill(id, wholeSeries) {
  // No second argument means the dialog is on screen and the tickboxes have the
  // answer. Called with one, it already knows.
  if (wholeSeries === undefined) {
    wholeSeries = !!(document.getElementById('delete-series') || {}).checked;
  }
  const bill = await getItem('due', id);
  if (!bill) return;
  const rows = (await getAll('due')).filter((r) => sameSeries(r, bill));

  if (wholeSeries) {
    for (const row of rows) await deleteItem('due', row.id);
    showToast(`Removed ${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}`);
  } else {
    await deleteItem('due', id);
    // Deleting the upcoming occurrence would otherwise end the series silently.
    // Only put the next one back if the user hasn't already made one.
    const alreadyScheduled = rows.some((r) => r.id !== id && r.dueDate > (bill.dueDate || ''));
    if (bill.paid !== true && frequencyOf(bill) && !alreadyScheduled) {
      await addItem('due', {
        ...bill, paid: false,
        dueDate: nextDueDate(bill.dueDate, bill.frequency)
      });
    }
    showToast('Removed this month only');
  }
  currentReceipt = null;
  closeModal();
  renderPage();
}

async function deleteItemFromModal(type, id, btn) {
  // A repeating bill asks which of the two it means; anything else is a single
  // row and needs one confirmation.
  if (type === 'due') {
    const bill = await getItem('due', id);
    if (bill && frequencyOf(bill)) return confirmDeleteRecurringBill(id);
  }
  // Two-step confirm: no native dialogs, no accidental deletes.
  if (btn.dataset.confirming !== '1') {
    btn.dataset.confirming = '1';
    btn.textContent = 'Really delete? Click again';
    setTimeout(() => {
      btn.dataset.confirming = '';
      btn.textContent = 'Delete';
    }, 4000);
    return;
  }
  await deleteItem(type, id);
  currentReceipt = null;
  closeModal();
  renderPage();
  refreshReminders();
}

async function toggleConfirm(type, id) {
  const item = await getItem(type, id);
  if (!item) return;
  item.confirmed = !item.confirmed;
  await updateItem(type, item);
  renderPage();
  refreshReminders();
}

// Putting a bill back to unpaid. Two shapes have to be handled: a settled row
// from 2.8.3 onwards, and a payment copy left in Spend by the old model, where
// undoing means deleting the copy and letting the bill come back.
async function unpayBill(id) {
  const bill = await getItem('due', id);
  if (bill && bill.paid === true) {
    await updateItem('due', { ...bill, paid: false });
    showToast('Back to unpaid');
    await renderPage();
    refreshReminders();
    return;
  }
  const twin = (await getAll('spend')).find((s) => s.paid === true && s.dueDate === bill?.dueDate);
  if (twin) {
    await deleteItem('spend', twin.id);
    showToast('Back to unpaid');
  }
  await renderPage();
  refreshReminders();
}

async function markPaid(id) {
  const item = await getItem('due', id);
  if (!item) return;
  // Whoever is using the app right now is recorded as the payer, which is the
  // half of "who paid for it" the bill's own person can't answer.
  await markDuePaid(item, getCurrentPersonId());
  // A recurring bill rolls to the same day next month, so it leaves the list
  // that was just tapped. Say where it went — otherwise a payment looks like
  // it deleted the bill.
  if (item.recurring) {
    showToast(`Paid — next due ${formatDate(nextDueDate(item.dueDate))}`);
  } else {
    showToast('Marked as paid');
  }
  renderPage();
  refreshReminders();
}

// Cap plugins are registered lazily on first use — registerPlugin() warns
// if called twice for the same name.
let capExport = null;

async function exportData() {
  const data = await getAllData();
  const json = JSON.stringify(data, null, 2);
  const name = `sorted-backup-${localISO()}.json`;

  // Capacitor/Android: the WebView can't process blob: downloads (the click
  // silently does nothing), so write the backup into the app cache and hand
  // it to the system share sheet via the FileProvider instead.
  if (window.Capacitor && window.Capacitor.isNativePlatform()) {
    try {
      if (!capExport) {
        capExport = {
          fs: window.Capacitor.registerPlugin('Filesystem'),
          share: window.Capacitor.registerPlugin('Share'),
        };
      }
      const { uri } = await capExport.fs.writeFile({ path: name, data: json, directory: 'CACHE' });
      await capExport.share.share({ title: 'Sorted backup', files: [uri] });
      showToast('Backup ready to share');
    } catch (err) {
      const msg = String((err && err.message) || err);
      if (/cancel/i.test(msg)) return; // backing out of the share sheet isn't an error
      console.error('Export failed:', err);
      showToast(`Export failed: ${msg}`);
    }
    return;
  }

  // Web: browser download.
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

async function importData() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) await importFromFile(file);
  };
  input.click();
}

async function importFromFile(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (err) {
    showToast("That file isn't valid JSON");
    return;
  }
  await startImport(data);
}

// Parsed backup arrives here (web file picker or Electron dialog) — validate
// it, then let the user choose merge vs replace before anything is written.
let pendingImport = null;

async function startImport(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    showToast("That file isn't a Sorted backup");
    return;
  }
  const fileStores = STORES.filter((n) => Array.isArray(data[n]));
  if (fileStores.length === 0) {
    showToast('No Sorted data found in that file');
    return;
  }
  const fileCount = fileStores.reduce((n, s) => n + data[s].length, 0);
  if (fileCount === 0) {
    showToast('Nothing to import in that file');
    return;
  }

  const existing = await getAllData();
  const existingCount = STORES.reduce((n, s) => n + (existing[s] ? existing[s].length : 0), 0);
  const parts = fileStores
    .filter((s) => data[s].length > 0)
    .map((s) => `${data[s].length} ${s}`)
    .join(', ');

  pendingImport = data;
  openModal('Import data', `
      <p class="form-label">File: ${fileCount} item${fileCount === 1 ? '' : 's'} (${escapeHTML(parts)}). Stored: ${existingCount}.</p>
      <button class="btn btn-primary" style="width: 100%; margin-top: 10px;" onclick="commitImport('merge')">Merge into existing</button>
      <button class="btn btn-danger" style="width: 100%; margin-top: 10px;" onclick="commitImport('replace', this)">Replace all stored data</button>
      <button class="btn btn-ghost" style="width: 100%; margin-top: 10px;" onclick="cancelImport()">Cancel</button>`);
}

function cancelImport() {
  pendingImport = null;
  closeModal();
}

async function commitImport(mode, btn) {
  // Replace wipes everything — same two-step confirm as delete in-modal.
  if (mode === 'replace' && btn && btn.dataset.confirming !== '1') {
    btn.dataset.confirming = '1';
    btn.textContent = 'Really replace everything? Click again';
    setTimeout(() => {
      btn.dataset.confirming = '';
      btn.textContent = 'Replace all stored data';
    }, 4000);
    return;
  }
  const data = pendingImport;
  pendingImport = null;
  closeModal();
  if (!data) return;

  try {
    const { imported, skipped, dropped } = await importDataToDB(data, mode);
    if (mode === 'replace') {
      showToast(`Replaced with ${imported} item${imported === 1 ? '' : 's'}${dropped ? ` (${dropped} unusable skipped)` : ''}`);
    } else {
      showToast(`Imported ${imported} new item${imported === 1 ? '' : 's'}${skipped ? `, skipped ${skipped} duplicate${skipped === 1 ? '' : 's'}` : ''}${dropped ? `, ${dropped} unusable skipped` : ''}`);
    }
    renderPage();
  } catch (err) {
    console.error('Import failed:', err);
    showToast(err.message || 'Import failed');
  }
}

// A caller can ask for longer than the default. A permission problem that
// disappears after three and a half seconds is one you can't act on, so the
// messages that name a fix stay up long enough to read.
function showToast(message, ms) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(showToast.timer);
  const duration = Number(ms) > 0 ? Number(ms) : 3500;
  showToast.timer = setTimeout(() => el.classList.remove('show'), duration);
}

// Row actions — one delegated listener instead of inline handlers, so no
// user-controlled value is ever interpolated into an HTML attribute.
document.getElementById('content').addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]');
  if (action) {
    // The id straight off the dataset. Ids are UUID strings (older rows are
    // still numbers), so this must not be run through Number().
    const id = action.dataset.id;
    if (action.dataset.action === 'toggle') toggleConfirm(action.dataset.type, id);
    else if (action.dataset.action === 'paid') markPaid(id);
    else if (action.dataset.action === 'unpaid') unpayBill(id);
    else if (action.dataset.action === 'receipt') viewItemReceipt(action.dataset.type, id);
    else if (action.dataset.action === 'edit-receipt') openEditModal(action.dataset.type, id);
    return;
  }
  const row = e.target.closest('[data-edit-id]');
  if (row) openEditModal(row.dataset.editType, row.dataset.editId);
});

// The person chip lives outside #content (the top bar), and the picker's
// options live inside the modal, so both are handled on the document.
document.addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]');
  if (!action) return;
  if (action.dataset.action === 'pick-person') {
    openPersonPicker();
    return;
  }
  if (action.dataset.action === 'choose-person') {
    setCurrentPersonId(action.dataset.id || null);
    closeModal();
  }
});

// The receipt thumbnail inside the Edit popup opens the same viewer as the
// paperclip on a list row.
modalBody.addEventListener('click', (e) => {
  if (e.target.closest('[data-action="view-receipt"]')) openViewer(currentReceipt);
});

async function viewItemReceipt(type, id) {
  const item = await getItem(type, id);
  if (item) openViewer(item.receipt);
}

// Initialize
applyTheme();
initLock();
// Cash has to exist before anything renders, including on an install that was
// seeded before accounts were a thing.
ensureDefaults();
// Only starts anything if notifications were already switched on, so the
// common case costs one function call and no listeners.
initNotifications();
renderPage();
