// Sorted v2 - Utility Functions

function currency(amount) {
  return '£' + amount.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
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


function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}
