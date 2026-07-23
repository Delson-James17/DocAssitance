import type { LocalSearchResult } from "./api";

// Renders a local keyword-search result as plain answer text for the record.
export function formatLocalSearchAnswer(result: LocalSearchResult): string {
  if (result.matches.length === 0) {
    const base =
      result.searchedFiles.length === 0
        ? "No text-searchable files are attached."
        : `No keyword match found in: ${result.searchedFiles.join(", ")}.`;
    const unsearchable =
      result.unsearchableFiles.length > 0
        ? ` (${result.unsearchableFiles.join(", ")} can't be searched locally — PDFs/images need AI turned on to read.)`
        : "";
    return `${base}${unsearchable}`;
  }

  // Just the matched content — no "From <file>:" wrapper or quotes, so a
  // single match reads exactly like a direct answer, not a quoted excerpt.
  return result.matches.map((m) => m.snippet).join("\n\n");
}
