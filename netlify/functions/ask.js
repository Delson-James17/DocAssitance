// Netlify Function equivalent of server/http/ask.controller.js. Reuses the
// same server/services/claude.service.js call — only the transport differs:
// Express streams SSE via res.write() (see server/http/sse.js), Netlify
// Functions stream it through a ReadableStream Response body instead. The
// wire format (event: X\ndata: {...}\n\n) is identical either way, so
// src/lib/api.ts's askQuestion() parses it the same regardless of which
// backend produced it.
import { createClaudeService } from "../../server/services/claude.service.js";
import { config as appConfig } from "../../server/config.js";

const claude = createClaudeService();
const encoder = new TextEncoder();

function logUsage(usage) {
  if (!usage) return;
  const { input_tokens = 0, output_tokens = 0 } = usage;
  const { inputPerMTok, outputPerMTok } = appConfig.pricing;
  const cost = (input_tokens * inputPerMTok + output_tokens * outputPerMTok) / 1_000_000;
  console.log(
    `[ask] input=${input_tokens} output=${output_tokens} ` +
      `~$${cost.toFixed(4)} (upper-bound estimate, standard rates)`,
  );
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export default async (req) => {
  const body = await req.json().catch(() => ({}));
  const question = (body?.question ?? "").toString().trim();
  if (!question) return jsonError("No question provided.", 400);

  const send = (controller, event, data) => {
    controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  };

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const messageStream = claude.streamAnswer({ question });
        messageStream.on("text", (delta) => send(controller, "delta", { text: delta }));

        const final = await messageStream.finalMessage();
        const answer = final.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("");
        logUsage(final.usage);
        send(controller, "done", { answer });
      } catch (err) {
        console.error(err);
        send(controller, "error", { message: err?.message ?? "Something went wrong." });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
};

export const config = {
  path: "/api/ask",
  method: ["POST"],
};
