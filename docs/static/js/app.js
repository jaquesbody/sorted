// Sorted v2 - Main Application

// Single source for the version shown in the UI. Bump this together with
// package.json and android/app/build.gradle.
const APP_VERSION = '2.0.4';
document.querySelectorAll('.app-version').forEach((el) => { el.textContent = 'v' + APP_VERSION; });

let currentPage = 'dashboard';
let viewedDate = new Date();
viewedDate.setDate(1);
// Bills Due has its own month cursor: the two pages are navigated separately
// and a shared one made stepping through a bill's recurrence move the spend
// list too.
let dueViewedDate = new Date();
dueViewedDate.setDate(1);
let spendFilter = 'all';
let reportRange = 'all'; // Reports date range: 'all' | 'month' | 'year'

// Navigation — delegated, so the cloned bottom-bar copy used by the
// phone layout works with the same handler and all copies stay in sync.
document.addEventListener('click', (e) => {
  const item = e.target.closest && e.target.closest('.nav-item');
  if (!item) return;
  document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
  item.classList.add('active');
  currentPage = item.dataset.page;
  renderPage();
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
  
  const spendMonth = spendItems.filter(i => isThisMonth(i.date));
  const spendYear = spendItems.filter(i => isThisYear(i.date));
  const spendMonthTotal = spendMonth.reduce((sum, i) => sum + i.amount, 0);
  const spendYearTotal = spendYear.reduce((sum, i) => sum + i.amount, 0);
  
  const dueTotal = dueItems.reduce((sum, i) => sum + i.amount, 0);
  const overdueCount = dueItems.filter(i => isOverdue(i.dueDate)).length;
  
  const savingsCurrent = savingsItems.reduce((sum, i) => sum + i.current, 0);
  const savingsTarget = savingsItems.reduce((sum, i) => sum + i.target, 0);
  const savingsPct = savingsTarget > 0 ? Math.round((savingsCurrent / savingsTarget) * 100) : 0;
  
  // Category breakdowns
  const spendByCategory = groupByCategory(spendMonth, 'amount');
  const dueByCategory = groupByCategory(dueItems, 'amount');
  
  if (token !== renderToken) return;
  container.innerHTML = `
    <div class="dashboard-grid">
      <div class="stat-card" role="button" tabindex="0" onclick="currentPage='spend'; renderPage();">
        <div class="stat-card-header">
          <span class="stat-card-title">Spent This Month</span>
          <span class="stat-card-sub">${spendMonth.length} items</span>
        </div>
        <div class="stat-card-value">${currency(spendMonthTotal)}</div>
        <div class="stat-card-sub">${currency(spendYearTotal)} this year</div>
        <div class="stat-card-progress">
          <div class="stat-card-progress-fill progress-spend" style="width: ${Math.min(100, (spendMonthTotal / 1000) * 100)}%"></div>
        </div>
        ${renderCategoryBreakdown(spendByCategory, spendMonthTotal)}
      </div>
      
      <div class="stat-card" role="button" tabindex="0" onclick="currentPage='due'; renderPage();">
        <div class="stat-card-header">
          <span class="stat-card-title">Bills Due</span>
          <span class="stat-card-sub">${dueItems.length} items</span>
        </div>
        <div class="stat-card-value" style="color: ${overdueCount > 0 ? 'var(--danger)' : 'var(--text-primary)'}">${currency(dueTotal)}</div>
        <div class="stat-card-sub">${overdueCount > 0 ? overdueCount + ' overdue' : 'All up to date'}</div>
        <div class="stat-card-progress">
          <div class="stat-card-progress-fill progress-due" style="width: ${Math.min(100, (dueTotal / 500) * 100)}%"></div>
        </div>
        ${renderCategoryBreakdown(dueByCategory, dueTotal)}
      </div>
      
      <div class="stat-card" role="button" tabindex="0" onclick="currentPage='savings'; renderPage();">
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
      </div>
      <canvas id="trend-chart" class="chart-canvas"></canvas>
    </div>
  `;
  
  // Draw simple bar chart
  drawTrendChart(spendItems);
}

function groupByCategory(items, amountKey) {
  const totals = {};
  items.forEach(item => {
    totals[item.category] = (totals[item.category] || 0) + item[amountKey];
  });
  return totals;
}

function renderCategoryBreakdown(totals, grandTotal) {
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
              <div class="category-bar-fill" style="width: ${pct}%"></div>
            </div>
            <span class="category-amount">${currency(amt)}</span>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function drawTrendChart(spendItems) {
  const canvas = document.getElementById('trend-chart');
  if (!canvas) return;
  lastTrendItems = spendItems;

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
  const muted = css.getPropertyValue('--text-secondary').trim() || '#8b8b96';
  // The canvas sits inside a card, so it paints itself the card colour —
  // --bg-surface left a visible inset rectangle of a different shade.
  const surface = css.getPropertyValue('--bg-card').trim() || '#222228';
  const bodyFont = getComputedStyle(document.body).fontFamily || 'sans-serif';

  const months = [];
  const now = new Date();

  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({
      label: d.toLocaleDateString('en-GB', { month: 'short' }),
      total: spendItems
        .filter(item => isSameMonth(item.date, d))
        .reduce((sum, i) => sum + i.amount, 0)
    });
  }

  const max = Math.max(...months.map(m => m.total), 100);
  const barWidth = w / months.length - 10;

  ctx.fillStyle = surface;
  ctx.fillRect(0, 0, w, h);

  months.forEach((m, i) => {
    const height = (m.total / max) * (h - 40);
    const x = i * (barWidth + 10) + 5;
    const y = h - height - 20;

    ctx.fillStyle = accent;
    ctx.fillRect(x, y, barWidth, height);

    ctx.fillStyle = muted;
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
      ctx.fillText(currency(m.total), clamp(x + barWidth / 2, currency(m.total)), y - 5);
    }
  });
}

// Redraw the trend chart on window resize (the backing store is sized in
// device pixels, so a resize would otherwise leave it stretched).
let lastTrendItems = null;
let trendResizeTimer = null;
window.addEventListener('resize', () => {
  if (currentPage !== 'dashboard' || !lastTrendItems) return;
  clearTimeout(trendResizeTimer);
  trendResizeTimer = setTimeout(() => drawTrendChart(lastTrendItems), 150);
});

// settings.js calls this after a theme change: the chart is a canvas painted
// with colours read out of the CSS variables, so a restyle isn't enough.
function onThemeChanged() {
  if (currentPage === 'dashboard' && lastTrendItems) drawTrendChart(lastTrendItems);
}

// A single crisp tick, shared by the confirm (Spend) and mark-as-paid (Bills
// Due) boxes. Inline SVG rather than a "✓" character: the text glyph rendered
// thin and inconsistently placed, and read as a dot inside a circle rather
// than as a tick.
const TICK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>';

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
  
  const monthItems = items.filter(i => isSameMonth(i.date, viewedDate));
  const yearItems = items.filter(i => isSameYear(i.date, viewedDate));
  const monthTotal = monthItems.reduce((sum, i) => sum + i.amount, 0);
  const yearTotal = yearItems.reduce((sum, i) => sum + i.amount, 0);
  
  if (token !== renderToken) return;
  container.innerHTML = `
    <div class="page-toolbar">
      <div class="month-nav">
        <button class="btn-icon" onclick="stepMonth('spend', -1)" aria-label="Previous month">◀</button>
        <span class="month-label">${formatMonth(viewedDate)}</span>
        <button class="btn-icon" onclick="stepMonth('spend', 1)" aria-label="Next month">▶</button>
      </div>
      <button class="btn btn-primary" onclick="openAddModal('spend')">+ Add Spend</button>
    </div>
    
    <div class="stat-card" style="margin-bottom: 20px;">
      <div class="stat-card-header">
        <span class="stat-card-title">Monthly Total</span>
        <span class="stat-card-sub">Year: ${currency(yearTotal)}</span>
      </div>
      <div class="stat-card-value">${currency(monthTotal)}</div>
    </div>
    
    <div class="filter-bar">
      <span class="filter-chip ${spendFilter === 'all' ? 'active' : ''}" role="button" tabindex="0" onclick="filterSpend('all')">All</span>
      <span class="filter-chip ${spendFilter === 'confirmed' ? 'active' : ''}" role="button" tabindex="0" onclick="filterSpend('confirmed')">Confirmed</span>
      <span class="filter-chip ${spendFilter === 'pending' ? 'active' : ''}" role="button" tabindex="0" onclick="filterSpend('pending')">Pending</span>
      <span class="filter-chip ${spendFilter === 'recurring' ? 'active' : ''}" role="button" tabindex="0" onclick="filterSpend('recurring')">Recurring</span>
    </div>
    
    <div class="item-list" id="spend-list">
      ${renderSpendList(monthItems, monthTotal)}
    </div>
  `;
}

function applySpendFilter(items) {
  if (spendFilter === 'confirmed') return items.filter(i => i.confirmed === true);
  if (spendFilter === 'pending') return items.filter(i => !i.confirmed);
  if (spendFilter === 'recurring') return items.filter(i => !!i.recurring);
  return items;
}

function renderSpendList(monthItems, monthTotal) {
  const filtered = applySpendFilter(monthItems);
  if (filtered.length === 0 && monthItems.length > 0) {
    return `
      <div class="empty-state">
        <div class="empty-state-text">No ${spendFilter} items this month</div>
      </div>
    `;
  }
  return renderSpendItems(filtered, monthTotal);
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
    return `
      <div class="item-row" data-edit-type="spend" data-edit-id="${item.id}">
        <div class="item-row-main">
          <div class="item-info">
            <div class="item-title">${escapeHTML(item.title)}</div>
            <div class="item-meta">
              ${formatDate(item.date)} · ${escapeHTML(item.category)}
              ${item.recurring ? '<span class="badge badge-recurring">Recurring</span>' : ''}
            </div>
          </div>
        </div>
        <div class="item-amount">${currency(item.amount)}</div>
        <div class="item-actions">
          ${receiptChip(item, 'spend')}
          <button class="confirm-btn" data-action="toggle" data-type="spend" data-id="${item.id}"
                  aria-pressed="${item.confirmed ? 'true' : 'false'}"
                  aria-label="${item.confirmed ? 'Unconfirm' : 'Confirm'} ${escapeHTML(item.title)}"
                  title="${item.confirmed ? 'Confirmed — tap to undo' : 'Confirm'}">${TICK_SVG}</button>
        </div>
      </div>
    `;
  }).join('');
}

function filterSpend(filter) {
  spendFilter = filter;
  renderPage();
}

// Month stepper, shared by Spend and Bills Due so both pages navigate
// identically. Spend and Due keep separate cursors, so this takes which one to
// move rather than reaching for a shared global.
function stepMonth(which, delta) {
  if (which === 'due') dueViewedDate.setMonth(dueViewedDate.getMonth() + delta);
  else viewedDate.setMonth(viewedDate.getMonth() + delta);
  renderPage();
}

// Due Page
async function renderDue(container) {
  const token = renderToken;
  await seedIfEmpty();
  
  const all = await getAll('due');
  all.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
  
  // The month view exists so a recurring bill's *next* occurrences are
  // visible — a bill is only ever stored with the date it's currently due,
  // so without stepping forward there was no way to see what the following
  // few months look like.
  const inMonth = all.filter(i => isSameMonth(i.dueDate, dueViewedDate));
  // Anything already past its date stays listed whatever month you're looking
  // at: it's still payable, and dropping it off the screen the moment you tap
  // ▶ is how a bill gets missed.
  const overdueElsewhere = all.filter(i => isOverdue(i.dueDate) && !isSameMonth(i.dueDate, dueViewedDate));
  const items = [...inMonth, ...overdueElsewhere].sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
  
  const total = items.reduce((sum, i) => sum + i.amount, 0);
  const overdue = items.filter(i => isOverdue(i.dueDate));
  const upcoming = inMonth.length - inMonth.filter(i => isOverdue(i.dueDate)).length;
  // What the month after the one on screen holds. A bill due next month is
  // genuinely not in this month's list, and without saying so it reads as
  // the bill having gone missing.
  const nextMonth = new Date(dueViewedDate.getFullYear(), dueViewedDate.getMonth() + 1, 1);
  const following = all.filter(i => isSameMonth(i.dueDate, nextMonth));
  const followingTotal = following.reduce((sum, i) => sum + i.amount, 0);
  
  if (token !== renderToken) return;
  container.innerHTML = `
    <div class="page-toolbar">
      <div class="month-nav">
        <button class="btn-icon" onclick="stepMonth('due', -1)" aria-label="Previous month">◀</button>
        <span class="month-label">${formatMonth(dueViewedDate)}</span>
        <button class="btn-icon" onclick="stepMonth('due', 1)" aria-label="Next month">▶</button>
      </div>
      <button class="btn btn-primary" onclick="openAddModal('due')">+ Add Bill</button>
    </div>
    
    <div class="stat-card" style="margin-bottom: 20px; ${overdue.length > 0 ? 'border-color: var(--danger);' : ''}">
      <div class="stat-card-header">
        <span class="stat-card-title">Total Due</span>
        <span class="stat-card-sub">${items.length} item${items.length === 1 ? '' : 's'}</span>
      </div>
      <div class="stat-card-value" style="color: ${overdue.length > 0 ? 'var(--danger)' : 'var(--text-primary)'}">${currency(total)}</div>
      ${overdue.length > 0
        ? `<div class="stat-card-sub" style="color: var(--danger);">${overdue.length} overdue</div>`
        : `<div class="stat-card-sub">${upcoming > 0 ? 'Nothing overdue' : 'Nothing due this month'}</div>`}
      ${overdueElsewhere.length > 0
        ? `<div class="stat-card-sub">Includes ${overdueElsewhere.length} overdue from an earlier month</div>` : ''}
      ${following.length > 0
        ? `<div class="stat-card-sub">${escapeHTML(formatMonth(nextMonth))}: ${currency(followingTotal)} · ${following.length} bill${following.length === 1 ? '' : 's'} — tap ▶</div>`
        : ''}
    </div>
    
    <div class="item-list">
      ${items.length === 0 ? `
        <div class="empty-state">
          <div class="empty-state-text">${all.length > 0 ? 'Nothing due this month' : 'No bills due'}</div>
          ${all.length > 0
            ? '<p class="setting-hint" style="margin-bottom: 20px;">Use ◀ ▶ to see other months</p>'
            : '<button class="btn btn-primary" onclick="openAddModal(\'due\')">Add First Bill</button>'}
        </div>
      ` : items.map(item => {
        const days = daysUntil(item.dueDate);
        const isOverdueItem = days < 0;
        return `
          <div class="item-row" data-edit-type="due" data-edit-id="${item.id}" style="${isOverdueItem ? 'border-color: var(--danger);' : ''}">
            <div class="item-row-main">
              <div class="item-info">
                <div class="item-title">${escapeHTML(item.title)}</div>
                <div class="item-meta">
                  Due ${formatDate(item.dueDate)} · ${escapeHTML(item.category)}
                  ${item.recurring ? '<span class="badge badge-recurring">Recurring</span>' : ''}
                </div>
              </div>
            </div>
            <div style="text-align: right;">
              <div class="item-amount">${currency(item.amount)}</div>
              <div class="stat-card-sub">${dueCountdown(item.dueDate)}</div>
            </div>
            <div class="item-actions">
              ${receiptChip(item, 'due')}
              <button class="confirm-btn" data-action="paid" data-type="due" data-id="${item.id}"
                      aria-pressed="false" aria-label="Mark ${escapeHTML(item.title)} as paid" title="Mark as paid">${TICK_SVG}</button>
            </div>
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
        return `
          <div class="item-row" data-edit-type="savings" data-edit-id="${item.id}">
            <div class="item-row-main">
              <div class="item-info">
                <div class="item-title">${escapeHTML(item.title)}</div>
                <div class="item-meta">${escapeHTML(item.category)} · ${goalPct}% complete</div>
              </div>
            </div>
            <div style="text-align: right; min-width: 150px;">
              <div class="item-amount" style="color: var(--success)">${currency(item.current)}</div>
              <div class="stat-card-sub">of ${currency(item.target)}</div>
              <div class="stat-card-progress" style="margin-top: 8px;">
                <div class="stat-card-progress-fill progress-savings" style="width: ${goalPct}%"></div>
              </div>
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
        ${renderReportBreakdown(groupByCategory(rangedSpend, 'amount'), totalSpend)}
      </div>
      
      <div class="report-card">
        <h2 class="report-title">Bills by Category</h2>
        ${renderReportBreakdown(groupByCategory(rangedDue, 'amount'), totalDue)}
      </div>
      
      <div class="report-card">
        <h2 class="report-title">Summary</h2>
        <div style="margin-top: 10px;">
          <div class="kv-row">
            <span class="kv-name">Total Spent</span>
            <span class="kv-value">${currency(totalSpend)}</span>
          </div>
          <div class="kv-row">
            <span class="kv-name">Total Due</span>
            <span class="kv-value">${currency(totalDue)}</span>
          </div>
          <div class="kv-row">
            <span class="kv-name">Total Saved</span>
            <span class="kv-value" style="color: var(--success)">${currency(totalSavings)}</span>
          </div>
        </div>
      </div>
    </div>
  `;
}

function setReportRange(range) {
  reportRange = range;
  renderPage();
}

function renderReportBreakdown(totals, grandTotal) {
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
          <div class="category-bar-fill" style="width: ${pct}%"></div>
        </div>
        <span class="category-amount">${currency(amt)}</span>
      </div>
    `;
  }).join('');
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
            <div class="setting-hint">System follows your device setting</div>
          </div>
          <div class="setting-control">
            ${themeSegment()}
          </div>
        </div>
      </div>

      <div class="report-card">
        <h2 class="report-title">Passcode</h2>
        <p style="color: var(--text-secondary); font-size: 0.85rem; margin-bottom: 15px;">
          Locks the app on launch and after a period of inactivity. Your data stays
          on this device either way — this only keeps the app closed when you're
          not using it.
        </p>
        ${passcodeSettings()}
      </div>

      <div class="report-card">
        <h2 class="report-title">Data Management</h2>
        <p style="color: var(--text-secondary); margin-bottom: 15px;">Export or import your financial data</p>
        <button class="btn btn-primary" onclick="handleExport()" style="width: 100%; margin-bottom: 10px;">Export Data</button>
        <button class="btn btn-ghost" onclick="handleImport()" style="width: 100%;">Import Data</button>
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

function themeSegment() {
  const pref = getThemePreference();
  const opt = (value, label) =>
    `<button class="segmented-option ${pref === value ? 'active' : ''}" onclick="setThemePreference('${value}')">${label}</button>`;
  return `<div class="segmented">${opt('light', 'Light')}${opt('dark', 'Dark')}${opt('system', 'System')}</div>`;
}

function passcodeSettings() {
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
    `;
  }

  return `
    <div class="setting-row">
      <div class="setting-text">
        <div class="setting-label">Passcode on</div>
        <div class="setting-hint">Tap to remove</div>
      </div>
      <div class="setting-control">
        <button class="switch" role="switch" aria-checked="true" aria-label="Remove passcode"
                onclick="confirmRemovePasscode(this)"></button>
      </div>
    </div>
    <div class="setting-block">
      <div class="setting-row">
        <div class="setting-text">
          <div class="setting-label">Lock after</div>
          <div class="setting-hint">Of no use — the app re-locks itself</div>
        </div>
        <div class="setting-control">
          <select class="form-input" id="lock-timeout" style="width: auto;" onchange="setLockTimeoutMinutes(Number(this.value))">
            ${LOCK_TIMEOUTS.map(t => `<option value="${t.value}" ${t.value === getLockTimeoutMinutes() ? 'selected' : ''}>${t.label}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="setting-row">
        <div class="setting-text">
          <div class="setting-label">Lock now</div>
          <div class="setting-hint">Test it, or lock the phone down now</div>
        </div>
        <div class="setting-control">
          <button class="btn btn-ghost" onclick="lockApp()">Lock</button>
        </div>
      </div>
    </div>
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
  showToast('Passcode removed');
  renderPage();
}

// Modal Forms
function buildForm(type, editId = null) {
  const saveCall = editId == null
    ? `saveItem('${type}')`
    : `saveItem('${type}', ${editId})`;
  // The receipt panel is a live region app.js fills in — it needs to exist in
  // both add and edit mode, since a stored receipt can be viewed, replaced or
  // removed after the entry is saved.
  const receiptHtml = (type === 'spend' || type === 'due') ? `
      <div class="receipt-panel" id="receipt-panel"></div>` : '';
  const deleteBtn = editId == null ? '' : `
      <button class="btn btn-danger" style="width: 100%; margin-top: 10px;" onclick="deleteItemFromModal('${type}', ${editId}, this)">Delete</button>`;
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
            <option value="Utilities">Utilities</option>
            <option value="Motor">Motor</option>
            <option value="Entertainment">Entertainment</option>
            <option value="Food">Food</option>
            <option value="Health">Health</option>
            <option value="Shopping">Shopping</option>
            <option value="General">General</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Recurring</label>
          <select class="form-input" id="form-recurring">
            <option value="false">No</option>
            <option value="true">Yes</option>
          </select>
        </div>
      </div>
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
            <option value="Mortgage">Mortgage</option>
            <option value="Utilities">Utilities</option>
            <option value="Motor">Motor</option>
            <option value="Entertainment">Entertainment</option>
            <option value="General">General</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Recurring</label>
          <select class="form-input" id="form-recurring">
            <option value="false">No</option>
            <option value="true">Yes</option>
          </select>
        </div>
      </div>
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
          <option value="Holiday">Holiday</option>
          <option value="Car">Car</option>
          <option value="General">General</option>
        </select>
      </div>
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
  openModal(`Edit ${type.charAt(0).toUpperCase() + type.slice(1)}`, buildForm(type, id));
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
  if (recurring && item.recurring !== undefined) recurring.value = String(item.recurring);
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
  const recurring = document.getElementById('form-recurring')?.value === 'true';

  if (!title) {
    showFormError('Please enter a title', 'form-title');
    return;
  }

  const fields = { title, category };
  if (type !== 'savings') fields.recurring = recurring;
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
  await markDuePaid(item);
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
    const id = Number(action.dataset.id);
    if (action.dataset.action === 'toggle') toggleConfirm(action.dataset.type, id);
    else if (action.dataset.action === 'paid') markPaid(id);
    else if (action.dataset.action === 'receipt') viewItemReceipt(action.dataset.type, id);
    else if (action.dataset.action === 'edit-receipt') openEditModal(action.dataset.type, id);
    return;
  }
  const row = e.target.closest('[data-edit-id]');
  if (row) openEditModal(row.dataset.editType, Number(row.dataset.editId));
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
renderPage();
