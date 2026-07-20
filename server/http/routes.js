import { Router } from "express";
import { upload } from "./upload.middleware.js";

/**
 * Builds the /api router from its controllers.
 *
 * @param {{
 *   attachments: ReturnType<import("./attachments.controller.js").createAttachmentsController>,
 *   ask: ReturnType<import("./ask.controller.js").createAskController>,
 * }} controllers
 */
export function createApiRouter({ attachments, ask }) {
  const router = Router();

  router.get("/attachments", attachments.list);
  router.post("/attachments", upload.array("files"), attachments.upload);
  router.delete("/attachments", attachments.clear);
  router.delete("/attachments/:id", attachments.remove);
  router.patch("/attachments/:id", attachments.rename);

  router.post("/ask", ask);

  return router;
}
