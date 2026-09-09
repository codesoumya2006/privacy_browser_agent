# Edge-Redacted Vision & Web Navigation Assistant

A privacy-preserving, universal browser assistant: a Chrome extension
locally redacts screenshots and DOM text (canvas black-out + referential
tokenization) before anything is sent to a Google ADK-style multi-agent
FastAPI backend running on Gemini 2.5 Flash, which reasons over the
sanitized state and returns a single safe next action for the extension
to execute on the live page.

```
[ Chrome Extension ]                          [ FastAPI / ADK Backend ]
  content script                                 RedactionAuditTool (fail-safe)
    scrape + tokenize   ──┐                            │
  side panel              ├─ HTTPS POST ─►  PagePerception
    canvas redact       ──┘   /api/v1/interact          │
    render chat UI                              Router (informational vs actionable)
    confirm risky actions                         │              │
  content script         ◄── ActionCommand ── DataExtraction  NavigationPlanning
    detokenize + dispatch                                        │
                                                            ActionSafety (policy gate)
```

## Project layout

```
/                          Backend (Python / FastAPI / Google ADK)
  agent.py                 FastAPI app + root orchestrator
  prompt.py, tracing.py
  shared_libraries/        Pydantic schemas + constants (allowed actions, PII regex)
  tools/                   redaction_verifier, state_memory, dom_mapper
  sub_agents/               page_perception, data_extraction, navigation_planning, action_safety
  profiles/                 Mock SanitizedPageState fixtures
  requirements.txt, .env.example, README.md

frontend_extension/        Chrome MV3 extension (TypeScript / React / Vite)
  manifest.json, package.json, vite.config.ts, tailwind.config.js
  public/                   manifest.json + icons (copied verbatim into dist/ by Vite)
  src/
    background.ts           Service worker: tab capture, side panel open
    contentScript.ts         DOM access, scrape/redact/execute, owns the pseudonymizer
    config.ts                Backend base URL
    utils/                   domScraper, edgeRedactor, pseudonymizer, frameDiff, speechHandler
    sidepanel/                React app: App.tsx, backendClient.ts, extensionBridge.ts
      components/             ChatInterface, RedactionPreview, VoiceController, SafetyConfirmationModal
  README.md
```

## Running the whole thing end to end

**1. Backend**

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env       # set GEMINI_API_KEY
python -m uvicorn agent:app --host 0.0.0.0 --port 8000 --reload
```

Do not use `adk web` for this project. The backend is a custom FastAPI
orchestrator and exposes `/api/v1/interact`; it does not expose ADK Web's
`/run_sse` endpoint. `adk web` will therefore show a 404 for `/run_sse`.

Verify: `curl http://localhost:8000/health`

**2. Extension**

```bash
cd frontend_extension
npm install
npm run build
```

Load `frontend_extension/dist/` as an unpacked extension in
`chrome://extensions` (Developer mode → Load unpacked).

**3. Use it**

Open any page, click the extension icon to open the side panel, and type
(or speak) a request. Behind the scenes:

1. The side panel asks the content script to scrape the visible page —
   text is tokenized and sensitive regions are flagged before this data
   ever leaves the tab.
2. The side panel asks the background worker to capture the visible tab,
   then hands that raw screenshot straight back to the content script to
   canvas-redact — the raw pixels never touch disk or the network.
3. The tokenized elements + redacted screenshot go to
   `POST /api/v1/interact`.
4. The backend re-audits the payload, classifies the page, routes to
   either a read-only data-extraction agent or a navigation-planning
   agent, and runs the result through a deterministic policy gate that
   forces a confirmation prompt for anything irreversible (submit, pay,
   delete, ...).
5. The side panel either executes the returned action immediately or
   shows the `SafetyConfirmationModal` first. Either way, the content
   script resolves any surrogate token (e.g. `<PERSON_1>`) back to the
   real value locally, right before dispatching the native input event —
   the real value is never sent back from the backend.

## Privacy invariants (see both READMEs for the code that enforces each)

1. Raw screenshots and raw PII strings are never transmitted over the
   network or written to persistent storage — masking happens entirely
   in the content script's in-memory `pseudonymizer` and canvas redactor.
2. The backend independently re-audits every incoming payload
   (`tools/redaction_verifier.py`) and hard-aborts if anything unmasked
   slips through, before any LLM call happens.
3. Irreversible actions always require an explicit "Approve" click in
   the side panel — enforced twice: once heuristically by
   `navigation_planning`, and again unconditionally by the deterministic
   `action_safety` gate.

## What's implemented vs. what's a documented gap

Implemented: the full backend pipeline, the full extension (background
worker, content script, side panel UI, all five utils modules), icons,
build tooling, and both READMEs.

Documented gaps (see `frontend_extension/README.md` → "Known gaps"):
no local OCR/vision pre-pass for image-baked text, backend URL is a
hardcoded constant rather than a settings screen, and there's no
automated test suite yet. `npm install`/`tsc`/`vite build` could not be
run in this environment (no network access to the npm registry), so the
frontend was validated via manual import-path review, Node's
`--experimental-strip-types` syntax checking on every non-JSX file, and
structural bracket-balance checks on the `.tsx` files — run
`npm install && npm run build` locally to do a full type-check before
shipping.
