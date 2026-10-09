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
//
// onTick is not decoration. Everything here is a stretch in which Tesseract
// says nothing at all — decoding the photo, scaling it, re-encoding it — and
// runOCRWithTimeout's deadline only knows the pipeline is alive when something
// reports. Called before the decode and again before the encode, because those
// two are the slow parts and the encode is the slow one.
async function preprocessForOCR(file, onTick) {
  try {
    if (onTick) onTick('Preparing the photo…');
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

    // Before the encode, not after: encoding a 2400x3200 PNG is the slowest
    // thing in here and the part that has to be covered.
    if (onTick) onTick('Preparing the photo…');
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    return blob || file;
  } catch (err) {
    console.warn('Receipt preprocessing skipped:', err);
    return file;
  }
}

/* -----------------------------------------------------------------------------
   The engine, and where its language comes from.

   Tesseract's worker loads the *engine* with importScripts() but the *language*
   traineddata with fetch(), from inside a worker created from a blob URL. On
   Android that second request never reaches this app's asset server: the core
   loads and the language load then sits at 0% forever, which is what a
   handset was reporting as "Reading stopped at loading language traineddata
   0%". importScripts is served by the WebView's asset loader and worker fetch
   is not, and the two are not interchangeable.

   So the bytes are fetched on the main thread — where this app's own assets
   are served and always have been — and handed to the worker with the job, as
   `{ code, data }`. The worker then applies them without fetching anything.
   Verified with every https:// URL blocked in the browser: no network request
   is made at all.
   -------------------------------------------------------------------------- */

const OCR_LANG = 'eng';

// The traineddata is about 3MB and never changes, and the worker is expensive
// to build — engine load, language decode — so both are kept after the first
// read. Both are dropped on any failure and whenever the app is backgrounded,
// which matters more than it sounds: Android tears the worker down when it
// suspends the WebView, and the photo picker and the camera both suspend it,
// so a receipt is chosen by leaving the app and coming back. Holding on to a
// worker that no longer exists would have the next receipt wait on it.
let ocrLangData = null;
let ocrWorker = null;

function dropOcrWorker() {
  const w = ocrWorker;
  ocrWorker = null;
  // terminate() can reject if the worker already died — nothing to do.
  if (w) Promise.resolve(w.terminate()).catch(() => {});
}

// Where the traineddata lives. It has to be asked for by more than one name,
// because the build changes it: aapt2 gunzips any asset whose filename ends in
// .gz and strips the extension, so the web build carries eng.traineddata.gz
// and the APK carries eng.traineddata, decompressed. The worker applies either
// — it gunzips by magic number when it needs to — so the bytes only have to
// arrive, and every name the app ships under is tried.
const OCR_LANG_URLS = [
  'static/vendor/tesseract/lang/eng.traineddata.gz',
  'static/vendor/tesseract/lang/eng.traineddata',
];

async function loadOcrLangData(onProgress) {
  if (ocrLangData) return ocrLangData;
  if (onProgress) onProgress('Loading the reader…');
  const failed = [];
  for (const url of OCR_LANG_URLS) {
    let bytes = null;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        // A 404 here is not a broken phone: it is a name the build renamed.
        failed.push(`${url} (HTTP ${res.status})`);
        continue;
      }
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      failed.push(`${url} (${(err && err.name) || err})`);
      continue;
    }
    // A truncated or empty file would otherwise reach the engine as a language
    // it cannot read, and the failure would surface nowhere.
    if (bytes.length < 1024) {
      failed.push(`${url} (too small: ${bytes.length})`);
      continue;
    }
    ocrLangData = bytes;
    return bytes;
  }
  throw new Error(`could not load the reader's language from ${failed.join(' or ')}`);
}

async function getOcrWorker(onProgress) {
  if (ocrWorker) return ocrWorker;
  const data = await loadOcrLangData(onProgress);
  // Fetched on demand — see loadScriptOnce() in utils.js.
  await loadScriptOnce('static/vendor/tesseract/tesseract.min.js');
  if (onProgress) onProgress('Starting the reader…');
  // No language at creation: createWorker('eng', …) would make the worker fetch
  // it, and that is the request that never arrives on a handset. Nothing is
  // asked for until there are bytes in hand to give.
  const worker = await Tesseract.createWorker([], undefined, {
    workerPath: 'static/vendor/tesseract/worker.min.js',
    corePath: 'static/vendor/tesseract/core/tesseract-core-lstm.wasm.js',
    cacheMethod: 'none',
    logger: (m) => {
      if (onProgress) onProgress(`${m.status}${m.progress !== undefined ? ' ' + Math.round(m.progress * 100) + '%' : ''}`);
    },
  });
  await worker.load([{ code: OCR_LANG, data: data }]);
  await worker.reinitialize(OCR_LANG, 1, undefined);
  ocrWorker = worker;
  return worker;
}

async function runOCR(imageFile, onProgress, onWorker) {
  // Every stage announces itself, and not only for the person watching. The
  // deadline below can only tell "working" from "stuck" by being told
  // something, and the spans between Tesseract's own reports — loading the
  // script, fetching the language, decoding the photo, scaling it, re-encoding
  // it, and the gap between `recognize` being called and its first percentage
  // — are stretches in which the engine says nothing at all. Measured on a
  // desktop they total about 1.7s; on a handset the same spans are the longest
  // quiet periods in the whole pipeline, and a deadline that only listened to
  // Tesseract fired in the middle of a read that was still going.
  let worker;
  try {
    worker = await getOcrWorker(onProgress);
  } catch (err) {
    // A half-built worker is not a worker. Next receipt starts clean.
    dropOcrWorker();
    throw err;
  }
  if (onWorker) onWorker(worker);

  // PSM 6, "assume a single uniform block of text", which is what a receipt is:
  // one column, no page furniture. The default (3) spends effort hunting for
  // columns and headers and misreads till paper as a page with regions.
  try {
    await worker.setParameters({ tessedit_pageseg_mode: '6' });
  } catch (err) {
    console.warn('Could not set page segmentation mode:', err);
  }

  const prepared = await preprocessForOCR(imageFile, onProgress);
  // Announced before the call rather than after, because the quiet span is the
  // image going across to the worker and the page being set up — nothing is
  // reported again until Tesseract has text of its own to report on.
  if (onProgress) onProgress('Reading receipt…');
  let text;
  try {
    const out = await worker.recognize(prepared);
    text = out.data.text;
  } catch (err) {
    // Not kept for next time. Whatever just went wrong, this worker is now
    // suspect, and holding on to it would have the next receipt repeat it.
    dropOcrWorker();
    throw err;
  }
  // Left alive on purpose: the next receipt should not pay for it again.
  return text;
}

// Android suspends the WebView when the app is backgrounded, which kills the
// worker, and the picker and the camera both background the app — a receipt is
// chosen by leaving Sorted and coming back. So the worker is dropped on the way
// out and rebuilt when it is next needed, rather than held as a reference to
// something that has already gone.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') dropOcrWorker();
  });
  window.addEventListener('pagehide', dropOcrWorker);
}

// Recognition is slow because a phone is not a desk, not because the photo is
// bad. Measured on a packed 2400-wide receipt on a fast desktop: 16.6s end to
// end, of which 16.0s is `recognize` alone — and that image is one this code
// deliberately prepared, downscaled to the width Tesseract wants. A 25s wall
// clock was therefore not a safety net but a coin flip at a desk and a certain
// loss on a handset: it cut those runs off with seconds to spare here, and on
// a phone several times slower it cut every one of them off. That is what
// "Could not read that file" was reporting — the receipt was never given the
// time to be read, so how clear it was never came into it.
//
// The thing the old message suspected — a file that failed to load, a worker
// that died — does not look like slowness, it looks like silence: the engine
// stops saying anything at all. So the deadline is silence rather than elapsed
// time. The logger reports progress every 250-500ms throughout, with only a
// 39ms gap before it finishes, so anything still ticking is still working and
// may take as long as it needs; nothing heard for OCR_STALL_MS means nothing
// is coming.
const OCR_STALL_MS = 45000;

function runOCRWithTimeout(imageFile, onProgress, stallMs = OCR_STALL_MS) {
  let worker = null;
  let stalled = false;
  let timer = null;
  let giveUp = () => {};
  // What the pipeline said last. The failure has to name it: the same message
  // used to come back for every cause, and a deadline arriving mid-read was
  // reported as though the photo were unreadable.
  let lastStatus = '';

  const stall = new Promise((_, reject) => {
    giveUp = () => {
      const err = new Error(`OCR stopped reporting progress for ${stallMs}ms`);
      err.code = 'ocr-stall';
      err.lastStatus = lastStatus;
      reject(err);
    };
  });

  const killWorker = () => {
    const w = worker;
    worker = null;
    // If that is the shared worker, the shared reference goes with it: leaving
    // it behind would have the next receipt wait on something we have already
    // given up on.
    if (ocrWorker === w) ocrWorker = null;
    // terminate() can reject if the worker already died — nothing to do.
    if (w) Promise.resolve(w.terminate()).catch(() => {});
  };

  // Restart the deadline on every word from the engine. The first beat() is
  // what covers the script load and worker creation, before there is a logger.
  const beat = () => {
    if (stalled) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      killWorker(); // a stalled OCR used to leak the worker forever
      giveUp();
    }, stallMs);
  };

  const work = runOCR(imageFile, (msg) => {
    lastStatus = msg;
    beat();
    if (onProgress) onProgress(msg);
  }, (w) => {
    worker = w;
    // createWorker may only finish after we gave up — kill it then.
    if (stalled) killWorker();
  }).finally(() => {
    if (timer) clearTimeout(timer);
  });

  beat();
  return Promise.race([work, stall]);
}

// OCR does not read capitals reliably, and the words that decide which figure
// is the one being asked about are the words it mangles most: measured on a
// degraded receipt, TOTAL came back T0TAL and TOTA1 and VISA as V1SA, which lost
// the one number the receipt existed to state. So the keywords are matched
// through a character class per letter rather than as literals — 0 for O, 1 for
// I or L, 5 for S, 8 for B, 6 for G, 2 for Z, 4 for A — which costs nothing to
// build and turns a misspelling into a hit.
const OCR_CONFUSION = { A: '4', B: '8', G: '6', I: '1', L: '1', O: '0', S: '5', Z: '2' };

function fuzzyBody(word) {
  return word
    .replace(/[a-z]/gi, (ch) => {
      const alt = OCR_CONFUSION[ch.toUpperCase()];
      return alt ? `[${ch}${alt}]` : ch;
    })
    .replace(/\s+/g, '\\s+');
}

const fuzzyWord = (word) => new RegExp(`\\b${fuzzyBody(word)}\\b`, 'i');

// Words that mark the figure the receipt is asking you for, strongest first.
// Ordered rather than tested as a set because "SUBTOTAL" contains "total" and a
// discount, a service charge or a deposit between the two makes them different
// numbers — on a receipt with a 10% off coupon the subtotal is the wrong answer
// and it was winning because the old test was just /total/i.
const TOTAL_WORDS = [
  ['grand total', 100],
  ['total due', 95],
  ['amount due', 92],
  ['to pay', 90],
  ['net due', 88],
  ['balance due', 86],
  ['balance', 70],
  ['amount', 68],
  ['total', 66],
  ['subtotal', 30],
];
const TOTAL_WEIGHTS = TOTAL_WORDS.map(([word, weight]) => [fuzzyWord(word), weight]);

// Words about how you paid rather than what you owed. The old fallback took the
// largest number anywhere on the page, so any receipt with a CASH line returned
// the cash you handed over: measured, a Sainsbury's receipt for £8.60 read back
// as £10.00 because CASH 10.00 was the biggest figure on it.
const TENDER_LIST = [
  'cash', 'change', 'tendered', 'amount received', 'received', 'given',
  'visa', 'mastercard', 'maestro', 'amex', 'debit card', 'credit card',
  'card payment', 'paid by', 'coins', 'notes',
];
const TENDER_WORDS = new RegExp(
  `\\b(${TENDER_LIST.map(fuzzyBody).join('|')})\\b`, 'i');

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

// Receipt furniture: the things a receipt says before it says who it is from.
// An address, a till number, a VAT number and a phone number all precede the
// name, and the first line of text is the one that reads worst — a logo is set
// in a typeface the engine has no chance on, and the plain-text name of the
// same business is usually printed a few lines below it. Measured: a degraded
// supermarket receipt read its logo as "i : —_" while its "TESCO STORES LTD"
// three lines down came back perfectly.
const TITLE_FURNITURE =
  /\b(store|till|tel|phone|fax|vat|address|branch|receipt|invoice|date|time|welcome|thank|you|visit|again|please|order|table|cashier|operator|card|visa|mastercard|debit|credit|cash|change|total|subtotal|amount|balance|www|http|no\s*\d|tel\s*\d)\b/i;

// A line that names the business itself rather than the shop it was printed in.
// This is what the logo line is normally a mangled version of.
const TITLE_COMPANY =
  /\b(ltd|limited|plc|llp|inc|llc|corp|group|stores|supermarket|supermarkets|trading|company|retail|shop|cafe|restaurant|hotel|inn|pharmacy|garage|centre|center|services|solutions|kitchens|bakers|butchers|deli)\b/i;

function titleScore(line, index, total) {
  const t = line.trim();
  // Not a name at all: no run of letters long enough to be a word.
  if (!/[a-z]{3,}/i.test(t)) return -1000;
  if (TITLE_FURNITURE.test(t)) return -1000;
  if (/^\d/.test(t)) return -1000;          // "12 HIGH STREET", "4471"
  if (/\b\d{5,6}\b/.test(t)) return -1000;   // a postcode or an account number
  const letters = (t.match(/[a-z]/gi) || []).length;
  const digits = (t.match(/\d/g) || []).length;
  // A row of digits with separators and almost no letters is a date, a time or a
  // figure, not a name.
  if (letters <= 2 && digits >= 2) return -1000;

  let score = 100 - index * 2;               // earlier is better
  // A shop's name is never the last thing printed. The tail of a receipt is
  // "PLEASE KEEP YOUR RECEIPT" and "THANK YOU", and on a poor photo the second
  // of those reads as "THANE TOU" — no keyword list survives that, but the
  // position is a fact.
  if (index >= total - 2) score -= 40;
  if (TITLE_COMPANY.test(t)) score += 60;    // "TESCO STORES LTD" beats "TESCO"
  // A digit inside an otherwise good name is an OCR substitution, not a
  // disqualification: S is read as 3 often enough that rejecting every line
  // carrying one threw away "TESCO 3TORES LTD" and handed the title to "THAME
  // TOL", the mangled thank-you. It costs the line standing without ending it.
  score -= digits * 12;
  return score;
}

/* -----------------------------------------------------------------------------
   Category inference.

   A receipt usually says what it was for — a supermarket's name, "DIESEL", a
   pharmacy — and the category is the field that costs the most taps to get
   right by hand. So it is suggested from the text, exactly as the title, the
   amount and the date are: it fills an empty field and is never written over
   anything already there, and it is a <select>, so a wrong suggestion is one
   tap to correct.

   Two things make it work. The words are matched with the same substitution
   tolerance as the total and tender words, because the photo that reads T0TAL
   reads TESC0. And the title is tried on its own before the whole receipt,
   because the shop's name is the most reliably-read line and a word like
   "petrol" in an item list is much weaker evidence than "SHELL GARAGE" at the
   top.
   -------------------------------------------------------------------------- */

const CATEGORY_KEYWORDS = {
  'Eating out': [
    'restaurant', 'cafe', 'coffee', 'starbucks', 'costa coffee', 'caffe nero', 'pret a manger',
    'mcdonalds', 'burger king', 'kfc', 'subway', 'dominos', 'pizza hut', 'nandos', 'wagamama',
    'weatherspoons', 'greggs', 'diner', 'bistro', 'eatery', 'takeaway', 'fish and chips',
    'gastropub', 'pub', 'inn', 'bar',
  ],
  Health: [
    'pharmacy', 'chemist', 'boots', 'dentist', 'dental', 'optician', 'specsavers', 'surgery',
    'clinic', 'hospital', 'veterinary', 'vets', 'physio', 'chiropodist', 'hearing care',
  ],
  Home: [
    'ikea', 'homebase', 'wickes', 'argos', 'dunelm', 'dfs', 'john lewis', 'wilkinson', 'wilko',
    'furniture', 'hardware', 'kitchens', 'carpets', 'curtains', 'bedding', 'toolstation',
  ],
  Motor: [
    'petrol', 'diesel', 'fuel', 'shell', 'esso', 'texaco', 'gulf', 'garage', 'motoring', 'halfords',
    'kwik fit', 'tyres', 'car wash', 'parking', 'trainline', 'railway', 'taxi',
  ],
  Utilities: [
    'electric', 'electricity', 'gas', 'water', 'council tax', 'energy', 'power', 'broadband',
    'internet', 'telephone', 'mobile phone', 'tv licence', 'severn trent', 'thames water', 'edf',
    'eon', 'british gas', 'npower', 'octopus energy', 'virgin media',
  ],
  Groceries: [
    'tesco', 'sainsburys', 'asda', 'morrisons', 'aldi', 'lidl', 'waitrose', 'co-op', 'coop',
    'marks and spencer', 'm&s', 'iceland', 'farmfoods', 'spar', 'costcutter', 'budgens', 'londis',
    'nisa', 'premier', 'costco', 'whole foods', 'greengrocer', 'butchers', 'bakers', 'deli',
    'off licence',
  ],
  Entertainment: [
    'cinema', 'odeon', 'vue', 'cineworld', 'theatre', 'netflix', 'spotify', 'amazon prime',
    'disney', 'steam', 'playstation', 'xbox', 'nintendo', 'waterstones', 'hobbycraft',
    'the range', 'gaming',
  ],
  Travel: [
    'hotel', 'travel', 'airline', 'easyjet', 'ryanair', 'british airways', 'booking.com', 'expedia',
    'holiday', 'flight', 'hostel', 'guest house', 'hygiene',
  ],
  Shopping: [
    'amazon', 'ebay', 'tk maxx', 'primark', 'next', 'h&m', 'zara', 'new look', 'sports direct',
    'currys', 'asos', 'debenhams', 'peacocks', 'dorothy perkins',
  ],
};

// Ordered most specific first: where two categories could both match a name,
// the one that names a way of spending beats the one that names a shop.
const CATEGORY_WORDS = Object.entries(CATEGORY_KEYWORDS).map(([name, words]) => [
  name, new RegExp(`\\b(${words.map(fuzzyBody).join('|')})\\b`, 'i'),
]);

// The last four digits on a receipt belong to whoever holds that card, so they
// are the one thing on a receipt that identifies an *account* rather than a
// shop. Read as a standalone four-digit group — a card number is longer than
// that, so the group is matched on its own boundaries rather than inside the
// longer number — and returned for the caller to match against the accounts.
function guessCardLast4(text) {
  const found = String(text || '').match(/\b\d{4}\b/g) || [];
  // The last group on the page: a receipt prints the card digits in the
  // payment block, which is at the bottom.
  return found.length ? found[found.length - 1] : null;
}

function guessCategoryFromText(text, title) {
  const heading = String(title || '').trim();
  // The shop's name first — the line the engine reads best.
  if (heading) {
    for (const [name, re] of CATEGORY_WORDS) if (re.test(heading)) return name;
  }
  const all = `${heading}\n${String(text || '')}`;
  for (const [name, re] of CATEGORY_WORDS) if (re.test(all)) return name;
  return null;
}

function guessTitleFromText(text) {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 2);
  if (lines.length === 0) return 'Receipt';

  // Only the top of the receipt is in play: past a dozen lines this is the
  // middle of the item list, and the best number on it is a price.
  let best = { score: -Infinity, line: lines[0] };
  lines.slice(0, 12).forEach((line, i) => {
    const score = titleScore(line, i, lines.length);
    if (score > best.score) best = { score, line };
  });
  return best.line.slice(0, 40) || 'Receipt';
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

  // The substitutions OCR actually makes on a date. A poor photo read
  // "25/10/2026 14:02" as "25/16/2826 14:82" — a month of 16 and a year of
  // 2826, so `make` rejected both and the date was lost entirely, even though
  // the digits were there to be had. Swapping one or two of them back is
  // enough, and it is only ever tried when the candidate as read is
  // impossible, so a date that already reads correctly is never touched.
  const DIGIT_FIX = { '0': '8', '8': '0', '6': '0', '1': '7', '7': '1', '5': '6', '2': '7' };
  const repaired = (match) => {
    const swappable = [];
    for (let i = 0; i < match.length; i++) if (DIGIT_FIX[match[i]]) swappable.push(i);
    const swap = (s, i) => s.slice(0, i) + DIGIT_FIX[s[i]] + s.slice(i + 1);
    const out = swappable.map((i) => swap(match, i));
    for (let a = 0; a < swappable.length; a++) {
      for (let b = a + 1; b < swappable.length; b++) out.push(swap(swap(match, swappable[a]), swappable[b]));
    }
    return out;
  };

  // Try a candidate as read, then each repaired version, and take the first
  // that is a real date.
  const tryDate = (partsFn, raw) => {
    const r = partsFn(raw);
    if (r) return r;
    for (const fixed of repaired(raw)) {
      const f = partsFn(fixed);
      if (f) return f;
    }
    return null;
  };

  let m;
  // Year-first (2026-09-25 or 2026/09/25) — unambiguous, check before the
  // day-first patterns so "2026/09/25" isn't misread as day 26 month 09.
  m = text.match(/\b(\d{4})[/-](\d{1,2})[/-](\d{1,2})\b/);
  if (m) {
    const r = tryDate((s) => {
      const p = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
      return p ? make(p[1], p[2], p[3]) : null;
    }, m[0]);
    if (r) return r;
  }

  // Numeric day/month order: assume UK (this is a £ app), flip only when the
  // other reading is forced (09/25 → month 09 day 25).
  const numRe = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/g;
  while ((m = numRe.exec(text)) !== null) {
    const r = tryDate((s) => {
      const p = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
      if (!p) return null;
      let day = p[1];
      let month = p[2];
      const a = Number(p[1]);
      const b = Number(p[2]);
      if (a > 12 && b > 12) return null;         // neither can be a month
      if (b > 12) { day = p[2]; month = p[1]; }  // only the US reading fits
      return make(p[3], month, day);
    }, m[0]);
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
