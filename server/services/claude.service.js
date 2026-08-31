import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import {
  SYSTEM_PROMPT,
  codeLanguageInstruction,
  jobDescriptionInstruction,
  lengthInstruction,
  personaInstruction,
} from "../prompts.js";

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
   * Turns recent Q&A exchanges into real prior turns in the `messages`
   * array — not text stuffed into the current message — so Claude gets its
   * native multi-turn behavior for follow-ups ("explain that more", "why
   * line 3") instead of an ad-hoc summary of what was said before. Empty
   * when there's no history, so a fresh question costs exactly what it
   * always did.
   *
   * @param {{ question: string, answer: string }[]} [history]
   * @returns {{ role: "user" | "assistant", content: string }[]}
   */
  function buildHistoryMessages(history) {
    if (!history || history.length === 0) return [];
    return history.flatMap((h) => [
      { role: "user", content: h.question },
      { role: "assistant", content: h.answer },
    ]);
  }

  /**
   * SYSTEM_PROMPT plus whichever of tone/length/job-targeting/code-language
   * instructions are active — each appended rather than interpolated into
   * the base prompt, so none of them can rewrite the rules above them
   * (first-person practice answers, staying consistent with saved
   * background, and so on). All four are independent axes: a short, Jolly
   * answer can still be targeted at a specific job posting and still write
   * any code in a specific language.
   *
   * @param {{ preset?: string, custom?: string }} [persona]
   * @param {boolean} [short]
   * @param {string} [jobDescription]
   * @param {{ preset?: string, custom?: string }} [codeLanguage]
   */
  function buildSystemPrompt(persona, short, jobDescription, codeLanguage) {
    const extras = [
      personaInstruction(persona),
      lengthInstruction(short),
      jobDescriptionInstruction(jobDescription),
      codeLanguageInstruction(codeLanguage),
    ].filter(Boolean);
    return extras.length > 0 ? `${SYSTEM_PROMPT}\n\n${extras.join("\n\n")}` : SYSTEM_PROMPT;
  }

  return {
    /**
     * Start a streamed answer. Returns the SDK message stream so the caller
     * can forward `text` events and await the final message.
     *
     * @param {{ question: string, context?: { question: string, answer: string }[], persona?: { preset?: string, custom?: string }, short?: boolean, jobDescription?: string, codeLanguage?: { preset?: string, custom?: string }, history?: { question: string, answer: string }[] }} params
     */
    streamAnswer({ question, context, persona, short, jobDescription, codeLanguage, history }) {
      return client.messages.stream({
        model: config.model,
        max_tokens: config.maxAnswerTokens,
        system: buildSystemPrompt(persona, short, jobDescription, codeLanguage),
        messages: [
          ...buildHistoryMessages(history),
          { role: "user", content: buildMessage(context, question) },
        ],
      });
    },

    /**
     * Same as streamAnswer, but the question is a screenshot rather than
     * text — Claude reads whatever question is shown in the image directly
     * (native vision support, no separate OCR step) and answers it.
     *
     * @param {{ imageBase64: string, mediaType: string, context?: { question: string, answer: string }[], persona?: { preset?: string, custom?: string }, short?: boolean, jobDescription?: string, codeLanguage?: { preset?: string, custom?: string }, history?: { question: string, answer: string }[] }} params
     */
    streamAnswerFromImage({ imageBase64, mediaType, context, persona, short, jobDescription, codeLanguage, history }) {
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
        system: buildSystemPrompt(persona, short, jobDescription, codeLanguage),
        messages: [...buildHistoryMessages(history), { role: "user", content }],
      });
    },
  };
}
