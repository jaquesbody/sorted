// Sorted v2 - Utility Functions

function currency(amount) {
  const n = Number(amount);
  return '£' + (Number.isFinite(n) ? n : 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatDate(dateStr) {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatMonth(date) {
  return date.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

function isThisMonth(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  return date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();
}

function isThisYear(dateStr) {
  const date = new Date(dateStr);
  return date.getFullYear() === new Date().getFullYear();
}

function isSameMonth(dateStr, targetDate) {
  const date = new Date(dateStr);
  return date.getMonth() === targetDate.getMonth() && date.getFullYear() === targetDate.getFullYear();
}

function isSameYear(dateStr, targetDate) {
  const date = new Date(dateStr);
  return date.getFullYear() === targetDate.getFullYear();
}

function isOverdue(dueDate) {
  return new Date(dueDate) < new Date();
}

function daysUntil(dueDate) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate);
  due.setHours(0, 0, 0, 0);
  return Math.ceil((due - today) / (1000 * 60 * 60 * 24));
}


// Local-date YYYY-MM-DD (toISOString() is UTC — wrong "today" between
// 00:00 and 01:00 in BST).
function localISO(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Escape a value for safe interpolation into HTML text or attributes.
function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}
