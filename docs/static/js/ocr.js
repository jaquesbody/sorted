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
