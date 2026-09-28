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
  // Date-only: a bill is overdue the day AFTER it was due. Comparing
  // against the current time made every bill due today read as overdue
  // on the dashboard while the Bills page said "Due today" — both now
  // normalise to local midnight like daysUntil() does.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate);
  due.setHours(0, 0, 0, 0);
  return due < today;
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

// Load a classic script on demand, once, however many callers ask. Tesseract
// (63KB) and pdf.js (320KB) are two thirds of the payload and neither is
// needed to draw a screen, so they are fetched when a receipt is actually
// picked rather than on every page load — which held up the first paint
// (LCP sat around 4s against a 0.9s FCP).
//
// `defer` on a <script> tag was not enough on its own: deferred scripts still
// run in order, so app.js waited on the vendor bundles regardless. Dedupe
// matters because isPDF() is called on every picked file and a user can pick
// two receipts before the first has finished loading.
const scriptLoads = new Map();

function loadScriptOnce(src) {
  if (scriptLoads.has(src)) return scriptLoads.get(src);
  const promise = new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => {
      // Don't cache the failure: a retry after a flaky connection should work.
      scriptLoads.delete(src);
      reject(new Error('could not load ' + src));
    };
    document.head.appendChild(el);
  });
  scriptLoads.set(src, promise);
  return promise;
}
