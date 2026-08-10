import { useMemo, useRef, useState } from "react";
import { normalizeQuestion } from "../lib/dedupe";
import { parseQaImportFile } from "../lib/qaImport";
import type { QaEntry } from "../types";

// Textarea (one phrasing per line) <-> string[] — used for both the add
// form and per-item editing.
function parseAlternates(text: string): string[] {
  return Array.from(
    new Set(
      text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  );
}

// The assignable quick-recall keys, grouped the way they physically sit on
// the keyboard so the dropdown reads like the thing you're about to press:
// the number row first, then the three QWERTY letter rows. 36 keys in all —
// far more entries can be reached instantly than the digits alone allowed.
// "." and space are deliberately left out: they're already the record / ask
// mode shortcuts (see App.tsx).
const HOTKEY_ROWS: { label: string; keys: string[] }[] = [
  { label: "Number row", keys: [..."1234567890"] },
  { label: "QWERTY row", keys: [..."qwertyuiop"] },
  { label: "Home row", keys: [..."asdfghjkl"] },
  { label: "Bottom row", keys: [..."zxcvbnm"] },
];

interface Props {
  entries: QaEntry[];
  open: boolean;
  onAdd: (question: string, answer: string, alternates?: string[]) => Promise<void>;
  onUpdate: (
    id: string,
    fields: { question?: string; answer?: string; alternates?: string[]; hotkey?: string | null },
  ) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onRemoveAll: () => Promise<void>;
  onImport: (
    pairs: { question: string; answer: string; alternates?: string[] }[],
  ) => Promise<number>;
}

// Collapsible drawer for the manually-curated Q&A table: an add form up
// top, the saved list (question + answer, editable in place) below.
export function QaPanel({
  entries,
  open,
  onAdd,
  onUpdate,
  onRemove,
  onRemoveAll,
  onImport,
}: Props) {
  const [newQuestion, setNewQuestion] = useState("");
  const [newAnswer, setNewAnswer] = useState("");
  const [newAlternates, setNewAlternates] = useState("");
  const [saving, setSaving] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editQuestion, setEditQuestion] = useState("");
  const [editAnswer, setEditAnswer] = useState("");
  const [editAlternates, setEditAlternates] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const importInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);
  // First click arms the delete, second one carries it out. See handleDeleteAll.
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const [search, setSearch] = useState("");
  // Keyword filter over the question text *and* its alternate phrasings —
  // every typed word must appear somewhere in one of them (in any order,
  // not as one contiguous phrase). A whole-phrase substring match missed
  // entries whenever the words weren't adjacent in that exact order (e.g.
  // "inheritance polymorphism" wouldn't match "difference between
  // Inheritance and Polymorphism"); this checks each word independently.
  const filtered = useMemo(() => {
    const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return entries;
    return entries.filter((e) => {
      const haystack = [e.question, ...e.alternates].join(" ").toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }, [entries, search]);

  // key -> id of the entry currently holding it, so each dropdown can mark
  // the keys that are already taken.
  const hotkeyOwners = useMemo(() => {
    const owners = new Map<string, string>();
    for (const e of entries) if (e.hotkey) owners.set(e.hotkey, e.id);
    return owners;
  }, [entries]);

  async function handleAdd() {
    const question = newQuestion.trim();
    const answer = newAnswer.trim();
    if (!question || !answer) return;
    setSaving(true);
    await onAdd(question, answer, parseAlternates(newAlternates));
    setSaving(false);
    setNewQuestion("");
    setNewAnswer("");
    setNewAlternates("");
  }

  function startEdit(entry: QaEntry) {
    setEditingId(entry.id);
    setEditQuestion(entry.question);
    setEditAnswer(entry.answer);
    setEditAlternates(entry.alternates.join("\n"));
  }

  function cancelEdit() {
    setEditingId(null);
    setEditQuestion("");
    setEditAnswer("");
    setEditAlternates("");
  }

  async function commitEdit(id: string) {
    const question = editQuestion.trim();
    const answer = editAnswer.trim();
    if (!question || !answer) return cancelEdit();
    setBusyId(id);
    await onUpdate(id, { question, answer, alternates: parseAlternates(editAlternates) });
    setBusyId(null);
    cancelEdit();
  }

  async function handleDelete(id: string) {
    setBusyId(id);
    await onRemove(id);
    setBusyId(null);
  }

  // Two clicks on purpose: this wipes every curated answer from the database,
  // there is no undo, and the button sits next to Import where a misclick is
  // easy. The single-entry [del] stays a one-click action.
  //
  // Confirmed in the UI rather than with a dialog. window.prompt() throws
  // outright in Electron ("prompt() is not supported."), which silently killed
  // the whole handler — the button appeared to do nothing at all. Nothing here
  // depends on the host providing dialogs.
  async function handleDeleteAll() {
    const count = entries.length;
    if (count === 0) return;

    if (!confirmingDelete) {
      setConfirmingDelete(true);
      // Arming this shouldn't stay armed indefinitely — walking away and
      // coming back to a primed delete button is exactly the misclick this is
      // meant to prevent.
      window.setTimeout(() => setConfirmingDelete(false), 6000);
      return;
    }

    setConfirmingDelete(false);
    setDeletingAll(true);
    try {
      await onRemoveAll();
    } finally {
      setDeletingAll(false);
    }
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
      const fresh: { question: string; answer: string; alternates?: string[] }[] = [];
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
          <button
            className={`link-btn${confirmingDelete ? " danger-armed" : ""}`}
            title={
              confirmingDelete
                ? "Click again to permanently delete every saved entry — this cannot be undone"
                : "Delete every saved Q&A entry"
            }
            onClick={handleDeleteAll}
            disabled={entries.length === 0 || deletingAll}
          >
            {deletingAll
              ? "Deleting…"
              : confirmingDelete
                ? `Delete all ${entries.length}? Click again`
                : "✕ Delete all"}
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
          <textarea
            className="edit-input qa-answer-input"
            placeholder="Other ways to ask this (one per line) — e.g. &quot;Walk me through your resume.&quot;"
            rows={2}
            value={newAlternates}
            onChange={(e) => setNewAlternates(e.target.value)}
          />
          <button
            className="term-btn"
            onClick={() => void handleAdd()}
            disabled={saving || !newQuestion.trim() || !newAnswer.trim()}
          >
            {saving ? "Saving…" : "+ Save Q&A"}
          </button>
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
                      <textarea
                        className="edit-input qa-answer-input"
                        placeholder="Other ways to ask this (one per line)"
                        rows={2}
                        value={editAlternates}
                        onChange={(e) => setEditAlternates(e.target.value)}
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
                        <span className="qa-item-controls">
                          <select
                            className="hotkey-select"
                            value={entry.hotkey ?? ""}
                            disabled={busyId === entry.id}
                            title="Quick-recall key — press this key (outside any text field) to instantly show this answer on screen, even if voice or typing isn't working. Assigning a key takes it from whichever entry currently has it."
                            onChange={(e) => {
                              // Hand focus back, or the key that was just
                              // assigned does nothing: the global shortcut
                              // handler ignores keystrokes aimed at a form
                              // control, so the <select> keeping focus
                              // swallows the very key it just bound.
                              e.target.blur();
                              void onUpdate(entry.id, { hotkey: e.target.value || null });
                            }}
                          >
                            <option value="">Quick key: none</option>
                            {HOTKEY_ROWS.map((row) => (
                              <optgroup key={row.label} label={row.label}>
                                {row.keys.map((key) => {
                                  // Picking a key another entry holds is allowed
                                  // (it just moves), but with 36 of them it's
                                  // worth saying which are already spoken for.
                                  const owner = hotkeyOwners.get(key);
                                  return (
                                    <option key={key} value={key}>
                                      Quick key: {key.toUpperCase()}
                                      {owner && owner !== entry.id ? " (in use)" : ""}
                                    </option>
                                  );
                                })}
                              </optgroup>
                            ))}
                          </select>
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
                        </span>
                      </div>
                      <p className="qa-answer">{entry.answer}</p>
                      {entry.alternates.length > 0 && (
                        <p className="qa-alternates muted">
                          Also matches: {entry.alternates.join(" · ")}
                        </p>
                      )}
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
