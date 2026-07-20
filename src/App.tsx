import { useCallback, useRef, useState } from "react";
import { Console } from "./components/Console";
import { FileListPanel } from "./components/FileListPanel";
import { useAttachments } from "./hooks/useAttachments";
import { useSpeechRecognition } from "./hooks/useSpeechRecognition";
import { askQuestion } from "./lib/api";
import { isQuestion } from "./lib/isQuestion";
import { captureScreenshot, screenshotSupported } from "./lib/screenshot";
import { downloadTranscript } from "./lib/transcript";
import type { RecordEntry } from "./types";

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : String(Date.now() + Math.random());
}

export default function App() {
  const { files, upload, remove, removeMany, rename } = useAttachments();
  const [record, setRecord] = useState<RecordEntry[]>([]);
  const [filesOpen, setFilesOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Stream an answer for one question, updating its entry as deltas arrive.
  const ask = useCallback((question: string) => {
    const id = newId();

    setRecord((prev) => [
      { id, kind: "qa", question, answer: "", pending: true, timestamp: Date.now() },
      ...prev,
    ]);

    const patch = (fields: Partial<Extract<RecordEntry, { kind: "qa" }>>) =>
      setRecord((prev) =>
        prev.map((e) => (e.id === id && e.kind === "qa" ? { ...e, ...fields } : e)),
      );

    void askQuestion(question, {
      onDelta: (text) =>
        setRecord((prev) =>
          prev.map((e) =>
            e.id === id && e.kind === "qa" ? { ...e, answer: e.answer + text } : e,
          ),
        ),
      onDone: (answer) => patch({ pending: false, answer }),
      onError: (message) => patch({ pending: false, error: message }),
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

  // Each finished utterance either gets answered (it reads as a question)
  // or is just transcribed into the record.
  const onFinalUtterance = useCallback(
    (utterance: string) => {
      if (isQuestion(utterance)) ask(utterance);
      else addNote(utterance);
    },
    [ask, addNote],
  );

  const { supported, listening, interim, toggle } =
    useSpeechRecognition(onFinalUtterance);

  const busy = record.some((e) => e.kind === "qa" && e.pending);

  const [screenshotBusy, setScreenshotBusy] = useState(false);

  // Capture the screen/window/tab the user picks, attach it, and ask about
  // it right away — no separate "now type your question" step.
  const handleScreenshot = useCallback(async () => {
    setScreenshotBusy(true);
    try {
      const file = await captureScreenshot();
      await upload([file]);
      ask("What does this screenshot show?");
    } catch (err) {
      const cancelled =
        err instanceof DOMException &&
        (err.name === "NotAllowedError" || err.name === "AbortError");
      if (!cancelled) {
        alert(err instanceof Error ? err.message : "Screenshot failed.");
      }
    } finally {
      setScreenshotBusy(false);
    }
  }, [upload, ask]);

  return (
    <div className="term-app">
      <div className="title-bar">
        <span className="title-text">
          <span className="glyph">&gt;_</span>
          C:\Users\Guest\VoiceDocAssistant
        </span>
        <span className="win-controls">
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
          Attach your files, start talking. Everything you say is recorded as
          text — questions get answered, everything else just joins the log.
        </p>
      </header>

      <div className="workspace">
        <Console
          supported={supported}
          listening={listening}
          busy={busy}
          interim={interim}
          onToggleMic={toggle}
          record={record}
          onAsk={ask}
          onDownload={() => downloadTranscript(record)}
          onScreenshot={handleScreenshot}
          screenshotSupported={screenshotSupported()}
          screenshotBusy={screenshotBusy}
          fileCount={files.length}
          filesOpen={filesOpen}
          onToggleFiles={() => setFilesOpen((v) => !v)}
          onInsertClick={() => fileInputRef.current?.click()}
        />
        <FileListPanel
          files={files}
          open={filesOpen}
          onInsertClick={() => fileInputRef.current?.click()}
          onUpload={upload}
          onRemove={remove}
          onRemoveMany={removeMany}
          onRename={rename}
        />
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          void upload(e.target.files);
          e.target.value = "";
        }}
      />

      {!supported && (
        <p className="unsupported">
          ⚠ Your browser doesn't support the Web Speech API — you can still
          type questions. Voice input needs Chrome or Edge.
        </p>
      )}
    </div>
  );
}
