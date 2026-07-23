import { extractHeading, groupParagraphs, splitParagraphs, stripFileHeader } from "./text-utils.js";

function toQuestion(heading) {
  const clean = heading.replace(/\s+/g, " ").trim();
  return /\?$/.test(clean) ? clean : `What is "${clean}"?`;
}

/**
 * Heuristically builds sample question/answer pairs from attached text
 * files by pairing heading-like lines (markdown headings, numbered items,
 * ALL-CAPS section labels) with their content — a free preview of what
 * local keyword search can answer well, no Claude call. Paragraphs are
 * pre-grouped with groupParagraphs() so a heading that's followed by a bare
 * sub-label (e.g. "Meaning and Explanation" on its own line, before the
 * real content) still ends up paired with the actual answer, not the label.
 * Neither PDFs nor images can be scanned for text this way (never extracted
 * to text) — images are returned separately as `media` so the caller can
 * still show the picture itself (e.g. embedded in an HTML export), and PDFs
 * land in `skippedFiles` since there's nothing local to show for them.
 *
 * @param {{ name: string, block: object }[]} entries
 * @param {{ maxPerFile?: number, maxPairs?: number }} [opts]
 */
export function buildFaq(entries, { maxPerFile = 8, maxPairs = 40 } = {}) {
  const pairs = [];
  const media = [];
  const skippedFiles = [];

  for (const entry of entries) {
    if (entry.block.type === "image") {
      media.push({
        file: entry.name,
        mimetype: entry.block.source.media_type,
        data: entry.block.source.data,
      });
      continue;
    }

    if (entry.block.type !== "text") {
      skippedFiles.push(entry.name);
      continue;
    }

    const groups = groupParagraphs(splitParagraphs(stripFileHeader(entry.block.text)));
    let countForFile = 0;

    for (const group of groups) {
      if (countForFile >= maxPerFile) break;

      const heading = extractHeading(group);
      if (!heading) continue;

      const body = group.split("\n").slice(1).join("\n").trim();
      if (!body) continue;

      pairs.push({
        file: entry.name,
        question: toQuestion(heading),
        answer: body.length > 500 ? `${body.slice(0, 500)}…` : body,
      });
      countForFile++;
    }
  }

  return { pairs: pairs.slice(0, maxPairs), media, skippedFiles };
}
