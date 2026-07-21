import crypto from "crypto";
import { fileToBlock } from "./file-converter.js";
import { storage } from "./storage.service.js";

/**
 * @typedef {{ id: string, name: string, mimetype: string, buffer: Buffer }} StoredFile
 */

/**
 * Creates an attachment repository backed by Supabase Storage, with an
 * in-memory cache for fast, per-question access to Claude content blocks.
 *
 * If Supabase isn't configured (see server/services/supabase.client.js),
 * this degrades to a pure in-memory store for a single server run — the
 * app still works, files just don't survive a restart.
 *
 * This holds attachments for a single user. To support multiple concurrent
 * users, create one store per session instead of sharing this instance.
 */
export function createAttachmentStore() {
  /** @type {Map<string, StoredFile>} */
  const files = new Map();

  const ready = (async () => {
    await storage.ensureBucket();
    try {
      const existing = await storage.listAll();
      for (const f of existing) files.set(f.id, f);
    } catch (err) {
      console.warn(`[attachments] Could not load files from Supabase: ${err.message}`);
    }
  })();

  /** Content block + display metadata for one stored file. */
  async function toEntry(f) {
    return { id: f.id, name: f.name, block: await fileToBlock(f) };
  }

  return {
    /** Resolves once the initial Supabase sync has finished. */
    ready: () => ready,

    /**
     * @param {{ originalname: string, mimetype: string, buffer: Buffer }} file
     */
    async add(file) {
      await ready;
      const id = crypto.randomUUID();
      const stored = { id, name: file.originalname, mimetype: file.mimetype, buffer: file.buffer };
      files.set(id, stored);
      // Persist best-effort: if Supabase isn't reachable or the bucket isn't
      // set up yet, keep the attachment in memory for this session instead
      // of failing the upload outright (see README's Supabase setup step).
      try {
        await storage.upload(stored);
      } catch (err) {
        console.warn(`[attachments] Not persisted to Supabase (kept in memory): ${err.message}`);
      }
      return await toEntry(stored);
    },

    async remove(id) {
      await ready;
      const f = files.get(id);
      if (!f) return false;
      try {
        await storage.remove(f);
      } catch (err) {
        console.warn(`[attachments] Supabase delete failed (removed locally): ${err.message}`);
      }
      files.delete(id);
      return true;
    },

    async rename(id, newName) {
      await ready;
      const f = files.get(id);
      if (!f) return null;
      const name = newName.trim();
      if (!name || name === f.name) return await toEntry(f);

      try {
        await storage.rename({ id: f.id, oldName: f.name, newName: name });
      } catch (err) {
        console.warn(`[attachments] Supabase rename failed (renamed locally): ${err.message}`);
      }
      const updated = { ...f, name };
      files.set(id, updated);
      return await toEntry(updated);
    },

    /** Content blocks in attachment order (for sending to Claude). */
    async blocks() {
      await ready;
      return Promise.all([...files.values()].map((f) => fileToBlock(f)));
    },

    /** `{ id, name }` for every current attachment, in attachment order. */
    async list() {
      await ready;
      return [...files.values()].map(({ id, name }) => ({ id, name }));
    },

    async clear() {
      await ready;
      try {
        await storage.removeAll();
      } catch (err) {
        console.warn(`[attachments] Supabase clear failed (cleared locally): ${err.message}`);
      }
      files.clear();
    },
  };
}
