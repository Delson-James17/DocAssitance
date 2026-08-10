import crypto from "crypto";
import { supabase, supabaseEnabled } from "./supabase.client.js";

const TABLE = "qa_entries";

/**
 * @typedef {{ id: string, question: string, alternates: string[], answer: string, hotkey: string | null, createdAt: string }} QaEntry
 */

/**
 * Repository for manually-curated Q&A pairs, backed by a Supabase Postgres
 * table with an in-memory cache, so a saved answer survives server restarts
 * when Supabase is configured, and still works (for the current session)
 * when it isn't.
 */
export function createQaStore() {
  /** @type {Map<string, QaEntry>} */
  const entries = new Map();

  const ready = (async () => {
    if (!supabaseEnabled) return;
    try {
      const { data, error } = await supabase
        .from(TABLE)
        .select("id, question, alternates, answer, hotkey, created_at")
        .order("created_at", { ascending: true });
      if (error) throw error;
      for (const row of data ?? []) {
        entries.set(row.id, {
          id: row.id,
          question: row.question,
          alternates: row.alternates ?? [],
          answer: row.answer,
          hotkey: row.hotkey ?? null,
          createdAt: row.created_at,
        });
      }
    } catch (err) {
      console.warn(`[qa] Could not load entries from Supabase: ${err.message}`);
    }
  })();

  // Ordered by creation, with the id as a tie-break. The tie-break is what
  // makes the order *stable*: a bulk import used to stamp every entry with an
  // identical createdAt, so the comparator saw them all as equal and the list
  // could come back in a different order on every request. On screen that
  // looked like rows jumping around — and a quick key you'd just assigned
  // appearing to land on the wrong entry.
  function sorted() {
    return [...entries.values()].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  }

  return {
    /** Resolves once the initial Supabase sync has finished. */
    ready: () => ready,

    async list() {
      await ready;
      return sorted();
    },

    async add({ question, answer, alternates = [] }) {
      await ready;
      const entry = {
        id: crypto.randomUUID(),
        question,
        alternates,
        answer,
        hotkey: null,
        createdAt: new Date().toISOString(),
      };
      entries.set(entry.id, entry);
      // Persist best-effort: if Supabase is unreachable, keep the entry in
      // memory for this session instead of failing the save outright.
      if (supabaseEnabled) {
        try {
          const { error } = await supabase.from(TABLE).insert({
            id: entry.id,
            question: entry.question,
            alternates: entry.alternates,
            answer: entry.answer,
            created_at: entry.createdAt,
          });
          if (error) throw error;
        } catch (err) {
          console.warn(`[qa] Not persisted to Supabase (kept in memory): ${err.message}`);
        }
      }
      return entry;
    },

    /**
     * Adds many entries in one round trip — used by bulk import. A single
     * batched Supabase insert instead of one per row, same best-effort
     * fallback as `add` if Supabase is unreachable.
     *
     * @param {{ question: string, answer: string, alternates?: string[] }[]} pairs
     */
    async addMany(pairs) {
      await ready;
      // One timestamp per entry, not one for the whole batch. Sharing a single
      // createdAt across an import leaves nothing to order the rows by, and
      // preserves the order of the file being imported only by accident.
      const base = Date.now();
      const newEntries = pairs.map(({ question, answer, alternates = [] }, index) => ({
        id: crypto.randomUUID(),
        question,
        alternates,
        answer,
        hotkey: null,
        createdAt: new Date(base + index).toISOString(),
      }));
      for (const entry of newEntries) entries.set(entry.id, entry);

      if (supabaseEnabled && newEntries.length > 0) {
        // Sent in batches: a single insert of a thousand-plus rows is the kind
        // of request that times out, and one failure would take the whole
        // import with it.
        const BATCH = 250;
        const rows = newEntries.map((e) => ({
          id: e.id,
          question: e.question,
          alternates: e.alternates,
          answer: e.answer,
          created_at: e.createdAt,
        }));

        for (let i = 0; i < rows.length; i += BATCH) {
          const { error } = await supabase.from(TABLE).insert(rows.slice(i, i + BATCH));
          if (error) {
            // Deliberately *not* swallowed the way a single add is. An import
            // is how someone restores their answers; reporting success while
            // the rows only exist in memory means they disappear again at the
            // next restart, which is worse than failing loudly here.
            const saved = i;
            for (const entry of newEntries.slice(saved)) entries.delete(entry.id);
            throw new Error(
              `Saved ${saved} of ${rows.length} entries, then the database rejected the rest: ${error.message}`,
            );
          }
        }
      }
      return newEntries;
    },

    async update(id, fields) {
      await ready;
      const existing = entries.get(id);
      if (!existing) return null;
      const updated = { ...existing, ...fields };
      entries.set(id, updated);
      if (supabaseEnabled) {
        try {
          const { error } = await supabase.from(TABLE).update(fields).eq("id", id);
          if (error) throw error;
        } catch (err) {
          console.warn(`[qa] Supabase update failed (updated locally): ${err.message}`);
        }
      }
      return updated;
    },

    async remove(id) {
      await ready;
      if (!entries.has(id)) return false;
      entries.delete(id);
      if (supabaseEnabled) {
        try {
          const { error } = await supabase.from(TABLE).delete().eq("id", id);
          if (error) throw error;
        } catch (err) {
          console.warn(`[qa] Supabase delete failed (removed locally): ${err.message}`);
        }
      }
      return true;
    },

    /**
     * Removes every entry. Irreversible — there's no undo and no soft-delete,
     * which is why the UI confirms with the count before calling this.
     *
     * Unlike the single-entry delete, an unreachable Supabase is reported
     * rather than swallowed: dropping the rows locally while leaving them in
     * the table would make the list reappear on the next restart, which looks
     * like the delete silently failed.
     *
     * @returns {Promise<number>} how many entries were removed
     */
    async removeAll() {
      await ready;
      const count = entries.size;
      if (count === 0) return 0;

      if (supabaseEnabled) {
        // Supabase requires a filter on delete; matching every non-null id is
        // the documented way to express "all rows".
        const { error } = await supabase.from(TABLE).delete().not("id", "is", null);
        if (error) throw new Error(error.message);
      }

      entries.clear();
      return count;
    },
  };
}
