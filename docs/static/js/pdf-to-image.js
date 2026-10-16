/* =============================================================================
   pdf-to-image.js
   Converts a PDF's first page to a PNG blob, so it can go through the exact
   same OCR pipeline as a photographed receipt. Self-hosted pdf.js, pinned
   to 3.11.174 (plain-script build, not ESM) — see item-form.js for the
   reasoning.

   pdf.js itself is fetched on demand (320KB, and only a PDF receipt needs
   it) — see loadScriptOnce() in utils.js. The workerSrc line therefore can't
   sit at the top of the file any more: it has to wait until pdfjsLib exists.
   ============================================================================= */

async function pdfFirstPageToImageBlob(file) {
  await loadScriptOnce('static/vendor/pdfjs/pdf.min.js');
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'static/vendor/pdfjs/pdf.worker.min.js';

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const page = await pdf.getPage(1);

  const viewport = page.getViewport({ scale: 2 }); // higher scale = better OCR accuracy
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d');

  await page.render({ canvasContext: ctx, viewport }).promise;

  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

// Pure file inspection — no pdf.js needed to answer this, which is why the
// app can decide whether to fetch the library at all.
//
// The name is optional. Everything the app hands here comes from a file input or
// the camera, so it always has one — but a Blob made in code doesn't, and the
// assumption turned "no filename" into a crash inside receipt handling rather
// than a plain "not a PDF".
function isPDF(file) {
  if (!file) return false;
  if (file.type === 'application/pdf') return true;
  const name = String(file.name || '');
  return name.toLowerCase().endsWith('.pdf');
}
