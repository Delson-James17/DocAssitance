import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { SYSTEM_PROMPT, personaInstruction } from "../prompts.js";

/**
 * Wraps the Anthropic SDK with this app's answering logic. The `client` is
 * injectable so it can be stubbed in tests.
 *
 * @param {Anthropic} [client]
 */
export function createClaudeService(client = new Anthropic()) {
  /**
   * Prepends a labeled "background" block built from loosely-related saved
   * Q&A entries (see src/lib/qaMatch.ts's findRelatedContext) so Claude's
   * improvised answer stays consistent with real saved facts about the
   * user instead of pure invention — see prompts.js for how it's told to
   * use (or ignore) this. Omitted entirely when there's no context, so a
   * plain question costs exactly what it always did.
   *
   * @param {{ question: string, answer: string }[]} context
   * @param {string} question
   */
  function buildMessage(context, question) {
    if (!context || context.length === 0) return `Question: ${question}`;

    const background = context
      .map((c) => `Q: ${c.question}\nA: ${c.answer}`)
      .join("\n\n");
    return `Background you've saved (use only if relevant to the question below, otherwise ignore):\n${background}\n\nQuestion: ${question}`;
  }

  /**
   * The same "Background you've saved" preamble buildMessage() prepends for
   * a text question, but as its own content block — an image message can't
   * just concatenate it into one string the way a text question can.
   *
   * @param {{ question: string, answer: string }[]} context
   */
  function backgroundBlock(context) {
    if (!context || context.length === 0) return null;
    const background = context
      .map((c) => `Q: ${c.question}\nA: ${c.answer}`)
      .join("\n\n");
    return `Background you've saved (use only if relevant to the question below, otherwise ignore):\n${background}\n`;
  }

  /**
   * SYSTEM_PROMPT plus an optional tone instruction — appended rather than
   * interpolated into the base prompt, so a persona can only add a stylistic
   * note on top, never rewrite the rules above it (first-person practice
   * answers, staying consistent with saved background, and so on).
   *
   * @param {{ preset?: string, custom?: string }} [persona]
   */
  function buildSystemPrompt(persona) {
    const tone = personaInstruction(persona);
    return tone ? `${SYSTEM_PROMPT}\n\n${tone}` : SYSTEM_PROMPT;
  }

  return {
    /**
     * Start a streamed answer. Returns the SDK message stream so the caller
     * can forward `text` events and await the final message.
     *
     * @param {{ question: string, context?: { question: string, answer: string }[], persona?: { preset?: string, custom?: string } }} params
     */
    streamAnswer({ question, context, persona }) {
      return client.messages.stream({
        model: config.model,
        max_tokens: config.maxAnswerTokens,
        system: buildSystemPrompt(persona),
        messages: [{ role: "user", content: buildMessage(context, question) }],
      });
    },

    /**
     * Same as streamAnswer, but the question is a screenshot rather than
     * text — Claude reads whatever question is shown in the image directly
     * (native vision support, no separate OCR step) and answers it.
     *
     * @param {{ imageBase64: string, mediaType: string, context?: { question: string, answer: string }[], persona?: { preset?: string, custom?: string } }} params
     */
    streamAnswerFromImage({ imageBase64, mediaType, context, persona }) {
      const background = backgroundBlock(context);
      const content = [
        ...(background ? [{ type: "text", text: background }] : []),
        { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
        {
          type: "text",
          text: "Read the question shown in this screenshot and answer it.",
        },
      ];

      return client.messages.stream({
        model: config.model,
        max_tokens: config.maxAnswerTokens,
        system: buildSystemPrompt(persona),
        messages: [{ role: "user", content }],
      });
    },
  };
}
