/* =============================================================================
   ocr.js
   Self-hosted Tesseract.js OCR, per project.md 5 — no external requests.
   Uses the non-SIMD LSTM core specifically (the only variant committed to
   the repo), pointed at directly rather than a directory, since Tesseract's
   auto-detection would otherwise try filenames we don't have.

   IMPORTANT: amount/title extraction below is a naive best-guess, not a
   real parser. Receipts have several numbers on them (unit price, VAT,
   total) — this looks for a line containing "total" first, falls back to
   the largest currency-looking number on the page. Wrong often enough that
   the confirm step is not optional.
   ============================================================================= */

// Tesseract wants text roughly 30px tall — about 300dpi on paper. A receipt
// photographed on a phone is often well under that, and at 12px it stops being
// reliably readable: measured, a receipt 560px wide came back with its decimal
// points gone ("1.75" read as "175") and its date collapsed to "200202".
//
// Lifting it costs nothing on device and is the single biggest accuracy lever
// available without sending the image anywhere.
const OCR_MIN_WIDTH = 1000;
const OCR_MAX_WIDTH = 2400;

// Returns a PNG blob of the same receipt, prepared for recognition. Falls back
// to the original on any failure: a receipt that reads badly is better than a
// receipt that reads as an error.
async function preprocessForOCR(file) {
  try {
    const bitmap = await createImageBitmap(file);
    let scale = 1;
    if (bitmap.width < OCR_MIN_WIDTH) {
      scale = Math.min(OCR_MAX_WIDTH / bitmap.width, 3);
    } else if (bitmap.width > OCR_MAX_WIDTH) {
      scale = OCR_MAX_WIDTH / bitmap.width;
    }

    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    // White, not transparent: a transparent area reads as black ink.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    // Smoothing off when lifting, so upscaling doesn't blur the glyph edges
    // into each other — the opposite of what a smoother read wants.
    ctx.imageSmoothingEnabled = scale > 1 ? false : true;
    ctx.drawImage(bitmap, 0, 0, width, height);
    if (typeof bitmap.close === 'function') bitmap.close();

    // Deliberately no binarisation here. It looked like an obvious win and was
    // measured to be a loss: greyscaling and cutting at Otsu's threshold got the
    // grocery receipts' decimals and dates right, but chewed up dense
    // low-contrast lines — a receipt's card line read "2840" as "B40", and the
    // one date that was still being missed stopped being missed once the
    // threshold was removed. Upscaling alone scored 12/12 on amounts and on
    // dates; upscaling plus binarisation scored 12/12 and 11/12. The threshold
    // code went rather than staying behind a flag.

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    return blob || file;
  } catch (err) {
    console.warn('Receipt preprocessing skipped:', err);
    return file;
  }
}

async function runOCR(imageFile, onProgress, onWorker) {
  // Fetched on demand — see loadScriptOnce() in utils.js.
  await loadScriptOnce('static/vendor/tesseract/tesseract.min.js');
  const worker = await Tesseract.createWorker('eng', 1, {
    workerPath: 'static/vendor/tesseract/worker.min.js',
    corePath: 'static/vendor/tesseract/core/tesseract-core-lstm.wasm.js',
    langPath: 'static/vendor/tesseract/lang/',
    logger: (m) => {
      if (onProgress) onProgress(`${m.status}${m.progress !== undefined ? ' ' + Math.round(m.progress * 100) + '%' : ''}`);
    },
  });
  if (onWorker) onWorker(worker);

  // PSM 6, "assume a single uniform block of text", which is what a receipt is:
  // one column, no page furniture. The default (3) spends effort hunting for
  // columns and headers and misreads till paper as a page with regions.
  try {
    await worker.setParameters({ tessedit_pageseg_mode: '6' });
  } catch (err) {
    console.warn('Could not set page segmentation mode:', err);
  }

  const prepared = await preprocessForOCR(imageFile);
  const { data: { text } } = await worker.recognize(prepared);
  await worker.terminate();
  return text;
}

function runOCRWithTimeout(imageFile, onProgress, timeoutMs = 25000) {
  let worker = null;
  let timedOut = false;
  let timer = null;

  const killWorker = () => {
    const w = worker;
    worker = null;
    // terminate() can reject if the worker already died — nothing to do.
    if (w) Promise.resolve(w.terminate()).catch(() => {});
  };

  const work = runOCR(imageFile, onProgress, (w) => {
    worker = w;
    // createWorker may only finish after we gave up — kill it then.
    if (timedOut) killWorker();
  }).finally(() => {
    if (timer) clearTimeout(timer);
  });

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      killWorker(); // a timed-out OCR used to leak the worker forever
      reject(new Error('Timed out after 25s — likely a file failed to load'));
    }, timeoutMs);
  });

  return Promise.race([work, timeout]);
}

// Words that mark the figure the receipt is asking you for, strongest first.
// Ordered rather than tested as a set because "SUBTOTAL" contains "total" and a
// discount, a service charge or a deposit between the two makes them different
// numbers — on a receipt with a 10% off coupon the subtotal is the wrong answer
// and it was winning because the old test was just /total/i.
const TOTAL_WEIGHTS = [
  [/\bgrand\s*total\b/i, 100],
  [/\btotal\s*due\b/i, 95],
  [/\bamount\s*due\b/i, 92],
  [/\bto\s*pay\b/i, 90],
  [/\bnet\s*due\b/i, 88],
  [/\bbalance\s*due\b/i, 86],
  [/\bbalance\b/i, 70],
  [/\bamount\b/i, 68],
  [/\btotal\b/i, 66],
  [/\bsubtotal\b/i, 30],
];

// Words about how you paid rather than what you owed. The old fallback took the
// largest number anywhere on the page, so any receipt with a CASH line returned
// the cash you handed over: measured, a Sainsbury's receipt for £8.60 read back
// as £10.00 because CASH 10.00 was the biggest figure on it.
const TENDER_WORDS =
  /\b(cash|change|tendered|amount\s*received|received|given|visa|mastercard|maestro|amex|debit\s*card|credit\s*card|card\s*payment|paid\s*by|coins?|notes?)\b/i;

// A money figure, preferring one with two decimal places. Also catches the
// thousands separator a till prints, and pence-only totals.
const MONEY = /(?:\u00a3|GBP)?\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})|\d{1,5}\.\d{2})/g;

function moneyOn(line) {
  const found = [];
  MONEY.lastIndex = 0;
  let m;
  while ((m = MONEY.exec(line)) !== null) {
    const n = parseFloat(String(m[1]).replace(/,/g, ''));
    if (Number.isFinite(n)) found.push(n);
  }
  return found;
}

// A line's claim to being the total, 0 if it isn't claiming.
function totalWeight(line) {
  if (TENDER_WORDS.test(line)) return 0;
  let best = 0;
  for (const [re, weight] of TOTAL_WEIGHTS) {
    if (re.test(line)) best = Math.max(best, weight);
  }
  return best;
}

function guessAmountFromText(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return 0;

  // 1. The best line that names a total, largest figure on it. A total word with
  //    no figure on its own line — "TOTAL" above the number, which is how a lot
  //    of receipts print it — borrows from the line below.
  let best = { score: 0, amount: 0 };
  lines.forEach((line, i) => {
    const score = totalWeight(line);
    if (!score) return;
    let money = moneyOn(line);
    if (money.length === 0 && i + 1 < lines.length && !totalWeight(lines[i + 1])) {
      money = moneyOn(lines[i + 1]);
    }
    if (!money.length) return;
    const amount = Math.max(...money);
    if (score > best.score || (score === best.score && amount > best.amount)) {
      best = { score: score, amount: amount };
    }
  });
  if (best.score > 0) return best.amount;

  // 2. No total anywhere. The largest figure on a line that isn't about payment
  //    — the amount, not the cash.
  const candidates = [];
  lines.forEach((line) => {
    if (TENDER_WORDS.test(line)) return;
    candidates.push(...moneyOn(line));
  });
  if (candidates.length > 0) return Math.max(...candidates);

  // 3. Nothing but tender lines. The smallest is the most likely total, since a
  //    receipt always shows change as a smaller figure than the cash.
  const tendered = [];
  lines.forEach((line) => tendered.push(...moneyOn(line)));
  return tendered.length > 0 ? Math.min(...tendered) : 0;
}

function guessTitleFromText(text) {
  const firstLine = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 2);
  return firstLine ? firstLine.slice(0, 40) : 'Receipt';
}

// Best-effort receipt date extraction — same naive philosophy as the amount
// guesser above, so the confirm step stays mandatory. Returns "YYYY-MM-DD"
// (ready for <input type="date">) or null when nothing date-like is found.
// Handles the formats receipts actually print: ISO (2026-09-25), numeric
// UK-first (25/09/2026, 25.09.26), US-style when unambiguous (09/25/2026),
// month names (25 Sep 2026, September 25, 2026) and mixed (25-Sep-26).
function guessDateFromText(text) {
  const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const monthAlt = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
  // The same months, but tolerant of the one substitution OCR actually makes
  // here: "2 Oct 2026" recognised as "20ct 2026", with a zero where the letter
  // O belongs. Measured on a drawn receipt at three tilts — it was the only
  // reason a date was being missed entirely, since "oct" cannot match "0ct".
  const monthAltLoose = 'jan|feb|mar|apr|may|jun|jul|aug|sep|[o0]ct|nov|dec';
  // Any digits in what matched are recognition noise — but a zero can BE the
  // noise, standing in for the letter O. Folding 0 back to o has to happen
  // before the rest is stripped, or "0ct" reduces to "ct" and looks up nothing.
  const monthKey = (s) => String(s || '')
    .toLowerCase()
    .replace(/0/g, 'o')
    .replace(/[^a-z]/g, '')
    .slice(0, 3);
  const currentYear = new Date().getFullYear();

  const make = (year, month, day) => {
    const y = year == null || year === '' ? currentYear
      : String(year).length === 2 ? 2000 + Number(year) : Number(year);
    const m = Number(month);
    const d = Number(day);
    if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2099) return null;
    const dt = new Date(y, m - 1, d); // round-trip rejects 31 Feb, 31/09, etc.
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
    const pad = (n) => String(n).padStart(2, '0');
    return `${y}-${pad(m)}-${pad(d)}`;
  };

  let m;
  // Year-first (2026-09-25 or 2026/09/25) — unambiguous, check before the
  // day-first patterns so "2026/09/25" isn't misread as day 26 month 09.
  m = text.match(/\b(\d{4})[/-](\d{1,2})[/-](\d{1,2})\b/);
  if (m) { const r = make(m[1], m[2], m[3]); if (r) return r; }

  // Numeric day/month order: assume UK (this is a £ app), flip only when the
  // other reading is forced (09/25 → month 09 day 25).
  const numRe = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/g;
  while ((m = numRe.exec(text)) !== null) {
    let day = m[1];
    let month = m[2];
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 12 && b > 12) continue;        // neither can be a month
    if (b > 12) { day = m[2]; month = m[1]; } // only the US reading fits
    const r = make(m[3], month, day);
    if (r) return r;
  }

  // Day + month name: "25 Sep 2026", "25th September", optional year.
  const nameRe = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${monthAltLoose})[a-z]*\\.?,?\\s*(\\d{2,4})?\\b`, 'i');
  m = text.match(nameRe);
  if (m) { const r = make(m[3], months[monthKey(m[2])], m[1]); if (r) return r; }

  // A day and a month name with no space between them, because the space was
  // lost in recognition rather than on the paper. "2 Oct 2026" comes back as
  // "20ct 2026" often enough to be worth handling: the day is one or two digits
  // and the month name follows immediately, so peel digits off the front until
  // what's left starts a month. Only 1-31 is accepted, which is what keeps "1st"
  // in a line number or a quantity from being read as a day.
  const gluedRe = new RegExp(`(\\d{1,2})(${monthAltLoose})[a-z]*\\.?\\s*,?\\s*(\\d{2,4})`, 'ig');
  while ((m = gluedRe.exec(text)) !== null) {
    const r = make(m[3], months[monthKey(m[2])], m[1]);
    if (r) return r;
  }

  // Month first: "Sep 25, 2026", "September 25".
  const monthFirstRe = new RegExp(`\\b(${monthAlt})[a-z]*\\.?,?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s*(\\d{2,4})?\\b`, 'i');
  m = text.match(monthFirstRe);
  if (m) { const r = make(m[3], months[m[1].slice(0, 3).toLowerCase()], m[2]); if (r) return r; }

  // Mixed separators: "25-Sep-26".
  const mixedRe = new RegExp(`\\b(\\d{1,2})[/.-](${monthAlt})[a-z]*[/.-](\\d{2,4})\\b`, 'i');
  m = text.match(mixedRe);
  if (m) { const r = make(m[3], months[m[2].slice(0, 3).toLowerCase()], m[1]); if (r) return r; }

  return null;
}
