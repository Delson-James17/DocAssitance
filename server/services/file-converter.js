import mammoth from "mammoth";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOC_MIME = "application/msword";

function hasExt(name, ext) {
  return name.toLowerCase().endsWith(ext);
}

// Heuristic binary-content sniff (same idea `file`/git use): a NUL byte is a
// hard binary signal, and a high ratio of other non-printable control bytes
// means it's not something that decodes sensibly as UTF-8 text. Without
// this, an unsupported binary format (e.g. .xlsx, .pptx, a random blob)
// would get dumped into the prompt as raw garbage instead of being flagged.
function looksBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  if (sample.length === 0) return false;

  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    const isControl = byte < 7 || (byte > 13 && byte < 32);
    if (isControl) suspicious++;
  }
  return suspicious / sample.length > 0.1;
}

/**
 * Converts a stored file into a Claude content block, chosen by MIME type:
 *  - PDFs   → native `document` block
 *  - images → native `image` block
 *  - .docx  → extracted text (mammoth) — the raw file is a zip of XML, not
 *             text, so it can't just be decoded as UTF-8. Detected by MIME
 *             type OR file extension, since browsers (Windows especially)
 *             sometimes report "application/octet-stream" for it instead.
 *  - legacy .doc → flagged with a clear "not supported, re-save as .docx/PDF"
 *             message — mammoth only handles the modern zip-based format.
 *  - other binary formats → a placeholder noting extraction isn't supported,
 *             instead of dumping garbled bytes into the prompt
 *  - everything else → `text` block (utf-8 contents)
 *
 * @param {{ name: string, mimetype: string, buffer: Buffer }} file
 * @returns {Promise<object>} a Claude content block
 */
export async function fileToBlock(file) {
  const mime = file.mimetype || "";
  const base64 = file.buffer.toString("base64");

  if (mime === "application/pdf") {
    return {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: base64 },
      title: file.name,
    };
  }

  if (mime.startsWith("image/")) {
    return {
      type: "image",
      source: { type: "base64", media_type: mime, data: base64 },
    };
  }

  if (mime === DOCX_MIME || hasExt(file.name, ".docx")) {
    try {
      const { value: text } = await mammoth.extractRawText({ buffer: file.buffer });
      return {
        type: "text",
        text: `--- FILE: ${file.name} ---\n${text}`,
      };
    } catch (err) {
      return {
        type: "text",
        text: `--- FILE: ${file.name} ---\n[Could not extract text from this Word document: ${err.message}]`,
      };
    }
  }

  if (mime === DOC_MIME || hasExt(file.name, ".doc")) {
    return {
      type: "text",
      text: `--- FILE: ${file.name} ---\n[This is the old .doc Word format, which isn't supported — please re-save it as .docx or PDF and re-attach.]`,
    };
  }

  if (looksBinary(file.buffer)) {
    return {
      type: "text",
      text: `--- FILE: ${file.name} ---\n[This file type (${mime || "unknown"}) isn't supported for text extraction yet — its contents were not included.]`,
    };
  }

  const text = file.buffer.toString("utf-8");
  return {
    type: "text",
    text: `--- FILE: ${file.name} ---\n${text}`,
  };
}

/**
 * @param {Express.Multer.File} file
 * @returns {{ name: string, mimetype: string, buffer: Buffer }}
 */
export function fileToAttachment(file) {
  return { name: file.originalname, mimetype: file.mimetype, buffer: file.buffer };
}
