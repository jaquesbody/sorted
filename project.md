Last updated 28th September 2026

**Project: Sorted**

**1. Status**
- Phase: v2 rewrite complete and running on desktop, browser and Android. Iterating with visual/UX feedback; v2.2.0 adds a "Who Spent What" report splitting each person's bar between what they spent and what they owe, cuts six lines of explanatory copy from Settings, and takes Tesseract and pdf.js off the critical path. v2.1.0 added people and moved new rows onto UUIDs.
- Formerly Saved — dropped entirely, no merger, Sorted supersedes it.

**2. Problem, User, Outcome**
- Problem: family finance is scattered across receipts, bills and memory — spending goes untracked, savings targets drift, bills get missed.
- User: self, self-hosting across Android phone and laptop/Pi. Architecture built to be forkable for other self-hosters later.
- Outcome: easily check and track your spending, take the hassle out of saving, never miss a bill.

**3. Minimum v1 Scope**
- Dashboard: spend, savings, due — visible without scrolling, order Spend, Due, Savings
- Spend/Savings/Due pages: itemised, date-ordered, edit/confirm/reorder/filter
- Phone: capture-only (photo or manual entry), auto-downloads to Downloads folder, one-tap refresh to view synced data
- Desktop: full editor — OCR (Tesseract.js), categorisation, Brave tips, auto-ingest from synced folder via File System Access API
- PWA daily notification (Android-only)

**4. Explicitly Out of Scope (v1)**
- Email forwarding of invoices/bills — no static-site path without a real backend, revisit as a deliberate protocol.md 3.3 deviation later
- Multi-layout dashboard, government announcements, granular receipt-level search — all nice-to-haves, not started
- Per-person accounts/logins. Multi-user arrived in v2.1.0, but as *attribution* — a name and a colour on an entry, with anyone able to switch who they're being — so the no-backend, no-login stance in §5 still holds. Real accounts would reverse it.

**5. Architecture Decisions**
- No backend, no cloud storage, no login
- OCR: Tesseract.js, client-side
- Brave API: user's own key, local storage, popup with ignore option
- Sync: Syncthing-watched Downloads folder, one-way auto-download from phone (anchor download attribute — subfolder nesting unverified, test on-device first), desktop watches via File System Access API (desktop-only), phone viewer is manual one-tap refresh
- Notifications: Web Notifications API in an installed PWA, Android-only, flagged on the GitHub page
- Data model: recurring flag + frequency on Spend/Due items. One item per uploaded document (sub-lines for itemised charges within a single bill, not separate items). Direct Debit collections on a bill are payments, not separate charges. Recurring + DD items default to paid=true on upload, confirm button overrides.
- Receipts are stored on the item itself as a downscaled data URL (max 1400px, JPEG), not as a file reference — there is no file system to point at in a browser or a WebView. PDFs are flattened to a first-page image, which is what OCR reads and what's shown, so one copy serves both. Receipt images ride in the JSON export, so a backup stays self-contained; they are not part of the merge-dedupe key.
- A paid bill leaves exactly one record: the copy `markDuePaid` writes into Spend, keeping the original `dueDate`. The Bills Due month view reads those back as its history, which is why paying a bill leaves a "Paid" row in the month it was due rather than in the month you paid it. Each occurrence therefore appears once per month — either paid in Spend or still owing in the due store — with no double count and no gap.
- Overdue bills ride along in the month view, but only when looking at now or the future. A past month is a record of what it held; dragging today's overdue pile into it made the history unreadable.
- Theme and passcode live in localStorage, not IndexedDB: they're device settings, not finance data, and the passcode has to be readable synchronously at launch to decide whether to show the lock screen.
- Passcode is stored as a salted SHA-256 (crypto.subtle, with a non-crypto fallback for insecure contexts). It is a shoulder-surfing screen only — the hash sits next to the data on the same device, so it is documented as such rather than sold as encryption.
- Idle locking uses a `lastActivity` timestamp rather than counting events, so a backgrounded WebView that has its timers throttled can't drift the clock; a backgrounded app is re-checked on `visibilitychange`.
- People are attribution, not accounts. A person is a name and a colour, and "who's using the app" is a localStorage setting like the theme — anyone can switch it, so it is a label, not a login. It exists because a shared family device otherwise cannot say whose spending is whose, and because "who paid for it" cannot be answered from a bill's own record.
- "Who's using the app" stamps new entries and bill payments; the form's person field is pre-filled from it and still overridable, so the common case costs no taps and the odd case (adding a bill in someone else's name) costs one dropdown. Paying a bill records the *payer*, not the bill's owner, because that is the half the bill itself can't answer.
- The person filter sits on Spend and Bills, one shared selection across both, so switching person in one place doesn't leave the other quietly showing a different slice. The Spend totals follow it (it's a filter on the same data); the Bills *Total Due* card deliberately doesn't, because a card dropping to £0 because of a filter reads as "nothing owed". Dashboard and Reports stay household-wide for the same reason — the household view is what they're for.
- Rows are new rows get a `crypto.randomUUID()` id rather than the store's `autoIncrement` counter. Two devices counting from 1 would eventually hand out the same number, and sync is a stated goal — better to pay that cost now than re-key every row later. The stores keep the key generator they were created with, so this needs no schema change; `put`/`add` with an explicit key simply never invokes it.
- Legacy rows have *numeric* keys, and a data attribute always hands an id back as a string — `"3"` is not the key `3`. `normaliseId()` turns a numeric string back into a number on read and delete, without which every row in an existing install silently fails to open.
- "Who Spent What" gives one bar per person: the length is that person's share of the household total, so the bars compare against each other, and the split inside each bar is their own spend-to-bills ratio, which the length alone can't show. Unattributed money is kept as its own "Anyone" row rather than dropped — the card rolls up the same spend and bills as the two category cards above it, and quietly leaving it out would make the three disagree.
- No person dot on the Who Spent What rows. The name is the identity, the fixed 104px name column already truncated longer names once a dot was added, and a third colour sitting beside a two-colour bar invites reading it as a third bar colour. The dot stays on the Spend/Bills rows, where there is no bar to confuse it with.
- Tesseract (63KB) and pdf.js (320KB) load on demand via `loadScriptOnce()`, when a receipt is picked, not on every page load. `defer` on the script tags was tried first and did almost nothing (85 -> 86): deferred scripts still run in order, so app.js waited on the bundles regardless. Fetching them only when needed cut the first load from 577KB to 200KB, LCP from 4.1s to 2.0s, and performance 85 -> 99.
- People come first on import, in both modes, and are matched by name: ids are minted per device, so a name is the only identity that survives the trip. Every `personId` in the file is then translated to the local id of whoever it matched, and an unmatched reference becomes unattributed rather than a dangling id the UI would render as a blank. `getAllData()` is driven off `STORES` for the same reason — people missing from a backup would strip every entry's attribution on the next restore.

**6. Sample Data**
- Co-op Energy/Octopus electricity bill, two-part (screenshots provided)
- Spar fuel receipt (photo provided)
- One manual cash entry: 2 pints of beer, £5 each, cash, entertainment, single £10 item

**7. Design System**
- Shared base stylesheet source: jaquesbody/know repo, static/css/main.css — canonical copy. New projects duplicate the token/reset/typography/utility sections into their own repo (self-contained, no cross-repo runtime dependency); project-specific sections (e.g. "Portfolio homepage," "Under construction") are excluded from the copy, not carried forward.
- Sorted accent: #3d8bfd (blue) — chosen distinct from Know's #ff5c00 and the portfolio identity green #0EDA29.

**8. Icon Convention (exception to non-goal 8)**
- Non-goal 8 rules out icons except standard buttons (save/upload/edit). Exception carved out: compact status indicators where text would be repetitive or cramped at scale (e.g. many items in a list) may use a single, intuitive icon instead of a text label, provided the icon isn't a clickable action.
- Confirmed: outlined tick-box, fills solid when confirmed. This is the confirm/sign-off action itself, already covered by the original non-goal exception, not a new one. Drawn as an inline SVG rather than a "✓" character — the glyph rendered thin and inconsistently placed, and inside a circle it read as a radio button rather than a confirmation.
- Recurring: grey circular-arrow icon, present only on items that are recurring (absence = one-off, so no risk of reading as an inert button). Tap/hover reveals "recurring spend."
- Receipt: paperclip on every spend/bill row. Dimmed with no image behind it, where it is the way in to attach one; full strength when there's a photo to open. Shown on all rows rather than only those with photos so the row doesn't change shape once one is added.
- Person: a coloured dot with the first letter, in the row's action column beside the paperclip. A full name would not fit at that width, and the letter is what identifies it. This is the one place a non-action, coloured mark sits in a list row, and it is deliberately not one of the app's semantic colours — a red dot beside a number reads as "overdue" — so `PERSON_COLOURS` in db.js is a separate identity palette. Letter colour is picked from the dot's own luminance rather than assumed, so every swatch stays legible.

**9. Layout Notes**
- Pages have no `<h1>`. The nav bar already says where you are, and on a phone the heading was the single biggest thing between the top bar and the content. Each page's one control — the month navigator, the report range chips, a lone action button — sits in a toolbar row instead.
- The month selector is one component on three pages at a fixed width (`--month-nav-width`), because the same control in two widths reads as two different controls. The label is a button: tapping it returns to the current month, which is otherwise a long walk back with ▶.
- Category bars are a grid with a fixed name column, so a long name like "Entertainment" can't squeeze the bar it sits next to; the name truncates and keeps the full text in a title attribute. Bars carry the colour of what they break down — spending blue, bills red, savings green — because "Bills by Category" in spending blue read as a spending chart.
- Bills Due is scoped to a month because a bill is only ever stored with the date it's currently due — without stepping forward there was no way to see what the following months hold.
- The trend chart's month in view is marked with a band behind its column. That band needed its own token: `--bg-surface` works in dark but is the same white as the card in light, so the highlight vanished in the light theme.
- "Who's using the app" is a chip in the chrome, not in a page: the top bar on a phone, the sidebar header on desktop (only one is ever visible). It belongs in the persistent furniture because an attribution you have to go looking for is an attribution you forget to set. The person filter is a second row of the existing filter bar rather than a control of its own, with a negative top margin so the two read as one control on two axes.
- On a phone the sidebar collapses to a 60px icon rail, where `.nav-item span` is `display: none` — which took the accessible name with it, leaving six nameless icon buttons. They carry `aria-label` for the rail; the bottom bar keeps its visible text.
- The person dot sits in the row's action column rather than the meta line, so it never disturbs the date/category text and every compact indicator stays in one place. It costs about 32px of a phone row's width, which is enough to push a long title ("Electricity: Co-op Energy") onto a second line. Accepted: a title that wraps is a taller row, whereas putting the dot in the meta line would have wrapped the meta line too, and the meta line is shorter.

**10. Open Questions**
- Confirmed: no Saved repo exists, only a portfolio stub on jaquesbody.github.io.
- Can unlocking identify *who* is using the app? Raised after v2.1.0. Attribution today is a free choice — the top-bar chip can be switched by anyone — so an unlock that named the person would be the one thing that ties the two together. The blocker is the passcode's honest framing: §5 documents it as a shoulder-surfing screen, not encryption, and a per-person PIN would quietly turn that into a credential. A 4-digit family PIN is not a security boundary, and anyone can still switch the chip afterwards, so it would identify rather than authenticate. Needs a decision before any code.

**11. Outstanding Tasks**
- Update jaquesbody.github.io: rename "Saved" card to "Sorted," update description to reflect actual outcome, keep status "Under construction."
- Generate a banner logo (wordmark, matching Know's wordmark-know.svg pattern) and a single-letter favicon for Sorted, based on the jaquesbody portfolio and Know examples. Extend this into a standing process, applying the same asset pair to every future project, not a one-off.
- Receipt images sit in the export, so a backup with several dozen receipts is a large JSON file. Worth a size check against a real dataset before relying on export as the only off-device copy.
