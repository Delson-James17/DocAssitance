/**
 * HTTP handlers for managing attachments.
 *
 * @param {ReturnType<import("../services/attachment.store.js").createAttachmentStore>} store
 */
export function createAttachmentsController(store) {
  return {
    async list(_req, res) {
      res.json({ attachments: await store.list() });
    },

    async upload(req, res) {
      try {
        for (const file of req.files ?? []) {
          await store.add(file);
        }
        res.json({ attachments: await store.list() });
      } catch (err) {
        console.error(err);
        res.status(400).json({ error: err?.message ?? "Could not read one of the files." });
      }
    },

    async remove(req, res) {
      try {
        const ok = await store.remove(req.params.id);
        if (!ok) return res.status(404).json({ error: "Attachment not found." });
        res.json({ attachments: await store.list() });
      } catch (err) {
        console.error(err);
        res.status(400).json({ error: err?.message ?? "Could not delete the file." });
      }
    },

    async rename(req, res) {
      const name = (req.body?.name ?? "").toString().trim();
      if (!name) return res.status(400).json({ error: "New name is required." });
      try {
        const entry = await store.rename(req.params.id, name);
        if (!entry) return res.status(404).json({ error: "Attachment not found." });
        res.json({ attachments: await store.list() });
      } catch (err) {
        console.error(err);
        res.status(400).json({ error: err?.message ?? "Could not rename the file." });
      }
    },

    async clear(_req, res) {
      await store.clear();
      res.json({ attachments: [] });
    },
  };
}
