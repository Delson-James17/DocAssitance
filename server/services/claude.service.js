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
   * Build the user message content: file blocks first (stable → cacheable),
   * the volatile question last. The final file block carries the cache
   * breakpoint so repeated questions over the same files are fast and cheap.
   *
   * @param {object[]} blocks
   * @param {string} question
   */
  function buildContent(blocks, question) {
    const content = blocks.map((block) => ({ ...block }));

    if (content.length > 0) {
      const last = content.length - 1;
      content[last] = { ...content[last], cache_control: { type: "ephemeral" } };
    }

    content.push({ type: "text", text: `Question: ${question}` });
    return content;
  }

  return {
    /**
     * Start a streamed answer. Returns the SDK message stream so the caller
     * can forward `text` events and await the final message.
     *
     * @param {{ question: string, blocks: object[] }} params
     */
    streamAnswer({ question, blocks }) {
      return client.messages.stream({
        model: config.model,
        max_tokens: config.maxAnswerTokens,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildContent(blocks, question) }],
      });
    },
  };
}
