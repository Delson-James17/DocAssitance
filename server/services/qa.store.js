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

  function sorted() {
    return [...entries.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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
      const createdAt = new Date().toISOString();
      const newEntries = pairs.map(({ question, answer, alternates = [] }) => ({
        id: crypto.randomUUID(),
        question,
        alternates,
        answer,
        hotkey: null,
        createdAt,
      }));
      for (const entry of newEntries) entries.set(entry.id, entry);

      if (supabaseEnabled && newEntries.length > 0) {
        try {
          const { error } = await supabase.from(TABLE).insert(
            newEntries.map((e) => ({
              id: e.id,
              question: e.question,
              alternates: e.alternates,
              answer: e.answer,
              created_at: e.createdAt,
            })),
          );
          if (error) throw error;
        } catch (err) {
          console.warn(`[qa] Bulk import not persisted to Supabase (kept in memory): ${err.message}`);
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
  };
}
