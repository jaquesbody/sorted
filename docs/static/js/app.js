// Sorted v2 - Main Application

let currentPage = 'dashboard';
let viewedDate = new Date();
viewedDate.setDate(1);

// Navigation
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    item.classList.add('active');
    currentPage = item.dataset.page;
    renderPage();
  });
});

// Modal
const modal = document.getElementById('modal');
const modalTitle = document.getElementById('modal-title');
const modalBody = document.getElementById('modal-body');
const modalClose = document.getElementById('modal-close');

modalClose.addEventListener('click', () => modal.classList.remove('active'));
modal.addEventListener('click', (e) => {
  if (e.target === modal) modal.classList.remove('active');
});

function openModal(title, content) {
  modalTitle.textContent = title;
  modalBody.innerHTML = content;
  modal.classList.add('active');
}

// Export/Import
if (window.require) {
  const { ipcRenderer } = window.require('electron');

  document.getElementById('export-btn').addEventListener('click', async () => {
    await ipcRenderer.invoke('export-data');
  });

  document.getElementById('import-btn').addEventListener('click', async () => {
    const res = await ipcRenderer.invoke('import-data');
    if (res && res.error) showToast(res.error);
  });

  // Main process sends the parsed backup contents after the file dialog.
  ipcRenderer.on('sorted:import', (event, data) => {
    finishImport(data);
  });
}

// Page Rendering
async function renderPage() {
  const content = document.getElementById('content');
  
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
  
  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Dashboard</h1>
    </div>
    
    <div class="dashboard-grid">
      <div class="stat-card" onclick="currentPage='spend'; renderPage();">
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
      
      <div class="stat-card" onclick="currentPage='due'; renderPage();">
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
      
      <div class="stat-card" onclick="currentPage='savings'; renderPage();">
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
        <h3 class="chart-title">Monthly Trend</h3>
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
            <span class="category-name">${cat}</span>
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
  
  const ctx = canvas.getContext('2d');
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
  const barWidth = canvas.width / months.length - 10;
  
  ctx.fillStyle = '#2a2a32';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  
  months.forEach((m, i) => {
    const height = (m.total / max) * (canvas.height - 40);
    const x = i * (barWidth + 10) + 5;
    const y = canvas.height - height - 20;
    
    ctx.fillStyle = '#3d8bfd';
    ctx.fillRect(x, y, barWidth, height);
    
    ctx.fillStyle = '#8b8b96';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(m.label, x + barWidth / 2, canvas.height - 5);
    ctx.fillText(currency(m.total), x + barWidth / 2, y - 5);
  });
}

// Spend Page
async function renderSpend(container) {
  await seedIfEmpty();
  
  const items = await getAll('spend');
  items.sort((a, b) => new Date(b.date) - new Date(a.date));
  
  const monthItems = items.filter(i => isSameMonth(i.date, viewedDate));
  const yearItems = items.filter(i => isSameYear(i.date, viewedDate));
  const monthTotal = monthItems.reduce((sum, i) => sum + i.amount, 0);
  const yearTotal = yearItems.reduce((sum, i) => sum + i.amount, 0);
  
  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Spend</h1>
      <button class="btn btn-primary" onclick="openAddModal('spend')">+ Add Spend</button>
    </div>
    
    <div class="month-nav">
      <button class="btn-icon" onclick="viewedDate.setMonth(viewedDate.getMonth() - 1); renderPage();">◀</button>
      <span class="month-label">${formatMonth(viewedDate)}</span>
      <button class="btn-icon" onclick="viewedDate.setMonth(viewedDate.getMonth() + 1); renderPage();">▶</button>
    </div>
    
    <div class="stat-card" style="margin-bottom: 20px;">
      <div class="stat-card-header">
        <span class="stat-card-title">Monthly Total</span>
        <span class="stat-card-sub">Year: ${currency(yearTotal)}</span>
      </div>
      <div class="stat-card-value">${currency(monthTotal)}</div>
    </div>
    
    <div class="filter-bar">
      <span class="filter-chip active" onclick="filterSpend('all', this)">All</span>
      <span class="filter-chip" onclick="filterSpend('confirmed', this)">Confirmed</span>
      <span class="filter-chip" onclick="filterSpend('pending', this)">Pending</span>
      <span class="filter-chip" onclick="filterSpend('recurring', this)">Recurring</span>
    </div>
    
    <div class="item-list" id="spend-list">
      ${renderSpendItems(monthItems, monthTotal)}
    </div>
  `;
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
      <div class="item-row" onclick="openEditModal('spend', ${item.id})">
        <div class="item-row-main">
          <div class="item-info">
            <div class="item-title">${item.title}</div>
            <div class="item-meta">
              ${formatDate(item.date)} · ${item.category}
              ${item.recurring ? '<span class="badge badge-recurring">Recurring</span>' : ''}
            </div>
          </div>
        </div>
        <div class="item-amount">${currency(item.amount)}</div>
        <div class="item-actions">
          <button class="btn-icon" onclick="event.stopPropagation(); toggleConfirm('spend', ${JSON.stringify(item).replace(/"/g, '&quot;')})" title="${item.confirmed ? 'Confirmed' : 'Confirm'}">
            ${item.confirmed ? '✓' : '○'}
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function filterSpend(filter, chip) {
  document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
  chip.classList.add('active');
  // Re-render with filter (simplified)
  renderPage();
}

// Due Page
async function renderDue(container) {
  await seedIfEmpty();
  
  const items = await getAll('due');
  items.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
  
  const total = items.reduce((sum, i) => sum + i.amount, 0);
  const overdue = items.filter(i => isOverdue(i.dueDate));
  
  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Bills Due</h1>
      <button class="btn btn-primary" onclick="openAddModal('due')">+ Add Bill</button>
    </div>
    
    <div class="stat-card" style="margin-bottom: 20px; ${overdue.length > 0 ? 'border-color: var(--danger);' : ''}">
      <div class="stat-card-header">
        <span class="stat-card-title">Total Due</span>
        <span class="stat-card-sub">${items.length} items</span>
      </div>
      <div class="stat-card-value" style="color: ${overdue.length > 0 ? 'var(--danger)' : 'var(--text-primary)'}">${currency(total)}</div>
      ${overdue.length > 0 ? `<div class="stat-card-sub" style="color: var(--danger);">${overdue.length} overdue</div>` : ''}
    </div>
    
    <div class="item-list">
      ${items.length === 0 ? `
        <div class="empty-state">
          <div class="empty-state-text">No bills due</div>
          <button class="btn btn-primary" onclick="openAddModal('due')">Add First Bill</button>
        </div>
      ` : items.map(item => {
        const days = daysUntil(item.dueDate);
        const overdue = days < 0;
        return `
          <div class="item-row" onclick="openEditModal('due', ${item.id})" style="${overdue ? 'border-color: var(--danger);' : ''}">
            <div class="item-row-main">
              <div class="item-info">
                <div class="item-title">${item.title}</div>
                <div class="item-meta">
                  Due ${formatDate(item.dueDate)} · ${item.category}
                  ${item.recurring ? '<span class="badge badge-recurring">Recurring</span>' : ''}
                </div>
              </div>
            </div>
            <div style="text-align: right;">
              <div class="item-amount">${currency(item.amount)}</div>
              <div class="stat-card-sub" style="color: ${overdue ? 'var(--danger)' : days <= 7 ? 'var(--warning)' : 'var(--text-secondary)'}">
                ${overdue ? Math.abs(days) + ' days overdue' : days === 0 ? 'Due today' : days + ' days'}
              </div>
            </div>
            <div class="item-actions">
              <button class="btn-icon" onclick="event.stopPropagation(); markPaid(${JSON.stringify(item).replace(/"/g, '&quot;')})" title="Mark as Paid">✓</button>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

// Savings Page
async function renderSavings(container) {
  await seedIfEmpty();
  
  const items = await getAll('savings');
  const totalCurrent = items.reduce((sum, i) => sum + i.current, 0);
  const totalTarget = items.reduce((sum, i) => sum + i.target, 0);
  const pct = totalTarget > 0 ? Math.round((totalCurrent / totalTarget) * 100) : 0;
  
  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Savings</h1>
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
          <div class="item-row" onclick="openEditModal('savings', ${item.id})">
            <div class="item-row-main">
              <div class="item-info">
                <div class="item-title">${item.title}</div>
                <div class="item-meta">${item.category} · ${goalPct}% complete</div>
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
  const [spendItems, dueItems, savingsItems] = await Promise.all([
    getAll('spend'),
    getAll('due'),
    getAll('savings')
  ]);
  
  const totalSpend = spendItems.reduce((sum, i) => sum + i.amount, 0);
  const totalDue = dueItems.reduce((sum, i) => sum + i.amount, 0);
  const totalSavings = savingsItems.reduce((sum, i) => sum + i.current, 0);
  
  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Reports</h1>
    </div>
    
    <div class="reports-grid">
      <div class="report-card">
        <h3 class="report-title">Spending by Category</h3>
        ${renderReportBreakdown(groupByCategory(spendItems, 'amount'), totalSpend)}
      </div>
      
      <div class="report-card">
        <h3 class="report-title">Bills by Category</h3>
        ${renderReportBreakdown(groupByCategory(dueItems, 'amount'), totalDue)}
      </div>
      
      <div class="report-card">
        <h3 class="report-title">Summary</h3>
        <div style="margin-top: 10px;">
          <div class="category-row">
            <span class="category-name">Total Spent</span>
            <span class="category-amount">${currency(totalSpend)}</span>
          </div>
          <div class="category-row">
            <span class="category-name">Total Due</span>
            <span class="category-amount">${currency(totalDue)}</span>
          </div>
          <div class="category-row">
            <span class="category-name">Total Saved</span>
            <span class="category-amount" style="color: var(--success)">${currency(totalSavings)}</span>
          </div>
        </div>
      </div>
    </div>
  `;
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
        <span class="category-name">${cat}</span>
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
    <div class="page-header">
      <h1 class="page-title">Settings</h1>
    </div>
    
    <div class="reports-grid">
      <div class="report-card">
        <h3 class="report-title">Data Management</h3>
        <p style="color: var(--text-secondary); margin-bottom: 15px;">Export or import your financial data</p>
        <button class="btn btn-primary" onclick="exportData()" style="width: 100%; margin-bottom: 10px;">Export Data</button>
        <button class="btn btn-ghost" onclick="importData()" style="width: 100%;">Import Data</button>
      </div>
      
      <div class="report-card">
        <h3 class="report-title">About</h3>
        <p style="color: var(--text-secondary);">
          <strong>Sorted v2.0</strong><br>
          A modern finance tracker<br>
          All data stored locally<br>
          No cloud, no login required
        </p>
      </div>
    </div>
  `;
}

// Modal Forms
function buildForm(type, editId = null) {
  const saveCall = editId == null
    ? `saveItem('${type}')`
    : `saveItem('${type}', ${editId})`;
  // Receipt capture is add-only: a photo is taken when the entry is created,
  // not when it's edited (matches v1, which hid the capture link in edit mode).
  const receiptHtml = editId == null && (type === 'spend' || type === 'due') ? `
      <div class="receipt-row">
        <button type="button" class="btn btn-ghost" id="receipt-camera-btn">Take photo</button>
        <button type="button" class="btn btn-ghost" id="receipt-upload-btn">Upload file</button>
        <input type="file" id="receipt-camera-input" accept="image/*" capture="environment" hidden>
        <input type="file" id="receipt-upload-input" accept="image/*,application/pdf" hidden>
      </div>
      <p class="ocr-status" id="ocr-status" aria-live="polite"></p>` : '';
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
          <input type="date" class="form-input" id="form-date" value="${new Date().toISOString().slice(0, 10)}">
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
  openModal(`Add ${type.charAt(0).toUpperCase() + type.slice(1)}`, buildForm(type));
  if (type === 'spend' || type === 'due') setupReceiptCapture();
}

async function openEditModal(type, id) {
  const item = await getItem(type, id);
  if (!item) return;
  openModal(`Edit ${type.charAt(0).toUpperCase() + type.slice(1)}`, buildForm(type, id));
  prefillForm(item);
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

// Receipt capture — camera or file upload, OCR'd to pre-fill title/amount.
function setupReceiptCapture() {
  const cameraBtn = document.getElementById('receipt-camera-btn');
  const cameraInput = document.getElementById('receipt-camera-input');
  const uploadBtn = document.getElementById('receipt-upload-btn');
  const uploadInput = document.getElementById('receipt-upload-input');
  if (!cameraBtn) return;

  cameraBtn.addEventListener('click', () => cameraInput.click());
  uploadBtn.addEventListener('click', () => uploadInput.click());

  const handleChange = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (file) await ocrPrefill(file);
  };
  cameraInput.addEventListener('change', handleChange);
  uploadInput.addEventListener('change', handleChange);
}

async function ocrPrefill(file) {
  const status = document.getElementById('ocr-status');
  const titleEl = document.getElementById('form-title');
  const amountEl = document.getElementById('form-amount');
  if (!status) return;

  try {
    status.textContent = 'Reading receipt…';
    let image = file;
    if (typeof isPDF === 'function' && isPDF(file)) {
      status.textContent = 'Rendering PDF…';
      image = await pdfFirstPageToImageBlob(file);
      if (!image) throw new Error('could not render PDF');
    }
    const text = await runOCRWithTimeout(image, (msg) => { status.textContent = msg; });
    const title = guessTitleFromText(text);
    const amount = guessAmountFromText(text);
    if (!titleEl.value && title) titleEl.value = title;
    if (!amountEl.value && amount > 0) amountEl.value = amount;
    status.textContent = 'Done — check title and amount, then save.';
  } catch (err) {
    console.error('OCR failed:', err);
    status.textContent = 'Could not read that file — enter the details manually.';
  }
}

async function saveItem(type, editId = null) {
  const title = document.getElementById('form-title').value.trim();
  const amount = parseFloat(document.getElementById('form-amount')?.value || document.getElementById('form-current')?.value || 0);
  const target = parseFloat(document.getElementById('form-target')?.value || 0);
  const category = document.getElementById('form-category').value;
  const recurring = document.getElementById('form-recurring')?.value === 'true';
  
  if (!title) {
    alert('Please enter a title');
    return;
  }
  
  const fields = { title, category };
  if (type !== 'savings') fields.recurring = recurring;
  
  if (type === 'spend') {
    Object.assign(fields, { date: document.getElementById('form-date').value, amount });
  } else if (type === 'due') {
    Object.assign(fields, { dueDate: document.getElementById('form-dueDate').value, amount });
  } else {
    Object.assign(fields, { current: amount, target });
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
  
  modal.classList.remove('active');
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
  modal.classList.remove('active');
  renderPage();
}

async function toggleConfirm(type, item) {
  item.confirmed = !item.confirmed;
  await updateItem(type, item);
  renderPage();
}

async function markPaid(item) {
  await markDuePaid(item);
  renderPage();
}

async function exportData() {
  const data = await getAllData();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sorted-backup-${new Date().toISOString().slice(0, 10)}.json`;
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
  await finishImport(data);
}

async function finishImport(data) {
  try {
    const { imported } = await importDataToDB(data);
    showToast(`Imported ${imported} item${imported === 1 ? '' : 's'}`);
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

// Initialize
renderPage();
