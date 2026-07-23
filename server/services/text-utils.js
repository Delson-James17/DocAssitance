// Shared helpers for working with the extracted-text blocks file-converter.js
// produces — used by both local-search.service.js and faq.service.js, which
// both need to walk the same "--- FILE: name ---\n<text>" text blocks.

const NUMBERED_RE = /^(\d{1,3})[.)]\s+(.+)$/;
const MD_HEADING_RE = /^#{1,6}\s+(.+)$/;

export function stripFileHeader(text) {
  return text.replace(/^--- FILE: .*? ---\n/, "");
}

export function splitParagraphs(text) {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A short, punctuation-light, ALL-CAPS line reads as a section label
// ("SKILLS", "WORK EXPERIENCE") rather than a sentence.
function isAllCapsLine(line) {
  if (line.length > 60) return false;
  const letters = line.replace(/[^A-Za-z]/g, "");
  if (letters.length < 2) return false;
  return letters === letters.toUpperCase();
}

/**
 * Extracts heading text from a paragraph's first line — a markdown heading,
 * a numbered item ("01. Topic"), or a standalone ALL-CAPS label — or null
 * if it doesn't read as one. Only looks at the first line, so it works both
 * on a single un-merged paragraph and on a group produced by
 * groupParagraphs() (heading line followed by its now-attached content).
 */
export function extractHeading(paragraph) {
  const line = paragraph.split("\n")[0].trim();

  const md = MD_HEADING_RE.exec(line);
  if (md) return md[1].trim();

  const numbered = NUMBERED_RE.exec(line);
  if (numbered) return numbered[2].trim();

  if (isAllCapsLine(line)) return line;

  return null;
}

// A recognized heading, or any other short line with no sentence-ending
// punctuation, reads as a heading/sub-label ("Meaning and Explanation")
// rather than real content — some documents split a heading, a sub-label,
// and its actual content across three separate paragraphs instead of one.
// (Checked via extractHeading first so numbering like "01." — which itself
// contains a period — still counts as a lead fragment.)
export function isLeadFragment(paragraph) {
  if (extractHeading(paragraph)) return true;
  return paragraph.length < 60 && !/[:.!?]/.test(paragraph);
}

// Groups consecutive lead fragments (a heading, then maybe a sub-label)
// together with the first substantial paragraph that follows, so a match on
// a heading/label still surfaces its real content instead of a bare word or
// two. Capped so an unrelated run of short lines (e.g. a bullet list)
// can't merge into one runaway chunk.
export function groupParagraphs(paragraphs, maxGroupSize = 4) {
  const groups = [];
  let i = 0;
  while (i < paragraphs.length) {
    let text = paragraphs[i];
    let last = paragraphs[i];
    let j = i;
    while (
      isLeadFragment(last) &&
      j + 1 < paragraphs.length &&
      j - i + 1 < maxGroupSize
    ) {
      j++;
      last = paragraphs[j];
      text = `${text}\n${last}`;
    }
    groups.push(text);
    i = j + 1;
  }
  return groups;
}
