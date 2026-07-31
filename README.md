# 🎙️ Voice Doc Assistant

Real-time speech-to-text that keeps a **running transcript of everything you
say**, and **answers your questions** from a saved Q&A table you curate, or
from Claude.

Talk naturally (or just type). Every finished utterance is transcribed into
the record; ones that read as a question get answered and streamed to the
screen, everything else just joins the log as plain text. The whole record
can be downloaded as a `.txt` file at any time.

Built with **Vite + React + TypeScript** on the front end and an **Express**
backend that holds your API key.

## How it works

```
Browser mic ──► Web Speech API (live transcript)      Typed question ──┐
                      │  question?  │  no → append to the record        │
                      │ yes                                             │
                      ▼                                                 ▼
                    1. Saved Q&A match?  ──yes──► answer instantly, free
                      │ no
                      ▼
                    2. Repeat of a cached question? ──yes──► reuse it, free
                      │ no
                      ▼
                    3. AI on?  ──yes──► Claude (claude-sonnet-5), streamed
                      │ no
                      ▼
                    Nothing free could answer it — say so
```

- **Speech-to-text** uses the browser's built-in Web Speech API — no audio keys, works in Chrome/Edge. It **auto-detects English vs. Filipino/Tagalog** ([`src/lib/detectLang.ts`](src/lib/detectLang.ts)): after each utterance it checks for common Tagalog words and switches the recognizer language for the *next* one if needed — no manual toggle. The **`[EN]`/`[FIL]`** badge in the command bar just shows which one is currently active. (The Web Speech API can only listen in one language at a time, so this adapts going forward rather than detecting both simultaneously — it can't un-garble an utterance recognized in the wrong language after the fact.)
- **Question detection** ([`src/lib/isQuestion.ts`](src/lib/isQuestion.ts)) recognizes English and Filipino/Tagalog question words (plus the Tagalog "ba" particle) to decide, per utterance, whether it gets answered or just recorded as text.
- **Language**: questions can be asked in English, Filipino/Tagalog, or a Taglish mix — Claude understands either and answers in English by default (see [`server/prompts.js`](server/prompts.js)).
- The backend holds your API key so it's never exposed to the browser.
- **Saved Q&A** (**`[?]`** in the command bar) lets you type your own question/answer pairs and save them — a close match always wins over Claude, so you get a guaranteed-correct, zero-cost answer for anything you've curated, with no risk of Claude answering the wrong thing. Persisted in Supabase (a Postgres table) so it survives server restarts.
- **Bulk-import Q&A** from a `.csv` or `.json` file — see [Using it](#using-it) below.
- If AI is on and nothing saved matches, Claude answers from its own general knowledge (see [`server/prompts.js`](server/prompts.js)).
- The whole record (notes + questions + answers, in order) can be **downloaded as a `.txt` file**.
- The UI is styled like a **command-prompt window**.

## Project layout

Both the backend and frontend are split into small, single-responsibility
modules with the web layer kept separate from business logic.

```
├── server/                Express backend (layered)
│   ├── index.js           Entry point — starts the server
│   ├── app.js             Composition root — wires the layers together
│   ├── config.js          Env + constants (port, model, pricing)
│   ├── prompts.js         System prompt
│   ├── services/          Business logic (framework-agnostic)
│   │   ├── qa.store.js           Saved Q&A repository (Supabase table-backed, in-memory cache)
│   │   ├── supabase.client.js    Supabase client (null if not configured)
│   │   └── claude.service.js     Claude SDK wrapper
│   └── http/              Web layer (Express)
│       ├── routes.js
│       ├── sse.js                Server-Sent Events helper
│       ├── qa.controller.js
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
│   │   └── QaPanel.tsx        Collapsible drawer: search/add/edit/delete/import saved Q&A pairs
│   ├── hooks/
│   │   ├── useSpeechRecognition.ts   Web Speech API wrapper
│   │   └── useQa.ts                  Saved Q&A list + add/update/remove/import state
│   └── lib/               api.ts (backend client), isQuestion.ts, qaMatch.ts (keyword-coverage saved-Q&A matching), qaImport.ts (.csv/.json parsing), dedupe.ts (near-duplicate detection), transcript.ts (build/download record)
├── samples/               qa-import-sample.csv / .json — try the bulk import with these
└── .env                   ANTHROPIC_API_KEY + SUPABASE_* (git-ignored)
```

The layers depend inward: `http/` controllers call `services/`, which call the
Claude SDK or Supabase. `app.js` injects the Q&A store and Claude service into
the controllers, so each piece is isolated and testable.

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

### Supabase setup

Saved Q&A pairs are stored in a `qa_entries` Postgres table so they survive
server restarts and can be managed from the UI.

1. In the Supabase dashboard, open **SQL Editor → New query**, paste in
   [`supabase/setup.sql`](supabase/setup.sql), and run it. It creates the
   `qa_entries` table and the RLS policies that let the **anon key** (the
   default) read/write it.
2. Alternatively, set `SUPABASE_SERVICE_ROLE_KEY` in `.env` (server-only —
   **never** expose it to the browser) and skip the script's policy section;
   the service-role key bypasses RLS entirely.
3. If Supabase isn't configured at all, the app still runs — saved Q&A just
   lives in memory for that server session.

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

### Deploying to Netlify

Netlify only serves static files by default — it can't run the persistent
Express server in `server/`. Deploying `dist/` alone (with no other setup)
builds and serves the frontend fine, but every `/api/*` call fails, since
there's nothing on the other end to answer them.

[`netlify.toml`](netlify.toml) and [`netlify/functions/`](netlify/functions)
solve this by re-implementing the same two API routes as **Netlify
Functions** — `ask.js` and `qa.js` — which both import and reuse the exact
same [`server/services/`](server/services) modules (`claude.service.js`,
`qa.store.js`) that the Express backend uses for local dev; only the HTTP
glue differs (Web-standard `Request`/`Response` instead of Express's
`req`/`res`). `/api/ask` streams Claude's answer through a `ReadableStream`
response body — the same SSE wire format either way, so the frontend doesn't
need to know or care which backend answered it.

1. **Connect the repo** in the Netlify dashboard (or `netlify deploy` via
   the CLI). Netlify auto-detects `netlify.toml`'s build command
   (`npm run build`), publish directory (`dist`), and functions directory
   (`netlify/functions`) — no manual build-settings changes needed.
2. **Set environment variables** — Site configuration → Environment
   variables. `.env` is git-ignored and never deployed, so these must be set
   here instead:
   - `ANTHROPIC_API_KEY`
   - `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` (or the `SUPABASE_*`
     aliases — see [Supabase setup](#supabase-setup) above)
3. **Deploy.** Both `/api/ask` and `/api/qa*` are routed straight to the
   matching function via each file's exported `config.path` — no redirect
   rules needed.

To try the whole thing locally exactly as Netlify will run it — before
pushing a change and finding out it's broken in production — run
`npx netlify dev` (already a devDependency). It builds the app, loads
`.env`, and serves everything (frontend + both functions) on
**http://localhost:8888**.

**Known limits** (Netlify's, not this app's): streaming functions have a
response-time ceiling that varies by plan (10s+, longer on paid tiers) — an
answer capped at `maxAnswerTokens` (see `server/config.js`) normally
finishes well inside that, but if you raise the cap enough to hit timeouts,
either lower it back down or check your plan's function duration limit.
Because each request may hit a different function instance, there's no
shared in-memory cache between invocations the way the Express server has
within one process — every `qa.js` call re-syncs from Supabase instead, so
correctness holds, it's just an extra round trip Netlify's Express
counterpart doesn't pay.

## Using it

1. **Talk, or ask a question** — click the round **▶** button and just talk.
   Every finished sentence is transcribed into the record on the right;
   sentences that read as a question (end like one, or start with _what,
   how, why, can you, tell me, explain…_) also get answered, everything else
   is kept as plain text (including misheard/garbled fragments — the mic
   picks up whatever it hears, not just clean speech). Typing into the
   command-bar input and pressing Enter always asks a question directly. The
   current exchange shows in the **Question**/**Answer** boxes.
2. **Ask by voice without relying on detection** — click **❓** to turn on
   ask mode: everything you say from then on is sent straight to be
   answered, no question-shaped wording required, unlike ▶'s auto-detection.
   Click ❓ again to turn it back off. Recording never stops for this — ❓
   is a toggle on the *same* continuous session (it'll start ▶ for you if
   it wasn't already running), not a separate one, so nothing said while
   switching between modes is ever missed. Turning ▶ off stops everything,
   including ask mode.
3. **Switch between the full log and Q&A only** — two tabs sit above the
   scrolling log: **Conversation** (everything, notes included — newest
   first) and **Q&A only** (just the question/answer exchanges, with the
   noise filtered out). Each has its own **`⭳ Q&A`** / **`⭳ Full Log`**
   download button at the top of the console, independent of which tab is
   currently showing — you don't need to switch tabs just to get the other
   file. Both save a timestamped `.txt`.
4. **Speak in Filipino/Tagalog** — just talk; no setup needed. The **`[EN]`/`[FIL]`**
   badge next to the mic button shows what it's currently listening for and
   switches on its own as your speech shifts between languages. Either way,
   Claude understands the question and answers in English.
5. **Save your own Q&A** — click **`[?]`** in the command bar to open the
   Saved Q&A drawer. Type a question and its exact answer, **`+ Save Q&A`**
   persists it. From then on, asking that question (or a close rewording)
   answers instantly from what you wrote — shown with a **`Saved`** badge —
   instead of calling Claude. `[edit]`/`[del]` manage entries in place.
6. **Search saved Q&A** — the search box in the drawer filters by keyword
   against the question text (every typed word must appear somewhere in the
   question, in any order) — handy once you've got more than a handful saved.
7. **Bulk-import Q&A** — click **`⭱ Import`** in the Saved Q&A drawer and
   pick a `.csv` (header row `question,answer`) or `.json` file (an array of
   `{question, answer}` objects, or an object mapping questions to answers).
   Rows missing either field, or whose question already matches something
   saved, are skipped automatically — you get a summary of how many were
   imported vs. skipped either way. Sample files to try it with (or use as a
   template):
   [`samples/qa-import-sample.csv`](samples/qa-import-sample.csv),
   [`samples/qa-import-sample.json`](samples/qa-import-sample.json).

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
- **Saved-Q&A matching** ([`src/lib/qaMatch.ts`](src/lib/qaMatch.ts)) is
  keyword-coverage based: a saved question needs to cover most of the asked
  question's distinct keywords (common filler words like "what", "is",
  "tell", "me" are stripped first and never compared), not match it
  word-for-word — robust to rewording and voice-transcription variance.
  Questions with only one or two real keywords left after filtering (e.g.
  "What is AWS?" → just "aws") require *all* of them to match instead of a
  partial ratio — with that little to go on, partial credit isn't a
  meaningful signal, and demanding an exact keyword hit is what stops an
  unrelated saved question from winning just because it shares one common
  word. If a short saved question doesn't reliably match, double-check its
  exact wording in the drawer — matching only looks at the literal words
  saved, so "your self" (two words) won't match a query for "yourself".
- Chrome needs an internet connection for speech recognition, and requires
  **HTTPS** for the mic on any real domain (`localhost` is exempt).

## Managing API cost

**Turn the AI off.** The **`◉ AI: ON`** button at the top of the console
(next to Download) is a hard kill switch — click it to flip to **`○ AI:
OFF`**. The setting is saved (`localStorage`), so it stays off across
reloads until you turn it back on. With it off, Claude is never called —
but questions still get answered where possible, for free:

- **A close match to a Saved Q&A entry is always free and answered first,**
  ahead of the cache or Claude — see **`[?]`** above. It's the most reliable
  way to guarantee a correct, on-topic answer for a question you know you'll
  be asked, since it's exactly what you wrote rather than an inference.
- **Repeat questions are free, AI on or off.** Every Claude answer is cached
  in memory. Asking the same question again — or a close rewording of it —
  is answered instantly from that cache instead of spending tokens again.
  Shown with a **`Cached`** badge.
- If neither of those match and AI is off, the app says so plainly instead
  of guessing — turn AI on to let Claude answer.

Use AI-off mode whenever you want a hard guarantee that nothing in the app
can spend from your balance, while still getting free answers for anything
you've saved or already asked before.

- **Watch the terminal.** Every answer logs a line like
  `[ask] input=16 output=14 ~$0.0043` — token counts plus a rough
  (deliberately overestimated) dollar cost.
