import multer from "multer";
import { config } from "../config.js";

// Files are held in memory so they can be forwarded straight to Claude.
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxFileBytes },
});
