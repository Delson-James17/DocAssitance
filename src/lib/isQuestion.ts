// A finished utterance is treated as a question if it ends with "?" or opens
// with a question word — browser speech recognition rarely inserts the "?".
const QUESTION_WORDS =
  /^(who|what|when|where|why|which|how|whose|whom|can|could|would|should|do|does|did|is|are|was|were|will|may|might|shall|tell me|explain|list|give me|show me|summarize|what's|who's|how's|where's)\b/i;

export function isQuestion(text: string): boolean {
  const t = text.trim();
  return t.endsWith("?") || QUESTION_WORDS.test(t);
}
