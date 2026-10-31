// A receipt, drawn rather than downloaded, so the amount and merchant are known
// exactly and the accuracy number means something.
//
// Deliberately awkward in the ways real photos are: slight rotation, uneven
// lighting, a paper tint, JPEG-ish softness. A perfectly crisp synthetic image
// flatters Tesseract and would hide the preprocessing work.
const RECEIPTS = [
  {
    name: 'grocery-total-line',
    // The classic trap: "TOTAL" with the amount on the line below, so a naive
    // line-scanner never links them.
    lines: [
      { text: 'CO-OP FOOD', size: 34, bold: true },
      { text: '123 High Street', size: 18 },
      { text: '2 Oct 2026  14:32', size: 18 },
      { text: 'Semi-skimmed milk   x2    1.75', size: 18 },
      { text: 'Sourdough loaf             2.40', size: 18 },
      { text: 'Free range eggs     x6    2.10', size: 18 },
      { text: 'Coffee beans 250g          6.99', size: 18 },
      { text: 'SUBTOTAL                 13.24', size: 18 },
      { text: 'TOTAL', size: 26, bold: true },
      { text: '13.24', size: 26, bold: true },
    ],
    amount: 13.24,
    title: 'CO-OP FOOD',
    date: '2026-10-02',
  },
  {
    name: 'vat-inclusive-total',
    // Big number elsewhere on the receipt: a loyalty balance and a card number.
    // The old fallback takes the largest number on the page, which is wrong.
    lines: [
      { text: 'BRIGHTON PHARMACY', size: 32, bold: true },
      { text: 'Card **** **** **** 4471', size: 18 },
      { text: 'Loyalty points balance   2840', size: 18 },
      { text: 'Ibuprofen 200mg          3.99', size: 18 },
      { text: 'Vitamin D                4.50', size: 18 },
      { text: 'Plasters                 2.49', size: 18 },
      { text: 'TOTAL DUE              10.98', size: 26, bold: true },
      { text: 'Includes VAT 20p        1.83', size: 18 },
    ],
    amount: 10.98,
    title: 'BRIGHTON PHARMACY',
    date: null,
  },
  {
    name: 'amount-to-the-left-of-total',
    // The other common layout: label left, figure right, same line.
    lines: [
      { text: 'SAINSBURYS', size: 34, bold: true },
      { text: '2 October 2026', size: 18 },
      { text: 'Chicken thighs           4.15', size: 18 },
      { text: 'Rice 1kg                  2.20', size: 18 },
      { text: 'Tinned tomatoes   x4      1.40', size: 18 },
      { text: 'Kitchen roll             0.85', size: 18 },
      { text: 'AMOUNT     8.60', size: 24, bold: true },
      { text: 'CASH      10.00', size: 18 },
      { text: 'CHANGE     1.40', size: 18 },
    ],
    amount: 8.60,
    title: 'SAINSBURYS',
    date: '2026-10-02',
  },
  {
    name: 'no-currency-symbol',
    // Some receipts print bare figures with no symbol anywhere near them.
    lines: [
      { text: 'NATIONAL RAIL', size: 30, bold: true },
      { text: 'London Victoria', size: 18 },
      { text: 'Off-Peak Single     12.40', size: 18 },
      { text: 'Seat Reservation      2.60', size: 18 },
      { text: 'Booking Fee           1.00', size: 18 },
      { text: 'Total Paid          16.00', size: 26, bold: true },
    ],
    amount: 16.00,
    title: 'NATIONAL RAIL',
    date: null,
  },
];

async function drawReceipt(spec, opts = {}) {
  const W = opts.width || 760;
  const pad = opts.pad || 40;
  const lineGap = opts.lineGap || 30;
  const tilt = opts.tilt || 0;          // degrees
  const scale = opts.scale || 1;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = pad * 2 + spec.lines.length * lineGap + 20;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#f6f3ea';                      // paper, not white
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((tilt * Math.PI) / 180);
  ctx.translate(-canvas.width / 2, -canvas.height / 2);

  spec.lines.forEach((line, i) => {
    const size = line.size * scale;
    ctx.font = `${line.bold ? '700' : '400'} ${size}px Georgia, serif`;
    ctx.fillStyle = line.bold ? '#141414' : '#2b2b2b';
    const y = pad + 24 + i * (lineGap * scale);
    // Right-align anything with a wide gap, the way a till prints it.
    const m = line.text.match(/^(.*?)(\s{2,})(\S+)$/);
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

  // A soft gradient down the page: the shadow you get photographing paper.
  const grad = ctx.createLinearGradient(0, 0, canvas.width * 0.4, canvas.height);
  grad.addColorStop(0, 'rgba(0,0,0,0.10)');
  grad.addColorStop(0.55, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.07)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.restore();

  return canvas;
}

if (typeof module !== 'undefined') {
  module.exports = { RECEIPTS, drawReceipt };
}

// Three renderings of the same receipt, so the number isn't flattered by a
// perfectly crisp synthetic image that hides the preprocessing work.
const DIFFICULTIES = [
  { key: 'crisp', opts: {} },
  { key: 'tilted', opts: { tilt: 1.6 } },
  { key: 'small+tilted', opts: { tilt: 2.4, scale: 0.72, width: 560 } },
];

module.exports.DIFFICULTIES = DIFFICULTIES;
