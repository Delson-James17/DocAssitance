/**
 * Converts a stored file into a Claude content block, chosen by MIME type:
 *  - PDFs  → native `document` block
 *  - images → native `image` block
 *  - everything else → `text` block (utf-8 contents)
 *
 * @param {{ name: string, mimetype: string, buffer: Buffer }} file
 * @returns {object} a Claude content block
 */
export function fileToBlock(file) {
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
