import multer from "multer";
import { config } from "../config.js";

/**
 * Express error-handling middleware (4 args — Express recognizes it by
 * arity). Without this, an error thrown mid-upload (e.g. Multer's file-size
 * limit) can leave the connection torn down before a response is sent,
 * which the browser reports as an opaque "Failed to fetch" instead of a
 * readable error.
 */
export function errorHandler(err, _req, res, _next) {
  if (res.headersSent) return;

  if (err instanceof multer.MulterError) {
    const message =
      err.code === "LIMIT_FILE_SIZE"
        ? `File is too large — max ${Math.round(config.maxFileBytes / (1024 * 1024))} MB per file.`
        : err.message;
    return res.status(400).json({ error: message });
  }

  console.error(err);
  res.status(500).json({ error: "Something went wrong." });
}
