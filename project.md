Last updated 27th September 2026

**Project: Sorted**

**1. Status**
- Phase: v2 rewrite complete and running on desktop, browser and Android. Iterating with visual/UX feedback; v2.0.5 adds light/dark, a passcode lock, stored receipts, and a month view on Bills Due.
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
- Multi-layout dashboard, government announcements, granular receipt-level search, multi-user — all nice-to-haves, not started

**5. Architecture Decisions**
- No backend, no cloud storage, no login
- OCR: Tesseract.js, client-side
- Brave API: user's own key, local storage, popup with ignore option
- Sync: Syncthing-watched Downloads folder, one-way auto-download from phone (anchor download attribute — subfolder nesting unverified, test on-device first), desktop watches via File System Access API (desktop-only), phone viewer is manual one-tap refresh
- Notifications: Web Notifications API in an installed PWA, Android-only, flagged on the GitHub page
- Data model: recurring flag + frequency on Spend/Due items. One item per uploaded document (sub-lines for itemised charges within a single bill, not separate items). Direct Debit collections on a bill are payments, not separate charges. Recurring + DD items default to paid=true on upload, confirm button overrides.
- Receipts are stored on the item itself as a downscaled data URL (max 1400px, JPEG), not as a file reference — there is no file system to point at in a browser or a WebView. PDFs are flattened to a first-page image, which is what OCR reads and what's shown, so one copy serves both. Receipt images ride in the JSON export, so a backup stays self-contained; they are not part of the merge-dedupe key.
- Theme and passcode live in localStorage, not IndexedDB: they're device settings, not finance data, and the passcode has to be readable synchronously at launch to decide whether to show the lock screen.
- Passcode is stored as a salted SHA-256 (crypto.subtle, with a non-crypto fallback for insecure contexts). It is a shoulder-surfing screen only — the hash sits next to the data on the same device, so it is documented as such rather than sold as encryption.
- Idle locking uses a `lastActivity` timestamp rather than counting events, so a backgrounded WebView that has its timers throttled can't drift the clock; a backgrounded app is re-checked on `visibilitychange`.

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

**9. Layout Notes**
- Pages have no `<h1>`. The nav bar already says where you are, and on a phone the heading was the single biggest thing between the top bar and the content. Each page's one control — the month navigator, the report range chips, a lone action button — sits in a toolbar row instead.
- Category bars are a grid with a fixed name column, so a long name like "Entertainment" can't squeeze the bar it sits next to; the name truncates and keeps the full text in a title attribute.
- Bills Due is scoped to a month because a bill is only ever stored with the date it's currently due — without stepping forward there was no way to see what the following months hold. Bills already past their date stay listed in every month view, and the total card names next month's figure so nothing looks lost.

**10. Open Questions**
- Confirmed: no Saved repo exists, only a portfolio stub on jaquesbody.github.io.

**11. Outstanding Tasks**
- Update jaquesbody.github.io: rename "Saved" card to "Sorted," update description to reflect actual outcome, keep status "Under construction."
- Generate a banner logo (wordmark, matching Know's wordmark-know.svg pattern) and a single-letter favicon for Sorted, based on the jaquesbody portfolio and Know examples. Extend this into a standing process, applying the same asset pair to every future project, not a one-off.
- Receipt images sit in the export, so a backup with several dozen receipts is a large JSON file. Worth a size check against a real dataset before relying on export as the only off-device copy.
