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
  return {
    /**
     * Start a streamed answer. Returns the SDK message stream so the caller
     * can forward `text` events and await the final message.
     *
     * @param {{ question: string }} params
     */
    streamAnswer({ question }) {
      return client.messages.stream({
        model: config.model,
        max_tokens: config.maxAnswerTokens,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: question }],
      });
    },
  };
}
