// A manually-curated Q&A pair, persisted server-side (Supabase if
// configured, in-memory otherwise) — see server/services/qa.store.js.
export interface QaEntry {
  id: string;
  question: string;
  // Other ways of asking the same question ("Walk me through your resume",
  // "Can you introduce yourself?" for a "Tell me about yourself?" entry).
  // Matching (src/lib/qaMatch.ts) checks all of these, not just `question`
  // — two phrasings can mean the same thing while sharing almost no actual
  // words, which keyword matching alone can never bridge on its own.
  alternates: string[];
  answer: string;
  // A single quick-recall key — one lowercase character, either a digit
  // (0-9) or a letter (a-z) — or null if unassigned. Pressing that key (see
  // App.tsx's global keydown handler) instantly shows this entry's answer
  // on screen — a manual fallback for the questions you most need on hand,
  // independent of voice/typed matching in case either one fails you
  // mid-practice. At most one entry can hold a given key at a time.
  hotkey: string | null;
  createdAt: string;
}

// The whole conversation record: every finished utterance (or typed line)
// becomes an entry. Ones that read as a question get answered ("qa");
// everything else is just kept as plain transcribed text ("note").
export type RecordEntry =
  | {
      id: string;
      kind: "note";
      text: string;
      timestamp: number;
    }
  | {
      id: string;
      kind: "qa";
      question: string;
      answer: string;
      pending: boolean;
      error?: string;
      timestamp: number;
      // Where the answer came from: Claude, a reused answer to an earlier
      // question (no tokens spent), a manually-curated Q&A entry (no
      // tokens spent, and no risk of Claude answering the wrong thing), or
      // "none" — AI is off and nothing saved could answer it either.
      source: "claude" | "cache" | "saved" | "none";
    };
