import { Router } from "express";
import { upload } from "./upload.middleware.js";

/**
 * Builds the /api router from its controllers.
 *
 * @param {{
 *   attachments: ReturnType<import("./attachments.controller.js").createAttachmentsController>,
 *   ask: ReturnType<import("./ask.controller.js").createAskController>,
 *   search: ReturnType<import("./search.controller.js").createSearchController>,
 *   faq: ReturnType<import("./faq.controller.js").createFaqController>,
 * }} controllers
 */
export function createApiRouter({ attachments, ask, search, faq }) {
  const router = Router();

  router.get("/attachments", attachments.list);
  router.post("/attachments", upload.array("files"), attachments.upload);
  router.delete("/attachments", attachments.clear);
  router.get("/attachments/:id/raw", attachments.raw);
  router.delete("/attachments/:id", attachments.remove);
  router.patch("/attachments/:id", attachments.rename);

  router.post("/ask", ask);
  router.post("/search", search);
  router.get("/faq", faq);

  return router;
}
