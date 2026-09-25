# Sorted

Easily check and track your spending, saving and bills, all local and private.

**Sorted v2** is a modern rewrite: a dark-themed finance tracker that runs as a desktop app (Electron) and straight in your browser. No backend, no cloud, no login — everything lives in your device's local storage (IndexedDB).

## Screenshots

![Sorted dashboard — spend, bills, and savings at a glance](screenshots/dashboard.png)

![Spend list with month navigation and confirm flow](screenshots/spend.png)

## Features

- Dashboard: spent this month, bills due, savings progress, and a 6-month trend chart
- Spend, Bills Due, and Savings lists — add, edit, confirm, and mark-as-paid
- Reports: spending and bills broken down by category
- Month navigation and status filters
- Export / import your whole dataset as JSON
- Sample data seeds on first run so the app isn't empty

## Run It

### Desktop app (Electron)

    git clone https://github.com/jaquesbody/sorted.git
    cd sorted
    npm install
    npm start

### In a browser

Serve the `renderer` folder with any static file server:

    git clone https://github.com/jaquesbody/sorted.git
    cd sorted
    python3 -m http.server --directory renderer

Then open `http://localhost:8000` in your browser. Same app, minus the native export dialogs (export downloads a JSON file instead).

## Tech Stack

- Vanilla HTML, CSS, and JavaScript — no frameworks
- Electron for the desktop shell
- IndexedDB for local storage
- No dependencies at runtime

## Privacy

No backend, no cloud storage, no login. All data stays on your own device and only leaves it when you export it yourself.

## History

v1 — the original web/PWA with OCR, service worker, and Syncthing sync — lives in the git history and still serves from earlier commits.

## Licence

MIT — see [LICENSE](LICENSE).
