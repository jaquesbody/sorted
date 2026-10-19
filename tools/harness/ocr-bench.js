// Measures OCR accuracy against receipts we drew, so the answer is known.
//
// Four layouts, each chosen to break the current guesser in a different way,
// rendered at three difficulties. Reports the AMOUNT, because that is the field
// people get wrong: a receipt carries several plausible numbers and the old
// fallback takes the largest on the page.
//
// The drawing happens inside the page because the OCR lives there. Node sends
// fixtures and difficulty options as JSON and reads results back as JSON — no
// variables cross the boundary by accident, which is what went wrong three times.
const { session, sleep } = require('./harness');
const { RECEIPTS, DIFFICULTIES } = require('./receipts');

(async () => {
  const s = await session();
  await s.open('http://127.0.0.1:8141/index.html');

  // OCR_NOPRE=1 bypasses preprocessing, so the two runs differ only in that and
  // the difference is the preprocessing's own doing.
  if (process.env.OCR_NOPRE) {
    await s.run('window.preprocessForOCR = (f) => f; return 1;');
    console.log('(preprocessing DISABLED for this run)');
  }
  if (process.env.OCR_NOBIN) {
    await s.run('window.__OCR_NO_BINARISE = true; return 1;');
    console.log('(binarisation DISABLED, upscaling only)');
  }

  await s.run(`
    window.__fixtures = ${JSON.stringify(RECEIPTS)};
    window.__opts = ${JSON.stringify(DIFFICULTIES.map((d) => ({ key: d.key, opts: d.opts })))};

    window.__draw = (spec, opts) => {
      opts = opts || {};
      const W = opts.width || 760;
      const pad = opts.pad || 40;
      const lineGap = opts.lineGap || 30;
      const tilt = opts.tilt || 0;
      const scale = opts.scale || 1;
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = pad * 2 + spec.lines.length * lineGap + 20;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#f6f3ea';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((tilt * Math.PI) / 180);
      ctx.translate(-canvas.width / 2, -canvas.height / 2);
      const split = new RegExp('^(.*?)(\\\\s{2,})(\\\\S+)$');
      spec.lines.forEach((line, i) => {
        const size = line.size * scale;
        ctx.font = (line.bold ? '700' : '400') + ' ' + size + 'px Georgia, serif';
        ctx.fillStyle = line.bold ? '#141414' : '#2b2b2b';
        const y = pad + 24 + i * (lineGap * scale);
        const m = split.exec(line.text);
        if (m) {
          ctx.textAlign = 'left';
          ctx.fillText(m[1].trimEnd(), pad, y);
          ctx.textAlign = 'right';
          ctx.fillText(m[3], canvas.width - pad, y);
          ctx.textAlign = 'left';
        } else {
          ctx.fillText(line.text, pad, y);
        }
      });
      const grad = ctx.createLinearGradient(0, 0, canvas.width * 0.4, canvas.height);
      grad.addColorStop(0, 'rgba(0,0,0,0.10)');
      grad.addColorStop(0.55, 'rgba(0,0,0,0)');
      grad.addColorStop(1, 'rgba(0,0,0,0.07)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
      return canvas;
    };

    // One receipt, one difficulty, through the real pipeline.
    window.__runOne = async (name, opts) => {
      const spec = window.__fixtures.find((f) => f.name === name);
      if (!spec) return { name: name, fatal: 'fixture missing' };
      const canvas = window.__draw(spec, opts);
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
      // A real File has a name; a bare Blob doesn't, and isPDF() would rather
      // know that than assume it.
      const file = new File([blob], name + '.png', { type: 'image/png' });
      const prepared = await prepareReceipt(file);
      const text = await runOCRWithTimeout(prepared.source, () => {});
      const amount = guessAmountFromText(text);
      const title = guessTitleFromText(text);
      const date = guessDateFromText(text);
      const squash = (t) => String(t || '').replace(/\\s+/g, ' ').trim();
      return {
        name: name,
        want: spec.amount,
        got: amount,
        amountOk: Math.abs(amount - spec.amount) < 0.005,
        wantTitle: spec.title,
        gotTitle: title,
        titleOk: squash(title).toLowerCase().indexOf(squash(spec.title).split(' ')[0].toLowerCase()) >= 0,
        wantDate: spec.date,
        gotDate: date,
        dateOk: spec.date ? date === spec.date : true,
        text: squash(text)
      };
    };
    return 1;
  `);

  const rows = [];
  for (const spec of RECEIPTS) {
    for (const diff of DIFFICULTIES) {
      const r = await s.run(`
        return await window.__runOne(${JSON.stringify(spec.name)}, ${JSON.stringify(diff.opts)});`);
      if (r.fatal) { console.log('FATAL', spec.name, diff.key, r.fatal); continue; }
      rows.push(Object.assign({ difficulty: diff.key }, r));
    }
  }

  for (const r of rows) {
    console.log(`${r.amountOk ? 'ok  ' : 'FAIL'} ${r.name.padEnd(26)} ${r.difficulty.padEnd(13)}`
      + ` want ${String(r.want).padEnd(7)} got ${r.got}`);
  }

  const n = rows.length;
  const pct = (k) => (n ? Math.round((rows.filter(k).length / n) * 100) : 0);
  console.log(`\nAMOUNT ${rows.filter((r) => r.amountOk).length}/${n}  (${pct((r) => r.amountOk)}%)`);
  console.log(`TITLE  ${rows.filter((r) => r.titleOk).length}/${n}  (${pct((r) => r.titleOk)}%)`);
  console.log(`DATE   ${rows.filter((r) => r.dateOk).length}/${n}  (${pct((r) => r.dateOk)}%)`);

  const bad = rows.filter((r) => !r.amountOk);
  if (bad.length) {
    console.log('\nwhere the amount went wrong:');
    for (const r of bad) {
      console.log(`  ${r.name} / ${r.difficulty}: want ${r.want}, got ${r.got}`);
      console.log(`     ${r.text.slice(0, 150)}`);
    }
  }

  require('fs').writeFileSync(
    process.env.OCR_OUT || '/tmp/ocr-baseline.json',
    JSON.stringify(rows, null, 1));
  console.log('\nsaved to', process.env.OCR_OUT || '/tmp/ocr-baseline.json');

  await s.close();
})();
