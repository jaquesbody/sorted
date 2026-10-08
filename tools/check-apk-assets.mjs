#!/usr/bin/env node
/*
 * Everything the app fetches has to actually be in the APK, under the name it
 * is fetched by.
 *
 * This exists because aapt2 renames assets. Any file whose name ends in .gz is
 * gunzipped and loses the extension, so docs/static/vendor/tesseract/lang/
 * eng.traineddata.gz is shipped as eng.traineddata, decompressed. The app
 * asked for the .gz name and got a 404 — on the web it worked, in the build it
 * did not, and the failure looked exactly like an unreadable receipt. Three
 * releases were spent on that.
 *
 * It is not enough for the bytes to be somewhere in the archive. The URL the
 * app fetches is what matters, so that is what is asserted.
 *
 *   node tools/check-apk-assets.mjs [path-to-apk]
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const apk = resolve(root, process.argv[2] || 'sorted-v2-latest-debug.apk');

// Where the app fetches anything from itself. Relative to the app root, so the
// same list describes the web build and the APK.
const FETCHED = [
  'static/vendor/tesseract/lang/eng.traineddata.gz',
  'static/vendor/tesseract/lang/eng.traineddata',
];

// Assets the app loads by tag rather than by URL. These are only checked for
// presence under the name on disk, because nothing fetches them.
const LOADED_BY_TAG = [
  'static/vendor/tesseract/tesseract.min.js',
  'static/vendor/tesseract/worker.min.js',
  'static/vendor/tesseract/core/tesseract-core-lstm.wasm.js',
  'static/vendor/tesseract/core/tesseract-core-lstm.wasm',
];

if (!existsSync(apk)) {
  console.error(`no APK at ${apk} — pass one, or copy the build output here`);
  process.exit(1);
}

const listing = execFileSync('unzip', ['-Z1', apk], { encoding: 'utf8', maxBuffer: 1 << 28 });
const inApk = new Set(listing.split('\n').filter(Boolean));

const shipped = join(root, 'docs');
const inRepo = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else inRepo.push(relative(shipped, full));
  }
})(shipped);

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? '  PASS  ' : '  FAIL  '}${name}${ok || !detail ? '' : ' -> ' + detail}`);
  if (!ok) failed++;
};

// 1. At least one of the names the app asks for has to be in the APK, under
//    that exact path. aapt2 will have renamed the other, and the app falls back
//    to it, so "all of them" is not the test — "none of them" is the fault.
const resolvable = FETCHED.filter((rel) => inApk.has(`assets/public/${rel}`));
check('the app can fetch its language under a name the build kept',
  resolvable.length > 0, `none of ${FETCHED.join(', ')} is in the APK`);
for (const rel of FETCHED) {
  const kept = inApk.has(`assets/public/${rel}`);
  if (!kept) {
    console.log(`        (note: ${rel} was renamed by aapt2; the app tries ${rel.replace(/\.gz$/, '')} too)`);
  }
}

// 2. Everything loaded by tag must still be there under its own name.
for (const rel of LOADED_BY_TAG) {
  check(`the load-by-tag asset ${rel} is unchanged`, inApk.has(`assets/public/${rel}`));
}

// 3. And nothing the app ships may have been renamed by the build without the
//    app knowing — the whole point is that the two lists agree.
const renamed = [];
for (const rel of inRepo) {
  if (!inApk.has(`assets/public/${rel}`)) renamed.push(rel);
}
if (renamed.length) {
  // Only a rename is a fault here. A file the build dropped would already have
  // failed one of the checks above, and the list is long.
  const renames = renamed.filter((rel) => inApk.has(`assets/public/${rel.replace(/\.gz$/, '')}`));
  check('the build renamed no asset the app fetches by name',
    renames.every((rel) => FETCHED.some((f) => f === rel)),
    `renamed by the build: ${renames.join(', ') || 'none'}`);
} else {
  check('the build renamed no asset the app fetches by name', true);
}

// 4. The fetched file must be big enough to be the language, not an error page.
const lang = FETCHED.find((f) => inApk.has(`assets/public/${f}`));
if (lang) {
  const size = Number(
    (execFileSync('unzip', ['-l', apk, `assets/public/${lang}`], { encoding: 'utf8' })
      .split('\n').find((l) => l.includes('assets/public')) || '')
      .trim().split(/\s+/)[0] || '0'
  );
  check(`${lang} is the whole file`, size > 500000, `${size} bytes`);
}

console.log(`\n${failed} failed`);
process.exit(failed ? 1 : 0);
