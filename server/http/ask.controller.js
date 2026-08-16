import { initSse } from "./sse.js";
import { config } from "../config.js";

/**
 * Logs token usage and a rough cost estimate for one answer, so cost is
 * visible per-question rather than only discovered later on the bill.
 *
 * @param {{ input_tokens?: number, output_tokens?: number }} usage
 */
function logUsage(usage) {
  if (!usage) return;
  const { input_tokens = 0, output_tokens = 0 } = usage;
  const { inputPerMTok, outputPerMTok } = config.pricing;

  const cost = (input_tokens * inputPerMTok + output_tokens * outputPerMTok) / 1_000_000;

  console.log(
    `[ask] input=${input_tokens} output=${output_tokens} ` +
      `~$${cost.toFixed(4)} (upper-bound estimate, standard rates)`,
  );
}

/**
 * Trusts nothing from the request body beyond "is it shaped like a list of
 * {question, answer} strings" — this is user-supplied saved data forwarded
 * straight into the Claude prompt, not something the server generated
 * itself.
 *
 * @param {unknown} raw
 */
function cleanContext(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((c) => ({
      question: (c?.question ?? "").toString().trim(),
      answer: (c?.answer ?? "").toString().trim(),
    }))
    .filter((c) => c.question && c.answer)
    .slice(0, 5);
}

/**
 * A screenshot question arrives as `{ mediaType, data }` — `data` a bare
 * base64 string (no "data:" prefix, that's stripped client-side), `mediaType`
 * one of the image types Claude's vision input accepts. Anything else is
 * treated as "no image was actually sent" rather than forwarded to Claude.
 *
 * @param {unknown} raw
 */
function cleanImage(raw) {
  const mediaType = (raw?.mediaType ?? "").toString();
  const data = (raw?.data ?? "").toString();
  if (!data || !/^image\/(png|jpe?g|gif|webp)$/.test(mediaType)) return null;
  return { mediaType, data };
}

const PERSONA_PRESET_KEYS = new Set(["default", "professional", "friendly", "jolly", "custom"]);

/**
 * The tone preset (and optional custom text) chosen in Settings. An unknown
 * preset falls back to "default" rather than erroring — this only ever
 * changes phrasing, never a rule the app depends on, so failing soft here
 * beats failing an otherwise-fine question over it.
 *
 * @param {unknown} raw
 */
function cleanPersona(raw) {
  const preset = (raw?.preset ?? "default").toString();
  return {
    preset: PERSONA_PRESET_KEYS.has(preset) ? preset : "default",
    custom: (raw?.custom ?? "").toString(),
  };
}

/**
 * HTTP handler that answers a question — typed/spoken text, or a screenshot
 * — from Claude's general knowledge, and streams the answer back as
 * Server-Sent Events.
 *
 * @param {{ claude: ReturnType<import("../services/claude.service.js").createClaudeService> }} deps
 */
export function createAskController({ claude }) {
  return async function ask(req, res) {
    const question = (req.body?.question ?? "").toString().trim();
    const image = cleanImage(req.body?.image);
    if (!question && !image) {
      return res.status(400).json({ error: "No question or screenshot provided." });
    }

    // Without this the Anthropic SDK fails deep inside the request with
    // "Could not resolve authentication method…", which surfaces in the UI as
    // a wall of jargon that doesn't hint at the actual fix. A packaged desktop
    // build can't see the repo's .env, so this is the first thing a fresh
    // install hits.
    if (!config.hasApiKey) {
      const hint = process.env.ENV_FILE_HINT;
      return res.status(503).json({
        error:
          "No Anthropic API key configured. Add ANTHROPIC_API_KEY to " +
          (hint ? `"${hint}"` : "your .env file") +
          " and restart the app. Saved Q&A answers still work without it.",
      });
    }

    const context = cleanContext(req.body?.context);
    const persona = cleanPersona(req.body?.persona);

    const sse = initSse(res);
    try {
      const stream = image
        ? claude.streamAnswerFromImage({
            imageBase64: image.data,
            mediaType: image.mediaType,
            context,
            persona,
          })
        : claude.streamAnswer({ question, context, persona });
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
