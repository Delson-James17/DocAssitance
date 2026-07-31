import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { SYSTEM_PROMPT } from "../prompts.js";

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

  return {
    /**
     * Start a streamed answer. Returns the SDK message stream so the caller
     * can forward `text` events and await the final message.
     *
     * @param {{ question: string, context?: { question: string, answer: string }[] }} params
     */
    streamAnswer({ question, context }) {
      return client.messages.stream({
        model: config.model,
        max_tokens: config.maxAnswerTokens,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildMessage(context, question) }],
      });
    },
  };
}
