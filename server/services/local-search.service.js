import {
  escapeRegExp,
  extractHeading,
  groupParagraphs,
  splitParagraphs,
  stripFileHeader,
} from "./text-utils.js";

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

/** Lowercased, de-duplicated, stopword-free keywords from a question. */
function extractKeywords(question) {
  const words = question
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return Array.from(new Set(words));
}

// A short standalone paragraph (a section heading, "SKILLS", "01. Topic…")
// carries no content on its own — group it with what follows so a match on
// the heading also surfaces the content under it, instead of returning a
// bare one- or two-word "answer" (see groupParagraphs in text-utils.js).
function buildChunks(searchable) {
  const chunks = [];
  for (const { name, text } of searchable) {
    for (const group of groupParagraphs(splitParagraphs(stripFileHeader(text)))) {
      chunks.push({ file: name, text: group });
    }
  }
  return chunks;
}

// Rare keywords (present in few chunks) distinguish the right answer much
// better than common ones repeated everywhere in a document ("programming"
// in a programming cheatsheet, say) — weight matches accordingly instead of
// letting raw occurrence counts dominate.
function computeIdfWeights(chunks, keywords) {
  const total = Math.max(chunks.length, 1);
  const weights = {};
  for (const kw of keywords) {
    const re = new RegExp(`\\b${escapeRegExp(kw)}`, "i");
    const df = chunks.reduce((n, c) => n + (re.test(c.text) ? 1 : 0), 0);
    weights[kw] = Math.log((total + 1) / (df + 1)) + 1;
  }
  return weights;
}

function scoreChunk(chunk, keywords, weights) {
  const lower = chunk.text.toLowerCase();
  let coverage = 0;
  let weighted = 0;
  for (const kw of keywords) {
    const re = new RegExp(`\\b${escapeRegExp(kw)}`, "g");
    const matches = lower.match(re);
    if (matches) {
      coverage++;
      // Cap a single keyword's contribution so a repeated common word can't
      // out-rank a chunk that actually covers more of the question.
      weighted += weights[kw] * Math.min(matches.length, 3);
    }
  }
  return { coverage, weighted };
}

// Local search is free (no Claude call), so there's no reason to cut an
// answer short the way a token-priced response would need to — this is
// only a safety cap against a pathologically large merged chunk, not a
// "keep it brief" limit.
const MAX_SNIPPET_LEN = 1600;

/** Trims a long chunk down to a window around the first keyword hit. */
function trimSnippet(text, keywords, maxLen = MAX_SNIPPET_LEN) {
  if (text.length <= maxLen) return text;
  const lower = text.toLowerCase();
  let idx = -1;
  for (const kw of keywords) {
    const i = lower.indexOf(kw);
    if (i !== -1 && (idx === -1 || i < idx)) idx = i;
  }
  if (idx === -1) return `${text.slice(0, maxLen)}…`;
  const start = Math.max(0, idx - 80);
  const end = Math.min(text.length, start + maxLen);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

// A chunk that came from a previously-exported Q&A file (this app's own
// "Sample Q&A" .html/.txt download) reads as "Q: ...\nA: ...\nfrom <file>"
// — the actual answer, plus a re-asked question and a footer that are just
// noise once we're already showing the real source file. Reduce it to just
// the answer text so it reads the same as a direct match in the original
// document, not a nested quote-of-a-quote.
function unwrapAnswer(text) {
  const match = text.match(/(?:^|\n)A:\s*([\s\S]*?)(?:\n(?:from\s|Q:\s)|$)/);
  return match ? match[1].trim() : text;
}

// A chunk built by groupParagraphs is often "SKILLS\n<the actual content>"
// (heading kept alongside its body so a heading match still finds the real
// answer — see buildChunks). For display, the heading line itself is
// redundant with the question that was just asked — show only the content.
function stripHeadingLine(text) {
  if (!extractHeading(text)) return text;
  const rest = text.split("\n").slice(1).join("\n").trim();
  return rest || text;
}

function normalizeForDedupe(text) {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Zero-cost keyword search over already-extracted text attachments — no
 * Claude call, so it works even with the AI switched off. Only text blocks
 * (.docx/.txt/etc., extracted at upload time) can be searched this way;
 * PDFs and images are sent to Claude as native document/image blocks and
 * were never turned into text, so they're reported separately instead of
 * silently producing no results.
 *
 * Ranking is coverage-first (how many distinct keywords a chunk matches)
 * with IDF-style weighting as the tiebreaker, so the section that actually
 * answers the question wins over a paragraph that just repeats one common
 * word from it many times.
 *
 * @param {{ name: string, block: object }[]} entries
 * @param {string} question
 */
export function searchAttachments(entries, question) {
  const keywords = extractKeywords(question);
  const searchable = entries
    .filter((e) => e.block.type === "text")
    .map((e) => ({ name: e.name, text: e.block.text }));
  const unsearchableFiles = entries
    .filter((e) => e.block.type !== "text")
    .map((e) => e.name);

  let matches = [];
  if (keywords.length > 0) {
    const chunks = buildChunks(searchable);
    const weights = computeIdfWeights(chunks, keywords);

    const ranked = chunks
      .map((chunk) => ({ chunk, ...scoreChunk(chunk, keywords, weights) }))
      .filter((c) => c.coverage > 0)
      .sort((a, b) => b.coverage - a.coverage || b.weighted - a.weighted);

    // Only bundle extra chunks alongside the best one if they cover just as
    // many distinct keywords — otherwise a differently-templated section
    // that merely shares one common word (e.g. "object" also showing up in
    // an unrelated "What is a Class?" chunk) rides along in the top-3 slots
    // just because nothing more relevant was available to fill them,
    // producing an answer that's part right, part noise.
    const topCoverage = ranked.length > 0 ? ranked[0].coverage : 0;
    const relevant = ranked.filter((c) => c.coverage >= topCoverage);

    const kept = [];
    matches = relevant
      .map((c) => ({
        file: c.chunk.file,
        snippet: trimSnippet(stripHeadingLine(unwrapAnswer(c.chunk.text)), keywords),
        score: c.coverage,
      }))
      // Duplicate/redundant content — the same file attached twice, or an
      // exported Q&A file re-quoting a section from its source doc word for
      // word — should show up once. Substring containment (not just exact
      // equality) catches the export case, where the quoted answer is the
      // same text minus the heading line.
      .filter((m) => {
        const norm = normalizeForDedupe(m.snippet);
        if (!norm) return false;
        const redundant = kept.some((k) => k.includes(norm) || norm.includes(k));
        if (redundant) return false;
        kept.push(norm);
        return true;
      })
      .slice(0, 3);
  }

  return {
    keywords,
    matches,
    searchedFiles: searchable.map((e) => e.name),
    unsearchableFiles,
  };
}
