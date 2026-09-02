/* =============================================================================
   due.js
   Renders the Due list from IndexedDB. Marking paid calls markDuePaid(),
   which creates the matching Spend entry and removes the Due entry — see
   db.js and project.md Architecture Decisions.
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

function payIconSVG() {
  return `<button type="button" class="icon-btn icon-btn--pay" aria-label="Mark as paid" aria-pressed="false">
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
  </button>`;
}

async function renderDueList() {
  await seedIfEmpty();

  const items = await getAll('due');
  items.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

  const dueTotal = items.reduce((sum, i) => sum + i.amount, 0);

  document.getElementById('due-total').textContent = currency(dueTotal);
  document.getElementById('due-count').textContent = items.length;

  const listEl = document.getElementById('due-list');
  listEl.innerHTML = '';

  if (items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'text-sm text-secondary';
    empty.style.padding = '1rem 0';
    empty.textContent = 'Nothing due.';
    listEl.appendChild(empty);
    return;
  }

  items.forEach((item) => {
    const pct = dueTotal > 0 ? Math.round((item.amount / dueTotal) * 100) : 0;
    const row = document.createElement('a');
    row.className = 'item-row';
    row.href = '#';
    row.dataset.itemId = item.id;
    row.innerHTML = `
      <div class="item-row-main">
        <div class="item-main">
          <span class="item-title">${item.title}</span>
          <span class="item-meta">due ${formatDate(item.dueDate)} · ${item.category}
            ${item.recurring ? recurringIconSVG() : ''}
          </span>
        </div>
        <div class="flex flex-col gap-1" style="align-items:flex-end;">
          <span class="item-amount">${currency(item.amount)}</span>
          <div class="item-badges">
            ${editIconSVG()}
            ${payIconSVG()}
          </div>
        </div>
      </div>
      <div class="item-progress-track"><div class="item-progress-fill" style="width:${pct}%"></div></div>
    `;
    listEl.appendChild(row);

    row.addEventListener('click', (e) => {
      e.preventDefault();

      if (e.target.closest('.icon-btn--pay')) {
        markDuePaid(item).then(renderDueList);
        return;
      }

      if (e.target.closest('.icon-btn--edit')) {
        window.location.href = `item.html?type=due&id=${item.id}`;
        return;
      }

      if (e.target.closest('.icon-btn--recurring')) {
        alert('Recurring spend');
        return;
      }

      window.location.href = `detail.html?type=due&id=${item.id}`;
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  renderDueList();
  document.getElementById('add-item').addEventListener('click', () => {
    window.location.href = 'item.html?type=due';
  });
});
