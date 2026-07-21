import { initSse } from "./sse.js";
import { config } from "../config.js";

/**
 * Logs token usage and a rough cost estimate for one answer, so cost is
 * visible per-question rather than only discovered later on the bill.
 * `cache_read_input_tokens` near `input_tokens + cache_creation_input_tokens`
 * means the attachment cache is being hit; near zero on a repeat question
 * means something is invalidating it (attachments changed, or more than an
 * hour passed).
 *
 * @param {{ input_tokens?: number, output_tokens?: number, cache_creation_input_tokens?: number, cache_read_input_tokens?: number }} usage
 */
function logUsage(usage) {
  if (!usage) return;
  const {
    input_tokens = 0,
    output_tokens = 0,
    cache_creation_input_tokens = 0,
    cache_read_input_tokens = 0,
  } = usage;
  const { inputPerMTok, outputPerMTok, cacheWriteMultiplier, cacheReadMultiplier } =
    config.pricing;

  const cost =
    (input_tokens * inputPerMTok +
      cache_creation_input_tokens * inputPerMTok * cacheWriteMultiplier +
      cache_read_input_tokens * inputPerMTok * cacheReadMultiplier) /
      1_000_000 +
    (output_tokens * outputPerMTok) / 1_000_000;

  console.log(
    `[ask] input=${input_tokens} cache_write=${cache_creation_input_tokens} ` +
      `cache_read=${cache_read_input_tokens} output=${output_tokens} ` +
      `~$${cost.toFixed(4)} (upper-bound estimate, standard rates)`,
  );
}

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
      logUsage(final.usage);
      sse.send("done", { answer });
    } catch (err) {
      console.error(err);
      sse.send("error", { message: err?.message ?? "Something went wrong." });
    } finally {
      sse.end();
    }
  };
}
