/* =============================================================================
   savings.js
   Renders the Savings list from IndexedDB.
   Depends on: db.js, utils.js
   ============================================================================= */

function editIconSVG() {
  return `<button type="button" class="icon-btn icon-btn--edit" aria-label="Edit item">
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
  </button>`;
}

async function renderSavingsList() {
  await seedIfEmpty();

  const items = await getAll('savings');
  items.sort((a, b) => a.title.localeCompare(b.title));

  const currentTotal = items.reduce((sum, i) => sum + i.current, 0);
  const targetTotal = items.reduce((sum, i) => sum + i.target, 0);

  document.getElementById('savings-total').textContent = currency(currentTotal);
  document.getElementById('savings-target').textContent =
    targetTotal > 0 ? `£${targetTotal.toLocaleString()}` : '£0';

  const listEl = document.getElementById('savings-list');
  listEl.innerHTML = '';

  if (items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'text-sm text-secondary';
    empty.style.padding = '1rem 0';
    empty.textContent = 'No savings goals yet.';
    listEl.appendChild(empty);
    return;
  }

  items.forEach((item) => {
    const pct = item.target > 0 ? Math.round((item.current / item.target) * 100) : 0;
    const row = document.createElement('a');
    row.className = 'item-row';
    row.href = '#';
    row.dataset.itemId = item.id;
    row.innerHTML = `
      <div class="item-row-main">
        <div class="item-main">
          <span class="item-title">${item.title}</span>
          <span class="item-meta">${currency(item.current)} of £${item.target.toLocaleString()} · ${pct}%</span>
        </div>
        <div class="flex flex-col gap-1" style="align-items:flex-end;">
          <span class="item-amount">${currency(item.current)}</span>
          <div class="item-badges">
            ${editIconSVG()}
          </div>
        </div>
      </div>
      <div class="item-progress-track"><div class="item-progress-fill" style="width:${pct}%"></div></div>
    `;
    listEl.appendChild(row);

    row.addEventListener('click', (e) => {
      e.preventDefault();

      if (e.target.closest('.icon-btn--edit')) {
        window.location.href = `item.html?type=savings&id=${item.id}`;
        return;
      }

      window.location.href = `detail.html?type=savings&id=${item.id}`;
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  renderSavingsList();
  document.getElementById('add-item').addEventListener('click', () => {
    window.location.href = 'item.html?type=savings';
  });
});
