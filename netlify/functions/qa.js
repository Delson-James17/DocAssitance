// Netlify Function equivalent of server/http/qa.controller.js +
// server/http/routes.js's /api/qa* routes. Reuses the same
// server/services/qa.store.js logic — only the HTTP glue differs, since
// Netlify Functions speak Web-standard Request/Response, not Express's
// req/res. See server/http/qa.controller.js for the Express version used
// by local dev (`npm run dev`) and traditional Node hosting.
//
// A fresh store is created per invocation and every store method already
// awaits its own `ready()` sync with Supabase first, so this stays correct
// even though serverless functions can't rely on a long-lived in-memory
// cache across invocations the way the Express server can.
import { createQaStore } from "../../server/services/qa.store.js";

function json(data, init) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

export default async (req) => {
  const store = createQaStore();
  const segments = new URL(req.url).pathname.split("/").filter(Boolean);
  const rest = segments.slice(2); // drop "api", "qa"

  try {
    if (req.method === "GET" && rest.length === 0) {
      return json({ entries: await store.list() });
    }

    if (req.method === "POST" && rest.length === 0) {
      const body = await req.json().catch(() => ({}));
      const question = (body?.question ?? "").toString().trim();
      const answer = (body?.answer ?? "").toString().trim();
      if (!question || !answer) {
        return json({ error: "Both a question and an answer are required." }, { status: 400 });
      }
      await store.add({ question, answer });
      return json({ entries: await store.list() });
    }

    if (req.method === "POST" && rest[0] === "import") {
      const body = await req.json().catch(() => ({}));
      const raw = Array.isArray(body?.entries) ? body.entries : [];
      const pairs = raw
        .map((e) => ({
          question: (e?.question ?? "").toString().trim(),
          answer: (e?.answer ?? "").toString().trim(),
        }))
        .filter((e) => e.question && e.answer);
      if (pairs.length === 0) {
        return json({ error: "No valid question/answer pairs found to import." }, { status: 400 });
      }
      await store.addMany(pairs);
      return json({ imported: pairs.length, entries: await store.list() });
    }

    if (req.method === "PATCH" && rest.length === 1) {
      const body = await req.json().catch(() => ({}));
      const fields = {};
      if (body?.question !== undefined) fields.question = body.question.toString().trim();
      if (body?.answer !== undefined) fields.answer = body.answer.toString().trim();
      if (fields.question === "" || fields.answer === "") {
        return json({ error: "Question and answer can't be empty." }, { status: 400 });
      }
      const entry = await store.update(rest[0], fields);
      if (!entry) return json({ error: "Entry not found." }, { status: 404 });
      return json({ entries: await store.list() });
    }

    if (req.method === "DELETE" && rest.length === 1) {
      const ok = await store.remove(rest[0]);
      if (!ok) return json({ error: "Entry not found." }, { status: 404 });
      return json({ entries: await store.list() });
    }

    return json({ error: "Not found." }, { status: 404 });
  } catch (err) {
    console.error(err);
    return json({ error: err?.message ?? "Something went wrong." }, { status: 400 });
  }
};

export const config = {
  path: ["/api/qa", "/api/qa/*"],
};
