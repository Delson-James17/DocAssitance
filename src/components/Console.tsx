import { useState } from "react";
import { CODE_LANGUAGE_PRESETS, type CodeLanguagePreset } from "../lib/api";
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
  starting: boolean;
  listening: boolean;
  busy: boolean;
  interim: string;
  onToggleMic: () => void;
  audioSource: "headset" | "mic";
  onToggleAudioSource: () => void;
  record: RecordEntry[];
  onAsk: (question: string) => void;
  onScreenshot: () => void;
  /** False in the web build — there's no OS-level screen capture to call. */
  screenshotAvailable: boolean;
  aiEnabled: boolean;
  onToggleAi: () => void;
  onDownload: () => void;
  onDownloadQa: () => void;
  /** Undefined in the web build — there's no local logs folder to open. */
  onOpenLogsFolder?: () => void;
  /** Forces any code Claude writes into this language — "auto" leaves it to Claude's own judgment. */
  codeLanguagePreset: CodeLanguagePreset;
  onCodeLanguagePreset: (preset: CodeLanguagePreset) => void;
  onClear: () => void;
  qaCount: number;
  qaOpen: boolean;
  onToggleQa: () => void;
}

export function Console({
  supported,
  starting,
  listening,
  busy,
  interim,
  onToggleMic,
  audioSource,
  onToggleAudioSource,
  record,
  onAsk,
  onScreenshot,
  screenshotAvailable,
  aiEnabled,
  onToggleAi,
  onDownload,
  onDownloadQa,
  onOpenLogsFolder,
  codeLanguagePreset,
  onCodeLanguagePreset,
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
  const status = starting ? "preparing" : !listening ? "idle" : busy ? "thinking" : "listening";
  const qaEntries = record.filter(
    (e): e is Extract<RecordEntry, { kind: "qa" }> => e.kind === "qa",
  );
  const latestQa = qaEntries[0];
  const visibleRecord = view === "qa" ? qaEntries : record;

  // Whatever is being said right now, falling back to the last answered
  // question once speech stops. Purely a display choice — what actually gets
  // recorded is decided in App.tsx's onFinalUtterance, not here.
  const questionText = interim || latestQa?.question || "";
  const questionLive = Boolean(interim);

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
          <select
            className="term-btn lang-select"
            value={codeLanguagePreset}
            onChange={(e) => onCodeLanguagePreset(e.target.value as CodeLanguagePreset)}
            title="Forces any code Claude writes into this language, even if the question doesn't say which one — Auto leaves it to Claude's own judgment. Pick Custom, then set the language name in Settings."
          >
            <option value="auto">Code: Auto</option>
            {CODE_LANGUAGE_PRESETS.map((lang) => (
              <option key={lang} value={lang}>
                Code: {lang}
              </option>
            ))}
            <option value="custom">Code: Custom…</option>
          </select>
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
          {onOpenLogsFolder ? (
            <button
              className="term-btn"
              title="Open the folder where session logs are auto-saved when you close the app"
              onClick={onOpenLogsFolder}
            >
              📂 Logs
            </button>
          ) : null}
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

          {/* Live caption. Speech is transcribed while it's still being
              spoken (see mic.ts's onPartial), so this entry updates as the
              words arrive and is replaced by the real one the moment the
              speaker stops. Conversation only — Q&A only lists answered
              questions, and a half-finished sentence isn't one yet. */}
          {view === "notes" && interim && (
            <div className="log-entry live">
              <p className="log-note live">
                {interim === "…" ? <span className="muted">Listening…</span> : interim}
                <span className="type-caret" />
              </p>
            </div>
          )}

          {visibleRecord.length === 0 && !interim && (
            <p className="muted scrollback-empty">
              {view === "qa"
                ? "No questions answered yet — press ▶ and ask one out loud, or type it below."
                : audioSource === "mic"
                  ? "No history yet. Press ▶ and speak — your microphone is transcribed and answered."
                  : "No history yet. Press ▶ while your meeting is playing — system audio is transcribed and answered."}
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
          disabled={!supported || starting}
          title={
            (starting
              ? `Preparing ${audioSource === "mic" ? "microphone" : "Windows system-audio"} capture — start speaking when this button turns red`
              : listening
                ? `Stop transcribing ${audioSource === "mic" ? "microphone" : "meeting/system"} audio`
                : audioSource === "mic"
                  ? "Start transcribing your microphone (no headset needed)"
                  : "Start transcribing meeting/system audio (works with headphones)") +
            " (shortcut: .)"
          }
        >
          {listening ? "⏸" : "▶"}
        </button>

        <button
          className={`term-btn source-toggle${audioSource === "mic" ? " mic" : ""}`}
          onClick={onToggleAudioSource}
          disabled={listening || starting}
          title={
            listening || starting
              ? "Stop listening to switch input source"
              : audioSource === "headset"
                ? "Input: Headset — transcribes meeting/system audio through headphones. Click to switch to microphone input (no headset)."
                : "Input: Mic — transcribes your microphone directly, no headset needed. Click to switch to headset/system-audio input."
          }
        >
          {audioSource === "headset" ? "🎧 Headset" : "🎤 Mic"}
        </button>

        <button
          className="square-btn"
          onClick={onScreenshot}
          disabled={!screenshotAvailable}
          title={
            screenshotAvailable
              ? "Screenshot — capture the screen and let Claude answer whatever question is shown in it"
              : "Screenshot is desktop-only — the browser build has no screen capture to call"
          }
        >
          📷
        </button>

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
