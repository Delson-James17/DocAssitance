import { buildFaq } from "../services/faq.service.js";

/**
 * HTTP handler for generating a free sample-question/answer preview from
 * attached text files — heuristic, local, never calls Claude.
 *
 * @param {{ store: ReturnType<import("../services/attachment.store.js").createAttachmentStore> }} deps
 */
export function createFaqController({ store }) {
  return async function faq(_req, res) {
    const entries = await store.entries();
    res.json(buildFaq(entries));
  };
}
