// End-to-end PDF receipt: a real (minimal, hand-built) PDF goes through the
// form's file input — render to image, store a preview, OCR the text.
const fs = require('fs');
const path = require('path');
const { withDriver } = require('./driver');
const openedSessions = [];

const OUT = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, extra) => { ok ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n + (extra ? ' -> ' + JSON.stringify(extra) : ''))); };

async function runSuite(driverBase) {
  const caps = { capabilities: { alwaysMatch: { browserName: 'chrome', 'goog:chromeOptions': {
    binary: '/usr/bin/chromium', args: ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2', '--window-size=412,915'] } } } };
  const res = await fetch(`${driverBase}/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(caps) });
  const sid = (await res.json()).value.sessionId;
  openedSessions.push(sid);
  const send = async (p, m, b) => {
    const r = await fetch(`${driverBase}/session/${sid}${p}`, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    const j = await r.json();
    if (j.value && j.value.error) throw new Error(p + ' ' + JSON.stringify(j.value).slice(0, 400));
    return j.value;
  };
  const run = (s) => send('/execute/sync', 'POST', { script: `return (async function(){ ${s} })();`, args: [] });
  const shot = async (n) => fs.writeFileSync(path.join(OUT, n + '.png'), Buffer.from(await send('/screenshot', 'GET'), 'base64'));

  await send('/url', 'POST', { url: 'http://127.0.0.1:8141/index.html?native' });
  await sleep(1500);
  await run(`localStorage.clear();`);
  await send('/url', 'POST', { url: 'http://127.0.0.1:8141/index.html?native' });
  await sleep(1600);

  console.log('\n# a PDF receipt, through the real form');
  const out = await run(`
    // A one-page PDF built by hand, xref offsets computed as we go.
    const enc = (s) => Array.from(s, (c) => c.charCodeAt(0));
    const objs = [];
    objs[1] = '<</Type/Catalog/Pages 2 0 R>>';
    objs[2] = '<</Type/Pages/Kids[3 0 R]/Count 1>>';
    objs[3] = '<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 600]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>';
    const text = 'BT /F1 22 Tf 40 480 Td (SPAR FUEL) Tj 0 -50 Td (TOTAL GBP 40.05) Tj ET';
    objs[4] = '<</Length ' + text.length + '>>\\nstream\\n' + text + '\\nendstream';
    objs[5] = '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>';
    let pdf = '%PDF-1.4\\n';
    const offsets = [];
    for (let i = 1; i <= 5; i++) {
      offsets[i] = pdf.length;
      pdf += i + ' 0 obj\\n' + objs[i] + '\\nendobj\\n';
    }
    const startxref = pdf.length;
    pdf += 'xref\\n0 6\\n0000000000 65535 f \\n';
    for (let i = 1; i <= 5; i++) pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \\n';
    pdf += 'trailer\\n<</Size 6/Root 1 0 R>>\\nstartxref\\n' + startxref + '\\n%%EOF';
    const bytes = new Uint8Array(enc(pdf));
    const file = new File([bytes], 'spar-bill.pdf', { type: 'application/pdf' });

    openAddModal('spend');
    await new Promise((r) => setTimeout(r, 300));
    const input = document.getElementById('receipt-upload-input');
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));

    // Wait for OCR to finish (or time out) rather than guessing.
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const s = document.getElementById('ocr-status').textContent;
      if (/Done|Could not/.test(s)) break;
    }
    const status = document.getElementById('ocr-status').textContent;
    const thumb = document.querySelector('.receipt-thumb');
    const title = document.getElementById('form-title').value;
    const amount = document.getElementById('form-amount').value;
    const dataUrl = currentReceipt ? currentReceipt.dataUrl : null;
    const sourceIsBlob = currentReceipt ? typeof currentReceipt.source === 'undefined' : null;
    document.getElementById('form-title').value = title || 'PDF bill';
    if (!amount) document.getElementById('form-amount').value = '40.05';
    await saveItem('spend');
    await new Promise((r) => setTimeout(r, 500));
    const saved = (await getAll('spend')).find((i) => i.receipt);
    return { status, hasThumb: !!thumb, title, amount, isPng: /^data:image\\/png/.test(dataUrl || ''), sourceIsBlob, savedName: saved ? saved.receipt.name : null, storedKeys: saved ? Object.keys(saved.receipt) : null };
  `);

  check('PDF rendered to a preview', out.isPng, out);
  check('thumbnail shown in the form', out.hasThumb, out);
  check('stored receipt keeps only dataUrl/name/addedAt', JSON.stringify(out.storedKeys.sort()) === JSON.stringify(['addedAt', 'dataUrl', 'name']), out);
  check('original filename kept', /spar-bill\.pdf/.test(out.savedName || ''), out);
  check('OCR read the PDF text', /SPAR|Fuel|FUEL/i.test(out.title) && parseFloat(out.amount) === 40.05, out);
  console.log('    status line: ' + JSON.stringify(out.status));

  await run(`currentPage='spend'; renderPage();`);
  await sleep(700);
  await shot('pdf-receipt-row');
  await run(`const id = (await getAll('spend')).find(i => i.receipt).id; openEditModal('spend', id);`);
  await sleep(800);
  await shot('pdf-receipt-edit');
  await run(`openViewer(currentReceipt);`);
  await sleep(600);
  await shot('pdf-receipt-viewer');

  console.log(`\n${pass} passed, ${fail} failed`);
  return fail;
}

// Teardown in the same order as everywhere else: close the session (which is
// what makes chrome exit), then let withDriver stop the driver, then exit.
// process.exit() inside the try would skip the session close — the exact leak
// this replaces, where a failed run left a browser alive.
let exitCode = 1;
withDriver(async ({ base, driver }) => {
  // See test.js: the port is not accepting the moment the driver is spawned.
  await driver.ready;
  let failures = 1;
  try {
    failures = await runSuite(base);
  } finally {
    for (const id of openedSessions.splice(0)) {
      try { await fetch(`${base}/session/${id}`, { method: 'DELETE' }); }
      catch (err) { /* the driver is going away anyway */ }
    }
  }
  exitCode = failures ? 1 : 0;
}).catch((e) => {
  console.error(e);
  exitCode = e && e.code === 'STALE_BROWSERS' ? 2 : 1;
}).finally(() => {
  process.exit(exitCode);
});
