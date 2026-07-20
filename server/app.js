import express from "express";
import path from "path";
import { fileURLToPath } from "url";

import { createAttachmentStore } from "./services/attachment.store.js";
import { createClaudeService } from "./services/claude.service.js";
import { createAttachmentsController } from "./http/attachments.controller.js";
import { createAskController } from "./http/ask.controller.js";
import { createApiRouter } from "./http/routes.js";
import { errorHandler } from "./http/error-handler.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "dist");

/**
 * Composition root: builds the Express app and wires the layers together.
 * Dependencies are injectable so the app can be tested with stubs.
 *
 * @param {{
 *   store?: ReturnType<typeof createAttachmentStore>,
 *   claude?: ReturnType<typeof createClaudeService>,
 * }} [deps]
 */
export function createApp({
  store = createAttachmentStore(),
  claude = createClaudeService(),
} = {}) {
  const app = express();
  app.use(express.json());

  // Serve the built Vite app (production). In dev the Vite server serves the
  // frontend and proxies /api here, so dist/ may not exist.
  app.use(express.static(distDir));

  // API
  const attachments = createAttachmentsController(store);
  const ask = createAskController({ store, claude });
  app.use("/api", createApiRouter({ attachments, ask }));

  // SPA fallback: any non-API route serves the built index.html.
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(distDir, "index.html"), (err) => {
      if (err) {
        res.status(404).json({
          error: "Frontend not built. Run `npm run build`, or use `npm run dev`.",
        });
      }
    });
  });

  app.use(errorHandler);

  return app;
}
