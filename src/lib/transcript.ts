import type { RecordEntry } from "../types";

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// Renders the record oldest-first as plain text, newest entries are stored
// first in the array (same order the UI scrolls them).
export function buildTranscript(record: RecordEntry[]): string {
  const chronological = [...record].reverse();
  const lines: string[] = [];

  for (const entry of chronological) {
    if (entry.kind === "note") {
      lines.push(`[${formatTime(entry.timestamp)}] ${entry.text}`);
    } else {
      lines.push(`[${formatTime(entry.timestamp)}] > ${entry.question}`);
      if (entry.error) lines.push(`⚠ ${entry.error}`);
      else if (entry.answer) lines.push(entry.answer);
    }
    lines.push("");
  }

  return lines.join("\n").trim() + "\n";
}

export function downloadTranscript(record: RecordEntry[], filePrefix = "transcript"): void {
  const text = buildTranscript(record);
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const a = document.createElement("a");
  a.href = url;
  a.download = `${filePrefix}-${stamp}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Q&A entries only, dropping the plain-note fragments (misheard background
// noise, filler speech, etc.) that clutter the full conversation log.
export function downloadQaTranscript(record: RecordEntry[]): void {
  downloadTranscript(
    record.filter((e) => e.kind === "qa"),
    "qa-transcript",
  );
}
