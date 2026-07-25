import { useMemo, useRef, useState } from "react";
import { normalizeQuestion } from "../lib/dedupe";
import { parseQaImportFile } from "../lib/qaImport";
import type { QaEntry } from "../types";

interface Props {
  entries: QaEntry[];
  open: boolean;
  onAdd: (question: string, answer: string) => Promise<void>;
  onUpdate: (id: string, fields: { question?: string; answer?: string }) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onImport: (pairs: { question: string; answer: string }[]) => Promise<number>;
}

// Collapsible drawer for the manually-curated Q&A table: an add form up
// top, the saved list (question + answer, editable in place) below.
export function QaPanel({ entries, open, onAdd, onUpdate, onRemove, onImport }: Props) {
  const [newQuestion, setNewQuestion] = useState("");
  const [newAnswer, setNewAnswer] = useState("");
  const [saving, setSaving] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editQuestion, setEditQuestion] = useState("");
  const [editAnswer, setEditAnswer] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const importInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);

  const [search, setSearch] = useState("");
  // Keyword filter over the question text only — every typed word must
  // appear somewhere in the question (in any order, not as one contiguous
  // phrase). A whole-phrase substring match missed entries whenever the
  // words in the search weren't adjacent in that exact order (e.g.
  // "inheritance polymorphism" wouldn't match "difference between
  // Inheritance and Polymorphism"); this checks each word independently.
  const filtered = useMemo(() => {
    const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return entries;
    return entries.filter((e) => {
      const q = e.question.toLowerCase();
      return terms.every((term) => q.includes(term));
    });
  }, [entries, search]);

  async function handleAdd() {
    const question = newQuestion.trim();
    const answer = newAnswer.trim();
    if (!question || !answer) return;
    setSaving(true);
    await onAdd(question, answer);
    setSaving(false);
    setNewQuestion("");
    setNewAnswer("");
  }

  function startEdit(entry: QaEntry) {
    setEditingId(entry.id);
    setEditQuestion(entry.question);
    setEditAnswer(entry.answer);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditQuestion("");
    setEditAnswer("");
  }

  async function commitEdit(id: string) {
    const question = editQuestion.trim();
    const answer = editAnswer.trim();
    if (!question || !answer) return cancelEdit();
    setBusyId(id);
    await onUpdate(id, { question, answer });
    setBusyId(null);
    cancelEdit();
  }

  async function handleDelete(id: string) {
    setBusyId(id);
    await onRemove(id);
    setBusyId(null);
  }

  // Parses the picked .csv/.json file, drops rows that are empty or already
  // saved (exact-ish match against the current list, so re-importing the
  // same file twice doesn't double everything up), then bulk-adds the rest
  // in one request and reports back what happened.
  async function handleImportFile(file: File) {
    setImporting(true);
    try {
      const rows = await parseQaImportFile(file);
      const seen = new Set(entries.map((e) => normalizeQuestion(e.question)));
      const fresh: { question: string; answer: string }[] = [];
      let skippedEmpty = 0;
      let skippedDuplicate = 0;

      for (const row of rows) {
        if (!row.question || !row.answer) {
          skippedEmpty++;
          continue;
        }
        const norm = normalizeQuestion(row.question);
        if (seen.has(norm)) {
          skippedDuplicate++;
          continue;
        }
        seen.add(norm);
        fresh.push(row);
      }

      if (fresh.length === 0) {
        alert("Nothing to import — every row was empty or already saved.");
        return;
      }

      const imported = await onImport(fresh);
      const summary = [`Imported ${imported} question${imported === 1 ? "" : "s"}.`];
      if (skippedDuplicate > 0) summary.push(`${skippedDuplicate} already saved, skipped.`);
      if (skippedEmpty > 0) summary.push(`${skippedEmpty} row(s) missing a question or answer, skipped.`);
      alert(summary.join(" "));
    } catch (err) {
      alert(err instanceof Error ? err.message : "Couldn't import the file.");
    } finally {
      setImporting(false);
    }
  }

  return (
    <aside className={`filelist-panel${open ? " open" : ""}`}>
      <div className="filelist-inner">
        <div className="panel-head">
          <h2>Saved Q&amp;A</h2>
          <button
            className="term-btn"
            title="Bulk-add from a .csv (question,answer columns) or .json file"
            onClick={() => importInputRef.current?.click()}
            disabled={importing}
          >
            {importing ? "Importing…" : "⭱ Import"}
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept=".csv,.json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void handleImportFile(file);
            }}
          />
        </div>

        {entries.length > 0 && (
          <div className="qa-search">
            <input
              className="edit-input"
              placeholder="Search saved Q&A…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button className="icon-btn" title="Clear search" onClick={() => setSearch("")}>
                [x]
              </button>
            )}
            {search && (
              <span className="muted qa-search-count">
                {filtered.length} of {entries.length}
              </span>
            )}
          </div>
        )}

        <div className="qa-form">
          <input
            className="edit-input"
            placeholder="Question…"
            value={newQuestion}
            onChange={(e) => setNewQuestion(e.target.value)}
          />
          <textarea
            className="edit-input qa-answer-input"
            placeholder="Answer…"
            rows={3}
            value={newAnswer}
            onChange={(e) => setNewAnswer(e.target.value)}
          />
          <button
            className="term-btn"
            onClick={() => void handleAdd()}
            disabled={saving || !newQuestion.trim() || !newAnswer.trim()}
          >
            {saving ? "Saving…" : "+ Save Q&A"}
          </button>
          <p className="muted qa-hint">
            Or <strong>⭱ Import</strong> a .csv (header row: question, answer)
            or a .json file — an array of {"{question, answer}"}, or an
            object mapping questions to answers.
          </p>
        </div>

        <div className="term-listing filelist-listing">
          {entries.length === 0 && (
            <p className="muted">
              No saved answers yet. Add a question and answer above — a close
              match always wins over document search or Claude, for free.
            </p>
          )}

          {entries.length > 0 && filtered.length === 0 && (
            <p className="muted">No matches for "{search}".</p>
          )}

          {filtered.length > 0 && (
            <ul className="qa-list">
              {filtered.map((entry) => (
                <li key={entry.id} className={`qa-item${busyId === entry.id ? " busy" : ""}`}>
                  {editingId === entry.id ? (
                    <div className="qa-form">
                      <input
                        className="edit-input"
                        autoFocus
                        value={editQuestion}
                        onChange={(e) => setEditQuestion(e.target.value)}
                        onKeyDown={(e) => e.key === "Escape" && cancelEdit()}
                      />
                      <textarea
                        className="edit-input qa-answer-input"
                        rows={3}
                        value={editAnswer}
                        onChange={(e) => setEditAnswer(e.target.value)}
                        onKeyDown={(e) => e.key === "Escape" && cancelEdit()}
                      />
                      <span className="file-actions">
                        <button className="icon-btn" onClick={() => void commitEdit(entry.id)}>
                          [save]
                        </button>
                        <button className="icon-btn" onClick={cancelEdit}>
                          [cancel]
                        </button>
                      </span>
                    </div>
                  ) : (
                    <>
                      <div className="qa-item-head">
                        <span className="qa-question">{entry.question}</span>
                        <span className="file-actions">
                          <button
                            className="icon-btn"
                            title="Edit"
                            onClick={() => startEdit(entry)}
                            disabled={busyId === entry.id}
                          >
                            [edit]
                          </button>
                          <button
                            className="icon-btn danger"
                            title="Delete"
                            onClick={() => void handleDelete(entry.id)}
                            disabled={busyId === entry.id}
                          >
                            [del]
                          </button>
                        </span>
                      </div>
                      <p className="qa-answer">{entry.answer}</p>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </aside>
  );
}
