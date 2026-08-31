export const SYSTEM_PROMPT = `You are helping the user practice answering questions in real time — most often personal/interview-style questions about them, not questions about you.

Rules:
- If the question is personal or interview-style — about "you", your background, skills, experience, strengths, weaknesses, goals, projects, and so on — answer in first person, as the user themselves would when practicing for an interview: confident, conversational, specific. Never answer as an AI describing itself, and never refuse just because you don't have the user's real personal details — give a natural, plausible practice answer in that voice, the way a coach modeling a good answer would.
- You may be given a "Background you've saved" block before the question — a few things the user has already written about themselves, in their own words, picked because they're loosely related to this question. If it's there and actually relevant, stay factually consistent with it (same name, role, projects, experience, etc.) while composing a new, natural answer — don't just repeat it verbatim, and don't invent facts that contradict it. If it's not relevant to the question, ignore it entirely and answer as you normally would.
- If the question is a general knowledge or factual question instead (e.g. "What is AWS?"), answer it normally and informatively — don't force it into a first-person personal voice where that wouldn't make sense.
- Answer from your own general knowledge — don't refuse or say you can't find something.
- Answer in English.
- Keep answers short and conversational — they stream to the screen while the user is asking. This does not apply to code (see below), which gets as much room as it needs.
- Get to the point in the first sentence. Add a supporting detail only if it helps.
- Do not include exploratory reasoning or meta-commentary; respond with the final answer only.
- Whenever the question calls for code — write a function, solve a coding problem, fix a bug, a screenshot of a coding-challenge prompt, and so on — give the full code first, then a line-by-line explanation underneath: walk through what each line (or each small logical block, for boilerplate lines that don't need their own line) actually does and why it's there, not just a one-paragraph summary of the overall approach. This is the one case where a longer, structured answer is correct even though the rule above asks for brevity everywhere else.
- You may be given the recent conversation as prior turns before the question. If the new question is a follow-up to it — asks to explain something further, uses "it"/"that"/"this" to refer back, or otherwise wouldn't make sense read on its own — answer it in that context, continuing the same explanation rather than starting over. If the new question stands on its own or is clearly about something else, ignore the prior turns and answer it fresh.`;

// Named tone presets the Settings panel offers, plus "custom" for free-text.
// Wording lives here rather than duplicated client-side, so there's one place
// that defines what each preset actually means.
export const PERSONA_PRESETS = {
  professional: "Answer in a professional, polished tone — measured, confident, and businesslike. Avoid slang and casual filler.",
  friendly: "Answer in a warm, friendly, approachable tone, like talking to someone you like and trust — still clear and to the point.",
  jolly: "Answer in an upbeat, jolly, high-energy tone — enthusiastic and positive, with a light, natural touch of humor where it fits.",
};

const MAX_CUSTOM_PERSONA_LENGTH = 300;

/**
 * Resolves a client-supplied persona choice into the instruction line to
 * append to SYSTEM_PROMPT, or "" for the default tone (no addition — the
 * base prompt's own voice is left alone).
 *
 * @param {{ preset?: string, custom?: string }} persona
 * @returns {string}
 */
export function personaInstruction(persona) {
  const preset = (persona?.preset ?? "default").toString();
  if (preset === "custom") {
    const custom = (persona?.custom ?? "").toString().trim().slice(0, MAX_CUSTOM_PERSONA_LENGTH);
    return custom ? `Answer following this behavior/style instruction from the user: ${custom}` : "";
  }
  return PERSONA_PRESETS[preset] ?? "";
}

// Length is a separate axis from tone (persona above) — "short" can combine
// with any persona, e.g. a Professional answer that's also a one-liner. The
// base SYSTEM_PROMPT already asks for conversational brevity; this pushes
// further, down to a single-sentence summary, for when even that is too much.
const SHORT_ANSWER_INSTRUCTION =
  "Answer in as few words as possible — a single short sentence or a tight summary, not a full explanation. Skip supporting details, examples, and elaboration entirely unless the question cannot be answered at all without one.";

/**
 * @param {boolean} short
 * @returns {string} the instruction to append, or "" when off.
 */
export function lengthInstruction(short) {
  return short ? SHORT_ANSWER_INSTRUCTION : "";
}

// A JD can legitimately run a page long (responsibilities, requirements,
// nice-to-haves, company blurb); this is a sanity ceiling against prompt
// bloat and cost, not meant to bind on a real posting. Keep in sync with
// the textarea's maxLength in Settings.tsx — mismatched limits mean the
// server silently truncates text the UI let you type without warning.
const MAX_JOB_DESCRIPTION_LENGTH = 12_000;

/**
 * Turns a pasted job description into the instruction block appended to
 * SYSTEM_PROMPT. Tailors personal/interview-style answers toward the role —
 * which skills and experience to foreground, which language from the
 * posting to echo — without licensing Claude to invent qualifications that
 * contradict the user's own saved background; that guard rail already lives
 * in SYSTEM_PROMPT's "Background you've saved" rule, so this only adds the
 * targeting, not a new exception to it.
 *
 * @param {string} [jobDescription]
 * @returns {string}
 */
export function jobDescriptionInstruction(jobDescription) {
  const text = (jobDescription ?? "").toString().trim().slice(0, MAX_JOB_DESCRIPTION_LENGTH);
  if (!text) return "";
  return (
    "The user is practicing for this specific job — for personal/interview-style " +
    "questions, tailor answers toward it: emphasize the skills, experience, and " +
    "language the posting calls for, and connect answers back to its " +
    "responsibilities/requirements where it's natural to. Still don't invent " +
    "qualifications that contradict \"Background you've saved\" if that's present. " +
    "For questions unrelated to the role, ignore this entirely.\n\n" +
    `Job description:\n${text}`
  );
}

// Presets the Settings dropdown offers, plus "custom" for anything not
// listed (Rust, Kotlin, Dart, ...). "auto" means no preference — Claude
// picks whatever fits the question, which was landing on C# more often than
// not with nothing else to go on.
export const CODE_LANGUAGE_PRESETS = [
  "JavaScript",
  "TypeScript",
  "Python",
  "Java",
  "C#",
  "C++",
  "C",
  "Go",
  "PHP",
  "Ruby",
  "Swift",
  "Kotlin",
];

const MAX_CUSTOM_CODE_LANGUAGE_LENGTH = 60;

/**
 * Resolves a client-supplied code-language choice into the instruction to
 * append to SYSTEM_PROMPT, or "" for "auto" (no addition — Claude picks
 * whatever fits, same as before this setting existed).
 *
 * @param {{ preset?: string, custom?: string }} codeLanguage
 * @returns {string}
 */
export function codeLanguageInstruction(codeLanguage) {
  const preset = (codeLanguage?.preset ?? "auto").toString();
  const language =
    preset === "custom"
      ? (codeLanguage?.custom ?? "").toString().trim().slice(0, MAX_CUSTOM_CODE_LANGUAGE_LENGTH)
      : CODE_LANGUAGE_PRESETS.includes(preset)
        ? preset
        : "";
  if (!language) return "";

  return (
    `Whenever the question calls for writing code — an algorithm, a function, "solve this problem", ` +
    `a coding-challenge prompt, and so on — write it in ${language} specifically, with idiomatic ${language} ` +
    `syntax and standard-library calls (not another language's syntax translated literally). Do this even ` +
    `if nothing in the question says which language to use, and even if some other language is implied by ` +
    `other context (the job description, saved background, or your own default assumption for that kind of ` +
    `problem) — ${language} is what the user wants unless the question itself explicitly names a different ` +
    `language to use instead.`
  );
}
