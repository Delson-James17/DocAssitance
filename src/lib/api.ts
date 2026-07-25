// Thin client for the backend API.

import type { QaEntry } from "../types";

async function unwrapQa(res: Response): Promise<QaEntry[]> {
  const data = (await res.json().catch(() => ({}))) as {
    entries?: QaEntry[];
    error?: string;
  };
  if (!res.ok || data.error) {
    throw new Error(data.error ?? `Request failed (${res.status})`);
  }
  return data.entries ?? [];
}

export async function listQa(): Promise<QaEntry[]> {
  return unwrapQa(await fetch("/api/qa"));
}

export async function addQa(question: string, answer: string): Promise<QaEntry[]> {
  return unwrapQa(
    await fetch("/api/qa", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, answer }),
    }),
  );
}

export async function updateQa(
  id: string,
  fields: { question?: string; answer?: string },
): Promise<QaEntry[]> {
  return unwrapQa(
    await fetch(`/api/qa/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    }),
  );
}

export async function removeQa(id: string): Promise<QaEntry[]> {
  return unwrapQa(await fetch(`/api/qa/${encodeURIComponent(id)}`, { method: "DELETE" }));
}

export interface ImportQaResult {
  imported: number;
  entries: QaEntry[];
}

// Bulk-adds many question/answer pairs in one request (see qaImport.ts for
// the .csv/.json parsing that produces these pairs).
export async function importQa(
  pairs: { question: string; answer: string }[],
): Promise<ImportQaResult> {
  const res = await fetch("/api/qa/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entries: pairs }),
  });
  const data = (await res.json().catch(() => ({}))) as Partial<ImportQaResult> & {
    error?: string;
  };
  if (!res.ok || data.error) {
    throw new Error(data.error ?? `Request failed (${res.status})`);
  }
  return { imported: data.imported ?? 0, entries: data.entries ?? [] };
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
