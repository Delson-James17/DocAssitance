import { useState } from "react";
import type { Attachment } from "../types";

interface Props {
  files: Attachment[];
  open: boolean;
  onInsertClick: () => void;
  onUpload: (list: FileList | File[] | null) => Promise<boolean>;
  onRemove: (id: string) => Promise<void>;
  onRemoveMany: (ids: string[]) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
}

export function FileListPanel({
  files,
  open,
  onInsertClick,
  onUpload,
  onRemove,
  onRemoveMany,
  onRename,
}: Props) {
  const [dragging, setDragging] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  const allSelected = files.length > 0 && selected.size === files.length;

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(files.map((f) => f.id)));
  }

  async function handleDeleteSelected() {
    const ids = [...selected];
    setSelected(new Set());
    await onRemoveMany(ids);
  }

  async function handleDelete(id: string) {
    setBusyId(id);
    await onRemove(id);
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setBusyId(null);
  }

  function startEdit(file: Attachment) {
    setEditingId(file.id);
    setEditValue(file.name);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditValue("");
  }

  async function commitEdit(id: string) {
    const name = editValue.trim();
    if (!name) return cancelEdit();
    setBusyId(id);
    await onRename(id, name);
    setBusyId(null);
    cancelEdit();
  }

  return (
    <aside
      className={`filelist-panel${open ? " open" : ""}${dragging ? " drag" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void onUpload(e.dataTransfer.files);
      }}
    >
      <div className="filelist-inner">
        <div className="panel-head">
          <h2>File List</h2>
          <button className="term-btn" onClick={onInsertClick}>
            [+ Insert]
          </button>
        </div>

        {files.length > 0 && (
          <div className="select-all-row">
            <label className="check-row">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
              />
              Select all ({files.length})
            </label>
            {selected.size > 0 && (
              <button
                className="link-btn"
                onClick={() => void handleDeleteSelected()}
              >
                Delete selected ({selected.size})
              </button>
            )}
          </div>
        )}

        <div className="term-listing filelist-listing">
          {files.length === 0 && (
            <p className="muted">
              0 file(s). Use <span className="kbd">[+ Insert]</span> or drop
              files here to attach.
            </p>
          )}

          {files.length > 0 && (
            <ul className="file-list">
              {files.map((file) => (
                <li key={file.id} className={busyId === file.id ? "busy" : ""}>
                  <input
                    type="checkbox"
                    checked={selected.has(file.id)}
                    onChange={() => toggleOne(file.id)}
                  />
                  {file.mimetype.startsWith("image/") && (
                    <img
                      className="file-thumb"
                      src={`/api/attachments/${encodeURIComponent(file.id)}/raw`}
                      alt=""
                    />
                  )}
                  {editingId === file.id ? (
                    <input
                      className="edit-input"
                      autoFocus
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void commitEdit(file.id);
                        if (e.key === "Escape") cancelEdit();
                      }}
                      onBlur={() => void commitEdit(file.id)}
                    />
                  ) : (
                    <>
                      <span className="file-name">{file.name}</span>
                      <span className="file-actions">
                        <button
                          className="icon-btn"
                          title="Rename"
                          onClick={() => startEdit(file)}
                          disabled={busyId === file.id}
                        >
                          [edit]
                        </button>
                        <button
                          className="icon-btn danger"
                          title="Delete"
                          onClick={() => void handleDelete(file.id)}
                          disabled={busyId === file.id}
                        >
                          [del]
                        </button>
                      </span>
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
