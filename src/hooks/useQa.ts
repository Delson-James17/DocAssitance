import { useCallback, useEffect, useState } from "react";
import { addQa, importQa, listQa, removeQa, updateQa } from "../lib/api";
import type { QaEntry } from "../types";

interface UseQa {
  entries: QaEntry[];
  add: (question: string, answer: string, alternates?: string[]) => Promise<void>;
  update: (
    id: string,
    fields: { question?: string; answer?: string; alternates?: string[]; hotkey?: string | null },
  ) => Promise<void>;
  remove: (id: string) => Promise<void>;
  // Resolves to how many pairs actually got saved, so the caller (the
  // import UI) can report a count back to the user.
  importMany: (
    pairs: { question: string; answer: string; alternates?: string[] }[],
  ) => Promise<number>;
}

// Owns the saved Q&A list — the manually-curated answers that App.tsx checks
// before falling back to document search, and that QaPanel lets you manage.
export function useQa(): UseQa {
  const [entries, setEntries] = useState<QaEntry[]>([]);

  useEffect(() => {
    listQa().then(setEntries).catch(() => undefined);
  }, []);

  const add = useCallback(async (question: string, answer: string, alternates: string[] = []) => {
    try {
      setEntries(await addQa(question, answer, alternates));
    } catch (err) {
      alert(err instanceof Error ? err.message : "Couldn't save the Q&A entry.");
    }
  }, []);

  const update = useCallback(
    async (
      id: string,
      fields: { question?: string; answer?: string; alternates?: string[]; hotkey?: string | null },
    ) => {
      try {
        setEntries(await updateQa(id, fields));
      } catch (err) {
        alert(err instanceof Error ? err.message : "Couldn't update the Q&A entry.");
      }
    },
    [],
  );

  const remove = useCallback(async (id: string) => {
    try {
      setEntries(await removeQa(id));
    } catch (err) {
      alert(err instanceof Error ? err.message : "Couldn't delete the Q&A entry.");
    }
  }, []);

  const importMany = useCallback(
    async (pairs: { question: string; answer: string; alternates?: string[] }[]) => {
      try {
        const result = await importQa(pairs);
        setEntries(result.entries);
        return result.imported;
      } catch (err) {
        alert(err instanceof Error ? err.message : "Couldn't import the Q&A entries.");
        return 0;
      }
    },
    [],
  );

  return { entries, add, update, remove, importMany };
}
