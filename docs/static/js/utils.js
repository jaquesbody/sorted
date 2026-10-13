// Sorted v2 - Utility Functions

/* Currency
   The stored figures are plain numbers and always were — nothing about them
   depends on the symbol, so changing this never touches a row or needs a
   migration. The code stays in whatever it was entered as and only the display
   changes.
   ------------------------------------------------------------------------ */

// A deliberately ordinary set: the currencies people actually hold a budget in.
// Anything not here can still be reached by storing the code, and the formatter
// below handles any three-letter code it is given.
const CURRENCIES = [
  ['GBP', '£ Pound sterling'],
  ['EUR', '€ Euro'],
  ['USD', '$ US dollar'],
  ['CAD', '$ Canadian dollar'],
  ['AUD', '$ Australian dollar'],
  ['NZD', '$ New Zealand dollar'],
  ['CHF', '₣ Swiss franc'],
  ['SEK', 'kr Swedish krona'],
  ['NOK', 'kr Norwegian krone'],
  ['DKK', 'kr Danish krone'],
  ['ISK', 'kr Icelandic króna'],
  ['PLN', 'zł Polish złoty'],
  ['CZK', 'Kč Czech koruna'],
  ['HUF', 'Ft Hungarian forint'],
  ['RON', 'lei Romanian leu'],
  ['BGN', 'лв Bulgarian lev'],
  ['TRY', '₺ Turkish lira'],
  ['RUB', '₽ Russian ruble'],
  ['UAH', '₴ Ukrainian hryvnia'],
  ['INR', '₹ Indian rupee'],
  ['PKR', '₨ Pakistani rupee'],
  ['BDT', '৳ Bangladeshi taka'],
  ['LKR', 'Rs Sri Lankan rupee'],
  ['IDR', 'Rp Indonesian rupiah'],
  ['MYR', 'RM Malaysian ringgit'],
  ['SGD', '$ Singapore dollar'],
  ['HKD', '$ Hong Kong dollar'],
  ['CNY', '¥ Chinese yuan'],
  ['JPY', '¥ Japanese yen'],
  ['KRW', '₩ South Korean won'],
  ['THB', '฿ Thai baht'],
  ['PHP', '₱ Philippine peso'],
  ['VND', '₫ Vietnamese dong'],
  ['AED', 'د.إ UAE dirham'],
  ['SAR', '﷼ Saudi riyal'],
  ['ILS', '₪ Israeli shekel'],
  ['ZAR', 'R South African rand'],
  ['NGN', '₦ Nigerian naira'],
  ['KES', 'KSh Kenyan shilling'],
  ['EGP', 'E£ Egyptian pound'],
  ['MAD', 'د.م Moroccan dirham'],
  ['ARS', '$ Argentine peso'],
  ['CLP', '$ Chilean peso'],
  ['COP', '$ Colombian peso'],
  ['PEN', 'S/ Peruvian sol'],
  ['UYU', '$U Uruguayan peso'],
  ['BRL', 'R$ Brazilian real'],
];

const CURRENCY_KEY = 'sorted-currency';

function getCurrencyCode() {
  try {
    const code = localStorage.getItem(CURRENCY_KEY);
    if (code && /^[A-Z]{3}$/.test(code)) return code;
  } catch (err) { /* storage disabled; pounds below */ }
  return 'GBP';
}

function setCurrencyCode(code) {
  const clean = String(code || '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(clean)) return false;
  try {
    localStorage.setItem(CURRENCY_KEY, clean);
  } catch (err) {
    return false;
  }
  // Anything already on screen is showing the old symbol.
  if (typeof renderPage === 'function') renderPage();
  return true;
}

// Cached: formatting runs once per visible row and building an Intl formatter is
// not free, so a page with two hundred amounts should build it once.
let currencyFormatter = null;
let currencyFormatterCode = null;

// Six currencies whose symbols Intl has no data for, so it prints the ISO code
// instead — which is how 32 of the 47 read "CHF 12.00" rather than a symbol.
// `currencyDisplay: 'narrowSymbol'` fixes the other 26 and drops the region
// prefixes ("US$" -> "$"), so only these are left to supply by hand.
//
// The Swiss franc is deliberately absent: it has no symbol of its own, so
// "CHF" is the correct rendering and inventing one would be worse.
const CURRENCY_SYMBOLS = {
  BGN: 'лв',   // Bulgarian lev
  AED: 'د.إ',  // UAE dirham
  SAR: 'ر.س',  // Saudi riyal
  KES: 'KSh',  // Kenyan shilling
  MAD: 'د.م.', // Moroccan dirham
  PEN: 'S/'   // Peruvian sol
};

function currencyFormatterFor(code) {
  if (currencyFormatter && currencyFormatterCode === code) return currencyFormatter;
  // narrowSymbol first, then the plain form for a WebView whose Intl predates
  // the option — an options bag it doesn't recognise throws, and that must not
  // cost a working currency.
  for (const display of ['narrowSymbol', 'symbol']) {
    try {
      // en-GB as the default so grouping reads the same as it always did. Symbols
      // and separators come from the currency itself, not the locale.
      currencyFormatter = new Intl.NumberFormat('en-GB', {
        style: 'currency', currency: code, currencyDisplay: display,
        minimumFractionDigits: 2, maximumFractionDigits: 2
      });
      currencyFormatterCode = code;
      return currencyFormatter;
    } catch (err) { /* try the next form */ }
  }
  // An unknown code, or a browser without Intl. Fall back to the old hand-rolled
  // formatting rather than showing nothing: an amount is the one thing on a
  // row that must always appear.
  currencyFormatter = null;
  currencyFormatterCode = null;
  return null;
}

function currency(amount) {
  const n = Number(amount);
  const value = Number.isFinite(n) ? n : 0;
  const code = getCurrencyCode();
  const formatter = currencyFormatterFor(code);
  if (formatter) {
    const out = formatter.format(value);
    const symbol = CURRENCY_SYMBOLS[code];
    // Only stepped in when Intl actually fell back to the code, so a currency
    // it does know keeps its own spacing and symbol.
    if (symbol && out.indexOf(code) === 0) return symbol + out.slice(code.length);
    return out;
  }
  const fallback = (CURRENCY_SYMBOLS[code] || (CURRENCIES.find((c) => c[0] === code) || [code])[0]);
  return fallback + ' ' + value.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// A date-only string ("2026-10-01") parsed as the local calendar day it names.
//
// `new Date('2026-10-01')` is midnight *UTC* by spec. In London during BST that
// is 01:00 the same day and everything looks fine, which is why this went years
// without being noticed; in any zone west of Greenwich it is the previous
// evening locally, so every month comparison, every printed date and every day
// count is off by one. The app ships 51 currencies and documents forking as the
// plan, so "works in the UK" is not good enough.
//
// A string that already carries a time is left to the normal parser, because
// that is an instant rather than a day.
function parseDateOnly(value) {
  const s = String(value == null ? '' : value).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

function formatDate(dateStr) {
  const date = parseDateOnly(dateStr);
  if (!date) return '';
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatMonth(date) {
  return date.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

function isThisMonth(dateStr) {
  const date = parseDateOnly(dateStr);
  if (!date) return false;
  const now = new Date();
  return date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();
}

function isThisYear(dateStr) {
  const date = parseDateOnly(dateStr);
  if (!date) return false;
  return date.getFullYear() === new Date().getFullYear();
}

function isSameMonth(dateStr, targetDate) {
  const date = parseDateOnly(dateStr);
  if (!date) return false;
  return date.getMonth() === targetDate.getMonth() && date.getFullYear() === targetDate.getFullYear();
}

function isSameYear(dateStr, targetDate) {
  const date = parseDateOnly(dateStr);
  if (!date) return false;
  return date.getFullYear() === targetDate.getFullYear();
}

function isOverdue(dueDate) {
  // Date-only: a bill is overdue the day AFTER it was due. Comparing
  // against the current time made every bill due today read as overdue
  // on the dashboard while the Bills page said "Due today" — both now
  // normalise to local midnight like daysUntil() does.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = parseDateOnly(dueDate);
  if (!due) return false;
  due.setHours(0, 0, 0, 0);
  return due < today;
}

function daysUntil(dueDate) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = parseDateOnly(dueDate);
  if (!due) return null;
  due.setHours(0, 0, 0, 0);
  // Calendar days, not elapsed hours. On the spring-forward day the interval is
  // 23 hours long and Math.ceil of that reads yesterday as today, so a bill one
  // day overdue said "Due today" once a year.
  const day = 24 * 60 * 60 * 1000;
  const from = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const to = Date.UTC(due.getFullYear(), due.getMonth(), due.getDate());
  return Math.round((to - from) / day);
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
