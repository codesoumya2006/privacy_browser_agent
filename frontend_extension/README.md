# Edge Vision Web Assistant — Chrome Extension (Manifest V3)

Side-panel browsing assistant: locally redacts sensitive screen content
and DOM text before anything reaches the backend, then guides/executes
safe on-page actions.

## Setup

```bash
npm install
npm run build
```

This produces `dist/`, containing `manifest.json`, `icons/`, and the three
built bundles (`src/background.js`, `src/contentScript.js`, and the side
panel app under `src/sidepanel/`).

## Load into Chrome

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `dist/` folder (not the project root)
5. Click the extension icon on any page to open the side panel

## Point it at your backend

The backend base URL is a constant in `src/config.ts`:

```ts
export const BACKEND_BASE_URL = "http://localhost:8000";
```

Make sure the backend (`../requirements.txt` project) is running there
before using the assistant — see the backend's own README.

## Dev loop

```bash
npm run dev   # vite build --watch
```

Re-load the unpacked extension in `chrome://extensions` (or click the
refresh icon on the extension card) after each rebuild to pick up
background/content-script changes; the side panel itself hot-reloads on
next open.

## Where the privacy work happens

- `src/utils/domScraper.ts` — harvests visible DOM elements, tokenizing
  any sensitive text (via `pseudonymizer.ts`) inline, before returning
  anything to the caller.
- `src/utils/edgeRedactor.ts` — paints solid black rectangles over
  sensitive screen regions on an off-screen canvas.
- `src/utils/pseudonymizer.ts` — the in-memory, per-tab token map. Lives
  entirely inside the content script's execution context (see
  `src/contentScript.ts`) so that the same instance both creates tokens
  during scraping and resolves them back to real values immediately
  before a `type_tokenized` action is dispatched. The side panel never
  holds a raw value — only opaque tokens like `<PERSON_1>`.
- `src/contentScript.ts` — the only place with live DOM access; handles
  `SCRAPE_PAGE`, `CAPTURE_AND_REDACT`, and `EXECUTE_ACTION` messages from
  the side panel.
- `src/background.ts` — owns `chrome.tabs.captureVisibleTab` (only the
  service worker has that permission) and relays the raw screenshot to
  the side panel for a single redact-and-discard round trip.

## Known gaps / next steps

- No local OCR/vision pre-pass (e.g. Tesseract.js) for sensitive text
  baked into images or `<canvas>`-rendered content — current masking is
  DOM-text-based (`domScraper.ts`) plus a heuristic pass over `<img>`
  `alt` text for photos/signatures/avatars.
- `BACKEND_BASE_URL` is a hardcoded constant; a real settings screen
  (backed by `chrome.storage`) would let users point at their own
  backend deployment.
- No automated test suite yet (Vitest + `@testing-library/react` would
  be natural additions for the side panel components, and a Playwright
  smoke test for the content script's DOM dispatch logic).
