// Sorted v2 - Main Application

// Single source for the version shown in the UI. Bump this together with
// package.json and android/app/build.gradle.
const APP_VERSION = '2.5.1';
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
  renderPage();
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
    document.body.classList.add('is-native');
  }
}

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
  renderToken++;

  // Every page needs the people list: to resolve a row's dot, to offer the
  // filter, or to stamp a form. One read, shared by the render below.
  await loadPeople();
  renderPersonChip();

  switch(currentPage) {
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
      break;
  }
}

// Dashboard
async function renderDashboard(container) {
  const token = renderToken;
  await seedIfEmpty();
  
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
  
  // Draw simple bar chart
  drawTrendChart(spendItems, dashViewedDate);
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
  const inMonth = dueItems.filter((i) => isSameMonth(i.dueDate, date));
  const overdueElsewhere = lookingBack
    ? []
    : dueItems.filter((i) => isOverdue(i.dueDate) && !isSameMonth(i.dueDate, date));
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

// How a bill reads at a glance. Only counted down when the number is worth
// acting on: a raw "522 days" for a bill due in 2028 told the user nothing
// and looked like the app was incrementing something on its own.
function dueCountdown(dueDate) {
  const days = daysUntil(dueDate);
  if (days < 0) {
    const n = Math.abs(days);
    return `<span style="color: var(--danger)">${n} day${n === 1 ? '' : 's'} overdue</span>`;
  }
  if (days === 0) return '<span style="color: var(--warning)">Due today</span>';
  if (days <= 7) return `<span style="color: var(--warning)">In ${days} day${days === 1 ? '' : 's'}</span>`;
  // Beyond a week the exact date under the title says it better than a
  // number that ticks down in the background.
  return '<span style="color: var(--text-secondary)">Scheduled</span>';
}

// Every spend/bill row carries the paperclip, so the row doesn't change shape
// once a receipt is attached. Dimmed with no photo behind it, it doubles as
// the way in to attach one — which is how entries added before receipts were
// stored get their picture.
function receiptChip(item, type) {
  const has = !!item.receipt;
  return `<button class="receipt-chip${has ? '' : ' receipt-chip--empty'}" data-action="${has ? 'receipt' : 'edit-receipt'}"
            data-type="${type}" data-id="${item.id}"
            title="${has ? 'View receipt' : 'Add a receipt'}"
            aria-label="${has ? 'View receipt for' : 'Add a receipt for'} ${escapeHTML(item.title)}">${CLIP_SVG}</button>`;
}

// Spend Page
async function renderSpend(container) {
  const token = renderToken;
  await seedIfEmpty();
  
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
  const projections = projectionsForMonth(items, viewedDate, 'date');
  const monthItems = applySpendFilter(inMonth);
  const yearItems = applySpendFilter(inYear);
  const monthTotal = monthItems.reduce((sum, i) => sum + i.amount, 0);
  const yearTotal = yearItems.reduce((sum, i) => sum + i.amount, 0);
  
  if (token !== renderToken) return;
  container.innerHTML = `
    <div class="page-toolbar">
      ${monthNavHtml('spend', viewedDate)}
      <button class="btn btn-primary" onclick="openAddModal('spend')">+ Add Spend</button>
    </div>
    
    <div class="stat-card" style="margin-bottom: 20px;">
      <div class="stat-card-header">
        <span class="stat-card-title">Monthly Total</span>
        <span class="stat-card-sub">Year: ${currency(yearTotal)}</span>
      </div>
      <div class="stat-card-value">${currency(monthTotal)}</div>
    </div>
    
    <div class="filter-bar" aria-label="Status">
      <span class="filter-chip ${spendFilter === 'all' ? 'active' : ''}" role="button" tabindex="0" onclick="filterSpend('all')">All</span>
      <span class="filter-chip ${spendFilter === 'confirmed' ? 'active' : ''}" role="button" tabindex="0" onclick="filterSpend('confirmed')">Confirmed</span>
      <span class="filter-chip ${spendFilter === 'pending' ? 'active' : ''}" role="button" tabindex="0" onclick="filterSpend('pending')">Pending</span>
      <span class="filter-chip ${spendFilter === 'recurring' ? 'active' : ''}" role="button" tabindex="0" onclick="filterSpend('recurring')">Recurring</span>
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
      <div class="item-row${projected ? ' item-row--projected' : ''}"${editable ? ` data-edit-type="spend" data-edit-id="${item.id}"` : ''}>
        <div class="item-row-main">
          <div class="item-info">
            <div class="item-title">${escapeHTML(item.title)}</div>
            <div class="item-meta">
              ${formatDate(item.date)} · ${escapeHTML(item.category)}
              ${isRecurring(item) ? `<span class="badge badge-recurring">${item.frequency === 'annually' ? 'Yearly' : 'Monthly'}</span>` : ''}
              ${projected ? '<span class="badge badge-projected">Projected</span>' : ''}
            </div>
          </div>
        </div>
        <div class="item-amount">${currency(item.amount)}</div>
        <div class="item-actions">
          ${personDot(personById(item.personId))}
          ${editable ? receiptChip(item, 'spend') : ''}
          ${projected ? '' : `<button class="confirm-btn" data-action="toggle" data-type="spend" data-id="${item.id}"
                  aria-pressed="${item.confirmed ? 'true' : 'false'}"
                  aria-label="${item.confirmed ? 'Unconfirm' : 'Confirm'} ${escapeHTML(item.title)}"
                  title="${item.confirmed ? 'Confirmed — tap to undo' : 'Confirm'}">${TICK_SVG}</button>`}
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

// Bills already paid, read back out of Spend. markDuePaid() writes the payment
// into Spend before rolling or removing the bill, so that copy is the only
// record a paid bill leaves behind — this is what makes a past month reviewable
// rather than just a date you stepped back to.
function paidBillsForMonth(spendItems, date) {
  return spendItems
    .filter((i) => i.paid === true && i.dueDate && isSameMonth(i.dueDate, date))
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
  await seedIfEmpty();
  
  const [all, spendItems] = await Promise.all([getAll('due'), getAll('spend')]);
  all.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
  
  // The month view exists so a recurring bill's *next* occurrences are
  // visible — a bill is only ever stored with the date it's currently due,
  // so without stepping forward there was no way to see what the following
  // few months look like.
  const { stored: outstanding, inMonth, overdueElsewhere, projections } = billsForMonth(all, dueViewedDate);
  const paid = paidBillsForMonth(spendItems, dueViewedDate);
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
      <button class="btn btn-primary" onclick="openAddModal('due')">+ Add Bill</button>
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
          <div class="item-row${projected ? ' item-row--projected' : ''}"${editable ? ` data-edit-type="${isPaid ? 'spend' : 'due'}" data-edit-id="${item.id}"` : ''} style="${isOverdueItem ? 'border-color: var(--danger);' : ''}">
            <div class="item-row-main">
              <div class="item-info">
                <div class="item-title">${escapeHTML(item.title)}</div>
                <div class="item-meta">
                  ${projected ? 'Due' : 'Due'} ${formatDate(item.dueDate)} · ${escapeHTML(item.category)}
                  ${isRecurring(item) ? `<span class="badge badge-recurring">${item.frequency === 'annually' ? 'Yearly' : 'Monthly'}</span>` : ''}
                  ${projected ? '<span class="badge badge-projected">Projected</span>' : ''}
                </div>
              </div>
            </div>
            <div class="item-amount">${currency(item.amount)}</div>
            <div class="item-actions">
              ${personDot(personById(item.personId))}
              ${editable ? receiptChip(item, isPaid ? 'spend' : 'due') : ''}
              ${isPaid
                ? `<span class="confirm-btn is-done" aria-hidden="true">${TICK_SVG}</span>`
                : projected
                  ? ''
                  : `<button class="confirm-btn" data-action="paid" data-type="due" data-id="${item.id}"
                        aria-pressed="false" aria-label="Mark ${escapeHTML(item.title)} as paid" title="Mark as paid">${TICK_SVG}</button>`}
            </div>
            ${isPaid && item.date
              ? `<div class="item-sub item-sub--paid">Paid ${formatDate(item.date)}</div>`
              : projected
                ? `<div class="item-sub">Repeats ${item.frequency === 'annually' ? 'yearly' : 'monthly'}</div>`
                : `<div class="item-sub">${dueCountdown(item.dueDate)}</div>`}
          </div>
        `;
      }).join('')}
    </div>
  `;
}

// Savings Page
async function renderSavings(container) {
  const token = renderToken;
  await seedIfEmpty();
  
  const items = await getAll('savings');
  const totalCurrent = items.reduce((sum, i) => sum + i.current, 0);
  const totalTarget = items.reduce((sum, i) => sum + i.target, 0);
  const pct = totalTarget > 0 ? Math.round((totalCurrent / totalTarget) * 100) : 0;
  
  if (token !== renderToken) return;
  container.innerHTML = `
    <div class="page-toolbar page-toolbar--end">
      <button class="btn btn-primary" onclick="openAddModal('savings')">+ Add Goal</button>
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
          <div class="item-row${done ? ' item-row--done' : ''}" data-edit-type="savings" data-edit-id="${item.id}">
            <div class="item-row-main">
              <div class="item-info">
                <div class="item-title">${escapeHTML(item.title)}</div>
                <div class="item-meta">${escapeHTML(item.category)} · ${goalPct}% complete</div>
              </div>
            </div>
            <div style="text-align: right; min-width: 130px;">
              <div class="item-amount"${done ? '' : ' style="color: var(--success)"'}>${currency(item.current)}</div>
              <div class="stat-card-sub">of ${currency(item.target)}</div>
              <div class="stat-card-progress" style="margin-top: 8px;">
                <div class="stat-card-progress-fill progress-savings" style="width: ${Math.min(100, goalPct)}%"></div>
              </div>
            </div>
            <div class="item-actions item-actions--stack">
              ${done ? `<span class="goal-tick" role="img" aria-label="Goal reached" title="Goal reached">${GOAL_TICK_SVG}</span>` : ''}
              ${personDot(personById(item.personId))}
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

// Reports Page
async function renderReports(container) {
  const token = renderToken;
  const [spendItems, dueItems, savingsItems] = await Promise.all([
    getAll('spend'),
    getAll('due'),
    getAll('savings')
  ]);

  // Range chips scope spending and bills; savings goals have no dates,
  // so their total stays lifetime.
  const inRange = (dateStr) => reportRange === 'all' ? true
    : reportRange === 'month' ? isThisMonth(dateStr)
    : isThisYear(dateStr);
  const rangedSpend = spendItems.filter(i => inRange(i.date));
  const rangedDue = dueItems.filter(i => inRange(i.dueDate));

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
        <h2 class="report-title">Spending by Category</h2>
        ${renderReportBreakdown(groupByCategory(rangedSpend, 'amount'), totalSpend, 'accent')}
        ${reportTotalRow('Total Spent', totalSpend, 'accent')}
      </div>
      
      <div class="report-card">
        <h2 class="report-title">Bills by Category</h2>
        ${renderReportBreakdown(groupByCategory(rangedDue, 'amount'), totalDue, 'danger')}
        ${reportTotalRow('Total Due', totalDue, 'danger')}
      </div>

      <div class="report-card">
        <h2 class="report-title">Who Spent What</h2>
        ${renderPersonBreakdown(rangedSpend, rangedDue)}
      </div>

      <div class="report-card">
        <h2 class="report-title">Savings by Goal</h2>
        ${renderSavingsBreakdown(savingsItems)}
        ${reportTotalRow('Total Saved', totalSavings, 'success')}
      </div>
    </div>
  `;
}

// A card's own total, sitting under its breakdown. The separate Summary card
// repeated all three in one place, which meant reading one number required
// scrolling past two other cards to find it — and the total is the thing the
// breakdown below it adds up to, so it belongs at the foot of that breakdown.
function reportTotalRow(label, amount, tone) {
  return `
    <div class="report-total">
      <span class="report-total-label">${escapeHTML(label)}</span>
      <span class="report-total-value${tone ? ' tone-' + tone : ''}">${currency(amount)}</span>
    </div>
  `;
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
        <h2 class="report-title">Appearance</h2>
        <div class="setting-row">
          <div class="setting-text">
            <div class="setting-label">Theme</div>
          </div>
          <div class="setting-control">
            ${themeSegment()}
          </div>
        </div>
      </div>

      <div class="report-card">
        <h2 class="report-title">People</h2>
        ${peopleSettingsHtml()}
      </div>

      <div class="report-card">
        <h2 class="report-title">Passcode</h2>
        ${passcodeSettings()}
      </div>

      <div class="report-card">
        <h2 class="report-title">Data Management</h2>
        <p style="color: var(--text-secondary); margin-bottom: 15px;">Export or import your financial data</p>
        <button class="btn btn-primary" onclick="handleExport()" style="width: 100%; margin-bottom: 10px;">Export Data</button>
        <button class="btn btn-ghost" onclick="handleImport()" style="width: 100%;">Import Data</button>
      </div>

      <div class="report-card">
        <h2 class="report-title">Bill Reminders</h2>
        ${notifySettingsHtml()}
      </div>

      <div class="report-card">
        <h2 class="report-title">Start Over</h2>
        <p style="color: var(--text-secondary); margin-bottom: 15px;">
          Delete everything and start from empty. There's no undo and no backup
          of its own — export first if you might want any of it.
        </p>
        <button class="btn btn-danger" onclick="confirmRemoveAllData(this)" style="width: 100%;">Delete all data</button>
      </div>

      <div class="report-card">
        <h2 class="report-title">About</h2>
        <p style="color: var(--text-secondary);">
          <strong>Sorted <span class="app-version">v${APP_VERSION}</span></strong><br>
          A modern finance tracker<br>
          All data stored locally<br>
          No cloud, no login required
        </p>
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
  // Deliberately no re-seed here. Put the sample data back and "delete all
  // data" doesn't: every figure the user just wiped reappears, which is
  // indistinguishable from the button not having worked. Empty is what empty
  // means. The seed only ever runs on a first launch, from a database that has
  // never had anything in it.
  closeModal();
  navigate('dashboard');
  showToast(`${result.total} items deleted`);
  await renderPage();
}

// Bill reminders, and the honest limits of them. There is no backend, so
// nothing can fire at a set time in the background: the app checks when you put
// it away and when you pick it up. Said here rather than left for the user to
// discover, because "it didn't remind me" otherwise reads as a broken feature.
function notifySettingsHtml() {
  if (!notifySupported()) {
    return '<p class="setting-hint">This browser has no notifications.</p>';
  }

  const on = isNotifyEnabled();
  const permission = Notification.permission;
  const leadRow = `
    <div class="setting-row setting-row--left">
      <div class="setting-text">
        <div class="setting-label">Remind me</div>
      </div>
      <div class="setting-control">
        <select class="form-input" id="notify-lead" style="width: auto;" onchange="setNotifyLeadDays(Number(this.value)); renderPage();">
          ${NOTIFY_LEADS.map((l) => `<option value="${l.value}" ${l.value === getNotifyLeadDays() ? 'selected' : ''}>${l.label}</option>`).join('')}
        </select>
      </div>
    </div>`;

  if (permission === 'denied') {
    return `
      <p class="setting-hint">
        Blocked for this site. Reminders have to be re-allowed in the browser's
        own settings for this page before Sorted can use them.
      </p>
      ${leadRow}
    `;
  }

  return `
    <div class="setting-row">
      <div class="setting-text">
        <div class="setting-label">Remind me about bills</div>
        <div class="setting-hint">${on
          ? 'When a bill is coming due or already overdue'
          : 'A system notification, on a phone only while Sorted is closed'}</div>
      </div>
      <div class="setting-control">
        <button class="switch" role="switch" aria-checked="${on}" aria-label="Remind me about bills"
                onclick="toggleNotifications(this)"></button>
      </div>
    </div>
    ${on ? leadRow : ''}
    ${on ? `<p class="setting-hint" style="margin-top: 12px;">
      There's no server, so nothing can arrive at a set time on its own. Sorted
      checks when you close it and when you open it again — install it to your
      home screen and notifications will reach you.
    </p>` : ''}
  `;
}

async function toggleNotifications(switchEl) {
  if (isNotifyEnabled()) {
    disableNotifications();
    renderPage();
    return;
  }
  const result = await enableNotifications();
  if (result === 'on') {
    showToast('Bill reminders on');
  } else if (result === 'denied') {
    showToast('Notifications blocked for this site');
  } else {
    showToast('This browser has no notifications');
  }
  renderPage();
}

function peopleSettingsHtml() {
  const people = [...peopleCache.values()];
  const current = getCurrentPersonId();
  const rows = people.map((p) => `
    <div class="setting-row">
      <div class="setting-text">
        <div class="setting-label person-setting-label">${personDot(p, 20, true)} ${escapeHTML(p.name)}${current === p.id ? ' — using now' : ''}</div>
      </div>
      <div class="setting-control">
        <button class="btn btn-ghost" onclick="openPersonPinModal('${p.id}')">${hasPersonPin(p.id) ? 'Change PIN' : 'Set PIN'}</button>
        <button class="btn btn-ghost" onclick="removePersonFromSettings('${p.id}', this)">Remove</button>
      </div>
    </div>`).join('');

  return `
    ${rows}
    <div class="setting-row">
      <div class="setting-text">
        <div class="setting-label">Add someone</div>
      </div>
      <div class="setting-control">
        <input type="text" class="form-input" id="new-person-name" placeholder="Name" maxlength="40" style="width: 130px;">
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

function themeSegment() {
  const pref = getThemePreference();
  const opt = (value, label) =>
    `<button class="segmented-option ${pref === value ? 'active' : ''}" onclick="setThemePreference('${value}')">${label}</button>`;
  return `<div class="segmented">${opt('light', 'Light')}${opt('dark', 'Dark')}${opt('system', 'System')}</div>`;
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

  if (!isPasscodeSet()) {
    return `
      <div class="setting-row">
        <div class="setting-text">
          <div class="setting-label">Require a passcode</div>
          <div class="setting-hint">Ask for it when the app opens</div>
        </div>
        <div class="setting-control">
          <button class="switch" role="switch" aria-checked="false" aria-label="Require a passcode"
                  onclick="openPasscodeSetup()"></button>
        </div>
      </div>
      ${lockBlock}
    `;
  }

  return `
    <div class="setting-row">
      <div class="setting-text">
        <div class="setting-label">Passcode on</div>
      </div>
      <div class="setting-control">
        <button class="switch" role="switch" aria-checked="true" aria-label="Remove passcode"
                onclick="confirmRemovePasscode(this)"></button>
      </div>
    </div>
    ${lockBlock}
  `;
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
  const recurring = document.getElementById('form-recurring');
  // A row that was saved with the old yes/no flag has no frequency, but it
  // still repeats — monthly is what "yes" meant.
  if (recurring) recurring.value = frequencyOf(item) || 'no';
  setVal('form-person', item.personId || '');
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
  const repeatChoice = document.getElementById('form-recurring')?.value || 'no';
  const personId = document.getElementById('form-person')?.value || null;

  if (!title) {
    showFormError('Please enter a title', 'form-title');
    return;
  }

  const fields = { title, category, personId };
  if (type !== 'savings') {
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
      await updateItem(type, { ...existing, ...fields, id: editId });
    }
  } else {
    if (type === 'spend') Object.assign(fields, { confirmed: false, paid: false });

    await addItem(type, fields);
  }

  currentReceipt = null;
  receiptRemoved = false;
  ocrStatusText = '';
  closeModal();
  renderPage();
}

async function deleteItemFromModal(type, id, btn) {
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
}

async function toggleConfirm(type, id) {
  const item = await getItem(type, id);
  if (!item) return;
  item.confirmed = !item.confirmed;
  await updateItem(type, item);
  renderPage();
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

function showToast(message) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => el.classList.remove('show'), 3500);
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
// Only starts anything if notifications were already switched on, so the
// common case costs one function call and no listeners.
initNotifications();
renderPage();
