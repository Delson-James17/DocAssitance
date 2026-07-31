/**
 * Trims a submitted alternates value down to a clean, deduped string array —
 * accepts either a real array (JSON body) or a newline-separated string
 * (form-ish input), and drops anything that's empty or identical to the
 * primary question (redundant, not a real alternate).
 *
 * @param {unknown} raw
 * @param {string} question
 * @returns {string[]}
 */
function cleanAlternates(raw, question) {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split("\n")
      : [];
  const seen = new Set([question.toLowerCase()]);
  const cleaned = [];
  for (const item of list) {
    const text = (item ?? "").toString().trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(text);
  }
  return cleaned;
}

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
      const alternates = cleanAlternates(req.body?.alternates, question);
      try {
        await store.add({ question, answer, alternates });
        res.json({ entries: await store.list() });
      } catch (err) {
        console.error(err);
        res.status(400).json({ error: err?.message ?? "Could not save the entry." });
      }
    },

    async import(req, res) {
      const raw = Array.isArray(req.body?.entries) ? req.body.entries : [];
      const pairs = raw
        .map((e) => {
          const question = (e?.question ?? "").toString().trim();
          const answer = (e?.answer ?? "").toString().trim();
          return { question, answer, alternates: cleanAlternates(e?.alternates, question) };
        })
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
      if (req.body?.alternates !== undefined) {
        fields.alternates = cleanAlternates(req.body.alternates, fields.question ?? "");
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
