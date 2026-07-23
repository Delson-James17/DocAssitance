import { useState } from "react";
import type { RecordEntry } from "../types";

type QaSource = Extract<RecordEntry, { kind: "qa" }>["source"];

// Labels where an answer came from — "claude" is the normal (token-costing)
// path and gets no badge; the other two are free, so they're called out.
function SourceTag({ source }: { source: QaSource }) {
  if (source === "cache") {
    return (
      <span className="src-tag cache" title="Reused from an earlier answer to this same question — no tokens spent">
        cached
      </span>
    );
  }
  if (source === "local") {
    return (
      <span className="src-tag local" title="Local keyword search over attached text files — AI is off, no tokens spent">
        local
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
  speechLang: "en-US" | "fil-PH";
  record: RecordEntry[];
  onAsk: (question: string) => void;
  aiEnabled: boolean;
  onToggleAi: () => void;
  onDownload: () => void;
  onClear: () => void;
  onExportFaq: () => void;
  faqBusy: boolean;
  onScreenshot: () => void;
  screenshotSupported: boolean;
  screenshotBusy: boolean;
  fileCount: number;
  filesOpen: boolean;
  onToggleFiles: () => void;
  onInsertClick: () => void;
}

export function Console({
  supported,
  listening,
  busy,
  interim,
  onToggleMic,
  speechLang,
  record,
  onAsk,
  aiEnabled,
  onToggleAi,
  onDownload,
  onClear,
  onExportFaq,
  faqBusy,
  onScreenshot,
  screenshotSupported,
  screenshotBusy,
  fileCount,
  filesOpen,
  onToggleFiles,
  onInsertClick,
}: Props) {
  const [typed, setTyped] = useState("");
  const status = !listening ? "idle" : busy ? "thinking" : "listening";
  const latestQa = record.find(
    (e): e is Extract<RecordEntry, { kind: "qa" }> => e.kind === "qa",
  );

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
                : "AI is off — questions are only logged, nothing is sent to Claude (zero cost). Click to turn on."
            }
            onClick={onToggleAi}
          >
            {aiEnabled ? "◉ AI: ON" : "○ AI: OFF"}
          </button>
          <button
            className="term-btn"
            title="Download the whole record as .txt"
            onClick={onDownload}
            disabled={record.length === 0}
          >
            ⭳ Download
          </button>
          <button
            className="link-btn"
            title="Clear the whole conversation record"
            onClick={onClear}
            disabled={record.length === 0}
          >
            ✕ Clear
          </button>
          <button
            className="term-btn"
            title="Preview sample questions & answers this app can read from your attached files — generated locally, no AI used"
            onClick={onExportFaq}
            disabled={faqBusy}
          >
            {faqBusy ? "⭳ Sample Q&A…" : "⭳ Sample Q&A"}
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
          {record.length === 0 && (
            <p className="muted scrollback-empty">
              No history yet. Speak or type below — the whole record (every
              question and everything else you say) will scroll here.
            </p>
          )}
          {record.map((e) =>
            e.kind === "note" ? (
              <div className="log-entry" key={e.id}>
                <p className="log-note">{e.text}</p>
              </div>
            ) : (
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
            ),
          )}
        </div>
      </div>

      <div className="command-bar">
        <button
          className={`round-btn${listening ? " on" : ""}`}
          onClick={onToggleMic}
          disabled={!supported}
          title={listening ? "Stop listening" : "Start listening"}
        >
          {listening ? "⏸" : "▶"}
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
              ? "AI is off — questions will only be logged…"
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
          className="square-btn"
          title="Insert attachment"
          onClick={onInsertClick}
        >
          [+]
        </button>

        <button
          className="square-btn"
          title={
            screenshotSupported
              ? "Screenshot the page and ask about it"
              : "Screenshot capture isn't supported in this browser"
          }
          onClick={onScreenshot}
          disabled={!screenshotSupported || screenshotBusy}
        >
          {screenshotBusy ? "[…]" : "[📷]"}
        </button>

        <button
          className={`square-btn${filesOpen ? " active" : ""}`}
          title="File list"
          onClick={onToggleFiles}
        >
          [≡{fileCount > 0 ? ` ${fileCount}` : ""}]
        </button>
      </div>
    </section>
  );
}
