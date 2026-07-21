export type SpeechLang = "en-US" | "fil-PH";

// Common Tagalog function/question words — reliable language signals
// regardless of topic, the same idea classic language-ID heuristics use
// stop words for. Deliberately excludes short words that collide with
// common English words ("at", "o", "may") to avoid false positives.
const TAGALOG_MARKERS = new Set([
  "ako", "ikaw", "ka", "siya", "kami", "tayo", "kayo", "sila",
  "ito", "iyan", "iyon", "dito", "diyan", "doon",
  "ang", "ng", "mga", "sa", "na", "pa", "ba", "po", "opo",
  "hindi", "oo", "wala", "meron", "mayroon",
  "pero", "kasi", "dahil", "kung", "kapag",
  "paano", "ano", "sino", "kailan", "saan", "bakit", "alin", "magkano", "kanino", "ilan",
  "gusto", "ayaw", "kailangan", "pwede", "puwede", "maaari", "maari",
  "salamat", "kumusta", "mahal", "maganda", "masarap", "talaga",
  "lang", "din", "rin", "naman", "daw", "raw",
  "yung", "yun", "nung", "noon", "ngayon", "bukas", "kahapon",
  "natin", "namin", "ninyo", "nila", "akin", "iyo", "kanya", "amin", "atin", "inyo", "kanila",
]);

// A heuristic, not a real language identifier: counts common Tagalog
// function words in the transcript. The Web Speech API can only listen in
// one language at a time, so this can't fix a transcription that already
// came out garbled — it decides which language to listen for next.
export function detectSpeechLang(text: string): SpeechLang {
  const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
  if (words.length === 0) return "en-US";

  const hits = words.filter((w) => TAGALOG_MARKERS.has(w)).length;
  return hits >= 2 || hits / words.length > 0.2 ? "fil-PH" : "en-US";
}
