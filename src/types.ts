export interface Attachment {
  id: string;
  name: string;
  mimetype: string;
}

// A manually-curated Q&A pair, persisted server-side (Supabase if
// configured, in-memory otherwise) — see server/services/qa.store.js.
export interface QaEntry {
  id: string;
  question: string;
  answer: string;
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
      // Where the answer came from: Claude, a reused answer to the same
      // earlier question (no tokens spent), a local keyword search over
      // attached text files (also no tokens spent, used while AI is off),
      // or a manually-curated Q&A entry (no tokens spent, and no risk of an
      // unrelated document passage being surfaced instead).
      source: "claude" | "cache" | "local" | "saved";
    };
