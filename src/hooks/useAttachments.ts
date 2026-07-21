import { useCallback, useEffect, useState } from "react";
import {
  MAX_UPLOAD_BYTES,
  listAttachments,
  removeAttachment,
  renameAttachment,
  uploadAttachments,
} from "../lib/api";
import type { Attachment } from "../types";

function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface UseAttachments {
  files: Attachment[];
  // Resolves to whether anything actually got uploaded — callers that chain
  // an action onto the upload (e.g. "attach this screenshot, then ask about
  // it") need to know it didn't silently no-op (oversized, rejected, etc).
  upload: (list: FileList | File[] | null) => Promise<boolean>;
  remove: (id: string) => Promise<void>;
  removeMany: (ids: string[]) => Promise<void>;
  rename: (id: string, name: string) => Promise<void>;
}

// Owns the attachment list and every mutation on it, so the console's insert
// icon and the file-list panel's own controls can both act on the same state
// without either one owning the other.
export function useAttachments(): UseAttachments {
  const [files, setFiles] = useState<Attachment[]>([]);

  useEffect(() => {
    listAttachments().then(setFiles).catch(() => undefined);
  }, []);

  const upload = useCallback(async (list: FileList | File[] | null) => {
    const requested = list ? Array.from(list) : [];
    if (requested.length === 0) return false;

    // Reject oversized files here rather than letting the request start —
    // once Multer's limit trips mid-upload the socket gets torn down before
    // a response can go out, and the browser just reports "Failed to fetch".
    const tooBig = requested.filter((f) => f.size > MAX_UPLOAD_BYTES);
    const uploadable = requested.filter((f) => f.size <= MAX_UPLOAD_BYTES);
    if (tooBig.length > 0) {
      alert(
        `Too large to attach (max ${formatMB(MAX_UPLOAD_BYTES)} per file):\n` +
          tooBig.map((f) => `${f.name} (${formatMB(f.size)})`).join("\n"),
      );
    }
    if (uploadable.length === 0) return false;

    try {
      setFiles(await uploadAttachments(uploadable));
      return true;
    } catch (err) {
      alert(err instanceof Error ? err.message : "Upload failed.");
      return false;
    }
  }, []);

  const remove = useCallback(async (id: string) => {
    try {
      setFiles(await removeAttachment(id));
    } catch (err) {
      alert(err instanceof Error ? err.message : "Delete failed.");
    }
  }, []);

  const removeMany = useCallback(async (ids: string[]) => {
    try {
      let next: Attachment[] = [];
      for (const id of ids) next = await removeAttachment(id);
      setFiles(next);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Delete failed.");
    }
  }, []);

  const rename = useCallback(async (id: string, name: string) => {
    try {
      setFiles(await renameAttachment(id, name));
    } catch (err) {
      alert(err instanceof Error ? err.message : "Rename failed.");
    }
  }, []);

  return { files, upload, remove, removeMany, rename };
}
