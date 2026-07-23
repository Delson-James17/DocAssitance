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

- **Speech-to-text** uses the browser's built-in Web Speech API — no audio keys, works in Chrome/Edge. It **auto-detects English vs. Filipino/Tagalog** ([`src/lib/detectLang.ts`](src/lib/detectLang.ts)): after each utterance it checks for common Tagalog words and switches the recognizer language for the *next* one if needed — no manual toggle. The **`[EN]`/`[FIL]`** badge in the command bar just shows which one is currently active. (The Web Speech API can only listen in one language at a time, so this adapts going forward rather than detecting both simultaneously — it can't un-garble an utterance recognized in the wrong language after the fact.)
- **Question detection** ([`src/lib/isQuestion.ts`](src/lib/isQuestion.ts)) recognizes English and Filipino/Tagalog question words (plus the Tagalog "ba" particle) to decide, per utterance, whether it gets sent to Claude or just recorded as text.
- **Language**: questions can be asked in English, Filipino/Tagalog, or a Taglish mix — Claude understands either and answers in English by default (see [`server/prompts.js`](server/prompts.js)).
- **Supported attachments**: PDF and images (native, read directly by Claude); `.docx` (text extracted via [mammoth](https://www.npmjs.com/package/mammoth) — detected by extension too, since browsers don't always report the right MIME type); plain-text formats (`.txt`, `.md`, `.csv`, `.json`, code, …). Legacy `.doc` isn't supported (mammoth only reads the modern zip-based format) and gets a clear message asking you to re-save as `.docx` or PDF; other unrecognized binary formats get flagged the same way instead of being sent as garbled bytes.
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
   (PDF, images, `.docx`, `.txt`, `.md`, `.csv`, `.json`, code…).
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
6. **Speak in Filipino/Tagalog** — just talk; no setup needed. The **`[EN]`/`[FIL]`**
   badge next to the mic button shows what it's currently listening for and
   switches on its own as your speech shifts between languages. Either way,
   Claude understands the question and answers in English.

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

## Managing API cost

**Turn the AI off.** The **`◉ AI: ON`** button at the top of the console
(next to Download) is a hard kill switch — click it to flip to **`○ AI:
OFF`**. The setting is saved (`localStorage`), so it stays off across
reloads until you turn it back on. With it off, Claude is never called —
but questions still get answered where possible, for free:

- **Repeat questions are free, AI on or off.** Every answer is cached
  (in memory, per browser tab) against the exact set of attached files it
  was computed from. Asking the same question again — or a close rewording
  of it — is answered instantly from that cache instead of spending tokens
  or (with AI off) re-running a search. Shown with a **`cached`** badge.
  Changing the attachments invalidates the cache automatically, since the
  answer no longer applies to the same files.
- **New questions fall back to local keyword search** (`server/services/local-search.service.js`)
  over attachments whose text was already extracted at upload time
  (`.docx`, `.txt`, `.md`, `.csv`, `.json`, code…) — it finds the paragraphs
  that best match the question's keywords and shows them directly, no
  Claude call involved. Shown with a **`local`** badge. PDFs and images
  can't be searched this way (they're sent to Claude as native files and
  never turned into text) — the app tells you which attachments it couldn't
  search rather than pretending they don't exist.
- Screenshots still attach normally with AI off, they just aren't
  auto-asked-about (a screenshot is an image, so local search can't read
  it) — turn AI on when you're ready to ask about one.

Use AI-off mode whenever you're done with the expensive path but still want
answers from documents you've already attached, or whenever you want a hard
guarantee that nothing in the app can spend from your balance.

**Export sample Q&A.** The **`⭳ Sample Q&A`** button (next to Download)
downloads an **`.html`** preview of what the app can read well from your
attached files, generated entirely locally (`server/services/faq.service.js`)
— no Claude call, no tokens. It scans text-extractable attachments for
heading-like lines (markdown headings, numbered items, ALL-CAPS section
labels like `SKILLS`) and pairs each with the content right after it, so you
can see up front which sections it'll answer accurately. It's HTML rather
than plain text specifically so attached **images** (like screenshots) can
be embedded directly in the file and viewed — a `.txt` file can't hold a
picture. PDFs are listed separately as "not previewable" since they're
never turned into text or an image locally. The file is self-contained
(images inlined as base64), so it opens in any browser with no server
needed.

**Image previews in the app itself.** Attached images (e.g. screenshots)
now show a small thumbnail directly in the file list drawer (**`[≡]`**), so
you can see what's attached without needing AI or exporting anything —
served from the new `GET /api/attachments/:id/raw` endpoint.

**Local search accuracy.** Local search (`server/services/local-search.service.js`)
ranks matches by how many *distinct* question keywords a passage covers
first, with rarer/more distinctive keywords weighted above common ones
repeated throughout a document — so a passage that actually addresses
several parts of the question outranks one that just repeats a single
common word many times. Short heading-only paragraphs (e.g. a bare
`SKILLS` line) are merged with the paragraph right after them before
scoring, so a heading match still surfaces its real content instead of a
one-word non-answer.

Every question resends **all** currently attached files as context — that's
what lets Claude answer from them, but it also means cost scales with what's
attached, not with what the question is actually about.

- **Watch the terminal.** Every answer logs a line like
  `[ask] input=16 cache_write=0 cache_read=13049 output=14 ~$0.0043` — token
  counts plus a rough (deliberately overestimated) dollar cost. If
  `cache_read` is near zero on a question you expect to be a repeat, the
  attachment cache isn't being hit — see below.
- **Prompt caching (`server/services/claude.service.js`)** caches the whole
  attachment set as one block with a **1-hour TTL**: the first question after
  attachments change pays a cache-write premium (2x base price), every
  question after that within the hour reads from cache at **~0.1x** price
  instead of full price. Two things break this: attaching/removing/renaming
  a file (changes the cached content, forces a fresh write) and letting more
  than an hour pass between questions.
- **Remove attachments you don't need for the current line of questions** —
  cost is proportional to everything attached, not just what's relevant. A
  large `.docx` sitting attached "just in case" gets paid for on every single
  question, whether or not it's used.
- **Ask follow-ups in the same session** rather than spacing them out — they
  land inside the 1-hour cache window and cost a fraction of a fresh
  question.
