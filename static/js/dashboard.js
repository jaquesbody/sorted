/* =============================================================================
   dashboard.js
   Reads spend/due/savings from IndexedDB, computes the dashboard's real
   numbers and category breakdowns, renders them into the existing markup.
   Depends on: db.js, utils.js
   ============================================================================= */

function groupByCategory(items, amountKey) {
  const totals = {};
  items.forEach((item) => {
    totals[item.category] = (totals[item.category] || 0) + item[amountKey];
  });
  return totals;
}

function renderCategoryBreakdown(containerEl, totals, grandTotal, emptyText) {
  containerEl.innerHTML = '';
  const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);

  if (entries.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'category-empty';
    empty.textContent = emptyText;
    containerEl.appendChild(empty);
    return;
  }

  entries.forEach(([category, amount]) => {
    const pct = grandTotal > 0 ? Math.round((amount / grandTotal) * 100) : 0;
    const row = document.createElement('div');
    row.className = 'category-row';
    row.innerHTML = `
      <span class="category-name">${category}</span>
      <div class="category-bar-track"><div class="category-bar-fill" style="width:${pct}%"></div></div>
      <span class="category-amount">${currency(amount)}</span>
    `;
    containerEl.appendChild(row);
  });
}

async function renderDashboard() {
  await seedIfEmpty();

  const [spendItems, dueItems, savingsItems] = await Promise.all([
    getAll('spend'),
    getAll('due'),
    getAll('savings'),
  ]);

  /* --- Spend --- */
  const spendMonth = spendItems.filter((i) => isThisMonth(i.date));
  const spendYear = spendItems.filter((i) => isThisYear(i.date));
  const spendMonthTotal = spendMonth.reduce((sum, i) => sum + i.amount, 0);
  const spendYearTotal = spendYear.reduce((sum, i) => sum + i.amount, 0);

  document.getElementById('spend-total').textContent = currency(spendMonthTotal);
  document.getElementById('spend-annual').textContent = currency(spendYearTotal) + ' this year';
  renderCategoryBreakdown(
    document.getElementById('spend-categories'),
    groupByCategory(spendMonth, 'amount'),
    spendMonthTotal,
    'No spend this month'
  );

  /* --- Due --- */
  const dueTotal = dueItems.reduce((sum, i) => sum + i.amount, 0);

  document.getElementById('due-total').textContent = currency(dueTotal);
  document.getElementById('due-next').textContent = dueItems.length === 1
    ? '1 item due'
    : `${dueItems.length} items due`;
  renderCategoryBreakdown(
    document.getElementById('due-categories'),
    groupByCategory(dueItems, 'amount'),
    dueTotal,
    'No items due'
  );

  /* --- Savings --- */
  const savingsCurrentTotal = savingsItems.reduce((sum, i) => sum + i.current, 0);
  const savingsTargetTotal = savingsItems.reduce((sum, i) => sum + i.target, 0);
  const savingsPct = savingsTargetTotal > 0
    ? Math.round((savingsCurrentTotal / savingsTargetTotal) * 100)
    : 0;

  document.getElementById('savings-total').textContent = currency(savingsCurrentTotal);
  document.getElementById('savings-target').textContent =
    `${savingsPct}% of £${savingsTargetTotal.toLocaleString()} target`;
  document.querySelector('.savings-progress-fill').style.width = savingsPct + '%';
}

document.addEventListener('DOMContentLoaded', () => {
  renderDashboard();

  document.querySelectorAll('.card-add-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.location.href = `item.html?type=${btn.dataset.addType}`;
    });
  });

  document.querySelectorAll('.metric-card-body').forEach((body) => {
    body.addEventListener('click', () => {
      window.location.href = body.dataset.nav;
    });
  });
});
