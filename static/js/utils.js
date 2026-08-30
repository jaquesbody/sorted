/* =============================================================================
   utils.js
   Shared helpers used across dashboard.js, spend.js, due.js, savings.js
   ============================================================================= */

function currency(n) {
  return '£' + n.toFixed(2);
}

function isThisMonth(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
}

function isThisYear(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  return d.getFullYear() === now.getFullYear();
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function isSameMonth(dateStr, refDate) {
  const d = new Date(dateStr);
  return d.getFullYear() === refDate.getFullYear() && d.getMonth() === refDate.getMonth();
}

function isSameYear(dateStr, refDate) {
  const d = new Date(dateStr);
  return d.getFullYear() === refDate.getFullYear();
}

function monthLabel(refDate) {
  return refDate.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}
