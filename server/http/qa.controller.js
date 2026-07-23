/**
 * HTTP handlers for the manually-curated Q&A table.
 *
 * @param {ReturnType<import("../services/qa.store.js").createQaStore>} store
 */
export function createQaController(store) {
  return {
    async list(_req, res) {
      res.json({ entries: await store.list() });
    },

    async add(req, res) {
      const question = (req.body?.question ?? "").toString().trim();
      const answer = (req.body?.answer ?? "").toString().trim();
      if (!question || !answer) {
        return res.status(400).json({ error: "Both a question and an answer are required." });
      }
      try {
        await store.add({ question, answer });
        res.json({ entries: await store.list() });
      } catch (err) {
        console.error(err);
        res.status(400).json({ error: err?.message ?? "Could not save the entry." });
      }
    },

    async import(req, res) {
      const raw = Array.isArray(req.body?.entries) ? req.body.entries : [];
      const pairs = raw
        .map((e) => ({
          question: (e?.question ?? "").toString().trim(),
          answer: (e?.answer ?? "").toString().trim(),
        }))
        .filter((e) => e.question && e.answer);

      if (pairs.length === 0) {
        return res.status(400).json({ error: "No valid question/answer pairs found to import." });
      }
      try {
        await store.addMany(pairs);
        res.json({ imported: pairs.length, entries: await store.list() });
      } catch (err) {
        console.error(err);
        res.status(400).json({ error: err?.message ?? "Could not import entries." });
      }
    },

    async update(req, res) {
      const fields = {};
      if (req.body?.question !== undefined) fields.question = req.body.question.toString().trim();
      if (req.body?.answer !== undefined) fields.answer = req.body.answer.toString().trim();
      if (fields.question === "" || fields.answer === "") {
        return res.status(400).json({ error: "Question and answer can't be empty." });
      }
      try {
        const entry = await store.update(req.params.id, fields);
        if (!entry) return res.status(404).json({ error: "Entry not found." });
        res.json({ entries: await store.list() });
      } catch (err) {
        console.error(err);
        res.status(400).json({ error: err?.message ?? "Could not update the entry." });
      }
    },

    async remove(req, res) {
      try {
        const ok = await store.remove(req.params.id);
        if (!ok) return res.status(404).json({ error: "Entry not found." });
        res.json({ entries: await store.list() });
      } catch (err) {
        console.error(err);
        res.status(400).json({ error: err?.message ?? "Could not delete the entry." });
      }
    },
  };
}
