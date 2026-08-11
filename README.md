# 🎙️ Voice Doc Assistant

Real-time speech-to-text that keeps a **running transcript of everything you
say**, and **answers your questions** from a saved Q&A table you curate, or
from Claude.

Talk naturally (or just type) and every finished utterance is transcribed
into the record, word for word — plain listening never guesses at what's a
question and never answers on its own, so the transcript stays an accurate
record of what was actually said. Turn on **ask mode** (or just type) when
you want something answered, streamed to the screen as it comes in. The
record can be downloaded as a `.txt` file — either the whole conversation,
or just the Q&A exchanges — at any time.

Built with **Vite + React + TypeScript** on the front end and an **Express**
backend that holds your API key.

## How it works

```
Microphone ──► whisper.cpp, on this machine ──► joins the record, verbatim
                                                            ▲
Ask mode (❓) or a typed question ─────────────────────────┘
                      │
                      ▼
                    1. Saved Q&A match?  ──yes──► answer instantly, free
                      │ no
                      ▼
                    2. Repeat of a cached question? ──yes──► reuse it, free
                      │ no
                      ▼
                    3. AI on?  ──yes──► Claude (claude-sonnet-5), streamed
                      │           (grounded in loosely-related saved Q&A, if any)
                      │ no
                      ▼
                    Nothing free could answer it — say so
```

- **Speech-to-text runs locally**, via [whisper.cpp](https://github.com/ggml-org/whisper.cpp) in the desktop app ([`src/hooks/useSpeechRecognition.ts`](src/hooks/useSpeechRecognition.ts)). **No API key, no per-minute cost, no audio leaves the machine**, and it works offline. It **auto-detects English vs. Filipino/Tagalog** ([`src/lib/detectLang.ts`](src/lib/detectLang.ts)): after each utterance it checks for common Tagalog words and tells Whisper which language to expect for the *next* one — no manual toggle. The **`[EN]`/`[FIL]`** badge in the command bar shows which is currently active.
  - This replaced the browser's built-in Web Speech API, which **does not work in Electron**: Chrome's implementation calls a Google speech service using private API keys baked into official Chrome builds, so in Electron it fails immediately with a `network` error and there's no flag that enables it.
  - **Voice input is desktop-only.** whisper.cpp is a native binary the browser can't run, so the web build supports typed questions and saved Q&A but not the microphone. It says so rather than failing silently.
  - **There's no word-by-word interim text.** Whisper transcribes a *finished* utterance rather than a live stream, so the console shows a `…` indicator while you're speaking and the text lands when you stop. [`src/lib/mic.ts`](src/lib/mic.ts) decides where an utterance ends, using an energy gate: it collects audio while you're above an adaptive noise floor and flushes ~700ms after you go quiet.
  - **Silence is never transcribed.** Whisper doesn't return "nothing" for audio with no speech in it — it invents the most common thing from its training data, which is why an idle mic used to fill the log with "Thank you." and "Thanks for watching!". Three things prevent it: the mic only sends a segment containing at least 400ms of genuinely voiced audio; the engine is left free to emit its `[BLANK_AUDIO]` marker (passing `--suppress-nst` actively *causes* hallucinations, by forcing a real word out instead of the marker); and any transcript that comes back as a known artifact is dropped in [`electron/whisper.cjs`](electron/whisper.cjs).
- **Plain listening (▶) never guesses.** Everything heard is transcribed as-is, including misheard/garbled fragments — there's no "does this sound like a question" heuristic trying (and sometimes failing) to decide what to answer. **Ask mode (❓)** is the explicit, reliable way to get a spoken question answered — see [Using it](#using-it) below.
- **Language**: questions can be asked in English, Filipino/Tagalog, or a Taglish mix — Claude understands either and answers in English by default (see [`server/prompts.js`](server/prompts.js)).
- The backend holds your API key so it's never exposed to the browser.
- **Saved Q&A** (**`[?]`** in the command bar) lets you type your own question/answer pairs and save them — a close match always wins over Claude, so you get a guaranteed-correct, zero-cost answer for anything you've curated, with no risk of Claude answering the wrong thing. Persisted in Supabase (a Postgres table) so it survives server restarts. Each entry can also list **alternates** — other ways the same question tends to get asked (e.g. "Walk me through your resume" for "Tell me about yourself?") — so differently-worded but same-meaning questions all match the one saved answer instead of only the exact wording you first typed.
- **Bulk-import Q&A** from a `.csv` or `.json` file — see [Using it](#using-it) below.
- **Quick-recall keys**: assign any saved entry a key (`0-9` or any letter `A-Z` — 36 in all) and pressing that key instantly shows its answer on screen — a manual fallback for your most-needed questions, independent of voice or typed matching. Plus keyboard shortcuts for the two round buttons (**`.`** / **space**) — see [Using it](#using-it) below.
- If AI is on and nothing saved matches exactly, Claude answers from its own general knowledge (see [`server/prompts.js`](server/prompts.js)) — but if the question is loosely related to something you've saved (say, a project or a strength that's connected to the question but not an exact match), Claude is quietly given that saved Q&A as background so its composed answer stays consistent with what you've actually written about yourself, instead of inventing an unrelated persona. Unrelated general-knowledge questions (e.g. "What is AWS?") don't trigger this at all — no saved data is ever sent unless it's actually related to the question.
- The **Conversation** tab is a full transcript of everything said, questions included; **Q&A only** additionally shows the generated answer for each — the answer itself is the only thing exclusive to Q&A only. Each has its own **downloadable `.txt` file**.
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
├── electron/              Desktop shell
│   ├── main.cjs           Main process: window, embedded Express server, mic permissions
│   ├── whisper.cjs        Runs whisper.cpp locally and turns audio into text
│   └── preload.cjs        contextBridge surface exposed to the renderer
├── scripts/
│   ├── dev.mjs            Dev launcher (backend + Vite [+ Electron], with o/q shortcuts)
│   └── fetch-whisper.mjs  Downloads the whisper.cpp runtime + model into vendor/
├── index.html             Vite entry
├── vite.config.ts         Dev server + /api proxy to the backend
├── src/                   React frontend
│   ├── main.tsx           React entry
│   ├── App.tsx            Ties speech/typed input → question → streamed answer together
│   ├── components/
│   │   ├── Console.tsx        Question/Answer + scrollback log (notes + Q&A) + command bar
│   │   └── QaPanel.tsx        Collapsible drawer: search/add/edit/delete/import saved Q&A pairs
│   ├── hooks/
│   │   ├── useSpeechRecognition.ts   Mic + local Whisper transcription
│   │   └── useQa.ts                  Saved Q&A list + add/update/remove/import state
│   └── lib/               api.ts (backend client), mic.ts (mic capture + utterance detection), qaMatch.ts (keyword-coverage saved-Q&A matching), qaImport.ts (.csv/.json parsing), dedupe.ts (near-duplicate detection), transcript.ts (build/download record, whole or Q&A-only)
├── samples/               qa-import-sample.csv / .json — try the bulk import with these
└── .env                   ANTHROPIC_API_KEY + SUPABASE_* (git-ignored)
```

The layers depend inward: `http/` controllers call `services/`, which call the
Claude SDK or Supabase. `app.js` injects the Q&A store and Claude service into
the controllers, so each piece is isolated and testable.

## Setup

Requires **Node.js 18.11+**. Typed questions work everywhere; voice input needs
a microphone and the **desktop app** (see [Desktop app](#desktop-app-electron)),
because speech recognition runs locally rather than in the browser.

```bash
# 1. Install dependencies
npm install

# 2. Add your Anthropic API key and Supabase project details
cp .env.example .env
#   then edit .env:
#   - ANTHROPIC_API_KEY (get one at https://console.anthropic.com/settings/keys)
#   - VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (Project Settings > API)
#   (speech-to-text needs no key — it runs locally)

# 3. Run in development (backend + Vite dev server together)
npm run dev

# ...or run it as a desktop app, with voice input
npm run whisper:setup   # one-time, ~150MB download
npm run dev:desktop
```

## Desktop app (Electron)

The same React frontend and Express backend, wrapped in a native window — and
the only build with voice input.

```bash
npm run whisper:setup  # one-time: downloads the speech engine + model
npm run dev:desktop    # dev: Vite + backend + Electron, with hot reload
npm run desktop:pack   # build an unpacked app into release/win-unpacked/
npm run desktop:dist   # build a real installer into release/
```

`desktop:dist` produces an NSIS installer on Windows, a `.dmg` on macOS, and
an AppImage on Linux — each built on its own platform.

### Installing it

`npm run desktop:dist` writes **`release/Voice Doc Assistant Setup <version>.exe`**
(~223MB — most of that is the bundled Whisper model). Run it to install.

- It installs **per-user**, into `%LOCALAPPDATA%\Programs\Voice Doc Assistant`,
  so it needs no administrator rights and you can pick a different folder.
- **Windows will warn you the publisher is unknown.** The build isn't code-signed —
  click *More info → Run anyway*. Silencing that for real means buying a code-signing
  certificate; nothing in the app can avoid it.
- **Voice input works immediately** — the speech engine and model ship inside the
  installer, so there's no `whisper:setup` step on the installed copy.
- **Add your keys after installing**, at **`%APPDATA%\voice-doc-assistant\.env`**.
  The installed app can't see the repo's `.env`. Use that path rather than the
  install directory — the installer clears the install directory on upgrade, so
  a `.env` kept beside the `.exe` is destroyed every time you reinstall. The
  file should contain `ANTHROPIC_API_KEY` and your
  `VITE_SUPABASE_*` values. Without it the app still runs — voice, transcription
  and typed input all work; only Claude answers and saved Q&A sync are missing.

### The window

The desktop window is **frameless and transparent** ([`electron/main.cjs`](electron/main.cjs)),
so the app's own title bar is the real one: drag it to move the window, and its
`–` / `□` / `×` buttons are wired to actual window controls. That also removes
the duplicate chrome you'd otherwise get — a native title bar and menu sitting
above the app's own.

The three themes (**Dark / Light / Glass**, cycled from the title-bar button)
are all glass; they differ in tint and backdrop. **Glass** drops the page
background entirely so the desktop shows through the window.

On Windows 11 the window also sets `backgroundMaterial: "acrylic"`, which is
what actually frosts the desktop behind it. CSS `backdrop-filter` can't do
that — it only blurs content the page itself painted — so without acrylic the
Glass theme would be a plain dim overlay rather than frosted glass.

### Speech-to-text setup

`npm run whisper:setup` downloads two things into `vendor/whisper/` (git-ignored,
~150MB total): the prebuilt whisper.cpp binaries and a GGML model. It's safe to
re-run — anything already downloaded is skipped.

Pick a different model if the default doesn't suit you:

```bash
npm run whisper:setup -- tiny    #  75MB — fastest, least accurate
npm run whisper:setup -- base    # 142MB — the default
npm run whisper:setup -- small   # 466MB — slowest, best Filipino accuracy
```

Whisper's Tagalog is weakest at the small end, so `small` is worth the download
if you use Filipino heavily. Only one model needs to be present; the app picks
up whichever it finds.

**Speed.** A 4-second question transcribes in about **1 second** on a Ryzen 5
3500U (4 cores / 8 threads). Three things get it there, and they matter more
than the model choice:

- The model is loaded **once** and kept resident via `whisper-server`. Shelling
  out to `whisper-cli` per utterance would re-read ~150MB every time (~1.5s).
- **`--audio-ctx 512`.** Whisper's encoder always runs over a 30-second window
  regardless of clip length, so a 4-second question pays for 26 seconds of
  silence. Limiting the context to ~10s of frames measured **3028ms → 1094ms,
  a 2.8× speedup with identical output**. The catch is that audio past ~10s
  isn't transcribed at all, which is why [`src/lib/mic.ts`](src/lib/mic.ts)
  caps an utterance at 9s — exceed the window and the end of a long question
  silently disappears (and the text starts repeating itself).
- **All cores.** Halving the thread count roughly doubled the time.

`tiny` is not a useful speed option — measured *slower* than `base` here and
returned nothing at all for the same clip. If accuracy is the problem rather
than speed (Filipino especially), `npm run whisper:setup -- small` is the lever
to pull; expect roughly 2-3× the latency above.

**Prebuilt binaries exist for Windows and Linux x64.** On macOS, build
whisper.cpp from source and drop `whisper-server` plus its libraries into
`vendor/whisper/bin/`; the script will tell you this if you run it there.

### Meeting/system audio transcription (Windows)

The existing green **▶** button transcribes the Windows output mix, rather than
the microphone. Start a Teams, Zoom, Meet, or browser call, then click **▶**;
its audio is captured even when the output device is headphones. Recognized
questions go through the normal saved-Q&A/Claude answer flow. The stream is
processed in-memory with voice activity detection, resampled to 16 kHz mono
PCM WAV, and sent as short chunks to the same local Whisper process; audio is
never saved.

This uses Electron's `setDisplayMediaRequestHandler` with `audio: "loopback"`
to grant only the primary display's output-audio stream. It is Windows desktop
only and is separate from microphone permission. If it says no system audio is
available, make sure Windows has an active output device and that the meeting
is playing audio; protected/DRM content and device drivers that block loopback
cannot be captured. Stop releases every audio track immediately.

### Why the runtime lives outside the asar

Packaged builds put the whisper files in `resources/whisper/` via
`extraResources` rather than bundling them into `app.asar`. An asar is an
archive, and the OS can't execute a binary from inside one — `whisper-server`
has to exist as a real file on disk to be spawned. This also adds ~150MB to the
installer, which is the price of not having a cloud bill.

**How it's wired.** [`electron/main.cjs`](electron/main.cjs) starts the *same*
Express app in-process, bound to `127.0.0.1` on a random free port, and points
the window at that URL rather than loading the files over `file://`. That way
every relative `/api/...` call in [`src/lib/api.ts`](src/lib/api.ts) — including
the SSE answer stream — works unchanged, and the page still counts as a secure
context so the microphone is available. The loopback bind also means the API
(and the Anthropic key behind it) is never reachable from the local network,
which the plain `npm start` server does not guarantee.

**Keys in a packaged build.** The installed app can't read the repo's `.env`,
so it looks for one in this order and takes the first it finds:

1. next to the installed `.exe` — checked first so it can override, but **not
   where you should keep it**: the NSIS installer clears the install directory
   on upgrade, so a `.env` here is destroyed every time you reinstall
2. **the app's `userData` folder — `%APPDATA%\voice-doc-assistant\.env` on
   Windows. This is the one to use**: it lives outside the install directory
   and survives upgrades. Note the lower-case, hyphenated name — Electron
   derives it from package.json's `name`, not the `productName` used for the
   install folder.
3. a `.env` bundled with the build

The app logs every path it searched when it can't find a key, and the in-app
error names the `userData` path.

Real environment variables always win over all of these. Without a key the app
still opens — Q&A and typed input work, and the UI says what's missing.

**Note on ESM.** [`electron/main.cjs`](electron/main.cjs) and
[`electron/preload.cjs`](electron/preload.cjs) are CommonJS even though the rest
of the project is `"type": "module"`. Electron injects its built-in `electron`
module by patching CommonJS `require()`; it doesn't intercept ESM resolution, so
`import { app } from "electron"` resolves to the *npm package* in
`node_modules` — which exports the path to the binary, not the API — and fails
with `app is undefined`. `require()` always gets the real module.

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
4. **Already have a `qa_entries` table from before `alternates`/`hotkey`
   existed?** Re-running [`supabase/setup.sql`](supabase/setup.sql) is safe —
   both columns are added with `add column if not exists`, so it won't touch
   your existing rows beyond giving them an empty `alternates` list and a
   blank `hotkey`. It also widens an older numbers-only `hotkey` column
   (`smallint`) to `text` so letters can be assigned as quick keys — quick
   keys you'd already set are converted, not dropped. Skipping this step
   means the app's queries against
   `qa_entries` will fail (the columns won't exist yet), so run it once
   before using a pre-existing table with this version of the app.

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

1. **Talk** — click the round **▶** button and just talk. Every finished
   sentence is transcribed into the record verbatim, including
   misheard/garbled fragments (the mic picks up whatever it hears) — plain
   listening never tries to guess what's a question and never answers on
   its own. Typing into the command-bar input and pressing Enter always
   asks a question directly, regardless of whether ▶ or ❓ is on.
2. **Ask a question by voice** — click **❓** to turn on ask mode:
   everything you say from then on is sent straight to be answered instead
   of just transcribed. Click ❓ again to turn it back off. Recording never
   stops for this — ❓ is a toggle on the *same* continuous session (it'll
   start ▶ for you if it wasn't already running), not a separate one, so
   nothing said while switching between modes is ever missed. Turning ▶ off
   stops everything, including ask mode. The current exchange shows in the
   **Question**/**Answer** boxes.
3. **Switch between the transcript and Q&A only** — two tabs sit above the
   scrolling log: **Conversation** (everything said, newest first — plain
   notes *and* every question exactly as asked, since a question is still
   part of what was said) and **Q&A only** (the question/answer exchanges,
   with the generated answer). A question always appears on both, since it
   was both said *and* answered — the one thing exclusive to Q&A only is the
   answer itself; Conversation never shows it, just the question line. Each
   tab has its own **`⭳ Q&A`** / **`⭳ Full Log`** download button at the
   top of the console, independent of which tab is currently showing. Both
   save a timestamped `.txt`.
4. **Speak in Filipino/Tagalog** — just talk; no setup needed. The **`[EN]`/`[FIL]`**
   badge next to the mic button shows what it's currently listening for and
   switches on its own as your speech shifts between languages. Either way,
   Claude understands the question and answers in English.
5. **Save your own Q&A** — click **`[?]`** in the command bar to open the
   Saved Q&A drawer. Type a question and its exact answer, **`+ Save Q&A`**
   persists it. From then on, asking that question (or a close rewording)
   answers instantly from what you wrote — shown with a **`Saved`** badge —
   instead of calling Claude. `[edit]`/`[del]` manage entries in place.
   Use the **"Other ways to ask this"** box (one phrasing per line) to list
   other real phrasings of the same question — e.g. "Can you introduce
   yourself?", "Walk me through your resume." — so all of them match the
   same saved answer, not just the exact wording you typed first.
6. **Search saved Q&A** — the search box in the drawer filters by keyword
   against the question text (every typed word must appear somewhere in the
   question, in any order) — handy once you've got more than a handful saved.
7. **Bulk-import Q&A** — click **`⭱ Import`** in the Saved Q&A drawer and
   pick a `.csv` (header row `question,answer`, plus an optional `alternates`
   column) or `.json` file (an array of `{question, answer, alternates}`
   objects, or an object mapping questions to answers). `alternates` is a
   list of other phrasings that should match the same saved answer — in CSV
   it's one cell with entries separated by `|` (since `,` already separates
   columns); in JSON it's a plain string array. Rows missing `question` or
   `answer`, or whose question already matches something saved, are skipped
   automatically — you get a summary of how many were imported vs. skipped
   either way. Sample files to try it with (or use as a template):
   [`samples/qa-import-sample.csv`](samples/qa-import-sample.csv),
   [`samples/qa-import-sample.json`](samples/qa-import-sample.json) — and for
   the `alternates` column specifically:
   [`samples/qa-alternates-template.csv`](samples/qa-alternates-template.csv),
   [`samples/qa-alternates-template.json`](samples/qa-alternates-template.json).
8. **Quick-recall keys** — for the questions you most need on hand, assign
   any saved entry a key via the **"Quick key"** dropdown next to it in the
   Saved Q&A drawer. Any digit (**`0-9`**) or letter (**`A-Z`**) works — 36
   entries can be reachable at once — and the dropdown is laid out like the
   keyboard itself (number row, then the three QWERTY rows), marking the
   keys another entry already holds. Pressing that key on your keyboard
   (while not typing in any text field) instantly shows that entry's answer
   in the Question/Answer boxes and adds it to the record — a manual
   fallback in case voice input or typing lets you down mid-practice. Caps
   don't matter: an entry on **`q`** answers to **`Q`** too. Only one entry
   can hold a given key at a time; assigning it elsewhere takes it from
   whoever had it. This and the **`.`** / **space** shortcuts below work
   anywhere in the app except while a text field has focus.
9. **Keyboard shortcuts** — **`.`** toggles the round **▶** record button,
   and **space** toggles **❓** ask mode, exactly like clicking them — handy
   for switching without reaching for the mouse mid-practice. Both are
   ignored while typing in the command bar or the Saved Q&A drawer, so
   normal typing is never interrupted.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Backend + Vite dev server together, with `o`/`q` shortcuts |
| `npm run build` | Production bundle → `dist/` |
| `npm start` | Run the backend, serving the built app + API |
| `npm run typecheck` | `tsc --noEmit` — type-check without emitting |

## Notes & tuning

- **Voice questions only ever come from ask mode (❓)** — plain listening
  (▶) has no question-detection heuristic to tune; it's a deliberate design
  choice so the Conversation tab stays an accurate, unedited transcript
  rather than something that occasionally misfires into an unwanted answer.
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
  If two real phrasings of a question share *no* real keywords at all (e.g.
  "Walk me through your resume" vs. "Tell me about yourself?" — no common
  vocabulary for coverage-matching to find), keyword matching alone can't
  bridge them; add the second phrasing as an **alternate** on the saved entry
  instead (see [Using it](#using-it) above) rather than trying to tune the
  matching algorithm itself.
- **AI grounding** ([`src/lib/qaMatch.ts`](src/lib/qaMatch.ts)'s
  `findRelatedContext`, [`server/prompts.js`](server/prompts.js)): when
  Claude answers because nothing saved matched exactly, up to 2 saved
  entries that are *loosely* topically related to the question (not a full
  match, just some shared keywords) are sent along as background so the
  composed answer stays factually consistent with what's actually been
  saved about you. This is deliberately looser than saved-Q&A matching
  itself — its job is "worth keeping in mind," not "is this the same
  question" — and it costs nothing extra when nothing related is found,
  which is the common case for general-knowledge questions.
- Speech recognition needs **no internet connection** — Whisper runs on this
  machine, so voice input keeps working offline (Claude still needs the
  network, but saved Q&A answers don't).

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
