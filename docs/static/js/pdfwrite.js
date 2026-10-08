// A PDF writer.
//
// Sorted ships no PDF library. The only PDF code in this app reads receipts
// (pdf-to-image.js); nothing could write one. "Save Report" and the PDF option
// in Export both need a file that a phone can hand to the share sheet while
// offline, and the two alternatives were worse: bundling a library for a format
// this simple, or deferring to `window.print()` — which leaves the app's own
// share flow, opens a dialog instead, and whose behaviour in an Android WebView
// would have to be taken on trust rather than tested.
//
// So this writes the file itself: PDF 1.4, four objects plus two per page, no
// compression, Helvetica from the base-14 set so nothing has to be embedded or
// licensed. Everything here is bytes it wrote deliberately.
//
// Three things are load-bearing and easy to get quietly wrong:
//
//  - Every byte matters twice. Object offsets are byte offsets, and the xref
//    table is what lets a reader find anything, so the writer counts bytes and
//    the stream Length is the length of the stream. Both hold only because
//    every string that reaches the file has already been folded into single
//    bytes (see pdfWinAnsi) — a Unicode é would make `.length` and the file's
//    size disagree by one, and the reader would trust the smaller one.
//
//  - Text is WinAnsi, not Unicode. A PDF string is a byte string, so the
//    characters a person types — £, ·, —, ', " — have to be mapped to their
//    WinAnsi codes rather than passed through. Anything outside that table
//    becomes '?', because a wrong character is better than a corrupt file.
//
//  - Widths are measured, not guessed. Helvetica's AFM widths are carried here
//    for ASCII, which is what lets a right-aligned amount actually land on the
//    right margin and lets a label be shortened before it overruns its column
//    instead of after.

// Helvetica and Helvetica-Bold, AFM widths in 1/1000 em, characters 32..126.
// Split into numbers, not left as strings: pdfWidthOf indexes these by
// character code, and `Number(str[i])` over "278 278 355 …" returns 2 — a
// fiftieth of the real width. Right-aligned amounts then stopped short of the
// right margin and the chart's legend labels collided with the swatch after
// them, both by an amount that looked like sloppy layout rather than like a
// table being read one character at a time.
const PDF_HELV = ('278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 '
  + '556 556 556 556 556 556 556 556 556 556 278 278 584 584 584 556 '
  + '1015 667 667 722 722 667 611 778 722 278 500 667 556 833 722 778 '
  + '667 778 722 667 611 722 667 944 667 667 611 278 278 278 469 556 '
  + '333 556 556 500 556 556 278 556 556 222 222 500 222 833 556 556 '
  + '556 556 333 500 278 556 500 722 500 500 500 334 260 334 584')
  .trim().split(/\s+/).map(Number);
const PDF_HELV_B = ('278 333 474 556 556 889 722 238 333 333 389 584 278 333 278 278 '
  + '556 556 556 556 556 556 556 556 556 556 333 333 584 584 584 611 '
  + '975 722 722 722 722 667 611 778 722 278 556 722 611 833 722 778 '
  + '667 778 722 667 611 722 667 944 667 667 611 333 278 333 584 556 '
  + '333 556 611 556 611 556 333 611 611 278 278 556 278 889 611 611 '
  + '611 611 389 556 333 611 556 778 556 556 500 389 280 389 584')
  .trim().split(/\s+/).map(Number);

// Characters the fonts carry outside ASCII: [regular, bold].
const PDF_SPEC_W = {
  0x00a3: [556, 556],   // £
  0x00b7: [278, 278],   // ·
  0x2013: [556, 556],   // –
  0x2014: [1000, 1000], // —
  0x2018: [222, 238],   // '
  0x2019: [222, 238],   // '
  0x201c: [333, 333],   // "
  0x201d: [333, 333],   // "
  0x2022: [350, 350],   // •
  0x2026: [1000, 1000], // …
  0x20ac: [556, 556],   // €
  0x2122: [1000, 1000]  // ™
};

// Unicode → WinAnsi byte. Latin-1 passes through unchanged, which covers every
// currency symbol this app can print except the euro; the typographic quotes,
// dashes and ellipsis a person's own descriptions use are listed by hand.
function pdfWinAnsiByte(cp) {
  if (cp < 128 || (cp >= 0xa0 && cp <= 0xff)) return cp;
  switch (cp) {
    case 0x20ac: return 0x80;
    case 0x201a: return 0x82;
    case 0x201e: return 0x84;
    case 0x2026: return 0x85;
    case 0x2020: return 0x86;
    case 0x2021: return 0x87;
    case 0x2030: return 0x89;
    case 0x0160: return 0x8a;
    case 0x2039: return 0x8b;
    case 0x0152: return 0x8c;
    case 0x017d: return 0x8e;
    case 0x2018: return 0x91;
    case 0x2019: return 0x92;
    case 0x201c: return 0x93;
    case 0x201d: return 0x94;
    case 0x2022: return 0x95;
    case 0x2013: return 0x96;
    case 0x2014: return 0x97;
    case 0x2122: return 0x99;
    case 0x0161: return 0x9a;
    case 0x203a: return 0x9b;
    case 0x0153: return 0x9c;
    case 0x017e: return 0x9e;
    case 0x0178: return 0x9f;
    default: return 0x3f; // '?'
  }
}

function pdfWidthOf(str, size, bold) {
  const table = bold ? PDF_HELV_B : PDF_HELV;
  let units = 0;
  for (const ch of String(str)) {
    const cp = ch.codePointAt(0);
    if (cp >= 32 && cp <= 126) {
      units += Number(table[cp - 32]);
    } else {
      const spec = PDF_SPEC_W[cp];
      units += spec ? spec[bold ? 1 : 0] : 556;
    }
  }
  return units * size / 1000;
}

// Byte string, escaped for a PDF literal string.
function pdfEsc(str) {
  let out = '';
  for (const ch of String(str)) out += String.fromCharCode(pdfWinAnsiByte(ch.codePointAt(0)));
  return out.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

const pdfN = (n) => (Math.round(Number(n) * 100) / 100).toString();

// --- The document -----------------------------------------------------------

function PdfDoc(opts) {
  const o = opts || {};
  const doc = {
    w: o.w || 595.28, h: o.h || 841.89, // A4 portrait in points
    ml: o.ml || 46, mr: o.mr || 46, mt: o.mt || 46, mb: o.mb || 46,
    pages: [],
    y: 0
  };
  pdfNewPage(doc);
  return doc;
}

function pdfNewPage(doc) {
  doc.pages.push({ ops: [] });
  doc.y = doc.mt;
}

function pdfOps(doc) { return doc.pages[doc.pages.length - 1].ops; }

// Open a page only when something will actually be drawn on it: a heading that
// would be the last thing before a break must not leave one behind.
function pdfNeed(doc, height) {
  if (doc.y + height > doc.h - doc.mb) pdfNewPage(doc);
}

function pdfSpace(doc, height) {
  pdfNeed(doc, height);
  doc.y += height;
}

// opts: size, bold, color [r,g,b], x, right, maxWidth, lead, indent, caps
function pdfText(doc, text, opts) {
  const o = opts || {};
  const size = o.size || 10;
  const bold = !!o.bold;
  const lead = o.lead || Math.round(size * 1.45);
  const color = o.color || [0.13, 0.13, 0.16];
  pdfNeed(doc, lead);

  let str = String(text == null ? '' : text);
  let width = pdfWidthOf(str, size, bold);
  const max = o.maxWidth;
  if (max && width > max) {
    // Shorten to fit, ellipsis included in the measurement so it cannot be the
    // thing that overruns.
    let cut = str;
    while (cut.length > 1 && pdfWidthOf(cut + '…', size, bold) > max) cut = cut.slice(0, -1);
    str = cut.replace(/\s+$/, '') + '…';
    width = pdfWidthOf(str, size, bold);
  }

  const left = o.x != null ? o.x : doc.ml;
  const x = o.right != null ? o.right - width : left;
  const baseline = doc.y + size;
  const font = bold ? '/F2' : '/F1';
  pdfOps(doc).push(
    `BT ${font} ${pdfN(size)} Tf ${color.map(pdfN).join(' ')} rg `
    + `1 0 0 1 ${pdfN(x)} ${pdfN(doc.h - baseline)} Tm (${pdfEsc(str)}) Tj ET`);
  doc.y += lead;
  return width;
}

// A filled bar from x for `width`, at the cursor. Bars are drawn in the same
// units as the text above them, so a row's label and its bar share a baseline
// without any measurement of the font.
function pdfBar(doc, x, top, width, height, color) {
  if (width <= 0) return;
  pdfOps(doc).push(
    `${color.map(pdfN).join(' ')} rg ${pdfN(x)} ${pdfN(doc.h - top - height)} `
    + `${pdfN(width)} ${pdfN(height)} re f`);
}

function pdfRule(doc, opts) {
  const o = opts || {};
  const y = doc.y + (o.dy || 0);
  pdfOps(doc).push(
    `${(o.color || [0.8, 0.8, 0.84]).map(pdfN).join(' ')} RG ${pdfN(o.width || 0.6)} w `
    + `${pdfN(o.x1 != null ? o.x1 : doc.ml)} ${pdfN(doc.h - y)} m `
    + `${pdfN(o.x2 != null ? o.x2 : doc.w - doc.mr)} ${pdfN(doc.h - y)} l S`);
}

function pdfPolyline(doc, points, color, width) {
  if (points.length < 2) return;
  const c = color.map(pdfN).join(' ');
  let s = `${c} RG ${pdfN(width || 1)} w`;
  points.forEach((p, i) => {
    s += ` ${pdfN(p[0])} ${pdfN(doc.h - p[1])} ${i === 0 ? 'm' : 'l'}`;
  });
  pdfOps(doc).push(s + ' S');
}

// The forecast chart, redrawn rather than photographed: four series over the
// window, gridlines at round figures, axis labels down the left. The on-screen
// version reads its colours out of the stylesheet so it follows the theme; a
// PDF has no theme, so it uses the light values it will be printed against.
function pdfChart(doc, series, opts) {
  const o = opts || {};
  const boxH = o.height || 150;
  // Chart, axis gutter, axis labels, legend — reserved up front so nothing in
  // the middle of it can open a page and leave half a chart behind on the
  // previous one. 60 rather than the 34 it strictly needs, because the legend
  // sits below the plot and its own line is part of what has to fit.
  pdfNeed(doc, boxH + 60);
  if (!series.length) { doc.y += boxH + 34; return; }

  const top = doc.y + 14;
  const x0 = doc.ml + 44;
  const x1 = doc.w - doc.mr;
  const plotH = boxH;

  const values = [];
  for (const p of series) values.push(p.balance, p.costs, p.spend, p.bills);
  let min = Math.min(0, ...values);
  let max = Math.max(0, ...values);
  if (max === min) max = min + 1;
  let step = max >= 1500 ? 1000 : Math.max(1, (max - min) / 5);
  while ((max - min) / step > 10) step *= 2;
  if (step < 1) step = 1;
  max = Math.ceil(max * 1.04 / step) * step;
  min = Math.floor(min / step) * step;
  if (max - min < step) max = min + step * 2;

  const yAt = (v) => top + plotH - ((v - min) / (max - min)) * plotH;
  const xAt = (i) => series.length === 1
    ? (x0 + x1) / 2
    : x0 + (i / (series.length - 1)) * (x1 - x0);

  const savedY = doc.y;
  for (let v = min; v <= max + 0.5; v += step) {
    const py = yAt(v);
    pdfRule(doc, {
      x1: x0, x2: x1, dy: py - doc.y, width: Math.abs(v) < 0.5 ? 0.8 : 0.4,
      color: Math.abs(v) < 0.5 ? [0.6, 0.6, 0.66] : [0.87, 0.87, 0.9]
    });
    // The label sits beside its line rather than on the cursor: pdfRule does
    // not move the cursor, and this is a measurement, not a row of text.
    const neg = v < 0;
    const mag = Math.abs(v);
    const label = (neg ? '-' : '')
      + (mag >= 1000 ? `£${Math.round(mag / 100) / 10}k` : `£${Math.round(mag)}`);
    doc.y = py - 5;
    pdfText(doc, label, { size: 7, right: x0 - 6, color: [0.45, 0.45, 0.5], lead: 10 });
    doc.y = savedY;
  }

  const keys = [
    ['balance', [0.13, 0.77, 0.37], 1.4],
    ['costs', [0.94, 0.27, 0.27], 1.4],
    ['spend', [0.24, 0.55, 0.99], 1],
    ['bills', [0.94, 0.27, 0.27], 1]
  ];
  for (const [field, color, width] of keys) {
    pdfPolyline(doc, series.map((p, i) => [xAt(i), yAt(Number(p[field]) || 0)]), color, width);
  }

  const legendY = top + plotH + 8;
  const legend = ['Total money', 'Total est costs', 'Spent', 'Bills'];
  const colors = [[0.13, 0.77, 0.37], [0.94, 0.27, 0.27], [0.24, 0.55, 0.99], [0.94, 0.27, 0.27]];
  let lx = x0;
  legend.forEach((label, i) => {
    // The cursor is reset each time: pdfText advances it, and a legend is one
    // row of swatches, not a stack of them.
    doc.y = legendY;
    pdfBar(doc, lx, legendY + 1, 8, 8, colors[i]);
    pdfText(doc, label, { size: 7, x: lx + 11, color: [0.35, 0.35, 0.4], lead: 11 });
    lx += 11 + pdfWidthOf(label, 7, false) + 12;
  });
  doc.y = legendY + 16;
}

function pdfBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  }
  return btoa(s);
}

// --- Assembly ---------------------------------------------------------------

function pdfBytes(doc) {
  const parts = [];
  let off = 0;
  // Every string pushed here has been through pdfEsc or is pure ASCII, so one
  // character is one byte and `off` is a real file offset.
  const W = (s) => { parts.push(s); off += s.length; };
  const offs = [];
  const obj = (n, body) => { offs[n] = off; W(`${n} 0 obj\n${body}\nendobj\n`); };

  W('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const count = 4 + 2 * doc.pages.length;
  const kids = [];
  for (let i = 0; i < doc.pages.length; i++) kids.push(5 + 2 * i);

  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${kids.map((n) => n + ' 0 R').join(' ')}] /Count ${doc.pages.length} >>`);
  obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  obj(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

  for (let i = 0; i < doc.pages.length; i++) {
    const pn = 5 + 2 * i;
    const cn = 6 + 2 * i;
    obj(pn, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pdfN(doc.w)} ${pdfN(doc.h)}] `
      + `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${cn} 0 R >>`);
    const stream = doc.pages[i].ops.join('\n');
    obj(cn, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }

  const xref = off;
  W(`xref\n0 ${count + 1}\n`);
  W('0000000000 65535 f \n');
  for (let n = 1; n <= count; n++) W(`${String(offs[n]).padStart(10, '0')} 00000 n \n`);
  W(`trailer\n<< /Size ${count + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const bytes = new Uint8Array(off);
  for (let i = 0, p = 0; i < parts.length; i++) {
    const s = parts[i];
    for (let j = 0; j < s.length; j++) bytes[p++] = s.charCodeAt(j) & 0xff;
  }
  return bytes;
}
