import { useCallback, useEffect, useRef, useState } from "react";
import { Console } from "./components/Console";
import { QaPanel } from "./components/QaPanel";
import { Settings } from "./components/Settings";
import { useAppearance } from "./hooks/useAppearance";
import { useQa } from "./hooks/useQa";
import { useSpeechRecognition } from "./hooks/useSpeechRecognition";
import { useTheme } from "./hooks/useTheme";
import { askQuestion, askScreenshot as askScreenshotApi } from "./lib/api";
import { DUPLICATE_THRESHOLD, similarity } from "./lib/dedupe";
import { findRelatedContext, matchSavedQa } from "./lib/qaMatch";
import { downloadQaTranscript, downloadTranscript } from "./lib/transcript";
import type { RecordEntry } from "./types";

// How close a spoken line has to be to the answer on screen before it's taken
// as the user reading that answer out loud rather than asking something new.
// Lower than DUPLICATE_THRESHOLD on purpose: someone reciting an answer
// paraphrases, stumbles and skips words, so the match is never exact.
const ANSWER_ECHO_THRESHOLD = 0.45;

interface CachedAnswer {
  question: string;
  answer: string;
}

interface DesktopWindow {
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
  /** @returns whether the window is now pinned on top */
  togglePin: () => Promise<boolean>;
}

// Present only in the desktop app. In the browser the title bar's buttons stay
// decorative, which is what they always were.
const desktopWindow: DesktopWindow | undefined = (
  window as unknown as { desktop?: { window?: DesktopWindow } }
).desktop?.window;

interface DesktopScreenshot {
  capture: () => Promise<{ dataUrl?: string; error?: string }>;
}

// Present only in the desktop app — capturing the screen needs OS-level
// access the browser doesn't grant a web page.
const desktopScreenshot: DesktopScreenshot | undefined = (
  window as unknown as { desktop?: { screenshot?: DesktopScreenshot } }
).desktop?.screenshot;

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : String(Date.now() + Math.random());
}

export default function App() {
  const qa = useQa();
  const { theme, toggleTheme } = useTheme();
  const {
    appearance,
    setUiOpacity,
    setTextOpacity,
    setLiveCaption,
    setTextColor,
    setBgColor,
    reset: resetAppearance,
  } = useAppearance();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [record, setRecord] = useState<RecordEntry[]>([]);
  const [qaOpen, setQaOpen] = useState(false);

  // "Move": pins the real OS window on top of every other window (desktop
  // only — there's no equivalent for a browser tab). Lives in App.tsx rather
  // than either style's own component because it's the same underlying
  // window regardless of which style is showing, and switching styles
  // shouldn't reset it. Starts pinned to match main.cjs's own default — the
  // whole point is that the window behaves like an overlay from launch,
  // without needing a click first; Move is how you turn it back off.
  const [pinned, setPinned] = useState(() => Boolean(desktopWindow));
  const togglePin = useCallback(() => {
    void desktopWindow?.togglePin().then((next) => setPinned(next));
  }, []);

  // Persisted kill switch: when off, no question ever reaches the Claude
  // API, so it's a hard guarantee against burning tokens, not just a UI
  // nicety. Defaults on; only saved to localStorage once the user flips it.
  const [aiEnabled, setAiEnabled] = useState<boolean>(
    () => localStorage.getItem("aiEnabled") !== "off",
  );
  const toggleAi = useCallback(() => {
    setAiEnabled((prev) => {
      const next = !prev;
      localStorage.setItem("aiEnabled", next ? "on" : "off");
      return next;
    });
  }, []);

  // Non-question speech is kept verbatim — the record is the whole
  // conversation, not just the parts that got answered.
  const addNote = useCallback((text: string) => {
    setRecord((prev) => [
      { id: newId(), kind: "note", text, timestamp: Date.now() },
      ...prev,
    ]);
  }, []);

  // Claude answers already paid for — reusing them for a repeat (or close
  // rewording of a) question is free whether AI is currently on or off,
  // since no new call is made either way.
  const answerCacheRef = useRef<CachedAnswer[]>([]);

  const pushQa = useCallback(
    (fields: Omit<Extract<RecordEntry, { kind: "qa" }>, "id" | "kind" | "timestamp">) => {
      const id = newId();
      setRecord((prev) => [
        { id, kind: "qa", timestamp: Date.now(), ...fields },
        ...prev,
      ]);
      return id;
    },
    [],
  );

  const patchQa = useCallback(
    (id: string, fields: Partial<Extract<RecordEntry, { kind: "qa" }>>) => {
      setRecord((prev) =>
        prev.map((e) => (e.id === id && e.kind === "qa" ? { ...e, ...fields } : e)),
      );
    },
    [],
  );

  // Every question — typed, spoken, or otherwise — funnels through here.
  // Three paths, in order: (1) a saved Q&A match always wins — it's an
  // exact answer someone wrote on purpose, so it can't be "the wrong
  // answer" the way an inference could be. Matching is keyword-coverage
  // based (matchSavedQa), robust to rewording — voice-transcribed questions
  // rarely match a saved question's exact wording. (2) a near-duplicate of
  // an earlier question is answered from cache, no network call at all.
  // (3) otherwise, with AI on, ask Claude and cache the result; with AI
  // off, there's nothing left that can answer it for free, so say so.
  const ask = useCallback(
    (question: string) => {
      const savedMatch = matchSavedQa(qa.entries, question);
      if (savedMatch) {
        pushQa({ question, answer: savedMatch.answer, pending: false, source: "saved" });
        return;
      }

      const cached = answerCacheRef.current.find(
        (c) => similarity(c.question, question) >= DUPLICATE_THRESHOLD,
      );
      if (cached) {
        pushQa({ question, answer: cached.answer, pending: false, source: "cache" });
        return;
      }

      if (!aiEnabled) {
        pushQa({
          question,
          answer: "",
          pending: false,
          source: "none",
          error: "No saved answer for this — turn AI on to ask Claude.",
        });
        return;
      }

      const id = pushQa({ question, answer: "", pending: true, source: "claude" });

      // Loosely-related saved entries (not a match, just topically nearby)
      // ride along as background so Claude's improvised answer stays
      // consistent with real facts the user already wrote about themselves,
      // instead of inventing an unrelated persona. Unrelated questions
      // naturally find none, so cost is unaffected for those.
      const context = findRelatedContext(qa.entries, question);

      void askQuestion(
        question,
        {
          onDelta: (text) =>
            setRecord((prev) =>
              prev.map((e) =>
                e.id === id && e.kind === "qa" ? { ...e, answer: e.answer + text } : e,
              ),
            ),
          onDone: (answer) => {
            patchQa(id, { pending: false, answer });
            answerCacheRef.current = [
              { question, answer },
              ...answerCacheRef.current,
            ].slice(0, 50);
          },
          onError: (message) => patchQa(id, { pending: false, error: message }),
        },
        context,
      );
    },
    [aiEnabled, qa.entries, pushQa, patchQa],
  );

  // A question read visually (a shared doc, a coding platform, a slide)
  // instead of heard. There's no text to match against saved Q&A or the
  // answer cache the way ask() does — Claude reads the screenshot directly
  // (native vision support) — so this always costs a Claude call and is a
  // no-op with AI off, same as a spoken question would be in that case.
  const askScreenshot = useCallback(() => {
    if (!desktopScreenshot) return;

    if (!aiEnabled) {
      pushQa({
        question: "📷 Screenshot",
        answer: "",
        pending: false,
        source: "none",
        error: "AI is off — turn it on to read a screenshot.",
      });
      return;
    }

    void (async () => {
      const result = await desktopScreenshot.capture();
      if (result.error || !result.dataUrl) {
        pushQa({
          question: "📷 Screenshot",
          answer: "",
          pending: false,
          source: "none",
          error: result.error ?? "Couldn't capture the screen.",
        });
        return;
      }

      const id = pushQa({
        question: "📷 Screenshot",
        answer: "",
        pending: true,
        source: "claude",
      });

      void askScreenshotApi(result.dataUrl, {
        onDelta: (text) =>
          setRecord((prev) =>
            prev.map((e) =>
              e.id === id && e.kind === "qa" ? { ...e, answer: e.answer + text } : e,
            ),
          ),
        onDone: (answer) => patchQa(id, { pending: false, answer }),
        onError: (message) => patchQa(id, { pending: false, error: message }),
      });
    })();
  }, [aiEnabled, pushQa, patchQa]);

  // The most recent answer shown, so it can be recognised if it's read back
  // out loud. See the echo check in onFinalUtterance.
  const lastAnswerRef = useRef("");
  useEffect(() => {
    const latest = record.find((e) => e.kind === "qa" && !e.pending && e.answer);
    if (latest && latest.kind === "qa") lastAnswerRef.current = latest.answer;
  }, [record]);

  // Every utterance heard while listening gets answered — there's no
  // question heuristic gating it anymore, since a missed "is this a
  // question" guess meant a spoken question silently got filed as a note
  // and never answered. The one thing still filtered out is the user's own
  // voice reading the last answer back off the screen: without that check,
  // every readback would immediately be re-asked as if it were new.
  const onFinalUtterance = useCallback(
    (utterance: string) => {
      const answer = lastAnswerRef.current;
      if (answer && similarity(utterance, answer) >= ANSWER_ECHO_THRESHOLD) {
        addNote(utterance);
        return;
      }

      ask(utterance);
    },
    [ask, addNote],
  );

  const {
    supported,
    listening,
    interim,
    activeLang,
    error: speechError,
    toggle,
  } = useSpeechRecognition(onFinalUtterance, {
    liveCaption: appearance.liveCaption,
  });

  const toggleListening = toggle;

  // Global keyboard shortcuts — a fallback for when clicking is inconvenient
  // mid-practice. "." and space both toggle listening (there is only one
  // control now); any digit or letter key instantly recalls
  // whichever saved entry has that quick key assigned (see QaPanel.tsx),
  // pushing it
  // into the record and mini boxes exactly like a live saved-Q&A match
  // would — a manual override for the questions you most need on hand in
  // case voice or typing lets you down. Ignored while focus is in any
  // editable field so normal typing (the command bar, the Saved Q&A forms)
  // is never hijacked.
  useEffect(() => {
    function isEditableTarget(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
    }

    function onKeyDown(e: KeyboardEvent) {
      if (isEditableTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "." || e.key === " ") {
        e.preventDefault();
        toggleListening();
        return;
      }
      // Case-insensitive: an entry assigned "q" answers to Q as well, so a
      // stray caps lock can't cost you the shortcut.
      const key = e.key.toLowerCase();
      if (/^[a-z0-9]$/.test(key)) {
        const entry = qa.entries.find((en) => en.hotkey === key);
        if (entry) {
          e.preventDefault();
          pushQa({ question: entry.question, answer: entry.answer, pending: false, source: "saved" });
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [qa.entries, toggleListening, pushQa]);

  const busy = record.some((e) => e.kind === "qa" && e.pending);

  // Wipes the on-screen record (and the answer cache keyed to it) — nothing
  // server-side to undo, but it's the whole conversation so confirm first
  // rather than lose it to a stray click.
  const handleClear = useCallback(() => {
    if (record.length === 0) return;
    if (!window.confirm("Clear the whole conversation record? This can't be undone.")) return;
    setRecord([]);
    answerCacheRef.current = [];
  }, [record.length]);

  return (
    <>
    <div className="term-app">
      <div className="title-bar">
        <span className="title-text">
          <span className="glyph">&gt;_</span>
          C:\Users\Guest\VoiceDocAssistant
        </span>
        <span className="win-controls">
          {/* Shows the theme you're *in*, not the one you'd switch to — the
              other way round reads as a label and had people thinking they
              were already in Glass mode. Where it goes next lives in the
              tooltip. */}
          <button
            className="theme-toggle"
            onClick={toggleTheme}
            title={
              theme === "dark"
                ? "Theme: Dark — click for Light"
                : theme === "light"
                  ? "Theme: Light — click for Glass"
                  : "Theme: Glass — click for Dark"
            }
          >
            {theme === "dark" ? "☾ Dark" : theme === "light" ? "☀ Light" : "◐ Glass"}
          </button>
          <button
            className={`theme-toggle settings-btn${settingsOpen ? " on" : ""}`}
            onClick={() => setSettingsOpen((prev) => !prev)}
            title="Appearance — background and text transparency"
            aria-label="Appearance settings"
          >
            ⚙
          </button>
          <button
            className={`theme-toggle settings-btn${pinned ? " on" : ""}`}
            onClick={togglePin}
            disabled={!desktopWindow}
            title={
              desktopWindow
                ? pinned
                  ? "Move: on — this window stays on top of everything else. Click to turn off."
                  : "Move — keep this window on top of other apps, even after Alt+Tab"
                : "Move is desktop-only — the browser build has no window to pin"
            }
          >
            📌 Move
          </button>
          <button className="min" onClick={() => desktopWindow?.minimize()} title="Minimize">
            &#8211;
          </button>
          <button
            className="max"
            onClick={() => desktopWindow?.toggleMaximize()}
            title="Maximize"
          >
            &#9633;
          </button>
          <button className="close" onClick={() => desktopWindow?.close()} title="Close">
            &#215;
          </button>
        </span>
      </div>

      <div className="workspace">
        <Console
          supported={supported}
          listening={listening}
          busy={busy}
          interim={interim}
          onToggleMic={toggleListening}
          speechLang={activeLang}
          record={record}
          onAsk={ask}
          onScreenshot={askScreenshot}
          screenshotAvailable={Boolean(desktopScreenshot)}
          aiEnabled={aiEnabled}
          onToggleAi={toggleAi}
          onDownload={() => downloadTranscript(record)}
          onDownloadQa={() => downloadQaTranscript(record)}
          onClear={handleClear}
          qaCount={qa.entries.length}
          qaOpen={qaOpen}
          onToggleQa={() => setQaOpen((v) => !v)}
        />
        <QaPanel
          entries={qa.entries}
          open={qaOpen}
          onAdd={qa.add}
          onUpdate={qa.update}
          onRemove={qa.remove}
          onRemoveAll={qa.removeAll}
          onImport={qa.importMany}
        />
      </div>

      {speechError && (
        <p className="unsupported">
          ⚠ {speechError}
          {!supported && " You can still type questions."}
        </p>
      )}
    </div>

    {/* Deliberately a sibling of .term-app, not a child. .term-app clips its
        overflow to keep square corners inside its rounded frame, which would
        clip this popover out of existence — and its backdrop-filter makes it
        a containing block, so even position: fixed wouldn't escape. */}
    <Settings
      open={settingsOpen}
      onClose={() => setSettingsOpen(false)}
      appearance={appearance}
      onUiOpacity={setUiOpacity}
      onTextOpacity={setTextOpacity}
      onLiveCaption={setLiveCaption}
      onTextColor={setTextColor}
      onBgColor={setBgColor}
      onReset={resetAppearance}
    />
    </>
  );
}
