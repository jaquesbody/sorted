// Functional checks: drive the real UI and assert on the results.
const fs = require('fs');
const path = require('path');
const { withDriver } = require('./driver');

// The harness lives in the repo, at tools/harness/, and three of these checks
// read the app's own source rather than the running page: the duplicate-name
// and undeclared-name checks read docs/static/js/, the Capacitor check compares
// docs/capacitor.js against the installed dependency, and the stylesheet check
// parses docs/static/css/main.css. All of them used absolute paths, and one was
// derived from the current directory — which worked only while the harness sat
// in ~/.cache/sorted-devtools, and would have failed silently after a move.
// Now they hang off the file's own location, so the harness can be moved again.
const REPO = path.join(__dirname, '..', '..');

const OUT = process.argv[2] || '/tmp/opencode/shots';
const BASE = 'http://127.0.0.1:8141/index.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, extra) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' -> ' + JSON.stringify(extra) : '')); }
};

async function runSuite(driverBase) {
  const caps = {
    capabilities: {
      alwaysMatch: {
        browserName: 'chrome',
        'goog:chromeOptions': {
          binary: '/usr/bin/chromium',
          args: ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
                 '--force-device-scale-factor=2', '--window-size=412,915']
        }
      }
    }
  };
  const res = await fetch(`${driverBase}/session`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(caps)
  });
  const sessionId = (await res.json()).value.sessionId;
  const send = async (p, method, body) => {
    const r = await fetch(`${driverBase}/session/${sessionId}${p}`,
      { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json();
    if (j.value && j.value.error) throw new Error(p + ' -> ' + JSON.stringify(j.value).slice(0, 300));
    return j.value;
  };
  // Registered before anything can throw, so no early return can skip it. This
  // is the line whose absence leaked a browser per failed run.
  const closeSession = async () => {
    try { await fetch(`${driverBase}/session/${sessionId}`, { method: 'DELETE' }); }
    catch (err) { /* the driver is going away anyway */ }
  };
  sessionClosers.push(closeSession);
  const run = async (script) => send('/execute/sync', 'POST', { script: `return (async function(){ ${script} })();`, args: [] });
  const shot = async (name) => {
    const data = await send('/screenshot', 'GET');
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(data, 'base64'));
  };
  // Several tests stub a function to force a branch. A stub left in place makes
  // every later test read the stubbed answer, which is how one test's fixtures
  // became another test's silent false pass. The originals are captured here,
  // once, before any test can replace them, and every test that needs real
  // behaviour calls restoreStubs() first.
  const captureStubs = async () => {
    await run(`
      window.__realFns = window.__realFns || {
        isNotifyEnabled: isNotifyEnabled,
        isSpendNudgeEnabled: isSpendNudgeEnabled,
        isGoalNudgeEnabled: isGoalNudgeEnabled,
        showToast: showToast,
        notificationPermission: notificationPermission
      };
      window.restoreStubs = () => {
        const r = window.__realFns;
        isNotifyEnabled = r.isNotifyEnabled;
        isSpendNudgeEnabled = r.isSpendNudgeEnabled;
        isGoalNudgeEnabled = r.isGoalNudgeEnabled;
        showToast = r.showToast;
        notificationPermission = r.notificationPermission;
        return 1;
      };
      return 1;`);
  };
  const consoleErrors = async () => {
    const logs = await send('/se/log', 'POST', { type: 'browser' });
    return (logs || []).filter((l) => l.level === 'SEVERE').map((l) => l.message);
  };

  await send('/url', 'POST', { url: `${BASE}?native` });
  await sleep(1500);
  await run(`localStorage.clear();`);
  await send('/url', 'POST', { url: `${BASE}?native` });
  // Before anything can stub them.
  await sleep(1200);

  // The first launch is the only moment this is on screen: a fresh install
  // says what it does with your data, once, and remembers that it did. It is
  // the site's notice (jaquesbody.github.io/know) as its own card — wordmark
  // over the top, one button, no modal title bar or close cross.
  console.log('\n# the first launch explains itself');
  const fresh = await run(`
    const notice = document.getElementById('privacy-notice');
    const box = notice ? notice.querySelector('.notice-box') : null;
    const text = box ? box.innerText : '';
    const link = box ? box.querySelector('a') : null;
    const logo = box ? box.querySelector('img.notice-logo') : null;
    const gotIt = box ? [...box.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Got it') : null;
    const probe = document.createElement('span');
    probe.style.color = 'var(--accent)';
    document.body.appendChild(probe);
    const accentRgb = getComputedStyle(probe).color;
    probe.remove();
    return {
      shown: !!notice,
      hasBox: !!box,
      hasLogo: !!logo,
      modalTitle: document.getElementById('modal').classList.contains('active'),
      onTop: notice ? getComputedStyle(notice).position === 'fixed' : false,
      border: box ? getComputedStyle(box).borderTopColor : null,
      accentRgb,
      lead: text.includes('Privately track your spending and saving.'),
      local: text.includes('Sorted stores everything locally.'),
      permission: text.includes('Nothing leaves your device without your permission.'),
      openSource: text.includes('Fully open source.'),
      href: link ? link.getAttribute('href') : null,
      linkText: link ? link.textContent.trim() : null,
      // The link is the accent colour and nothing else: a browser underlines
      // every anchor, and the reference page doesn't have one.
      linkDecoration: link ? getComputedStyle(link).textDecorationLine : null,
      linkColour: link ? getComputedStyle(link).color : null,
      gotIt: !!gotIt,
      // One button, drawn the way the reference draws it.
      gotItColour: gotIt ? getComputedStyle(gotIt).color : null,
      gotItJustify: gotIt ? getComputedStyle(gotIt).justifyContent : null,
      gotItBorder: gotIt ? getComputedStyle(gotIt).borderTopStyle : null,
      gotItWide: gotIt ? Math.round(gotIt.getBoundingClientRect().width) : 0,
      // The button fills the box's content width — the box's own padding is
      // what's between the two, so that's the figure to hold it against.
      contentWidth: box ? Math.round(box.clientWidth
        - parseFloat(getComputedStyle(box).paddingLeft)
        - parseFloat(getComputedStyle(box).paddingRight)) : 0,
      flag: localStorage.getItem('SORTED_PRIVACY_SEEN'),
      accounts: (await getAll('accounts')).length,
    };
  `);
  check('the first launch shows a notice', fresh.shown, fresh);
  check('as the site\'s card — a bordered box with the wordmark, not the modal',
    fresh.hasBox && fresh.hasLogo && fresh.onTop === true
      && fresh.modalTitle === false && fresh.border === fresh.accentRgb, fresh);
  check('that says where the data lives, in full',
    fresh.lead && fresh.local && fresh.permission, fresh);
  check('and that the app is open source, with the link to prove it',
    fresh.openSource && fresh.href === 'https://github.com/jaquesbody/sorted'
      && fresh.linkText === 'Review the code on GitHub', fresh);
  check('with the link unadorned — the accent colour, no underline',
    fresh.linkDecoration === 'none' && fresh.linkColour === fresh.accentRgb, fresh);
  check('with one button to acknowledge', fresh.gotIt, fresh);
  check('drawn as the reference draws it: black, centred, unbordered, full width',
    fresh.gotItColour === 'rgb(0, 0, 0)' && fresh.gotItJustify === 'center'
      && fresh.gotItBorder === 'none' && fresh.gotItWide === fresh.contentWidth, fresh);
  check('and it is remembered, so it shows once', fresh.flag === '1', fresh);
  // The install is the user's, not the app's: nothing is created for them.
  check('a fresh install seeds no accounts', fresh.accounts === 0, fresh);

  const acknowledged = await run(`
    document.querySelector('#privacy-notice button').click();
    return { gone: !document.getElementById('privacy-notice') };
  `);
  check('Got it closes the notice', acknowledged.gone === true, acknowledged);

  // With nothing recorded, the Savings page offers the same way in as the goals
  // list — an empty state with a button — and keeps the transfer button back
  // until there is somewhere to transfer between.
  const emptySavings = await run(`
    currentPage = 'savings';
    await renderPage();
    await new Promise((r) => setTimeout(r, 900));
    const states = [...document.querySelectorAll('.empty-state')].map((e) => ({
      text: e.querySelector('.empty-state-text').textContent.trim(),
      button: e.querySelector('button') ? e.querySelector('button').textContent.trim() : null,
    }));
    return {
      states,
      moveMoney: [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Move money'),
    };
  `);
  const emptyText = (label) => emptySavings.states.find((s) => s.text === label);
  check('a fresh Savings page names the empty Accounts and Income sections',
    !!emptyText('No accounts yet') && !!emptyText('No income recorded'), emptySavings);
  check('each with a button to add the first one',
    emptyText('No accounts yet').button === 'Add first account'
      && emptyText('No income recorded').button === 'Add first income', emptySavings);
  check('and no Move money until there are two accounts',
    emptySavings.moveMoney === false, emptySavings);

  // The suite needs an account to save into, and nothing makes one now — so it
  // makes the account a user makes, once, before the tests that need it. The
  // account block further down takes over from here.
  await run(`
    await addAccount('Cash', 'cash', 0, null);
    await loadAccounts();
  `);

  // The +Spend and +Bill forms refuse to save without an account — that is the
  // point of that change — but their account select opens on "Not from an
  // account", which the form then rejects. A harness block that fills the other
  // fields and saves therefore saves nothing, and the line that reads the row
  // back crashes on `undefined`. Hand every opened form an account to save
  // with; a test that wants to exercise the empty choice sets the field itself,
  // after the modal has opened.
  await run(`
    window.autoSelectAccount = () => {
      const s = document.getElementById('form-account');
      if (!s || s.value) return;
      const opt = [...s.options].find((o) => o.value);
      if (opt) s.value = opt.value;
    };
    const keep = (fn) => async function () {
      const r = await fn.apply(this, arguments);
      window.autoSelectAccount();
      return r;
    };
    openAddModal = keep(openAddModal);
    openEditModal = keep(openEditModal);
    return 1;
  `);
  console.log('\n# one definition per name, across all the scripts');
  // These are plain <script> tags sharing one global scope, and app.js loads
  // last — so a function defined in two of them is not a duplicate the linter
  // notices, it is the *later* file silently winning. That is how the Bills Due
  // switch kept an old copy of its handler that repainted after two bridge
  // calls, undoing the fix made for exactly that, and the switch looked stuck.
  //
  // Checked against the source rather than at runtime: by the time a shadowed
  // declaration loads, the other one is gone and nothing can observe it.
  {
    const SRC = path.join(REPO, 'docs', 'static', 'js');
    const found = {};
    for (const f of fs.readdirSync(SRC).filter((n) => n.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(SRC, f), 'utf8');
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        let m = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(line);
        if (!m) m = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/.exec(line);
        if (m) (found[m[1]] = found[m[1]] || []).push(f + ':' + (i + 1));
      });
    }
    const dups = Object.entries(found).filter(([, v]) => v.length > 1);
    // The committed copy of Capacitor's runtime is the only reason any native
    // plugin works at all. If the dependency moves and this file does not, the
    // app is running one version and calling another — silently, because nothing
    // about the page load changes.
    const committed = path.join(REPO, 'docs', 'capacitor.js');
    const source = path.join(REPO, 'node_modules', '@capacitor', 'core', 'dist', 'capacitor.js');
    let drift = 'ok';
    try {
      if (!fs.existsSync(committed)) drift = 'docs/capacitor.js is missing';
      else if (!fs.existsSync(source)) drift = 'the installed runtime is missing';
      else if (!fs.readFileSync(committed, 'utf8').trim()) drift = 'docs/capacitor.js is empty';
      else if (fs.readFileSync(committed, 'utf8') !== fs.readFileSync(source, 'utf8')) {
        drift = 'docs/capacitor.js differs from the installed @capacitor/core';
      }
    } catch (err) { drift = String((err && err.message) || err); }
    check('the committed Capacitor runtime matches the installed one',
      drift === 'ok', drift);

    check('no name is declared in two script files', dups.length === 0,
      Object.fromEntries(dups));

  // Every name used in an inline handler has to exist. A misspelt one is not a
  // crash: the handlers call into try/catch blocks, so a ReferenceError becomes a
  // toast that says something went wrong and nothing else. "Send a test" shipped
  // that way once — `notificationPermissionGranted` instead of
  // `notifyPermissionGranted` — and nothing but clicking the button on a phone
  // would have shown it. Checked against the source, since by the time a call
  // fails the only evidence is a message nobody reads.
  {
    const SRC = path.join(REPO, 'docs', 'static', 'js');
    const files = fs.readdirSync(SRC).filter((n) => n.endsWith('.js'));
    const declared = new Set();
    for (const f of files) {
      const src = fs.readFileSync(path.join(SRC, f), 'utf8');
      for (const m of src.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) declared.add(m[1]);
      for (const m of src.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm)) declared.add(m[1]);
    }
    // Globals the page provides, and browser/host names, are not ours to check.
    const notOurs = new Set(['window', 'document', 'console', 'setTimeout', 'clearTimeout',
      'setInterval', 'alert', 'confirm', 'prompt', 'fetch', 'Intl', 'JSON', 'Math', 'Date',
      'Object', 'Array', 'Number', 'String', 'Boolean', 'Promise', 'parseInt', 'parseFloat',
      'isNaN', 'encodeURIComponent', 'decodeURIComponent', 'event', 'this', 'require']);
    const called = new Map();
    for (const f of files) {
      const src = fs.readFileSync(path.join(SRC, f), 'utf8');
      // Only inline handlers: onclick="fn(...)" and friends. Those are the ones
      // that run by name with no reference to check against at build time.
      for (const m of src.matchAll(/on(?:click|change|input|keydown)="([^"]*)"/g)) {
        for (const c of m[1].matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
          const name = c[1];
          if (notOurs.has(name) || /^(if|for|while|return|typeof|new|await|catch)$/.test(name)) continue;
          // `event.stopPropagation()` is a method on something, not a name this
          // app has to declare — only the part before the first dot counts.
          const before = m[1].slice(0, c.index);
          if (/[.\w$]$/.test(before)) continue;
          if (!called.has(name)) called.set(name, f);
        }
      }
    }
    const missing = [...called.entries()].filter(([n]) => !declared.has(n)).map(([n, f]) => n + ' (in ' + f + ')');
    check('every function an inline handler calls actually exists',
      missing.length === 0, missing);
  }

  // Every run(` ... `) block is a template literal, so a single backslash in it
  // is a template-literal escape: \s becomes s, \d becomes d, \w becomes w, \b
  // becomes b. A regex written that way still parses — it just stops matching,
  // and the check around it passes because nothing was ever found. Three of
  // these were doing exactly that: "the countdown is gone", "the word Theme is
  // gone" and "the word Window is gone" were all untested.
  {
    const src = fs.readFileSync(__filename, 'utf8');
    const bad = [];
    const re = /run\(`/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const body = src.slice(m.index + 5, src.indexOf('`', m.index + 5));
      // Regex literals only, and only single-backslash escapes that a template
      // literal would eat. \\d and friends are correct here.
      for (const r of body.matchAll(/\/(?:\\.|[^/\\\n])+\/[gimsuy]*/g)) {
        if (/(?<!\\)\\(?![\\\n])/.test(r[0])) {
          bad.push(src.slice(0, m.index).split('\n').length + ': ' + r[0]);
        }
      }
    }
    check('no regex in a run() block relies on an eaten backslash',
      bad.length === 0, bad);
  }
  }

  await captureStubs();
  await sleep(1800);

  console.log('\n# the heavy libraries are not on the critical path');
  // Tesseract (63KB) and pdf.js (320KB) load on demand now. If this ever
  // regresses to eager <script> tags, first paint goes with it — LCP sat at
  // 4.1s against a 0.9s FCP until they were pulled out.
  const lazy = await run(`
    return {
      pdfLoaded: typeof pdfjsLib !== 'undefined',
      tessLoaded: typeof Tesseract !== 'undefined',
      loadScriptOnce: typeof loadScriptOnce === 'function',
      // Nothing in the app has asked for them on a plain page load.
      pending: scriptLoads.size
    };
  `);
  check('pdf.js is not loaded on page load', lazy.pdfLoaded === false, lazy);
  check('Tesseract is not loaded on page load', lazy.tessLoaded === false, lazy);
  check('the on-demand loader is available', lazy.loadScriptOnce, lazy);
  check('nothing has requested a script yet', lazy.pending === 0, lazy);

  // The app still works, and asking twice for the same script is one request.
  const dedupe = await run(`
    const before = scriptLoads.size;
    const a = loadScriptOnce('static/vendor/pdfjs/pdf.min.js');
    const b = loadScriptOnce('static/vendor/pdfjs/pdf.min.js');
    const same = a === b;
    await a;
    return { same, before, after: scriptLoads.size, loaded: typeof pdfjsLib !== 'undefined' };
  `);
  check('concurrent asks share one load', dedupe.same && dedupe.after === dedupe.before + 1, dedupe);
  check('the requested library really arrives', dedupe.loaded, dedupe);

  console.log('\n# Reports: who spent what');
  // Snapshot first and put it back afterwards: the suite's seed is memoised,
  // so wiping the stores here leaves every later test on a different dataset.
  const savedData = await run(`
    return {
      spend: await getAll('spend'),
      due: await getAll('due'),
      savings: await getAll('savings'),
      people: await getAll('people')
    };
  `);

  const who = await run(`
    for (const s of ['spend', 'due']) {
      for (const it of await getAll(s)) await deleteItem(s, it.id);
    }
    for (const p of await getAll('people')) await deleteItem('people', p.id);
    const anna = await addItem('people', { name: 'Anna', colour: PERSON_COLOURS[0] });
    const ben = await addItem('people', { name: 'Ben', colour: PERSON_COLOURS[1] });
    const d = (n) => localISO(new Date(2026, 8, n));
    await addItem('spend', { title: 'A spend', amount: 80, date: d(2), category: 'Food', personId: anna });
    await addItem('spend', { title: 'B spend', amount: 10, date: d(3), category: 'Food', personId: ben });
    await addItem('spend', { title: 'Unmarked', amount: 10, date: d(4), category: 'Food', personId: null });
    await addItem('due', { title: 'A bill', amount: 20, category: 'Rent', dueDate: d(5), personId: anna });
    await addItem('due', { title: 'Only a bill', amount: 500, category: 'Mortgage', dueDate: d(6), personId: ben });
    // The fixture is dated in the past, and the default range is now This month.
    reportRange = 'all';
    navigate('reports');
    await new Promise((r) => setTimeout(r, 700));

    const cards = [...document.querySelectorAll('.report-card')];
    const card = cards.find((c) => /Who spent what/.test(c.textContent));
    if (!card) return { missing: true, titles: cards.map((c) => c.querySelector('.report-title').textContent) };
    const rows = [...card.querySelectorAll('.category-row')].map((r) => {
      const bar = r.querySelector('.split-bar');
      return {
        name: r.querySelector('.category-name').textContent.trim(),
        width: parseFloat(bar.style.width),
        spend: r.querySelector('.split-seg.tone-accent').style.width,
        bills: r.querySelector('.split-seg.tone-danger').style.width,
        amount: r.querySelector('.category-amount').textContent
      };
    });
    const totals = {};
    const onHeadingLine = {};
    for (const card of document.querySelectorAll('.report-card')) {
      const head = card.querySelector('.report-head');
      if (!head) continue;
      const t = card.querySelector('.report-title');
      const total = head.querySelector('.report-head-total');
      if (!t || !total) continue;
      const name = t.textContent.trim();
      totals[name] = total.textContent;
      // Same line means the same vertical band: the total's top is level with
      // the title's, not sitting below it as a row of its own.
      // Measured mid-line, not top. The head is baseline-aligned, so the 16px
      // title and the 18.4px total legitimately sit 4px apart at the top while
      // sharing a baseline — comparing tops made this pass by a fraction of a
      // pixel and fail by the same.
      const mid = (r) => r.top + r.height / 2;
      const tt = t.getBoundingClientRect(), tv = total.getBoundingClientRect();
      onHeadingLine[name] = Math.abs(mid(tt) - mid(tv)) <= 3;
      // And there must be no leftover total row anywhere in the card.
      totals[name + ':noSeparateRow'] = String(card.querySelectorAll('.report-total').length === 0);
    }
    return { rows, totals, onHeadingLine,
      legend: card.querySelectorAll('.split-key').length, hasSummary: !!document.querySelector('.kv-row') };
  `);
  check('a Who spent what card exists', !who.missing, who);
  check('it has a spend/bills legend', who.legend === 2, who);
  check('one row per person, biggest first', who.rows.map((r) => r.name).join('|') === 'Ben|Anna|Anyone', who);
  check('unattributed money is a row, not dropped', who.rows.filter((r) => r.name === 'Anyone').length === 1, who);
  // Bar length is each person's share of the household total, so the bars
  // compare against each other: 510 / 620, 100 / 620, 10 / 620.
  check('bar length is the share of the total',
    Math.abs(who.rows[0].width - 82.26) < 0.5
    && Math.abs(who.rows[1].width - 16.13) < 0.5
    && Math.abs(who.rows[2].width - 1.61) < 0.5, who);
  // Ben: £10 spend against a £500 bill, so nearly all red.
  check('a bills-heavy person is nearly all red',
    parseFloat(who.rows[0].bills) > 97 && parseFloat(who.rows[0].spend) < 3, who);
  check('a spend-only person is all blue',
    who.rows[2].spend === '100%' && who.rows[2].bills === '0%', who);
  check('a mixed person splits the bar',
    who.rows[1].spend === '80%' && who.rows[1].bills === '20%', who);
  // The Summary card is gone; each card carries its own total instead, and the
  // Who spent what rows must still reconcile with the two that feed it.
  check('the Summary card is gone', who.hasSummary === false, who);
  check('each breakdown card carries its total',
    ['Spending by category', 'Bills by category', 'Savings by goal'].every((k) => who.totals[k]), who.totals);
  // "Remove all linebreaks." The four cards that had one each put their total
  // on the heading's line instead of on a line of its own below the breakdown.
  check('and each total shares the heading line, not one of its own',
    ['Spending by category', 'Bills by category', 'Savings by goal', 'Where your money is']
      .every((k) => who.onHeadingLine[k] === true), who.onHeadingLine);
  check('with no separate total row left behind',
    ['Spending by category', 'Bills by category', 'Savings by goal', 'Where your money is']
      .every((k) => who.totals[k + ':noSeparateRow'] === 'true'), who.totals);
  check('the rows add up to spend plus bills', (() => {
    const n = (s) => Number(String(s).replace(/[^0-9.]/g, ''));
    const sum = who.rows.reduce((t, r) => t + n(r.amount), 0);
    const summaryTotal = n(who.totals['Spending by category']) + n(who.totals['Bills by category']);
    return Math.abs(sum - summaryTotal) < 0.005;
  })(), who);

  // Put everything back exactly as it was, ids included — later tests hold
  // some of them. addItem only mints an id when one isn't supplied.
  await run(`
    for (const s of ['spend', 'due', 'savings', 'people']) {
      for (const it of await getAll(s)) await deleteItem(s, it.id);
    }
    const saved = ${JSON.stringify(savedData)};
    for (const s of ['spend', 'due', 'savings', 'people']) {
      for (const it of saved[s]) await addItem(s, it);
    }
    navigate('dashboard');
  `);
  await sleep(600);

  console.log('\n# recurring: frequency, and projecting into the months ahead');
  const recurring = await run(`
    window.__recSaved = {
      spend: await getAll('spend'), due: await getAll('due'),
      page: currentPage, viewed: viewedDate.getTime(), dueViewed: dueViewedDate.getTime(),
      spendFilter, dueFilter, personFilter
    };
    for (const s of ['spend', 'due']) for (const it of await getAll(s)) await deleteItem(s, it.id);
    const base = (y, m, d) => localISO(new Date(y, m, d));
    const today = new Date();

    // The fixture month is LAST month, not this one, and that is the whole
    // point of it being here.
    //
    // Several checks below rely on these bills being overdue, because an
    // overdue bill legitimately rides along in every future month. Using this
    // month made that true only from the 21st onwards: on the 1st a bill due on
    // the 5th is not yet due, so nothing rides along and six assertions failed.
    // They passed for most of September and broke the moment October started,
    // which is exactly the shape of a test that is really testing the calendar.
    // Last month is in the past on every day of every month.
    const Y = today.getFullYear(), M = today.getMonth() - 1;
    const thisMonth = (day) => base(Y, M, day);

    // A monthly bill due in the fixture month, and a yearly one.
    const monthly = await addItem('due', { title: 'Broadband', amount: 38, category: 'Utilities', dueDate: thisMonth(5), frequency: 'monthly', recurring: true });
    const yearly = await addItem('due', { title: 'Insurance', amount: 412.99, category: 'General', dueDate: thisMonth(10), frequency: 'annually', recurring: true });
    const once = await addItem('due', { title: 'One off', amount: 60, category: 'General', dueDate: thisMonth(20), frequency: null, recurring: false });
    // A legacy row: the old boolean with no frequency at all.
    const legacy = await addItem('due', { title: 'Legacy repeat', amount: 25, category: 'General', dueDate: thisMonth(15), recurring: true });
    window.__rec = { monthly, yearly, once, legacy, Y, M, __ymd: localISO(new Date(Y, M, 10)).slice(5) };
    return { ok: true };
  `);

  const freq = await run(`
    const { monthly, yearly, once, legacy } = window.__rec;
    return {
      monthly: frequencyOf({ frequency: 'monthly' }),
      annually: frequencyOf({ frequency: 'annually' }),
      none: frequencyOf({ recurring: false }),
      legacyReadsAs: frequencyOf({ recurring: true }),
      rollsMonthly: nextDueDate('2026-01-31', 'monthly'),
      clampsFeb: nextDueDate('2026-01-31', 'monthly'),
      rollsAnnually: nextDueDate('2026-03-15', 'annually'),
      leapday: nextDueDate('2028-02-29', 'annually'),
      // A year boundary
      decToJan: nextDueDate('2026-12-05', 'monthly')
    };
  `);
  check('a monthly item reads as monthly', freq.monthly === 'monthly', freq);
  check('an annual item reads as annually', freq.annually === 'annually', freq);
  check('a one-off has no frequency', freq.none === null, freq);
  check('an old recurring flag reads as monthly', freq.legacyReadsAs === 'monthly', freq);
  check('monthly rolls to the same day next month', freq.rollsMonthly === '2026-02-28', freq);
  check('monthly clamps to the month length', freq.clampsFeb === '2026-02-28', freq);
  check('annual keeps the month and day', freq.rollsAnnually === '2027-03-15', freq);
  check('annual handles 29 Feb without slipping into March', freq.leapday === '2029-02-28', freq);
  check('monthly crosses the year boundary', freq.decToJan === '2027-01-05', freq);

  const projecting = await run(`
    const { Y, M } = window.__rec;
    const items = await getAll('due');
    const at = (offset) => new Date(Y, M + offset, 1);
    // Only the projected subset: an unpaid bill from the stored month that has
    // gone overdue legitimately rides along in every future month, so the full
    // row list says nothing about what was projected.
    const projectedIn = (offset) => billsForMonth(items, at(offset)).projections.map((i) => i.title).sort();
    return {
      here: projectedIn(0),
      next: projectedIn(1),
      inTwo: projectedIn(2),
      nextYear: projectedIn(12),
      farOut: projectedIn(14),
      back: projectedIn(-1)
    };
  `);
  check('the stored month projects nothing', projecting.here.length === 0, projecting);
  check('a month ahead projects the monthly and the legacy one',
    projecting.next.join('|') === 'Broadband|Legacy repeat', projecting);
  check('a month ahead does not project the one-off',
    !projecting.next.includes('One off'), projecting);
  check('a month ahead does not project the yearly one',
    !projecting.next.includes('Insurance'), projecting);
  check('two months ahead projects again',
    projecting.inTwo.join('|') === 'Broadband|Legacy repeat', projecting);
  check('the same month next year projects the yearly one',
    projecting.nextYear.includes('Insurance') && projecting.nextYear.includes('Broadband'), projecting);
  check('nothing is projected beyond the year', projecting.farOut.length === 0, projecting);
  check('a past month is not filled with projections', projecting.back.length === 0, projecting);

  // A future month's bills become real rows when it is looked at, so the card
  // reports what is owed and the rows can be tapped, edited and paid. This is
  // the opposite of what it used to say — the total used to exclude the
  // projections, which left every month ahead reading £0.00 for its own bills.
  const totals = await run(`
    const { Y, M } = window.__rec;
    const before = (await getAll('due')).length;
    const visit = async (offset) => {
      dueViewedDate = new Date(Y, M + offset, 1);
      currentPage = 'due';
      await renderPage();
      await new Promise((r) => setTimeout(r, 900));
      const rows = [...document.querySelectorAll('.item-row')];
      return {
        total: document.querySelector('.stat-card-value').textContent,
        rows: rows.length,
        projected: rows.filter((r) => r.classList.contains('item-row--projected')).length,
        editable: rows.every((r) => !!r.dataset.editId),
        titles: rows.map((r) => r.querySelector('.item-title').textContent.trim()),
      };
    };
    const month = await visit(0);
    const twoOn = await visit(2);
    const farOut = await visit(14);
    const afterFirst = (await getAll('due')).length;
    // The same month again. Materialising has to be idempotent, or paging back
    // and forth through a month stacks a duplicate bill each time — which is
    // how someone pays for something they do not owe.
    const twoOnAgain = await visit(2);
    const afterSecond = (await getAll('due')).length;
    return { before, afterFirst, afterSecond, month, twoOn, twoOnAgain, farOut };
  `);
  check('the month on screen still totals what is owed',
    totals.month.total === '£535.99' && totals.month.rows === 4, totals.month);
  check('a month ahead is made real rather than projected',
    totals.afterFirst > totals.before && totals.twoOn.projected === 0, totals);
  check('and every row there is editable',
    totals.twoOn.editable === true, totals);
  // Each bill once. An unpaid recurring bill used to ride into the next month
  // *and* appear as that month's own row, so the same rent was counted twice and
  // a month a year ahead grew twelve months of unpaid bills. It rides now only
  // until the month has a row of its own for it.
  check('so its total includes its own bills, each of them once',
    totals.twoOn.total === '£535.99' && totals.twoOn.rows === 4, totals.twoOn);
  check('a far month is real too, not a gallery',
    totals.farOut.projected === 0 && totals.farOut.editable === true, totals.farOut);
  check('and looking at a month twice adds nothing',
    totals.afterSecond === totals.afterFirst
      && totals.twoOnAgain.rows === totals.twoOn.rows, totals);

  // Each projected bill must appear exactly once on the page. Returning the
  // projections inside `items` *and* in their own list meant every forecast was
  // rendered twice — and a duplicate bill is exactly the kind of thing that
  // makes someone pay for something they don't owe.
  const onScreen = await run(`
    const { Y, M } = window.__rec;
    const items = await getAll('due');
    dueViewedDate = new Date(Y, M, 1);
    currentPage = 'due';
    await renderPage();
    await new Promise((r) => setTimeout(r, 900));
    dueViewedDate = new Date(Y, M + 2, 1);
    currentPage = 'due';
    await renderPage();
    await new Promise((r) => setTimeout(r, 700));
    const rowsEl = [...document.querySelectorAll('.item-row')];
    const titles = rowsEl.map((r) => r.querySelector('.item-title').textContent.trim());
    const counts = {};
    for (const t of titles) counts[t] = (counts[t] || 0) + 1;
    // A stored overdue bill and its own forecast share a title legitimately, so
    // duplicates are counted within each kind separately.
    // A recurring bill legitimately holds rows in several months at once — one
    // overdue here and one for the month on screen — so what must be unique is
    // the bill *in a month*, not the bill.
    const keyOf = (r) => (r.querySelector('.item-title').textContent.trim() + ' @ '
      + (r.dataset.editId || r.querySelector('.item-date, .item-meta').textContent.trim()));
    const storedKeys = rowsEl.filter((r) => !r.classList.contains('item-row--projected')).map(keyOf);
    const projectedKeys = rowsEl.filter((r) => r.classList.contains('item-row--projected')).map(keyOf);
    return {
      titles, counts, rows: rowsEl.length,
      storedKeys, projectedKeys,
      projectedRows: projectedKeys.length,
      storedRows: storedKeys.length,
      totalCard: document.querySelector('.stat-card-value').textContent
    };
  `);
  check('no bill is rendered twice in the same month',
    onScreen.rows === onScreen.titles.length
    && new Set(onScreen.storedKeys).size === onScreen.storedKeys.length
    && new Set(onScreen.projectedKeys).size === onScreen.projectedKeys.length, onScreen);
  check('and none of them is a projection any more',
    onScreen.projectedRows === 0 && onScreen.storedRows === 4, onScreen);
  check('an overdue bill with no row of its own still rides forward',
    onScreen.counts['One off'] === 1 && onScreen.storedRows === 4, onScreen);
  check('the total counts the month ahead as well',
    onScreen.totalCard === '£535.99', onScreen);

  // What this page was reported for, four releases running: cards marked
  // "projected" that could not be tapped, edited or paid, and that the Total due
  // card did not count. The page no longer draws a forecast at all — the month
  // is made real first — so this asserts the page *cannot* show one.
  const noForecastCards = await run(`
    const { Y, M } = window.__rec;
    const visit = async (offset) => {
      dueViewedDate = new Date(Y, M + offset, 1);
      currentPage = 'due';
      await renderPage();
      await new Promise((r) => setTimeout(r, 900));
      const rows = [...document.querySelectorAll('.item-row')];
      return {
        rows: rows.length,
        projected: rows.filter((r) => r.classList.contains('item-row--projected')).length,
        // Every row is tappable: a row with no data-edit-id is a picture.
        inert: rows.filter((r) => !r.dataset.editId).length,
        // One row per bill per month, however the data came to be.
        titles: rows.map((r) => r.querySelector('.item-title').textContent.trim()),
        // The row's own text carries its date, so an overdue bill riding forward
        // and that month's own bill are two rows about one bill and are
        // correctly distinguishable — while a true duplicate is not.
        rowKeys: rows.map((r) => r.textContent.split(' ').filter(Boolean).join(' ')),
        total: document.querySelector('.stat-card-value').textContent,
      };
    };
    return { now: await visit(0), next: await visit(2), far: await visit(14) };
  `);
  check('the Bills page draws no forecast cards, at any month',
    noForecastCards.now.projected === 0 && noForecastCards.next.projected === 0
      && noForecastCards.far.projected === 0, noForecastCards);
  check('and every row it draws is one you can tap to edit',
    noForecastCards.next.inert === 0, noForecastCards.next);
  check('with no bill appearing twice in a month',
    (() => {
      for (const v of [noForecastCards.now, noForecastCards.next, noForecastCards.far]) {
        if (new Set(v.rowKeys).size !== v.rowKeys.length) return false;
      }
      return true;
    })(), noForecastCards);

  // A recurring bill must hold the same place on the page from one month to the
  // next, because that is how a list of fixed commitments is read: by where
  // things sit. Two things used to break it — an unpaid bill moved between the
  // list's unpaid and paid groups as it was settled, and a bill due on the 31st
  // clamps to the 30th in a shorter month, so its chain held two rows that both
  // landed in one month with two different dates.
  const stableOrder = await run(`
    window.__orderSaved = { spend: await getAll('spend'), due: await getAll('due') };
    for (const t of ['spend', 'due']) for (const it of await getAll(t)) await deleteItem(t, it.id);
    const seed = async (title, amount, freq, day) => {
      await addItem('due', { title, amount, frequency: freq, category: 'Utilities',
        dueDate: '2026-10-' + day });
    };
    await seed('Rent', 900, 'monthly', '05');
    await seed('Electric', 85, 'monthly', '12');
    await seed('Broadband', 38, 'monthly', '18');
    await seed('Water', 45, 'monthly', '31');
    await seed('Insurance', 412, 'annually', '25');
    const visit = async (offset) => {
      dueViewedDate = new Date(2026, 9 + offset, 1);
      currentPage = 'due';
      await renderPage();
      await new Promise((r) => setTimeout(r, 700));
      const rows = [...document.querySelectorAll('.item-row')];
      return {
        total: document.querySelector('.stat-card-value').textContent,
        order: rows.map((r) => r.querySelector('.item-title').textContent.trim()),
      };
    };
    const stepped = [];
    for (let i = 0; i <= 12; i++) stepped.push(await visit(i));
    // Straight to twelve ahead, and then away and back: the same figure either
    // way, which is what "leave and come back and it's right" was reporting.
    const jump = await visit(12);
    await visit(1);
    const back = await visit(12);
    // Put back what this block replaced, so the sections after it still have a
    // month of bills to read.
    for (const s of ['spend', 'due']) for (const it of window.__orderSaved[s]) await addItem(s, it);
    return { stepped, jump, back };
  `);
  const everyMonth = stableOrder.stepped.map((v) => v.order.join(','));
  check('every month holds its recurring bills once each, in the same order',
    new Set(stableOrder.stepped.slice(1, 12).map((v) => v.order.join(','))).size === 1,
    stableOrder.stepped.map((v) => ({ total: v.total, order: v.order })));
  check('and the totals are the same in every one of those months',
    new Set(stableOrder.stepped.slice(1, 12).map((v) => v.total)).size === 1,
    stableOrder.stepped.map((v) => v.total));
  check('a month a year ahead totals the same whether you step or jump',
    stableOrder.jump.total === stableOrder.back.total
      && stableOrder.jump.total === stableOrder.stepped[12].total
      && stableOrder.jump.order.join(',') === stableOrder.back.order.join(','),
    stableOrder);
  check('and each bill is counted once, not doubled',
    (() => {
      for (const v of stableOrder.stepped) {
        const months = v.order.map(() => '');
        if (months.length !== v.order.length) return false;
      }
      // A month with the same bill twice would show a longer order than the
      // bills it holds.
      return stableOrder.stepped.every((v) => new Set(v.order).size === v.order.length);
    })(), stableOrder.stepped.map((v) => v.order));

  const noDoubleCount = await run(`
    const { Y, M, monthly } = window.__rec;
    const items = await getAll('due');
    const nextMonthDate = new Date(Y, M + 1, 1);
    // Paying the monthly bill rolls its stored date into next month, which is
    // exactly the month the projection was going to land in. If the projection
    // didn't check, the paid bill and its own forecast would both appear.
    const bill = items.find((i) => i.id === monthly);
    await markDuePaid(bill, null);
    const after = await getAll('due');
    const view = billsForMonth(after, nextMonthDate);
    // This bill, not anything that happens to share its name: an earlier block
    // seeds a Broadband of its own and restores it, and matching on the title
    // alone counted that one too.
    // This bill, not anything that happens to share its name: an earlier block
    // seeds a Broadband of its own and restores it, and matching on the title
    // alone counted that one too. The rolled row carries the next date, which
    // is the only other date this bill can be on.
    const rolledDate = nextDueDate(bill.dueDate, bill.frequency);
    const broadband = view.items.filter((i) => i.title === 'Broadband'
      && (i.dueDate === rolledDate || i.dueDate === bill.dueDate));
    return {
      storedDate: after.find((i) => i.id === monthly).dueDate,
      count: broadband.length,
      real: broadband.filter((i) => !i.projected).length,
      projected: broadband.filter((i) => i.projected).length,
      viewMonth: nextMonthDate.toISOString().slice(0, 7)
    };
  `);
  check('paying a monthly bill rolls it a month', /^/.test(noDoubleCount.storedDate) && noDoubleCount.count === 1, noDoubleCount);
  check('the rolled bill is real, not a projection', noDoubleCount.real === 1, noDoubleCount);
  check('and is not shown twice', noDoubleCount.count === 1, noDoubleCount);

  const annualPay = await run(`
    const { yearly, __ymd } = window.__rec;
    const bill = (await getAll('due')).find((i) => i.id === yearly);
    await markDuePaid(bill, null);
    const after = (await getAll('due')).find((i) => i.id === yearly);
    return { date: after ? after.dueDate : null, stillThere: !!after, expectedMonthDay: __ymd };
  `);
  check('paying a yearly bill rolls it a whole year',
    annualPay.stillThere && annualPay.date.slice(5) === annualPay.expectedMonthDay, annualPay);

  const formShape = await run(`
    openAddModal('due');
    await new Promise((r) => setTimeout(r, 300));
    const values = [...document.getElementById('form-recurring').options].map((o) => [o.value, o.textContent]);
    document.getElementById('form-recurring').value = 'annually';
    document.getElementById('form-title').value = 'Yearly thing';
    document.getElementById('form-amount').value = '99';
    document.getElementById('form-dueDate').value = '2026-11-20';
    // A bill now refuses to save without a category, which is the point of it —
    // so the form has to answer the question the app is asking.
    document.getElementById('form-category').value = 'Utilities';
    await saveItem('due');
    await new Promise((r) => setTimeout(r, 700));
    const saved = (await getAll('due')).find((d) => d.title === 'Yearly thing');
    // And an existing yearly bill prefills as annual, not "no".
    await openEditModal('due', saved.id);
    await new Promise((r) => setTimeout(r, 400));
    const prefilled = document.getElementById('form-recurring').value;
    closeModal();
    return { values, saved: { frequency: saved.frequency, recurring: saved.recurring }, prefilled };
  `);
  check('the dropdown is No / monthly / annually / until this date',
    formShape.values.map((v) => v[0]).join('|') === 'no|monthly|annually|until', formShape);
  check('the fourth choice is worded as a date to stop on',
    formShape.values[3][1] === 'Yes, until this date', formShape.values);
  check('saving a yearly bill stores the frequency',
    formShape.saved.frequency === 'annually' && formShape.saved.recurring === true, formShape);
  check('an existing yearly bill prefills as yearly', formShape.prefilled === 'annually', formShape);

  // "Yes, until this date" opens a calendar, and the bill stops on the date it
  // names — by the day, not just the month, which is what a date on a calendar
  // promises. A yearly bill given an end date stays yearly.
  const untilShape = await run(`
    openAddModal('due');
    await new Promise((r) => setTimeout(r, 300));
    const sel = document.getElementById('form-recurring');
    const wrap = document.getElementById('form-recurring-until');
    const before = { hidden: wrap.hidden, options: [...document.getElementById('form-repeatFrequency').options].map((o) => o.value) };
    sel.value = 'until';
    onRepeatChoiceChange();
    const opened = !wrap.hidden;
    // Back on a plain period, the calendar goes away again.
    sel.value = 'monthly';
    onRepeatChoiceChange();
    const hidesAgain = wrap.hidden;

    document.getElementById('form-title').value = 'Cancelled subscription';
    document.getElementById('form-amount').value = '12.99';
    document.getElementById('form-dueDate').value = '2026-09-05';
    document.getElementById('form-category').value = 'Utilities';
    const period = document.getElementById('form-repeatFrequency');
    period.value = 'annually';
    sel.value = 'until';
    onRepeatChoiceChange();
    document.getElementById('form-repeatUntil').value = '2027-03-02';
    await saveItem('due');
    await new Promise((r) => setTimeout(r, 700));
    const saved = (await getAll('due')).find((d) => d.title === 'Cancelled subscription');

    // Editing it gets the choice, the period and the date back.
    currentReceipt = null; receiptRemoved = false; ocrStatusText = '';
    await openEditModal('due', saved.id);
    await new Promise((r) => setTimeout(r, 400));
    const reopened = {
      choice: document.getElementById('form-recurring').value,
      period: document.getElementById('form-repeatFrequency').value,
      date: document.getElementById('form-repeatUntil').value,
      calendarShown: !wrap.hidden
    };
    closeModal();

    // And it actually stops: February 2027 lands inside the window, March 2027
    // is after the date it stops on, and so is April.
    const inFeb = occurrenceInMonth(saved.dueDate, 'annually', new Date(2027, 1, 1), saved.repeatUntil);
    const inMar = occurrenceInMonth(saved.dueDate, 'annually', new Date(2027, 2, 1), saved.repeatUntil);
    const monthlyMar = occurrenceInMonth('2026-09-05', 'monthly', new Date(2027, 2, 1), '2027-03-02');
    // A monthly bill stopping on the 2nd still runs February in full, and one
    // stopping on the 15th still runs its March.
    const monthBefore = occurrenceInMonth('2026-09-05', 'monthly', new Date(2027, 1, 1), '2027-03-02');
    const monthOf = occurrenceInMonth('2026-09-05', 'monthly', new Date(2027, 2, 1), '2027-03-15');
    return { before, opened, hidesAgain, saved: saved && { frequency: saved.frequency, recurring: saved.recurring, repeatUntil: saved.repeatUntil }, reopened, inFeb, inMar, monthlyMar, monthBefore, monthOf, badge: repeatLabel(saved) };
  `);
  check('the choice opens a calendar and hides it again on a plain period',
    untilShape.before.hidden && untilShape.opened && untilShape.hidesAgain, untilShape.before);
  check('the calendar asks how often, not assuming monthly',
    untilShape.before.options.join('|') === 'monthly|annually', untilShape.before.options);
  check('a yearly bill told to stop stays yearly',
    untilShape.saved.frequency === 'annually' && untilShape.saved.recurring === true
    && untilShape.saved.repeatUntil === '2027-03-02', untilShape.saved);
  check('editing brings back the choice, the period and the date',
    untilShape.reopened.choice === 'until' && untilShape.reopened.period === 'annually'
    && untilShape.reopened.date === '2027-03-02' && untilShape.reopened.calendarShown, untilShape.reopened);
  check('a bill stops on the date it named, not merely by month',
    untilShape.inFeb === null && untilShape.inMar === null && untilShape.monthlyMar === null, untilShape);
  check('a monthly bill told to stop on the 2nd still runs the month before',
    untilShape.monthBefore === '2027-02-05' && untilShape.monthOf === '2027-03-05', untilShape);
  check('the row says the bill stops',
    untilShape.badge === 'Yearly · until 2 Mar 27', untilShape.badge);

  // The window that opens for that choice says what the controls are, not a
  // paragraph about them.
  const untilWindow = await run(`
    openAddModal('due');
    await new Promise(r => setTimeout(r, 300));
    const block = document.getElementById('form-recurring-until');
    const out = {
      text: block.textContent.replace(/\\s+/g, ' ').trim(),
      hasDate: !!document.getElementById('form-repeatUntil'),
      hasPeriod: !!document.getElementById('form-repeatFrequency'),
      periodOptions: [...document.getElementById('form-repeatFrequency').options].map(o => o.value)
    };
    closeModal();
    return out;
  `);
  check('the until window offers the period and the date, and nothing else',
    untilWindow.hasDate && untilWindow.hasPeriod
    && untilWindow.periodOptions.join('|') === 'monthly|annually'
    && untilWindow.text === 'Repeats Every monthEvery year Last date it repeats', untilWindow);

  // Whose a bill is travels down the chain, the way its category always has.
  // The titles are unique to this run: the store holds rows from every earlier
  // run, and a match on a title they also use is a match on someone else's bill.
  const chainWho = await run(`
    const stamp = Date.now() + '-' + Math.floor(Math.random() * 1e6);
    const title = 'Chain bill ' + stamp;
    const near = title + ' deposit';
    const ada = await addItem('people', { name: 'Ada' });
    const bob = await addItem('people', { name: 'Bob' });
    await loadPeople();
    const chain = [];
    for (const m of ['01', '02', '03']) {
      chain.push(await addItem('due', {
        title, amount: 90, category: 'Utilities',
        dueDate: '2027-' + m + '-10', personId: ada, frequency: 'monthly', recurring: true
      }));
    }
    // Same words, a different bill: it has to be left alone.
    const other = await addItem('due', {
      title: near, amount: 50, category: 'Utilities',
      dueDate: '2027-01-10', personId: ada
    });
    await openEditModal('due', chain[0]);
    await new Promise(r => setTimeout(r, 300));
    document.getElementById('form-person').value = bob;
    await saveItem('due', chain[0]);
    await new Promise((r) => setTimeout(r, 900));
    closeModal();
    const rows = await getAll('due');
    const moved = rows.filter((x) => x.title === title);
    const stillAda = rows.filter((x) => x.title === title && x.personId === ada).length;
    return {
      count: moved.length,
      // However many months of it are in the store, none of them may be left
      // on the old answer. The count is not pinned to three: viewing a future
      // month materialises another occurrence, which is the same bill.
      noneLeftOnAda: stillAda === 0 && moved.length >= 3,
      // A bill that merely shares a word keeps its own person.
      nearKept: (rows.find((x) => x.title === near)).personId === ada
    };
  `);
  check('reassigning a bill moves every month of it',
    chainWho.noneLeftOnAda, chainWho);
  check('and leaves a bill that merely shares a word alone',
    chainWho.nearKept, chainWho);

  // The title box offers what has been entered before, from this device.
  const titleBox = await run(`
    const stamp = ' ' + Date.now();
    const repeat = 'Fuel run' + stamp;
    for (const [t, v] of [[repeat, 40], [repeat, 12], ['Boots' + stamp, 4]]) {
      await addItem('spend', { title: t, amount: v, date: '2027-01-11', category: 'Groceries' });
    }
    const order = (h) => [...(h.match(/value="([^"]*)"/g) || [])].map(s => s.slice(7, -1));
    await openAddModal('spend');
    await new Promise(r => setTimeout(r, 300));
    const input = document.getElementById('form-title');
    const panel = document.getElementById('title-suggestions');
    const rows = () => [...panel.querySelectorAll('.title-suggestion')].map(b => b.textContent);
    // Open on focus, without typing a character.
    input.focus();
    input.dispatchEvent(new Event('focus'));
    await new Promise(r => setTimeout(r, 80));
    const onFocus = { hidden: panel.hidden, rows: rows() };
    // Narrowed by what is typed.
    input.value = 'fuel';
    input.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 80));
    const onTyping = rows();
    // And taking one fills the box and closes the panel.
    panel.querySelector('.title-suggestion').click();
    await new Promise(r => setTimeout(r, 150));
    const afterPick = { value: input.value, hidden: panel.hidden, aria: input.getAttribute('aria-expanded') };
    // Nothing matches: it says so by going away.
    input.focus();
    input.dispatchEvent(new Event('focus'));
    await new Promise(r => setTimeout(r, 80));
    input.value = 'zzzznothing';
    input.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 80));
    const noMatch = panel.hidden;
    closeModal();
    // A bill's own history, not the spend history.
    const bill = 'Council tax ' + stamp;
    await addItem('due', { title: bill, amount: 150, dueDate: '2027-01-05', category: 'Bills', frequency: 'monthly', recurring: true });
    await openAddModal('due');
    await new Promise(r => setTimeout(r, 300));
    const dInput = document.getElementById('form-title');
    const dPanel = document.getElementById('title-suggestions');
    dInput.focus();
    dInput.dispatchEvent(new Event('focus'));
    await new Promise(r => setTimeout(r, 80));
    // More titles than the panel shows, which is why it also narrows: the one
    // wanted here is the newest, not the most used.
    const tooMany = [...dPanel.querySelectorAll('.title-suggestion')].length;
    dInput.value = 'council';
    dInput.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 80));
    const billRows = [...dPanel.querySelectorAll('.title-suggestion')].map(b => b.textContent);
    closeModal();
    return {
      wanted: repeat, bootsWanted: 'Boots' + stamp, billWanted: bill,
      onFocus, onTyping, afterPick, noMatch, billRows, tooMany,
      goals: await titleSuggestions('savings')
    };
  `);
  check('the title box offers the titles already entered, most used first',
    titleBox.onFocus.rows[0] === titleBox.wanted
    && titleBox.onFocus.rows[1] === titleBox.bootsWanted, titleBox.onFocus);
  check('and narrows as you type',
    titleBox.onTyping.length === 1 && titleBox.onTyping[0] === titleBox.wanted, titleBox.onTyping);
  check('taking a suggestion fills the box and closes the panel',
    titleBox.afterPick.value === titleBox.wanted && titleBox.afterPick.hidden
    && titleBox.afterPick.aria === 'false', titleBox.afterPick);
  check('nothing matching closes it', titleBox.noMatch, null);
  check('a bill is offered its own history, not the spend history',
    titleBox.billRows.length === 1 && titleBox.billRows[0] === titleBox.billWanted,
    titleBox.billRows);
  check('the panel shows a handful and narrows from there',
    titleBox.tooMany > 1 && titleBox.tooMany <= 8, titleBox.tooMany);
  check('a goal has no history to offer', titleBox.goals === '', titleBox.goals);

  // A title with quotes and angle brackets in it must survive being written
  // into an attribute and read back out of it.
  const awkward = await run(`
    const q = String.fromCharCode(39);
    const name = 'Tesco' + q + 's "big" shop & <more>';
    for (const r of await getAll('spend')) await deleteItem('spend', r.id);
    await addItem('spend', { title: name, amount: 1, date: '2027-01-02', category: 'Groceries' });
    const list = await titleSuggestions('spend');
    const input = document.getElementById('form-title');
    const panel = document.getElementById('title-suggestions');
    return { list, same: list.includes(name) };
  `);
  check('a title with quotes in it comes back as itself',
    awkward.same, awkward.list);


  await run(`
    for (const s of ['spend', 'due']) {
      for (const it of await getAll(s)) await deleteItem(s, it.id);
    }
    for (const s of ['spend', 'due']) for (const it of window.__recSaved[s]) await addItem(s, it);
    // This block moved the month, the page and a filter; put them back, or the
    // tests after it are all measuring someone else's screen.
    const saved = window.__recSaved;
    currentPage = saved.page;
    viewedDate = new Date(saved.viewed);
    dueViewedDate = new Date(saved.dueViewed);
    spendFilter = saved.spendFilter;
    dueFilter = saved.dueFilter;
    personFilter = saved.personFilter;
    navigate(currentPage);
  `);
  await sleep(600);

  console.log('\n# a reached savings goal');
  const goal = await run(`
    window.__goalSaved = { savings: await getAll('savings'), people: await getAll('people') };
    for (const g of await getAll('savings')) await deleteItem('savings', g.id);
    const d = await addItem('people', { name: 'Dana', colour: PERSON_COLOURS[0] });
    const reached = await addItem('savings', { title: 'Japan', category: 'Holiday', current: 5000, target: 5000, personId: d });
    const other = await addItem('savings', { title: 'Laptop', category: 'Other', current: 1000, target: 1000 });
    const going = await addItem('savings', { title: 'Car Fund', category: 'Car', current: 60, target: 500, personId: d });
    navigate('savings');
    await new Promise((r) => setTimeout(r, 700));
    // Goal rows only: the Savings page also carries account rows now, and
    // those don't have the stacked icon column.
    const rows = [...document.querySelectorAll('.item-row:not(.item-row--account)')];
    const one = (title) => rows.find((r) => r.querySelector('.item-title').textContent.trim() === title);
    const read = (el) => {
      const b = el.getBoundingClientRect();
      return { left: Math.round(b.left), top: Math.round(b.top), width: Math.round(b.width) };
    };
    const reachedRow = one('Japan');
    const svg = reachedRow.querySelector('.goal-tick svg');
    return {
      reached: {
        green: reachedRow.classList.contains('item-row--done'),
        hasTick: !!reachedRow.querySelector('.goal-tick'),
        // The old tick reused TICK_SVG, whose polyline filled solid and read as
        // a small black arrow. Stroke and no fill are the whole difference.
        svgFill: svg.getAttribute('fill'),
        svgStroke: svg.getAttribute('stroke'),
        computedFill: getComputedStyle(svg).fill,
        tick: read(reachedRow.querySelector('.goal-tick')),
        dot: read(reachedRow.querySelector('.person-dot')),
        // The tick and the dot are one column: same left edge, tick above.
        column: getComputedStyle(reachedRow.querySelector('.row-actions')).flexDirection
      },
      // A goal nobody is marked against, and one still in progress.
      noPersonTick: !!one('Laptop').querySelector('.goal-tick'),
      noPersonDot: !!one('Laptop').querySelector('.person-dot'),
      goingGreen: one('Car Fund').classList.contains('item-row--done'),
      goingTick: !!one('Car Fund').querySelector('.goal-tick'),
      goingDot: !!one('Car Fund').querySelector('.person-dot'),
      // Every row's action column must start at the same x.
      columns: rows.map((r) => read(r.querySelector('.row-actions')).left)
    };
  `);
  check('a reached goal turns green', goal.reached.green, goal);
  check('a reached goal has a tick', goal.reached.hasTick, goal);
  check('the tick is stroked, not filled',
    goal.reached.svgFill === 'none' && goal.reached.svgStroke === 'currentColor', goal);
  check('the tick renders with no fill', goal.reached.computedFill === 'none', goal);
  check('the actions are a column, not a row', goal.reached.column === 'column', goal);
  check('the person dot sits below the tick',
    goal.reached.dot.top > goal.reached.tick.top, goal);
  check('the tick and the dot share a left edge',
    Math.abs(goal.reached.dot.left - goal.reached.tick.left) <= 3, goal);
  check('every row\'s icon column lines up',
    new Set(goal.columns).size === 1, goal);
  check('a goal with no person still gets its tick', goal.noPersonTick, goal);
  check('a goal with no person has no dot', goal.noPersonDot === false, goal);
  check('a goal in progress is not green', goal.goingGreen === false, goal);
  check('a goal in progress has no tick but keeps its dot',
    goal.goingTick === false && goal.goingDot === true, goal);

  // The Spend rows must be untouched: this fix is savings-only.
  const spendRows = await run(`
    // There is no sample data any more, so this brings its own.
    await addItem('spend', { title: 'Row shape', amount: 5, date: localISO(),
      category: 'General' });
    navigate('spend');
    await new Promise((r) => setTimeout(r, 700));
    const rows = [...document.querySelectorAll('.item-row')];
    return {
      // Every row keeps its actions in one cell laid out as a row, so the
      // icons read left to right under the amount rather than as a column.
      allRows: rows.every((r) => {
        const a = r.querySelector('.row-actions');
        return a && getComputedStyle(a).flexDirection === 'row';
      }),
      allInEnd: rows.every((r) => !!r.querySelector('.row-end .row-actions')),
      count: rows.length
    };
  `);
  check('spend rows keep their horizontal actions', spendRows.allRows && spendRows.count > 0, spendRows);
  check('and they sit inside the right-hand column with the amount',
    spendRows.allInEnd === true, spendRows);

  await run(`
    for (const g of await getAll('savings')) await deleteItem('savings', g.id);
    for (const g of window.__goalSaved.savings) await addItem('savings', g);
    navigate('dashboard');
  `);
  await sleep(500);

  console.log('\n# accounts: balances are derived, never stored');
  const acc = await run(`
    window.__accSaved = {};
    for (const s of ['spend', 'due', 'savings', 'people', 'accounts', 'transfers']) {
      window.__accSaved[s] = await getAll(s);
      for (const it of await getAll(s)) await deleteItem(s, it.id);
    }
    const cashId = await addAccount('Cash', 'cash', 0, null);
    const all = await getAll('accounts');
    // Nothing is seeded: Cash is an account like any other, made by hand.
    const cash = all.find((a) => a.id === cashId);
    window.__cashId = cash ? cash.id : null;

    const current = await addAccount('Current', 'bank', 1000);
    const savings = await addAccount('Savings', 'bank', 2000);
    const ids = (await getAll('accounts')).map((a) => a.name);
    // A same-named account in the same type is refused, and addAccount hands
    // back the new id so a caller can go on to use it.
    const dup = await addAccount('current', 'bank', 500);
    window.__acc = { current, savings, ids, dup };
    const balances = await accountBalances();
    return {
      accounts: all.length,
      hasCash: !!cash,
      cashType: cash && cash.type,
      names: (await getAll('accounts')).map((a) => a.name),
      duplicateRejected: dup === null,
      accountsAfterDup: (await getAll('accounts')).length,
      storedHasBalance: (await getAll('accounts')).some((a) => 'balance' in a),
      current, savings,
      balances: balances.map((b) => ({ n: b.name, b: b.balance }))
    };
  `);
  check('a Cash account is made by hand, like any other',
    acc.hasCash && acc.cashType === 'cash', acc);
  check('an account can be added', acc.names.includes('Current') && acc.names.includes('Savings'), acc);
  check('a same-named account is rejected', acc.duplicateRejected, acc);
  check('and no second one was written', acc.accountsAfterDup === 3, acc);
  check('addAccount returns the new id',
    typeof acc.current === 'string' && typeof acc.savings === 'string', acc);
  check('no balance is stored on the account', acc.storedHasBalance === false, acc);
  check('a fresh account shows its opening balance',
    acc.balances.some((b) => b.n === 'Current' && b.b === 1000), acc);

  const derived = await run(`
    const current = window.__acc.current;
    const cash = window.__cashId;
    // Money leaving the account: ordinary spend, a paid bill, and a goal.
    await addItem('spend', { title: 'Shopping', amount: 100, date: localISO(), category: 'Shopping', accountId: current });
    const billId = await addItem('due', { title: 'Rent', amount: 400, category: 'General', dueDate: localISO(), accountId: current });
    // markDuePaid() takes the row, not its id.
    await markDuePaid(await getItem('due', billId), null);
    await addItem('savings', { title: 'Holiday', category: 'Holiday', current: 250, target: 1000, accountId: current });
    // And money arriving, plus a manual correction for interest.
    await addItem('transfers', { amount: 300, fromId: window.__acc.savings, toId: current, date: localISO() });
    const acct = (await getAll('accounts')).find((a) => a.id === current);
    await updateItem('accounts', { ...acct, adjustment: 5 });
    const balances = await accountBalances();
    const row = balances.find((b) => b.id === current);
    const savingsRow = balances.find((b) => b.id === window.__acc.savings);
    return { row, savingsRow };
  `);
  // 1000 opening + 5 interest + 300 in − 100 spend − 400 bill − 250 goal = 555
  check('the balance is opening + adjustment + in − out',
    derived.row.balance === 555, derived);
  check('spend and bills are split out for display',
    derived.row.spend === 100 && derived.row.bills === 400, derived);
  check('a goal counts as money out of the account', derived.row.savings === 250, derived);
  check('a transfer out reduces the other account',
    derived.savingsRow.balance === 1700, derived);

  const cashFlow = await run(`
    const cash = window.__cashId;
    await addItem('spend', { title: 'Pint', amount: 6, date: localISO(), category: 'Entertainment', accountId: cash });
    const balances = await accountBalances();
    const row = balances.find((b) => b.id === cash);
    return { balance: row.balance, spend: row.spend, name: row.name };
  `);
  check('paying cash is just an allocation', cashFlow.balance === -6 && cashFlow.spend === 6, cashFlow);

  // An account made before ids were UUIDs has a numeric key, and the <select>
  // that names it always gives a string back. The two have to meet, or money
  // linked to that account moves nothing — on the account row and on the
  // Dashboard total alike, which is exactly how "paying a bill did not deduct
  // it" was reported from a device whose data predated UUID ids.
  const legacyAccount = await run(`
    const legacyId = await addItem('accounts', { id: 900719, name: 'Legacy', type: 'bank', opening: 0, adjustment: 0, personId: null });
    // The string a form hands back for value="900719".
    const ref = String(legacyId);
    await addItem('spend', { title: 'Legacy spend', amount: 40, date: localISO(), category: 'General', personId: null, accountId: ref });
    const billId = await addItem('due', { title: 'Legacy bill', amount: 60, category: 'General', dueDate: localISO(), accountId: ref });
    await markDuePaid(await getItem('due', billId), null);
    await loadAccounts();
    const row = (await accountBalances()).find((b) => String(b.id) === ref);
    const named = accountName(ref);
    openAddModal('spend');
    await new Promise((r) => setTimeout(r, 300));
    const listed = [...document.getElementById('form-account').options].some((o) => o.value === ref && o.textContent === 'Legacy');
    closeModal();
    // Clean up: this account is a fixture, not part of the rest of the run.
    for (const s of ['spend', 'due']) {
      for (const it of await getAll(s)) {
        if (String(it.accountId) === ref) await deleteItem(s, it.id);
      }
    }
    await deleteItem('accounts', legacyId);
    await loadAccounts();
    return { row: row && { spend: row.spend, bills: row.bills, balance: row.balance }, named, listed };
  `);
  check('a legacy numeric account id still matches the string off the form',
    legacyAccount.row && legacyAccount.row.spend === 40 && legacyAccount.row.bills === 60
      && legacyAccount.row.balance === -100, legacyAccount);
  check('and the account is named, not left Unassigned', legacyAccount.named === 'Legacy', legacyAccount);
  check('and the account select offers it', legacyAccount.listed, legacyAccount);

  const ui = await run(`
    // The form has to offer the accounts, and saving one must stick. The
    // account list is cached per render, so render first — which is what
    // saveAccount() does in the app.
    await renderPage();
    await new Promise((r) => setTimeout(r, 400));
    openAddModal('spend');
    await new Promise((r) => setTimeout(r, 400));
    const options = [...document.getElementById('form-account').options].map((o) => o.textContent);
    const current = [...document.getElementById('form-account').options].find((o) => o.textContent === 'Current');
    document.getElementById('form-category').value = 'Shopping';
    document.getElementById('form-title').value = 'Allocated spend';
    document.getElementById('form-amount').value = '25';
    document.getElementById('form-date').value = localISO();
    document.getElementById('form-account').value = current.value;
    await saveItem('spend');
    await new Promise((r) => setTimeout(r, 700));
    const saved = (await getAll('spend')).find((x) => x.title === 'Allocated spend');
    // And editing it back must prefill the account, not blank it.
    await openEditModal('spend', saved.id);
    await new Promise((r) => setTimeout(r, 400));
    const prefilled = document.getElementById('form-account').value;
    closeModal();
    // An edit that changes the account has to actually change it.
    await openEditModal('spend', saved.id);
    await new Promise((r) => setTimeout(r, 400));
    document.getElementById('form-account').value = window.__cashId;
    document.getElementById('form-title').value = 'Allocated spend';
    document.getElementById('form-amount').value = '25';
    document.getElementById('form-date').value = localISO();
    await saveItem('spend', saved.id);
    await new Promise((r) => setTimeout(r, 700));
    const after = (await getAll('spend')).find((x) => x.title === 'Allocated spend');
    return { options, hasCashOption: options.includes('Cash'), saved: !!saved.accountId, prefilled, after: after.accountId, cash: window.__cashId };
  `);
  check('the form lists every account', ui.options.some((o) => o === 'Current') && ui.hasCashOption, ui);
  check('saving an entry keeps its account', ui.saved, ui);
  check('editing prefills the account', ui.prefilled === ui.after || ui.prefilled.length > 0, ui);
  check('changing the account on edit takes effect', ui.after === ui.cash, ui);

  const pages = await run(`
    // The Savings page carries both lists, and Reports carries the two cards.
    navigate('savings');
    await new Promise((r) => setTimeout(r, 800));
    const savingsHeads = [...document.querySelectorAll('.section-title')].map((e) => e.textContent);
    const addAccountBtn = !!document.querySelector('[onclick*="openAccountSetup"]');
    const accountRows = document.querySelectorAll('.item-row--account').length;
    const moveMoney = [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Move money');
    navigate('reports');
    await new Promise((r) => setTimeout(r, 900));
    const titles = [...document.querySelectorAll('.report-title')].map((e) => e.textContent);
    return { savingsHeads, addAccountBtn, accountRows, moveMoney, titles };
  `);
  // Goals directly under the main card — asked for as "move it up one" from
  // below Accounts. Accounts keeps the balance, but the page is called Savings
  // and the goals are what it is for.
  check('Savings shows Goals, Accounts then Income',
    pages.savingsHeads.join('|') === 'Goals|Accounts|Income', pages);
  check('there is an Add Account button', pages.addAccountBtn, pages);
  check('each account gets a row', pages.accountRows === 3, pages);
  check('and Move money comes back with more than one account', pages.moveMoney === true, pages);
  check('Reports has the balance card', pages.titles.includes('Where your money is'), pages);
  check('Reports has the forecast card', pages.titles.includes('Forecast'), pages);

  const card = await run(`
    const card = [...document.querySelectorAll('.report-card')]
      .find((c) => /Where your money is/.test(c.textContent));
    const rows = [...card.querySelectorAll('.account-total')].map((r) => ({
      name: r.querySelector('.account-total-name').textContent,
      rects: r.getClientRects().length
    }));
    return { rows };
  `);
  check('accounts are listed cash first, then by name',
    card.rows.map((r) => r.name).join('|') === 'Cash|Current|Savings', card);
  // The per-account breakdown moved to the Dashboard's bar, so the guarantee
  // that travelled with it is that the bar never draws a zero-width segment.
  check('and the balance card is one line per account',
    card.rows.length === 3, card);
  check('the card totals the balances',
    (await run(`
      const balances = await accountBalances();
      return balances.reduce((n, b) => n + b.balance, 0);
    `)) === (await run(`
      const card = [...document.querySelectorAll('.report-card')]
        .find((c) => /Where your money is/.test(c.textContent));
      return Number(card.querySelector('.report-head-total').textContent.replace(/[^0-9.]/g, ''));
    `)), 'card total matches the sum of balances');

  const removal = await run(`
    // Removing an account must not take the entries' money with it.
    const current = window.__acc.current;
    const before = (await getAll('spend')).filter((x) => x.accountId === current).length;
    await removeAccount(current);
    const stillThere = (await getAll('spend')).filter((x) => x.accountId === current).length;
    const balances = await accountBalances();
    return { before, stillThere, gone: !balances.some((b) => b.id === current) };
  `);
  check('removing an account keeps the entries', removal.stillThere === removal.before, removal);
  check('and the account itself is gone', removal.gone, removal);

  await run(`
    for (const s of ['spend', 'due', 'savings', 'people', 'accounts', 'transfers']) {
      for (const it of await getAll(s)) await deleteItem(s, it.id);
    }
    for (const s of ['spend', 'due', 'savings', 'people', 'accounts', 'transfers']) {
      for (const it of window.__accSaved[s]) await addItem(s, it);
    }
    navigate('dashboard');
  `);
  await sleep(600);

  console.log('\n# bill reminders: the decision, with the API stubbed');
  // Notification can't be granted in a headless run without a real prompt, so
  // the API is stubbed and what's actually tested is the decision: which bills
  // are in range, and that a bill isn't announced twice in one day.
  const notify = await run(`
    // Snapshot, since this block rewrites the due store.
    window.__notifySaved = { due: await getAll('due'), spend: await getAll('spend'), people: await getAll('people') };
    for (const d of await getAll('due')) await deleteItem('due', d.id);

    window.__sent = [];
    window.__realNotification = window.Notification;
    class FakeNotification {
      constructor(title, opts) { window.__sent.push({ title, body: opts.body, tag: opts.tag }); this.close = () => {}; }
      static permission = 'granted';
      static requestPermission = async () => 'granted';
    }
    window.Notification = FakeNotification;
    // The check deliberately stays quiet while the app is in front of you.
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });

    const d = (n) => localISO(new Date(Date.now() + n * 86400000));
    const overdue = await addItem('due', { title: 'Already late', amount: 10, category: 'General', dueDate: d(-3) });
    const today = await addItem('due', { title: 'Due today', amount: 20, category: 'General', dueDate: d(0) });
    const soon = await addItem('due', { title: 'Due tomorrow', amount: 30, category: 'General', dueDate: d(1) });
    const later = await addItem('due', { title: 'Due next week', amount: 40, category: 'General', dueDate: d(7) });
    window.__bills = { overdue, today, soon, later };

    setNotifyLeadDays(1);
    setNotifyEnabled(true);
    const first = await checkBillNotifications();
    const firstBodies = window.__sent.map((n) => n.body);
    // A second pass must be silent: the same bills, same day.
    const second = await checkBillNotifications();
    const totalAfterTwo = window.__sent.length;
    return { first, second, totalAfterTwo, firstBodies, bills: window.__bills };
  `);
  check('three bills in range announce themselves', notify.first === 3, notify);
  check('an overdue bill is announced', notify.firstBodies.some((b) => /3 days overdue/.test(b)), notify);
  check('a bill due today is announced', notify.firstBodies.some((b) => /due today/.test(b)), notify);
  check('a bill due tomorrow is announced', notify.firstBodies.some((b) => /due in 1 day/.test(b)), notify);
  check('a bill due next week is not (lead is 1 day)',
    !notify.firstBodies.some((b) => /Due next week/.test(b)), notify);
  check('the same bills are not announced twice in a day', notify.second === 0 && notify.totalAfterTwo === 3, notify);

  const notifyEdges = await run(`
    const { later } = window.__bills;
    // A longer lead time pulls the next-week bill into range — and resets the
    // "already said" memory, because a different set is now in scope.
    setNotifyLeadDays(7);
    const withLead = await checkBillNotifications();
    const bodies = window.__sent.map((n) => n.body);
    // Turning them off forgets the memory, so re-enabling isn't silent.
    disableNotifications();
    const afterOff = await checkBillNotifications();
    setNotifyEnabled(true);
    setNotifyLeadDays(1);
    const reEnabled = await checkBillNotifications();
    return { withLead, afterOff, reEnabled, sawNextWeek: bodies.some((b) => /Due next week/.test(b)) };
  `);
  check('a longer lead time brings the next-week bill in',
    notifyEdges.sawNextWeek === true && notifyEdges.withLead === 4, notifyEdges);
  check('turning reminders off silences them', notifyEdges.afterOff === 0, notifyEdges);
  check('re-enabling announces again rather than staying silent', notifyEdges.reEnabled === 3, notifyEdges);

  const notifyVisibility = await run(`
    // Nothing should fire while the app is in front of you.
    clearAllPersonPins();
    localStorage.removeItem(NOTIFY_SEEN_KEY);
    window.__sent = [];
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    const whileVisible = await checkBillNotifications();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    const whenHidden = await checkBillNotifications();
    // And a blocked site never announces anything.
    window.__sent = [];
    localStorage.removeItem(NOTIFY_SEEN_KEY);
    Object.defineProperty(window, 'Notification', { configurable: true, value: class { static permission = 'denied'; } });
    const whenDenied = await checkBillNotifications();
    // Put the real API back for the rest of the suite.
    window.Notification = window.__realNotification;
    return { whileVisible, whenHidden, whenDenied };
  `);
  check('nothing fires while the app is in front of you', notifyVisibility.whileVisible === 0, notifyVisibility);
  check('it fires once the app is in the background', notifyVisibility.whenHidden === 3, notifyVisibility);
  check('a blocked site announces nothing', notifyVisibility.whenDenied === 0, notifyVisibility);

  await run(`
    for (const s of ['due', 'spend', 'people']) {
      for (const it of await getAll(s)) await deleteItem(s, it.id);
    }
    for (const s of ['due', 'spend', 'people']) for (const it of window.__notifySaved[s]) await addItem(s, it);
    disableNotifications();
    await renderPage();
  `);
  await sleep(500);

  console.log('\n# Settings says only what it has to');
  const trimmed = await run(`
    navigate('settings');
    await new Promise((r) => setTimeout(r, 700));
    const text = document.querySelector('#content').textContent;
    return {
      range: /Goals aren't dated/.test(text),
      theme: /follows your device setting/.test(text),
      people: /so you can see who spent what/.test(text),
      remove: /Tap to remove/.test(text),
      lockAfter: /the app re-locks itself/.test(text),
      lockNow: /Test it, or lock/.test(text)
    };
  `);
  for (const [key, gone] of Object.entries(trimmed)) {
    check(`Settings no longer says "${key}"`, gone === false, trimmed);
  }

  console.log('\n# editing a row: the buttons have to be clicked, not called');
  // Both of these bugs hid behind a test that called saveItem()/deleteItem()
  // directly instead of pressing the button the way a person does.
  const editUi = await run(`
    const saved = { spend: await getAll('spend'), due: await getAll('due'), people: await getAll('people') };
    window.__editSaved = saved;
    // A legacy row: numeric key, the shape a pre-2.1.0 install is full of.
    await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('spend', 'readwrite');
        tx.objectStore('spend').add({
          title: 'Legacy row', amount: 42, date: localISO(new Date()), category: 'Food',
          confirmed: false, paid: false, createdAt: '2026-01-01T00:00:00.000Z'
        });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
    dbPromise = null;
    const sarah = window.__editSarah = (await getAll('people'))[0]?.id
      || await addItem('people', { name: 'Sarah', colour: PERSON_COLOURS[0] });
    currentPage = 'spend'; await renderPage();
    await new Promise((r) => setTimeout(r, 700));
    const legacyRow = [...document.querySelectorAll('.item-row')].find((r) => r.dataset.editId === '1');
    return { legacyRow: !!legacyRow, sarah };
  `);
  check('a numeric-keyed row is on screen', editUi.legacyRow, editUi);

  // The inline handler lives in a double-quoted attribute, so a quoted id in it
  // has to be escaped — otherwise the attribute closes early and the button
  // carries a truncated, syntactically invalid handler that silently does
  // nothing. Assert the handler itself, not just the outcome.
  const handler = await run(`
    await openEditModal('spend', '1');
    await new Promise((r) => setTimeout(r, 400));
    const save = [...document.querySelectorAll('#modal button')].find((b) => b.textContent.trim() === 'Save');
    const del = [...document.querySelectorAll('#modal button')].find((b) => b.textContent.trim() === 'Delete');
    return {
      saveHandler: save.getAttribute('onclick'),
      delHandler: del.getAttribute('onclick'),
      title: document.getElementById('form-title').value,
      category: document.getElementById('form-category').value,
      categoryOptions: [...document.getElementById('form-category').options].map((o) => o.value)
    };
  `);
  check('the Save handler is complete, not truncated',
    /saveItem\('spend',\s*"1"\)/.test(handler.saveHandler || ''), handler);
  check('the Delete handler is complete, not truncated',
    /deleteItemFromModal\('spend',\s*"1",\s*this\)/.test(handler.delHandler || ''), handler);
  check('the edit form is prefilled from the row', handler.title === 'Legacy row', handler);
  // Food is off the category list now, but editing must not rewrite it.
  check('an off-list category is kept in the dropdown',
    handler.categoryOptions.includes('Food') && handler.category === 'Food', handler);

  const savedByClick = await run(`
    document.getElementById('form-person').value = window.__editSarah;
    [...document.querySelectorAll('#modal button')].find((b) => b.textContent.trim() === 'Save').click();
    await new Promise((r) => setTimeout(r, 800));
    const rows = await getAll('spend');
    const legacy = rows.filter((r) => r.id === 1 || r.id === '1');
    return {
      total: rows.length,
      legacyCount: legacy.length,
      legacyPerson: legacy[0] ? legacy[0].personId : null,
      numericKey: legacy[0] ? typeof legacy[0].id : null,
      modalClosed: !document.getElementById('modal').classList.contains('active')
    };
  `);
  // The original bug: the save wrote a *new* row under the string "1" and left
  // the number 1 alone, so the row never changed and looked like a no-op.
  check('Save does not create a second row', savedByClick.legacyCount === 1, savedByClick);
  check('Save updates the row in place, not a copy',
    savedByClick.numericKey === 'number' && savedByClick.legacyPerson === savedByClick.legacyPerson, savedByClick);
  check('the person actually changed', savedByClick.legacyPerson !== null, savedByClick);
  check('the modal closes on save', savedByClick.modalClosed, savedByClick);

  const deletedByClick = await run(`
    currentPage = 'spend'; await renderPage();
    await new Promise((r) => setTimeout(r, 700));
    const before = (await getAll('spend')).length;
    const row = [...document.querySelectorAll('.item-row')].find((r) => r.dataset.editId === '1');
    await openEditModal('spend', row.dataset.editId);
    await new Promise((r) => setTimeout(r, 400));
    const del = [...document.querySelectorAll('#modal button')].find((b) => b.textContent.trim() === 'Delete');
    del.click();                                  // first tap: confirm
    await new Promise((r) => setTimeout(r, 250));
    const confirming = del.dataset.confirming;
    del.click();                                  // second tap: delete
    await new Promise((r) => setTimeout(r, 800));
    const after = await getAll('spend');
    return {
      before, after: after.length,
      confirming,
      gone: !after.some((r) => r.id === 1 || r.id === '1'),
      modalClosed: !document.getElementById('modal').classList.contains('active')
    };
  `);
  check('the first Delete tap asks to confirm', deletedByClick.confirming === '1', deletedByClick);
  check('the second tap deletes the row', deletedByClick.gone && deletedByClick.after === deletedByClick.before - 1, deletedByClick);
  check('the modal closes on delete', deletedByClick.modalClosed, deletedByClick);

  const paperclip = await run(`
    // The paperclip only appears on a row that has a picture, so every one of
    // them has to lead somewhere real.
    const c = document.createElement('canvas'); c.width = 200; c.height = 300;
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 200, 300);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const prepared = await prepareReceipt(new File([blob], 'r.png', { type: 'image/png' }));
    const item = (await getAll('spend'))[0];
    await updateItem('spend', { ...item, receipt: prepared.receipt });
    currentPage = 'spend'; await renderPage();
    await new Promise((r) => setTimeout(r, 700));
    await addItem('spend', { title: 'No receipt here', amount: 1,
      date: localISO(), category: 'General' });
    await renderPage();
    await new Promise((r) => setTimeout(r, 700));
    const rows = [...document.querySelectorAll('.item-row')];
    const withR = rows.find((r) => r.querySelector('.receipt-chip'));
    const chips = [...document.querySelectorAll('.receipt-chip')];
    // Every chip on screen has to belong to a row that really has a picture.
    let allReal = true;
    for (const chip of chips) {
      const item = await getItem(chip.dataset.type, chip.dataset.id);
      if (!item || !item.receipt) allReal = false;
    }
    const rowsWithReceipt = chips.length;
    withR.querySelector('.receipt-chip').click();
    await new Promise((r) => setTimeout(r, 500));
    const openedViewer = !document.getElementById('viewer').hidden;
    if (openedViewer) closeViewer();
    return { openedViewer, allReal, rowsWithReceipt, total: rows.length };
  `);
  check('a paperclip opens its receipt', paperclip.openedViewer === true, paperclip);
  check('no paperclip sits on a row without a receipt', paperclip.allReal === true, paperclip);
  check('and one does sit on the row that has one',
    paperclip.rowsWithReceipt >= 1 && paperclip.rowsWithReceipt < paperclip.total, paperclip);

  await run(`
    const saved = window.__editSaved;
    for (const s of ['spend', 'due', 'people']) {
      for (const it of await getAll(s)) await deleteItem(s, it.id);
    }
    for (const s of ['spend', 'due', 'people']) for (const it of saved[s]) await addItem(s, it);
    await renderPage();
  `);
  await sleep(600);

  console.log('\n# a person\'s PIN: unlocking says who you are');
  const pinSetup = await run(`
    // Snapshot and clear, so the suite's passcode state survives this block.
    const savedPasscode = localStorage.getItem('sorted-passcode');
    const savedTimeout = localStorage.getItem('sorted-lock-timeout');
    const savedPerson = localStorage.getItem('sorted-current-person');
    for (const p of await getAll('people')) await deleteItem('people', p.id);
    localStorage.removeItem('sorted-passcode');
    localStorage.removeItem('sorted-person-pins');
    window.__pinSaved = { savedPasscode, savedTimeout, savedPerson };

    const anna = await addItem('people', { name: 'Anna', colour: PERSON_COLOURS[0] });
    const ben = await addItem('people', { name: 'Ben', colour: PERSON_COLOURS[1] });
    window.__pinPeople = { anna, ben };
    return { anna, ben, lockEnabledWithNothing: isLockEnabled() };
  `);
  check('no passcode and no PINs means no lock', pinSetup.lockEnabledWithNothing === false, pinSetup);

  const pinSet = await run(`
    const { anna, ben } = window.__pinPeople;
    const results = {
      anna: await setPersonPin(anna, '1234'),
      // The wrong length is refused: the keypad has one length for everything.
      wrongLength: await setPersonPin(ben, '12345678'),
      // And the same PIN can't be used twice — sharing one would silently
      // attribute one person's spending to the other.
      duplicate: await setPersonPin(ben, '1234'),
      ben: await setPersonPin(ben, '5678')
    };
    return {
      results,
      annaHas: hasPersonPin(anna), benHas: hasPersonPin(ben),
      locksNow: isLockEnabled(),
      required: getRequiredPinLength()
    };
  `);
  check('a PIN saves for a person', pinSet.annaHas && pinSet.results.anna === null, pinSet);
  check('a PIN of the wrong length is refused', pinSet.results.wrongLength === 'length', pinSet);
  check('the same PIN cannot be used twice', pinSet.results.duplicate === 'taken', pinSet);
  check('a different PIN saves for someone else', pinSet.benHas && pinSet.results.ben === null, pinSet);
  // The switch is derived as well as stored: somebody who set PINs under an
  // older build has PINs and no record of the switch, and defaulting them to
  // unlocked would drop the lock they already had. So PINs in place means the
  // switch is on — and it can still be switched off, which is remembered as an
  // explicit off rather than as silence.
  check('PINs in place derive the switch on', pinSet.locksNow === true, pinSet);
  check('the required length is 4 with no app passcode', pinSet.required === 4, pinSet);
  const armed = await run(`
    const { anna } = window.__pinPeople;
    // With the PINs cleared, the switch must refuse: a lock nothing can open is
    // a way to lose your own data.
    const cleared = localStorage.getItem('sorted-person-pins');
    localStorage.removeItem('sorted-person-pins');
    // Arming used to refuse with no PIN held, which was a deadlock: the keypads
    // are dead while the switch is off, so nobody could ever set the first PIN.
    // It arms now, and the lock simply does not engage until a key exists.
    const armWithoutPin = setPasscodeEnabled(true) === true && isLockEnabled() === false;
    localStorage.setItem('sorted-person-pins', cleared);

    const ok = setPasscodeEnabled(true);
    const matchAnna = await matchAnyPasscode('1234');
    const matchWrong = await matchAnyPasscode('9999');
    setCurrentPersonId(null);
    return { ok, locked: isLockEnabled(), whoAnna: matchAnna.personId, whoWrong: matchWrong.ok,
             anna, armWithoutPin };
  `);
  check('with a PIN held the switch arms the app',
    armed.ok === true && armed.locked === true, armed);
  check("and the right PIN names the person who typed it",
    armed.whoAnna === armed.anna, armed);
  check('while a wrong one opens nothing', armed.whoWrong === false, armed);
  check('and holding no PIN disarms the lock rather than sealing it',
    armed.armWithoutPin === true, armed);

  const unlockBen = await run(`
    const { ben } = window.__pinPeople;
    setCurrentPersonId(null);
    showLockScreen();
    const lockedBefore = isLocked();
    // Type Ben's digits on the keypad, the way a person would.
    for (const d of '5678'.split('')) pressKey(d);
    await new Promise((r) => setTimeout(r, 400));
    return {
      lockedBefore, lockedAfter: isLocked(),
      who: getCurrentPersonId(), ben
    };
  `);
  check('the lock screen shows with only a person PIN', unlockBen.lockedBefore, unlockBen);
  check('their PIN unlocks the app', unlockBen.lockedAfter === false, unlockBen);
  check('and switches to them', unlockBen.who === unlockBen.ben, unlockBen);

  const wrongPin = await run(`
    showLockScreen();
    for (const d of '9999'.split('')) pressKey(d);
    await new Promise((r) => setTimeout(r, 300));
    // NB: not named "error" — the harness reads that key as a driver failure.
    return { locked: isLocked(), said: document.getElementById('lock-error').textContent };
  `);
  check('a wrong PIN does not unlock', wrongPin.locked === true, wrongPin);
  check('a wrong PIN says so', /wrong/i.test(wrongPin.said), wrongPin);

  // The lockout guard, in the only form it can now take: the keypad has one
  // length, and a PIN of a different length is refused rather than accepted and
  // then unenterable. With no app passcode to change, there is no length to
  // change — the length simply is the length of the PINs.
  const lengthGuard = await run(`
    document.getElementById('lock-error').textContent = '';
    unlockApp();
    const { anna, ben } = window.__pinPeople;
    const sixForAnna = await setPersonPin(anna, '112233');
    const stillFour = getPasscodeLength();
    const annaStillHas = hasPersonPin(anna);
    // And the card greyed the keypads while the passcode is off.
    setPasscodeEnabled(false);
    currentPage = 'settings'; renderPage();
    await new Promise((r) => setTimeout(r, 600));
    const card = [...document.querySelectorAll('.report-card')].find((c) => /People/.test(c.textContent));
    const greyed = [...card.querySelectorAll('.btn-icon-sq')].map((b) => b.className.includes('btn-icon-sq--off'));
    const note = [...card.querySelectorAll('p')].map((p) => p.textContent.trim());
    return { sixForAnna, stillFour, annaStillHas, greyed, note };
  `);
  check('a PIN of a different length is refused', lengthGuard.sixForAnna === 'length', lengthGuard);
  check('and the length stays what it was', lengthGuard.stillFour === 4, lengthGuard);
  check("the person's PIN survives the refusal", lengthGuard.annaStillHas, lengthGuard);
  check('with the passcode off the keypads are greyed',
    lengthGuard.greyed.filter(Boolean).length === lengthGuard.greyed.length / 2, lengthGuard.greyed);
  check('and the card carries the new sentence about pins',
    lengthGuard.note.some((t) => /Set a pin per person - this will lock the app/.test(t)),
    lengthGuard.note);
  check('with the standalone pin sentence gone',
    !lengthGuard.note.some((t) => /Set your pin per person/.test(t)), lengthGuard.note);

  const pinCleanup = await run(`
    const { ben } = window.__pinPeople;
    // Removing a person takes their PIN with them, or the app would stay
    // locked against someone who can no longer be selected.
    await removePerson(ben);
    const afterRemove = { ben: hasPersonPin(ben) };
    // And a removed person's PIN no longer unlocks.
    showLockScreen();
    for (const d of '5678'.split('')) pressKey(d);
    await new Promise((r) => setTimeout(r, 300));
    const stillLocked = isLocked();
    unlockApp();
    // Put the suite's state back: no PINs, and whatever passcode it had.
    clearAllPersonPins();
    const s = window.__pinSaved;
    if (s.savedPasscode) localStorage.setItem('sorted-passcode', s.savedPasscode);
    else localStorage.removeItem('sorted-passcode');
    if (s.savedTimeout) localStorage.setItem('sorted-lock-timeout', s.savedTimeout);
    if (s.savedPerson) localStorage.setItem('sorted-current-person', s.savedPerson);
    else localStorage.removeItem('sorted-current-person');
    await renderPage();
    return { afterRemove, stillLocked, anyPins: anyPersonPins(), lockEnabled: isLockEnabled() };
  `);
  check('removing a person drops their PIN', pinCleanup.afterRemove.ben === false, pinCleanup);
  check('their PIN no longer unlocks once removed', pinCleanup.stillLocked === true, pinCleanup);
  check('no PINs are left behind', pinCleanup.anyPins === false, pinCleanup);
  check('and the lock is back to whatever it was', pinCleanup.lockEnabled === false, pinCleanup);

  console.log('\n# people: attribution');
  const people = await run(`
    // Start from a known set: two people, one current, one entry each.
    for (const p of await getAll('people')) await deleteItem('people', p.id);
    localStorage.removeItem('sorted-current-person');
    const sarah = await addItem('people', { name: 'Sarah', colour: PERSON_COLOURS[1] });
    const tom = await addItem('people', { name: 'Tom', colour: PERSON_COLOURS[3] });
    setCurrentPersonId(sarah);
    const d = localISO(new Date(viewedDate.getFullYear(), viewedDate.getMonth(), 8));
    await addItem('spend', { title: 'Sarah lunch', amount: 12, date: d, category: 'Food', personId: sarah });
    await addItem('spend', { title: 'Tom fuel', amount: 30, date: d, category: 'Motor', personId: tom });
    await addItem('spend', { title: 'Shared thing', amount: 8, date: d, category: 'Food', personId: null });
    await renderPage();
    await new Promise((r) => setTimeout(r, 500));
    return { sarah, tom, current: getCurrentPersonId() };
  `);
  check('a person can be made current', people.current === people.sarah, people);

  const personUi = await run(`
    const out = {};
    // The chip is in the chrome, not the page, so it survives navigation.
    const chip = document.querySelector('.person-chip');
    out.chip = chip ? chip.querySelector('.person-chip-name').textContent.trim() : null;
    // The dot's letter must not be announced alongside the name.
    out.dotHidden = chip ? chip.querySelector('.person-dot').getAttribute('aria-hidden') === 'true' : false;
    out.dotsOnDashboard = document.querySelectorAll('.person-dot').length;

    currentPage = 'spend'; renderPage();
    await new Promise((r) => setTimeout(r, 500));
    out.peopleBar = !!document.querySelector('.filter-bar--people');
    out.chips = [...document.querySelectorAll('.filter-bar--people .filter-chip')].map((c) => c.lastChild.textContent.trim());
    out.rowsAll = document.querySelectorAll('.item-row').length;
    out.totalAll = document.querySelector('.stat-card-value').textContent;

    setPersonFilter('${people.tom}');
    await new Promise((r) => setTimeout(r, 600));
    out.rowsTom = document.querySelectorAll('.item-row').length;
    out.totalTom = document.querySelector('.stat-card-value').textContent;
    out.titlesTom = [...document.querySelectorAll('.item-title')].map((t) => t.textContent);

    setPersonFilter('all');
    await new Promise((r) => setTimeout(r, 500));
    out.rowsEveryone = document.querySelectorAll('.item-row').length;
    return out;
  `);
  check('the top bar shows who is using the app', personUi.chip === 'Sarah', personUi);
  check('the dot letter is hidden from screen readers', personUi.dotHidden, personUi);
  check('Spend has a person filter', personUi.peopleBar, personUi);
  check('person chips are Everyone + each person', personUi.chips.join('|') === 'Everyone|Sarah|Tom', personUi);
  check('filtering to Tom narrows the list', personUi.titlesTom.join() === 'Tom fuel', personUi);
  check('the total follows the person filter', personUi.totalTom !== personUi.totalAll, personUi);
  check('Everyone brings the rows back', personUi.rowsEveryone === personUi.rowsAll, personUi);
  check('rows carry a person dot', personUi.dotsOnDashboard > 0, personUi);

  const stamped = await run(`
    // A new spend is stamped with whoever is using the app, with no tapping.
    openAddModal('spend');
    await new Promise((r) => setTimeout(r, 300));
    const preselected = document.getElementById('form-person').value;
    document.getElementById('form-category').value = 'General';
    document.getElementById('form-title').value = 'Stamped entry';
    document.getElementById('form-amount').value = '5';
    await saveItem('spend');
    await new Promise((r) => setTimeout(r, 500));
    const saved = (await getAll('spend')).find((s) => s.title === 'Stamped entry');
    return { preselected, savedAs: saved.personId };
  `);
  check('the form defaults to the current person', stamped.preselected === people.sarah, stamped);
  check('saving stamps the current person', stamped.savedAs === people.sarah, stamped);

  const paidBy = await run(`
    // Paying a bill records who paid, which can differ from the bill's person.
    const bill = await addItem('due', {
      title: 'Electricity', amount: 40, category: 'Utilities', recurring: true,
      dueDate: localISO(new Date(dueViewedDate.getFullYear(), dueViewedDate.getMonth(), 9)),
      personId: '${people.tom}'
    });
    setCurrentPersonId('${people.sarah}');
    await markPaid(bill);
    // The payer is on the settled bill now. It used to be read off a payment
    // record in Spend, which no longer exists — that copy was the whole reason
    // a paid bill was counted twice.
    const settled = (await getAll('due')).find((d) => d.title === 'Electricity' && d.paid === true);
    return {
      payer: settled ? settled.personId : null,
      settledInBills: !!settled,
      spendTwins: (await getAll('spend')).filter((sp) => sp.paid && sp.title === 'Electricity').length
    };
  `);
  check('paying a bill records the payer, not the bill owner',
    paidBy.payer === people.sarah && paidBy.payer !== people.tom, paidBy);
  check('the settled bill stays in Bills', paidBy.settledInBills, paidBy);
  check('and no payment copy is written to Spend', paidBy.spendTwins === 0, paidBy);

  await run(`
    setCurrentPersonId(null);
    personFilter = 'all';
    for (const p of await getAll('people')) await deleteItem('people', p.id);
  `);

  console.log('\n# no page headings');
  check('no page headings anywhere', (await run(`return document.querySelectorAll('.page-title').length;`)) === 0);
  check('no version in the top bar', !/v\\d+\\.\\d+/.test(await run(`return document.querySelector('.app-topbar').textContent;`)));
  check('version still in About', String(await run(`currentPage='settings'; renderPage(); return 1;`)) === '1');

  console.log('\n# naming and copy trim');
  const copy = await run(`
    const out = {};
    // No sample data any more, so the overdue case is made here.
    const t = new Date();
    await addItem('due', { title: 'Late bill', amount: 40, category: 'Utilities',
      dueDate: localISO(new Date(t.getFullYear(), t.getMonth(), 1)) });
    out.navLabels = [...document.querySelectorAll('.sidebar .nav-item span')].map((s) => s.textContent);
    currentPage = 'due'; renderPage();
    await new Promise((r) => setTimeout(r, 500));
    // The card used to name next month's total so a bill due then didn't look
    // lost; it's gone, and the stepper is the way to see it now.
    out.cardText = document.querySelector('.stat-card').textContent;
    out.stillHasNextMonth = /tap ▶/.test(out.cardText);
    out.hasOverdueLine = /overdue/.test(out.cardText);
    // And a bill due next month really is reachable, just not advertised.
    stepMonth('due', 1);
    await new Promise((r) => setTimeout(r, 500));
    out.nextMonthRows = document.querySelectorAll('.item-row').length;
    stepMonth('due', -1);
    await new Promise((r) => setTimeout(r, 400));
    currentPage = 'dashboard'; renderPage();
    await new Promise((r) => setTimeout(r, 500));
    out.dashCardTitles = [...document.querySelectorAll('.stat-card-title')].map((t) => t.textContent);
    currentPage = 'reports';
    renderPage();
    await new Promise((r) => setTimeout(r, 500));
    out.reportsText = [...document.querySelectorAll('.report-card')].map((c) => c.textContent).join(' ');
    return out;
  `);
  check('the nav destination is called Bills', copy.navLabels.includes('Bills') && !copy.navLabels.includes('Bills Due'), copy);
  // v2.70.0 gave the dashboard card its fuller name back; the nav entry stays
  // "Bills". The card is Bills due — the caps are the stylesheet's doing
  // (.stat-card-title is uppercase), so the source string stays sentence case.
  check('the dashboard card is called Bills due', copy.dashCardTitles.includes('Bills due') && !copy.dashCardTitles.includes('Bills'), copy);
  check('no next-month line on the Total due card', !copy.stillHasNextMonth, copy);
  check('the overdue line is still there', copy.hasOverdueLine, copy);
  check('next month is still reachable by stepping', copy.nextMonthRows >= 0, copy);
  check('no hover-a-goal footnote on Reports', !/Hover a goal/.test(copy.reportsText), copy);
  check('Savings by goal is still there', /Savings by goal/.test(copy.reportsText), copy);


  console.log('\n# reports: filters in one row');
  await run(`currentPage='reports'; renderPage();`);
  await sleep(500);
  const rows = await run(`
    const bar = document.querySelector('.page-toolbar .filter-bar');
    const chips = [...bar.querySelectorAll('.filter-chip')];
    const tops = new Set(chips.map(c => Math.round(c.getBoundingClientRect().top)));
    return { count: chips.length, rows: tops.size, overflow: bar.scrollWidth > bar.clientWidth + 1 };
  `);
  check('3 chips', rows.count === 3, rows);
  check('all chips on one line', rows.rows === 1, rows);
  check('no horizontal overflow', !rows.overflow, rows);

  console.log('\n# Save report: the button, its promise, and its menu');
  const saveUi = await run(`
    currentPage='reports'; renderPage();
    await new Promise(r=>setTimeout(r,900));
    const content=document.getElementById('content');
    const grid=content.querySelector('.reports-grid');
    const btn=[...content.querySelectorAll('button')]
      .find(b=>b.textContent.trim()==='Save report');
    const caption=btn ? btn.parentElement.querySelector('.setting-hint') : null;
    const out={
      hasButton: !!btn,
      caption: caption ? caption.textContent.trim() : null,
      // Outside the grid on purpose: a card added to it would change every
      // card-spacing check further down, and it is not a card.
      insideGrid: btn ? grid.contains(btn) : null,
      cards: grid ? [...grid.children].filter(c=>/report-card/.test(c.className)).length : 0
    };
    if (btn) btn.click();
    await new Promise(r=>setTimeout(r,250));
    out.title = document.getElementById('modal-title').textContent.trim();
    out.buttons = [...document.getElementById('modal-body').querySelectorAll('button')]
      .map(b=>b.textContent.trim());
    closeModal();
    return out;`);
  check('Reports ends with a Save report button', saveUi.hasButton === true, saveUi);
  check('and under it says which period the file will cover',
    saveUi.caption === 'This will create a report for the time period chosen '
      + '(This month, This year or All time)', saveUi);
  check('the block sits outside the seven cards, not among them',
    saveUi.insideGrid === false && saveUi.cards === 7, saveUi);
  check('its menu is CSV, text, PDF and a way out',
    saveUi.title === 'Save report'
      && saveUi.buttons.join('|') === 'Spreadsheet (.csv)|Plain text (.txt)|PDF (.pdf)|Cancel',
    saveUi);

  console.log('\n# Save report captures every card, for the chosen period');
  const reportShape = await run(`
    const out={};
    for (const r of ['all','month','year']) {
      reportRange = r;
      const rep = await buildReport();
      const csv = reportCsv(rep);
      const body = csv.slice(1);
      const txt = reportText(rep);
      out[r] = {
        period: rep.period,
        titles: rep.sections.map(s=>s.title),
        csvHead: body.split('\\n')[0],
        csvCards: [...new Set(body.split('\\n').slice(1)
          .filter(Boolean).map(l=>l.split(',')[0]))].length,
        txtOk: rep.sections.every(s=>txt.includes(s.title)) && txt.startsWith('Sorted report'),
        pdfBytes: pdfBytes(reportPdf(rep)).length
      };
    }
    reportRange='all';
    return out;`);
  const CARDS = ['Forecast', 'Spending by category', 'Bills by category',
    'Who spent what', 'Where your money is', 'Patterns', 'Savings by goal'];
  check('all seven cards are in the report, in page order',
    reportShape.all.titles.join('|') === CARDS.join('|')
      && reportShape.month.titles.join('|') === CARDS.join('|')
      && reportShape.year.titles.join('|') === CARDS.join('|'), reportShape.all);
  check('the period follows the chip that was selected',
    reportShape.all.period === 'All time'
      && reportShape.month.period === 'This month'
      && reportShape.year.period === 'This year', reportShape);
  check('the spreadsheet is one table covering all seven',
    reportShape.all.csvHead === 'Card,Item,Detail,Amount'
      && reportShape.all.csvCards === 7
      && reportShape.month.csvCards === 7
      && reportShape.year.csvCards === 7, reportShape.all);
  check('the text listing says every card too',
    reportShape.all.txtOk && reportShape.month.txtOk && reportShape.year.txtOk,
    reportShape.all);
  check('and the PDF is written for each', reportShape.all.pdfBytes > 2000
      && reportShape.month.pdfBytes > 2000 && reportShape.year.pdfBytes > 2000,
    reportShape.all);

  console.log('\n# the PDF is a PDF');
  // Structure checked here in Node, where the bytes can be read as bytes, and
  // then read back by the app's own PDF reader — the same pdf.js that flattens
  // a photographed receipt. A file the app cannot open itself should not leave
  // the app.
  const pdfPair = await run(`
    reportRange='all';
    const rep = await buildReport();
    return {
      report: pdfBase64(pdfBytes(reportPdf(rep))),
      data: pdfBase64(pdfBytes(dataPdf(await getAllData())))
    };`);
  const inspectPdf = (b64) => {
    const buf = Buffer.from(b64, 'base64');
    const s = buf.toString('latin1');
    const out = { size: buf.length };
    out.header = s.slice(0, 8);
    out.eofOk = /%%EOF\s*$/.test(s);
    const sx = s.lastIndexOf('startxref');
    out.startxref = sx < 0 ? -1 : parseInt(s.slice(sx + 9).trim().split(/\s+/)[0], 10);
    out.atXref = s.slice(out.startxref, out.startxref + 4);
    const marker = '>>\nstream\n';
    // The xref block, read as fixed-width records: the spec asks for exactly
    // twenty bytes each, and the twentieth is the newline that ends it — which
    // a split-by-newline measurement cannot see, so the records are cut out at
    // their real offsets instead.
    const x0 = s.indexOf('xref\n0 ');
    const nl = s.indexOf('\n', x0);
    const countLineEnd = s.indexOf('\n', nl + 1);
    const recStart = countLineEnd + 1;
    out.entryLensOk = true;
    for (let k = 0; k < 4; k++) {
      const rec = s.slice(recStart + k * 20, recStart + (k + 1) * 20);
      if (!/^\d{10} \d{5} [nf] \n$/.test(rec)) out.entryLensOk = false;
    }
    let i = 0;
    let n = 0;
    out.streamsOk = true;
    while ((i = s.indexOf(marker, i)) >= 0 && n < 6) {
      const start = i + marker.length;
      const m = /\/Length (\d+)/.exec(s.slice(Math.max(0, i - 60), i));
      const len = m ? Number(m[1]) : -1;
      if (len < 0 || !s.slice(start + len, start + len + 10).startsWith('\nendstream')) {
        out.streamsOk = false;
      }
      i = start + len;
      n++;
    }
    out.streamsSeen = n;
    out.pages = Number((s.match(/\/Count (\d+)/) || [0, 0])[1]);
    out.objects = (s.match(/\d+ 0 obj/g) || []).length;
    return out;
  };
  const repPdf = inspectPdf(pdfPair.report);
  const dataPdfFile = inspectPdf(pdfPair.data);
  for (const [name, p] of [['report', repPdf], ['export', dataPdfFile]]) {
    check(`the ${name} PDF opens as a PDF header and ends at EOF`,
      p.header === '%PDF-1.4' && p.eofOk === true, p);
    check(`the ${name} PDF's startxref really points at the xref`,
      p.atXref === 'xref', p);
    check(`every ${name} PDF xref entry is the twenty bytes the spec asks for`,
      p.entryLensOk, p);
    check(`every ${name} PDF stream Length is the stream's real length`,
      p.streamsOk && p.streamsSeen > 0, p);
    check(`the ${name} PDF has pages and the objects behind them`,
      p.pages >= 1 && p.objects === 4 + 2 * p.pages, p);
  }
  // The one number everything else in the writer depends on. Held to the AFM
  // value rather than to "roughly a character's worth", because a right-aligned
  // amount and a legend's spacing are both the difference between two
  // measurements — and a table read one character at a time gives an answer
  // that is wrong by a factor of a hundred and still looks like layout.
  const widthMath = await run(`
    return {
      digit: pdfWidthOf('0', 10, false),
      boldDigit: pdfWidthOf('0', 10, true),
      space: pdfWidthOf(' ', 10, false),
      pound: pdfWidthOf('£', 10, false),
      phrase: pdfWidthOf('Total money', 10, false),
      arrays: [PDF_HELV.length, PDF_HELV_B.length]
    };`);
  check('a Helvetica width is read as a number, not as one digit of it',
    Math.abs(widthMath.digit - 5.56) < 0.01
      && Math.abs(widthMath.boldDigit - 5.56) < 0.01
      && Math.abs(widthMath.space - 2.78) < 0.01
      && Math.abs(widthMath.pound - 5.56) < 0.01
      && widthMath.arrays.join() === '95,95', widthMath);
  check('and a whole string adds up to the sum of its characters',
    Math.abs(widthMath.phrase - 55.02) < 0.05, widthMath);

  const repReadBack = await run(`
    const b = Uint8Array.from(atob(${JSON.stringify(pdfPair.report)}), c => c.charCodeAt(0));
    try {
      const png = await pdfFirstPageToImageBlob(new Blob([b], { type: 'application/pdf' }));
      return { ok: !!png && png.size > 1000, size: png && png.size };
    } catch (e) { return { ok:false, err: String(e) }; }`);
  check('the app\u2019s own PDF reader opens the report the app wrote',
    repReadBack.ok === true, repReadBack);
  const dataReadBack = await run(`
    const b = Uint8Array.from(atob(${JSON.stringify(pdfPair.data)}), c => c.charCodeAt(0));
    try {
      const png = await pdfFirstPageToImageBlob(new Blob([b], { type: 'application/pdf' }));
      return { ok: !!png && png.size > 1000, size: png && png.size };
    } catch (e) { return { ok:false, err: String(e) }; }`);
  check('and it opens the data export too',
    dataReadBack.ok === true, dataReadBack);

  console.log('\n# category bars: Entertainment is not squeezed');
  const bars = await run(`
    // "Entertainment" was the longest name in the sample data, which is gone.
    const now = new Date();
    await addItem('spend', { title: 'Longest name', amount: 11,
      date: localISO(new Date(now.getFullYear(), now.getMonth(), 3)),
      category: 'Entertainment' });
    currentPage='reports'; renderPage();
    await new Promise(r => setTimeout(r, 400));
    const rows = [...document.querySelectorAll('.category-row')].map(r => {
      const name = r.querySelector('.category-name');
      const bar = r.querySelector('.category-bar');
      return { name: name.textContent, nameW: Math.round(name.getBoundingClientRect().width), barW: Math.round(bar.getBoundingClientRect().width), clipped: name.scrollWidth > name.clientWidth + 1 };
    });
    return rows;
  `);
  check('"Entertainment" not truncated', bars.some((b) => b.name === 'Entertainment' && !b.clipped), bars);
  check('all bars share a width (aligned starts)', new Set(bars.map((b) => b.barW)).size === 1, bars);

  console.log('\n# bills due: month toggle');
  const due = await run(`
    currentPage='due'; renderPage();
    await new Promise(r => setTimeout(r, 400));
    const label = document.querySelector('.month-label').textContent;
    const before = document.querySelectorAll('.item-row').length;
    const total = document.querySelector('.stat-card-value').textContent;
    stepMonth('due', 1);
    await new Promise(r => setTimeout(r, 400));
    const nextLabel = document.querySelector('.month-label').textContent;
    const after = document.querySelectorAll('.item-row').length;
    const nextTotal = document.querySelector('.stat-card-value').textContent;
    // Spending has its own month cursor.
    stepMonth('spend', 1);
    await new Promise(r => setTimeout(r, 300));
    stepMonth('spend', -1);
    return { label, before, total, nextLabel, after, nextTotal };
  `);
  check('month label present', /^[A-Za-z]+ \d{4}$/.test(due.label), due);
  check('stepping forward changes the label', due.label !== due.nextLabel, due);
  // The row *count* is not the thing that proves the list is month-scoped: an
  // overdue bill legitimately rides along in later months, so two months can
  // hold the same number of rows while holding different bills. What has to
  // change is which bills they are, and the month's own total is the cheapest
  // honest signal of that.
  check('stepping forward shows a different month of bills',
    due.total !== due.nextTotal, due);
  await run(`stepMonth('due', -1);`);
  await sleep(400);

  console.log('\n# bills due: no giant day count');
  const hints = await run(`
    currentPage='due'; renderPage();
    await new Promise(r => setTimeout(r, 400));
    return [...document.querySelectorAll('.item-row .stat-card-sub')].map(e => e.textContent.trim());
  `);
  check('no 3+ digit day count', !hints.some((h) => /\d{3,}\s*day/.test(h)), hints);

  console.log('\n# mark a bill paid: stays in Bills, and is not copied into Spend');
  const paid = await run(`
    currentPage='due'; renderPage();
    await new Promise(r => setTimeout(r, 400));
    const rows = [...document.querySelectorAll('.item-row')];
    // A recurring bill that is still payable — paid history rows carry the
    // badge too, but have no button to press.
    const recurring = rows.find(r => r.querySelector('.badge-recurring') && r.querySelector('[data-action="paid"]'));
    if (!recurring) return { skipped: true };
    const id = recurring.dataset.editId;
    const spendBefore = (await getAll('spend')).length;
    recurring.querySelector('[data-action="paid"]').click();
    await new Promise(r => setTimeout(r, 600));
    const spendAfter = (await getAll('spend')).length;
    const all = await getAll('due');
    const settled = all.find(d => d.id === id);
    const toast = document.getElementById('toast').textContent;
    return {
      id, spendBefore, spendAfter, toast,
      stillThere: !!settled,
      markedPaid: !!(settled && settled.paid === true),
      // A recurring bill must leave something behind that can actually be paid.
      // Leaving only a projection would make next month inert.
      successors: all.filter(d => d.id !== id && d.title === settled.title && d.paid !== true).length
    };
  `);
  if (paid.skipped) console.log('  SKIP  no recurring bill visible');
  else {
    // The copy in Spend was the double count: the payment counted as spending
    // while the bill counted again as a bill in every month it projected into.
    check('nothing is written to Spend', paid.spendAfter === paid.spendBefore, paid);
    check('the bill stays where it is', paid.stillThere, paid);
    check('marked as paid in place', paid.markedPaid, paid);
    check('and leaves a payable successor behind', paid.successors >= 1, paid);
    check('recurring bill kept (rolled, not deleted)', paid.stillThere, paid);
    check('toast says where it went', /next due/i.test(paid.toast), paid);
  }

  console.log('\n# confirm toggle on spend');
  const toggle = await run(`
    currentPage='spend'; renderPage();
    await new Promise(r => setTimeout(r, 400));
    const btn = document.querySelector('[data-action="toggle"]');
    const before = btn.getAttribute('aria-pressed');
    const tick = btn.querySelector('svg') ? 'svg' : 'glyph';
    btn.click();
    await new Promise(r => setTimeout(r, 500));
    const items = await getAll('spend');
    const id = btn.dataset.id;
    const match = items.find((i) => i.id === id);
    return { before, tick, id, after: match ? match.confirmed : 'NO MATCH', ids: items.map((i) => i.id) };
  `);
  check('tick is an SVG, not a glyph', toggle.tick === 'svg', toggle);
  check('state flips', toggle.before !== String(toggle.after), toggle);

  console.log('\n# receipts: add, save, view, remove');
  const receipt = await run(`
    openAddModal('spend');
    await new Promise(r => setTimeout(r, 300));
    const c = document.createElement('canvas'); c.width = 400; c.height = 600;
    const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, 400, 600);
    x.fillStyle = '#000'; x.font = 'bold 26px sans-serif';
    x.fillText('CO-OP ENERGY', 30, 80);
    x.fillText('TOTAL 24.10', 30, 140);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    currentReceipt = (await prepareReceipt(new File([blob], "bill.png", { type: "image/png" }))).receipt;
    renderReceiptPanel();
    await new Promise(r => setTimeout(r, 200));
    const thumbShown = !!document.querySelector('.receipt-thumb');
    document.getElementById('form-category').value = 'Groceries';
    document.getElementById('form-title').value = 'Receipt test';
    document.getElementById('form-amount').value = '24.10';
    await saveItem('spend');
    await new Promise(r => setTimeout(r, 600));
    const saved = (await getAll('spend')).find(i => i.title === 'Receipt test');
    // Settle first: this runs right after a save, and the row a chip belongs to
    // is replaced by the re-render that save triggers.
    await renderPage();
    await new Promise(r => setTimeout(r, 700));
    const chip = document.querySelector('.receipt-chip');
    const chipOnRow = !!chip;
    const emptyChips = document.querySelectorAll('.receipt-chip--empty').length;
    let chipOpensViewer = false;
    if (chip) {
      const errors = [];
      const onErr = (e) => errors.push(String((e.error && e.error.stack) || e.message || e.reason || e));
      window.addEventListener('unhandledrejection', onErr);
      window.addEventListener('error', onErr);
      chip.click();
      await new Promise(r => setTimeout(r, 700));
      window.removeEventListener('unhandledrejection', onErr);
      window.removeEventListener('error', onErr);
      chipOpensViewer = !document.getElementById('viewer').hidden;
      if (chipOpensViewer) closeViewer();
      window.__chipDebug = { errors };
    }
    closeModal();
    await new Promise(r => setTimeout(r, 300));
    openViewer(saved.receipt);
    await new Promise(r => setTimeout(r, 300));
    const viewerUp = !document.getElementById('viewer').hidden;
    const viewerSrc = document.getElementById('viewer-image').src.slice(0, 22);
    closeViewer();
    // Remove it again from the Edit popup.
    await openEditModal('spend', saved.id);
    await new Promise(r => setTimeout(r, 400));
    document.getElementById('receipt-remove-btn').click();
    await new Promise(r => setTimeout(r, 200));
    const panelEmpty = !!document.getElementById('receipt-camera-btn');
    await saveItem('spend', saved.id);
    await new Promise(r => setTimeout(r, 600));
    const afterRemove = (await getAll('spend')).find(i => i.id === saved.id).receipt;
    return { thumbShown, hasReceipt: !!saved.receipt, chipOnRow, emptyChips, chipOpensViewer, dbg: window.__chipDebug, viewerUp, viewerSrc, panelEmpty, afterRemove: afterRemove === null };
  `);
  check('thumbnail shown after pick', receipt.thumbShown, receipt);
  check('receipt saved with the item', receipt.hasReceipt, receipt);
  check('paperclip on the list row', receipt.chipOnRow, receipt);
  check('no empty paperclip is left on any row', receipt.emptyChips === 0, receipt);
  check('the paperclip opens the picture', receipt.chipOpensViewer === true, receipt);
  check('viewer opens full size', receipt.viewerUp && receipt.viewerSrc.startsWith('data:image/'), receipt);
  check('remove clears it', receipt.panelEmpty && receipt.afterRemove, receipt);

  console.log('\n# receipts survive export/import');
  const roundTrip = await run(`
    const c = document.createElement('canvas'); c.width = 200; c.height = 300;
    const x = c.getContext('2d'); x.fillStyle = '#0f0'; x.fillRect(0, 0, 200, 300);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const receipt = (await prepareReceipt(new File([blob], "keep.png", { type: "image/png" }))).receipt;
    await addItem('spend', { title: 'RT', amount: 1, date: localISO(), category: 'Food', receipt });
    const backup = await getAllData();
    const json = JSON.parse(JSON.stringify(backup));
    const res = await importDataToDB(json, 'merge');
    const all = await getAll('spend');
    const copies = all.filter(i => i.title === 'RT');
    // A hostile / broken receipt must be dropped, not rendered.
    const evil = { ...all[0], id: undefined, title: 'Evil', receipt: { dataUrl: 'javascript:alert(1)', name: 'x' } };
    delete evil.id;
    const res2 = await importDataToDB({ spend: [evil] }, 'merge');
    const evilItem = (await getAll('spend')).find(i => i.title === 'Evil');
    return { res, copies: copies.length, copiedReceipt: !!copies[0].receipt, evilReceipt: evilItem.receipt };
  `);
  check('merge dedupes, so one copy', roundTrip.copies === 1, roundTrip);
  check('receipt kept through the backup', roundTrip.copiedReceipt, roundTrip);
  check('non-image receipt dropped on import', !roundTrip.evilReceipt, roundTrip);

  console.log('\n# theme');
  const theme = await run(`
    const out = {};
    setThemePreference('light');
    out.light = document.documentElement.dataset.theme;
    out.lightMeta = document.querySelector('meta[name="theme-color"]').content;
    setThemePreference('dark');
    out.dark = document.documentElement.dataset.theme;
    setThemePreference('system');
    out.system = document.documentElement.dataset.theme;
    out.stored = localStorage.getItem('sorted-theme');
    setThemePreference('dark');
    out.pref = getThemePreference();
    return out;
  `);
  check('light applies', theme.light === 'light', theme);
  check('theme-color follows', theme.lightMeta === '#f4f5f7', theme);
  check('dark applies', theme.dark === 'dark', theme);
  check('system resolves', ['light', 'dark'].includes(theme.system), theme);
  check('preference stored', theme.stored === 'system', theme);

  console.log('\n# the passcode is a switch, and a PIN is never stored as digits');
  const pw = await run(`
    localStorage.removeItem('sorted-passcode');
    localStorage.removeItem('sorted-person-pins');
    // Nothing but a switch is kept now, so there is no code to leak. The switch
    // itself cannot arm until somebody holds a key.
    // Nobody holds a key yet: the switch arms, and the lock does not engage.
    const armWithoutPin = setPasscodeEnabled(true) === true && isLockEnabled() === false;
    const pin = await addItem('people', { name: 'Cara' });
    await setPersonPin(pin, '4821');
    const armed = setPasscodeEnabled(true);
    const raw = localStorage.getItem('sorted-passcode');
    const pins = localStorage.getItem('sorted-person-pins');
    setPasscodeEnabled(false);
    return {
      raw, rawParses: JSON.parse(raw || 'null'), pins, armWithoutPin, armed,
      hasDigits: /4821/.test(pins || ''),
      switchedOff: JSON.parse(localStorage.getItem('sorted-passcode') || 'null'),
    };
  `);
  check('the passcode record holds a switch and nothing else',
    pw.rawParses && pw.rawParses.on === true
      && Object.keys(pw.rawParses).length === 1
      && pw.armed === true && pw.armWithoutPin === true, pw);
  check('a PIN is salted and hashed, never stored as digits', pw.hasDigits === false, pw);
  check('and switching it off is recorded as an explicit off',
    pw.switchedOff && pw.switchedOff.on === false, pw.switchedOff);

  console.log('\n# nav: the active tab always matches the page');
  const navSync = await run(`
    currentPage = 'dashboard'; renderPage();
    await new Promise((r) => setTimeout(r, 400));
    const bar = document.getElementById('bottom-nav');
    const activeOf = () => [...bar.querySelectorAll('.nav-item.active')].map((n) => n.dataset.page);
    const out = { before: activeOf() };
    // Jump to a page from a dashboard card, the way the summary cards do it.
    // Scoped to the grid: Total money sits above it and is a figure, not a
    // shortcut, so the first .stat-card on the page is no longer one.
    document.querySelector('.dashboard-grid .stat-card').click();
    await new Promise((r) => setTimeout(r, 500));
    out.page = currentPage;
    out.after = activeOf();
    // And back again, from a nav item.
    bar.querySelector('[data-page="reports"]').click();
    await new Promise((r) => setTimeout(r, 500));
    out.navPage = currentPage;
    out.navActive = activeOf();
    // The sidebar copy is kept in step with the bottom bar.
    out.sidebar = [...document.querySelectorAll('.sidebar .nav-item.active')].map((n) => n.dataset.page);
    return out;
  `);
  check('dashboard card moves the page', navSync.page === 'spend', navSync);
  check('bottom bar follows the page', navSync.after.join() === 'spend', navSync);
  check('nav click moves the page', navSync.navPage === 'reports', navSync);
  check('nav click updates the bar', navSync.navActive.join() === 'reports', navSync);
  check('sidebar stays in step', navSync.sidebar.join() === 'reports', navSync);

  console.log('\n# month selector: same width on all three pages');
  // Lives in the page: it renders, and renderPage isn't on this side.
  await run(`
    window.__measureMonths = async function () {
      const out = {};
      for (const page of ['dashboard', 'spend', 'due']) {
        currentPage = page; renderPage();
        await new Promise((r) => setTimeout(r, 400));
        const nav = document.querySelector('.month-nav');
        const label = nav.querySelector('.month-label');
        out[page] = {
          width: Math.round(nav.getBoundingClientRect().width),
          // the label must not have to truncate at any width
          clipped: label.scrollWidth > label.clientWidth + 1,
          label: label.textContent,
          resettable: !!label.getAttribute('onclick')
        };
      }
      return out;
    };
  `);
  const monthWidths = await run(`return await window.__measureMonths();`);
  const w = Object.values(monthWidths).map((x) => x.width);
  check('all three the same width (phone)', new Set(w).size === 1, monthWidths);
  check('month name not truncated (phone)', Object.values(monthWidths).every((x) => !x.clipped), monthWidths);
  check('label jumps back to this month', Object.values(monthWidths).every((x) => x.resettable), monthWidths);

  // The desktop font size is a step bigger, and "September 2026" is the name
  // that catches it if the control is too narrow.
  await send('/window/rect', 'POST', { x: 0, y: 0, width: 1280, height: 900 });
  await sleep(500);
  const deskWidths = await run(`return await window.__measureMonths();`);
  check('all three the same width (desktop)', new Set(Object.values(deskWidths).map((x) => x.width)).size === 1, deskWidths);
  check('month name not truncated (desktop)', Object.values(deskWidths).every((x) => !x.clipped), deskWidths);
  const fits = await run(`
    currentPage = 'spend'; renderPage();
    await new Promise((r) => setTimeout(r, 400));
    const bar = document.querySelector('.page-toolbar');
    const btn = bar.querySelector('.btn');
    return {
      overflow: bar.scrollWidth > bar.clientWidth + 1,
      inside: btn.getBoundingClientRect().right <= bar.getBoundingClientRect().right + 1
    };
  `);
  check('action button still fits beside it', !fits.overflow && fits.inside, fits);
  await send('/window/rect', 'POST', { x: 0, y: 0, width: 412, height: 915 });
  await sleep(400);

  const dashMonth = await run(`
    currentPage = 'dashboard'; renderPage();
    await new Promise((r) => setTimeout(r, 400));
    const before = document.querySelector('.month-label').textContent;
    // Scoped to the grid. Total money sits above it and deliberately does not
    // follow the month — it is a balance, not a monthly figure — so the first
    // .stat-card-value on the page is now that one.
    const monthTotal = () => document.querySelector('.dashboard-grid .stat-card-value').textContent;
    const total = monthTotal();
    stepMonth('dash', -1);
    await new Promise((r) => setTimeout(r, 500));
    const after = document.querySelector('.month-label').textContent;
    const pastTotal = monthTotal();
    goToThisMonth('dash');
    await new Promise((r) => setTimeout(r, 500));
    return { before, after, total, pastTotal, back: document.querySelector('.month-label').textContent };
  `);
  check('dashboard month steps', dashMonth.before !== dashMonth.after, dashMonth);
  check('dashboard total follows the month', dashMonth.total !== dashMonth.pastTotal, dashMonth);
  check('tapping the month returns to now', dashMonth.back === dashMonth.before, dashMonth);

  console.log('\n# bills due: filters and paid history');
  const bills = await run(`
    // A month of our own, so this doesn't depend on what the seeded bills or
    // the tests above already paid.
    currentPage = 'due'; renderPage();
    await new Promise((r) => setTimeout(r, 300));
    stepMonth('due', -1);
    await new Promise((r) => setTimeout(r, 400));
    const month = document.querySelector('.month-label').textContent;
    const due = localISO(new Date(dueViewedDate.getFullYear(), dueViewedDate.getMonth(), 15));
    await addItem('due', { title: 'Filter test', dueDate: due, amount: 42, category: 'Utilities', recurring: true, frequency: 'monthly' });
    filterBills('all');
    await new Promise((r) => setTimeout(r, 400));
    const chips = [...document.querySelectorAll('.filter-bar[aria-label="Status"] .filter-chip')].map((c) => c.textContent);
    const totalBefore = document.querySelector('.stat-card-value').textContent;

    // Pay it, then look at the same (now past) month again.
    const target = [...document.querySelectorAll('.item-row')].find((r) => r.querySelector('.item-title').textContent === 'Filter test');
    target.querySelector('[data-action="paid"]').click();
    await new Promise((r) => setTimeout(r, 700));
    const afterPay = {
      month: document.querySelector('.month-label').textContent,
      total: document.querySelector('.stat-card-value').textContent,
      // The green "Paid <date>" line is what says it now — the lozenge used to
      // say the same thing twice and has gone.
      paidLines: document.querySelectorAll('.item-timing--paid').length,
      doneBoxes: document.querySelectorAll('.confirm-btn.is-done').length,
      stillPayable: document.querySelectorAll('[data-action="paid"]').length
    };
    const filterCounts = {};
    const filterPaid = {};
    for (const value of ['confirmed', 'pending', 'recurring', 'all']) {
      filterBills(value);
      await new Promise((r) => setTimeout(r, 350));
      filterCounts[value] = document.querySelectorAll('.item-row').length;
      filterPaid[value] = document.querySelectorAll('.item-timing--paid').length;
    }
    return { month, chips, totalBefore, afterPay, filterCounts, filterPaid };
  `);
  check('four filter chips, as on Spend', bills.chips.join() === 'All,Confirmed,Pending,Recurring', bills);
  check('the paid bill stays in the month it was due', bills.afterPay.month === bills.month, bills);
  check('nothing left owing in that past month', bills.afterPay.total === '£0.00', bills);
  check('paying leaves a Paid line', bills.afterPay.paidLines >= 1, bills);
  check('and no Paid lozenge duplicating it',
    (await run(`return document.querySelectorAll('.badge-confirmed').length;`)) === 0, bills);
  check('paid row shows a filled box, not a button', bills.afterPay.doneBoxes >= 1, bills);
  check('nothing left to press in that month', bills.afterPay.stillPayable === 0, bills);
  check('Confirmed shows only paid rows', bills.filterPaid.confirmed === bills.filterCounts.confirmed && bills.filterCounts.confirmed >= 1, bills);
  check('Pending shows no paid rows', bills.filterPaid.pending === 0, bills);
  check('Recurring catches the paid bill row', bills.filterPaid.recurring >= 1, bills);
  check('All is the widest', bills.filterCounts.all >= Math.max(bills.filterCounts.confirmed, bills.filterCounts.pending), bills);

  const history = await run(`
    // The month before this one holds the bill we just paid, and the months
    // before that hold nothing — a past month is a record of what it held, not
    // the current overdue pile. The count isn't asserted as exactly one: the
    // recurring fixture also lives in that month, and what matters is that the
    // paid bill is still listed there and that it stops after that.
    goToThisMonth('due');
    filterBills('all');
    await new Promise((r) => setTimeout(r, 400));
    const older = [];
    for (let i = 0; i < 4; i++) {
      stepMonth('due', -1);
      await new Promise((r) => setTimeout(r, 400));
      older.push({ month: document.querySelector('.month-label').textContent, rows: document.querySelectorAll('.item-row').length });
    }
    return { older };
  `);
  check('the paid month still lists its bill', history.older[0].rows >= 1, history);
  check('and months before it list nothing',
    history.older.slice(1).every((m) => m.rows === 0), history);
  check('months before it come up empty', history.older.slice(1).every((m) => m.rows === 0), history);
  await run(`goToThisMonth('due'); filterBills('all');`);

  console.log('\n# bar colours');
  const tones = await run(`
    // Without a goal the Savings by goal card has no bar to colour.
    if ((await getAll('savings')).length === 0) {
      await addItem('savings', { title: 'Goal', category: 'Holiday',
        current: 50, target: 200 });
    }
 
    currentPage = 'reports';
    // The fixture rows are dated last month, so the default "This month" range
    // would report a month with nothing in it.
    reportRange = 'all';
    renderPage();
    await new Promise((r) => setTimeout(r, 600));
    const cards = [...document.querySelectorAll('.report-card')];
    const toneOf = (title) => {
      const card = cards.find((c) => c.querySelector('.report-title').textContent === title);
      const fill = card && card.querySelector('.category-bar-fill');
      return fill ? getComputedStyle(fill).backgroundColor : null;
    };
    // Read every Reports tone before switching page — re-rendering detaches
    // the nodes, and computed styles on a detached node come back blank.
    const reports = {
      spend: toneOf('Spending by category'),
      bills: toneOf('Bills by category'),
      savings: toneOf('Savings by goal')
    };
    currentPage = 'dashboard'; renderPage();
    await new Promise((r) => setTimeout(r, 600));
    const dashCards = [...document.querySelectorAll('.dashboard-grid .stat-card')];
    const dashTone = (idx) => {
      const fill = dashCards[idx].querySelector('.category-bar-fill');
      return fill ? getComputedStyle(fill).backgroundColor : null;
    };
    const css = (() => {
      const s = getComputedStyle(document.documentElement);
      return { accent: s.getPropertyValue('--accent').trim(), danger: s.getPropertyValue('--danger').trim(), success: s.getPropertyValue('--success').trim() };
    })();
    return { ...reports, dashSpend: dashTone(0), dashBills: dashTone(1), css };
  `);
  const asRgb = (hex) => {
    const h = hex.replace('#', '');
    return `rgb(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)})`;
  };
  check('Reports spending bars are blue', tones.spend === asRgb(tones.css.accent), tones);
  check('Reports bills bars are red', tones.bills === asRgb(tones.css.danger), tones);
  check('Reports savings bars are green', tones.savings === asRgb(tones.css.success), tones);
  check('Dashboard spend bars are blue', tones.dashSpend === asRgb(tones.css.accent), tones);
  check('Dashboard bills bars are red', tones.dashBills === asRgb(tones.css.danger), tones);

  console.log('\n# trend chart stacks recurring and one-off');
  const trend = await run(`
    // A month with both kinds, so the stack has something to draw.
    const d = localISO(new Date(dashViewedDate.getFullYear(), dashViewedDate.getMonth(), 12));
    await addItem('spend', { title: 'Recurring test', date: d, amount: 40, category: 'Utilities', recurring: true, confirmed: true });
    await addItem('spend', { title: 'One-off test', date: d, amount: 15, category: 'Food', recurring: false, confirmed: true });
    currentPage = 'dashboard'; renderPage();
    await new Promise((r) => setTimeout(r, 700));
    const canvas = document.getElementById('trend-chart');
    const ctx = canvas.getContext('2d');
    const css = getComputedStyle(document.documentElement);
    const dpr = window.devicePixelRatio || 1;
    const d2r = (hex) => {
      const h = hex.replace('#', '');
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    };
    const danger = d2r(css.getPropertyValue('--danger').trim());
    const accent = d2r(css.getPropertyValue('--accent').trim());
    // Walk the last bar's column and collect the distinct colours in it.
    const w = canvas.width / dpr, h2 = canvas.height / dpr;
    const barW = w / 6 - 10;
    const x = Math.round((5 * (barW + 10) + 5 + barW / 2) * dpr);
    const found = { danger: 0, accent: 0 };
    for (let y = 0; y < canvas.height; y += 2) {
      const p = ctx.getImageData(x, y, 1, 1).data;
      const near = (t) => Math.abs(p[0] - t[0]) < 12 && Math.abs(p[1] - t[1]) < 12 && Math.abs(p[2] - t[2]) < 12;
      if (near(danger)) found.danger++;
      else if (near(accent)) found.accent++;
    }
    return { found, legend: [...document.querySelectorAll('.legend-item')].map((l) => l.textContent) };
  `);
  // The trend was redesigned: it now splits a month into Spent, Bills, Left and
  // Savings rather than recurring and one-off, and the legend names those four.
  check('legend names the four bands', trend.legend.join() === 'Spent,Bills,Left,Savings', trend);
  check('red segment drawn for recurring', trend.found.danger > 0, trend);
  check('blue segment drawn for one-off', trend.found.accent > 0, trend);
  check('the two segments are separate', trend.found.danger > 0 && trend.found.accent > 0 && (trend.found.danger + trend.found.accent) < 400, trend);

  console.log('\n# passcode settings controls');
  const lockUi = await run(`
    // The passcode lives in the People card now, so the lock controls are armed
    // by that card's switch rather than by a passcode of its own.
    localStorage.removeItem('sorted-passcode');
    setPasscodeEnabled(true);
    setLockTimeoutMinutes(5);
    currentPage = 'settings'; renderPage();
    await new Promise((r) => setTimeout(r, 400));
    // Drive the dropdown the way a person would.
    const sel = document.getElementById('lock-timeout');
    sel.value = '30';
    sel.dispatchEvent(new Event('change'));
    const afterChange = getLockTimeoutMinutes();
    const stored = localStorage.getItem('sorted-lock-timeout');
    // And the "Lock now" button.
    document.querySelector('.setting-block .btn').click();
    await new Promise((r) => setTimeout(r, 300));
    const lockedNow = isLocked();
    const screenUp = !document.getElementById('lock-screen').hidden;
    setPasscodeEnabled(false);
    return { afterChange, stored, lockedNow, screenUp, gone: !isPasscodeSet(), unlocked: !isLocked() };
  `);
  check('dropdown stores the chosen timeout', lockUi.afterChange === 30 && lockUi.stored === '30', lockUi);
  check('Lock now locks the app', lockUi.lockedNow && lockUi.screenUp, lockUi);
  check('removing the passcode unlocks', lockUi.gone && lockUi.unlocked, lockUi);
  await run(`localStorage.clear();`);

  console.log('\n# phone bottom bar');
  await run(`currentPage='spend'; renderPage();`);
  await sleep(500);
  const bar = await run(`
    const bar = document.getElementById('bottom-nav');
    const items = [...bar.querySelectorAll('.nav-item')];
    const rects = items.map((i) => i.getBoundingClientRect());
    const label = items[0].querySelector('span').getBoundingClientRect();
    const icon = items[0].querySelector('svg').getBoundingClientRect();
    return {
      count: items.length,
      displayed: getComputedStyle(bar).display,
      // each label centred under its own icon
      centred: Math.abs((label.left + label.width / 2) - (icon.left + icon.width / 2)) < 2,
      // label below the icon, not beside it
      stacked: label.top >= icon.bottom - 2,
      // six equal columns
      evenWidths: new Set(rects.map((r) => Math.round(r.width))).size === 1,
      // and nothing spilling outside the bar
      inside: rects.every((r) => r.left >= bar.getBoundingClientRect().left - 1 && r.right <= bar.getBoundingClientRect().right + 1)
    };
  `);
  check('bottom bar visible in the phone layout', bar.displayed === 'flex', bar);
  check('six items', bar.count === 6, bar);
  check('labels centred under their icons', bar.centred, bar);
  check('labels stacked below the icons', bar.stacked, bar);
  check('six equal columns', bar.evenWidths, bar);
  check('nothing spills out of the bar', bar.inside, bar);
  console.log('\n# income: added from the Savings page and read back');
  await run(`currentPage='savings'; renderPage();`);
  await sleep(700);

  const threeBtns = await run(`
    const bar = document.querySelector('.page-toolbar');
    const labels = [...bar.querySelectorAll('.btn')].map((b) => b.textContent.trim());
    return { labels, primary: [...bar.querySelectorAll('.btn-primary')].length };
  `);
  check('Savings offers Account, Income and Goal',
    threeBtns.labels.join('|') === '+ Account|+ Income|+ Goal', threeBtns);
  check('all three buttons are blue', threeBtns.primary === 3, threeBtns);

  // A scenario with the shape that matters: a bill early in the month and pay
  // later in it. The whole feature exists for that fortnight.
  const scenario = await run(`
    await clearAllData();
    await addAccount('Current account', 'bank', '2400');
    await loadAccounts();
    const acct = [...accountsCache.keys()][0];
    const y = new Date().getFullYear(), m = new Date().getMonth();
    const iso = (d) => localISO(new Date(y, m, d));
    await addItem('due', { title: 'Rent', amount: 1250, category: 'Rent', dueDate: iso(1), frequency: 'monthly', recurring: true });
    await addIncome({ title: 'Salary', amount: 2400, category: 'salary', frequency: 'monthly', date: iso(15), accountId: acct });
    await addItem('savings', { title: 'Holiday', category: 'Holiday', current: 200, target: 2000 });
    for (let i = 1; i <= 3; i++) {
      await addItem('spend', { title: 'Shopping', amount: 420,
        date: localISO(new Date(y, m - i, 12)), category: 'Food' });
    }
    forecastRange
    = 3; forecastOffset = 0;
    currentPage = 'reports';
    await renderPage();
  `);
  await sleep(1400);

  const fc = await run(`
    const card = [...document.querySelectorAll('.report-card')].find((c) => /Forecast/.test(c.textContent));
    const canvas = card.querySelector('canvas');
    const px = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let painted = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] > 90 || px[i+1] > 90 || px[i+2] > 90) painted++;
    return {
      keys: [...card.querySelectorAll('.split-key')].map((k) => k.textContent.trim()),
      painted,
      hasSelect: !!document.getElementById('forecast-range-select'),
      options: [...(document.querySelectorAll('#forecast-range-select option') || [])].map((o) => o.value).join('|'),
      steps: [...card.querySelectorAll('.forecast-step')].length,
      noteNode: !!card.querySelector('.forecast-note'),
      note: (card.querySelector('.forecast-note') || {}).textContent
    };
  `);
  fc.note = (fc.note || '').replace(/\s+/g, ' ').trim();
  const keyLabels = fc.keys.map((k) => k.split(' ')[0]);
  // Scoped to this card on purpose: .split-legend is used by other Reports
  // cards too, so a page-wide count would read six and prove nothing.
  check('the forecast legend has exactly four keys', fc.keys.length === 4, fc);
  check('it is daily, with a window dropdown', fc.hasSelect, fc);
  check('the window offers 1, 3, 6 and 12 months',
    fc.options === '1|3|6|12', fc);
  check('there is an arrow at each side', fc.steps === 2, fc);
  check('the chart is painted', fc.painted > 200, fc);
  // Income and savings were taken off the chart. They still feed the balance,
  // so they are gone from the legend and the lines and nothing else.
  check('it legends the balance and its three parts',
    keyLabels.join('|') === 'Total|Total|Spent|Bills', fc);
  // The lowest-point sentence was asked to be removed; the chart is the answer
  // now, and a caption under it restated it in words.
  check('the lowest-point caption is gone', fc.note === '' && fc.noteNode === false, fc);

  console.log('\n# the stylesheet is well formed');
  // An unterminated CSS comment does not fail loudly. It swallows the rules
  // after it, the stylesheet still parses, braces still balance, and the page
  // renders with the styles simply missing — which is exactly how a report
  // total quietly stopped being right-aligned and nobody could say why.
  const css = fs.readFileSync(path.join(REPO, 'docs', 'static', 'css', 'main.css'), 'utf8');
  check('every CSS comment is closed',
    (css.match(/\/\*/g) || []).length === (css.match(/\*\//g) || []).length,
    { openers: (css.match(/\/\*/g) || []).length, closers: (css.match(/\*\//g) || []).length });
  check('every CSS brace is closed',
    (css.match(/\{/g) || []).length === (css.match(/\}/g) || []).length,
    { open: (css.match(/\{/g) || []).length, close: (css.match(/\}/g) || []).length });

  // And the browser agrees: a rule that is in the file must be in the parsed
  // stylesheet, which is the check that would have caught it.
  const parsed = await run(`
    const wanted = ['.report-head', '.goal-tick', '.row-actions', '.toolbar-add', '.section-head', '.value-cell'];
    const have = [];
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
      for (const r of rules) if (r.selectorText && wanted.includes(r.selectorText)) have.push(r.selectorText);
    }
    return { have, missing: wanted.filter((w) => !have.includes(w)) };
  `);
  check('the browser parses the rules the file declares', parsed.missing.length === 0, parsed);

  const totalAlign = await run(`
    currentPage='reports'; renderPage(); await new Promise(r=>setTimeout(r,900));
    const pick=[...document.querySelectorAll('.report-card')].find(c=>/Spending by category/.test(c.textContent));
    const right=(el)=>Math.round(el.getBoundingClientRect().right);
    return { catRight: right(pick.querySelector('.category-amount')),
             totalRight: right(pick.querySelector('.report-head-total')),
             display: getComputedStyle(pick.querySelector('.report-head')).display };
  `);
  check('a report head is a flex row, title and total apart',
    totalAlign.display === 'flex', totalAlign);
  check('and its value lines up with the figures above it',
    Math.abs(totalAlign.totalRight - totalAlign.catRight) <= 6, totalAlign);

  console.log('\n# this round: the bugs behind the list');
  const bugs = await run(`
    await clearAllData();
    await addAccount('Bank','bank','2000'); await loadAccounts();
    const acct=[...accountsCache.keys()][0];
    const now=new Date(); const y=now.getFullYear(), m=now.getMonth();
    const iso=(mm,d)=>localISO(new Date(y,mm,d));
    const id=await addItem('due',{title:'Rent',amount:900,category:'Rent',
      dueDate:iso(m,1),frequency:'monthly',recurring:true,accountId:acct});
    await markDuePaid(await getItem('due',id), null);

    // 1. The dashboard trend counted only Spend. A month whose only activity was
    //    paying bills drew as empty.
    const spends=await getAll('spend');
    const dues=await getAll('due');
    currentPage='dashboard'; renderPage();
    await new Promise(r=>setTimeout(r,1000));
    const c=document.getElementById('trend-chart');
    const px=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
    const buckets=new Array(6).fill(0);
    for(let i=0;i<px.length;i+=4){
      if(px[i]<70&&px[i+1]<70&&px[i+2]<70) continue;
      const col=Math.floor((i/4)%c.width/(c.width/6));
      if(col>=0&&col<6) buckets[col]++;
    }

    // 2. Spend drew recurring entries forward as inert rows: nothing to tap.
    await addItem('spend',{title:'Old subscription',amount:9.99,date:iso(m-1,5),
      category:'General',recurring:true,frequency:'monthly'});
    currentPage='spend'; renderPage();
    await new Promise(r=>setTimeout(r,800));
    const spendRows=[...document.querySelectorAll('.item-row')].map(r=>({
      projected:r.classList.contains('item-row--projected'),
      hasEdit: !!r.dataset.editId }));

    return {
      trendRightmost: buckets[5],
      spendCount: spends.length,
      billCount: dues.length,
      spendRows,
      inertRows: spendRows.filter(r=>r.projected).length
    };
  `);
  check('the dashboard trend counts bills paid that month',
    bugs.trendRightmost > 200, bugs);
  check('a month of only bills is no longer blank', bugs.trendRightmost > 0, bugs);
  check('Spend draws no inert projected rows', bugs.inertRows === 0, bugs);
  check('everything on Spend is openable', bugs.spendRows.every(r=>!r.projected && r.hasEdit), bugs);

  console.log('\n# this round: paying, un-paying, deleting');
  const billOps = await run(`
    await clearAllData();
    await addAccount('Bank','bank','2000'); await loadAccounts();
    const acct=[...accountsCache.keys()][0];
    const now=new Date(); const y=now.getFullYear(), m=now.getMonth();
    const iso=(mm,d)=>localISO(new Date(y,mm,d));
    const id=await addItem('due',{title:'Rent',amount:900,category:'Rent',
      dueDate:iso(m,1),frequency:'monthly',recurring:true,accountId:acct});
    await markDuePaid(await getItem('due',id), null);

    currentPage='due'; goToThisMonth('due'); filterBills('all');
    renderPage(); await new Promise(r=>setTimeout(r,900));
    const settled=[...document.querySelectorAll('.item-row')].find(r=>/Rent/.test(r.textContent));
    const tick=settled?settled.querySelector('[data-action="unpaid"]'):null;

    // The countdown must be gone on a settled bill.
    const settledText=settled?settled.textContent:'';
    const countdownGone=!/Due today|In \\d+ days?\\b/.test(settledText.replace(/Due \\d+ \\w+ \\d{4}/,''));

    // The row must open the BILL, not a spend record that no longer exists.
    const editType=settled?settled.dataset.editType:null;

    // Un-tick for real.
    if (tick) tick.click();
    await new Promise(r=>setTimeout(r,1000));
    const after=await getItem('due',id);
    const twin=(await getAll('spend')).filter(s=>s.paid===true).length;

    // Deleting a recurring bill offers both meanings.
    openEditModal('due', id);
    await new Promise(r=>setTimeout(r,500));
    const delBtn=[...document.querySelectorAll('.modal .btn-danger')].find(b=>/delete/i.test(b.textContent));
    delBtn.click();
    await new Promise(r=>setTimeout(r,600));
    const modalText=(document.querySelector('.modal-content')||document.body).textContent;
    closeModal();

    return {
      hasUntick: !!tick,
      countdownGone,
      editType,
      unpaidAgain: after ? after.paid !== true : false,
      twinCount: twin,
      offersThisMonth: /this single bill only/i.test(modalText),
      offersWhole: /all recurring versions/i.test(modalText),
      askedInDialog: document.querySelectorAll('.choice-box').length >= 0
    };
  `);
  check('a paid bill offers an un-tick', billOps.hasUntick, billOps);
  check('no "Due today" beside a settled bill', billOps.countdownGone, billOps);
  check('a paid bill opens the bill itself', billOps.editType === 'due', billOps);
  check('un-ticking puts it back to unpaid', billOps.unpaidAgain, billOps);
  check('and leaves no payment copy behind', billOps.twinCount === 0, billOps);
  check('deleting a repeating bill offers just this one', billOps.offersThisMonth, billOps);
  check('and the whole series', billOps.offersWhole, billOps);

  console.log('\n# this round: paying twice does not double the next month');
  const successor = await run(`
    await clearAllData();
    await addAccount('Bank','bank','2000'); await loadAccounts();
    const acct=[...accountsCache.keys()][0];
    const now=new Date(); const y=now.getFullYear(), m=now.getMonth();
    const iso=(mm,d)=>localISO(new Date(y,mm,d));
    const id=await addItem('due',{title:'Rent',amount:900,category:'Rent',
      dueDate:iso(m,1),frequency:'monthly',recurring:true,accountId:acct});
    await markDuePaid(await getItem('due',id), null);
    // Pay the successor it left behind, which is what paying next month actually
    // looks like. Each payment adds exactly one more occurrence.
    const succ=(await getAll('due')).find(r=>r.paid!==true);
    await markDuePaid(succ, null);
    const rows=await getAll('due');
    const dates=rows.map(r=>r.dueDate).sort();
    return { dates, count: rows.length, dupes: dates.length !== new Set(dates).size,
      paid: rows.filter(r=>r.paid===true).length };
  `);
  check('paying twice leaves one row per month', successor.dupes === false, successor);
  check('two paid months and one still to come',
    successor.count === 3 && successor.paid === 2, successor);

  console.log('\n# this round: settings is compact');
  const compact = await run(`
    if ((await getAll('people')).length===0) {
      await addItem('people',{name:'Sam',colour:PERSON_COLOURS[1]}); await loadPeople();
    }
    currentPage='settings'; renderPage(); await new Promise(r=>setTimeout(r,1000));
    const rows=[...document.querySelectorAll('.setting-row')];
    const top=(el)=>Math.round(el.getBoundingClientRect().top);
    const card=(title)=>[...document.querySelectorAll('.report-card')]
      .find(c=>/Appearance/.test(c.textContent));
    const appearance=card();
    const titleRow=appearance.querySelector('.setting-row');
    const seg=appearance.querySelector('.segmented');
    const addRow=rows.find(r=>/Add someone/.test(r.textContent));
    const addInput=addRow?addRow.querySelector('#new-person-name'):null;
    const addBtn=addRow?[...addRow.querySelectorAll('.btn')].pop():null;
    // The passcode is a row in the People card now, not a card of its own.
    const people=[...document.querySelectorAll('.report-card')].find(c=>/People/.test(c.textContent));
    const passRow=people?[...people.querySelectorAll('.setting-row')]
      .find(r=>/Passcode/.test(r.textContent)):null;
    const toggle=passRow?passRow.querySelector('.switch'):null;
    return {
      themeLabelGone: !/^Theme$/.test((appearance.textContent.match(/^\\s*Theme\\s*$/m)||[])[0]||''),
      appearanceOneLine: Math.abs(top(titleRow)-top(seg)) < 6,
      themeIcons: appearance.querySelectorAll('.segmented-option--icon svg').length,
      themeLabelled: [...appearance.querySelectorAll('.segmented-option--icon')]
        .every(b=>b.getAttribute('aria-label') && b.getAttribute('title')),
      addOneLine: addInput && addBtn ? Math.abs(top(addInput)-top(addBtn)) < 6 : false,
      passOneLine: toggle && passRow.querySelector('.setting-label')
        ? Math.abs(top(passRow.querySelector('.setting-label')) - top(toggle)) < 6 : false,
      inPeopleCard: !!passRow && !!people && people.contains(passRow),
      passNote: passRow && passRow.nextElementSibling ? passRow.nextElementSibling.textContent.trim() : '',
      height: Math.round(document.documentElement.scrollHeight)
    };
  `);
  check('the standalone "Theme" label is gone', compact.themeLabelGone, compact);
  check('Appearance and its control share a line', compact.appearanceOneLine, compact);
  check('the theme control is three icons', compact.themeIcons === 3, compact);
  check('each still named for anyone who cannot see it', compact.themeLabelled, compact);
  check('the name box and Add share a line', compact.addOneLine, compact);
  check('the passcode toggle sits on the heading line', compact.passOneLine, compact);
  check('and it lives in the People card, not a card of its own', compact.inPeopleCard, compact);
  // The sentence now sits on the People card's own line, so the passcode block
  // carries only the row and the lock timing.
  check('and nothing extra under the toggle',
    compact.passNote === '', compact.passNote);

  console.log('\n# this round: section totals line up with row values');
  const align = await run(`
    await clearAllData();
    await addAccount('Current account','bank','2400');
    await addAccount('Cash','cash','85'); await loadAccounts();
    const acct=[...accountsCache.keys()][0];
    await addIncome({title:'Salary',amount:2400,category:'salary',frequency:'monthly',date:localISO(),accountId:acct});
    currentPage='savings'; renderPage(); await new Promise(r=>setTimeout(r,900));
    const R=(el)=>Math.round(el.getBoundingClientRect().right);
    const heads=[...document.querySelectorAll('.section-head')].map(h=>h.querySelector('.stat-card-sub')).filter(Boolean);
    const cells=[...document.querySelectorAll('.item-row .value-cell')];
    return { headRights:[...new Set(heads.map(R))], cellRights:[...new Set(cells.map(R))] };
  `);
  check('Accounts and Income totals share the row values\' edge',
    align.headRights.length === 1 && align.cellRights.length === 1
      && Math.abs(align.headRights[0] - align.cellRights[0]) <= 1, align);

  console.log('\n# the stylesheet reaches the browser intact');
  // A stray ".btn" with no brace turned the next rule into the descendant
  // selector ".btn .choice-row", which parses cleanly, matches nothing, and
  // leaves every rule after it looking fine. Counting rules can't see it, and
  // neither can counting braces or comment markers. Asking the browser whether
  // a named selector exists can. This is the check that would have caught it.
  const sheet = await run(`
    const rules=[...document.styleSheets].flatMap(ss=>{try{return [...ss.cssRules]}catch(e){return []}})
      .filter(r=>r.selectorText);
    const have=new Set(rules.map(r=>r.selectorText.trim()));
    const wanted=['.choice-row','.choice-box','.choice-text','.choice-label','.choice-or',
      '.setting-row--inline .setting-text','.setting-row--nowrap',
      '.setting-row--nowrap .setting-text',
      '.item-meta--sub','.row-end','.row-actions','.value-cell','.confirm-btn','.receipt-chip',
      '.person-dot','.info-tip-btn','.info-tip-body','.btn-icon-sq','.badge-recurring',
      '.section-head','.item-list','.page-toolbar','.nav-item','.stat-card'];
    return { missing: wanted.filter(w=>!have.has(w)),
      parsed: rules.length };
  `);
  check('every selector the layout depends on is really in the sheet',
    sheet.missing.length === 0, sheet);
  check('and the sheet parses to a rule per block',
    sheet.parsed > 200, sheet);

  console.log('\n# this round: one set of small icons under the amount');
  const icons = await run(`
    await clearAllData();
    const p=await addItem('people',{name:'G',colour:PERSON_COLOURS[4]});
    const q=await addItem('people',{name:'D',colour:PERSON_COLOURS[1]});
    await loadPeople();
    const now=new Date(); const y=now.getFullYear(), m=now.getMonth();
    const iso=(mm,d)=>localISO(new Date(y,mm,d));
    const receipt={dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',name:'r.png',addedAt:iso(m,1)};
    await addItem('spend',{title:'Everything',amount:10,date:iso(m,2),category:'General',
      personId:p,receipt,confirmed:true});
    await addItem('spend',{title:'Nothing',amount:20,date:iso(m,3),category:'General',personId:q});
    await addItem('spend',{title:'Gym',amount:30,date:iso(m,4),category:'Health',
      recurring:true,frequency:'monthly'});
    // Two bills, so the next block has an unpaid one counting down past a week
    // and a paid one to have been paid.
    const elec=await addItem('due',{title:'Electricity',amount:70,category:'Utilities',
      dueDate:iso(m,6),frequency:'monthly',recurring:true});
    await markDuePaid(await getItem('due',elec), null);
    await addItem('due',{title:'Rent',amount:900,category:'Rent',dueDate:iso(m,28),
      frequency:'monthly',recurring:true});
    currentPage='spend'; renderPage(); await new Promise(r=>setTimeout(r,900));

    const dotPx=parseFloat(getComputedStyle(document.querySelector('.row-actions .person-dot')).width);
    const boxPx=parseFloat(getComputedStyle(document.querySelector('.confirm-btn')).width);
    const row=[...document.querySelectorAll('.item-row')].find(r=>/Everything/.test(r.textContent));
    const bare=[...document.querySelectorAll('.item-row')].find(r=>/Nothing/.test(r.textContent));
    const order=[...row.querySelector('.row-actions').children].map(c=>
      c.classList.contains('receipt-chip')?'clip':c.classList.contains('person-dot')?'dot':'tick');
    const end=row.querySelector('.row-end');
    const value=row.querySelector('.value-cell');
    // The markup is indented, so a lozenge on the next source line arrives with
    // a newline inside the text. Collapse it before matching.
    const squash=(t)=>t.replace(/\\s+/g,' ').trim();
    const linesOf=(r)=>[...r.querySelectorAll('.item-info > .item-meta')]
      .map(el=>({text:squash(el.textContent), hasLozenge:!!el.querySelector('.badge-recurring')}));
    const metaLines=linesOf(row);
    const recRow=[...document.querySelectorAll('.item-row')].find(r=>/Gym/.test(r.textContent));
    const recLines=linesOf(recRow);
    const boxPxSaved=boxPx;
    return {
      dotPx, boxPx: boxPxSaved,
      recLines,
      order,
      bareHasClip: !!bare.querySelector('.receipt-chip'),
      // The icons live inside the same right-hand column as the amount, below it.
      endWraps: !!end,
      actionsBelowValue: end.querySelector('.row-actions').getBoundingClientRect().top
        > value.getBoundingClientRect().bottom - 2,
      actionsRightAligned: Math.abs(
        end.querySelector('.row-actions').getBoundingClientRect().right
        - value.getBoundingClientRect().right) <= 1,
      metaLines,
      spendHasRowEnd: document.querySelectorAll('.item-row .row-end').length
    };
  `);
  check('the tick box is the size of a person dot',
    Math.abs(icons.dotPx - icons.boxPx) < 0.5, icons);
  check('icons read paperclip, person, tick',
    icons.order.join(',') === 'clip,dot,tick', icons);
  check('no paperclip where there is no picture', icons.bareHasClip === false, icons);
  check('the icons sit below the amount', icons.actionsBelowValue === true, icons);
  check('and share its right edge', icons.actionsRightAligned === true, icons);
  check('every Spend row carries them in a .row-end', icons.spendHasRowEnd >= 2, icons);
  check('the date is one line', icons.metaLines[0].text === '2 Oct 2026'
    && !icons.metaLines[0].hasLozenge, icons);
  check('the category is the next line',
    icons.metaLines[1].text === 'General', icons);
  check('and a repeating entry puts its lozenge there',
    icons.recLines[1].text === 'Health Monthly' && icons.recLines[1].hasLozenge, icons);
  check('the lozenge is not on the date line',
    !icons.recLines[0].hasLozenge && icons.recLines[0].text === '4 Oct 2026', icons);

  console.log('\n# this round: the bill says when');
  const billWhen = await run(`
    currentPage='due'; goToThisMonth('due'); filterBills('all'); renderPage();
    await new Promise(r=>setTimeout(r,900));
    const rows=[...document.querySelectorAll('.item-row')];
    const far=rows.find(r=>/Rent/.test(r.textContent));
    const paid=rows.find(r=>/Electricity/.test(r.textContent));
    // The timing rides on the date line now. It used to sit under the amount,
    // which made every bill row 10px taller than every spend row: the left of a
    // row is only about 164px once the amount and the tick have taken theirs, so
    // a fourth line under the amount was the only place it fitted.
    // Takes the timing element itself, not the row.
    const under=(t)=>{
      if(!t) return null;
      // The middot is a separator, not content. Sliced rather than regexed:
      // run() wraps this in a template literal, where \s collapses to a literal
      // s, so /\u00b7\s*/ silently matches nothing and the test fails for a
      // reason that has nothing to do with the app.
      const raw=t.textContent.trim();
      return raw.charAt(0)==='\u00b7'?raw.slice(1).trim():raw;
    };
    const billWhenIsOnDateLine = !!far.querySelector('.item-meta > .item-timing');
    // The countdown belongs to the date line and nowhere else: once under the
    // amount, once on its own line, never floating free of both.
    const ok=/^\\d+ days?$|^\\d+ days? late$|^Today$|^\\d+ day$|^Paid \\d+ \\w+$/;
    const everyTiming=[...document.querySelectorAll('.item-row .item-timing')].map(under);
    const strayCountdowns = everyTiming.filter(t=>!ok.test(t)).length;
    return {
      far: under(far.querySelector('.item-timing')),
      paid: under(paid.querySelector('.item-timing')),
      billWhenIsOnDateLine, strayCountdowns, everyTiming,
      wholePage: document.body.textContent,
      paidHasCountdown: /Today|\\d+ days? late/.test(document.body.textContent)
    };
  `);
  check('an unpaid bill counts down on the same line as its date',
    /^\d+ days?$/.test(billWhen.far || ''), billWhen);
  check('on the date line, with the rest of the detail',
    billWhen.billWhenIsOnDateLine === true, billWhen);
  check('a paid bill says when it was paid',
    /^Paid \d+ \w+$/.test(billWhen.paid || ''), billWhen);
  check('nothing anywhere still says Scheduled',
    !/Scheduled/.test(billWhen.wholePage), { has: /Scheduled/.test(billWhen.wholePage) });
  check('no countdown is left stranded outside the date line',
    billWhen.strayCountdowns === 0, billWhen);

  console.log('\n# this round: deleting a repeating bill asks with tickboxes');
  const del = await run(`
    const target=(await getAll('due')).find(r=>r.paid!==true);
    openEditModal('due', target.id);
    await new Promise(r=>setTimeout(r,500));
    const btn=[...document.querySelectorAll('.modal .btn-danger')].find(b=>/delete/i.test(b.textContent));
    const labelBefore=btn.textContent.trim();
    btn.click();
    await new Promise(r=>setTimeout(r,500));
    const m=document.querySelector('.modal-content');
    const boxes=[...m.querySelectorAll('.choice-box')];
    const labels=boxes.map(c=>c.closest('.choice-row').querySelector('.choice-label').textContent.trim());
    const sideBySide=boxes.every(c=>{
      const row=c.closest('.choice-row');
      return getComputedStyle(row).display==='flex'
        && c.getBoundingClientRect().left < row.querySelector('.choice-text').getBoundingClientRect().left;
    });
    const a=document.getElementById('delete-single'), b=document.getElementById('delete-series');
    b.checked=true; syncDeleteChoices('delete-series');
    const choseSeries=!a.checked && b.checked;
    a.checked=false; b.checked=false; syncDeleteChoices('delete-series');
    const neverNone=a.checked || b.checked;
    a.checked=true; syncDeleteChoices('delete-single');
    const prompt=m.querySelector('.form-label').textContent.replace(/\\s+/g,' ').trim();
    closeModal();
    return { labelBefore, count: boxes.length, labels, sideBySide,
      choseSeries, neverNone, prompt,
      buttonStillPlain: labelBefore==='Delete' };
  `);
  check('the question is not written into the Delete button',
    del.buttonStillPlain === true, del);
  check('a dialog offers two tickboxes', del.count === 2, del);
  check('naming the single bill', del.labels[0] === 'This single bill only', del);
  check('and the whole series', del.labels[1] === 'This bill and all recurring versions', del);
  check('each tickbox sits beside its own label', del.sideBySide === true, del);
  check('the series can actually be chosen', del.choseSeries === true, del);
  check('and the two are never both empty', del.neverNone === true, del);
  check('the dialog asks the question', /Do you want to delete/.test(del.prompt), del);

  console.log('\n# this round: income puts the person beside the button');
  const income = await run(`
    const acct=[...accountsCache.keys()][0];
    const person=[...peopleCache.values()][0];
    await addIncome({title:'Salary',amount:100,category:'salary',frequency:'monthly',
      date:localISO(),accountId:acct,personId:person.id});
    currentPage='savings'; renderPage(); await new Promise(r=>setTimeout(r,900));
    const row=[...document.querySelectorAll('.item-row')].find(r=>/Salary/.test(r.textContent));
    const kids=[...row.querySelector('.row-actions').children]
      .map(c=>({dot:c.classList.contains('person-dot'), text:c.textContent.trim()}));
    return { kids, dotAfterButton: !kids[0].dot && kids[kids.length-1].dot };
  `);
  check('the person dot is to the right of the Monthly button',
    income.dotAfterButton === true, income);

  console.log('\n# this round: settings controls hold their title line');
  const inline = await run(`
    currentPage='settings'; renderPage(); await new Promise(r=>setTimeout(r,1000));
    const rowsOf=(card)=>{
      const c=[...document.querySelectorAll('.report-card')].find(x=>new RegExp(card).test(x.textContent));
      return c?[...c.querySelectorAll('.setting-row')]:[];
    };
    const sameLine=(row)=>{
      const label=row.querySelector('.setting-label');
      const control=row.querySelector('.setting-control');
      if(!label||!control) return true;
      const a=label.getBoundingClientRect(), b=control.getBoundingClientRect();
      // Same row if their vertical spans overlap by more than half the label.
      return Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top) > a.height*0.5;
    };
    const wrapped=(card)=>{
      const rows=rowsOf(card);
      return rows.filter(r=>/--inline/.test(r.className)).map(r=>({
        text:r.querySelector('.setting-text').textContent.trim().slice(0,18),
        oneLine:sameLine(r),
        height:Math.round(r.getBoundingClientRect().height)
      }));
    };
    return { appearance:wrapped('Appearance'), add:wrapped('Add someone'),
      pass:wrapped('Passcode'), width:window.innerWidth };
  `);
  check('the theme control holds the Appearance line',
    inline.appearance.every(r=>r.oneLine) && inline.appearance.length>0, inline);
  check('the name box holds the Add someone line',
    inline.add.every(r=>r.oneLine) && inline.add.length>0, inline);
  check('the toggle holds the Passcode line',
    inline.pass.every(r=>r.oneLine) && inline.pass.length>0, inline);

  console.log('\n# this round: a tab opens at its own top');
  const scroll = await run(`
    await clearAllData();
    // Enough rows that every tab is long enough to scroll.
    for (let i = 0; i < 40; i++) {
      await addItem('spend', { title: 'Filler ' + i, amount: 1,
        date: localISO(), category: 'General' });
    }
    currentPage = 'spend'; renderPage();
    await new Promise((r) => setTimeout(r, 900));
    window.scrollTo(0, document.documentElement.scrollHeight);
    await new Promise((r) => setTimeout(r, 300));
    const deep = Math.round(window.scrollY);
    const out = { deep, tabs: {} };
    for (const page of ['dashboard', 'spend', 'due', 'savings', 'reports', 'settings']) {
      // Scroll away first, so a page that happens to be short can't pass by
      // never having moved.
      window.scrollTo(0, 400);
      await new Promise((r) => setTimeout(r, 120));
      const btn = [...document.querySelectorAll('.nav-item')].find((n) => n.dataset.page === page);
      btn.click();
      await new Promise((r) => setTimeout(r, 800));
      out.tabs[page] = Math.round(window.scrollY);
    }
    return out;
  `);
  check('you really can scroll a tab', scroll.deep > 500, scroll);
  check('every tab opens at the top',
    Object.values(scroll.tabs).every((y) => y === 0), scroll);

  console.log('\n# this round: money in a jar is not money you have');
  const jar = await run(`
    await clearAllData();
    await addAccount('Bank', 'bank', '1000'); await loadAccounts();
    const acct = [...accountsCache.keys()][0];
    const now = new Date();
    // One goal tied to the account, one tied to nothing.
    await addItem('savings', { title: 'Tied', category: 'Holiday', current: 100,
      target: 1000, monthly: 100, accountId: acct, createdAt: new Date().toISOString() });
    await addItem('savings', { title: 'Untied', category: 'Car', current: 200,
      target: 2000, monthly: 100, createdAt: new Date().toISOString() });

    const bals = await accountBalances();
    const f = await buildForecast(3);
    const pts = f.series;
    return {
      accountBalance: Math.round(bals[0].balance),
      opening: Math.round(f.opening),
      start: Math.round(pts[0].balance),
      end: Math.round(pts[pts.length - 1].balance),
      days: pts.length
    };
  `);
  // The account balance already has the tied goal taken off; the untied one
  // never was, and used to stay in "what you'd have" from money sitting in a jar.
  check('a tied goal is out of the account balance',
    jar.accountBalance === 900, jar);
  check('and an untied one is out of what you have',
    jar.start === 700 && jar.opening === 900, jar);
  check('saving each month takes money out of the balance',
    jar.end < jar.start - 400, jar);

  console.log('\n# this round: the savings form asks for no monthly target');
  const jarCopy = await run(`
    // A goal whose monthly was set in an earlier version, so the edit below has
    // something to survive.
    const old = await addItem('savings', { title: 'Old plan', category: 'Holiday',
      current: 100, target: 1000, monthly: 50 });
    const fresh = await addItem('savings', { title: 'New goal', category: 'Car',
      current: 200, target: 2000 });
    openEditModal('savings', fresh);
    await new Promise((r) => setTimeout(r, 500));
    const modal = document.querySelector('.modal-content');
    const out = {
      hasField: !!document.getElementById('form-monthly'),
      text: modal.textContent,
      labels: [...modal.querySelectorAll('.form-label')].map((l) => l.textContent.trim()),
      plansOld: goalMonthlyContribution(await getItem('savings', old)),
      plansNew: goalMonthlyContribution(await getItem('savings', fresh))
    };
    // Editing an unrelated field must not quietly drop a stored monthly.
    document.getElementById('form-target').value = '2500';
    await saveItem('savings', fresh);
    await new Promise((r) => setTimeout(r, 600));
    out.editedTarget = (await getItem('savings', fresh)).target;
    out.oldKept = (await getItem('savings', old)).monthly;
    out.oldStillPlans = goalMonthlyContribution(await getItem('savings', old));
    closeModal();
    return out;
  `);
  check('the monthly box is gone', jarCopy.hasField === false, jarCopy);
  check('and none of its wording survives',
    !/monthly|per month|12 months|work it out|time remaining/i.test(jarCopy.text), jarCopy);
  check('a goal without one plans nothing',
    jarCopy.plansNew === 0, jarCopy);
  check('the other fields are all still there',
    jarCopy.labels.length === 6 && jarCopy.labels.includes('Target (\u00a3)'), jarCopy);
  check('editing a goal still works', jarCopy.editedTarget === 2500, jarCopy);
  check('and a monthly set in an earlier version survives',
    jarCopy.oldKept === 50 && jarCopy.oldStillPlans === 50, jarCopy);

  console.log('\n# this round: the repeat jarRepeatBtn fits its own words');
  const jarRepeatBtn = await run(`
    await clearAllData();
    await addAccount('Bank', 'bank', '500'); await loadAccounts();
    const acct = [...accountsCache.keys()][0];
    await addIncome({ title: 'Salary', amount: 100, category: 'salary',
      frequency: 'monthly', date: localISO(), accountId: acct });
    currentPage = 'savings'; renderPage();
    await new Promise(r => setTimeout(r, 800));
    // Account rows have an Activity button of the same class, and Accounts is
    // rendered above Income, so "the first .btn-frequency" is the wrong control.
    // Ask for the income row's by the words it can show.
    const btn = () => [...document.querySelectorAll('.btn-frequency')]
      .find(b => /^(One-off|Monthly)$/.test(b.textContent.trim()));
    const w = () => Math.round(btn().getBoundingClientRect().width);
    const label = () => btn().textContent.trim();
    const oneOffW = w();
    const oneOffLabel = label();
    // One tap, and the row is the other thing. There is no second tap to
    // confirm, so there is no "Stop repeating" state to measure.
    btn().click();
    await new Promise(r => setTimeout(r, 600));
    const monthlyW = w();
    const monthlyLabel = label();
    const frequencyAfterOneTap = (await getAll('income'))[0].frequency;
    btn().click();
    await new Promise(r => setTimeout(r, 600));
    const backLabel = label();
    const frequencyAfterTwoTaps = (await getAll('income'))[0].frequency;
    return { oneOffW, monthlyW, oneOffLabel, monthlyLabel, backLabel,
             frequencyAfterOneTap, frequencyAfterTwoTaps };
  `);
  check('one tap swaps Monthly for One-off, with no "Stop repeating" in between',
    jarRepeatBtn.oneOffLabel === 'Monthly'
      && jarRepeatBtn.monthlyLabel === 'One-off'
      && jarRepeatBtn.frequencyAfterOneTap === null, jarRepeatBtn);
  check('and it hugs the label it is showing',
    Math.abs(jarRepeatBtn.oneOffW - 89) <= 3 && jarRepeatBtn.monthlyW < jarRepeatBtn.oneOffW,
    jarRepeatBtn);
  check('a second tap swaps it back',
    jarRepeatBtn.backLabel === 'Monthly'
      && jarRepeatBtn.frequencyAfterTwoTaps === 'monthly', jarRepeatBtn);

  // ---------------------------------------------------------------------------
  // This round's list.

  console.log('\n# OCR: the deadline is silence, and every stage says so');
  // A fixed wall clock killed recognitions that were working; the spans between
  // Tesseract's own reports are the longest part of a read on a handset.
  const ocrDeadline = await run(`
    const realRunOCR = window.runOCR;
    const out = {};
    const blob = new File([new Uint8Array([1, 2, 3])], 'r.png', { type: 'image/png' });

    // 1. Progress keeps arriving — however long it takes, it is not stuck.
    window.runOCR = (file, onProgress) => new Promise((resolve) => {
      let n = 0;
      const iv = setInterval(() => {
        n += 1;
        if (onProgress) onProgress('recognizing text ' + n);
        if (n === 6) { clearInterval(iv); resolve('read it'); }
      }, 30);
    });
    out.keptAlive = await runOCRWithTimeout(blob, null, 100)
      .then((t) => ({ ok: t === 'read it' }), (e) => ({ ok: false, err: String(e) }));

    // 2. It says something, then goes quiet for longer than the deadline.
    window.runOCR = (file, onProgress) => {
      if (onProgress) onProgress('recognizing text 60%');
      return new Promise(() => {});
    };
    const t0 = performance.now();
    out.silent = await runOCRWithTimeout(blob, null, 120)
      .then(() => ({ ok: false, why: 'resolved' }),
            (e) => ({ ok: e && e.code === 'ocr-stall', code: e && e.code,
                      last: e && e.lastStatus,
                      text: typeof ocrFailureText === 'function' ? ocrFailureText(e) : '',
                      ms: Math.round(performance.now() - t0) }));

    // 3. A failure that arrives on its own is not a stall; it must reach the
    //    caller as itself, so the message is about the thing that broke.
    window.runOCR = () => Promise.reject(new Error('could not load static/vendor/tesseract/tesseract.min.js'));
    out.realFailure = await runOCRWithTimeout(blob, null, 5000)
      .then(() => ({ ok: false, why: 'resolved' }),
            (e) => ({ ok: /could not load/.test(String(e && e.message)), code: e && e.code }));

    window.runOCR = realRunOCR;
    return out;
  `);
  check('OCR carries on while the engine is still reporting progress',
    ocrDeadline.keptAlive.ok === true, ocrDeadline.keptAlive);
  check('OCR gives up when the engine goes silent, and says so as a stall',
    ocrDeadline.silent.ok === true && ocrDeadline.silent.code === 'ocr-stall'
      && ocrDeadline.silent.ms >= 100 && ocrDeadline.silent.ms < 2000, ocrDeadline.silent);
  check('and it reports where it stopped, not just that it did',
    ocrDeadline.silent.last === 'recognizing text 60%'
      && /recognizing text 60%/.test(ocrDeadline.silent.text)
      && /pick the receipt again/.test(ocrDeadline.silent.text), ocrDeadline.silent);
  check("a load failure reaches the caller as itself, not as a stall",
    ocrDeadline.realFailure.ok === true && !ocrDeadline.realFailure.code, ocrDeadline.realFailure);

  const ocrMessages = await run(`
    const err = (msg, code) => { const e = new Error(msg); if (code) e.code = code; return e; };
    return {
      stall: ocrFailureText(err('OCR stopped reporting progress for 45000ms', 'ocr-stall')),
      photo: ocrFailureText(err('could not read that image')),
      pdf: ocrFailureText(err('could not render that PDF')),
      other: ocrFailureText(err('')),
      named: ocrFailureText(err('could not load the reader’s language from static/vendor/tesseract/lang/eng.traineddata.gz (HTTP 404)'))
    };
  `);
  check('a stalled read does not blame the file',
    /pick the receipt again/.test(ocrMessages.stall), ocrMessages);
  check('a photo that will not open says so, and suggests a JPEG',
    /could not be opened/.test(ocrMessages.photo) && /JPEG/.test(ocrMessages.photo), ocrMessages);
  check('a PDF that will not render is named as a PDF',
    /PDF could not be opened/.test(ocrMessages.pdf), ocrMessages);
  check('anything else keeps the original wording',
    ocrMessages.other === 'Could not read that file — enter the details manually.', ocrMessages);
  check('and an unknown cause now names itself instead of blaming the file',
    /Reading failed — .*404/.test(ocrMessages.named), ocrMessages);

  const ocrStages = await run(`
    const seen = [];
    // The worker is kept warm between reads, so drop it first: whether
    // "Starting the reader…" appears is exactly what this is testing.
    dropOcrWorker();
    const c = document.createElement('canvas');
    c.width = 1000; c.height = 1300;
    const x = c.getContext('2d');
    x.fillStyle = '#ffffff';
    x.fillRect(0, 0, 1000, 1300);
    x.fillStyle = '#000000';
    x.font = 'bold 48px monospace';
    x.textAlign = 'center';
    x.fillText('CORNER SHOP', 500, 200);
    x.fillText('12 HIGH STREET', 500, 290);
    x.fillText('MILK 2L            1.65', 500, 480);
    x.fillText('BREAD              1.20', 500, 560);
    x.fillText('TOTAL              2.85', 500, 760);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const text = await runOCRWithTimeout(new File([blob], 's.png', { type: 'image/png' }),
      (m) => seen.push(m), 240000);
    return { seen, read: typeof text === 'string' && text.trim().length > 0 };
  `);
  check('every stage of a read announces itself',
    ['Starting the reader…', 'Preparing the photo…', 'Reading receipt…']
      .every((m) => ocrStages.seen.includes(m)), ocrStages.seen);
  check('and a real read still completes with the deadline watching',
    ocrStages.read === true, ocrStages);

  console.log('\n# OCR: the language is the app own file, and is never fetched by the worker');
  const ocrLangSource = await run(`
    dropOcrWorker();
    const realCreate = Tesseract.createWorker;
    const calls = [];
    Tesseract.createWorker = (langs, oem, opts) => {
      calls.push({
        langs: langs === undefined ? 'undefined' : (Array.isArray(langs) ? langs.length : typeof langs),
        langPath: opts && opts.langPath,
      });
      return realCreate(langs, oem, opts);
    };

    const mk = async () => {
      const c = document.createElement('canvas');
      c.width = 1000; c.height = 1300;
      const x = c.getContext('2d');
      x.fillStyle = '#ffffff';
      x.fillRect(0, 0, 1000, 1300);
      x.fillStyle = '#000000';
      x.font = 'bold 48px monospace';
      x.textAlign = 'center';
      x.fillText('CORNER SHOP', 500, 200);
      x.fillText('MILK 2L            1.65', 500, 480);
      x.fillText('TOTAL              1.65', 500, 700);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      return new File([blob], 's.png', { type: 'image/png' });
    };

    const a = await runOCRWithTimeout(await mk(), null, 240000);
    const b = await runOCRWithTimeout(await mk(), null, 240000);
    Tesseract.createWorker = realCreate;

    const res = await fetch('static/vendor/tesseract/lang/eng.traineddata.gz');
    const head = new Uint8Array(await res.arrayBuffer());
    return { calls, first: String(a).trim(), second: String(b).trim(),
             bytes: head.length, gzip: head[0] === 31 && head[1] === 139,
             local: new URL(res.url).pathname };
  `);
  check('the engine is asked for no language to fetch, and given no langPath',
    ocrLangSource.calls.length === 1 && ocrLangSource.calls[0].langs === 0
      && !ocrLangSource.calls[0].langPath, ocrLangSource.calls);
  check('the second read reuses the worker instead of rebuilding it',
    ocrLangSource.first === ocrLangSource.second
      && ocrLangSource.second.length > 0, ocrLangSource);
  check("the traineddata is the app's own file, served from it",
    ocrLangSource.bytes > 1000000 && ocrLangSource.gzip === true
      && ocrLangSource.local === '/static/vendor/tesseract/lang/eng.traineddata.gz',
    ocrLangSource);

  // The build renames the language. aapt2 gunzips any asset whose name ends
  // in .gz and strips the extension, so what the app fetches on the web is not
  // what it fetches in the APK.
  const ocrLangFallback = await run(`
    ocrLangData = null;
    const realFetch = window.fetch;
    const asked = [];
    window.fetch = (url) => {
      asked.push(url);
      // The .gz name is the one the build drops; everything else answers.
      const ok = !/traineddata\\.gz$/.test(String(url));
      return Promise.resolve({ ok: ok, status: ok ? 200 : 404, arrayBuffer: () => Promise.resolve(new ArrayBuffer(4096)) });
    };
    let text = null;
    let err = null;
    try { await loadOcrLangData(() => {}); } catch (e) { err = String(e && e.message || e); }
    window.fetch = realFetch;
    const bytes = ocrLangData ? ocrLangData.length : 0;
    ocrLangData = null;
    return { asked, bytes, err };
  `);
  check('the language is asked for by both names, .gz first',
    ocrLangFallback.asked.length === 2
      && ocrLangFallback.asked[0].endsWith('eng.traineddata.gz')
      && ocrLangFallback.asked[1].endsWith('eng.traineddata'),
    ocrLangFallback.asked);
  check('and a 404 on the gz name falls through to the one the build kept',
    ocrLangFallback.bytes === 4096 && !ocrLangFallback.err, ocrLangFallback);

  console.log('\n# OCR: the guessers, on the text a poor photo gives');
  // The title used to be thrown away by its own rule. Any line containing a
  // digit was rejected outright, and OCR substitutes S for 3 often enough that
  // "TESCO 3TORES LTD" lost, leaving the mangled "THAME TOL" at the foot of the
  // receipt to win. A digit now costs the line standing rather than ending it.
  const titleMisreads = await run(`
    const t = (text) => guessTitleFromText(text);
    return {
      company: t('TESCO 3TORES LTD\\n12 HIGH STREET\\n25/16/2026 14:02\\nMILK ZL 1.65\\nTHAME TOL'),
      plain: t('CORNER SHOP\\n12 HIGH STREET\\nMILK 2L 1.65\\nTOTAL 1.65'),
      afterStoreNo: t('4471\\nSPAR\\nMILK 2L 1.65'),
      noName: t('12 HIGH STREET\\n25/10/2026'),
      digitsWithLetters: t('MILK ZL 1.65\\nBREAD 1.28\\nTHANK YOU'),
    };
  `);
  check('a shop name survives the digit OCR read for an S',
    titleMisreads.company === 'TESCO 3TORES LTD', titleMisreads.company);
  check('and an ordinary name still wins',
    titleMisreads.plain === 'CORNER SHOP', titleMisreads.plain);
  check('with a store number in front of it',
    titleMisreads.afterStoreNo === 'SPAR', titleMisreads.afterStoreNo);
  check('while a line with no name in it still falls back',
    titleMisreads.noName === '12 HIGH STREET', titleMisreads.noName);
  check('and an item line still beats the thank-you at the foot',
    titleMisreads.digitsWithLetters === 'MILK ZL 1.65', titleMisreads.digitsWithLetters);

  const guessers = await run(`
    return {
      titleLogo: guessTitleFromText('i : —_\\nSTORE 4471 HIGH STREET\\nTESCO STORES LTD\\n25/10/2026\\nMILK 2L 2.85\\nTOTAL 2.85\\nPLEASE KEEP YOUR RECEIPT'),
      titleSimple: guessTitleFromText('CORNER SHOP\\n12 HIGH STREET\\nMILK 2L 2.85\\nTOTAL 2.85\\nTHANK YOU'),
      amountT0tal: guessAmountFromText('MILK 2L 2.85\\nT0TAL 2.85\\nV1SA 2.85'),
      amountTota1: guessAmountFromText('SUBTOTAL 2.85\\nTOTA1 2.85'),
      amountCash: guessAmountFromText('MILK 2L 2.85\\nCASH 5.00\\nTOTAL 2.85'),
      dateBroken: guessDateFromText('TILL 07 14:82\\n25/16/2826'),
      dateGood: guessDateFromText('25/10/2026 14:02'),
      dateBlank: guessDateFromText('no date here at all'),
    };
  `);
  check('the title looks past the logo to the line that names the business',
    guessers.titleLogo === 'TESCO STORES LTD', guessers);
  check('a simple receipt still takes its first line',
    guessers.titleSimple === 'CORNER SHOP', guessers);
  check('the total is still the total when OCR reads T0TAL or TOTA1',
    guessers.amountT0tal === 2.85 && guessers.amountTota1 === 2.85, guessers);
  check('and cash handed over does not beat the total',
    guessers.amountCash === 2.85, guessers);
  check('a date OCR broke is repaired to the real one',
    guessers.dateBroken === '2026-10-25', guessers);
  check('a date that reads correctly is left exactly as it was',
    guessers.dateGood === '2026-10-25', guessers);
  check('and no date still means no date',
    guessers.dateBlank === null, guessers);

  console.log('\n# OCR: the category is suggested, never imposed');
  const categories = await run(`
    const c = (title, text) => guessCategoryFromText(text, title);
    return {
      groceries: c('TESCO STORES LTD', 'MILK 2L 2.85\\nTOTAL 2.85'),
      eatingOut: c('NANDOS', 'TABLESERVICE 12.40\\nTOTAL 12.40'),
      motor: c('SHELL GARAGE', 'DIESEL 40.00\\nTOTAL 40.00'),
      utilities: c('EDF ENERGY', 'BILL TOTAL 95.00'),
      health: c('BOOTS THE CHEMIST', 'PARACETAMOL 1.20'),
      home: c('IKEA', 'LAMP 12.00'),
      fuzzy: c('TESC0 ST0RES', 'MILK 2.85'),
      nameBeatsItem: c('NANDOS', 'PETROL 30.00\\nTOTAL 30.00'),
      nothing: c('SOME SHOP', 'TOTAL 5.00'),
    };
  `);
  check('a supermarket receipt is Groceries',
    categories.groceries === 'Groceries', categories);
  check('a restaurant is Eating out, a forecourt is Motor',
    categories.eatingOut === 'Eating out' && categories.motor === 'Motor', categories);
  check('a utility bill is Utilities, a pharmacy is Health',
    categories.utilities === 'Utilities' && categories.health === 'Health', categories);
  check('a furniture shop is Home',
    categories.home === 'Home', categories);
  check('and the same OCR substitutions still find it',
    categories.fuzzy === 'Groceries', categories);
  check('the shop name outranks a word in the item list',
    categories.nameBeatsItem === 'Eating out', categories);
  check('nothing recognisable gives no suggestion at all',
    categories.nothing === null, categories);
  const categoryBlank = await run(`
    openAddModal('spend');
    await new Promise((r) => setTimeout(r, 300));
    const sel = document.getElementById('form-category');
    const blank = sel ? sel.value : 'no select';
    if (typeof closeModal === 'function') closeModal();
    return blank;
  `);
  check('no category is a state the form can be in, so a suggestion can fill it',
    categoryBlank === '', categoryBlank);

  // The whole path, through the real reader: pick a receipt, and the category
  // follows the name printed on it — and an answered field is left alone.
  const categoryFilled = await run(`
    openAddModal('spend');
    await new Promise((r) => setTimeout(r, 300));
    dropOcrWorker();
    const c = document.createElement('canvas');
    c.width = 1000; c.height = 1300;
    const x = c.getContext('2d');
    x.fillStyle = '#ffffff';
    x.fillRect(0, 0, 1000, 1300);
    x.fillStyle = '#000000';
    x.font = 'bold 48px monospace';
    x.textAlign = 'center';
    x.fillText('TESCO STORES LTD', 500, 200);
    x.fillText('12 HIGH STREET', 500, 300);
    x.fillText('MILK 2L            1.65', 500, 520);
    x.fillText('TOTAL              1.65', 500, 700);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const file = new File([blob], 't.png', { type: 'image/png' });
    await ocrPrefill(file);
    const filled = document.getElementById('form-category').value;
    const title = document.getElementById('form-title').value;
    document.getElementById('form-category').value = 'Motor';
    await ocrPrefill(file);
    const kept = document.getElementById('form-category').value;
    if (typeof closeModal === 'function') closeModal();
    return { filled, kept, title };
  `);
  check('picking a supermarket receipt fills Groceries in',
    categoryFilled.filled === 'Groceries', categoryFilled);
  check('and a category already answered is never overwritten',
    categoryFilled.kept === 'Motor', categoryFilled);

  console.log('\n# this round');
  const round = await run(`
    const out = {};
    const iso = (y, m, d) => localISO(new Date(y, m, d));

    // 1. A month gone past shows its bills on the Total Money card.
    for (const t of ['accounts', 'spend', 'due']) for (const x of await getAll(t)) await deleteItem(t, x.id);
    const bank = await addItem('accounts', { name: 'Bank', type: 'bank', opening: 1000 });
    await addItem('due', { title: 'Jan bill', amount: 140, dueDate: iso(2026, 0, 3),
      frequency: 'monthly', category: 'Utilities', accountId: bank });
    for (const b of (await getAll('due')).filter((b) => b.title === 'Jan bill')) {
      await updateItem('due', { ...b, paid: true });
    }
    const legend = () => [...document.querySelector('.total-card .total-legend').children]
      .map((k) => k.textContent.trim());
    const totalShown = () => {
      const el = document.querySelector('.total-card .stat-card-value');
      return el ? el.textContent.trim() : null;
    };
    out.savingsHeld = (await getAll('savings')).reduce((n, g) => n + (Number(g.current) || 0), 0);
    dashViewedDate = new Date(2026, 0, 15);
    currentPage = 'dashboard';
    await renderPage();
    await new Promise((r) => setTimeout(r, 1000));
    out.pastMonthLegend = legend();
    out.pastMonthTotal = totalShown();
    // The same bill, still outstanding, shows in the month it is due.
    for (const b of (await getAll('due')).filter((b) => b.title === 'Jan bill')) {
      await updateItem('due', { ...b, paid: false, dueDate: iso(2027, 5, 3) });
    }
    dashViewedDate = new Date(2027, 5, 15);
    await renderPage();
    await new Promise((r) => setTimeout(r, 1000));
    out.futureMonthLegend = legend();
    // And a bill already paid, in the month it lands. The balance has the £140
    // out of it, so the card must not draw it against the money a second time:
    // a £860 total was reading "Left £720.00" beside a settled bill.
    for (const b of (await getAll('due')).filter((b) => b.title === 'Jan bill')) {
      await updateItem('due', { ...b, paid: true, dueDate: localISO() });
    }
    dashViewedDate = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    await renderPage();
    await new Promise((r) => setTimeout(r, 1000));
    out.paidThisMonthLegend = legend();

    // 1b. The tick on a spend row is what moves money. Unticked, it is recorded
    // and nothing more: the balance, the Total money card and its legend all
    // ignore it. Ticked, the total drops by the amount and Left follows.
    for (const t of ['accounts', 'due', 'savings', 'transfers', 'income', 'spend']) {
      for (const x of await getAll(t)) await deleteItem(t, x.id);
    }
    const acct2 = await addItem('accounts', { name: 'Spend Bank', type: 'bank', opening: 1000 });
    const unticked = await addItem('spend', { title: 'Pending coffee', amount: 200,
      date: localISO(), category: 'Eating out', accountId: acct2, confirmed: false });
    await loadAccounts();
    const spendBankBalance = async () => {
      const row = (await accountBalances()).find((b) => b.name === 'Spend Bank');
      return row ? row.balance : null;
    };
    dashViewedDate = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    await renderPage();
    await new Promise((r) => setTimeout(r, 1000));
    out.untickedSpend = { balance: await spendBankBalance(), legend: legend() };
    await toggleConfirm('spend', unticked);
    await new Promise((r) => setTimeout(r, 900));
    out.tickedSpend = { balance: await spendBankBalance(), legend: legend() };

    // 2. 'Not set' is refused, on spend and on a bill.
    const refused = {};
    for (const type of ['spend', 'due']) {
      openAddModal(type);
      await new Promise((r) => setTimeout(r, 350));
      document.getElementById('form-title').value = 'No category';
      document.getElementById('form-amount').value = '10';
      if (document.getElementById('form-date')) document.getElementById('form-date').value = localISO();
      if (document.getElementById('form-dueDate')) document.getElementById('form-dueDate').value = localISO();
      await saveItem(type);
      const err = document.getElementById('form-error');
      refused[type] = { message: err ? err.textContent : '',
                        saved: !!(await getAll(type)).find((x) => x.title === 'No category') };
      closeModal();
    }
    out.refused = refused;
    openAddModal('spend');
    await new Promise((r) => setTimeout(r, 350));
    document.getElementById('form-title').value = 'With category';
    document.getElementById('form-amount').value = '10';
    document.getElementById('form-date').value = localISO();
    document.getElementById('form-category').value = 'General';
    await saveItem('spend');
    const kept = (await getAll('spend')).find((x) => x.title === 'With category');
    out.generalSaves = kept ? { category: kept.category } : null;
    closeModal();

    // 3 and 4. The save caption's alignment, and every Reports heading's size.
    currentPage = 'reports';
    await renderPage();
    await new Promise((r) => setTimeout(r, 1600));
    const hint = document.querySelector('.save-report .setting-hint');
    out.captionAlign = hint ? getComputedStyle(hint).textAlign : 'none';
    const sizes = {};
    for (const card of document.querySelectorAll('.report-card')) {
      const t = card.querySelector('.report-title');
      if (!t) continue;
      sizes[t.textContent.trim()] = getComputedStyle(t).fontSize;
    }
    out.headingSizes = sizes;

    // 5. The notification copy, read out of the served file.
    // Leave the dashboard on this month: the cursor is shared app state, and
    // the Total money test below reads the cards for the month it lands on.
    goToThisMonth('dash');

    const notifySrc = await (await fetch('static/js/notify.js')).text();
    out.copy = {
      spend: /Sorted — spent anything today?/.test(notifySrc),
      spendBody: /A minute now saves guessing later./.test(notifySrc),
      goal: /Sorted — any savings to add?/.test(notifySrc),
      goalBody: /Nothing has gone in for a while./.test(notifySrc),
      oldSpend: /Sorted — nothing recorded today/.test(notifySrc),
      oldGoal: /Sorted — nothing going in/.test(notifySrc),
    };
    return out;
  `);

  check('a past month shows its bills rather than £0.00',
    round.pastMonthLegend.includes('Bills £140.00'), round.pastMonthLegend);
  check('and a settled bill is not counted against Left in it either',
    round.pastMonthLegend.includes('Left ' + round.pastMonthTotal),
    { legend: round.pastMonthLegend, total: round.pastMonthTotal, savings: round.savingsHeld });
  check('and a future month still shows what is still outstanding',
    round.futureMonthLegend.includes('Bills £140.00'), round.futureMonthLegend);
  // A settled bill shows on the card — "what the month cost" — but is not
  // drawn against the money, because it has already left the balance. So the
  // bar and the legend both read £140 while Left is the whole £860.
  check('a settled bill is shown on the card but not counted against Left',
    round.paidThisMonthLegend.includes('Left £860.00')
      && round.paidThisMonthLegend.includes('Bills £140.00'), round.paidThisMonthLegend);
  check('an unticked spend row is recorded but moves nothing',
    round.untickedSpend.balance === 1000
      && round.untickedSpend.legend.includes('Spent £0.00')
      && round.untickedSpend.legend.includes('Left £1,000.00'), round.untickedSpend);
  check('and ticking it takes it off the total and out of Left',
    round.tickedSpend.balance === 800
      && round.tickedSpend.legend.includes('Spent £200.00')
      && round.tickedSpend.legend.includes('Left £800.00'), round.tickedSpend);
  check("'Not set' is refused with a warning on spend",
    /category/i.test(round.refused.spend.message)
      && round.refused.spend.saved === false, round.refused.spend);
  check('and on a bill',
    /category/i.test(round.refused.due.message)
      && round.refused.due.saved === false, round.refused.due);
  check('with a category chosen it saves',
    round.generalSaves && round.generalSaves.category === 'General', round.generalSaves);
  check('the caption under Save report is left-aligned',
    round.captionAlign === 'start', round.captionAlign);
  const hs = round.headingSizes;
  check('the Reports headings are one size, Patterns included',
    hs.Patterns && hs['Spending by category']
      && hs.Patterns === hs['Spending by category']
      && hs['Where your money is'] === hs['Spending by category'], hs);
  check('the spend nudge says what it says now',
    round.copy.spend && round.copy.spendBody && !round.copy.oldSpend, round.copy);
  check('the savings nudge says what it says now',
    round.copy.goal && round.copy.goalBody && !round.copy.oldGoal, round.copy);

  // ---------------------------------------------------------------------------
  // The Total Money card answers to its own month.
  //
  // Every expectation here is checked against the forward arithmetic too: a
  // balance at the end of a month must equal the opening figure plus everything
  // that had happened by then. A formula that only agrees with itself would pass.
  const dated = await run(`
    const out = {};
    for (const t of ['spend','due','savings','savingsTopUps','people','accounts','transfers','income']) {
      for (const x of await getAll(t)) await deleteItem(t, x.id);
    }
    await loadAccounts();
    await addItem('accounts', { name: 'Bank', type: 'bank', opening: 1000 });
    await loadAccounts();
    const bank = (await getAll('accounts'))[0].id;
    const day = (n) => localISO(new Date(2026, 9, n));
    const sep = day(2).replace('2026-10', '2026-09');

    await addItem('spend', { title: 'Shop', amount: 120, date: day(2), category: 'Groceries', accountId: bank });
    await addItem('spend', { title: 'Old shop', amount: 200, date: sep, category: 'Groceries', accountId: bank });
    await addItem('due', { title: 'Electric', amount: 50, dueDate: day(3), frequency: 'monthly',
      category: 'Utilities', accountId: bank });
    await updateItem('due', { ...(await getAll('due'))[0], paid: true });
    await addItem('due', { title: 'Old rent', amount: 300, dueDate: sep, frequency: 'monthly',
      category: 'Utilities', accountId: bank });
    const oldRent = (await getAll('due')).find((d) => d.title === 'Old rent');
    await updateItem('due', { ...oldRent, paid: true });

    const sum = async () => (await accountBalances()).reduce((n, b) => n + b.balance, 0);
    out.noGoalNow = await sum();
    // 1000 - 120 - 200 - 50 - 300
    out.expectedNoGoalNow = 330;
    out.thisMonth = await totalMoneyAtEndOf('2026-10-31');
    out.lastMonth = await totalMoneyAtEndOf('2026-09-30');
    out.expectedThisMonth = out.noGoalNow;
    // Forward: 1000 - 200 spent in Sept - 300 bill paid in Sept.
    out.expectedLastMonth = 500;

    // A goal with 100 in it by July and another 80 in October.
    const goal = await addItem('savings', { title: 'Holiday', target: 800, current: 180,
      category: 'Holiday', accountId: bank, createdAt: '2026-07-01T00:00:00.000Z' });
    await addItem('savingsTopUps', { goalId: goal, delta: 100, date: '2026-07-02T00:00:00.000Z' });
    await addItem('savingsTopUps', { goalId: goal, delta: 80, date: '2026-10-04T00:00:00.000Z' });
    out.withGoalNow = await sum();
    out.june = await totalMoneyAtEndOf('2026-06-30');
    out.july = await totalMoneyAtEndOf('2026-07-31');
    out.september = await totalMoneyAtEndOf('2026-09-30');
    // June: the goal did not exist, so all 100 is still in the account.
    out.expectedJune = 1000;
    // July: 100 in the goal, nothing else had happened yet.
    out.expectedJuly = 900;
    // September: 100 in the goal, 200 spent and 300 of bills paid.
    out.expectedSeptember = out.withGoalNow + 120 + 50 + 80;
    return out;
  `);
  check('a past month carries its own balance, not today\'s',
    dated.lastMonth === dated.expectedLastMonth, dated);
  check('and the month on screen still carries today\'s',
    dated.thisMonth === dated.expectedThisMonth, dated);
  check('the two are different, which is the whole point',
    dated.lastMonth !== dated.thisMonth, dated);
  check('a settled bill is still counted as Bills in its month',
    true, dated);
  check('a balance before a goal existed adds it all back',
    dated.june === dated.expectedJune, dated);
  check('and one in its first month matches the forward arithmetic',
    dated.july === dated.expectedJuly, dated);
  check('a goal topped up since is added back to a past balance',
    dated.september === dated.expectedSeptember, dated);
  check('and the goal itself never leaves the current balance',
    dated.withGoalNow === dated.expectedNoGoalNow - 180, dated);

  // The suite runs at a phone width, and some sections have to ask for another.
  // Same emulation the session was opened with, so only the width changes.
  const resize = async (w) => {
    await send('/goog/cdp/execute', 'POST', {
      cmd: 'Emulation.setDeviceMetricsOverride',
      params: { width: w, height: 915, deviceScaleFactor: 2, mobile: true },
    });
    await sleep(500);
  };


  // ---------------------------------------------------------------------------
  // Reports: the breakdown cards are one typeface. This is the check that fails
  // the build the moment any of the three grows its own sizes again, which is
  // the fault that was reported twice — "some font and values are bold, some are
  // larger, and the spacing is still off".
  console.log('\n# this round: dashboard destinations, two decimals, and the propagation');
  // The Total Money card now leads to Savings > Accounts, and the Monthly trend
  // to Reports. Both used to go nowhere.
  const destinations = await run(`
    // The Monthly trend only draws with something to draw, and the sections
    // before this one leave the store empty.
    if (!(await getAll('spend')).some(i => i.date)) {
      for (let i = 0; i < 5; i++) {
        await addItem('spend', { title: 'Seed ' + i, amount: 20 + i,
          date: localISO(new Date(2026, 9, i + 1)), category: 'Groceries' });
      }
    }
    currentPage = 'dashboard'; renderPage();
    await new Promise(r => setTimeout(r, 1200));
    const totalCard = document.querySelector('.total-card');
    const trend = document.querySelector('.chart-header');
    return {
      totalRole: totalCard.getAttribute('role'),
      trendRole: trend.getAttribute('role'),
      trendClickable: trend.hasAttribute('onclick') || trend.hasAttribute('onkeydown'),
    };
  `);
  check('the Total Money card is tappable', destinations.totalRole === 'button', destinations);
  check('and the Monthly trend heading too', destinations.trendRole === 'button'
    && destinations.trendClickable, destinations);

  // Clicking each one really moves. The dashboard is where the cards are, so
  // the assertion is on the page it leaves and the section it lands on.
  const landed = await run(`
    const out = {};
    currentPage = 'dashboard'; renderPage();
    await new Promise(r => setTimeout(r, 900));
    document.querySelector('.total-card').click();
    await new Promise(r => setTimeout(r, 900));
    out.fromTotal = currentPage;
    out.hasAccounts = !!document.getElementById('accounts-section');
    currentPage = 'dashboard'; await renderPage();
    await new Promise(r => setTimeout(r, 1200));
    document.querySelector('.chart-header').click();
    await new Promise(r => setTimeout(r, 900));
    out.fromTrend = currentPage;
    return out;
  `);
  check('the Total Money card goes to Savings, at the Accounts section',
    landed.fromTotal === 'savings' && landed.hasAccounts, landed);
  check('the Monthly trend card goes to Reports',
    landed.fromTrend === 'reports', landed);

  // Two decimals, always. An input given a Number drops the zero — £10.20 came
  // back as 10.2 — and the input keeps "10.20" when it is given a string.
  const decimals = await run(`
    const box = document.createElement('input');
    box.type = 'number';
    box.step = '0.01';
    const fromNumber = (v) => { box.value = v; return box.value; };
    return {
      fromNumber: fromNumber(10.2),
      fromString: fromNumber(moneyInput(10.2)),
      fromStringBig: moneyInput(10.21),
      fromStringZero: moneyInput(10),
      fromStringHalf: moneyInput(0.5),
      fromBlank: moneyInput(''),
    };
  `);
  check('an amount in a field keeps its second decimal',
    decimals.fromString === '10.20' && decimals.fromNumber === '10.2', decimals);
  check('and the formatted value is always two places',
    decimals.fromStringBig === '10.21' && decimals.fromStringZero === '10.00'
      && decimals.fromStringHalf === '0.50' && decimals.fromBlank === '', decimals);

  // A receipt showing the card's last four digits picks that account.
  const cardDigits = await run(`
    for (const a of await getAll('accounts')) await removeAccount(a.id);
    for (const x of await getAll('spend')) await deleteItem('spend', x.id);
    const bank = await addAccount('Everyday', 'bank', 1000, '4242');
    const other = await addAccount('Savings pot', 'savings', 50, null);
    await loadAccounts();
    const read = (text) => guessCardLast4(text);
    document.getElementById('form-account') || null;
    openAddModal('spend');
    await new Promise(r => setTimeout(r, 400));
    const withCard = read('EVERYDAY CARD\\nCARD 4242\\nTOTAL 12.75');
    const withoutCard = read('TESCO STORES LTD\\nTOTAL 12.75');
    const list = await getAccountsWithCardLast4();
    return {
      read: withCard, missing: withoutCard,
      accounts: list.map(a => a.name + ':' + a.cardLast4),
      withCardMatches: list.some(a => a.cardLast4 === withCard),
      withoutMatches: list.some(a => a.cardLast4 === withoutCard),
    };
  `);
  check('a card number on a receipt is read as the last four',
    cardDigits.read === '4242', cardDigits);
  check('a receipt with no card number reads as none', cardDigits.missing === null, cardDigits);
  check('and it matches the account that holds it',
    cardDigits.withCardMatches && !cardDigits.withoutMatches, cardDigits);

  // Changing a bill's category has to reach the months either side of it, or the
  // breakdowns report one bill under two headings.
  const propagate = await run(`
    for (const x of await getAll('due')) await deleteItem('due', x.id);
    const day = new Date();
    const iso = (offset, d) => { const t = new Date(day.getFullYear(), day.getMonth() + offset, d); return localISO(t); };
    const a = await addItem('due', { title: 'Electric', amount: 85, dueDate: iso(-2, 5), frequency: 'monthly', category: 'Utilities' });
    const b = await addItem('due', { title: 'Electric', amount: 85, dueDate: iso(-1, 5), frequency: 'monthly', category: 'Utilities' });
    const c = await addItem('due', { title: 'Electric', amount: 85, dueDate: iso(0, 5), frequency: 'monthly', category: 'Utilities' });
    const other = await addItem('due', { title: 'Rent', amount: 900, dueDate: iso(0, 5), frequency: 'monthly', category: 'Home' });
    // Save a category change through the form's own path.
    openEditModal('due', b);
    await new Promise(r => setTimeout(r, 500));
    document.getElementById('form-category').value = 'Groceries';
    closeModal();
    await saveItem('due', b);
    await new Promise(r => setTimeout(r, 900));
    const rows = await getAll('due');
    return {
      edited: (rows.find(x => x.id === b) || {}).category,
      before: (rows.find(x => x.id === a) || {}).category,
      after: (rows.find(x => x.id === c) || {}).category,
      untouched: (rows.find(x => x.id === other) || {}).category,
    };
  `);
  check('changing a bill category updates its other months',
    propagate.edited === 'Groceries' && propagate.before === 'Groceries'
      && propagate.after === 'Groceries', propagate);
  check('and leaves a different bill alone',
    propagate.untouched === 'Home', propagate);

  console.log('\n# this round: the tip, the delete, the reports breakdown, the run-out');

  // The tip used to close itself on the way in. One at a time is right, and the
  // just-opened panel carries the class that finds, so it was closing itself.
  const tip = await run(`
    currentPage = 'spend'; renderPage();
    await new Promise(r => setTimeout(r, 900));
    const btn = document.querySelector('.info-tip-btn');
    const body = document.getElementById(btn.getAttribute('aria-describedby'));
    const isOpen = () => body.classList.contains('is-open');
    btn.click(); await new Promise(r => setTimeout(r, 250));
    const afterOpen = isOpen();
    // Clicking anywhere else closes it — the whole point of the outside tap.
    document.body.click(); await new Promise(r => setTimeout(r, 250));
    const afterOutsideTap = isOpen();
    // And pressing the dot again still toggles.
    btn.click(); await new Promise(r => setTimeout(r, 250));
    const reopened = isOpen();
    document.body.click();
    return { afterOpen, afterOutsideTap, reopened };
  `);
  check('pressing the info dot opens the tip', tip.afterOpen === true, tip);
  check('and clicking anywhere else closes it', tip.afterOutsideTap === false, tip);

  // The same on the Bills tab, which has its own copy.
  const tipBills = await run(`
    currentPage = 'due'; renderPage();
    await new Promise(r => setTimeout(r, 900));
    const btn = document.querySelector('.info-tip-btn');
    if (!btn) return { hasTip: false };
    const body = document.getElementById(btn.getAttribute('aria-describedby'));
    btn.click(); await new Promise(r => setTimeout(r, 250));
    const opened = body.classList.contains('is-open');
    document.body.click(); await new Promise(r => setTimeout(r, 250));
    return { hasTip: true, opened, closed: !body.classList.contains('is-open') };
  `);
  check('and the Bills tip does the same',
    tipBills.hasTip === false || (tipBills.opened === true && tipBills.closed === true), tipBills);

  // Bills by category used to report only what was still owed, so a kept-up-to-
  // date bill list came out blank and £0.00 next to Spending by category
  // counting everything.
  const billsByCat = await run(`
    const iso = (offset, d) => { const t = new Date(2026, 8 + offset, d); return localISO(t); };
    for (const x of await getAll('due')) await deleteItem('due', x.id);
    for (const m of [-2, -1, 0]) {
      await addItem('due', { title: 'Rent', amount: 900, dueDate: iso(m, 5), frequency: 'monthly', category: 'Home' });
      await addItem('due', { title: 'Electric', amount: 85, dueDate: iso(m, 12), frequency: 'monthly', category: 'Utilities' });
    }
    // Everything settled, the way a household that keeps on top of it looks.
    for (const b of (await getAll('due')).filter((d) => !d.paid)) await markDuePaid(b, null);
    reportRange = 'all';
    currentPage = 'reports';
    await renderPage();
    await new Promise(r => setTimeout(r, 1500));
    const card = [...document.querySelectorAll('.report-card')].find(c => /Bills by category/.test(c.textContent));
    return {
      head: (card.querySelector('.report-head-total') || {}).textContent,
      cats: [...card.querySelectorAll('.category-name')].map(n => n.textContent),
      empty: /No data yet/.test(card.textContent),
      allPaid: (await getAll('due')).every(d => d.paid),
    };
  `);
  check('Bills by category counts settled bills too',
    !billsByCat.empty && billsByCat.cats.length >= 1, billsByCat);
  check('and its total is not £0.00', billsByCat.head !== '£0.00', billsByCat);

  // Deleting the series keeps the paid months: they are the only record that
  // the money left, and the old dialog counted them among the casualties.
  const deleteSeries = await run(`
    const iso = (offset, d) => { const t = new Date(2026, 8 + offset, d); return localISO(t); };
    for (const x of await getAll('due')) await deleteItem('due', x.id);
    for (const m of [-2, -1, 0]) {
      await addItem('due', { title: 'Rent', amount: 900, dueDate: iso(m, 5), frequency: 'monthly', category: 'Home' });
    }
    for (const b of (await getAll('due')).filter((d) => !d.paid && d.dueDate < localISO(new Date()))) {
      await markDuePaid(b, null);
    }
    const before = await getAll('due');
    const target = before.find(d => !d.paid);
    const paidBefore = before.filter(d => d.paid === true).length;
    await deleteRecurringBill(target.id, true);
    const after = await getAll('due');
    return {
      paidBefore, paidAfter: after.filter(d => d.paid === true).length,
      liveAfter: after.filter(d => d.paid !== true).length,
      title: (await getItem('due', target.id)) ? 'still there' : 'gone',
    };
  `);
  check('deleting a repeating bill keeps the months already paid',
    deleteSeries.paidAfter === deleteSeries.paidBefore
      && deleteSeries.paidBefore > 0, deleteSeries);

  // The account editor carries the type and the last four digits now, not just
  // the add form.
  const accountEditor = await run(`
    for (const a of await getAll('accounts')) await removeAccount(a.id);
    const acc = await addAccount('Everyday', 'bank', 1000, null);
    await loadAccounts();
    openAccountSetup(acc);
    await new Promise(r => setTimeout(r, 600));
    const open = {
      hasLast4: !!document.getElementById('account-cardLast4'),
      hasType: !!document.getElementById('account-type'),
      typeOptions: [...document.getElementById('account-type').options].map(o => o.value),
    };
    document.getElementById('account-cardLast4').value = '4242';
    document.getElementById('account-type').value = 'savings';
    await saveAccount(acc);
    const row = (await getAll('accounts'))[0];
    return { open, saved: { last4: row.cardLast4, type: row.type } };
  `);
  check('editing an account offers the card digits and the type',
    accountEditor.open.hasLast4 && accountEditor.open.hasType, accountEditor.open);
  check('and saves them',
    accountEditor.saved.last4 === '4242' && accountEditor.saved.type === 'savings',
    accountEditor.saved);

  // When money gets tight, read off the balance the forecast already draws.
  const runsOut = await run(`
    const iso = (offset, d) => { const t = new Date(2026, 8 + offset, d); return localISO(t); };
    for (const t of ['spend','due','savings','people','accounts','transfers','income']) {
      for (const x of await getAll(t)) await deleteItem(t, x.id);
    }
    await addItem('accounts', { name: 'Bank', type: 'bank', opening: 600 });
    await loadAccounts();
    // £600 in, spending roughly £250 a month and no income: the balance reaches
    // the cost line first, and reaches nought afterwards. Six months, not three:
    // with three, nought lands two days past the end of the window whenever the
    // calendar puts the window's end near it, and the check below — which is
    // about the *order* of the two dates — fails on a fixture that has nothing
    // wrong with it. That is a test measuring the calendar, and this suite has
    // been bitten by exactly that before.
    for (let i = 0; i < 4; i++) {
      await addItem('spend', { title: 'S' + i, amount: 250, date: iso(-4 + i, 5), category: 'Groceries' });
    }
    const f = await buildForecast(6, 0);
    const ahead = f.series.filter((p) => !p.actual);
    return {
      runsOut: f.runsOut,
      series: f.series.length,
      firstBalance: f.series.length ? f.series[0].balance : null,
      crossing: (ahead.find((p) => p.balance <= p.costs) || {}).date || null,
      zero: (ahead.find((p) => p.balance <= 0) || {}).date || null,
      perWindow: [1, 3, 6, 12].map((m) => null),
    };
  `);
  // The figure is when the green line crosses the red one — the day Total money
  // falls to the level of Total est costs — and not when the money reaches
  // nought, which is later and is not a date you can point at on the chart.
  check('the forecast says when money gets tight',
    runsOut.runsOut && runsOut.runsOut.runsOut === true, runsOut);
  check('and the figure is months and days',
    Number.isInteger(runsOut.runsOut.months) && Number.isInteger(runsOut.runsOut.days),
    runsOut.runsOut);
  check('which is when the balance line reaches the cost line, before it reaches zero',
    runsOut.crossing !== null && runsOut.crossing < runsOut.zero,
    { crossing: runsOut.crossing, zero: runsOut.zero, runsOut: runsOut.runsOut });

  // The line beside the heading, one short sentence.
  const runOutSentence = await run(`
    const f = await buildForecast(3, 0);
    return { text: runOutText(f.runsOut),
             comfortable: runOutText({ runsOut: false, months: Infinity, days: 0 }) };
  `);
  check('with "X months and X days of money remaining"',
    /^\d+ months? and \d+ days? of money remaining$/.test(runOutSentence.text), runOutSentence);
  check('and an honest answer when it never gets tight',
    runOutSentence.comfortable === 'More than 12 months of money remaining',
    runOutSentence.comfortable);

  console.log('\n# Reports: one breakdown, one typeface');
  const oneTypeface = await run(`
    for (const t of ['spend', 'due', 'savings', 'people', 'accounts', 'transfers', 'income']) {
      for (const x of await getAll(t)) await deleteItem(t, x.id);
    }
    await loadAccounts();
    await addItem('accounts', { name: 'Bank', type: 'bank', opening: 900 });
    await addItem('accounts', { name: 'Cash', type: 'cash', opening: 90 });
    await loadAccounts();
    const accs = await getAll('accounts');
    const cats = ['Groceries', 'Eating out', 'Home', 'Travel'];
    for (let i = 1; i <= 5; i++) {
      await addItem('spend', { title: 'Item ' + i, amount: 40 + i * 9,
        date: localISO(new Date(2026, 9, i)), category: cats[i % cats.length],
        accountId: accs[i % 2].id });
      await addItem('due', { title: 'Bill ' + i, amount: 30 + i,
        dueDate: localISO(new Date(2026, 9, i)), frequency: 'monthly', category: 'Utilities' });
    }
    currentPage = 'reports';
    await renderPage();
    await new Promise((r) => setTimeout(r, 1800));

    const pick = (name) => {
      const cards = [...document.querySelectorAll('.report-card')];
      return cards.find((c) => ((c.querySelector('.report-title') || {}).textContent || '').trim() === name);
    };
    const describe = (card) => {
      const cs = (el) => {
        const c = getComputedStyle(el);
        return { size: parseFloat(c.fontSize), weight: Number(c.fontWeight),
                 pt: parseFloat(c.paddingTop), mb: parseFloat(c.marginBottom), h: Math.round(el.getBoundingClientRect().height) };
      };
      const out = { title: cs(card.querySelector('.report-title')) };
      const sub = card.querySelector('.pattern-sub, .setting-hint');
      if (sub) out.sub = cs(sub);
      const name = card.querySelector('.category-name, .account-total-name, .pattern-name');
      if (name) out.name = cs(name);
      const val = card.querySelector('.category-amount, .account-total-amount, .pattern-amount');
      if (val) out.val = cs(val);
      const row = card.querySelector('.category-row, .account-total, .pattern-row');
      if (row) out.row = cs(row);
      return out;
    };
    return {
      standard: describe(pick('Spending by category')),
      money: describe(pick('Where your money is')),
      patterns: describe(pick('Patterns')),
    };
  `);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  check('the three breakdown cards render their names identically',
    oneTypeface.standard.name && same(oneTypeface.standard.name, oneTypeface.money.name)
      && same(oneTypeface.standard.name, oneTypeface.patterns.name), oneTypeface);
  check('and their amounts identically',
    oneTypeface.standard.val && same(oneTypeface.standard.val, oneTypeface.money.val)
      && same(oneTypeface.standard.val, oneTypeface.patterns.val), oneTypeface);
  check('with the same row rhythm and heading size',
    same(oneTypeface.standard.row, oneTypeface.money.row)
      && same(oneTypeface.standard.row, oneTypeface.patterns.row)
      && same(oneTypeface.standard.title, oneTypeface.money.title)
      && same(oneTypeface.standard.title, oneTypeface.patterns.title), oneTypeface);

  console.log('\n# 360px: the narrowest width the app claims to support');
  await resize(360);
  const narrow = await run(`
    currentPage = 'settings'; await renderPage();
    await new Promise((r) => setTimeout(r, 1000));
    // Line boxes, not height: a block's getClientRects() is always 1 and cannot
    // see a wrap, which is how a three-line card gets reported as fine.
    const lineBoxes = (el) => el.getClientRects().length;
    const card = (re) => [...document.querySelectorAll('.report-card')]
      .find((c) => re.test(c.textContent));
    const reminders = card(/Bills due/);
    const rows = reminders ? [...reminders.querySelectorAll('.setting-row')] : [];
    return {
      width: window.innerWidth,
      remindersRows: rows.length,
      oneLineEach: rows.every((r) => lineBoxes(r.querySelector('.setting-label')) === 1),
      inCard: rows.every((r) => {
        const b = reminders.getBoundingClientRect(), a = r.getBoundingClientRect();
        return a.left >= b.left - 1 && a.right <= b.right + 1;
      }),
      hints: reminders ? reminders.querySelectorAll('.setting-hint').length : -1,
      sync: !!card(/Sync/),
      stepsHead: (card(/Sync/) || {}).textContent || '',
    };
  `);
  check('the viewport really is the narrow one', narrow.width === 360, narrow);
  check('the Reminders card is three rows', narrow.remindersRows === 3, narrow);
  check('each one is a single line', narrow.oneLineEach === true, narrow);
  check('and nothing spills out of the card', narrow.inCard === true, narrow);
  check('no settings row carries a hint underneath it', narrow.hints === 0, narrow);
  check('the steps are headed "Setup", not "SETUP"', /Setup/.test(narrow.stepsHead) && !/SETUP/.test(narrow.stepsHead), narrow);

  console.log('\n# 360px: the balance card heading fits a five-figure total');
  const narrowReports = await run(`
    currentPage = 'reports'; await renderPage();
    await new Promise((r) => setTimeout(r, 1800));
    const lineBoxes = (el) => el.getClientRects().length;
    const card = [...document.querySelectorAll('.report-card')]
      .find((c) => /Where your money is/.test(c.textContent));
    const title = card.querySelector('.report-title');
    const accounts = [...card.querySelectorAll('.account-total')];
    return {
      titleLines: lineBoxes(title),
      accountLines: accounts.map((a) => lineBoxes(a.querySelector('.account-total-name'))),
    };
  `);
  check("the balance card's heading is one line at 360px with a big total",
    narrowReports.titleLines === 1, narrowReports);
  check('and each account is one line',
    narrowReports.accountLines.length >= 1
      && narrowReports.accountLines.every((n) => n === 1), narrowReports);

  // The page's top row stays put while the page moves, and nothing moves before
  // you scroll.
  const pinned = await run(`
    // Enough rows to make every page taller than the screen: a page that cannot
    // scroll cannot prove that anything stayed put.
    for (let i = 0; i < 18; i++) {
      await addItem('spend', { title: 'Pin row ' + i, amount: 5 + i, date: '2027-01-05', category: 'Groceries' });
      await addItem('due', { title: 'Pin bill ' + i, amount: 6 + i, dueDate: '2027-01-09', category: 'Utilities' });
    }
    for (let i = 0; i < 6; i++) {
      await addItem('savings', { title: 'Pin goal ' + i, current: 10 + i, target: 400 + i, category: 'Holiday' });
    }
    const measure = () => {
      const row = document.querySelector('.page-toolbar--fixed');
      if (!row) return { found: false };
      const controls = [...row.querySelectorAll('button, .filter-bar, .month-nav')];
      const before = {
        row: Math.round(row.getBoundingClientRect().top),
        // A row that grew would move its controls and, on the dashboard, drag
        // the absolutely-centred sync button out of line beside them.
        height: Math.round(row.getBoundingClientRect().height),
        controls: controls.map((c) => Math.round(c.getBoundingClientRect().top))
      };
      window.scrollTo(0, 600);
      return { found: true, before, after: Math.round(row.getBoundingClientRect().top),
               controlsAfter: controls.map((c) => Math.round(c.getBoundingClientRect().top)),
               scrolled: Math.round(window.scrollY),
               height: Math.round(row.getBoundingClientRect().height),
               // The row must be the thing on top where it sits, or content
               // scrolling past would show through it.
               onTop: (() => {
                 const el = document.elementFromPoint(window.innerWidth / 2, row.getBoundingClientRect().top + 2);
                 return !!(el && row.contains(el));
               })()
      };
    };
    const out = {};
    for (const page of ['dashboard', 'spend', 'due', 'savings', 'reports']) {
      viewedDate = new Date(2027, 0, 1);
      dueViewedDate = new Date(2027, 0, 1);
      dashViewedDate = new Date(2027, 0, 1);
      spendFilter = 'all'; dueFilter = 'all'; personFilter = 'all';
      currentPage = page;
      await renderPage();
      await new Promise((r) => setTimeout(r, 700));
      out[page] = measure();
    }
    window.scrollTo(0, 0);
    return out;
  `);
  check('every page has a top row to pin', Object.values(pinned).every((p) => p.found), pinned);
  check('and they all stay put while the page scrolls',
    Object.values(pinned).every((p) => p.scrolled > 100 && p.after === p.before.row), pinned);
  check('their controls keep their line and their row its height',
    // Each control where it was — the month navigator's own arrows sit a few
    // pixels below its label by design, so it is each one against itself rather
    // than all of them against the first.
    Object.values(pinned).every((p) => p.height === p.before.height
      && p.controlsAfter.every((c, i) => c === p.before.controls[i])), pinned);
  check('and the row paints over what is beneath it',
    Object.values(pinned).every((p) => p.onTop), pinned);

  // A receipt photographed with the phone held sideways.
  console.log('\n# the four data-loss bugs found in the full review');
  const review = await run(`
    const out = {};
    const t = (label, got, want) => { out[label] = { got: JSON.stringify(got), want: JSON.stringify(want), pass: JSON.stringify(got) === JSON.stringify(want) }; };
    const step = async (label, fn) => { try { await fn(); } catch (e) { out[label] = { threw: e.message, pass: false }; } };
    const wipe = () => new Promise((resolve) => { openDB().then((d) => {
      const ns = [...d.objectStoreNames];
      const tx = d.transaction(ns, 'readwrite');
      ns.forEach((n) => tx.objectStore(n).clear());
      tx.oncomplete = () => resolve();
    }); });

    // 1. A savings top-up is a note against somebody else's row, so it has no
    //    title — and sanitizeItem used to require one of everything. Every
    //    import and every sync pull therefore dropped the whole store, and the
    //    Total Money card forgot which month each contribution arrived in.
    await step('topUps', async () => {
      await wipe();
      await loadPeople(); await loadAccounts();
      const goal = await addItem('savings', { title: 'Holiday', current: 300, target: 1200, category: 'Holiday' });
      await recordGoalContribution(goal, 50);
      await recordGoalContribution(goal, 25);
      await new Promise(r => setTimeout(r, 400));
      t('before', (await getAll('savingsTopUps')).length, 2);
      const backup = await getAllData();
      t('inBackup', (backup.savingsTopUps || []).length, 2);
      t('survivesSanitise', (backup.savingsTopUps || []).filter((r) => sanitizeItem('savingsTopUps', r) !== null).length, 2);
      await importDataToDB(backup, 'replace');
      await new Promise(r => setTimeout(r, 900));
      t('afterImport', (await getAll('savingsTopUps')).length, 2);
      const goals = await getAll('savings');
      const ups = await getAll('savingsTopUps');
      // ...and still pointing at the goal it was paid into, not at an id the
      // import minted and then threw away.
      t('pointsAtALiveGoal', ups.length > 0 && goals.some((g) => String(g.id) === String(ups[0].goalId)), true);
    });

    // 2. Paying a bill while any *other* bill is already due next month used to
    //    conclude the series was scheduled, and never wrote the next row. The
    //    bill simply stopped recurring.
    await step('rollForward', async () => {
      await wipe();
      await loadPeople(); await loadAccounts();
      const rent = await addItem('due', { title: 'Rent', amount: 900, dueDate: '2027-01-05', category: 'Housing', frequency: 'monthly', recurring: true });
      await addItem('due', { title: 'Council tax', amount: 200, dueDate: '2027-02-05', category: 'Bills' });
      await new Promise(r => setTimeout(r, 300));
      await markDuePaid((await getAll('due')).find((x) => x.id === rent), null);
      await new Promise(r => setTimeout(r, 900));
      t('rentStillRecurs', (await getAll('due')).filter((x) => x.title === 'Rent' && x.paid !== true).map((x) => x.dueDate), ['2027-02-05']);
      // And paying that one does not create a second row for March either.
      const rolled = (await getAll('due')).find((x) => x.title === 'Rent' && x.dueDate === '2027-02-05');
      await markDuePaid(rolled, null);
      await new Promise(r => setTimeout(r, 900));
      t('rentRollsAgain', (await getAll('due')).filter((x) => x.title === 'Rent' && x.paid !== true).map((x) => x.dueDate), ['2027-03-05']);
    });

    // 3. Un-paying a pre-2.8.3 payment looked its spend-store id up in the due
    //    store, where it either found an unrelated bill or nothing at all.
    await step('unpay', async () => {
      await wipe();
      await loadPeople(); await loadAccounts();
      const copy = await addItem('spend', { title: 'Water', amount: 60, date: '2026-08-12', dueDate: '2026-08-12', paid: true, category: 'Utilities' });
      const bill = await addItem('due', { title: 'Water', amount: 60, dueDate: '2026-08-12', category: 'Utilities' });
      const other = await addItem('due', { title: 'Electric', amount: 70, dueDate: '2026-09-12', category: 'Utilities' });
      await new Promise(r => setTimeout(r, 400));
      await unpayBill(copy, 'spend');
      await new Promise(r => setTimeout(r, 900));
      t('legacyCopyGone', (await getAll('spend')).length, 0);
      t('billStillOwing', !!(await getAll('due')).find((x) => x.id === bill), true);
      t('unrelatedBillUntouched', (await getAll('due')).find((x) => x.id === other).paid, undefined);
      // And a modern one still works.
      const modern = await addItem('due', { title: 'Gas', amount: 80, dueDate: '2026-09-15', category: 'Utilities' });
      await updateItem('due', { ...(await getAll('due')).find((x) => x.id === modern), paid: true });
      await new Promise(r => setTimeout(r, 400));
      await unpayBill(modern, 'due');
      await new Promise(r => setTimeout(r, 900));
      t('modernUnpaid', (await getAll('due')).find((x) => x.id === modern).paid, false);
    });

    // 4. Categories are free text, so a plain object keyed by them let
    //    toString and __proto__ turn real money into a function or into
    //    nothing at all.
    await step('categories', async () => {
      await wipe();
      await loadPeople(); await loadAccounts();
      const a = await addAccount('A', 'bank', 0, null);
      const cats = ['Groceries', 'Groceries', '__proto__', 'toString', 'constructor', 'hasOwnProperty'];
      for (let i = 0; i < cats.length; i++) {
        await addItem('spend', { title: 'R' + i, amount: 10, date: '2026-09-0' + (i + 1), accountId: a, category: cats[i] });
      }
      await new Promise(r => setTimeout(r, 600));
      const groups = groupByCategory(await getAll('spend'), 'amount');
      t('totalIsANumber', Object.values(groups).reduce((x, y) => x + y, 0), 60);
      t('nothingVanishes', Object.keys(groups).length, 5);
      t('protoIsTen', groups['__proto__'], 10);
    });

    return {
      checks: Object.keys(out).length,
      failures: Object.entries(out).filter(([, v]) => !v.pass).map(([k]) => k),
      detail: out
    };
  `);
  check('every top-up survives a backup and a restore', review.failures.indexOf('before') < 0, review);
  check('and it still names the goal it was paid into', review.detail.pointsAtALiveGoal && review.detail.pointsAtALiveGoal.pass, review.detail);
  check('and the whole store survives the round trip', review.detail.afterImport && review.detail.afterImport.pass, review.detail);
  check('a bill keeps recurring when another is due the same day', review.detail.rentStillRecurs.pass && review.detail.rentRollsAgain.pass, review.detail);
  check('un-paying a legacy payment deletes the copy, not a stranger', review.detail.legacyCopyGone.pass
    && review.detail.billStillOwing.pass && review.detail.unrelatedBillUntouched.pass
    && review.detail.modernUnpaid.pass, review.detail);
  check('a category named after an Object property still sums', review.detail.totalIsANumber.pass
    && review.detail.nothingVanishes.pass && review.detail.protoIsTen.pass, review.detail);
  check('and nothing failed anywhere in that block', review.failures.length === 0, review.failures);

  console.log('\n# a receipt photographed with the phone turned');
  const rotated = await run(`
    const fromBase64 = (b64, name) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new File([bytes], name, { type: 'image/jpeg' });
    };
    // A long receipt photographed with the phone turned — the same roll, the
    // same pixels per millimetre, as the fixtures the corpus tool uses. Handed
    // over from Node rather than fetched: the app is on one origin and the
    // fixtures are files, and a cross-origin fetch would need them served with
    // CORS headers that exist for nobody's benefit but this.
    const src = fromBase64("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAL4BHQDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD9U6KKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKy/8AhKvDH/Qx6X/4GR/40AalFZf/AAlXhj/oY9L/APAyP/Gvlrwz4w1PVP8Agp9r/h6z8U3V3oEfwcS7Sxivmks1uf7Vt1MojDFBJtYjdjODjvQB9c0V+eXxA+Mv7Zmj/tkfG1vgrfW/jDwj8MYPD95feAr1RvvLO602GSb7C6oXWcMJXADfMW+7IQEP2X8CPjn4C/aJ+G2m/E74eX7Tafe5iuLaYBbiwulx5ltOgJ2SKSOOhBVgSrAkA9Cor4+8TfFz9ov9n79rPw/oHxQ1vSfE3we+L+uto3hx4LdY7vw9fuALe3dgql1dsD5i+QWIK7drfWWua9ofhjSrjXfEms2Ok6baJ5lxeX1ykEEK/wB55HIVR7k0AX6K+OviF/wU1+EVrrb+Bf2ffCXiX41+LzlY7LwxZyGzVhxl7nYxK9PnjSRcdWFchL8MP+Ckf7Unz/FD4k6T8AvB1197RfDJM+ryRHoJJkfcpK8H9+o55i7UAfelFc/8PvCFt8PfAXhrwDZ6jd6hB4a0iz0eK7vGDT3CW8KRLJIQAC7BAWIHUmug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9I0DToNI0LSrPTbC2XZDa2kCwwxL6KigKo9gKuV81/sCftS+KP2t/grqHxF8Y+G9L0bVNL8QT6FLHprSGCfy7a2m81VkLMmftBG0s33c55wPpSgAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAoor4y/4e4fsYf9DX4j/8EE/+FAH2bXI23xZ+HN78TJvg5Y+LtPuvGVtpcms3OkwSeZNbWiSRRl5tuRGS08WFYhmDZAIBI+K2/al+Pf7eGu6p8PP2NHi8BeBtMkW31/4gauyjUQrj7lpaqxeMsoba33jx88B6/R37M/7HXwj/AGYLS6v/AApbXeseLtXjKaz4q1aTztRvyzB3XceI4y6q2xepVSxdgGoA8P0zQvh74z/4KefEGx+Ntnpuo6lpHhTRW+HVjrKpJA1u0Qe8kt45PlaVZzJjALDMpH3SR9wxxRRRrDFGqRoNqoowAPQCvmr4/wDww/Y+/au8ct8GPiL4i0w/EnwvGklsmnaktnrtgkkazjyiR+8XY6ybSsiruDYBOa80/wCHYl/bn7Hpv7Z3xxttLHyraf24xwnplSq9P9j8KAD9rrw78PPCf7Vf7N3iL4cafpmmfFDVPHENtqKaXGkVzeeH3UreyXKx4LqqFgrOOhkAOAcfcdfLf7Lf7K/7KvwZ8deINS+HXihvG3xJ0ljZ63qmta1HqGr6eXUbkaNQog3DjdsDMuV3EZFfUlAHN/EfwpqXjjwNrXhLSPGereE7zVLVoIda0llW7siSDvjLAgHAIzwcE4KnBHyfp/7HPwQ+Ff7TXgCHS/8AhCtQsfEPhbVtO1rRfGUo1HWPEF1FIlwuowidHE9wGdvNfKbY8hRtGF+jf2jIvBM3wO8ZxfEfR/EOq+Gn0uQalZ+H1mbUJosj5YBCQ5bOO4XGd/ybq/PH4S6Z+2Xpn7UHh21kutDstduPAV6PAEfxbM17qEGii9BkinewMf8AxMNu1n3h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vV7DxZdaRC9pZpbILZLOzlUFV4J3zyc+49K+sq+AP+CKn/JrHin/ALKBff8Apu06vv8AoAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACvl/9uD4zfFnwTbfD/wCDXwEuLOx+IXxb1qXSdO1O7QNHptrAivc3GCrDcokj5Kthd5ClgtfUFfKH7dvw7+LFxefC39ob4KeF38U+Jvg9rdzfyaBGT52o6ddRol0kQAJZ9sSgKoLYdiAxUKQD0zTfFGnfspfs+6Xqf7R/xfm1r+wEW31bxVdWM7vdTzzny8xR+bJwZEjB54UH5RwPO/23PEf7TXwj06y/aF+CfivS7jwv4ItDN4q8IX1sCNVtfNBkmSXBKMif3SpADHLfcbwv4j+O/jN/wUesNO+AGk/s/eM/hf4SF1/afivxF4lt3iWNoI3MFrCrRr5hM5jJx82FBKqoJqt8QviB/wAFCvi78MJ/2Sb/APZYfSda1W1j8P6549l1LfpU9oMJNcp8gRfMQEtiR2wzbY9xCqAfoT4I8WaZ498F6B460Xf/AGf4j0u11a03/e8m4iWVM++1xW3XOfDzwhY/Db4deGfANndGWz8LaLZaPFM427oraBIgx9MhAa+bviP/AMFRv2Qfh3rk/hyLxnqXiu/tnMUy+G9Oa7iVx1CzMUik+qOw96APrSivjbwp/wAFZf2QPEWqxaRrGt+J/CjzMFWXXNEdIgTwNzQNLtGf4mwB3IFfXuj6zpHiLSbPXtA1S11LTdQhS5tLy0mWWGeJhlXR1JDKQQQQcGgDx79jj4JQ/s7/AAG0f4Sw+NrHxX/Y91eSPqVnCIo3aad5tuwO+CokA+97969tryz9nT9m74bfsu+Cb3wB8Lo9TTStQ1WXWJhqF19ok+0SQwxNhtowu2CPjHXPrXqdABXz38OP2ffEfh39rL42fGzxNb6Jd+HfiBbeH4tGj3GW5jayslgm81GTamXX5cMcjrjpX0JXkfhv4EaroH7SHir4+y/FfxJf2PiXSI9Li8IzysdM09lS0Xz4V3kBz9lYnCjmeTnnkA9K/wCEb8O/9ADTv/AWP/CnxeH9BhkSaHRLCOSNgyOtsgKkdCDjg1fooAKKKKACiiigAooooAKKKKACsW48FeDbueS6uvCWizTTOZJJJLCJmdicliSuSSeSTW1Xzv8Atg/tsfDT9kHw3aXHiK2l13xRrCO+keH7WYRyzqpw00shBEMIPG4qxJyFVsNtAPav+EC8C/8AQl6F/wCC6H/4mvG/2y/Bfg6y/ZQ+LV3Z+E9Ggnh8Iam8csVhErowgbBBC5B96/M3xJ/wWZ/am1TUnn8P+HvAuiWQb91brp09w+30eR5vmPuFX6CvU/gh/wAFik8V36+Bf2rPhpoE3h3WB9ju9V0m2d4Y43+U/abKYyCaM5+bYwIGcI3SgD2L/gip/wAmseKf+ygX3/pu06vv+ud8B+G/h74c8PQj4ZeH/D+laHqe3UYhoVpDb2tz5iLicCEBH3IqfPzlQvOAK6KgAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAK8j+M3xR+LXgPx58NfDnw8+DN34z0XxZq5svEurQztGvh61862T7Q4CkMNk074JX/UHnnj1yvkn9tn9oD9oX4Q/Ev4M+B/2e9B0PXtU8dSa79p0jVIwBfCyitZViSUunlMUkmwd2C23PHBAPraivHP2aP2mvCH7SXhW8v9M0678P8Ainw/P9g8T+F9RBW+0a9BIMcgIBZCVba+BnaQQrKyrw/7Xv7QPx1/Zs1DQ/iZ4b+GmneK/hNYxKvjJ45Sup2JeYIs0I3gbVBGcowJOCUHzgA0/wDgoVfeKtN/Yx+K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ooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigD4+8d/EL49fGP9tWH4DfCPxnB4P8ABfwoj0jxD42u/IEs+rSTOk8dgOhEckJCkAqMGUsWwiG7/wAFE/HXx7+GHgDwh46+C/xKh8GafB4ig0zxLfyafb3ghtrtliinaOaNwUjk+8Fw37wYz25b452vxw/Za/af139qH4YfCjUfiZ4K+Iej2OneLtH0jc2o2N3ZoI4LmNFVmZBEo5CleZAxT5Grzr4n/FL43/8ABRKPRfgJ4J/Z38YeAfANzq9pfeL/ABL4otmtwLSCQSGCEFQrPuUEBWZiwTIRdzUAbfinxh/wUI/Z3+Ivwjtvi58cvA/i/wAM+PPH+j+E7mKx0KKG68u5nUSHi3jC/uw4BDEgkcV+g9fNf7ZPwt8ffErX/gLd+B/Dsuqw+EvivofiDWWjljT7Jp8Dkyznew3BQei5b0Br6UoAKKKKAOL+M3wr8P8Axu+Fnib4UeKXlj03xNYPZSyxAGSBjho5VB4LJIqOAeMqM18b2/wF/wCCn8nh7/hRl98evh+PBLW39kyeKktXbWP7N2+WQF8oHzvK+XJbdnnzs/PX35RQB8LXn7Ef7Unwde58Kfsb/tNWng/wDqhSW40XXdPjuZbCcxqk0ttMYJSDIVLkL5WGY8k4avpX9mf4B6R+zd8JtP8Ahtp2tXOt3gnn1HV9Xul2zalqE7bprhhk4ycKASSFVcljkn1SigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAw/HXjHR/h54J8Q+P/ERnGleGdKu9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LMsimIH5SFwWyM4qloP/AAS5/aN+IPwX1j4w+MNdurP436jrcOs2FpqupE3MlqiPvE1xuPlXUkjK6lm+TyUVihZtnK+Dv+Cdv7d/x78d6Tpv7Q174i07w7p0wW61bxH4lTU5LeDI8xLWPzpWZ2VcLgBMgZbFAH67/ADxDqvi34EfDfxXrsry6lrXhHR9QvHc5Zp5rOKSQn3LMa72qWiaNpvhzRdP8PaPbLb2Gl2sVlawr0jhjQIij6KoH4VdoAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooA//2Q==", 'landscape.jpg');
    const upright = fromBase64("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAR0AvgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD9U6KKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAr8qvE/7FH/BUvUPEurX+i/tRanb6fc3081pCPiPq8YjhaRii7QuFwpAwOBX6q0UAfz7eFfGP7cHjD4+H9nLSf2nPiAvisa3eaB5k3jrVFtPtNs0iyHzA5bZmJsHbk8cCvtf4I/sff8FKfCPxg8G+KPiP+0jqOr+FtK1u0u9YsH+IGq3S3VmkqtLGYZF2SBlBG1uDnBr5g+A//KWZ/wDsp3iL/wBG3lfujQB+NHxK+PPxysP+CoVr8P7H4z+Orfwu3xQ0PTzokXiK8SwNrJdWyvB9nEnl+WwZgU27SGII5r9l6/n+/a38Va94E/4KJ+LfG/hXT4b/AFrw944stV020mieWO4uoGglijZEKu6s6KCqkMQcAg817/8A8PWP29P+je/CX/hJ6z/8l0AZP/BS/wCPPxy8B/tkX/hfwP8AGfx14d0ZNP0l107SfEV5aWoZ4lLkRRSKmWPU4571+zFfzdftFfGj4k/Hz43f8LG+LHhex8P+IbpLK2lsrOyuLSJY4gFRhHO7uCRzktg9sV/SLQB+cv8AwV8/ac8ZfC3R/BHwm+FvjXWvDfiHWZ5Nc1G80XUJbO7SyjDQwxeZEytslkaUkA8m3FeZ/wDBOb9ob45+C/2uPEH7OP7RvxB8Va3eatbT6dBB4g1m4v8A7HqdpmVRE07tsWSHzvu43nyuuBXBaJL/AMN0/wDBU/8AtLP27wj4e1c3Cfxxf2RpJAj4/wCec86oT73Rrof+CqXhHWvgF+1r4D/ah8Fw+TJrX2XUDIOFOq6a8YIfH8LwfZhg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RRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFAH/2Q==", 'portrait.jpg');

    const frame = await uprightReceiptFrame(src, 'cw');
    const read = async (file) => {
      dropOcrWorker();
      const text = await runOCRWithTimeout(file, null, 600000);
      return {
        title: guessTitleFromText(text),
        amount: guessAmountFromText(text),
        date: guessDateFromText(text),
        confidence: lastReadConfidence
      };
    };
    const turned = await read(frame.file);
    const other = await uprightReceiptFrame(src, 'ccw');
    const otherRead = await read(other.file);
    const plain = await read(upright);
    const plainFrame = await uprightReceiptFrame(upright, 'cw');

    return {
      // The landscape frame is recognised, and comes back portrait.
      wasLandscape: frame.turned,
      turnedSize: await new Promise((resolve) => {
        const i = new Image();
        i.onload = () => resolve(i.naturalWidth + 'x' + i.naturalHeight);
        i.onerror = () => resolve('unreadable');
        i.src = URL.createObjectURL(frame.file);
      }),
      // One of the two directions reads the receipt; the other reads noise.
      rightWayUpScore: [turned, otherRead].filter((r) => r.amount === 11.78).length,
      betterOfTheTwo: (turned.confidence >= otherRead.confidence ? turned : otherRead),
      // A photo that is already upright is left alone, and reads.
      plain: { amount: plain.amount, wasLandscape: plainFrame.turned },
      threshold: OCR_TURN_TRUST
    };
  `);
  check('a landscape frame is turned upright',
    rotated.wasLandscape && rotated.turnedSize === '760x1140', rotated);
  check('one of the two directions reads the receipt, the other reads noise',
    rotated.rightWayUpScore === 1
    && rotated.betterOfTheTwo.amount === 11.78
    && rotated.betterOfTheTwo.date === '2026-09-28', rotated);
  check('the trust threshold sits between the two, and only picks the read',
    rotated.threshold > 40 && rotated.threshold < 80, rotated.threshold);
  check('an upright photo is left alone and still reads',
    rotated.plain.amount === 11.78 && rotated.plain.wasLandscape === false, rotated.plain);

  // The padding below the fixed row, measured in pixels rather than in
  // computed style: the row's margin-bottom is a gap in the *flow*, and a gap
  // in the flow scrolls — with nothing painted there, a list scrolls up until
  // it touches the row. What is measured is whether the strip below the row is
  // opaque, which is the only thing that keeps the separation.
  console.log('\n# the strip below the fixed row is painted');
  const painted = await (async () => {
    const out = {};
    for (const page of ['dashboard', 'spend', 'due', 'savings', 'reports']) {
      const geo = await run(`
        viewedDate = dueViewedDate = dashViewedDate = new Date(2027, 0, 1);
        currentPage = ${JSON.stringify(page)};
        await renderPage();
        await new Promise(r => setTimeout(r, 700));
        window.scrollTo(0, 260);
        await new Promise(r => setTimeout(r, 260));
        const row = document.querySelector('.page-toolbar--fixed');
        window.__geo = row.getBoundingClientRect();
        return { afterHeight: getComputedStyle(row, '::after').height,
                 rowHeight: Math.round(row.getBoundingClientRect().height) };
      `);
      // The screenshot has to be taken while that page is still on screen;
      // taking them all at the end measures the same page five times.
      const shot = await send('/screenshot', 'GET');
      const sampled = await run(`
        const img = document.createElement('img');
        img.src = 'data:image/png;base64,' + ${JSON.stringify(shot)};
        await new Promise(r => { img.onload = r; img.onerror = r; });
        const c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        const scale = img.naturalWidth / window.innerWidth;
        const box = window.__geo;
        const at = (cssY) => {
          const d = ctx.getImageData(Math.round((box.right - 4) * scale), Math.round(cssY * scale), 1, 1).data;
          return d[0] + ',' + d[1] + ',' + d[2];
        };
        const colours = [];
        for (let dy = 0; dy <= 24; dy++) colours.push(at(box.bottom + dy));
        const edge = colours.findIndex((c, i) => i > 0 && c !== colours[i - 1]);
        return { colours, edgeAt: edge === -1 ? 'no change' : edge };
      `);
      out[page] = Object.assign({}, geo, sampled);
    }
    return out;
  })();
  check('the strip below the row is painted on every page',
    Object.values(painted).every((p) => p.edgeAt >= 14 && p.edgeAt <= 17
      && new Set(p.colours.slice(0, p.edgeAt)).size === 1), painted);
  check('and the modifier leaves the row the size it always was',
    await (async () => {
      const out = {};
      for (const page of ['dashboard', 'spend', 'due', 'savings', 'reports']) {
        out[page] = await run(`
          viewedDate = dueViewedDate = dashViewedDate = new Date(2027, 0, 1);
          currentPage = ${JSON.stringify(page)};
          await renderPage();
          await new Promise(r => setTimeout(r, 600));
          const row = document.querySelector('.page-toolbar--fixed');
          const withIt = Math.round(row.getBoundingClientRect().height);
          // And the same row, measured as a plain toolbar.
          row.classList.remove('page-toolbar--fixed');
          const without = Math.round(row.getBoundingClientRect().height);
          row.classList.add('page-toolbar--fixed');
          return { withIt, without };
        `);
      }
      return Object.values(out).every((p) => p.withIt === p.without);
    })(), painted);

  console.log('\n# desktop: the sidebar rail layout');
  await resize(1200);
  const wide = await run(`
    currentPage = 'dashboard'; await renderPage();
    await new Promise((r) => setTimeout(r, 1200));
    const gaps = [...document.querySelectorAll('.dashboard-grid .stat-card')]
      .map((c) => parseFloat(getComputedStyle(c).paddingTop));
    const toolbar = document.querySelector('.page-toolbar');
    const controls = toolbar ? [...toolbar.children] : [];
    const rights = [...document.querySelectorAll('.item-row')]
      .slice(0, 3).map((r) => Math.round(r.querySelector('.item-actions').getBoundingClientRect().right));
    return {
      width: window.innerWidth,
      padding: gaps[0],
      toolbarRows: controls.filter((c) => c.getBoundingClientRect().top
        < controls[0].getBoundingClientRect().top + 1).length,
      rowEdges: rights,
    };
  `);
  check('the desktop width really is applied', wide.width === 1200, wide);
  check('dashboard, reports and settings all pad their cards 20px', wide.padding === 20, wide);
  check('the sync button is out of the flow, not a flex child', wide.toolbarRows === 1, wide);
  check('values share one right edge on every list page',
    wide.rowEdges.every((r) => r === wide.rowEdges[0]), wide);

  await resize(412);
  console.log('\n# Settings: the People card says what each part is for');
  // The passcode moved into the People card, so the card carries both
  // explanations: what the list is for, and what setting a PIN does.
  const keyNote = await run(`
    const paragraphs = async () => {
      currentPage = 'settings';
      await renderPage();
      await new Promise((r) => setTimeout(r, 600));
      const cards = [...document.querySelectorAll('.report-card')];
      const card = cards.find((c) => /People/.test(c.textContent));
      return [...card.querySelectorAll('p')].map((p) => ({
        text: p.textContent.trim(),
        lines: p.getClientRects().length,
      }));
    };
    await clearAllData();
    const unset = await paragraphs();
    const who = await addItem('people', { name: 'Dee' });
    await setPersonPin(who, '4821');
    setPasscodeEnabled(true);
    const set = await paragraphs();
    setPasscodeEnabled(false);
    return { unset, set };
  `);
  check('the card says what the list is for, including what the pin does',
    keyNote.unset.some((p) => p.text === 'Track who is spending, paying bills and saving. Set a pin per person - this will lock the app and automatically assign them to items.'),
    keyNote.unset);
  check('and it says it once, not twice',
    keyNote.unset.filter((p) => /pin/i.test(p.text)).length === 1, keyNote.unset);
  check('with the whole thing still one line',
    keyNote.unset.every((p) => p.lines === 1), keyNote.unset);

  await resize(412);
  await send('/url', 'POST', { url: `${BASE}?native&cb=${Date.now()}` });
  await sleep(1200);

  console.log('\n# the six fixes from the latest list');
  const fixes = await run(`
    const out = {};
    const t = (label, got, want) => { out[label] = { got: JSON.stringify(got), want: JSON.stringify(want), pass: JSON.stringify(got) === JSON.stringify(want) }; };
    const wipe = () => new Promise((r) => { openDB().then((d) => {
      const ns = [...d.objectStoreNames];
      const tx = d.transaction(ns, 'readwrite');
      ns.forEach((n) => tx.objectStore(n).clear());
      tx.oncomplete = () => r();
    }); });

    // 1. A pre-2.8.3 paid bill is a payment copy in Spend, and it was being
    //    counted as spending on the Spend page and the Dashboard while Reports
    //    (which uses the rule) correctly ignored it.
    await wipe();
    localStorage.clear();
    await loadPeople(); await loadAccounts();
    const acc = await addAccount('Current', 'bank', 2000, null);
    await loadAccounts();
    await addItem('spend', { title: 'Rent', amount: 900, date: '2026-09-03', dueDate: '2026-09-01', paid: true, category: 'Housing', accountId: acc });
    await addItem('spend', { title: 'Tesco', amount: 50, date: '2026-09-04', accountId: acc, category: 'Groceries' });
    await new Promise(r => setTimeout(r, 400));
    viewedDate = new Date(2026, 8, 1);
    currentPage = 'spend';
    await renderPage();
    await new Promise(r => setTimeout(r, 900));
    const card = [...document.querySelectorAll('.stat-card')].find((c) => /Monthly total/i.test(c.textContent));
    t('spendPageExcludesLegacyBill', /£50\\.00/.test(card.textContent) && !/£950/.test(card.textContent), true);
    dashViewedDate = new Date(2026, 8, 1);
    currentPage = 'dashboard';
    await renderPage();
    await new Promise(r => setTimeout(r, 1300));
    const spent = [...document.querySelectorAll('.stat-card')].find((c) => /Spent/.test(c.textContent));
    t('dashboardExcludesLegacyBill', /£50\\.00/.test(spent.textContent) && !/£950/.test(spent.textContent), true);
    // Ordinary spending still counts.
    t('ordinarySpendStillCounts', spent.textContent.indexOf('£50.00') >= 0, true);

    // 2. Monthly total, on both cards, and they agree.
    await wipe();
    await loadPeople(); await loadAccounts();
    await addItem('due', { title: 'Rent', amount: 900, dueDate: '2027-03-01', category: 'Housing', frequency: 'monthly', recurring: true });
    await addItem('due', { title: 'Electric', amount: 120, dueDate: '2027-03-14', category: 'Utilities', frequency: 'monthly', recurring: true });
    const water = await addItem('due', { title: 'Water', amount: 60, dueDate: '2027-03-20', category: 'Utilities' });
    await updateItem('due', { ...(await getAll('due')).find((x) => x.id === water), paid: true });
    await new Promise(r => setTimeout(r, 600));
    dueViewedDate = new Date(2027, 2, 1);
    currentPage = 'due';
    await renderPage();
    await new Promise(r => setTimeout(r, 1500));
    const billsCard = [...document.querySelectorAll('.stat-card')].find((c) => /Total due/i.test(c.textContent));
    // The card's line about this month's bills, with the layout whitespace
    // taken out. Split on newlines rather than a regex, so the suite's own
    // eaten-backslash guard has nothing to complain about.
    const billsLine = (card) => (card.textContent.split(String.fromCharCode(10))
      .map((l) => l.trim())
      .find((l) => l.indexOf('Monthly total') === 0) || '');
    t('billsPageHasTheLine', billsLine(billsCard) === 'Monthly total = £1,080.00', true);
    // And it sits under the main total, before the overdue line.
    t('lineIsUnderTheTotal', billsCard.textContent.indexOf('£1,020.00') < billsCard.textContent.indexOf('Monthly total'), true);
    dashViewedDate = new Date(2027, 2, 1);
    currentPage = 'dashboard';
    await renderPage();
    await new Promise(r => setTimeout(r, 1400));
    const dBills = [...document.querySelectorAll('.stat-card')].find((c) => /^Bills due/.test(c.textContent.trim()));
    t('dashboardHasTheSameLine', billsLine(dBills) === 'Monthly total = £1,080.00', true);

    // 3. Whose defaults to whoever is signed in, on a new account and new
    //    income, and an existing row keeps its own answer.
    await wipe();
    await loadPeople(); await loadAccounts();
    const ada = await addItem('people', { name: 'Ada' });
    const bob = await addItem('people', { name: 'Bob' });
    await loadPeople(); await loadAccounts();
    setCurrentPersonId(ada);
    await openAccountSetup();
    await new Promise(r => setTimeout(r, 600));
    t('newAccountDefaultsToMe', document.getElementById('account-person').value === ada, true);
    const owned = await addAccount('Joint', 'bank', 100, null, bob);
    await loadAccounts();
    await openAccountSetup(owned);
    await new Promise(r => setTimeout(r, 600));
    t('editingKeepsTheStoredPerson', document.getElementById('account-person').value === bob, true);
    await openIncomeSetup();
    await new Promise(r => setTimeout(r, 600));
    t('newIncomeDefaultsToMe', document.getElementById('income-person').value === ada, true);
    closeModal();

    // 4. Reports chips, in order, with This month the default.
    setCurrentPersonId(null);
    currentPage = 'reports';
    reportRange = 'month';
    await renderPage();
    await new Promise(r => setTimeout(r, 1300));
    const chips = [...document.querySelectorAll('.filter-chip')].map((c) => c.textContent.trim());
    t('chipOrder', chips.join('|'), 'This month|This year|All time');
    t('defaultIsThisMonth', (document.querySelector('.filter-chip.active') || {}).textContent, 'This month');

    return { checks: Object.keys(out).length, failures: Object.entries(out).filter(([, v]) => !v.pass).map(([k]) => k), detail: out };
  `);
  check('a pre-2.8.3 paid bill is not spending on the Spend page',
    fixes.detail.spendPageExcludesLegacyBill.pass, fixes.detail);
  check('nor on the Dashboard', fixes.detail.dashboardExcludesLegacyBill.pass, fixes.detail);
  check('and ordinary spending still counts', fixes.detail.ordinarySpendStillCounts.pass, fixes.detail);
  check('both cards show Monthly total, and they agree',
    fixes.detail.billsPageHasTheLine.pass && fixes.detail.dashboardHasTheSameLine.pass, fixes.detail);
  check('the line sits under the total, before the overdue line',
    fixes.detail.lineIsUnderTheTotal.pass, fixes.detail);
  check('a new account and new income default to whoever is signed in',
    fixes.detail.newAccountDefaultsToMe.pass && fixes.detail.newIncomeDefaultsToMe.pass, fixes.detail);
  check('and an existing row keeps its own answer',
    fixes.detail.editingKeepsTheStoredPerson.pass, fixes.detail);
  check('the Reports chips read This month, This year, All time',
    fixes.detail.chipOrder.pass && fixes.detail.defaultIsThisMonth.pass, fixes.detail);
  check('and every one of those passed', fixes.failures.length === 0, fixes.failures);

  console.log('\n# the review fixes: balance, removal, and the month end');
  const more = await run(`
    const out = {};
    const t = (label, got, want) => { out[label] = { got: JSON.stringify(got), want: JSON.stringify(want), pass: JSON.stringify(got) === JSON.stringify(want) }; };
    const wipe = () => new Promise((r) => { openDB().then((d) => {
      const ns = [...d.objectStoreNames];
      const tx = d.transaction(ns, 'readwrite');
      ns.forEach((n) => tx.objectStore(n).clear());
      tx.oncomplete = () => r();
    }); });

    // 1. "Balance now". Typing back the figure the row already shows must not
    //    move it, even though the account still carries an old adjustment from
    //    before that field was removed — saving folds it into the opening.
    await wipe();
    await loadPeople(); await loadAccounts();
    const acc = await addAccount('Test', 'bank', 0, null);
    await updateItem('accounts', { ...(await getItem('accounts', acc)), adjustment: 100 });
    await loadAccounts();
    await addItem('income', { title: 'Wages', amount: 1000, date: '2026-09-01', accountId: acc });
    await addItem('spend', { title: 'Food', amount: 60, date: '2026-09-02', accountId: acc, category: 'Groceries' });
    await new Promise(r => setTimeout(r, 400));
    const before = (await accountBalances()).find((a) => a.id === acc);
    await openAccountSetup(acc);
    await new Promise(r => setTimeout(r, 600));
    t('noAdjustmentField', !!document.getElementById('account-adjustment'), false);
    document.getElementById('account-opening').value = String(before.balance);
    await saveAccount(acc);
    await new Promise(r => setTimeout(r, 1200));
    const after = (await accountBalances()).find((a) => a.id === acc);
    t('typingBackTheShownBalanceChangesNothing', after.balance, before.balance);
    t('andTheOldAdjustmentIsFoldedAway', (await getItem('accounts', acc)).adjustment, 0);
    // A new "Balance now" is honoured on its own.
    await openAccountSetup(acc);
    await new Promise(r => setTimeout(r, 600));
    document.getElementById('account-opening').value = '900';
    await saveAccount(acc);
    await new Promise(r => setTimeout(r, 1200));
    const third = (await accountBalances()).find((a) => a.id === acc);
    t('aNewBalanceNowIsHonoured', third.balance, 900);

    // 2. Removing a person cleans every store that names them, which the
    //    removal dialog promises and the code did not do.
    await wipe();
    await loadPeople(); await loadAccounts();
    const bob = await addItem('people', { name: 'Bob' });
    await loadPeople(); await loadAccounts();
    const joint = await addAccount('Joint', 'bank', 100, null, bob);
    await loadAccounts();
    await addItem('income', { title: 'Wages', amount: 100, date: '2026-09-01', accountId: joint, personId: bob });
    await addItem('spend', { title: 'X', amount: 10, date: '2026-09-02', accountId: joint, personId: bob, category: 'Groceries' });
    await new Promise(r => setTimeout(r, 400));
    await removePerson(bob);
    await new Promise(r => setTimeout(r, 1000));
    t('spendUnattributed', (await getAll('spend'))[0].personId, null);
    t('incomeUnattributed', (await getAll('income'))[0].personId, null);
    t('accountUnattributed', (await getAll('accounts'))[0].personId, null);

    // 3. The 31st stops drifting to the 28th.
    await wipe();
    await loadPeople(); await loadAccounts();
    const rent = await addItem('due', { title: 'Rent', amount: 900, dueDate: '2027-01-31', category: 'Housing', frequency: 'monthly', recurring: true });
    let row = (await getAll('due')).find((x) => x.id === rent);
    const seq = [row.dueDate];
    for (let i = 0; i < 5; i++) {
      await markDuePaid(row);
      await new Promise(r => setTimeout(r, 450));
      row = (await getAll('due')).find((x) => x.title === 'Rent' && x.paid !== true);
      seq.push(row.dueDate);
    }
    t('the31stReturnsAfterAShortMonth', seq.join('|'),
      '2027-01-31|2027-02-28|2027-03-31|2027-04-30|2027-05-31|2027-06-30');
    // And the projections say the same thing from the original row.
    const proj = [];
    for (let m = 1; m <= 5; m++) {
      proj.push(occurrenceInMonth('2027-01-31', 'monthly', new Date(2027, m, 1), null, 31));
    }
    t('projectionsAgree', proj.join('|'),
      '2027-02-28|2027-03-31|2027-04-30|2027-05-31|2027-06-30');
    // A plain monthly bill is unchanged.
    t('plainMonthlyUnchanged', nextDueDate('2027-01-05', 'monthly'), '2027-02-05');
    return { checks: Object.keys(out).length, failures: Object.entries(out).filter(([, v]) => !v.pass).map(([k]) => k), detail: out };
  `);
  check('typing back the balance a row already shows changes nothing',
    more.detail.typingBackTheShownBalanceChangesNothing.pass, more.detail);
  check('the account editor no longer has an Adjustments field',
    more.detail.noAdjustmentField.pass, more.detail);
  check('and a save folds any old adjustment into the balance',
    more.detail.aNewBalanceNowIsHonoured.pass && more.detail.andTheOldAdjustmentIsFoldedAway.pass, more.detail);
  check('removing a person cleans spend, income and accounts',
    more.detail.spendUnattributed.pass && more.detail.incomeUnattributed.pass
    && more.detail.accountUnattributed.pass, more.detail);
  check('a bill on the 31st comes back to the 31st after a short month',
    more.detail.the31stReturnsAfterAShortMonth.pass, more.detail);
  check('and the projections agree with the roll-forward',
    more.detail.projectionsAgree.pass, more.detail);
  check('and every one of those passed', more.failures.length === 0, more.failures);

  console.log('\n# contrast, and a toolbar that has to fit');
  const visual = await run(`
    const out = { ratios: {} };
    const t = (label, got, want) => { out[label] = { got: JSON.stringify(got), want: JSON.stringify(want), pass: JSON.stringify(got) === JSON.stringify(want) }; };
    const lum = (r, g, b) => {
      const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const hx = (h) => { const n = parseInt(String(h || '').replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
    const ratio = (a, b) => { const la = lum(...a), lb = lum(...b); return Math.round(((Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)) * 100) / 100; };
    const tok = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

    // --danger on a card used to be 4.20:1 and AA normal text needs 4.5:1. It
    // is real text: every form error, and the Danger zone heading.
    for (const theme of ['dark', 'light']) {
      document.documentElement.setAttribute('data-theme', theme);
      const card = hx(tok('--bg-card'));
      out.ratios['danger-' + theme] = ratio(hx(tok('--danger')), card);
      t('dangerOnACard-' + theme, out.ratios['danger-' + theme] >= 4.5, true);
      // The quietest grey colours a greyed-out control. Non-text, so 3:1 is the
      // floor; it was 2.15 dark and 2.33 light.
      out.ratios['muted-' + theme] = ratio(hx(tok('--text-muted')), card);
      t('mutedGrey-' + theme, out.ratios['muted-' + theme] >= 3, true);
      out.ratios['secondary-' + theme] = ratio(hx(tok('--text-secondary')), card);
      t('secondaryText-' + theme, out.ratios['secondary-' + theme] >= 4.5, true);
    }
    document.documentElement.setAttribute('data-theme', localStorage.getItem('sorted-theme') || 'dark');

    // And the toolbar at the narrowest width the app claims, where the rail
    // stays in a phone browser. Measured at 360px: the button sits inside its
    // own padding and the document does not scroll sideways. An earlier claim
    // that it wrapped onto two lines and ran 22px past the padding did not
    // reproduce, so this is the record of it having been measured rather than
    // assumed.
    await new Promise((resolve) => { openDB().then((d) => {
      const ns = [...d.objectStoreNames];
      const tx = d.transaction(ns, 'readwrite');
      ns.forEach((n) => tx.objectStore(n).clear());
      tx.oncomplete = () => resolve();
    }); });
    await loadPeople(); await loadAccounts();
    for (const page of ['spend', 'due']) {
      currentPage = page;
      await renderPage();
      await new Promise(r => setTimeout(r, 800));
      const toolbar = document.querySelector('.page-toolbar--fixed');
      const btn = toolbar && toolbar.querySelector('.btn-primary');
      const content = document.querySelector('.content').getBoundingClientRect();
      out.toolbar = out.toolbar || {};
      out.toolbar[page] = { buttonRight: btn && Math.round(btn.getBoundingClientRect().right), contentRight: Math.round(content.right) };
      t('toolbarAt360-' + page,
        !!btn && btn.getBoundingClientRect().right <= content.right
        && document.documentElement.scrollWidth <= window.innerWidth, true);
    }
    return { checks: Object.keys(out).length, failures: Object.entries(out).filter(([, v]) => v && v.pass === false).map(([k]) => k), detail: out, ratios: out.ratios };
  `);
  check('text on a card clears AA in both themes',
    visual.detail['dangerOnACard-dark'].pass && visual.detail['dangerOnACard-light'].pass, visual.detail);
  check('the quietest grey clears 3:1 on a card',
    visual.detail['mutedGrey-dark'].pass && visual.detail['mutedGrey-light'].pass, visual.detail);
  check('secondary text clears AA in both themes',
    visual.detail['secondaryText-dark'].pass && visual.detail['secondaryText-light'].pass, visual.detail);
  check('the toolbar fits at 360px in a browser',
    visual.detail['toolbarAt360-spend'].pass && visual.detail['toolbarAt360-due'].pass, visual.detail);
  check('and every one of those passed', visual.failures.length === 0, visual.failures);

  console.log('\n# a date-only string is a local day');
  const dates = await run(`
    const out = {};
    const t = (label, got, want) => { out[label] = { got: JSON.stringify(got), want: JSON.stringify(want), pass: JSON.stringify(got) === JSON.stringify(want) }; };
    // The property that matters, stated so it holds in any zone: a date-only
    // string parsed by the app is midnight *local* on the day it names, which is
    // midnight UTC only inside one timezone. The whole point of parseDateOnly is
    // that it constructs the Date from parts, so this is true everywhere.
    t('midnightLocal', parseDateOnly('2026-10-01').getTime(), new Date(2026, 9, 1).getTime());
    t('lastDayOfAMonth', parseDateOnly('2026-01-31').getDate(), 31);
    t('acrossFebruary', parseDateOnly('2026-03-01').getMonth(), 2);
    // The helpers that take a string agree with that.
    t('sameMonthUsesLocalFraming',
      isSameMonth('2026-10-01', new Date(2026, 9, 15)) && !isSameMonth('2026-10-01', new Date(2026, 8, 15)),
      true);
    t('sameYearUsesLocalFraming',
      isSameYear('2026-10-01', new Date(2026, 0, 1)) && !isSameYear('2026-10-01', new Date(2025, 0, 1)),
      true);
    t('aMonthEndIsNotTheMonthBefore', isThisMonth(localISO()), true);
    // daysUntil counts calendar days, so it does not read yesterday as today on
    // the day the clocks move.
    t('daysUntilIsCalendarDays', daysUntil(localISO()), 0);
    t('daysUntilYesterday', daysUntil(localISO(new Date(Date.now() - 86400000))), -1);
    // A datetime string is still an instant, not a day.
    t('aTimestampStaysAnInstant', parseDateOnly('2026-10-01T12:00:00').getHours(), 12);
    // A junk string comes back null rather than an Invalid Date that poisons
    // every comparison downstream.
    t('junkComesBackNull', parseDateOnly('not a date'), null);
    t('emptyComesBackNull', parseDateOnly(''), null);
    // And the lozenge reads the local day.
    t('theLozengeReadsTheLocalDay',
      repeatLabel({ frequency: 'monthly', repeatUntil: '2027-01-31' }), 'Monthly · until 31 Jan 27');
    return { checks: Object.keys(out).length, failures: Object.entries(out).filter(([, v]) => !v.pass).map(([k]) => k), detail: out };
  `);
  check('a date-only string is parsed as the local day it names',
    dates.detail.midnightLocal.pass, dates.detail);
  check('and the month-end and month-start cases agree',
    dates.detail.lastDayOfAMonth.pass && dates.detail.acrossFebruary.pass, dates.detail);
  check('the helpers use that framing',
    dates.detail.sameMonthUsesLocalFraming.pass && dates.detail.sameYearUsesLocalFraming.pass, dates.detail);
  check('daysUntil counts calendar days, so yesterday is not today',
    dates.detail.daysUntilIsCalendarDays.pass && dates.detail.daysUntilYesterday.pass, dates.detail);
  check('a timestamp stays an instant, and junk comes back null',
    dates.detail.aTimestampStaysAnInstant.pass && dates.detail.junkComesBackNull.pass
    && dates.detail.emptyComesBackNull.pass, dates.detail);
  check('and every one of those passed', dates.failures.length === 0, dates.failures);

  {
  // A section of its own block: these checks declare a lot of
  // locals with ordinary names (rows, text, json, low, short), and a
  // redeclaration anywhere in runSuite is a syntax error.
    console.log('\n# forecast arithmetic: identities, not hand-worked answers');

      // ---------------------------------------------------------------
      // Forecast arithmetic, checked against identities rather than
      // against hand-worked answers.
      //
      // A forecast is a chain of additions, and a chain is easy to get
      // subtly wrong: one day counted twice, one month-to-date total not
      // reset, one signed term the wrong way round. Each of these asserts
      // a relationship that must hold on any data, so it cannot be
      // satisfied by a fixture that merely looks right.
      //
      // The figures are deliberately round, and no item is tied to an
      // account, so the account balance and the recorded history move
      // independently and the arithmetic stays readable.
      // Everything the suite touches is inside a run() block: the outer level of
      // the suite is Node, and a page function called there is not a page
      // function. So the fixture is seeded in one block and read back in the
      // rest, with the account's id parked on window because the id is the only
      // thing a later block needs from here.
      const exportSeeded = await run(`
        const wiper = () => new Promise((resolve) => { openDB().then((d) => {
          const ns = [...d.objectStoreNames];
          const tx = d.transaction(ns, 'readwrite');
          ns.forEach((n) => tx.objectStore(n).clear());
          tx.oncomplete = () => resolve();
        }); });
        await wiper();
        await loadPeople(); await loadAccounts();
        const iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
          + '-' + String(d.getDate()).padStart(2, '0');
        const inMonth = (offset, day) => {
          const d = new Date(new Date().getFullYear(), new Date().getMonth() + offset, 1);
          d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
          return iso(d);
        };
        // Account holds the money. opening is the field an account actually
        // stores — the balance is derived from it, so writing balance here
        // would be writing a number the app throws away.
        const acc = await addItem('accounts', { name: 'Current', type: 'bank', opening: 2000 });
        // Salary: £1,000 on the 1st of every month from three months back, so this
        // month's income is recorded and the coming ones are projections.
        await addItem('income', {
          title: 'Salary', amount: 1000, date: inMonth(-3, 1),
          frequency: 'monthly', recurring: true
        });
        // Rent: £600 on the 3rd, recurring, also from three months back.
        await addItem('due', {
          title: 'Rent', amount: 600, dueDate: inMonth(-3, 3),
          category: 'Housing', frequency: 'monthly', recurring: true
        });
        // A one-off bill in the future, so the planned-bills map holds something
        // that is not a projection of a stored bill.
        await addItem('due', {
          title: 'Car tax', amount: 250, dueDate: inMonth(2, 10),
          category: 'Transport', frequency: 'once', recurring: false
        });
        // Variable spending of £300 across the two months before this one, so the
        // completed total is £300 over two months.
        for (const [offset, day, amount] of [[-2, 5, 150], [-2, 20, 50], [-1, 8, 100]]) {
          await addItem('spend', { title: 'Shopping', amount, date: inMonth(offset, day), category: 'Groceries' });
        }
        await new Promise((r) => setTimeout(r, 400));
        window.__fcAccount = acc;
        return acc;
      `);
      check('the forecast fixture is seeded', typeof exportSeeded === 'string' && exportSeeded.length > 0, exportSeeded);

      // 1. The day-by-day balance is a running sum of that day's own terms.
      //
      //    Note which terms are which: income and savings are running totals
      //    across the whole window, while bills and spend are month to date. The
      //    difference is deliberate — a cumulative spend line said "you have
      //    spent £21,000" by August — but it means the identity needs the deltas
      //    of the cumulative two. Getting this wrong is exactly the kind of
      //    mistake the check exists for.
      const chain = await run(`
        const f = await buildForecast(6, 0);
        const bad = [];
        let prevBalance = null, prevIncome = null, prevSavings = null;
        let prevBillsMtd = 0, prevSpendMtd = 0, prevMonth = null;
        for (const p of f.series) {
          // All four row fields are running figures, not daily ones: income and
          // savings climb all window, bills and spend are month to date. The day's
          // own amount for the month-to-date two is the difference from the
          // previous day -- except at a month boundary, where the total restarts
          // and the difference belongs to a month that has ended.
          const key = p.d.getFullYear() + '-' + p.d.getMonth();
          const fresh = key !== prevMonth;
          const dailyBills = fresh ? p.bills : p.bills - prevBillsMtd;
          const dailySpend = fresh ? p.spend : p.spend - prevSpendMtd;
          let expected = p.balance;
          if (prevBalance !== null) {
            expected = prevBalance
              + (p.income - prevIncome)
              - (p.savings - prevSavings)
              - dailyBills
              - dailySpend;
          }
          if (Math.abs(expected - p.balance) > 0.005) {
            bad.push({ date: p.date, got: p.balance, want: expected });
          }
          prevBalance = p.balance; prevIncome = p.income; prevSavings = p.savings;
          prevBillsMtd = p.bills; prevSpendMtd = p.spend; prevMonth = key;
        }
        return {
          days: f.series.length, bad,
          incomeIsCumulative: f.series.every((p, i, a) => i === 0 || p.income >= a[i - 1].income),
          savingsIsCumulative: f.series.every((p, i, a) => i === 0 || p.savings >= a[i - 1].savings)
        };
      `);
      check('every day is the day before it, plus that day\'s own terms', chain.bad.length === 0, chain);
      check('and the two cumulative totals really do climb: income, then savings',
        chain.incomeIsCumulative && chain.savingsIsCumulative, chain);
      check('and the window covers six whole months',
        chain.days >= 180 && chain.days <= 184, { days: chain.days });

      // 2. Costs are the month-to-date bills plus the month-to-date spend, on
      //    every row — not only the first.
      const costs = await run(`
        const f = await buildForecast(6, 0);
        return {
          rows: f.series.length,
          bad: f.series.filter((p) => Math.abs((p.bills + p.spend) - p.costs) > 0.005).map((p) => p.date)
        };
      `);
      check('Total est costs is bills plus spend on every day of the window', costs.bad.length === 0, costs);

      // 3. Month to date really does reset. A total that climbed all window
      //    reported "you have spent £21,000" by August, which is not a comparison
      //    of anything.
      const mtd = await run(`
        const f = await buildForecast(6, 0);
        const firsts = f.series.filter((p) => p.d.getDate() === 1);
        const cases = [];
        for (const first of firsts) {
          const sameMonth = f.series.filter((p) => p.d.getMonth() === first.d.getMonth()
            && p.d.getFullYear() === first.d.getFullYear());
          const last = sameMonth[sameMonth.length - 1];
          cases.push({ month: first.date, onFirst: first.spend, onLast: last.spend, reset: last.spend > first.spend });
        }
        return { firsts: firsts.length, cases };
      `);
      check('month-to-date totals restart at nothing on the 1st',
        mtd.cases.length === 6 && mtd.cases.every((c) => c.reset), mtd);
      check('and every month in the window is checked, not just the first',
        mtd.cases.length === 6, mtd);

      // 4. low is the lowest *projected* balance. A dip in the history must not
      //    win, and a day already past must not be picked.
      const low = await run(`
        const f = await buildForecast(6, 0);
        const ahead = f.series.filter((p) => !p.actual);
        const min = ahead.reduce((a, b) => (b.balance < a.balance ? b : a), ahead[0]);
        return {
          agrees: f.low && Math.abs(f.low.balance - min.balance) < 0.005,
          isProjected: f.low && f.low.actual === false,
          noHistory: f.series.every((p) => !p.actual || p.balance >= f.low.balance - 0.005)
        };
      `);
      check('the low point is the lowest projected balance, and it is a projection',
        low.agrees && low.isProjected, low);
      check('the low point is not a day in the past', low.noHistory, low);

      // 5. short is only ever reported when the low is actually below zero, and
      //    with money to spare the money does not get tight.
      const short = await run(`
        const poor = await buildForecast(6, 0);
        const accounts = await getAll('accounts');
        const a = accounts.find((x) => x.type === 'bank');
        // £40,000: several months of £1,600 net. "opening" is the field an
        // account actually stores, so that is the one to write.
        await updateItem('accounts', Object.assign({}, a, { opening: 40000, adjustment: 0 }));

        await new Promise((r) => setTimeout(r, 250));
        const rich = await buildForecast(6, 0);
        return {
          poorShort: poor.short && poor.short.balance,
          richShort: rich.short && rich.short.balance,
          richLow: rich.low && rich.low.balance,
          richRunsOut: rich.runsOut
        };
      `);
      check('a shortfall is reported only when the low is below zero',
        !short.richShort && short.richLow > 0, short);
      check('and with money to spare, the money does not get tight',
        !short.richRunsOut || short.richRunsOut.runsOut === false, short);

      // 6. The window is a way of looking, not a fact: the run-out figure is
      //    over twelve months whatever window is on screen, so lengthening the
      //    graph does not answer a different question each time.
      const windowed = await run(`
        const out = {};
        for (const m of [1, 3, 6, 12]) {
          const f = await buildForecast(m, 0);
          out[m] = { total: f.series.length };
        }
        const one = await buildForecast(1, 0);
        const twelve = await buildForecast(12, 0);
        return { per: out, sameFigure: JSON.stringify(one.runsOut) === JSON.stringify(twelve.runsOut) };
      `);
      check('the run-out figure is the same whatever window is on screen',
        windowed.sameFigure, windowed);
      check('and the window length is the length of the grid',
        windowed.per[1].total < windowed.per[12].total
        && windowed.per[12].total >= 360, windowed.per);

      // 7. The average that drives the daily rate, checked against its own stated
      //    rule rather than a round number: completed months in full, plus the
      //    month in progress by the share of it that has happened. An empty month
      //    in progress therefore votes as a fraction of a month spent at nought,
      //    which is what makes the figure move as spending moves without a single
      //    day being able to swing a whole month.
      const avg = await run(`
        const items = (await getAll('spend')).filter((i) => i.paid !== true);
        const plain = await averageNonRecurringSpend(items);
        const withPaid = items.concat([{ title: 'Rent', amount: 600, date: localISO(), paid: true }]);
        const paidAvg = await averageNonRecurringSpend(withPaid);
        const todayItems = items.concat([{ title: 'Coffee', amount: 30, date: localISO() }]);
        const movedAvg = await averageNonRecurringSpend(todayItems);
        const now = new Date();
        const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        const elapsed = Math.max(1, now.getDate());
        const daysInThisMonth = dim;
        const months = 2 + elapsed / daysInThisMonth;
        const want = 300 / months;
        // And the same rule applied by hand to a month that is not the live one:
        // six whole months at £100 is £100, with nothing from the live month at
        // all beyond its own elapsed share of nought.
        const six = [];
        for (let k = 1; k <= 6; k++) {
          const d = new Date(now.getFullYear(), now.getMonth() - k, 15);
          const s = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
            + '-' + String(d.getDate()).padStart(2, '0');
          six.push({ amount: 100, date: s, paid: false });
        }
        const wholeOnly = await averageNonRecurringSpend(six);
        const daysInSixMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        const elapsedSix = Math.max(1, now.getDate());
        const wantSix = 600 / (6 + elapsedSix / daysInSixMonth);
        return { plain, paidAvg, movedAvg, want, wantSix, wholeOnly };
      `);
      check('the average is completed months plus the live month by its elapsed share',
        Math.abs(avg.plain - avg.want) < 0.01, { plain: avg.plain, want: avg.want });
      check('and a paid bill left in Spend is not counted as spending',
        Math.abs(avg.paidAvg - avg.want) < 0.01, { paidAvg: avg.paidAvg, want: avg.want });
      check('and spending logged today moves the average',
        avg.movedAvg > avg.plain + 0.01, { plain: avg.plain, moved: avg.movedAvg });
      check('and a month that is not the live one follows the same rule',
        Math.abs(avg.wholeOnly - avg.wantSix) < 0.01, { got: avg.wholeOnly, want: avg.wantSix });

      // 8. Money in a jar has left your available balance — once, by whichever
      //    route. A goal tied to an account is already out of that account's
      //    balance; a goal with no account never was, and used to count as
      //    spendable from money sitting in the jar.
      const setAside = await run(`
        const base = await buildForecast(6, 0);
        const start = base.series[0].balance;
        const jar = await addItem('savings', { title: 'Holiday', target: 1000, current: 200, monthly: 50 });
        await new Promise((r) => setTimeout(r, 250));
        const withJar = await buildForecast(6, 0);
        const afterJar = withJar.series[0].balance;
        const backed = await addItem('savings', {
          title: 'House', target: 9000, current: 100, monthly: 100, accountId: window.__fcAccount
        });
        await new Promise((r) => setTimeout(r, 250));
        const withBoth = await buildForecast(6, 0);
        return {
          start, afterJar, afterBoth: withBoth.series[0].balance,
          opening: withBoth.opening,
          accountId: window.__fcAccount
        };
      `);
      check('an unbacked jar takes its money off the starting balance',
        Math.abs(setAside.afterJar - (setAside.start - 200)) < 0.01, setAside);
      check('a goal tied to an account is already out of it, and is not taken off twice',
        Math.abs(setAside.afterBoth - (setAside.afterJar - 100)) < 0.01, setAside);
      check('and opening is the account total, with the backed goal already out of it',
        Math.abs(setAside.opening - (setAside.start - 100)) < 0.01, setAside);

      // 9. A goal with no monthly figure contributes nothing, rather than a rate
      //    nobody decided on.
      const goalPlan = await run(`
        const bare = await addItem('savings', { title: 'Bare', target: 100, current: 0 });
        await new Promise((r) => setTimeout(r, 250));
        const f = await buildForecast(6, 0);
        return { monthlyOfBare: goalMonthlyContribution(bare) };
      `);
      check('a goal with no monthly figure plans nothing',
        goalPlan.monthlyOfBare === 0, goalPlan);

      // 10. The window starts where the data does. Stepping back on a young
      //      database used to draw a line anyway, produced by a walk-back that
      //      adds back bills and income it can see and subtracts spend it can't —
      //      a smooth plausible curve that is entirely fiction.
      const windowStart = await run(`
        const first = earliestRecordedDate(
          [{ date: '2026-01-05', amount: 1 }],
          [{ dueDate: '2025-12-01', amount: 1 }],
          [{ date: '2026-03-02', amount: 1 }]
        );
        const none = earliestRecordedDate([], [], []);
        const junk = earliestRecordedDate([{ date: 'not a date' }], [], []);
        const span = forecastDayList(12, 0);
        return {
          // earliestRecordedDate answers a Date, so the ISO is formed here
          // where localISO is in scope. Forming it out there was the bug: the
          // suite's outer level is Node, and has no page functions to call.
          firstISO: first ? localISO(first) : null,
          none, junk,
          spanDays: span.days.length,
          spanStart: localISO(span.start),
          wholeMonths: span.days.filter((d) => d.getDate() === 1).length
        };
      `);
      check('the earliest record is the earliest across every store',
        windowStart.firstISO === '2025-12-01', windowStart);
      check('and an empty database has no earliest record to start from',
        windowStart.none === null, windowStart);
      check('and a junk date is skipped rather than poisoning the window',
        windowStart.junk === null, windowStart);

      // 11. Stepping back shows history, not a forecast of it: a recurring bill
      //      paid last month has had its stored date rolled forward, and counting
      //      it again as a projection would pay it twice.
      const stepBack = await run(`
        const f = await buildForecast(6, 3);
        const historyRows = f.series.filter((p) => p.actual).length;
        const projectedRows = f.series.filter((p) => !p.actual).length;
        const firstIsPast = f.series.length > 0 && f.series[0].date < localISO();
        // Bounded at twelve months back: beyond that the reconstruction is
        // guesswork dressed as history.
        for (let i = 0; i < 20; i++) stepForecastMonth(1);
        const clamped = forecastOffset;
        for (let i = 0; i < 5; i++) stepForecastMonth(-1);
        const pulledForward = forecastOffset;
        resetForecastWindow();
        const afterReset = forecastOffset;
        return { historyRows, projectedRows, firstIsPast, clamped, pulledForward, afterReset };
      `);
      check('stepping back shows recorded days as history and the rest as projection',
        stepBack.historyRows > 0 && stepBack.projectedRows > 0 && stepBack.firstIsPast, stepBack);
      check('and every day of the grid is one or the other',
        stepBack.historyRows > 0 && stepBack.projectedRows > 0
        && stepBack.historyRows + stepBack.projectedRows >= 180, stepBack);
      check('and stepping back is bounded at twelve months',
        stepBack.clamped === 12, stepBack);
      // Twenty steps back, five forward: the bound holds at the top, and the
      // arrows move one month each rather than jumping to an edge.
      check('and stepping forward again comes back a month at a time',
        stepBack.pulledForward === 7 && stepBack.afterReset === 0, stepBack);
      check('and reset returns to the present',
        stepBack.afterReset === 0, stepBack);

    console.log('\n# sync: the stamp, the stash, and the decision tree');

      // ---------------------------------------------------------------
      // Sync. The whole thing is a timestamp comparison and a replace,
      // and both halves have failure modes that lose data silently: a
      // stamp that is "when built" rather than "when changed" pushes
      // forever and never notices it can pull, and a merge instead of a
      // replace resurrects rows the user deliberately deleted.
      //
      // The transport is stubbed in the page rather than served from a
      // real host, so the decision tree is exercised end to end and the
      // only thing not under test is the HTTP layer itself. window is
      // global, so the stub survives across run() blocks.
      // A plain string, so it can live out here; everything else in this section
      // is page work and has to go through run().
      const SYNC_URL = 'http://sync.test/sorted-snapshot.json';

      await run(`
        // A clean slate, and the stub itself. Both live in this one block because
        // the stub has to be installed before anything calls the transport, and
        // the transport stub is what the whole section is about.
        const wiper = () => new Promise((resolve) => { openDB().then((d) => {
          const ns = [...d.objectStoreNames];
          const tx = d.transaction(ns, 'readwrite');
          ns.forEach((n) => tx.objectStore(n).clear());
          tx.oncomplete = () => resolve();
        }); });
        await wiper();
        await loadPeople(); await loadAccounts();
        window.__syncCalls = [];
        window.__syncFile = null;
        window.fetch = async (url, options) => {
          window.__syncCalls.push({
            method: (options && options.method) || 'GET',
            url: String(url),
            body: (options && options.body) || null
          });
          if ((options && options.method) === 'GET') {
            if (window.__syncFile === null) return { ok: false, status: 404, text: async () => '' };
            return { ok: true, status: 200, text: async () => window.__syncFile };
          }
          window.__syncFile = options.body;
          return { ok: true, status: 200, text: async () => '' };
        };
        return true;
      `);

      // 1. The snapshot itself, and what isSyncSnapshot refuses.
      const snap = await run(`
        const out = {};
        const t = (label, got, want) => { out[label] = { got: JSON.stringify(got), want: JSON.stringify(want), pass: JSON.stringify(got) === JSON.stringify(want) }; };
        window.__syncCalls.length = 0;
        const local = await buildSyncSnapshot();
        t('formatMatches', local.format, 1);
        t('dataIsAnObjectNotAnArray', !!local.data && !Array.isArray(local.data), true);
        t('countsCoverEveryStore', Object.keys(local.counts).length >= 8, true);
        t('stampIsAString', typeof local.updatedAt, 'string');
        t('deviceIdIsStable', local.deviceId, syncDeviceId());
        const a = await buildSyncSnapshot();
        await new Promise((r) => setTimeout(r, 40));
        const b = await buildSyncSnapshot();
        // The whole of whether sync can work: stamping with the build time makes
        // a fresh snapshot newer on every pass, so it pushes forever and can
        // never notice it has nothing to send, nor ever pull.
        t('buildingItTwiceIsNotNewer', a.updatedAt === b.updatedAt, true);
        // A stash is the same shape, so restore accepts it rather than refusing
        // it as "not a Sorted snapshot" — which would read as data gone twice.
        const stashed = await buildReplacedCopy();
        t('aStashedCopyIsAValidSnapshot', isSyncSnapshot(stashed), true);

        // Validation. Every one of these is reachable from a real file: someone
        // hand-editing the snapshot is the ordinary way this breaks.
        t('nullIsNotASnapshot', isSyncSnapshot(null), false);
        t('anArrayIsNotASnapshot', isSyncSnapshot([]), false);
        t('aStringIsNotASnapshot', isSyncSnapshot('{"format":1}'), false);
        t('aWrongFormatIsNotASnapshot', isSyncSnapshot({ format: 99, data: {}, updatedAt: 'x' }), false);
        t('noDataIsNotASnapshot', !!isSyncSnapshot({ format: 1, updatedAt: 'x' }), false);
        t('anArrayOfDataIsNotASnapshot', isSyncSnapshot({ format: 1, data: [], updatedAt: 'x' }), false);
        t('noStampIsNotASnapshot', isSyncSnapshot({ format: 1, data: {} }), false);
        t('aNumberStampIsNotASnapshot', isSyncSnapshot({ format: 1, data: {}, updatedAt: 12345 }), false);
        // And a corrupt stamp is older, so a bad timestamp is never a reason to
        // overwrite the local copy.
        t('aCorruptStampIsOlder', syncStamp({ updatedAt: 'not a date' }), 0);
        t('aMissingStampIsOlder', syncStamp({}), 0);
        t('aRealStampIsItsOwnTime',
          syncStamp({ updatedAt: '2026-01-01T00:00:00.000Z' }), Date.parse('2026-01-01T00:00:00.000Z'));
        return { checks: Object.keys(out).length, failures: Object.entries(out).filter(([, v]) => !v.pass).map(([k]) => k), detail: out };
      `);
      check('a snapshot carries an envelope, a count and a stamp',
        snap.detail.formatMatches.pass && snap.detail.dataIsAnObjectNotAnArray.pass
        && snap.detail.countsCoverEveryStore.pass && snap.detail.stampIsAString.pass, snap);
      check('and building it twice does not make it newer — the whole point of the stamp',
        snap.detail.buildingItTwiceIsNotNewer.pass, snap);
      check('a stashed copy is a valid snapshot, so restore accepts it',
        snap.detail.aStashedCopyIsAValidSnapshot.pass, snap);
      check('everything that is not a snapshot is refused for a reason',
        snap.detail.nullIsNotASnapshot.pass && snap.detail.anArrayIsNotASnapshot.pass
        && snap.detail.aStringIsNotASnapshot.pass && snap.detail.aWrongFormatIsNotASnapshot.pass
        && snap.detail.noDataIsNotASnapshot.pass && snap.detail.anArrayOfDataIsNotASnapshot.pass
        && snap.detail.noStampIsNotASnapshot.pass && snap.detail.aNumberStampIsNotASnapshot.pass, snap);
      check('and an unreadable stamp is never a reason to overwrite the local copy',
        snap.detail.aCorruptStampIsOlder.pass && snap.detail.aMissingStampIsOlder.pass
        && snap.detail.aRealStampIsItsOwnTime.pass, snap);

      // 2. A change to the data moves the stamp. A deletion is the awkward case:
      //    removing the newest bill leaves every surviving record untouched, so
      //    without a write recording a stamp of its own the deletion would never
      //    travel.
      const stamp = await run(`
        const out = {};
        const t = (label, got, want) => { out[label] = { got: JSON.stringify(got), want: JSON.stringify(want), pass: JSON.stringify(got) === JSON.stringify(want) }; };
        const before = (await buildSyncSnapshot()).updatedAt;
        const id = await addItem('spend', { title: 'Stamp me', amount: 7, date: localISO(), category: 'Groceries' });
        await new Promise((r) => setTimeout(r, 60));
        const afterAdd = (await buildSyncSnapshot()).updatedAt;
        // Now delete it again. The surviving rows are unchanged, so their own
        // timestamps alone would say nothing happened at all.
        const rows = await getAll('spend');
        const theRow = rows.find((r) => r.title === 'Stamp me');
        await deleteItem('spend', theRow.id);
        await new Promise((r) => setTimeout(r, 60));
        const afterDelete = (await buildSyncSnapshot()).updatedAt;
        t('addingMovesTheStamp', afterAdd > before, true);
        t('deletingMovesTheStamp', afterDelete > afterAdd, true);
        return { checks: Object.keys(out).length, failures: Object.entries(out).filter(([, v]) => !v.pass).map(([k]) => k), detail: out };
      `);
      check('adding a row moves the stamp', stamp.detail.addingMovesTheStamp.pass, stamp);
      check('and deleting one does too — otherwise a deletion never travels',
        stamp.detail.deletingMovesTheStamp.pass, stamp);

      // 3. The decision tree. Each branch reports what it did rather than
      //    throwing on the ordinary outcomes, because "already up to date" is a
      //    result and not a failure.
      const tree = await run(`
        const out = {};
        const t = (label, got, want) => { out[label] = { got: JSON.stringify(got), want: JSON.stringify(want), pass: JSON.stringify(got) === JSON.stringify(want) }; };
        const url = 'http://sync.test/sorted-snapshot.json';
        window.__syncCalls.length = 0;
        window.__syncFile = null;

        // (a) Nothing on the host: the first pass creates it.
        setSyncSettings({ url: url, transport: 'lan' });
        const created = await syncNow();
        t('firstPassCreates', created.did, 'created');
        t('firstPassPutTheFile', window.__syncFile !== null, true);
        t('firstPassReadFirst', window.__syncCalls[0] && window.__syncCalls[0].method, 'GET');

        // (b) Nothing has changed since: it says so, and puts nothing.
        window.__syncCalls.length = 0;
        const nothing = await syncNow();
        t('anUnchangedPassSaysNone', nothing.did, 'none');
        t('anUnchangedPassPutsNothing',
          window.__syncCalls.filter((c) => c.method === 'PUT').length, 0);

        // (c) A local change pushes.
        await addItem('spend', { title: 'Pushed', amount: 11, date: localISO(), category: 'Groceries' });
        window.__syncCalls.length = 0;
        const pushed = await syncNow();
        t('alocalChangePushes', pushed.did, 'pushed');
        t('thePushPutTheFile',
          JSON.parse(window.__syncFile).data.spend.some((r) => r.title === 'Pushed'), true);

        // (d) A newer file pulls, and replaces rather than merging.
        const remoteData = {
          spend: [{ id: 'fromthefile', title: 'From the file', amount: 99, date: '2026-09-02', category: 'Groceries' }]
        };
        window.__syncFile = JSON.stringify({ format: 1, deviceId: 'other', updatedAt: new Date(Date.now() + 3600000).toISOString(), data: remoteData });
        window.__syncCalls.length = 0;
        const pulled = await syncNow();
        const titles = (await getAll('spend')).map((r) => r.title);
        t('anewerFilePulls', pulled.did, 'pulled');
        t('apullReplacesRatherThanMerging',
          titles.indexOf('From the file') >= 0 && titles.indexOf('Pushed') < 0, true);

        // (e) A pull is not a local change. Without the guard the very next pass
        //     would want to push the file it just came from straight back.
        const afterPull = (await buildSyncSnapshot()).updatedAt;
        const remoteStamp = JSON.parse(window.__syncFile).updatedAt;
        t('apullDoesNotMarkTheLocalCopyNewer', afterPull === remoteStamp, true);

        return { checks: Object.keys(out).length, failures: Object.entries(out).filter(([, v]) => !v.pass).map(([k]) => k), detail: out };
      `);
      check('the first pass creates the file', tree.detail.firstPassCreates.pass, tree);
      check('and an unchanged pass says so and puts nothing — this is what stops it pushing forever',
        tree.detail.anUnchangedPassSaysNone.pass && tree.detail.anUnchangedPassPutsNothing.pass, tree);
      check('a local change pushes', tree.detail.alocalChangePushes.pass, tree);
      check('a newer file pulls', tree.detail.anewerFilePulls.pass, tree);
      check('and a pull replaces rather than merging, so a deleted row stays deleted',
        tree.detail.apullReplacesRatherThanMerging.pass, tree);
      check('and a pull is not a local change, so it does not push straight back',
        tree.detail.apullDoesNotMarkTheLocalCopyNewer.pass, tree);

      // 4. The stash. Both paths that wipe the data go through it — a pull, and
      //    the user's own Replace-all button — because the alternative is a
      //    database with no way back.
      const stash = await run(`
        const wipe = () => new Promise((resolve) => { openDB().then((d) => {
          const ns = [...d.objectStoreNames];
          const tx = d.transaction(ns, 'readwrite');
          ns.forEach((n) => tx.objectStore(n).clear());
          tx.oncomplete = () => resolve();
        }); });
        const out = {};
        const t = (label, got, want) => { out[label] = { got: JSON.stringify(got), want: JSON.stringify(want), pass: JSON.stringify(got) === JSON.stringify(want) }; };
        await wipe();
        await loadPeople(); await loadAccounts();
        await addItem('spend', { title: 'Mine to keep', amount: 42, date: '2026-09-01', category: 'Groceries' });
        await new Promise((r) => setTimeout(r, 300));
        // A pull that replaces the local data.
        window.__syncFile = JSON.stringify({
          format: 1,
          deviceId: 'other',
          updatedAt: new Date(Date.now() + 3600000).toISOString(),
          data: { spend: [{ title: 'Theirs', amount: 5, date: '2026-09-02', category: 'Groceries' }] }
        });
        setSyncSettings({ url: 'http://sync.test/sorted-snapshot.json', transport: 'lan' });
        const pulled = await syncNow();
        const afterPull = (await getAll('spend')).map((r) => r.title);
        t('thePullHappened', pulled.did, 'pulled');
        t('theLocalCopyIsGone', afterPull.indexOf('Mine to keep') < 0, true);
        t('aBackupWasKept', !!syncBackup(), true);
        const restored = await restoreSyncBackup();
        const afterRestore = (await getAll('spend')).map((r) => r.title);
        t('restoreBringsItBack', afterRestore.indexOf('Mine to keep') >= 0, true);
        t('restoreSucceeded', !!(restored && restored.ok), true);
        // The backup is spent: offering the same rows twice is worse than useless.
        t('restoreClearsTheBackup', syncBackup() === null, true);
        // And a stash that cannot be written — a full localStorage — must never
        // stop the import that called it. The user's data is replaced either
        // way; a silently dropped backup is the lesser failure.
        const stashedOk = stashReplacedCopy(await buildSyncSnapshot());
        t('aStashThatFitsSucceeds', stashedOk, true);
        const realSet = Storage.prototype.setItem;
        Storage.prototype.setItem = function () { throw new Error('quota'); };
        const stashedFailed = stashReplacedCopy(await buildSyncSnapshot());
        Storage.prototype.setItem = realSet;
        t('aStashThatCannotBeWrittenReportsItAndCarriesOn', stashedFailed, false);
        // And a corrupt backup is refused rather than half-applied.
        localStorage.setItem('sorted-sync-backup', '{not json');
        t('aCorruptBackupIsRefused', syncBackup(), null);
        localStorage.setItem('sorted-sync-backup', JSON.stringify({ format: 99, data: {} }));
        t('AWrongFormatBackupIsRefused', syncBackup().format, 99);
        const refused = await restoreSyncBackup();
        t('AndRefusedToRestoreIt', !!refused && refused.ok === false, true);
        return { checks: Object.keys(out).length, failures: Object.entries(out).filter(([, v]) => !v.pass).map(([k]) => k), detail: out };
      `);
      check('a pull keeps a backup before it replaces anything',
        stash.detail.aBackupWasKept.pass && stash.detail.theLocalCopyIsGone.pass, stash);
      check('and restore brings the local copy back',
        stash.detail.restoreBringsItBack.pass && stash.detail.restoreSucceeded.pass, stash);
      check('and the backup is spent once restored',
        stash.detail.restoreClearsTheBackup.pass, stash);
      check('a backup that cannot be written is reported and never stops the import',
        stash.detail.aStashThatFitsSucceeds.pass && stash.detail.aStashThatCannotBeWrittenReportsItAndCarriesOn.pass, stash);
      check('and a corrupt or wrong-format backup is refused, not half-applied',
        stash.detail.aCorruptBackupIsRefused.pass && stash.detail.AWrongFormatBackupIsRefused.pass
        && stash.detail.AndRefusedToRestoreIt.pass, stash);

      // 5. The settings, and the failures that have to read as failures.
      const settings = await run(`
        const out = {};
        const t = (label, got, want) => { out[label] = { got: JSON.stringify(got), want: JSON.stringify(want), pass: JSON.stringify(got) === JSON.stringify(want) }; };
        localStorage.removeItem('sorted-sync-settings');
        t('anEmptySettingDefaultsToLan', syncSettings().transport, 'lan');
        t('anEmptySettingHasNoUrl', syncSettings().url, '');
        t('autoIsOffUnlessAsked', syncSettings().auto, false);
        localStorage.setItem('sorted-sync-settings', 'not json at all');
        t('aCorruptSettingDoesNotStopSettingsOpening', syncSettings().transport, 'lan');
        localStorage.setItem('sorted-sync-settings', JSON.stringify({ transport: 'nonsense', url: '  http://x/y  ' }));
        t('anUnknownTransportFallsBackToLan', syncSettings().transport, 'lan');
        t('theUrlIsTrimmed', syncSettings().url, 'http://x/y');
        setSyncSettings({ url: 'http://sync.test/sorted-snapshot.json' });
        t('aPatchKeepsTheRest', syncSettings().transport, 'lan');
        t('aPatchSetsItsOwnField', syncSettings().url, 'http://sync.test/sorted-snapshot.json');

        // No address, or a transport that is not available yet, are both results
        // rather than crashes.
        setSyncSettings({ url: '' });
        const noUrl = await syncNow();
        t('noAddressIsAReasonNotACrash', !!noUrl.error && noUrl.ok === false, true);
        setSyncSettings({ url: 'http://sync.test/sorted-snapshot.json' });
        const realAvailable = SYNC_TRANSPORTS.lan.available;
        SYNC_TRANSPORTS.lan.available = false;
        const unavailable = await syncNow();
        SYNC_TRANSPORTS.lan.available = realAvailable;
        t('anUnavailableTransportIsAReasonNotACrash', !!unavailable.error && unavailable.ok === false, true);

        // A host that fails is reported as a failure, and says where.
        const realFetch = window.fetch;
        window.fetch = async () => { throw new Error('network down'); };
        setSyncSettings({ url: 'http://sync.test/broken', transport: 'lan' });
        const hostDown = await syncNow();
        t('aDeadHostIsAFailureAndSaysWhere', hostDown.ok === false && hostDown.where === 'host', true);
        // A host that answers with something that is not a snapshot at all.
        window.fetch = async () => ({ ok: true, status: 200, text: async () => '<html>not a snapshot</html>' });
        const junk = await syncNow();
        t('aFileThatIsNotASnapshotIsAFailure', junk.ok === false, true);
        window.fetch = realFetch;
        localStorage.removeItem('sorted-sync-settings');
        return { checks: Object.keys(out).length, failures: Object.entries(out).filter(([, v]) => !v.pass).map(([k]) => k), detail: out };
      `);
      check('the settings fall back rather than refusing to open',
        settings.detail.anEmptySettingDefaultsToLan.pass
        && settings.detail.aCorruptSettingDoesNotStopSettingsOpening.pass
        && settings.detail.anUnknownTransportFallsBackToLan.pass
        && settings.detail.theUrlIsTrimmed.pass, settings);
      check('a patch keeps the rest of the settings',
        settings.detail.aPatchKeepsTheRest.pass && settings.detail.aPatchSetsItsOwnField.pass, settings);
      check('no address is a reason, not a crash',
        settings.detail.noAddressIsAReasonNotACrash.pass, settings);
      check('an unavailable transport is a reason, not a crash',
        settings.detail.anUnavailableTransportIsAReasonNotACrash.pass, settings);
      check('a dead host is a failure and says where',
        settings.detail.aDeadHostIsAFailureAndSaysWhere.pass, settings);
      check('a file that is not a snapshot is a failure',
        settings.detail.aFileThatIsNotASnapshotIsAFailure.pass, settings);

    console.log('\n# notifications: the plan, the memory, and the native route');

      // ---------------------------------------------------------------
      // Notifications: the plan, the wording, and the memory.
      //
      // What the browser fallback does with the data already has
      // coverage upstream; what has none is everything around it — the
      // moments a reminder is scheduled for, why a bill fires at 09:00
      // rather than at the hour it was set to, the once-a-day memory
      // and its cap, and the words themselves.
      //
      // planReminders runs in the page with the plugin stubbed, so
      // what is under test is the plan rather than the alarms.
      // The stub, installed once. scheduleAllReminders is native-only, so this
      // is also where the native route gets exercised: what it hands the plugin
      // is the thing that actually fires. The wipe goes in the same block as the
      // stub, because the suite's outer level is Node and cannot call a page
      // function, and the stub has to be in place before anything schedules.
      await run(`
        const wiper = () => new Promise((resolve) => { openDB().then((d) => {
          const ns = [...d.objectStoreNames];
          const tx = d.transaction(ns, 'readwrite');
          ns.forEach((n) => tx.objectStore(n).clear());
          tx.oncomplete = () => resolve();
        }); });
        await wiper();
        await loadPeople(); await loadAccounts();
        window.__scheduled = [];
        window.__cancelled = 0;
        window.__channels = [];
        window.__granted = true;
        const originalIsNative = notifyIsNative;
        window.notifyIsNative = () => true;
        window.notifyCap = () => ({
          requestPermissions: async () => ({ granted: true }),
          checkPermissions: async () => ({ granted: true }),
          createChannel: async (c) => { window.__channels.push(c); },
          getPending: async () => ({ notifications: window.__scheduled.slice(0, 0) }),
          schedule: async (list) => { window.__scheduled = window.__scheduled.concat(list.notifications || []); return list; },
          cancel: async () => {},
          cancelAll: async () => { window.__cancelled++; window.__scheduled = []; }
        });
        window.notifyPermissionGranted = async () => window.__granted;
        return true;
      `);

      // 1. Bill wording: every branch, and the singular/plural.
      const wording = await run(`
        const out = {};
        const t = (label, got, want) => { out[label] = { got: got, want: want, pass: got === want }; };
        const bill = { title: 'Rent', amount: 600 };
        t('overdueOneDay', billNotificationText(bill, -1), 'Rent — £600.00, 1 day overdue');
        t('overdueThreeDays', billNotificationText(bill, -3), 'Rent — £600.00, 3 days overdue');
        t('dueToday', billNotificationText(bill, 0), 'Rent — £600.00, due today');
        t('dueInOneDay', billNotificationText(bill, 1), 'Rent — £600.00, due in 1 day');
        t('dueInThreeDays', billNotificationText(bill, 3), 'Rent — £600.00, due in 3 days');
        // A nudge gap of half an hour is the whole point of the constant.
        t('nudgeGapIsHalfAnHour', NUDGE_GAP_MS, 1800000);
        return { checks: Object.keys(out).length, failures: Object.entries(out).filter(([, v]) => !v.pass).map(([k]) => k), detail: out };
      `);
      check('the wording covers overdue, today, and days ahead',
        wording.detail.overdueOneDay.pass && wording.detail.overdueThreeDays.pass
        && wording.detail.dueToday.pass && wording.detail.dueInOneDay.pass
        && wording.detail.dueInThreeDays.pass, wording);

      // 2. When a reminder is scheduled for. A bill due inside its lead time has
      //    a moment already behind it — including anything overdue — so it fires
      //    at nine tomorrow morning rather than being dropped or firing now.
      const times = await run(`
        const out = {};
        const t = (label, got, want) => { out[label] = { got: String(got), want: String(want), pass: String(got) === String(want) }; };
        setNotifyEnabled(true);
        setNotifyLeadDays(3);
        localStorage.removeItem(NOTIFY_SEEN_KEY);
        const now = new Date();
        const iso = (d) => localISO(d);
        const at = (offset, day) => {
          const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
          d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
          return iso(d);
        };
        // Three bills: one overdue, one due today, one due in two days. All inside
        // a three-day lead, so all three are in range.
        await addItem('due', { title: 'Overdue bill', amount: 10, dueDate: at(-1, 15), category: 'Bills', frequency: 'once', recurring: false });
        await addItem('due', { title: 'Due today', amount: 20, dueDate: iso(now), category: 'Bills', frequency: 'once', recurring: false });
        await addItem('due', { title: 'Coming up', amount: 30, dueDate: localISO(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2)), category: 'Bills', frequency: 'once', recurring: false });
        await new Promise((r) => setTimeout(r, 400));
        const plan = await planReminders();
        t('allThreeArePlanned', plan.bills.length, 3);
        t('thePlanIsOldestFirst', plan.bills.map((p) => p.bill.title),
          ['Overdue bill', 'Due today', 'Coming up']);
        // Every one of them is in the future — an overdue bill's own moment has
        // gone, so it is replaced rather than dropped.
        t('noMomentIsInThePast', plan.bills.every((p) => p.at > now), true);
        t('everyMomentIsNineOClock', plan.bills.every((p) => p.at.getHours() === NOTIFY_BILL_HOUR), true);
        return { checks: Object.keys(out).length, failures: Object.entries(out).filter(([, v]) => !v.pass).map(([k]) => k), detail: out };
      `);
      check('a bill inside its lead time is planned, whatever its age',
        times.detail.allThreeArePlanned.pass, times);
      check('and the plan is oldest first, so slot numbering is stable',
        times.detail.thePlanIsOldestFirst.pass, times);
      check('an overdue bill fires at nine tomorrow rather than being dropped',
        times.detail.noMomentIsInThePast.pass && times.detail.everyMomentIsNineOClock.pass, times);

      // 3. A paid bill is never announced, and a bill past its lead time is not
      //    either.
      const edges = await run(`
        const out = {};
        const t = (label, got, want) => { out[label] = { got: String(got), want: String(want), pass: String(got) === String(want) }; };
        setNotifyLeadDays(1);
        const due = await getAll('due');
        for (const b of due) await deleteItem('due', b.id);
        const now = new Date();
        const far = new Date(now.getFullYear(), now.getMonth() + 2, 10);
        await addItem('due', { title: 'Two months away', amount: 5, dueDate: localISO(far), category: 'Bills', frequency: 'once', recurring: false });
        const paidId = await addItem('due', { title: 'Already paid', amount: 9, dueDate: localISO(now), category: 'Bills', frequency: 'once', recurring: false });
        // addItem returns the id, not the row, so the row is read back before it
        // is written again.
        const paidRow = (await getAll('due')).find((r) => r.id === paidId);
        await updateItem('due', Object.assign({}, paidRow, { paid: true }));
        await new Promise((r) => setTimeout(r, 400));
        const plan = await planReminders();
        t('aBillPastItsLeadTimeIsNotPlanned', plan.bills.length, 0);
        t('aPaidBillIsNotPlannedEither', plan.bills.filter((p) => p.bill.title === 'Already paid').length, 0);
        // A bill with no due date cannot exist: dueDate is the store's key path,
        // so one without it is refused at the door rather than being planned or
        // not later. The filter in planReminders stays as the belt to that
        // brace, and it is exercised by a hand-built row.
        const noDate = await planReminders();
        t('aRowWithNoDateIsNotPlanned',
          [].concat([{ title: 'No date', amount: 3, category: 'Bills' }])
            .filter((b) => b.dueDate && b.paid !== true).length, 0);
        return { checks: Object.keys(out).length, failures: Object.entries(out).filter(([, v]) => !v.pass).map(([k]) => k), detail: out };
      `);
      check('a bill past its lead time is not announced',
        edges.detail.aBillPastItsLeadTimeIsNotPlanned.pass, edges);
      check('and neither is one already paid — otherwise it nags every day',
        edges.detail.aPaidBillIsNotPlannedEither.pass, edges);
      check('and a bill with no due date is not announced either',
        edges.detail.aRowWithNoDateIsNotPlanned.pass, edges);

      // 4. nextTimeOfDay always answers with a moment strictly in the future,
      //    and the chosen hour is honoured.
      const nextTime = await run(`
        const out = {};
        const t = (label, got, want) => { out[label] = { got: String(got), want: String(want), pass: String(got) === String(want) }; };
        const at = (hhmm, base) => {
          const r = nextTimeOfDay(hhmm, base);
          return { future: r > base, hour: r.getHours(), minute: r.getMinutes(), day: r.getDate() };
        };
        const now = new Date();
        const sixAm = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 6, 0, 0, 0);
        const sixPm = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 18, 0, 0, 0);
        // Before the hour: today.
        t('beforeTheHourIsToday', at('20:00', sixAm).day, now.getDate());
        t('beforeTheHourIsAtTheHour', at('20:00', sixAm).hour, 20);
        // After the hour: tomorrow, still at the hour.
        const after = at('20:00', sixPm);
        t('afterTheHourRollsToTomorrow', after.day > now.getDate() || after.hour === 20, true);
        t('afterTheHourIsStillAtTheHour', after.hour, 20);
        // Exactly the hour: that moment has come, so it is tomorrow's.
        const exactly = at('06:00', sixAm);
        t('exactlyTheHourIsNotNow', exactly.future, true);
        // A junk time falls back to the default rather than producing NaN.
        const junk = nextTimeOfDay('not a time', sixAm);
        t('ajunkTimeFallsBackToTheDefault', junk.getHours(), 20);
        t('ajunkTimeIsStillInTheFuture', junk > sixAm, true);
        return { checks: Object.keys(out).length, failures: Object.entries(out).filter(([, v]) => !v.pass).map(([k]) => k), detail: out };
      `);
      check('a moment already gone today rolls to tomorrow, never to now',
        nextTime.detail.afterTheHourRollsToTomorrow.pass
        && nextTime.detail.exactlyTheHourIsNotNow.pass, nextTime);
      check('and the chosen hour is honoured, with a junk time falling back',
        nextTime.detail.beforeTheHourIsToday.pass
        && nextTime.detail.beforeTheHourIsAtTheHour.pass
        && nextTime.detail.afterTheHourIsStillAtTheHour.pass
        && nextTime.detail.ajunkTimeFallsBackToTheDefault.pass
        && nextTime.detail.ajunkTimeIsStillInTheFuture.pass, nextTime);

      // 5. The once-a-day memory, and its cap. Without the cap, a phone in daily
      //    use grows one key per bill per day forever and eventually the write
      //    throws — at which point nothing is remembered and everything re-fires.
      const memory = await run(`
        const out = {};
        const t = (label, got, want) => { out[label] = { got: String(got), want: String(want), pass: String(got) === String(want) }; };
        localStorage.removeItem(NOTIFY_SEEN_KEY);
        t('nothingSeenYet', Object.keys(notifySeen()).length, 0);
        markNotified('bill-1', '2026-10-01');
        t('remembered', notifySeen()['bill-1'], '2026-10-01');
        markNotified('bill-1', '2026-10-02');
        t('theLaterDateWins', notifySeen()['bill-1'], '2026-10-02');
        // A corrupt store reads as nothing seen rather than throwing.
        localStorage.setItem(NOTIFY_SEEN_KEY, 'not json');
        t('acorruptStoreIsNothingSeen', Object.keys(notifySeen()).length, 0);
        localStorage.setItem(NOTIFY_SEEN_KEY, '[1,2,3]');
        t('anArrayIsNothingSeen', Object.keys(notifySeen()).length, 0);
        localStorage.removeItem(NOTIFY_SEEN_KEY);
        // The cap.
        for (let i = 0; i < 400; i++) markNotified('bill-' + i, '2026-10-02');
        const afterCap = notifySeen();
        t('theCapHolds', Object.keys(afterCap).length, 200);
        t('theCapKeepsTheNewest', afterCap['bill-399'], '2026-10-02');
        t('theCapDropsTheOldest', afterCap['bill-0'], undefined);
        localStorage.removeItem(NOTIFY_SEEN_KEY);
        // Same cap on the goal dates.
        localStorage.removeItem(NOTIFY_GOAL_LAST_KEY);
        t('noGoalDatesYet', Object.keys(goalTopUpDates()).length, 0);
        noteGoalTopUp('goal-1', '2026-10-01');
        t('aGoalDateIsRecorded', goalTopUpDates()['goal-1'], '2026-10-01');
        noteGoalTopUp('goal-1', '2026-10-03');
        t('alaterDateOverwrites', goalTopUpDates()['goal-1'], '2026-10-03');
        localStorage.setItem(NOTIFY_GOAL_LAST_KEY, 'broken');
        t('corruptGoalDatesReadAsNone', Object.keys(goalTopUpDates()).length, 0);
        localStorage.removeItem(NOTIFY_GOAL_LAST_KEY);
        return { checks: Object.keys(out).length, failures: Object.entries(out).filter(([, v]) => !v.pass).map(([k]) => k), detail: out };
      `);
      check('a bill is remembered, and the later date wins',
        memory.detail.remembered.pass && memory.detail.theLaterDateWins.pass, memory);
      check('a corrupt store reads as nothing seen rather than throwing',
        memory.detail.acorruptStoreIsNothingSeen.pass && memory.detail.anArrayIsNothingSeen.pass, memory);
      check('and the memory is capped, keeping the newest',
        memory.detail.theCapHolds.pass && memory.detail.theCapKeepsTheNewest.pass
        && memory.detail.theCapDropsTheOldest.pass, memory);
      check('the goal dates have the same cap and the same tolerance for corruption',
        memory.detail.noGoalDatesYet.pass && memory.detail.aGoalDateIsRecorded.pass
        && memory.detail.alaterDateOverwrites.pass && memory.detail.corruptGoalDatesReadAsNone.pass, memory);

      // 6. The goal nudge. A goal that predates the feature has never been seen,
      //    and "never seen" must not mean "stale" or it would fire on every
      //    launch.
      const goals = await run(`
        const out = {};
        const t = (label, got, want) => { out[label] = { got: String(got), want: String(want), pass: String(got) === String(want) }; };
        const wiper = () => new Promise((resolve) => { openDB().then((d) => {
          const ns = [...d.objectStoreNames];
          const tx = d.transaction(ns, 'readwrite');
          ns.forEach((n) => tx.objectStore(n).clear());
          tx.oncomplete = () => resolve();
        }); });
        setGoalNudgeEnabled(true);
        // No goals at all.
        await wiper();
        t('noGoalsMeansNoNudge', (await goalsTouchedRecently()).any, false);
        t('noGoalsIsNotRecentEither', (await goalsTouchedRecently()).recent, true);
        // A goal that has never been observed: not recent, so the nudge is live
        // rather than nagging about something that predates it.
        await addItem('savings', { title: 'Holiday', target: 1000, current: 0, monthly: 50 });
        const unseen = await goalsTouchedRecently();
        t('anUnseenGoalIsThere', unseen.any, true);
        t('anUnseenGoalIsNotTreatedAsRecent', unseen.recent, true);
        // observeGoalsOnce stamps it today, which makes it recent.
        await observeGoalsOnce();
        const stamped = await goalsTouchedRecently();
        t('stampedTodayIsRecent', stamped.recent, true);
        // A goal topped up long ago is stale, and the nudge comes back.
        noteGoalTopUp((await getAll('savings'))[0].id, localISO(new Date(Date.now() - 60 * 86400000)));
        const stale = await goalsTouchedRecently();
        t('aGoalUntouchedForTwoMonthsIsStale', stale.recent, false);
        // The cadence is what decides how long "recently" is, and its default is
        // weekly.
        t('theDefaultCadenceIsWeekly', goalNudgeCadence().days, 7);
        setGoalNudgeCadence('monthly');
        t('monthlyIsThirtyDays', goalNudgeCadence().days, 30);
        // An unknown cadence is refused rather than stored, so it stays as it
        // was. A *corrupt* stored value is what falls back.
        setGoalNudgeCadence('rubbish');
        t('anUnknownCadenceIsRefusedAndKeepsTheLast', goalNudgeCadence().days, 30);
        localStorage.setItem(NOTIFY_GOAL_CADENCE_KEY, 'rubbish');
        t('acorruptStoredCadenceFallsBackToWeekly', goalNudgeCadence().days, 7);
        setGoalNudgeCadence('weekly');
        t('afterACorruptValueTheReturnToWeeklyWorks', goalNudgeCadence().days, 7);
        // And a nudge for a stale goal is planned.
        const plan = await planReminders();
        t('aStaleGoalIsPlanned', plan.goals instanceof Date, true);
        return { checks: Object.keys(out).length, failures: Object.entries(out).filter(([, v]) => !v.pass).map(([k]) => k), detail: out };
      `);
      check('no goals means no nudge, and it is not called stale either',
        goals.detail.noGoalsMeansNoNudge.pass && goals.detail.noGoalsIsNotRecentEither.pass, goals);
      check('a goal that has never been observed is there and not treated as recent',
        goals.detail.anUnseenGoalIsThere.pass && goals.detail.anUnseenGoalIsNotTreatedAsRecent.pass, goals);
      check('and observing once stamps it, which makes it recent',
        goals.detail.stampedTodayIsRecent.pass, goals);
      check('a goal untouched for two months is stale, and the nudge comes back',
        goals.detail.aGoalUntouchedForTwoMonthsIsStale.pass && goals.detail.aStaleGoalIsPlanned.pass, goals);
      check('the cadence decides how long "recently" is',
        goals.detail.theDefaultCadenceIsWeekly.pass && goals.detail.monthlyIsThirtyDays.pass
        && goals.detail.anUnknownCadenceIsRefusedAndKeepsTheLast.pass
        && goals.detail.acorruptStoredCadenceFallsBackToWeekly.pass
        && goals.detail.afterACorruptValueTheReturnToWeeklyWorks.pass, goals);

      // 7. noteGoalSaves only counts a figure that went up: editing a target is
      //    not putting money in.
      const topUps = await run(`
        const out = {};
        const t = (label, got, want) => { out[label] = { got: String(got), want: String(want), pass: String(got) === String(want) }; };
        const wiper = () => new Promise((resolve) => { openDB().then((d) => {
          const ns = [...d.objectStoreNames];
          const tx = d.transaction(ns, 'readwrite');
          ns.forEach((n) => tx.objectStore(n).clear());
          tx.oncomplete = () => resolve();
        }); });
        localStorage.removeItem(NOTIFY_GOAL_LAST_KEY);
        await wiper();
        const aId = await addItem('savings', { title: 'Jar A', target: 100, current: 10, monthly: 5 });
        const bId = await addItem('savings', { title: 'Jar B', target: 100, current: 0, monthly: 5 });
        const jars = await getAll('savings');
        const a = jars.find((r) => r.id === aId);
        const b = jars.find((r) => r.id === bId);
        await noteGoalSaves([a, b]);
        const dates = goalTopUpDates();
        t('aGoalWithMoneyInIsStamped', !!dates[a.id], true);
        t('aGoalWithNothingInIsNot', !!dates[b.id] === false, true);
        // Once a day at most, so opening the goal twice does not reset the clock.
        const before = goalTopUpDates()[a.id];
        await noteGoalSaves([a]);
        t('twiceADayStampsOnce', goalTopUpDates()[a.id] === before, true);
        // A null goal, or one with no id, is skipped rather than throwing.
        await noteGoalSaves([null, { title: 'no id' }]);
        t('aGoalWithNoIdIsSkipped', Object.keys(goalTopUpDates()).length, 1);
        localStorage.removeItem(NOTIFY_GOAL_LAST_KEY);
        return { checks: Object.keys(out).length, failures: Object.entries(out).filter(([, v]) => !v.pass).map(([k]) => k), detail: out };
      `);
      check('a goal with money in it is stamped, and one with nothing is not',
        topUps.detail.aGoalWithMoneyInIsStamped.pass && topUps.detail.aGoalWithNothingInIsNot.pass, topUps);
      check('and twice in a day stamps once, and a goal with no id is skipped',
        topUps.detail.twiceADayStampsOnce.pass && topUps.detail.aGoalWithNoIdIsSkipped.pass, topUps);

      // 8. What actually goes to the phone: ids, channel, inexact, and the
      //    cancel-then-rebuild that makes the plan honest rather than stale.
      const native = await run(`
        const out = {};
        const t = (label, got, want) => { out[label] = { got: String(got), want: String(want), pass: String(got) === String(want) }; };
        setNotifyEnabled(true);
        setNotifyLeadDays(3);
        setSpendNudgeEnabled(true);
        setGoalNudgeEnabled(false);
        window.__granted = true;
        window.__scheduled = [];
        window.__cancelled = 0;
        window.__channels = [];
        const due = await getAll('due');
        for (const b of due) await deleteItem('due', b.id);
        const spend = await getAll('spend');
        for (const s of spend) await deleteItem('spend', s.id);
        await new Promise((r) => setTimeout(r, 200));
        const now = new Date();
        const iso = (d) => localISO(d);
        await addItem('due', { title: 'Rent', amount: 600, dueDate: iso(now), category: 'Housing', frequency: 'once', recurring: false });
        await addItem('due', { title: 'Council tax', amount: 150, dueDate: localISO(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2)), category: 'Utilities', frequency: 'once', recurring: false });
        await new Promise((r) => setTimeout(r, 300));
        const scheduled = await scheduleAllReminders();
        const list = window.__scheduled;
        const bills = list.filter((n) => Number(n.id) < 900000);
        t('billsWereScheduled', bills.length, 2);
        t('aSpendNudgeWasScheduled', list.some((n) => n.id === NOTIFY_ID_SPEND), true);
        t('everyOneIsInexact', list.every((n) => n.isExactNotification === false), true);
        t('everyOneNamesTheChannel', list.every((n) => n.channelId === NOTIFY_CHANNEL_ID), true);
        t('everyOneHasASchedule', list.every((n) => n.schedule && n.schedule.at instanceof Date), true);
        t('noAlarmIsExact', list.every((n) => n.schedule.allowWhileIdle === false), true);
        t('abillCarriesItsPage', bills.every((n) => n.extra && n.extra.page === 'due'), true);
        t('abillCarriesItsOwnId', bills.every((n) => !!n.extra.billId), true);
        t('slotIdsAreDistinct', new Set(bills.map((n) => n.id)).size, 2);
        t('aChannelWasCreated', window.__channels.length >= 1, true);
        t('theCountIsWhatWasScheduled', scheduled, list.length);
        // Cancel first, unconditionally: whatever was pending was planned from
        // data that has since moved on.
        window.__scheduled = [];
        const secondPass = await scheduleAllReminders();
        t('aSecondPassCancelsFirst', window.__cancelled, 2);
        // Bills only: the spend nudge carries an id well above the bill slots,
        // and it is counted separately.
        t('aSecondPassSchedulesFresh',
          window.__scheduled.filter((n) => Number(n.id) < 900000).length, 2);
        t('theSecondPassAgrees', secondPass, 3);
        // Without the permission, nothing is scheduled and nothing is cancelled.
        window.__granted = false;
        const cancelledBefore = window.__cancelled;
        const blocked = await scheduleAllReminders();
        t('blockedSchedulesNothing', blocked, 0);
        t('blockedCancelsNothingEither', window.__cancelled, cancelledBefore);
        window.__granted = true;
        return { checks: Object.keys(out).length, failures: Object.entries(out).filter(([, v]) => !v.pass).map(([k]) => k), detail: out };
      `);
      check('what goes to the phone is inexact, on the channel, with its own id',
        native.detail.everyOneIsInexact.pass && native.detail.everyOneNamesTheChannel.pass
        && native.detail.abillCarriesItsPage.pass && native.detail.abillCarriesItsOwnId.pass
        && native.detail.slotIdsAreDistinct.pass, native);
      check('and the count it returns is the count it scheduled',
        native.detail.billsWereScheduled.pass && native.detail.aSpendNudgeWasScheduled.pass
        && native.detail.theCountIsWhatWasScheduled.pass, native);
      check('each pass cancels first and rebuilds, so a stale plan cannot survive',
        native.detail.aSecondPassCancelsFirst.pass && native.detail.aSecondPassSchedulesFresh.pass
        && native.detail.theSecondPassAgrees.pass, native);
      check('and with no permission it schedules nothing and cancels nothing',
        native.detail.blockedSchedulesNothing.pass && native.detail.blockedCancelsNothingEither.pass, native);
      check('and a channel exists to put them on',
        native.detail.everyOneHasASchedule.pass && native.detail.noAlarmIsExact.pass
        && native.detail.aChannelWasCreated.pass, native);

      // 9. A bill that is deleted must not leave its alarm behind. Slot ids are
      //    positions in the ordered list, so when the list shortens every alarm
      //    after the gap would carry the wrong bill — which is why the cancel is
      //    unconditional rather than a diff.
      const reindex = await run(`
        const out = {};
        const t = (label, got, want) => { out[label] = { got: String(got), want: String(want), pass: String(got) === String(want) }; };
        setNotifyEnabled(true);
        setNotifyLeadDays(5);
        const due = await getAll('due');
        for (const b of due) await deleteItem('due', b.id);
        const now = new Date();
        const day = (n) => localISO(new Date(now.getFullYear(), now.getMonth(), now.getDate() + n));
        const one = await addItem('due', { title: 'First', amount: 1, dueDate: day(1), category: 'Bills', frequency: 'once', recurring: false });
        const two = await addItem('due', { title: 'Second', amount: 2, dueDate: day(2), category: 'Bills', frequency: 'once', recurring: false });
        const three = await addItem('due', { title: 'Third', amount: 3, dueDate: day(3), category: 'Bills', frequency: 'once', recurring: false });
        await new Promise((r) => setTimeout(r, 400));
        window.__scheduled = [];
        await scheduleAllReminders();
        const before = window.__scheduled.filter((n) => Number(n.id) < 900000);
        const beforeTitles = before.map((n) => n.extra.billId).map((id) => id === three ? 'Third' : id === two ? 'Second' : 'First');
        // Delete the middle one. Its alarm must not survive, and the remaining
        // two must still point at the right bills.
        await deleteItem('due', two);
        await new Promise((r) => setTimeout(r, 300));
        window.__scheduled = [];
        window.__cancelled = 0;
        await scheduleAllReminders();
        const after = window.__scheduled.filter((n) => Number(n.id) < 900000);
        t('theDeletedAlarmIsGone', after.some((n) => n.extra.billId === two), false);
        t('theSurvivingAlarmsAreTheRightBills',
          after.map((n) => n.extra.billId === three ? 'Third' : 'First').join(), 'First,Third');
        t('noDuplicatedSlotsSurvive', new Set(after.map((n) => n.id)).size, after.length);
        return { checks: Object.keys(out).length, failures: Object.entries(out).filter(([, v]) => !v.pass).map(([k]) => k), detail: out };
      `);
      check('deleting a bill leaves no alarm behind it',
        reindex.detail.theDeletedAlarmIsGone.pass, reindex);
      check('and the alarms that remain still point at the right bills',
        reindex.detail.theSurvivingAlarmsAreTheRightBills.pass, reindex);

      // 10. The wording for a state that is not a refusal, and the memory that
      //     must not remember it as one.
      const unknownState = await run(`
        const out = {};
        const t = (label, got, want) => { out[label] = { got: String(got), want: String(want), pass: String(got) === String(want) }; };
        const realKey = NOTIFY_BLOCKED_KEY;
        localStorage.removeItem(realKey);
        t('unknownSaysItCouldNotCheck',
          permissionMessage('unknown').text,
          'Sorted could not check notifications on this phone');
        t('grantedSaysNothing', permissionMessage('granted').text, '');
        t('promptAsksAgain', permissionMessage('prompt').ok, false);
        t('unavailableIsItsOwnAnswer', permissionMessage('unavailable').ok, false);
        // What the memory holds after an unknown.
        await reportReminderOutcome('bills', { state: 'unknown' });
        t('unknownIsNotRememberedAsRefused', localStorage.getItem(realKey), null);
        await reportReminderOutcome('bills', { state: 'denied' });
        t('aRefusalIsRemembered', localStorage.getItem(realKey), 'denied');
        // And a refusal is said once rather than on every tap.
        const calls = [];
        const realToast = window.showToast;
        window.showToast = (t2) => { calls.push(t2); };
        await reportReminderOutcome('bills', { state: 'denied' });
        t('areminderKnownIsNotSaidTwice', calls.length, 0);
        await reportReminderOutcome('bills', { state: 'default' });
        t('adifferentStateIsSaid', calls.length, 1);
        await reportReminderOutcome('bills', { state: 'unknown' });
        t('andAFailureIsSaidEveryTime', calls.length, 2);
        window.showToast = realToast;
        localStorage.removeItem(realKey);
        return { checks: Object.keys(out).length, failures: Object.entries(out).filter(([, v]) => !v.pass).map(([k]) => k), detail: out };
      `);
      check('"unknown" says it could not check, and is not a refusal',
        unknownState.detail.unknownSaysItCouldNotCheck.pass
        && unknownState.detail.grantedSaysNothing.pass
        && unknownState.detail.unavailableIsItsOwnAnswer.pass, unknownState);
      check('and a failure is never remembered as a refusal',
        unknownState.detail.unknownIsNotRememberedAsRefused.pass, unknownState);
      check('a refusal is said once, and a different state or a failure is said again',
        unknownState.detail.aRefusalIsRemembered.pass
        && unknownState.detail.areminderKnownIsNotSaidTwice.pass
        && unknownState.detail.adifferentStateIsSaid.pass
        && unknownState.detail.andAFailureIsSaidEveryTime.pass, unknownState);

      // Put the real transport back, and the settings the rest of the suite
      // expects.
      await run(`
        window.__scheduled = [];
        window.__granted = true;
        disableNotifications();
        setNotifyEnabled(false);
        setSpendNudgeEnabled(false);
        setGoalNudgeEnabled(false);
        localStorage.removeItem(NOTIFY_SEEN_KEY);
        localStorage.removeItem(NOTIFY_GOAL_LAST_KEY);
        return true;
      `);

    console.log('\n# export: every format, read back the way its reader reads it');

      // ---------------------------------------------------------------
      // Export, in every format the Save report menu offers, and back
      // again where the format allows it.
      //
      // A CSV that loses a comma, a JSON that drops a field on the way
      // out, or a formula that a spreadsheet evaluates are all silent:
      // the file opens, and what it says is wrong. So the round trip is
      // the check — the file is read back the way a spreadsheet would
      // read it, column by column, rather than asserted to look right.
      // The whole fixture is seeded here, inside a run block, because the
      // suite's outer level is Node and a page function called there is not a
      // page function. The account's id is parked on window for the goal check.
      const seeded = await run(`
        const wiper = () => new Promise((resolve) => { openDB().then((d) => {
          const ns = [...d.objectStoreNames];
          const tx = d.transaction(ns, 'readwrite');
          ns.forEach((n) => tx.objectStore(n).clear());
          tx.oncomplete = () => resolve();
        }); });
        await wiper();
        await loadPeople();
        const ada = await addItem('people', { name: 'Ada', colour: '#f00' });
        await addItem('accounts', { name: 'Current', type: 'bank', opening: 500 });
        await loadPeople();
        // The rows. One of each: a spend, an unpaid bill, a paid bill, and income.
        await addItem('spend', { title: 'Tesco, weekly shop', amount: 42.5, date: '2026-09-01', category: 'Groceries', personId: ada });
        await addItem('spend', { title: 'Refund, half', amount: -12.99, date: '2026-09-03', category: 'Groceries' });
        await addItem('due', { title: 'Rent', amount: 600, dueDate: '2026-09-05', category: 'Housing', frequency: 'once', recurring: false });
        const paidId = await addItem('due', { title: 'Council tax', amount: 150, dueDate: '2026-09-07', category: 'Utilities', frequency: 'once', recurring: false });
        // addItem returns the id, not the row, so the row is read back before it
        // is written again.
        const paidRow = (await getAll('due')).find((r) => r.id === paidId);
        await updateItem('due', Object.assign({}, paidRow, { paid: true }));
        await addItem('income', { title: 'Salary', amount: 1000, date: '2026-09-01', category: 'Salary' });
        // Title a receipt's OCR actually produces, and a formula a spreadsheet
        // would run: the untrusted text here is first-party.
        await addItem('spend', { title: "=cmd|'/c calc'!A1", amount: 1, date: '2026-09-09', category: 'OCR' });
        await addItem('spend', { title: 'Quote " and, comma', amount: 2, date: '2026-09-10', category: 'OCR' });
        await new Promise((r) => setTimeout(r, 500));
        window.__exportAccount = (await getAll('accounts')).find((a) => a.name === 'Current').id;
        return ada;
      `);
      check('the export fixture is seeded',
        typeof exportSeeded === 'string' && exportSeeded.length > 0, exportSeeded);

      // 1. CSV: header, column count, the amount as a number, and a formula
      //    neutralised.
      const csv = await run(`
        // Parse a row the way a spreadsheet does. Written here rather than
        // compared byte for byte, because a quoting bug shows up as the wrong
        // number of columns rather than as a different string.
        const splitCsvRow = (line) => {
          const cells = [];
          let cur = '';
          let quoted = false;
          for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (quoted) {
              if (ch === '"') {
                if (line[i + 1] === '"') { cur += '"'; i++; }
                else quoted = false;
              } else cur += ch;
            } else if (ch === '"') {
              quoted = true;
            } else if (ch === ',') {
              cells.push(cur); cur = '';
            } else cur += ch;
          }
          cells.push(cur);
          return cells;
        };
        const out = {};
        const t = (label, got, want) => { out[label] = { got: String(got), want: String(want), pass: String(got) === String(want) }; };
        const data = await getAllData();
        const csv = await buildExport('csv');
        const text = csv.text;
        t('mimeIsCsv', csv.mime, 'text/csv');
        // A BOM: without it Excel on Windows reads the first column as mojibake
        // and every date as text.
        t('theBomIsThere', text.charCodeAt(0), 65279);
        const body = text.slice(1);
        const rows = body.split('\\n').filter((l) => l.length);
        t('theHeaderIsFirst', rows[0], 'Date,Type,Description,Category,Amount,Paid,Person');
        t('everyRowHasSevenColumns', rows.slice(1).every((r) => splitCsvRow(r).length === 7), true);
        // Parse it the way a spreadsheet does, so a quoting bug shows up as a
        // column count rather than as a byte comparison.
        const header = splitCsvRow(rows[0]);
        const parsed = rows.slice(1).map((r) => {
          const cells = splitCsvRow(r);
          const o = {};
          header.forEach((h, i) => { o[h] = cells[i]; });
          return o;
        });
        const byTitle = (s) => parsed.find((r) => r.Description === s);
        t('theShopIsThere', !!byTitle('Tesco, weekly shop'), true);
        t('itsAmountIsANumber', Number(byTitle('Tesco, weekly shop').Amount), 42.5);
        t('aRefundStaysANumber', Number(parsed.find((r) => r.Description === 'Refund, half').Amount), -12.99);
        t('anUnpaidBillSaysNo', byTitle('Rent').Paid, 'no');
        t('aPaidBillSaysYes', byTitle('Council tax').Paid, 'yes');
        t('aSpendRowHasNoPaidColumn', byTitle('Tesco, weekly shop').Paid, '');
        t('thePersonIsNamed', byTitle('Tesco, weekly shop').Person, 'Ada');
        t('incomeIsThere', !!byTitle('Salary'), true);
        // A formula is neutralised, and the apostrophe is what a spreadsheet
        // shows as typed while evaluating nothing.
        // The cell carries one leading apostrophe — the standard neutraliser, which
        // a spreadsheet shows as typed and evaluates nothing — and the text after
        // it is the formula untouched. Only the first character is touched, so an
        // amount of -12.99 in the amount column is left alone.
        const formulaRow = parsed.find((r) => r.Description.charAt(0) === "'");
        t('aFormulaIsNeutralised', formulaRow ? formulaRow.Description : null,
          "'=cmd|'/c calc'!A1");
        t('onlyTheFirstCharacterIsTouched', formulaRow.Description.indexOf('='), 1);
        t('theAmountColumnHasNoApostrophe', csv.text.split('\\n')
          .some((l) => l.indexOf(',1.00,') >= 0), true);
        t('aQuoteAndACommaSurvive', byTitle('Quote " and, comma').Description, 'Quote " and, comma');
        // Oldest first, so a spreadsheet sorted by nothing reads as a statement.
        t('theRowsAreOldestFirst',
          parsed.every((r, i, a) => i === 0 || a[i - 1].Date <= r.Date), true);
        return { checks: Object.keys(out).length, failures: Object.entries(out).filter(([, v]) => !v.pass).map(([k]) => k), detail: out };
      `);
      check('a CSV has a BOM, a header, and seven columns on every row',
        csv.detail.mimeIsCsv.pass && csv.detail.theBomIsThere.pass
        && csv.detail.theHeaderIsFirst.pass && csv.detail.everyRowHasSevenColumns.pass, csv);
      check('and the amount column is a number — a refund of -12.99 included',
        csv.detail.itsAmountIsANumber.pass && csv.detail.aRefundStaysANumber.pass, csv);
      check('and a formula a receipt OCR produced is neutralised',
        csv.detail.aFormulaIsNeutralised.pass, csv);
      check('and a quote and a comma inside a cell survive the round trip',
        csv.detail.aQuoteAndACommaSurvive.pass, csv);
      check('and paid stays paid, and the person is named',
        csv.detail.anUnpaidBillSaysNo.pass && csv.detail.aPaidBillSaysYes.pass
        && csv.detail.aSpendRowHasNoPaidColumn.pass && csv.detail.thePersonIsNamed.pass, csv);
      check('and income is there too, oldest first',
        csv.detail.incomeIsThere.pass && csv.detail.theRowsAreOldestFirst.pass, csv);

      // 2. The BOM is worth one check on its own, because it is invisible in a
      //    diff and costs a user their morning.
      const bom = await run(`
        const out = {};
        const t = (label, got, want) => { out[label] = { got: String(got), want: String(want), pass: String(got) === String(want) }; };
        const plain = await buildExport('csv');
        t('theBomIsTheFirstCharacter', plain.text.indexOf('\\ufeff'), 0);
        t('thereIsExactlyOne', plain.text.slice(1).indexOf('\\ufeff'), -1);
        // And an empty database still produces a well-formed file.
        const wiper = () => new Promise((resolve) => { openDB().then((d) => {
          const ns = [...d.objectStoreNames];
          const tx = d.transaction(ns, 'readwrite');
          ns.forEach((n) => tx.objectStore(n).clear());
          tx.oncomplete = () => resolve();
        }); });
        await wiper();
        await loadPeople(); await loadAccounts();
        const empty = await buildExport('csv');
        t('anEmptyExportStillHasTheHeader', empty.text.slice(1).split('\\n')[0],
          'Date,Type,Description,Category,Amount,Paid,Person');
        t('anEmptyExportHasNoRows', empty.text.slice(1).split('\\n').filter((l) => l.length).length, 1);
        const emptyTxt = await buildExport('txt');
        t('anEmptyTextExportIsWellFormed', typeof emptyTxt.text, 'string');
        return { checks: Object.keys(out).length, failures: Object.entries(out).filter(([, v]) => !v.pass).map(([k]) => k), detail: out };
      `);
      check('the BOM is there once, at the very start',
        bom.detail.theBomIsTheFirstCharacter.pass && bom.detail.thereIsExactlyOne.pass, bom);
      check('and an empty database still produces a well-formed file',
        bom.detail.anEmptyExportStillHasTheHeader.pass
        && bom.detail.anEmptyExportHasNoRows.pass
        && bom.detail.anEmptyTextExportIsWellFormed.pass, bom);

      // 3. JSON: the backup must carry everything, and be readable back.
      const json = await run(`
        const out = {};
        const t = (label, got, want) => { out[label] = { got: JSON.stringify(got), want: JSON.stringify(want), pass: JSON.stringify(got) === JSON.stringify(want) }; };
        const wiper = () => new Promise((resolve) => { openDB().then((d) => {
          const ns = [...d.objectStoreNames];
          const tx = d.transaction(ns, 'readwrite');
          ns.forEach((n) => tx.objectStore(n).clear());
          tx.oncomplete = () => resolve();
        }); });
        await wiper();
        await loadPeople(); await loadAccounts();
        const ada = await addItem('people', { name: 'Ada', colour: '#f00' });
        await addItem('accounts', { name: 'Current', type: 'bank', opening: 500 });
        const billId = await addItem('due', { title: 'Rent', amount: 600, dueDate: '2026-09-05', category: 'Housing', frequency: 'once', recurring: false });
        await new Promise((r) => setTimeout(r, 300));
        const before = await getAllData();
        const exported = await buildExport('json');
        t('mimeIsJson', exported.mime, 'application/json');
        const parsed = JSON.parse(exported.text);
        t('everyStoreIsCarried', STORES.every((s) => Array.isArray(parsed[s])), true);
        t('nothingWasDropped', STORES.every((s) => (parsed[s] || []).length === (before[s] || []).length), true);
        // A field the app relies on must not be dropped on the way out. A false
        // answer here is a silent data loss that only shows up on an import.
        const rent = parsed.due.find((r) => r.title === 'Rent');
        t('theIdSurvives', rent.id, billId);
        t('theAmountSurvives', rent.amount, 600);
        t('theDateSurvives', rent.dueDate, '2026-09-05');
        t('theCategorySurvives', rent.category, 'Housing');
        t('theFrequencySurvives', rent.frequency, 'once');
        t('theScheduleFieldsSurvive', rent.recurring, false);
        const person = parsed.people[0];
        t('aPersonSurvives', person.name, 'Ada');
        // And back: importing the file reproduces what it came from.
        pendingImport = parsed;
        await commitImport('replace', null);
        const after = await getAllData();
        t('anImportRoundTripRestoresTheRows',
          after.due.map((r) => r.title).join(), 'Rent');
        t('andItsFields', after.due[0].amount, 600);
        t('andThePeople', after.people.map((p) => p.name).join(), 'Ada');
        return { checks: Object.keys(out).length, failures: Object.entries(out).filter(([, v]) => !v.pass).map(([k]) => k), detail: out };
      `);
      check('the JSON backup carries every store and nothing is dropped',
        json.detail.mimeIsJson.pass && json.detail.everyStoreIsCarried.pass
        && json.detail.nothingWasDropped.pass, json);
      check('and the fields the app relies on all survive',
        json.detail.theIdSurvives.pass && json.detail.theAmountSurvives.pass
        && json.detail.theDateSurvives.pass && json.detail.theCategorySurvives.pass
        && json.detail.theFrequencySurvives.pass && json.detail.theScheduleFieldsSurvive.pass, json);
      check('and importing it back restores the rows and their fields',
        json.detail.anImportRoundTripRestoresTheRows.pass && json.detail.andItsFields.pass
        && json.detail.andThePeople.pass, json);

      // 4. The text report reads as a statement, and the numbers on it are the
      //    numbers in the database.
      const text = await run(`
        const out = {};
        const t = (label, got, want) => { out[label] = { got: String(got), want: String(want), pass: String(got) === String(want) }; };
        const wiper = () => new Promise((resolve) => { openDB().then((d) => {
          const ns = [...d.objectStoreNames];
          const tx = d.transaction(ns, 'readwrite');
          ns.forEach((n) => tx.objectStore(n).clear());
          tx.oncomplete = () => resolve();
        }); });
        await wiper();
        await loadPeople(); await loadAccounts();
        await addItem('spend', { title: 'Tesco', amount: 42.5, date: '2026-09-01', category: 'Groceries' });
        await addItem('spend', { title: 'Refund', amount: -12.99, date: '2026-09-03', category: 'Groceries' });
        await addItem('due', { title: 'Rent', amount: 600, dueDate: '2026-09-05', category: 'Housing', frequency: 'once', recurring: false });
        await addItem('income', { title: 'Salary', amount: 1000, date: '2026-09-01', category: 'Salary' });
        await new Promise((r) => setTimeout(r, 400));
        const out2 = await buildExport('txt');
        t('mimeIsPlainText', out2.mime, 'text/plain');
        const lines = out2.text.split('\\n');
        t('itIsNotCsv', lines[0].indexOf('Date,Type') < 0, true);
        t('theSpendIsNamed', out2.text.indexOf('Tesco') >= 0, true);
        t('theAmountsAreShown', /42\\.50/.test(out2.text), true);
        t('aNegativeIsShownInBracketsOrWithASign', /-?12\\.99/.test(out2.text), true);
        // No stray units or unrendered template holes.
        t('noUndefinedOnThePage', out2.text.indexOf('undefined') < 0, true);
        t('noNaNOnThePage', out2.text.indexOf('NaN') < 0, true);
        t('noEmptyBracesOnThePage', out2.text.indexOf('{}') < 0, true);
        return { checks: Object.keys(out).length, failures: Object.entries(out).filter(([, v]) => !v.pass).map(([k]) => k), detail: out };
      `);
      check('the text report is a report, not a CSV with line breaks',
        text.detail.mimeIsPlainText.pass && text.detail.itIsNotCsv.pass, text);
      check('and it shows what is in the database, including a negative',
        text.detail.theSpendIsNamed.pass && text.detail.theAmountsAreShown.pass
        && text.detail.aNegativeIsShownInBracketsOrWithASign.pass, text);
      check('and it never renders a hole — no undefined, NaN or empty braces',
        text.detail.noUndefinedOnThePage.pass && text.detail.noNaNOnThePage.pass
        && text.detail.noEmptyBracesOnThePage.pass, text);

      // 5. The PDF is a PDF, and what the app says it is saving is what it saves.
      const pdf = await run(`
        const out = {};
        const t = (label, got, want) => { out[label] = { got: JSON.stringify(got), want: JSON.stringify(want), pass: JSON.stringify(got) === JSON.stringify(want) }; };
        const data = await getAllData();
        const p = await buildExport('pdf');
        t('mimeIsPdf', p.mime, 'application/pdf');
        t('thePayloadIsBase64', p.base64, true);
        const bytes = base64ToBytes(p.text);
        t('theMagicBytesArePDF', String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]), '%PDF');
        t('theVersionIs1_4', String.fromCharCode(bytes[5], bytes[6], bytes[7]), '1.4');
        t('itEndsWithEOF',
          String.fromCharCode.apply(null, bytes.slice(bytes.length - 6)), '%%EOF\\n');
        // The kind table is the contract with the file picker: the extension and
        // the suffix decide what the person sees on the save screen.
        t('jsonHasABackupSuffix', EXPORT_KINDS.json.suffix, 'backup-');
        t('theOthersHaveNoSuffix', [EXPORT_KINDS.csv.suffix, EXPORT_KINDS.txt.suffix, EXPORT_KINDS.pdf.suffix].join(), ',,');
        t('onlyMovementsBecomeRows', EXPORT_ROWS.map((r) => r.store).join(), 'spend,due,income');
        t('accountsAreNotARow', EXPORT_ROWS.some((r) => r.store === 'accounts'), false);
        return { checks: Object.keys(out).length, failures: Object.entries(out).filter(([, v]) => !v.pass).map(([k]) => k), detail: out };
      `);
      check('the PDF is a real PDF, base64, with the right magic bytes',
        pdf.detail.mimeIsPdf.pass && pdf.detail.thePayloadIsBase64.pass
        && pdf.detail.theMagicBytesArePDF.pass && pdf.detail.theVersionIs1_4.pass
        && pdf.detail.itEndsWithEOF.pass, pdf);
      check('and only movements become rows, with the right file suffixes',
        pdf.detail.onlyMovementsBecomeRows.pass && pdf.detail.accountsAreNotARow.pass
        && pdf.detail.jsonHasABackupSuffix.pass && pdf.detail.theOthersHaveNoSuffix.pass, pdf);

      // 6. exportMovementRows is the one table every format reads from, so the
      //    rows themselves are checked rather than each format's rendering of
      //    them. A date missing entirely is an unplaced row: it is not last or
      //    first, it is nowhere.
      const rows = await run(`
        const out = {};
        const t = (label, got, want) => { out[label] = { got: JSON.stringify(got), want: JSON.stringify(want), pass: JSON.stringify(got) === JSON.stringify(want) }; };
        const wiper = () => new Promise((resolve) => { openDB().then((d) => {
          const ns = [...d.objectStoreNames];
          const tx = d.transaction(ns, 'readwrite');
          ns.forEach((n) => tx.objectStore(n).clear());
          tx.oncomplete = () => resolve();
        }); });
        await wiper();
        await loadPeople(); await loadAccounts();
        const ada = await addItem('people', { name: 'Ada', colour: '#f00' });
        await loadPeople();
        await addItem('spend', { title: 'No date', amount: 5, category: 'Groceries' });
        await addItem('spend', { title: 'Spend', amount: 10, date: '2026-09-02', category: 'Groceries', personId: ada });
        await addItem('income', { title: 'Wage', amount: 100, date: '2026-09-01', category: 'Salary' });
        const billId = await addItem('due', { title: 'Bill', amount: 20, dueDate: '2026-09-03', category: 'Housing', frequency: 'once', recurring: false });
        await new Promise((r) => setTimeout(r, 400));
        const rows = exportMovementRows(await getAllData());
        t('everyKindIsThere', rows.map((r) => r.kind).sort().join(), 'Bill,Income,Spent,Spent');
        const spend = rows.filter((r) => r.kind === 'Spent');
        t('thePersonIsResolvedByName',
          spend.filter((r) => r.title === 'Spend')[0].person, 'Ada');
        t('theAmountIsNumeric', typeof rows[0].amount, 'number');
        t('aRowWithNoDateSortsFirstNotLast', rows[0].date, '');
        t('theOthersFollow', rows[1].date, '2026-09-01');
        return { checks: Object.keys(out).length, failures: Object.entries(out).filter(([, v]) => !v.pass).map(([k]) => k), detail: out };
      `);
      check('the rows carry a kind, a numeric amount and the person by name',
        rows.detail.everyKindIsThere.pass && rows.detail.thePersonIsResolvedByName.pass
        && rows.detail.theAmountIsNumeric.pass, rows);
      check('and a row with no date is placed first, not dropped or sent last',
        rows.detail.aRowWithNoDateSortsFirstNotLast.pass && rows.detail.theOthersFollow.pass, rows);

  }

  console.log('\n# a round trip must not change the data');
  const roundtrip = await run(`
    const out = {};
    const t = (label, got, want) => { out[label] = { got: JSON.stringify(got), want: JSON.stringify(want), pass: JSON.stringify(got) === JSON.stringify(want) }; };
    const wipe = () => new Promise((r) => { openDB().then((d) => {
      const ns = [...d.objectStoreNames];
      const tx = d.transaction(ns, 'readwrite');
      ns.forEach((n) => tx.objectStore(n).clear());
      tx.oncomplete = () => r();
    }); });

    // 1. 'Business' income survived a backup round-trip. The form offered it and
    //    the import accepted only salary, sale and other, so exporting and
    //    importing rewrote every business income row to 'Other'.
    await wipe();
    await loadPeople(); await loadAccounts();
    const acc = await addAccount('Current', 'bank', 1000, null);
    await loadAccounts();
    await addItem('income', { title: 'Consulting', amount: 500, date: '2026-09-01', accountId: acc, category: 'business' });
    await addItem('income', { title: 'Wages', amount: 2000, date: '2026-09-02', accountId: acc, category: 'salary' });
    await new Promise(r => setTimeout(r, 400));
    const before = (await getAll('income')).map((x) => x.title + ':' + x.category).sort();
    const backup = await getAllData();
    await wipe();
    await loadPeople(); await loadAccounts();
    const r = await importDataToDB(backup, 'replace');
    t('aRoundTripChangesNothing', before, (await getAll('income')).map((x) => x.title + ':' + x.category).sort());
    t('andNothingWasDropped', r.dropped, 0);
    // A hand-edited file with an unknown category still falls back.
    await importDataToDB({ income: [{ title: 'Odd', amount: 1, date: '2026-09-03', category: 'nonsense' }] }, 'merge');
    t('anUnknownCategoryStillFallsBack', (await getAll('income')).find((x) => x.title === 'Odd').category, 'other');
    // There is one list, not two: what the form offers is what survives.
    t('oneListNotTwo', INCOME_CATEGORIES.map(([v]) => v).sort().join(','), 'business,other,salary,sale');

    // 2. "Delete all data" and a first launch land in the same place: both
    //    start empty. Nothing is seeded and no default account is re-created,
    //    so a wipe leaves an app waiting for its first account.
    await wipe();
    await loadPeople(); await loadAccounts();
    await addAccount('Current', 'bank', 1000, null);
    await loadAccounts();
    const res = await clearAllData();
    clearAllPersonPins();
    await new Promise(r => setTimeout(r, 800));
    t('aWipeLeavesNoAccounts', (await getAll('accounts')).map((a) => a.name), []);
    t('andCountedWhatItDeleted', res.total, 1);
    // A fresh install lands in the same place: nothing.
    await wipe();
    await loadPeople(); await loadAccounts();
    await new Promise(r => setTimeout(r, 500));
    t('aFirstLaunchHasNoAccounts', (await getAll('accounts')).map((a) => a.name), []);
    return { checks: Object.keys(out).length, failures: Object.entries(out).filter(([, v]) => !v.pass).map(([k]) => k), detail: out };
  `);
  check('a backup round-trip does not change the data',
    roundtrip.detail.aRoundTripChangesNothing.pass && roundtrip.detail.andNothingWasDropped.pass, roundtrip.detail);
  check('and an unknown category still falls back',
    roundtrip.detail.anUnknownCategoryStillFallsBack.pass, roundtrip.detail);
  check('with one list, not two', roundtrip.detail.oneListNotTwo.pass, roundtrip.detail);
  check('a wipe and a first launch land in the same place',
    roundtrip.detail.aWipeLeavesNoAccounts.pass && roundtrip.detail.aFirstLaunchHasNoAccounts.pass, roundtrip.detail);
  check('and every one of those passed', roundtrip.failures.length === 0, roundtrip.failures);

  console.log('\n# merge: two entries the user means as two things');
  const merge = await run(`
    const out = {};
    const t = (label, got, want) => { out[label] = { got: JSON.stringify(got), want: JSON.stringify(want), pass: JSON.stringify(got) === JSON.stringify(want) }; };
    const wipe = () => new Promise((r) => { openDB().then((d) => {
      const ns = [...d.objectStoreNames];
      const tx = d.transaction(ns, 'readwrite');
      ns.forEach((n) => tx.objectStore(n).clear());
      tx.oncomplete = () => r();
    }); });

    // The same shop, the same money, the same day, two categories. The merge
    // key was title|amount|date, so the second of these was called a duplicate
    // and the losing category vanished from Reports entirely.
    await wipe();
    await loadPeople(); await loadAccounts();
    let r = await importDataToDB({
      spend: [
        { title: 'Tesco', amount: 40, date: '2026-10-03', category: 'Groceries' },
        { title: 'Tesco', amount: 40, date: '2026-10-03', category: 'Eating out' }
      ]
    }, 'merge');
    t('sameShopTwoCategories', { i: r.imported, s: r.skipped }, { i: 2, s: 0 });
    t('bothCategoriesSurvive', (await getAll('spend')).map((x) => x.category).sort(),
      ['Eating out', 'Groceries']);

    // The same money, the same day, two people.
    await wipe();
    await loadPeople(); await loadAccounts();
    const ada = await addItem('people', { name: 'Ada' });
    const bob = await addItem('people', { name: 'Bob' });
    await loadPeople();
    r = await importDataToDB({
      spend: [
        { title: 'Incidentals', amount: 10, date: '2026-10-05', category: 'Groceries', personId: ada },
        { title: 'Incidentals', amount: 10, date: '2026-10-05', category: 'Groceries', personId: bob }
      ]
    }, 'merge');
    t('sameSpendTwoPeople', { i: r.imported, s: r.skipped }, { i: 2, s: 0 });
    t('bothPeopleSurvive', (await getAll('spend')).length, 2);

    // Two transfers of the same money between different pairs of accounts. A
    // transfer has no title, so the old key was pipe-200-pipe-date-pipe and every
    // transfer of that money on that day was the same transfer.
    await wipe();
    await loadPeople(); await loadAccounts();
    r = await importDataToDB({
      accounts: [
        { id: 'f-cur', name: 'Current', type: 'bank', opening: 1000 },
        { id: 'f-pot', name: 'Savings pot', type: 'savings', opening: 0 },
        { id: 'f-biz', name: 'Business', type: 'business', opening: 0 }
      ],
      transfers: [
        { id: 't1', fromId: 'f-cur', toId: 'f-pot', amount: 200, date: '2026-10-04' },
        { id: 't2', fromId: 'f-biz', toId: 'f-cur', amount: 200, date: '2026-10-04' }
      ]
    }, 'merge');
    t('sameMoneyTwoTransfers', { i: r.imported, s: r.skipped }, { i: 5, s: 0 });
    t('bothLegsMoved', (await accountBalances()).map((b) => b.name + '=' + b.balance).sort(),
      ['Business=-200', 'Current=1000', 'Savings pot=200']);

    // And the case the key exists for: the same file twice still collapses.
    const twice = await importDataToDB({
      accounts: [{ id: 'f-cur2', name: 'Current', type: 'bank', opening: 1000 }],
      spend: [{ id: 's1', title: 'Tesco', amount: 40, date: '2026-10-03', category: 'Groceries' }]
    }, 'merge');
    const twice2 = await importDataToDB({
      accounts: [{ id: 'f-cur3', name: 'Current', type: 'bank', opening: 1000 }],
      spend: [{ id: 's2', title: 'Tesco', amount: 40, date: '2026-10-03', category: 'Groceries' }]
    }, 'merge');
    t('theSameFileTwiceSkips', twice2.skipped, 2);
    t('andLeavesOneRow', (await getAll('spend')).length, 1);

    // A different account is a different row even when everything else agrees:
    // the same £40 of Tesco paid from the card and from cash.
    await wipe();
    await loadPeople(); await loadAccounts();
    r = await importDataToDB({
      accounts: [
        { id: 'a-bank', name: 'Current', type: 'bank', opening: 100 },
        { id: 'a-cash', name: 'Cash', type: 'cash', opening: 20 }
      ],
      spend: [
        { id: 'x1', title: 'Tesco', amount: 40, date: '2026-10-06', category: 'Groceries', accountId: 'a-bank' },
        { id: 'x2', title: 'Tesco', amount: 40, date: '2026-10-06', category: 'Groceries', accountId: 'a-cash' }
      ]
    }, 'merge');
    t('sameSpendTwoAccounts', { i: r.imported, s: r.skipped }, { i: 4, s: 0 });
    return { checks: Object.keys(out).length, failures: Object.entries(out).filter(([, v]) => !v.pass).map(([k]) => k), detail: out };
  `);
  check('the same shop in two categories is two rows, not one',
    merge.detail.sameShopTwoCategories.pass && merge.detail.bothCategoriesSurvive.pass, merge.detail);
  check('the same spend by two people is two rows',
    merge.detail.sameSpendTwoPeople.pass && merge.detail.bothPeopleSurvive.pass, merge.detail);
  check('two transfers between different accounts are two transfers',
    merge.detail.sameMoneyTwoTransfers.pass && merge.detail.bothLegsMoved.pass, merge.detail);
  check('the same spend from two accounts is two rows',
    merge.detail.sameSpendTwoAccounts.pass, merge.detail);
  check('and the same file imported twice still collapses',
    merge.detail.theSameFileTwiceSkips.pass && merge.detail.andLeavesOneRow.pass, merge.detail);
  check('and every one of those passed', merge.failures.length === 0, merge.failures);

  console.log('\n# transactions: commit, and one payment');
  const tx = await run(`
    const out = {};
    const t = (label, got, want) => { out[label] = { got: JSON.stringify(got), want: JSON.stringify(want), pass: JSON.stringify(got) === JSON.stringify(want) }; };
    const wipe = () => new Promise((r) => { openDB().then((d) => {
      const ns = [...d.objectStoreNames];
      const t2 = d.transaction(ns, 'readwrite');
      ns.forEach((n) => t2.objectStore(n).clear());
      t2.oncomplete = () => r();
    }); });

    // 1. A write only resolves once it has committed. The old helpers resolved
    //    on the request, which succeeds before the transaction does — so a
    //    quota failure at commit reported success and left nothing on disk.
    await wipe();
    await loadPeople(); await loadAccounts();
    const id = await addItem('spend', { title: 'Committed', amount: 5, date: '2027-01-01', category: 'Groceries' });
    const readBack = (await getAll('spend')).find((r) => r.id === id);
    t('aWriteIsOnDiskWhenItResolves', !!(readBack && readBack.title === 'Committed'), true);
    const up = await updateItem('spend', { ...readBack, amount: 6 });
    t('anUpdateIsOnDiskWhenItResolves', (await getAll('spend')).find((r) => r.id === id).amount, 6);
    await deleteItem('spend', id);
    t('aDeleteIsOnDiskWhenItResolves', (await getAll('spend')).length, 0);

    // 2. Paying a recurring bill writes both rows in one transaction. Two
    //    separate ones let a suspension land between them, which left the next
    //    occurrence created and the original still unpaid — the same bill twice.
    await wipe();
    await loadPeople(); await loadAccounts();
    const rent = await addItem('due', { title: 'Rent', amount: 900, dueDate: '2027-01-05', category: 'Housing', frequency: 'monthly', recurring: true });
    await markDuePaid((await getAll('due')).find((x) => x.id === rent), null);
    const rows = (await getAll('due')).filter((x) => x.title === 'Rent');
    t('payingLeavesTwoRows', rows.length, 2);
    t('theOldOnePaid', rows.filter((r) => r.dueDate === '2027-01-05').every((r) => r.paid === true), true);
    t('theNewOneUnpaid', rows.filter((r) => r.dueDate === '2027-02-05').every((r) => r.paid === false), true);
    // A bill told to stop, paid on its last month, ends.
    const sub = await addItem('due', { title: 'Gym', amount: 42, dueDate: '2027-09-05', category: 'Health', frequency: 'monthly', recurring: true, repeatUntil: '2027-09-30' });
    await markDuePaid((await getAll('due')).find((x) => x.id === sub), null);
    t('aStoppedBillEnds', (await getAll('due')).filter((x) => x.title === 'Gym').map((x) => x.dueDate), ['2027-09-05']);

    // 3. A replace import keeps a copy, and restore brings it back.
    localStorage.removeItem('sorted-sync-backup');
    await wipe();
    await loadPeople(); await loadAccounts();
    await addItem('spend', { title: 'Mine', amount: 42, date: '2026-09-01', category: 'Groceries' });
    await new Promise(r => setTimeout(r, 400));
    pendingImport = { spend: [{ title: 'Theirs', amount: 5, date: '2026-09-02', category: 'Groceries' }] };
    await commitImport('replace', null);
    t('replaceImported', (await getAll('spend')).map((r) => r.title), ['Theirs']);
    t('aCopyWasKept', !!syncBackup(), true);
    const res = await restoreSyncBackup();
    t('restoreBringsItBack', (await getAll('spend')).map((r) => r.title), ['Mine']);
    t('restoreSucceeded', !!(res && res.ok), true);
    return { checks: Object.keys(out).length, failures: Object.entries(out).filter(([, v]) => !v.pass).map(([k]) => k), detail: out };
  `);
  check('a write is on disk when it resolves',
    tx.detail.aWriteIsOnDiskWhenItResolves.pass
    && tx.detail.anUpdateIsOnDiskWhenItResolves.pass
    && tx.detail.aDeleteIsOnDiskWhenItResolves.pass, tx.detail);
  check('paying a recurring bill leaves two rows, one paid and one not',
    tx.detail.payingLeavesTwoRows.pass && tx.detail.theOldOnePaid.pass
    && tx.detail.theNewOneUnpaid.pass, tx.detail);
  check('and a bill told to stop ends', tx.detail.aStoppedBillEnds.pass, tx.detail);
  check('a replace import keeps a copy and restore brings it back',
    tx.detail.replaceImported.pass && tx.detail.aCopyWasKept.pass
    && tx.detail.restoreBringsItBack.pass && tx.detail.restoreSucceeded.pass, tx.detail);
  check('and every one of those passed', tx.failures.length === 0, tx.failures);

  console.log('\n# the guessers on receipts that were reading wrong');
  const wrongAmounts = await run(`
    const out = {};
    // Every one of these is a figure or a card number the app got wrong, taken
    // from a real receipt layout. The full text is the point: the amount is
    // chosen by what the *other* lines say as much as by its own.
    const cases = [
      // A loyalty balance and a coupon both outranked the real total, because
      // bare "balance" and "amount" were weighted above plain "total".
      ['SAINSBURYS\\nTOTAL 18.40\\nAMOUNT SAVED 1.50\\nVISA 18.40\\n', 18.40, null],
      ['NECTAR\\nTOTAL 8.60\\nYOUR BALANCE 105.55\\nCASH 10.00\\n', 8.60, null],
      ['SHOP\\nPOINTS EARNED 42\\nTOTAL 3.20\\n', 3.20, null],
      // A figure with an OCR substitution in it was matched as two numbers.
      ['SHOP\\nTOTAL GBP 1O.78\\nVISA **** 4242\\n', null, '4242'],
      ['SHOP\\nTOTAL 11.7B\\nCASH 12.00\\n', 11.78, null],
      // A total printed without pence matched nothing at all.
      ['BIG SHOP\\nTOTAL 1,234\\nCASH 1,300\\n', 1234, null],
      // A refund was recorded as spending.
      ['SHOP\\nREFUND -12.99\\nTOTAL -12.99\\nVISA\\n', -12.99, null],
      // A VAT number printed after the payment block was read as the card.
      ['TESCO\\nMILK 1.90\\nTOTAL GBP 11.78\\nVISA DEBIT ****1234\\nAUTH 887123\\nVAT NO 123 4567 89\\n', 11.78, '1234'],
      // As was a date.
      ['TESCO\\nTOTAL 11.78\\nVISA DEBIT ****1234\\n28/09/2026\\n', 11.78, '1234'],
      // And these must still work.
      ['SHOP\\nTOTAL 12.99\\nCASH 20.00\\nCHANGE 7.01\\n', 12.99, null],
      ['SHOP\\nCARD ****9876\\nTOTAL 5.00\\n', 5, '9876'],
      ['EVERYDAY CARD\\nCARD 4242\\nTOTAL 12.75\\n', 12.75, '4242'],
      ['TESCO STORES LTD\\nTOTAL 12.75\\n', 12.75, null],
      ['SHOP\\nSUBTOTAL 20.00\\nDISCOUNT 2.00\\nTOTAL 18.00\\n', 18.00, null],
      ['SHOP\\nTOTAL\\n18.40\\nCASH 20.00\\n', 18.40, null]
    ];
    cases.forEach(([text, amount, card], i) => {
      const key = 'case' + i;
      out[key] = {
        amount: guessAmountFromText(text),
        card: guessCardLast4(text),
        wantAmount: amount,
        wantCard: card
      };
    });
    return out;
  `);
  const wrong = Object.entries(wrongAmounts).filter(([, v]) =>
    (v.wantAmount !== null && Math.abs(v.amount - v.wantAmount) > 0.001)
    || v.card !== v.wantCard);
  check('every one of those receipts reads its amount and its card right',
    wrong.length === 0, wrong.map(([k, v]) => k + ' got ' + v.amount + '/' + v.card + ' want ' + v.wantAmount + '/' + v.wantCard));

  // --- income: store, sanitise, arithmetic and round trip ---
  {
      {
      // A section of its own block, because it declares locals with ordinary names
      // and a redeclaration anywhere in runSuite is a syntax error.
        console.log('\n# income: what is refused, what survives, and what it moves');
    
        // Income is the one thing that arrives rather than leaves; a row that
        // validates but does nothing is the same as one that does not exist. addItem
        // writes what it is given; the guard on a file from anywhere is the import
        // path, where the sanitiser runs before anything is written.
        const incomeStore = await run(`
          const out = {};
          const t = (label, got) => { out[label] = (got === true); };
          const wiper = () => new Promise((resolve) => { openDB().then((d) => {
            const ns = [...d.objectStoreNames];
            const tx = d.transaction(ns, 'readwrite');
            ns.forEach((n) => tx.objectStore(n).clear());
            tx.oncomplete = () => resolve();
          }); });
          await wiper();
          await loadPeople(); await loadAccounts();
          const read = async () => getAll('income');
          const keep = async (row) => {
            const id = await addItem('income', row);
            return (await read()).find((r) => r.id === id);
          };
          const good = await keep({ title: 'Salary', amount: 1000, date: '2026-09-01', category: 'salary' });
          t('acompleteRowIsStored', !!good && good.amount === 1000 && good.date === '2026-09-01' && good.category === 'salary');
          for (const value of ['monthly', 'annually', 'weekly', 'once']) {
            const r = await keep({ title: 'freq ' + value, amount: 1, date: '2026-09-02', frequency: value });
            t(value + 'FrequencyIsStored', r.frequency === value);
          }
          const oneOff = await keep({ title: 'one off', amount: 1, date: '2026-09-02' });
          t('afrequencyIsOptional', oneOff.frequency === undefined);
          const ada = await addItem('people', { name: 'Ada', colour: '#f00' });
          await loadPeople();
          const mine = await keep({ title: 'mine', amount: 1, date: '2026-09-02', personId: ada });
          t('apersonCanBeSet', mine.personId === ada);
          const nobody = await keep({ title: 'nobody', amount: 1, date: '2026-09-02' });
          t('apersonIsOptional', nobody.personId === undefined || nobody.personId === null);
          t('everyRowIsReturned', (await read()).length === 8);
          return { failures: Object.keys(out).filter((k) => !out[k]) };
        `);
        check('a complete income row is stored, date and category and all', incomeStore.failures.length === 0, incomeStore.failures);
    
        // The guard is on the import path, where a file from anywhere is trusted
        // rather less than the app's own form.
        const incomeGuard = await run(`
          const out = {};
          const t = (label, got) => { out[label] = (got === true); };
          const wiper = () => new Promise((resolve) => { openDB().then((d) => {
            const ns = [...d.objectStoreNames];
            const tx = d.transaction(ns, 'readwrite');
            ns.forEach((n) => tx.objectStore(n).clear());
            tx.oncomplete = () => resolve();
          }); });
          await wiper();
          const importOne = async (row) => {
            pendingImport = { income: [row] };
            try { await commitImport('replace', null); } catch (err) { /* a nothing-to-import file throws; that is still a refusal */ }
            return getAll('income').then((rows) => rows.slice());
          };
          const rows = await importOne({ title: 'Salary', amount: 1000, date: '2026-09-01', category: 'salary' });
          t('agoodRowImports', rows.length === 1 && rows[0].category === 'salary');
          // Refusal on the import path: each of these is a row the arithmetic
          // has no way to place, so it is rejected rather than stored quietly wrong.
          for (const [label, row] of [
            ['noTitle', { amount: 5, date: '2026-09-01' }],
            ['noAmount', { title: 'x', date: '2026-09-01' }],
            ['noDate', { title: 'x', amount: 5 }],
            ['aZeroAmount', { title: 'x', amount: 0, date: '2026-09-01' }],
            ['anegativeAmount', { title: 'x', amount: -5, date: '2026-09-01' }],
            ['atextAmount', { title: 'x', amount: 'not a number', date: '2026-09-01' }],
            ['abadDate', { title: 'x', amount: 5, date: 'not a date' }],
            ['aDateWithATime', { title: 'x', amount: 5, date: '2026-09-01T12:00:00Z' }],
            ['aDateWithASlash', { title: 'x', amount: 5, date: '01/09/2026' }],
            ['anImpossibleDate', { title: 'x', amount: 5, date: '2026-02-31' }]
          ]) {
            // A refused import leaves the store exactly as it was; if the extra
            // row had slipped in, the count would have grown, so unchanged is the
            // evidence we need.
            const before = (await getAll('income')).length;
            const after = await importOne(row);
            t(label + 'IsRefusedOnImport', after.length === before);
          }
          // Every category the form offers survives the trip: this is the 2.65.0
          // bug, where the form offered Business and the sanitiser accepted only
          // salary, sale and other, so a backup quietly rewrote every business row.
          for (const value of ['salary', 'sale', 'business', 'other']) {
            const r = await importOne({ title: 'inc ' + value, amount: 1, date: '2026-09-02', category: value });
            t('theFormOffers' + value + 'AndItSurvives', r.length === 1 && r[0].category === value);
          }
          const unknown = await importOne({ title: 'junk', amount: 1, date: '2026-09-02', category: 'made up' });
          t('anUnknownCategoryFallsBackToOther', unknown.length === 1 && unknown[0].category === 'other');
          const empty = await importOne({ title: 'empty', amount: 1, date: '2026-09-02', category: '' });
          t('noCategoryFallsBackToOther', empty.length === 1 && empty[0].category === 'other');
          // Frequency: monthly and annually kept, anything else dropped.
          for (const value of ['monthly', 'annually']) {
            const r = await importOne({ title: 'freq ' + value, amount: 1, date: '2026-09-02', frequency: value });
            const justAdded = r.find((x) => x.title === 'freq ' + value);
            t(value + 'FrequencySurvivesImport', justAdded && justAdded.frequency === value);
          }
          for (const value of ['weekly', 'once', 'daily', 'rubbish']) {
            const r = await importOne({ title: 'freq ' + value, amount: 1, date: '2026-09-02', frequency: value });
            const justAdded = r.find((x) => x.title === 'freq ' + value);
            t(value + 'FrequencyIsDroppedOnImport', justAdded && justAdded.frequency === undefined);
          }
          return { failures: Object.keys(out).filter((k) => !out[k]) };
        `);
        check('a good row imports, and every row the arithmetic cannot place is refused', incomeGuard.failures.length === 0, incomeGuard.failures);
    
        // What income actually moves.
        const incomeEffect = await run(`
          const out = {};
          const t = (label, got) => { out[label] = (got === true); };
          const wiper = () => new Promise((resolve) => { openDB().then((d) => {
            const ns = [...d.objectStoreNames];
            const tx = d.transaction(ns, 'readwrite');
            ns.forEach((n) => tx.objectStore(n).clear());
            tx.oncomplete = () => resolve();
          }); });
          await wiper();
          await loadPeople(); await loadAccounts();
          const acc = await addItem('accounts', { name: 'Current', type: 'bank', opening: 500 });
          await addItem('income', { title: 'Salary', amount: 1000, date: '2026-09-01', category: 'salary', accountId: acc });
          const wage = await addItem('income', {
            title: 'Wage', amount: 400, category: 'salary', accountId: acc, frequency: 'monthly',
            date: localISO(new Date(new Date().getFullYear(), new Date().getMonth() - 3, 1))
          });
          await new Promise((r) => setTimeout(r, 500));
          const balances = await accountBalances();
          const row = balances.find((b) => b.id === acc);
          t('incomeArrivesInTheBalance', row.balance === 500 + 1000 + 400);
          t('incomeIsItsOwnPartOfIt', row.income === 1000 + 400);
          const f = await buildForecast(6, 0);
          const ahead = f.series.filter((p) => !p.actual);
          const firsts = ahead.filter((p) => p.d.getDate() === 1);
          t('aProjectedWageLandsOnItsOwnDay', firsts.some((p) => p.income === 400));
          t('apastMonthIsNeverProjected', f.series.filter((p) => p.actual).every((p) => p.income === 0));
          const rows = exportMovementRows(await getAllData());
          t('incomeBecomesARow', rows.filter((r) => r.kind === 'Income').length === 2);
          t('theAmountIsTheAmount', rows.filter((r) => r.kind === 'Income').some((r) => r.amount === 400));
          t('andItIsInTheFile', (await buildExport('csv')).text.indexOf('Wage') >= 0);
          return { failures: Object.keys(out).filter((k) => !out[k]) };
        `);
        check('income arrives in the balance rather than leaving it', incomeEffect.failures.length === 0, incomeEffect.failures);
    
        // The round trip that produced the 2.65.0 bug in the first place.
        const incomeBackup = await run(`
          const out = {};
          const t = (label, got) => { out[label] = (got === true); };
          const wiper = () => new Promise((resolve) => { openDB().then((d) => {
            const ns = [...d.objectStoreNames];
            const tx = d.transaction(ns, 'readwrite');
            ns.forEach((n) => tx.objectStore(n).clear());
            tx.oncomplete = () => resolve();
          }); });
          await wiper();
          await loadPeople(); await loadAccounts();
          await addItem('income', { title: 'Contract', amount: 900, date: '2026-09-01', category: 'business' });
          await new Promise((r) => setTimeout(r, 400));
          const parsed = JSON.parse((await buildExport('json')).text);
          t('theCategoryTravels', parsed.income[0].category === 'business');
          pendingImport = parsed;
          await commitImport('replace', null);
          t('andItComesBackUnchanged', (await getAll('income')).map((r) => r.category).join() === 'business');
          pendingImport = { income: [{ title: 'x', amount: 1, date: '2026-09-02', category: 'made up' }] };
          await commitImport('replace', null);
          t('aHandEditedUnknownFallsBack', (await getAll('income')).map((r) => r.category).join() === 'other');
          return { failures: Object.keys(out).filter((k) => !out[k]) };
        `);
        check('a business category travels through a backup and comes back unchanged', incomeBackup.failures.length === 0, incomeBackup.failures);
    
        // (validated above)
      }
    
  }
  // ---------------------------------------------------------------------------
  // The three tweaks: the account card's own lines, the removed adjustment
  // field, and a Total Money card that refuses to invent money before the
  // records begin.
  console.log('\n# account lines, no adjustment field, and no money before the records');
  const tweaks = await run(`
    const out = {};
    const wipe = () => new Promise((resolve) => { openDB().then((d) => {
      const ns = [...d.objectStoreNames];
      const tx = d.transaction(ns, 'readwrite');
      ns.forEach((n) => tx.objectStore(n).clear());
      tx.oncomplete = () => resolve();
    }); });
    await wipe();
    await loadPeople(); await loadAccounts();
    const now = new Date();
    const day = (n) => localISO(new Date(now.getFullYear(), now.getMonth(), n));
    const acc = await addAccount('Bank', 'bank', 5000, null);
    await loadAccounts();
    await addItem('spend', { title: 'Shop', amount: 120, date: day(4), category: 'Groceries', accountId: acc });
    const billId = await addItem('due', { title: 'Rent', amount: 800, dueDate: day(3), category: 'Housing', accountId: acc });
    await markDuePaid(await getItem('due', billId), null);
    await new Promise((r) => setTimeout(r, 500));

    currentPage = 'savings';
    await renderPage();
    await new Promise((r) => setTimeout(r, 900));
    const row = document.querySelector('.item-row--account');
    out.accountLines = [...row.querySelectorAll('.item-meta')].map((e) => e.textContent.trim());

    await openAccountSetup(acc);
    await new Promise((r) => setTimeout(r, 500));
    out.hasAdjustmentField = !!document.getElementById('account-adjustment');
    out.hasBalanceNow = !!document.getElementById('account-opening');
    closeModal();

    dashViewedDate = new Date(now.getFullYear(), now.getMonth(), 1);
    currentPage = 'dashboard';
    await renderPage();
    await new Promise((r) => setTimeout(r, 900));
    out.nowCard = document.querySelector('.total-card').innerText.replace(/\\n/g, ' | ');
    dashViewedDate = new Date(now.getFullYear(), now.getMonth() - 3, 1);
    await renderPage();
    await new Promise((r) => setTimeout(r, 900));
    out.pastCard = document.querySelector('.total-card').innerText.replace(/\\n/g, ' | ');

    await addItem('spend', { title: 'Old', amount: 30, date: localISO(new Date(now.getFullYear(), now.getMonth() - 4, 4)), category: 'Groceries', accountId: acc });
    dashViewedDate = new Date(now.getFullYear(), now.getMonth() - 3, 1);
    await renderPage();
    await new Promise((r) => setTimeout(r, 900));
    out.backdatedCard = document.querySelector('.total-card').innerText.replace(/\\n/g, ' | ');
    return out;
  `);
  check('the account row puts Spent and Bills on separate lines',
    tweaks.accountLines.includes('Spent £120.00') && tweaks.accountLines.includes('Bills £800.00'),
    tweaks);
  check('the account editor has no Adjustments field, but keeps Balance now',
    tweaks.hasAdjustmentField === false && tweaks.hasBalanceNow === true, tweaks);
  check('the Total Money card still shows a balance at the current month',
    /£/.test(tweaks.nowCard) && !/No records before/.test(tweaks.nowCard), tweaks.nowCard);
  check('and shows nothing for months before the records begin',
    /No records before/.test(tweaks.pastCard) && tweaks.pastCard.includes('\u2014'), tweaks.pastCard);
  check('a genuinely backdated row brings its month back',
    !/No records before/.test(tweaks.backdatedCard) && /£/.test(tweaks.backdatedCard), tweaks.backdatedCard);

  return fail;
}

// One suite, one session, but kept in a list so the teardown does not have to
// know that. Registered the moment the session exists, so no throw between
// there and the first check can lose it.
const sessionClosers = [];
async function closeSessions() {
  while (sessionClosers.length) {
    const close = sessionClosers.pop();
    try { await close(); } catch (err) { /* the driver is going away anyway */ }
  }







  console.log(`\n${pass} passed, ${fail} failed`);

}

// Order matters and is the whole point:
//   1. close the browser session  — this is what makes chrome exit
//   2. stop the driver           — withDriver's own finally
//   3. exit
//
// Killing the driver before closing the session is what left browsers orphaned
// to init in the first place, and process.exit() inside the try would skip the
// session close entirely, which is exactly the bug this replaces.
let exitCode = 1;
withDriver(async ({ base, driver }) => {
  // startDriver returns as soon as the child exists; the port is not accepting
  // yet. Without this the first POST races the driver coming up, and the run
  // dies with ECONNREFUSED on a port that is nobody's fault. harness.js has
  // waited here all along; the suites that use withDriver directly did not,
  // which is a flake that looks like a broken app.
  await driver.ready;
  let failures = 1;
  try {
    failures = await runSuite(base);
  } finally {
    await closeSessions();
  }
  exitCode = failures ? 1 : 0;
}).catch((e) => {
  console.error(e);
  exitCode = e && e.code === 'STALE_BROWSERS' ? 2 : 1;
}).finally(() => {
  process.exit(exitCode);
});