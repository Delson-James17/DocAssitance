// Detects "this is basically the same question as before" so a repeat can
// be answered from a local cache instead of spending tokens on Claude again.

export function normalizeQuestion(q: string): string {
  return q
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(q: string): Set<string> {
  return new Set(normalizeQuestion(q).split(" ").filter(Boolean));
}

// Jaccard similarity of word sets — cheap way to catch near-identical
// rephrasing ("what's my name" vs "what is my name") without an NLP lib.
export function similarity(a: string, b: string): number {
  const setA = tokenSet(a);
  const setB = tokenSet(b);
  if (setA.size === 0 && setB.size === 0) return 1;

  let intersection = 0;
  for (const word of setA) if (setB.has(word)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export const DUPLICATE_THRESHOLD = 0.82;
