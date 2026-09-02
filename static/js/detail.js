/* =============================================================================
   detail.js
   Reads a single item from IndexedDB and renders whatever fields it
   actually has. No fabricated content — fields that don't apply to a
   given type simply aren't shown.
   ============================================================================= */

const LIST_PAGE = { spend: 'spend.html', due: 'due.html', savings: 'savings.html' };

const params = new URLSearchParams(window.location.search);
const type = params.get('type') || 'spend';
const id = Number(params.get('id'));

function addRow(container, label, value) {
  const row = document.createElement('div');
  row.className = 'detail-row';
  row.innerHTML = `
    <span class="detail-row-label">${label}</span>
    <span class="detail-row-value">${value}</span>
  `;
  container.appendChild(row);
}

async function loadItem() {
  document.getElementById('back-link').href = LIST_PAGE[type];
  document.getElementById('edit-link').href = `item.html?type=${type}&id=${id}`;

  const items = await getAll(type);
  const item = items.find((i) => i.id === id);

  if (!item) {
    document.getElementById('detail-title').textContent = 'Item not found';
    return;
  }

  document.getElementById('page-title').textContent =
    type.charAt(0).toUpperCase() + type.slice(1);
  document.getElementById('detail-title').textContent = item.title;

  const rowsEl = document.getElementById('detail-rows');
  rowsEl.innerHTML = '';

  if (type === 'spend') {
    document.getElementById('detail-amount').textContent = currency(item.amount);
    addRow(rowsEl, 'Date', formatDate(item.date));
    addRow(rowsEl, 'Category', item.category);
    addRow(rowsEl, 'Recurring', item.recurring ? `Yes — ${item.frequency}` : 'No');
    addRow(rowsEl, 'Confirmed', item.confirmed ? 'Yes' : 'No — amount not verified');
    addRow(rowsEl, 'Paid', item.paid ? 'Yes' : 'No');
  }

  if (type === 'due') {
    document.getElementById('detail-amount').textContent = currency(item.amount);
    addRow(rowsEl, 'Due date', formatDate(item.dueDate));
    addRow(rowsEl, 'Category', item.category);
    addRow(rowsEl, 'Recurring', item.recurring ? `Yes — ${item.frequency}` : 'No');
    document.getElementById('mark-paid-btn').style.display = '';
    document.getElementById('mark-paid-btn').addEventListener('click', async () => {
      await markDuePaid(item);
      window.location.href = 'due.html';
    });
  }

  if (type === 'savings') {
    document.getElementById('detail-amount').textContent = currency(item.current);
    addRow(rowsEl, 'Target', `£${item.target.toLocaleString()}`);
    addRow(rowsEl, 'Category', item.category);
    const pct = item.target > 0 ? Math.round((item.current / item.target) * 100) : 0;
    addRow(rowsEl, 'Progress', `${pct}%`);
  }

  document.getElementById('delete-btn').addEventListener('click', async () => {
    if (!confirm(`Delete "${item.title}"? This can't be undone.`)) return;
    await deleteItem(type, id);
    window.location.href = LIST_PAGE[type];
  });
}

document.addEventListener('DOMContentLoaded', loadItem);
