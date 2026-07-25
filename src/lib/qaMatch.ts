// Finds the best-matching saved Q&A entry for a question, using the same
// keyword-coverage + rarity-weighting approach as document search (see
// server/services/local-search.service.js) instead of a strict whole-
// sentence similarity check. Voice-transcribed questions rarely match a
// saved question's exact wording — this is robust to rewording while still
// requiring a solid majority of keyword overlap, so an unrelated saved
// entry can't win just because it shares one common word.
//
// Only real content keywords count toward a match — filler/template words
// ("what", "is", "tell", "me", "about", …) are stripped out first and never
// compared. A whole-sentence comparison (including those words) seems like
// it'd help disambiguate short questions, but it backfires badly on a FAQ-
// style saved set where most entries share the same template ("What is
// ___?"): "What is AWS?" and "What is OOP?" already agree on 2 of maybe 3
// words before the real subject is even considered, which is enough
// overlap to falsely "match" two completely unrelated questions.

import { similarity } from "./dedupe";
import type { QaEntry } from "../types";

const STOPWORDS = new Set([
  // English
  "the", "a", "an", "of", "in", "on", "at", "to", "for", "and", "or", "is",
  "are", "was", "were", "what", "who", "whom", "when", "where", "why", "how",
  "which", "that", "this", "these", "those", "can", "could", "would",
  "should", "will", "do", "does", "did", "have", "has", "had", "my", "your",
  "his", "her", "its", "our", "their", "me", "you", "he", "she", "it", "we",
  "they", "be", "been", "being", "as", "by", "with", "from", "about", "into",
  "than", "then", "so", "please", "tell", "explain", "describe", "show",
  "give", "about", "there",
  // Filipino/Tagalog
  "ang", "mga", "ba", "po", "ko", "mo", "ng", "sa", "na", "ay", "ako",
  "ikaw", "siya", "kami", "kayo", "sila", "ano", "sino", "kailan", "saan",
  "bakit", "paano", "yung", "yun", "ito", "iyan", "iyon",
]);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractKeywords(question: string): string[] {
  const words = question
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return Array.from(new Set(words));
}

function computeIdfWeights(entries: QaEntry[], keywords: string[]): Record<string, number> {
  const total = Math.max(entries.length, 1);
  const weights: Record<string, number> = {};
  for (const kw of keywords) {
    const re = new RegExp(`\\b${escapeRegExp(kw)}`, "i");
    const df = entries.reduce((n, e) => n + (re.test(e.question) ? 1 : 0), 0);
    weights[kw] = Math.log((total + 1) / (df + 1)) + 1;
  }
  return weights;
}

function scoreEntry(
  entry: QaEntry,
  keywords: string[],
  weights: Record<string, number>,
): { coverage: number; weighted: number } {
  const lower = entry.question.toLowerCase();
  let coverage = 0;
  let weighted = 0;
  for (const kw of keywords) {
    const re = new RegExp(`\\b${escapeRegExp(kw)}`, "g");
    const matches = lower.match(re);
    if (matches) {
      coverage++;
      weighted += weights[kw] * Math.min(matches.length, 3);
    }
  }
  return { coverage, weighted };
}

// A saved entry needs to cover most of the question's keywords, not just
// one, before it's trusted as "the same question" — otherwise a saved
// entry that happens to share a single common word would win by default.
const MIN_COVERAGE_RATIO = 0.6;

// With only one or two real keywords to go on, "most of them" isn't a
// meaningful bar — partial credit doesn't exist below that, so demand every
// one of them instead. This is what makes "What is AWS?" (keyword: "aws")
// correctly fail to match a saved question that never mentions AWS at all,
// rather than being treated as 100%-covered by coincidence.
const FULL_COVERAGE_KEYWORD_CEILING = 2;

export function matchSavedQa(entries: QaEntry[], question: string): QaEntry | null {
  if (entries.length === 0) return null;
  const keywords = extractKeywords(question);
  if (keywords.length === 0) return null;

  const requiredRatio =
    keywords.length <= FULL_COVERAGE_KEYWORD_CEILING ? 1 : MIN_COVERAGE_RATIO;

  const weights = computeIdfWeights(entries, keywords);
  const scored = entries
    .map((entry) => ({ entry, ...scoreEntry(entry, keywords, weights) }))
    .filter((s) => s.coverage / keywords.length >= requiredRatio)
    .sort((a, b) => b.coverage - a.coverage || b.weighted - a.weighted);

  if (scored.length === 0) return null;

  // Keyword coverage can land on a genuine tie: two short questions can
  // share their one real keyword ("yourself") while being totally
  // different questions, once the words that actually distinguish them
  // ("tell me about" vs. "where do you see ... in 5 years") were stripped
  // as filler and never compared. Only *among candidates already past the
  // coverage bar above* — never as a way for a zero-coverage candidate to
  // qualify — break the tie with whole-sentence similarity, which does
  // weigh those filler words back in.
  const top = scored[0];
  const tied = scored.filter((s) => s.coverage === top.coverage && s.weighted === top.weighted);
  if (tied.length === 1) return tied[0].entry;

  tied.sort(
    (a, b) => similarity(b.entry.question, question) - similarity(a.entry.question, question),
  );
  return tied[0].entry;
}
