# 🎙️ Voice Doc Assistant

Real-time speech-to-text that keeps a **running transcript of everything you
say**, and **answers your questions from files you attach**.

Talk naturally (or just type). Every finished utterance is transcribed into
the record; ones that read as a question get answered from your attached
documents (via Claude) and streamed to the screen, everything else just joins
the log as plain text. The whole record can be downloaded as a `.txt` file at
any time.

Built with **Vite + React + TypeScript** on the front end and an **Express**
backend that holds your API key.

## How it works

```
Browser mic ──► Web Speech API (live transcript)      Typed question ──┐
                      │  question?  │  no → append to the record        │
                      │ yes                                             │
                      ▼                                                 ▼
                          Express backend ──► Claude (claude-sonnet-5) + your attached files
                                        │
                                        ▼
                    Answer streams into the record, shown on screen
```

- **Speech-to-text** uses the browser's built-in Web Speech API — no audio keys, works in Chrome/Edge.
- **Question detection** ([`src/lib/isQuestion.ts`](src/lib/isQuestion.ts)) decides, per utterance, whether it gets sent to Claude or just recorded as text.
- **Answers** come from Claude, which reads your attached files (PDFs and images natively, text/markdown/code as text).
- The backend holds your API key so it's never exposed to the browser.
- Attached files are **prompt-cached**, so repeated questions are fast and cheap.
- Attached files are **stored in Supabase Storage**, so they survive server restarts, and can be listed, renamed, or deleted from the UI at any time.
- The whole record (notes + questions + answers, in order) can be **downloaded as a `.txt` file**.
- **Screenshot a screen/window/tab** and it's automatically attached and asked about — no separate "now attach it" step.
- If no attached file answers a question, Claude falls back to its own general knowledge instead of refusing (see [`server/prompts.js`](server/prompts.js)).
- The UI is styled like a **command-prompt window**.

## Project layout

Both the backend and frontend are split into small, single-responsibility
modules with the web layer kept separate from business logic.

```
├── server/                Express backend (layered)
│   ├── index.js           Entry point — starts the server
│   ├── app.js             Composition root — wires the layers together
│   ├── config.js          Env + constants (port, model, limits)
│   ├── prompts.js         System prompt
│   ├── services/          Business logic (framework-agnostic)
│   │   ├── attachment.store.js   Attachment repository (Supabase-backed, in-memory cache)
│   │   ├── storage.service.js    Supabase Storage wrapper (upload/rename/remove/list)
│   │   ├── supabase.client.js    Supabase client (null if not configured)
│   │   ├── file-converter.js     File → Claude content block
│   │   └── claude.service.js     Claude SDK wrapper
│   └── http/              Web layer (Express)
│       ├── routes.js
│       ├── upload.middleware.js  multer config
│       ├── sse.js                Server-Sent Events helper
│       ├── attachments.controller.js
│       └── ask.controller.js
│
├── scripts/dev.mjs        Dev launcher (backend + Vite, with o/q shortcuts)
├── index.html             Vite entry
├── vite.config.ts         Dev server + /api proxy to the backend
├── src/                   React frontend
│   ├── main.tsx           React entry
│   ├── App.tsx            Ties speech/typed input → question → streamed answer together
│   ├── components/
│   │   ├── Console.tsx        Question/Answer + scrollback log (notes + Q&A) + command bar
│   │   └── FileListPanel.tsx  Collapsible drawer: select-all, per-file rename/delete, bulk delete
│   ├── hooks/
│   │   ├── useSpeechRecognition.ts   Web Speech API wrapper
│   │   └── useAttachments.ts         Attachment list + upload/rename/remove state
│   └── lib/               api.ts (backend client), isQuestion.ts, transcript.ts (build/download record), screenshot.ts (screen capture)
└── .env                   ANTHROPIC_API_KEY + SUPABASE_* (git-ignored)
```

The layers depend inward: `http/` controllers call `services/`, which call the
Claude SDK. `app.js` injects the store and Claude service into the controllers,
so each piece is isolated and testable.

## Setup

Requires **Node.js 18.11+**. Typed questions work in any browser; voice input
needs a **Chromium browser** (Chrome or Edge — the Web Speech API isn't
available in Firefox).

```bash
# 1. Install dependencies
npm install

# 2. Add your Anthropic API key and Supabase project details
cp .env.example .env
#   then edit .env:
#   - ANTHROPIC_API_KEY (get one at https://console.anthropic.com/settings/keys)
#   - VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (Project Settings > API)

# 3. Run in development (backend + Vite dev server together)
npm run dev
```

### Supabase storage setup

Attachments are stored in a Supabase Storage bucket named `attachments` so
they survive server restarts and can be listed/renamed/deleted from the UI.

1. In the Supabase dashboard, open **SQL Editor → New query**, paste in
   [`supabase/setup.sql`](supabase/setup.sql), and run it. It creates the
   `attachments` bucket and the RLS policies that let the **anon key** (the
   default) read/write it.
2. Alternatively, set `SUPABASE_SERVICE_ROLE_KEY` in `.env` (server-only —
   **never** expose it to the browser) and skip the script's policy section;
   the service-role key bypasses Storage RLS entirely.
3. If Supabase isn't configured at all, the app still runs — attachments just
   live in memory for that server session, like before.

There's no separate database table — attachment metadata (id, name,
mimetype, size) is read straight off the Storage object, not a Postgres row.

`npm run dev` runs both servers with keyboard shortcuts:

- **`o`** — open the app in your browser
- **`q`** — quit (also Ctrl+C)

Open **http://localhost:5173** in Chrome (or just press `o`). Vite serves the
React app and proxies `/api` calls to the backend on port 3000.

### Production build

```bash
npm run build     # bundles the React app into dist/
npm start         # backend serves dist/ + the API on one port
```

Then open **http://localhost:3000**.

## Using it

1. **Attach files** — click **`[+]`** in the command bar (or **`[+ Insert]`**
   in the file-list drawer) to pick files, or drag & drop onto the drawer
   (PDF, images, `.txt`, `.md`, `.csv`, `.json`, code…).
2. **Open the file list** — click **`[≡]`** in the command bar to slide out
   the drawer. Check individual files or **Select all**, then **Delete
   selected** for a bulk delete; `[edit]` renames a file in place (Enter to
   save, Esc to cancel), `[del]` removes just that one.
3. **Talk, or ask a question** — click the round **▶** button and just talk.
   Every finished sentence is transcribed into the record on the right;
   sentences that read as a question (end like one, or start with _what,
   how, why, can you, tell me, explain…_) also get answered by Claude,
   everything else is kept as plain text. Typing into the command-bar input
   and pressing Enter always asks a question directly. The current
   exchange shows in the **Question**/**Answer** boxes; the full record —
   notes and Q&A together, in order — scrolls in the log to the right.
4. **Download the record** — click **`⭳ Download`** at the top of the
   console to save the whole record (everything transcribed, plus every
   question and answer) as a timestamped `.txt` file.
5. **Screenshot something** — click **`[📷]`** in the command bar, then pick
   a screen, window, or tab in the browser's picker. The capture is attached
   automatically and Claude is asked "What does this screenshot show?" right
   away — no extra steps. Requires a browser that supports screen capture
   (Chrome/Edge/Firefox on desktop); the button is disabled otherwise.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Backend + Vite dev server together, with `o`/`q` shortcuts |
| `npm run build` | Production bundle → `dist/` |
| `npm start` | Run the backend, serving the built app + API |
| `npm run typecheck` | `tsc --noEmit` — type-check without emitting |

## Notes & tuning

- **What counts as a question** lives in [`src/lib/isQuestion.ts`](src/lib/isQuestion.ts)
  — tweak it to change how eagerly it answers, or switch to a wake word.
- **The model & answer style** are set in [`server/config.js`](server/config.js)
  (`model`, currently `claude-sonnet-5`) and [`server/prompts.js`](server/prompts.js)
  (`SYSTEM_PROMPT`). It defaults to short, conversational answers.
- Attachment **bytes live in Supabase Storage**, with an in-memory cache per
  server process for fast repeated access. This still holds attachments for
  a single user — to support multiple concurrent users, give each session
  its own store (see the note in `server/services/attachment.store.js`).
- Max upload size is 25 MB per file.
- Chrome needs an internet connection for speech recognition, and requires
  **HTTPS** for the mic on any real domain (`localhost` is exempt).
