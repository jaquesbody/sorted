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

async function runOCR(imageFile, onProgress) {
  const worker = await Tesseract.createWorker('eng', 1, {
    workerPath: 'static/vendor/tesseract/worker.min.js',
    corePath: 'static/vendor/tesseract/core/tesseract-core-lstm.wasm.js',
    langPath: 'static/vendor/tesseract/lang/',
    logger: (m) => {
      if (onProgress) onProgress(`${m.status}${m.progress !== undefined ? ' ' + Math.round(m.progress * 100) + '%' : ''}`);
    },
  });

  const { data: { text } } = await worker.recognize(imageFile);
  await worker.terminate();
  return text;
}

function runOCRWithTimeout(imageFile, onProgress, timeoutMs = 25000) {
  return Promise.race([
    runOCR(imageFile, onProgress),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timed out after 25s — likely a file failed to load')), timeoutMs)
    ),
  ]);
}

function guessAmountFromText(text) {
  const moneyRegex = /£?\s?(\d{1,4}\.\d{2})/;
  const lines = text.split('\n');

  for (const line of lines) {
    if (/total/i.test(line)) {
      const match = line.match(moneyRegex);
      if (match) return parseFloat(match[1]);
    }
  }

  const allMatches = [...text.matchAll(/£?\s?(\d{1,4}\.\d{2})/g)].map((m) => parseFloat(m[1]));
  return allMatches.length > 0 ? Math.max(...allMatches) : 0;
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
  const nameRe = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${monthAlt})[a-z]*\\.?,?\\s*(\\d{2,4})?\\b`, 'i');
  m = text.match(nameRe);
  if (m) { const r = make(m[3], months[m[2].slice(0, 3).toLowerCase()], m[1]); if (r) return r; }

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
