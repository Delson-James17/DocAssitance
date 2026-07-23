import { searchAttachments } from "../services/local-search.service.js";

/**
 * HTTP handler for zero-cost local keyword search over attached text files —
 * never calls Claude, so it's safe to use as an "AI off" fallback.
 *
 * @param {{ store: ReturnType<import("../services/attachment.store.js").createAttachmentStore> }} deps
 */
export function createSearchController({ store }) {
  return async function search(req, res) {
    const question = (req.body?.question ?? "").toString().trim();
    if (!question) {
      return res.status(400).json({ error: "No question provided." });
    }

    const entries = await store.entries();
    res.json(searchAttachments(entries, question));
  };
}
