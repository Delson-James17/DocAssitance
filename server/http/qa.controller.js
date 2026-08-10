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
 * Parses a submitted hotkey value down to a single lowercase character —
 * a digit (0-9) or a letter (a-z) — or `null` to unassign. Anything else
 * (a whole word, punctuation, empty) is treated as "unassign" rather than
 * an error, since this is a convenience feature, not part of the API's real
 * data contract.
 *
 * @param {unknown} raw
 * @returns {string | null}
 */
function cleanHotkey(raw) {
  const key = (raw ?? "").toString().trim().toLowerCase();
  return /^[a-z0-9]$/.test(key) ? key : null;
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
      if (req.body?.hotkey !== undefined) {
        fields.hotkey = cleanHotkey(req.body.hotkey);
      }
      try {
        // Only one entry can hold a given quick-recall key at a time — if
        // another entry already has the one being assigned here, it loses
        // it, the same way a radio button steals selection from its group.
        if (fields.hotkey) {
          const all = await store.list();
          const conflict = all.find((e) => e.hotkey === fields.hotkey && e.id !== req.params.id);
          if (conflict) await store.update(conflict.id, { hotkey: null });
        }
        const entry = await store.update(req.params.id, fields);
        if (!entry) return res.status(404).json({ error: "Entry not found." });
        res.json({ entries: await store.list() });
      } catch (err) {
        console.error(err);
        res.status(400).json({ error: err?.message ?? "Could not update the entry." });
      }
    },

    async removeAll(_req, res) {
      try {
        const removed = await store.removeAll();
        res.json({ removed, entries: await store.list() });
      } catch (err) {
        console.error(err);
        res.status(400).json({ error: err?.message ?? "Could not delete the entries." });
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
