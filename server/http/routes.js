import { Router } from "express";

/**
 * Builds the /api router from its controllers.
 *
 * @param {{
 *   ask: ReturnType<import("./ask.controller.js").createAskController>,
 *   qa: ReturnType<import("./qa.controller.js").createQaController>,
 * }} controllers
 */
export function createApiRouter({ ask, qa }) {
  const router = Router();

  router.post("/ask", ask);

  router.get("/qa", qa.list);
  router.post("/qa", qa.add);
  router.post("/qa/import", qa.import);
  router.patch("/qa/:id", qa.update);
  // Before /qa/:id, or "all" would be read as an entry id.
  router.delete("/qa/all", qa.removeAll);
  router.delete("/qa/:id", qa.remove);

  return router;
}
