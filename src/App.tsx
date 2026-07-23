import { useCallback, useRef, useState } from "react";
import { Console } from "./components/Console";
import { FileListPanel } from "./components/FileListPanel";
import { useAttachments } from "./hooks/useAttachments";
import { useSpeechRecognition } from "./hooks/useSpeechRecognition";
import { useTheme } from "./hooks/useTheme";
import { askQuestion, fetchFaq, localSearch } from "./lib/api";
import { DUPLICATE_THRESHOLD, similarity } from "./lib/dedupe";
import { downloadFaq } from "./lib/faqExport";
import { isQuestion } from "./lib/isQuestion";
import { formatLocalSearchAnswer } from "./lib/localSearchAnswer";
import { captureScreenshot, screenshotSupported } from "./lib/screenshot";
import { downloadTranscript } from "./lib/transcript";
import type { RecordEntry } from "./types";

interface CachedAnswer {
  fileKey: string;
  question: string;
  answer: string;
}

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : String(Date.now() + Math.random());
}

export default function App() {
  const { files, upload, remove, removeMany, rename } = useAttachments();
  const { theme, toggleTheme } = useTheme();
  const [record, setRecord] = useState<RecordEntry[]>([]);
  const [filesOpen, setFilesOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  // Answers already paid for, keyed to the exact set of attached files they
  // were computed against (an id-set fingerprint, not just names) — if the
  // attachments change, cached answers no longer apply and are skipped.
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

  // Every question — typed, spoken, or screenshot-triggered — funnels
  // through here. Three paths, in order: (1) a near-duplicate of an
  // earlier question against the same files is answered from cache, no
  // network call at all; (2) with AI off, a free local keyword search over
  // already-extracted attachment text; (3) otherwise, ask Claude, and cache
  // the result for next time.
  const ask = useCallback(
    (question: string) => {
      const fileKey = files.map((f) => f.id).slice().sort().join(",");

      const cached = answerCacheRef.current.find(
        (c) =>
          c.fileKey === fileKey &&
          similarity(c.question, question) >= DUPLICATE_THRESHOLD,
      );
      if (cached) {
        pushQa({ question, answer: cached.answer, pending: false, source: "cache" });
        return;
      }

      if (!aiEnabled) {
        const id = pushQa({ question, answer: "", pending: true, source: "local" });
        localSearch(question)
          .then((result) => {
            const answer = formatLocalSearchAnswer(result);
            patchQa(id, { pending: false, answer });
            answerCacheRef.current = [
              { fileKey, question, answer },
              ...answerCacheRef.current,
            ].slice(0, 50);
          })
          .catch((err) => {
            patchQa(id, {
              pending: false,
              error: err instanceof Error ? err.message : "Local search failed.",
            });
          });
        return;
      }

      const id = pushQa({ question, answer: "", pending: true, source: "claude" });

      void askQuestion(question, {
        onDelta: (text) =>
          setRecord((prev) =>
            prev.map((e) =>
              e.id === id && e.kind === "qa" ? { ...e, answer: e.answer + text } : e,
            ),
          ),
        onDone: (answer) => {
          patchQa(id, { pending: false, answer });
          answerCacheRef.current = [
            { fileKey, question, answer },
            ...answerCacheRef.current,
          ].slice(0, 50);
        },
        onError: (message) => patchQa(id, { pending: false, error: message }),
      });
    },
    [aiEnabled, files, pushQa, patchQa],
  );

  // Each finished utterance either gets answered (it reads as a question)
  // or is just transcribed into the record.
  const onFinalUtterance = useCallback(
    (utterance: string) => {
      if (isQuestion(utterance)) ask(utterance);
      else addNote(utterance);
    },
    [ask, addNote],
  );

  const { supported, listening, interim, activeLang, toggle } =
    useSpeechRecognition(onFinalUtterance);

  const busy = record.some((e) => e.kind === "qa" && e.pending);

  const [faqBusy, setFaqBusy] = useState(false);

  // Downloads a free, locally-generated preview of sample questions/answers
  // this app can read from the attached files — never calls Claude.
  const handleExportFaq = useCallback(async () => {
    setFaqBusy(true);
    try {
      downloadFaq(await fetchFaq());
    } catch (err) {
      alert(err instanceof Error ? err.message : "Couldn't generate sample Q&A.");
    } finally {
      setFaqBusy(false);
    }
  }, []);

  // Wipes the on-screen record (and the answer cache keyed to it) — nothing
  // server-side to undo, but it's the whole conversation so confirm first
  // rather than lose it to a stray click.
  const handleClear = useCallback(() => {
    if (record.length === 0) return;
    if (!window.confirm("Clear the whole conversation record? This can't be undone.")) return;
    setRecord([]);
    answerCacheRef.current = [];
  }, [record.length]);

  const [screenshotBusy, setScreenshotBusy] = useState(false);

  // Capture the screen/window/tab the user picks, attach it, and ask about
  // it right away — no separate "now type your question" step. Screenshots
  // are images, so local keyword search can't read them (see
  // local-search.service.js) — auto-asking with AI off would just report
  // "no match," so just attach and say so instead.
  const handleScreenshot = useCallback(async () => {
    setScreenshotBusy(true);
    try {
      const file = await captureScreenshot();
      const attached = await upload([file]);
      if (attached) {
        if (aiEnabled) ask("What does this screenshot show?");
        else addNote(`Screenshot attached (${file.name}) — turn AI on to ask about it.`);
      }
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
  }, [upload, ask, aiEnabled, addNote]);

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
          speechLang={activeLang}
          record={record}
          onAsk={ask}
          aiEnabled={aiEnabled}
          onToggleAi={toggleAi}
          onDownload={() => downloadTranscript(record)}
          onClear={handleClear}
          onExportFaq={handleExportFaq}
          faqBusy={faqBusy}
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
