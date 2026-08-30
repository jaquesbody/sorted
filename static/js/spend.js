/* =============================================================================
   spend.js
   Renders the Spend list from IndexedDB. Confirm toggle writes for real.
   Edit and item-detail are not built yet — placeholder alerts, not silent
   no-ops, so it's clear what does and doesn't work.
   Depends on: db.js, utils.js
   ============================================================================= */

function recurringIconSVG() {
  return `<button type="button" class="icon-btn icon-btn--recurring" title="Recurring spend" aria-label="Recurring spend">
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
  </button>`;
}

function editIconSVG() {
  return `<button type="button" class="icon-btn icon-btn--edit" aria-label="Edit item">
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
  </button>`;
}

function confirmIconSVG(confirmed) {
  return `<button type="button" class="icon-btn icon-btn--confirm ${confirmed ? 'is-confirmed' : ''}" aria-label="${confirmed ? 'Confirmed' : 'Not yet confirmed'}" aria-pressed="${confirmed}">
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
  </button>`;
}

let viewedDate = new Date();
viewedDate.setDate(1);

async function renderSpendList() {
  await seedIfEmpty();

  document.getElementById('month-label').textContent = monthLabel(viewedDate);

  const items = await getAll('spend');
  items.sort((a, b) => new Date(b.date) - new Date(a.date));

  const monthItems = items.filter((i) => isSameMonth(i.date, viewedDate));
  const yearItems = items.filter((i) => isSameYear(i.date, viewedDate));
  const monthTotal = monthItems.reduce((sum, i) => sum + i.amount, 0);
  const yearTotal = yearItems.reduce((sum, i) => sum + i.amount, 0);

  document.getElementById('spend-total').textContent = currency(monthTotal);
  document.getElementById('spend-annual').textContent = currency(yearTotal);

  const listEl = document.getElementById('spend-list');
  listEl.innerHTML = '';

  if (monthItems.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'text-sm text-secondary';
    empty.style.padding = '1rem 0';
    empty.textContent = 'No spend recorded for this month.';
    listEl.appendChild(empty);
    return;
  }

  monthItems.forEach((item) => {
    const pct = monthTotal > 0 ? Math.round((item.amount / monthTotal) * 100) : 0;
    const row = document.createElement('a');
    row.className = 'item-row';
    row.href = '#';
    row.dataset.itemId = item.id;
    row.innerHTML = `
      <div class="item-row-main">
        <div class="item-main">
          <span class="item-title">${item.title}</span>
          <span class="item-meta">${formatDate(item.date)} · ${item.category}
            ${item.recurring ? recurringIconSVG() : ''}
          </span>
        </div>
        <div class="flex flex-col gap-1" style="align-items:flex-end;">
          <span class="item-amount">${currency(item.amount)}</span>
          <div class="item-badges">
            ${editIconSVG()}
            ${confirmIconSVG(item.confirmed)}
          </div>
        </div>
      </div>
      <div class="item-progress-track"><div class="item-progress-fill" style="width:${pct}%"></div></div>
    `;
    listEl.appendChild(row);

    row.addEventListener('click', (e) => {
      e.preventDefault();

      if (e.target.closest('.icon-btn--confirm')) {
        item.confirmed = !item.confirmed;
        updateItem('spend', item).then(renderSpendList);
        return;
      }

      if (e.target.closest('.icon-btn--edit')) {
        window.location.href = `item.html?type=spend&id=${item.id}`;
        return;
      }

      if (e.target.closest('.icon-btn--recurring')) {
        alert('Recurring spend');
        return;
      }

      alert('Item detail view not built yet — coming in a later task.');
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  renderSpendList();

  document.getElementById('add-item').addEventListener('click', () => {
    window.location.href = 'item.html?type=spend';
  });

  document.getElementById('prev-month-btn').addEventListener('click', () => {
    viewedDate.setMonth(viewedDate.getMonth() - 1);
    renderSpendList();
  });

  document.getElementById('next-month-btn').addEventListener('click', () => {
    viewedDate.setMonth(viewedDate.getMonth() + 1);
    renderSpendList();
  });
});
