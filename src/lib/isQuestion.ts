// A finished utterance is treated as a question if it ends with "?" or opens
// with a question word — browser speech recognition rarely inserts the "?".
// Covers English and Filipino/Tagalog, since spoken questions may come in
// either (or a Taglish mix).
const QUESTION_WORDS =
  /^(who|what|when|where|why|which|how|whose|whom|can|could|would|should|do|does|did|is|are|was|were|will|may|might|shall|tell me|explain|list|give me|show me|summarize|what's|who's|how's|where's|ano|sino|kailan|saan|bakit|paano|alin|kanino|ilan|magkano|pwede|puwede|maaari|maari|meron ba|mayroon ba|pakisabi|paki|ipaliwanag)\b/i;

// Tagalog often marks a yes/no question with the particle "ba" elsewhere in
// the sentence rather than a leading question word (e.g. "May pasok ba
// bukas?"), so it's checked separately from the leading-word match above.
const TAGALOG_QUESTION_PARTICLE = /\bba\b/i;

export function isQuestion(text: string): boolean {
  const t = text.trim();
  return (
    t.endsWith("?") || QUESTION_WORDS.test(t) || TAGALOG_QUESTION_PARTICLE.test(t)
  );
}
