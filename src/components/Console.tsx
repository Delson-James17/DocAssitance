import { useState } from "react";
import type { RecordEntry } from "../types";

type QaSource = Extract<RecordEntry, { kind: "qa" }>["source"];

// Labels where an answer came from. "AI" is the only path that spends
// tokens — the other paths are free, which is also why they get the
// brighter, accent-colored badges while AI gets a plain, muted one. "none"
// (AI off, nothing saved matched) gets no badge — the error text says it all.
function SourceTag({ source }: { source: QaSource }) {
  if (source === "cache") {
    return (
      <span className="src-tag cache" title="Reused from an earlier answer to this same question — no tokens spent">
        Cached
      </span>
    );
  }
  if (source === "saved") {
    return (
      <span className="src-tag saved" title="Matched a manually-curated Q&A entry — no tokens spent">
        Saved
      </span>
    );
  }
  if (source === "claude") {
    return (
      <span className="src-tag ai" title="Answered by Claude — uses tokens">
        AI
      </span>
    );
  }
  return null;
}

interface Props {
  supported: boolean;
  listening: boolean;
  busy: boolean;
  interim: string;
  onToggleMic: () => void;
  askMode: boolean;
  onToggleAskMode: () => void;
  speechLang: "en-US" | "fil-PH";
  record: RecordEntry[];
  onAsk: (question: string) => void;
  aiEnabled: boolean;
  onToggleAi: () => void;
  onDownload: () => void;
  onDownloadQa: () => void;
  onClear: () => void;
  qaCount: number;
  qaOpen: boolean;
  onToggleQa: () => void;
}

export function Console({
  supported,
  listening,
  busy,
  interim,
  onToggleMic,
  askMode,
  onToggleAskMode,
  speechLang,
  record,
  onAsk,
  aiEnabled,
  onToggleAi,
  onDownload,
  onDownloadQa,
  onClear,
  qaCount,
  qaOpen,
  onToggleQa,
}: Props) {
  const [typed, setTyped] = useState("");
  // Conversation is the full transcript of everything said — every note,
  // *and* every question exactly as spoken/typed, since a question is still
  // something that was said and belongs in the record of the conversation.
  // What's exclusive to Q&A only is the generated *answer*: Conversation
  // renders a qa entry as just its question line (see the view === "notes"
  // branch below), never the answer or its source badge. Each tab has its
  // own download regardless of which is currently showing.
  const [view, setView] = useState<"notes" | "qa">("notes");
  const status = !listening
    ? "idle"
    : askMode
      ? "asking"
      : busy
        ? "thinking"
        : "listening";
  const qaEntries = record.filter(
    (e): e is Extract<RecordEntry, { kind: "qa" }> => e.kind === "qa",
  );
  const latestQa = qaEntries[0];
  const visibleRecord = view === "qa" ? qaEntries : record;

  // Live partial speech only belongs in the Question box while ask mode is
  // actually on — otherwise plain listening would flash whatever's
  // currently being said through the box, then revert once it turns out
  // not to be a question, which just looks broken. Recording into the
  // Conversation tab (via App.tsx's onFinalUtterance/addNote) doesn't go
  // through this component at all, so it keeps going exactly the same
  // regardless of what these boxes show — this is purely a display filter,
  // not a gate on what actually gets recorded.
  const questionText = (askMode ? interim : "") || latestQa?.question || "";
  const questionLive = askMode && Boolean(interim);

  function submitTyped() {
    const q = typed.trim();
    if (!q) return;
    onAsk(q);
    setTyped("");
  }

  return (
    <section className="panel console-panel">
      <div className="panel-head">
        <h2>
          <span className="prompt-chevron">C:\&gt;</span> voice-doc-assistant
        </h2>
        <div className="panel-head-actions">
          <button
            className={`term-btn ai-toggle${aiEnabled ? "" : " off"}`}
            title={
              aiEnabled
                ? "AI is on — questions are sent to Claude and cost tokens. Click to turn off."
                : "AI is off — only saved Q&A can answer, nothing is sent to Claude (zero cost). Click to turn on."
            }
            onClick={onToggleAi}
          >
            {aiEnabled ? "◉ AI: ON" : "○ AI: OFF"}
          </button>
          <button
            className="term-btn"
            title="Download just the Q&A exchanges as .txt — no notes or misheard fragments"
            onClick={onDownloadQa}
            disabled={qaEntries.length === 0}
          >
            ⭳ Q&amp;A
          </button>
          <button
            className="term-btn"
            title="Download the whole record as .txt — every note and Q&A, in order"
            onClick={onDownload}
            disabled={record.length === 0}
          >
            ⭳ Full Log
          </button>
          <button
            className="link-btn"
            title="Clear the whole conversation record"
            onClick={onClear}
            disabled={record.length === 0}
          >
            ✕ Clear
          </button>
          <span className={`status ${status}`}>{status}</span>
        </div>
      </div>

      <div className="console-body">
        <div className="qa-mini">
          <div className="mini-field">
            <span className="mini-label">Question</span>
            <div className={`mini-box${questionLive ? " live" : ""}`}>
              {questionText || <span className="muted">…</span>}
            </div>
          </div>
          <div className="mini-field">
            <span className="mini-label">
              Answer
              {latestQa && <SourceTag source={latestQa.source} />}
            </span>
            <div className={`mini-box${latestQa?.pending ? " pending" : ""}`}>
              {latestQa?.error ? (
                <span className="err">⚠ {latestQa.error}</span>
              ) : (
                latestQa?.answer || <span className="muted">…</span>
              )}
            </div>
          </div>
        </div>

        <div className="scrollback" aria-live="polite">
          <div className="scrollback-tabs">
            <button
              className={`tab-btn${view === "notes" ? " active" : ""}`}
              onClick={() => setView("notes")}
            >
              Conversation
            </button>
            <button
              className={`tab-btn${view === "qa" ? " active" : ""}`}
              onClick={() => setView("qa")}
            >
              Q&amp;A only
            </button>
          </div>

          {visibleRecord.length === 0 && (
            <p className="muted scrollback-empty">
              {view === "qa"
                ? "No questions answered yet — turn on ❓ ask mode, or type a question below."
                : "No history yet. Speak below — everything you say (including questions) is transcribed here, word for word."}
            </p>
          )}
          {visibleRecord.map((e) => {
            // Conversation is a uniform plain-text transcript — a question
            // renders exactly like a note (same "»" prefix, no "C:\>"
            // prompt), since here it's just something that was said, not
            // yet an interaction with an answer. Q&A only is where the
            // command-prompt framing and the answer itself belong.
            if (view === "notes") {
              const text = e.kind === "note" ? e.text : e.question;
              return (
                <div className="log-entry" key={e.id}>
                  <p className="log-note">{text}</p>
                </div>
              );
            }
            if (e.kind !== "qa") return null;
            return (
              <div className="log-entry" key={e.id}>
                <p className="log-q">
                  <span className="prompt-chevron">C:\&gt;</span> {e.question}
                </p>
                <p
                  className={
                    "log-a" +
                    (e.pending ? " pending" : "") +
                    (e.error ? " error" : "")
                  }
                >
                  <SourceTag source={e.source} /> {e.error ? `⚠ ${e.error}` : e.answer}
                </p>
              </div>
            );
          })}
        </div>
      </div>

      <div className="command-bar">
        <button
          className={`round-btn${listening ? " on" : ""}`}
          onClick={onToggleMic}
          disabled={!supported}
          title={
            listening
              ? "Stop listening"
              : "Start listening — everything you say is transcribed as plain text, nothing is answered automatically"
          }
        >
          {listening ? "⏸" : "▶"}
        </button>

        <button
          className={`round-btn ask-btn${askMode ? " on" : ""}`}
          onClick={onToggleAskMode}
          disabled={!supported}
          title={
            askMode
              ? "Turn off ask mode — back to plain transcription (recording keeps going)"
              : listening
                ? "Switch to ask mode — everything you say from here is answered instead of just transcribed, recording keeps going"
                : "Ask a question by voice — starts listening and answers everything you say until you turn it off"
          }
        >
          ❓
        </button>

        <span
          className="lang-badge"
          title={`Auto-detected speech language: ${speechLang === "en-US" ? "English" : "Filipino"} — adapts automatically as you talk`}
        >
          [{speechLang === "en-US" ? "EN" : "FIL"}]
        </span>

        <input
          className="cmd-input"
          placeholder={
            !aiEnabled
              ? "AI is off — only saved Q&A can answer…"
              : supported
                ? "Type a question and press Enter…"
                : "Type a question…"
          }
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitTyped();
          }}
        />

        <button
          className={`square-btn${qaOpen ? " active" : ""}`}
          title="Saved Q&A — manually-curated answers, checked before Claude"
          onClick={onToggleQa}
        >
          [?{qaCount > 0 ? ` ${qaCount}` : ""}]
        </button>
      </div>
    </section>
  );
}
