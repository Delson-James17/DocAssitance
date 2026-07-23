import type { FaqResult } from "./api";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// A .txt file can't hold an image — this renders a self-contained .html
// file instead, so screenshots can be embedded (as base64 data URIs) right
// next to the text Q&A, and the whole thing still opens with a double-click
// in any browser, no server needed.
export function buildFaqHtml(result: FaqResult): string {
  const pairsHtml = result.pairs.length
    ? result.pairs
        .map(
          (p) => `<div class="qa">
  <p class="q">Q: ${escapeHtml(p.question)}</p>
  <p class="a">A: ${escapeHtml(p.answer)}</p>
  <p class="src">from ${escapeHtml(p.file)}</p>
</div>`,
        )
        .join("\n")
    : `<p class="muted">No sample Q&A could be generated — attach a .docx/.txt/.md/etc. file with headings or sections first.</p>`;

  const mediaHtml = result.media
    .map(
      (m) => `<div class="qa media">
  <p class="q">Attached image: ${escapeHtml(m.file)}</p>
  <img src="data:${escapeHtml(m.mimetype)};base64,${m.data}" alt="${escapeHtml(m.file)}" />
  <p class="src">No text to search here — turn AI on and ask a question to get it described.</p>
</div>`,
    )
    .join("\n");

  const skippedHtml = result.skippedFiles.length
    ? `<p class="skipped">Not previewable here (e.g. PDF) — turn AI on to read: ${escapeHtml(result.skippedFiles.join(", "))}</p>`
    : "";

  // A reusable, editable block: copy it, fill in the brackets, save, and
  // this file reads back just like the generated pairs above (same
  // <div class="qa"> shape local search/FAQ-of-this-file expects) — so this
  // export doubles as a hand-curated Q&A file you can grow over time.
  const templateHtml = `<h2>Add your own</h2>
  <p class="subtitle">
    Copy the block below as many times as you like, replace the bracketed
    text, and save the file. Re-attach it to the app afterward so local
    search picks up what you added too.
  </p>
  <div class="qa template">
    <p class="q">Q: [Your question here]</p>
    <p class="a">A: [Your answer here]</p>
    <p class="src">(copy this whole block — from &lt;div class="qa"&gt; to &lt;/div&gt; — to add another)</p>
  </div>`;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Sample Q&amp;A</title>
<style>
  body { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; background: #0c0c0c; color: #e8e8e8; padding: 2rem 1.5rem; max-width: 760px; margin: 0 auto; line-height: 1.5; }
  h1 { font-size: 1.05rem; margin-bottom: 0.2rem; }
  h2 { font-size: 0.95rem; border-top: 1px dashed #333; padding-top: 1.5rem; margin-top: 2rem; }
  .subtitle { color: #888; font-size: 0.85rem; margin-top: 0; margin-bottom: 1.5rem; }
  .qa { border: 1px solid #333; border-radius: 4px; padding: 0.8rem 1rem; margin-bottom: 1rem; }
  .qa.template { border-style: dashed; border-color: #555; }
  .q { font-weight: 600; margin: 0 0 0.5rem; }
  .a { white-space: pre-wrap; margin: 0 0 0.5rem; }
  .src { color: #888; font-size: 0.78rem; margin: 0; }
  img { max-width: 100%; border: 1px solid #333; border-radius: 4px; margin: 0.4rem 0; display: block; }
  .muted { color: #888; }
  .skipped { color: #f9f1a5; font-size: 0.85rem; }
</style>
</head>
<body>
  <h1>Sample questions &amp; answers this app can read from your attached files</h1>
  <p class="subtitle">Generated locally — no AI used, no tokens spent.</p>
  ${pairsHtml}
  ${mediaHtml}
  ${skippedHtml}
  ${templateHtml}
</body>
</html>
`;
}

export function downloadFaq(result: FaqResult): void {
  const html = buildFaqHtml(result);
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const a = document.createElement("a");
  a.href = url;
  a.download = `sample-qa-${stamp}.html`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
