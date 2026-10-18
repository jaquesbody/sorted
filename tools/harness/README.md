# sorted-devtools

Test harness for the Sorted app. Part of the repo and **not part of the app**: it lives
with the other dev tools in `tools/`, Pages never sees it (the site serves `docs/` only,
checked), and nothing here is packaged into the APK.

It used to live in `~/.cache/sorted-devtools/`, which meant that a routine cache clean would
have taken the only thing that verifies the app — including the reason the directory existed
at all. Moved into the repo on 18 Oct 2026, and its paths now hang off its own location
rather than the current directory, so moving it again cannot quietly break the source checks.

## What's here

- `test.js` — the gate. 673 checks, every one of them through the real UI.
- `driver.js` — starts and stops chromedriver. Everything else goes through it.
- `harness.js` — session helpers, for scripts that need a driver outside the suite.
- `leak-check.js` — proves all three teardown paths leave nothing running.
- `screenshots.js` — regenerates the six README shots into `screenshots/`. Its seed
  gives every row its own id, so the output is byte-identical run to run; without
  that, the lists the app does not sort (goals, accounts) came out in a different
  order every time, and a screenshot diff could not tell a real change from a
  shuffle. Two things you should expect in a diff: `settings.png` contains the
  app's version string, so it changes on every release; and every shot contains
  the current month and the days counting down to each bill, so they drift as the
  calendar moves.
- `test-pdf.js`, `test-people.js` — the PDF export, and the people and split suites.
- `ocr-bench.js`, `receipts.js` — the receipt-OCR benchmark and its synthetic receipts.
- `README.md` — this file: the traps, and all of them were paid for.

The one-off `probe-*.js` and `shot-*.js` scripts that used to sit beside these stayed
behind in `~/.cache/sorted-devtools/`. They were scratch, each one written to answer a
single question, and they are not part of the suite.

## Running things

From the repo root:

```
npm test
```

That is `node tools/harness/test.js`. It prints each check, and exits non-zero if any
failed. The screenshots it takes along the way go to `/tmp/opencode/shots` unless you pass
another directory as the first argument.

The suites drive the app through the real UI, so something must be serving `docs/`:

```
python3 -m http.server 8141 --directory docs
```

Also from the repo root. Start it as a tracked background task, **not** with `&`.

## Never background a driver with `&`

`nohup chromedriver --port=9515 >log 2>&1 &` orphans the driver to PID 1. Nothing
owns it, so nothing stops it. This is what happened here: 56 dead headless
browsers, 557 processes, 10.3 GiB RSS, both swap devices full, and the machine
frozen — which also starved the opencode service of the SQLite lock it needed to
boot.

`driver.js` exists so this cannot be done by accident. It starts chromedriver as
a **child of the node process**, on a **random free port**, and stops it in a
`finally`. Do not start one yourself.

## Teardown order matters

1. Close the browser session — this is what makes chrome exit.
2. Stop the driver.
3. Exit.

Killing the driver first leaves the browser orphaned to init. Calling
`process.exit()` *inside* the try skips the session close, which was the original
leak: the suite deleted its session only on the success path, so
`main().catch(...)` and every failed run left a browser behind.

`leak-check.js` proves all three paths — normal, thrown error, and a hard
`process.exit(1)` with a session open. All leave nothing running:

```
node leak-check.js normal   # -> 0 browsers
node leak-check.js throw
node leak-check.js exit
```

## Ports are per-run

Port 9515 was a shared singleton. Two concurrent runs meant the second failed to
bind, failed the suite, and leaked through the path above. Each run now takes a
kernel-assigned free port, so concurrent runs cannot collide.

## Check before a heavy run

`driver.js` runs a preflight before starting and **refuses** if too many browser
processes or too much RSS are already there, printing what it found. The failure
mode here is invisible until it is catastrophic, so it is worth a look before
each run:

```
free -h
pgrep -c -x chromium
```

It reports and refuses. It does not kill anything: a browser belonging to Brave,
to OpenCode's Electron, or to anything else is not ours to reap.

**`pgrep -x chromium`, not `pgrep -f chromium`.** A full-command-line match also
matches OpenCode's crashpad handler, the user's Brave, and any shell that merely
mentions the word — including the one running the check. That reported a leak when
there was none, and would have refused a healthy run.

## Check `/tmp` too, and this one is not optional

`/tmp` is a tmpfs on this machine: memory-backed, 3.9 GB, and shared with everything else that
uses it. A browser that is **killed** rather than closed never removes its profile directory,
and each one is about 140 MB. Fifty of them had quietly filled the filesystem to 80%, and the
next run died part-way through with this, from the browser's own IndexedDB:

```
FILE_ERROR_FAILED (ChromeMethodBFE: 3::WritableFileAppend::1)
```

That reads exactly like a bug in the app — the suite stops mid-way, several hundred checks in,
with a stack trace — and it is not one. `timeout 60 node test.js` leaves a profile behind every
time it fires, which is how they accumulated. Check before blaming the code:

```
df -h /tmp
ls -d /tmp/org.chromium.Chromium.scoped_dir.* 2>/dev/null | wc -l
```

They are safe to delete once no browser is running: each one belongs to a browser that is
already gone. Do not kill a run to tidy up — let it finish, or the tidying makes more of them.

## The traps in here, all of them paid for

- **`\s` inside a `run()` template literal loses its backslash.** `\s`→`s`,
  `\d`→`d`, `\w`→`w`. A regex written that way still parses and matches nothing,
  so the check passes vacuously. Write `\\s`. There is a guard
  (`no regex in a run() block relies on an eaten backslash`) that has caught
  three of these, including one of its own and one in a test written to check it.
- **A backslash in an inline handler is invisible.** A misspelt function name is
  swallowed by the `try/catch` and shown as a toast, so only clicking it on a
  phone reveals it. Guarded by
  `every function an inline handler calls actually exists`.
- **A function defined in two of the scripts is silently the later one.** Plain
  `<script defer>` tags share a global scope. Guarded by
  `no name is declared in two script files`.
- **A stub left installed poisons every later test.** `captureStubs()` runs once
  before any test can replace anything; tests needing real behaviour call
  `restoreStubs()` first.
- **One page is one template, so a single undefined name blanks the whole page.**
  Hence `every page renders, on a near-empty database too`.
- **Exact-number assertions over a shared database are fragile.** Assert
  relationships.
- **Fixed sleeps are flaky.** The rapid-switch test read the page after 110ms,
  shorter than Reports takes to draw a chart, and intermittently reported the
  previous page — indistinguishable from the real bug it guards. Wait for the
  page instead.

## Before finishing a session

Kill the static server. Confirm nothing is left running:

```
pgrep -a -x chromedriver
pgrep -c -x chromium
```