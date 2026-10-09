#!/usr/bin/env node
/*
 * Score OCR against a folder of real receipts.
 *
 *   node tools/ocr-corpus.mjs [dir]
 *
 * The layout is deliberately a folder and some text:
 *
 *   ~/sorted-receipts/
 *     receipt-01.jpg          the photo, exactly as the phone took it
 *     receipt-01.txt          three lines: title, amount, date
 *
 *   TESCO STORES LTD
 *   72.86
 *   2026-10-25
 *
 * An amount may carry a £, the date may be anything the receipt prints, and a
 * line starting with # is ignored — that is how a note is left beside one.
 *
 * Why this exists: every OCR measurement so far has been made on a receipt
 * drawn by the benchmark, which is a receipt that reads perfectly. The
 * inaccuracies worth finding are the ones on real thermal print, real ink
 * spread and a real crease, and those cannot be invented here. With eight to
 * ten of these the case for or against a change to the guessers is a number
 * rather than an opinion, and every future one gets a score.
 *
 * It runs the real pipeline — preprocessForOCR then runOCR through the worker,
 * the same call the receipt panel makes — so the figures are the ones the app
 * produces, not a second implementation of them.
 */

import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';

const dir = process.argv[2] || `${process.env.HOME}/sorted-receipts`;
const IMAGE = /\.(png|jpe?g|webp|gif|bmp)$/i;

if (!existsSync(dir)) {
  console.error(`No folder at ${dir}.`);
  console.error('Create it, drop receipt images in with a .txt beside each holding the');
  console.error('title, amount and date, and run this again.');
  process.exit(2);
}

const images = readdirSync(dir).filter((f) => IMAGE.test(f));
if (!images.length) {
  console.error(`No images in ${dir}.`);
  process.exit(2);
}

// Its own chromedriver, on its own port: the tool has to run on its own, and a
// driver inherited from a shell is the thing that leaves browsers behind.
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

const base = `http://127.0.0.1:${await freePort()}`;
const driver = spawn('chromedriver', [`--port=${new URL(base).port}`], {
  stdio: ['ignore', 'ignore', 'ignore'],
  detached: true,
});
driver.unref();
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`${base}/status`)).ok) break;
  } catch (err) { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 200));
}
const stopDriver = () => { try { process.kill(-driver.pid, 'SIGKILL'); } catch (err) { driver.kill('SIGKILL'); } };
process.on('exit', stopDriver);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopDriver(); process.exit(1); });

async function newSession() {
  const caps = {
    capabilities: {
      alwaysMatch: {
        browserName: 'chrome',
        'goog:chromeOptions': {
          binary: process.env.CHROMIUM || '/usr/bin/chromium',
          args: ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
        },
      },
    },
  };
  const res = await fetch(`${base}/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(caps),
  });
  const { value: { sessionId } } = await res.json();
  const send = async (p, method, body) => {
    const r = await fetch(`${base}/session/${sessionId}${p}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json();
    if (j.value && j.value.error) throw new Error(JSON.stringify(j.value).slice(0, 300));
    return j.value;
  };
  const run = (sc) => send('/execute/sync', 'POST', { script: sc, args: [] });
  await send('/timeouts', 'POST', { script: 900000 });
  await send('/url', 'POST', { url: 'http://127.0.0.1:8141/index.html' });
  return { send, run, close: () => fetch(`${base}/session/${sessionId}`, { method: 'DELETE' }) };
}

// A receipt is read straight off disk and handed over as a File, the same shape
// the file input produces, so nothing about this differs from the real path.
const readReceipt = (path, type) => {
  const bytes = readFileSync(path);
  const b64 = bytes.toString('base64');
  const name = basename(path);
  return `(async () => {
    const bin = atob(${JSON.stringify(b64)});
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} });
  })()`;
};

const mimeOf = (name) => {
  const ext = (name.match(/\.([^.]+)$/) || [])[1];
  return { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp' }[String(ext).toLowerCase()]
    || 'image/jpeg';
};

const truthOf = (imagePath) => {
  const txt = imagePath.replace(/\.[^.]+$/, '.txt');
  if (!existsSync(txt)) return null;
  const lines = readFileSync(txt, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  const [title, amount, date] = lines;
  return {
    title: title || '',
    amount: amount === undefined ? null : Number(String(amount).replace(/[^\d.-]/g, '')),
    date: date || null,
  };
};

const results = [];
for (const image of images) {
  const imagePath = join(dir, image);
  const truth = truthOf(imagePath);
  const session = await newSession();
  try {
    // The guessers run in the page, where they are defined, and return the
    // figures the receipt panel would fill in.
    const run = await session.run(`return (async () => {
      dropOcrWorker();
      const t0 = performance.now();
      const text = await runOCRWithTimeout(
        await ${readReceipt(imagePath, mimeOf(image))}, null, 600000);
      return {
        text, ms: Math.round(performance.now() - t0),
        title: guessTitleFromText(text),
        amount: guessAmountFromText(text),
        date: guessDateFromText(text),
        cardLast4: guessCardLast4(text),
      };
    })();`);
    const text = String((run && run.text) || '');
    results.push(Object.assign({ image, truth }, run || {}));
  } catch (err) {
    results.push({ image, truth, error: String((err && err.message) || err) });
  } finally {
    await session.close();
  }
}

const pad = (s, n) => String(s === null || s === undefined ? '—' : s).padEnd(n);
const tick = (got, want) => (got && want && String(got) === String(want) ? 'ok  ' : (got ? 'MISS' : '----'));

let titleOk = 0, amountOk = 0, dateOk = 0, scored = 0;
for (const r of results) {
  const t = r.truth;
  if (!t) { console.log(`  ???  ${r.image} — no .txt beside it, not scored`); continue; }
  scored++;
  if (tick(r.title, t.title) === 'ok  ') titleOk++;
  if (tick(r.amount, t.amount) === 'ok  ') amountOk++;
  if (tick(r.date, t.date) === 'ok  ') dateOk++;
}
console.log('');
for (const r of results) {
  const t = r.truth;
  if (!t) continue;
  console.log(`  ${pad(r.image, 20)} ${r.ms ? r.ms + 'ms' : '      '}  `
    + `title:${tick(r.title, t.title)} amount:${tick(r.amount, t.amount)} date:${tick(r.date, t.date)}`);
  if (!t.title || r.title !== t.title) {
    console.log(`        title  got ${JSON.stringify(r.title)}  want ${JSON.stringify(t.title)}`);
  }
  if (r.title !== t.title || r.amount !== t.amount || r.date !== t.date) {
    console.log('        read  ' + JSON.stringify(r.text).slice(0, 320));
  }
  if (r.amount !== t.amount) {
    console.log(`        amount got ${r.amount}  want ${t.amount}`);
  }
  if (r.date !== t.date) {
    console.log(`        date   got ${JSON.stringify(r.date)}  want ${JSON.stringify(t.date)}`);
  }
  if (r.error) console.log(`        ERROR  ${r.error}`);
}
console.log('');
console.log(`  ${titleOk}/${scored} titles, ${amountOk}/${scored} amounts, `
  + `${dateOk}/${scored} dates, from ${scored} receipts in ${dir}`);
console.log('');
console.log('  The raw text of each read is in the rows above when it disagrees with the');
console.log('  truth; keep going until the misses are all the interesting kind.');
