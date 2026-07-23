// Thin client for the backend API.

import type { Attachment } from "../types";

// Must match server/config.js's maxFileBytes. Enforced client-side too: a
// file this large sent over multipart can hit Multer's limit mid-stream,
// which force-closes the socket before a response goes out — the browser
// then reports a bare "Failed to fetch" instead of a readable error.
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

async function unwrap(res: Response): Promise<Attachment[]> {
  const data = (await res.json().catch(() => ({}))) as {
    attachments?: Attachment[];
    error?: string;
  };
  if (!res.ok || data.error) {
    throw new Error(data.error ?? `Request failed (${res.status})`);
  }
  return data.attachments ?? [];
}

export async function listAttachments(): Promise<Attachment[]> {
  return unwrap(await fetch("/api/attachments"));
}

export async function uploadAttachments(files: File[]): Promise<Attachment[]> {
  const form = new FormData();
  for (const file of files) form.append("files", file);
  return unwrap(await fetch("/api/attachments", { method: "POST", body: form }));
}

export async function removeAttachment(id: string): Promise<Attachment[]> {
  return unwrap(await fetch(`/api/attachments/${encodeURIComponent(id)}`, { method: "DELETE" }));
}

export async function renameAttachment(id: string, name: string): Promise<Attachment[]> {
  return unwrap(
    await fetch(`/api/attachments/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }),
  );
}

export async function clearAttachments(): Promise<void> {
  await fetch("/api/attachments", { method: "DELETE" });
}

export interface AskHandlers {
  onDelta: (text: string) => void;
  onDone: (answer: string) => void;
  onError: (message: string) => void;
}

// Ask a question and consume the Server-Sent Events stream from the backend.
export async function askQuestion(
  question: string,
  handlers: AskHandlers,
): Promise<void> {
  const res = await fetch("/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });

  if (!res.ok || !res.body) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    handlers.onError(err.error ?? `Request failed (${res.status})`);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";

    for (const chunk of chunks) {
      const event = /event: (.*)/.exec(chunk)?.[1];
      const dataLine = /data: (.*)/.exec(chunk)?.[1];
      if (!dataLine) continue;
      const data = JSON.parse(dataLine) as {
        text?: string;
        answer?: string;
        message?: string;
      };

      if (event === "delta" && data.text != null) handlers.onDelta(data.text);
      else if (event === "done") handlers.onDone(data.answer ?? "");
      else if (event === "error")
        handlers.onError(data.message ?? "Something went wrong.");
    }
  }
}

export interface LocalSearchMatch {
  file: string;
  snippet: string;
  score: number;
}

export interface LocalSearchResult {
  keywords: string[];
  matches: LocalSearchMatch[];
  searchedFiles: string[];
  unsearchableFiles: string[];
}

// Zero-cost keyword search over already-extracted attachment text — never
// calls Claude, so it works with the AI switched off.
export async function localSearch(question: string): Promise<LocalSearchResult> {
  const res = await fetch("/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });
  const data = (await res.json().catch(() => ({}))) as Partial<LocalSearchResult> & {
    error?: string;
  };
  if (!res.ok || data.error) {
    throw new Error(data.error ?? `Request failed (${res.status})`);
  }
  return {
    keywords: data.keywords ?? [],
    matches: data.matches ?? [],
    searchedFiles: data.searchedFiles ?? [],
    unsearchableFiles: data.unsearchableFiles ?? [],
  };
}

export interface FaqPair {
  file: string;
  question: string;
  answer: string;
}

export interface FaqMedia {
  file: string;
  mimetype: string;
  data: string; // base64
}

export interface FaqResult {
  pairs: FaqPair[];
  media: FaqMedia[];
  skippedFiles: string[];
}

// Free, local, heuristic sample-Q&A preview generated from attached text
// files' headings/sections — never calls Claude. Image attachments come
// back as `media` (base64) rather than Q&A pairs, since there's no text to
// pair a question with — just the picture itself.
export async function fetchFaq(): Promise<FaqResult> {
  const res = await fetch("/api/faq");
  const data = (await res.json().catch(() => ({}))) as Partial<FaqResult> & {
    error?: string;
  };
  if (!res.ok || data.error) {
    throw new Error(data.error ?? `Request failed (${res.status})`);
  }
  return {
    pairs: data.pairs ?? [],
    media: data.media ?? [],
    skippedFiles: data.skippedFiles ?? [],
  };
}
