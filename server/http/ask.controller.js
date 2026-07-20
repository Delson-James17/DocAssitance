import { initSse } from "./sse.js";

/**
 * HTTP handler that answers a question from the attachments and streams the
 * answer back as Server-Sent Events.
 *
 * @param {{
 *   store: ReturnType<import("../services/attachment.store.js").createAttachmentStore>,
 *   claude: ReturnType<import("../services/claude.service.js").createClaudeService>,
 * }} deps
 */
export function createAskController({ store, claude }) {
  return async function ask(req, res) {
    const question = (req.body?.question ?? "").toString().trim();
    if (!question) {
      return res.status(400).json({ error: "No question provided." });
    }

    const sse = initSse(res);
    try {
      const stream = claude.streamAnswer({ question, blocks: await store.blocks() });
      stream.on("text", (delta) => sse.send("delta", { text: delta }));

      const final = await stream.finalMessage();
      const answer = final.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      sse.send("done", { answer });
    } catch (err) {
      console.error(err);
      sse.send("error", { message: err?.message ?? "Something went wrong." });
    } finally {
      sse.end();
    }
  };
}
