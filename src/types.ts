export interface Attachment {
  id: string;
  name: string;
  mimetype: string;
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
      // earlier question (no tokens spent), or a local keyword search over
      // attached text files (also no tokens spent, used while AI is off).
      source: "claude" | "cache" | "local";
    };
