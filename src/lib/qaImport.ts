// Parses a bulk-import file (.csv or .json) into raw question/answer rows.
// Deliberately permissive on structure (header casing, q/a shorthand keys,
// object-map JSON) but strict about failing loudly when the shape can't be
// figured out, rather than silently importing garbage.

export interface ParsedQaRow {
  question: string;
  answer: string;
}

// Minimal RFC4180-style CSV parser: handles quoted fields, escaped quotes
// (""), and commas/newlines inside quotes — a naive text.split(",") breaks
// on any answer that itself contains a comma.
function parseCsvCells(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function parseCsv(text: string): ParsedQaRow[] {
  const rows = parseCsvCells(text).filter((r) => r.some((cell) => cell.trim() !== ""));
  if (rows.length === 0) return [];

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const qIdx = header.findIndex((h) => h === "question");
  const aIdx = header.findIndex((h) => h === "answer");
  if (qIdx === -1 || aIdx === -1) {
    throw new Error('CSV needs a header row with "question" and "answer" columns.');
  }

  return rows.slice(1).map((r) => ({
    question: (r[qIdx] ?? "").trim(),
    answer: (r[aIdx] ?? "").trim(),
  }));
}

function parseJson(text: string): ParsedQaRow[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("That file isn't valid JSON.");
  }

  if (Array.isArray(data)) {
    return data.map((item, i) => {
      if (typeof item !== "object" || item === null) {
        throw new Error(`Row ${i + 1} isn't an object with "question"/"answer" fields.`);
      }
      const row = item as Record<string, unknown>;
      const question = String(row.question ?? row.q ?? "").trim();
      const answer = String(row.answer ?? row.a ?? "").trim();
      return { question, answer };
    });
  }

  if (data && typeof data === "object") {
    return Object.entries(data as Record<string, unknown>).map(([question, answer]) => ({
      question: question.trim(),
      answer: String(answer).trim(),
    }));
  }

  throw new Error(
    "JSON must be an array of {question, answer} objects, or an object mapping questions to answers.",
  );
}

export async function parseQaImportFile(file: File): Promise<ParsedQaRow[]> {
  const text = await file.text();
  const name = file.name.toLowerCase();
  if (name.endsWith(".json")) return parseJson(text);
  if (name.endsWith(".csv")) return parseCsv(text);
  throw new Error("Import file must be .csv or .json.");
}
