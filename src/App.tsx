import { useCallback, useRef, useState } from "react";
import { Console } from "./components/Console";
import { QaPanel } from "./components/QaPanel";
import { useQa } from "./hooks/useQa";
import { useSpeechRecognition } from "./hooks/useSpeechRecognition";
import { useTheme } from "./hooks/useTheme";
import { askQuestion } from "./lib/api";
import { DUPLICATE_THRESHOLD, similarity } from "./lib/dedupe";
import { findRelatedContext, matchSavedQa } from "./lib/qaMatch";
import { downloadQaTranscript, downloadTranscript } from "./lib/transcript";
import type { RecordEntry } from "./types";

interface CachedAnswer {
  question: string;
  answer: string;
}

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : String(Date.now() + Math.random());
}

export default function App() {
  const qa = useQa();
  const { theme, toggleTheme } = useTheme();
  const [record, setRecord] = useState<RecordEntry[]>([]);
  const [qaOpen, setQaOpen] = useState(false);

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

  // Ask mode: while on, every utterance is sent straight to ask() instead
  // of just being transcribed. A ref (not just the state) because
  // onFinalUtterance is a stable callback captured once by
  // useSpeechRecognition's effect; reading state there would close over a
  // stale value instead of whatever askMode actually is at the time each
  // utterance comes in.
  const [askMode, setAskMode] = useState(false);
  const askModeRef = useRef(false);

  // Plain listening never auto-answers, even if something sounds like a
  // question — it's a pure, accurate transcript of whatever was actually
  // heard, nothing guessed or interpreted. The only way to get an answer
  // from voice is to explicitly say so via ask mode (❓); typing a question
  // always answers it too. Recording itself never stops when ask mode
  // toggles on/off — it only changes how new utterances are classified, on
  // the same continuous session, so nothing said in between is ever missed.
  const onFinalUtterance = useCallback(
    (utterance: string) => {
      if (askModeRef.current) ask(utterance);
      else addNote(utterance);
    },
    [ask, addNote],
  );

  const { supported, listening, interim, activeLang, toggle } =
    useSpeechRecognition(onFinalUtterance);

  // Stopping the mic entirely also drops ask mode — there's nothing left
  // listening for it to apply to.
  const toggleListening = useCallback(() => {
    if (listening) {
      askModeRef.current = false;
      setAskMode(false);
    }
    toggle();
  }, [listening, toggle]);

  // Turning ask mode on starts the mic too if it wasn't already running
  // (so a single click is enough to start asking); turning it off just
  // reverts to auto-detection without stopping the mic, so continuous
  // recording carries on right through it either way.
  const toggleAskMode = useCallback(() => {
    const next = !askModeRef.current;
    askModeRef.current = next;
    setAskMode(next);
    if (next && !listening) toggle();
  }, [listening, toggle]);

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
    <div className="term-app">
      <div className="title-bar">
        <span className="title-text">
          <span className="glyph">&gt;_</span>
          C:\Users\Guest\VoiceDocAssistant
        </span>
        <span className="win-controls">
          <button
            className="theme-toggle"
            onClick={toggleTheme}
            title={
              theme === "dark"
                ? "Switch to light mode"
                : theme === "light"
                  ? "Switch to transparent mode"
                  : "Switch to dark mode"
            }
          >
            {theme === "dark" ? "☀ Light" : theme === "light" ? "◐ Glass" : "☾ Dark"}
          </button>
          <span className="min">_</span>
          <span className="max">□</span>
          <span className="close">×</span>
        </span>
      </div>

      <header>
        <h1>
          Voice Doc Assistant<span className="caret">&nbsp;</span>
        </h1>
        <p className="tagline">
          Start talking — everything you say is transcribed as plain text.
          Turn on ❓ ask mode (or just type) to get an answer from your saved
          Q&A or Claude.
        </p>
      </header>

      <div className="workspace">
        <Console
          supported={supported}
          listening={listening}
          busy={busy}
          interim={interim}
          onToggleMic={toggleListening}
          askMode={askMode}
          onToggleAskMode={toggleAskMode}
          speechLang={activeLang}
          record={record}
          onAsk={ask}
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
          onImport={qa.importMany}
        />
      </div>

      {!supported && (
        <p className="unsupported">
          ⚠ Your browser doesn't support the Web Speech API — you can still
          type questions. Voice input needs Chrome or Edge.
        </p>
      )}
    </div>
  );
}
