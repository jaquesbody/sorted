Last updated 29th August 2026

**Project: Sorted**

**1. Status**
- Phase: Section 1 complete, Section 2 complete (name: Sorted). Section 5 (content) run informally alongside Section 6 build — dashboard and spend list scaffolded, iterating with visual/UX feedback.
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

**6. Sample Data**
- Co-op Energy/Octopus electricity bill, two-part (screenshots provided)
- Spar fuel receipt (photo provided)
- One manual cash entry: 2 pints of beer, £5 each, cash, entertainment, single £10 item

**7. Design System**
- Shared base stylesheet source: jaquesbody/know repo, static/css/main.css — canonical copy. New projects duplicate the token/reset/typography/utility sections into their own repo (self-contained, no cross-repo runtime dependency); project-specific sections (e.g. "Portfolio homepage," "Under construction") are excluded from the copy, not carried forward.
- Sorted accent: #3d8bfd (blue) — chosen distinct from Know's #ff5c00 and the portfolio identity green #0EDA29.

**8. Icon Convention (exception to non-goal 8)**
- Non-goal 8 rules out icons except standard buttons (save/upload/edit). Exception carved out: compact status indicators where text would be repetitive or cramped at scale (e.g. many items in a list) may use a single, intuitive icon instead of a text label, provided the icon isn't a clickable action.
- Confirmed: outlined tick-box, fills solid when confirmed. This is the confirm/sign-off action itself, already covered by the original non-goal exception, not a new one.
- Recurring: grey circular-arrow icon, present only on items that are recurring (absence = one-off, so no risk of reading as an inert button). Tap/hover reveals "recurring spend."

**9. Open Questions**
- Confirmed: no Saved repo exists, only a portfolio stub on jaquesbody.github.io.

**10. Outstanding Tasks**
- Update jaquesbody.github.io: rename "Saved" card to "Sorted," update description to reflect actual outcome, keep status "Under construction."
- Generate a banner logo (wordmark, matching Know's wordmark-know.svg pattern) and a single-letter favicon for Sorted, based on the jaquesbody portfolio and Know examples. Extend this into a standing process, applying the same asset pair to every future project, not a one-off.
