import dotenv from "dotenv";

dotenv.config();

// Central place for environment-derived settings and tunable constants.
export const config = {
  port: Number(process.env.PORT) || 3000,
  hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY),

  // Claude
  model: "claude-sonnet-5",
  // Raised from 1024: a full code solution plus a genuine line-by-line
  // explanation (see SYSTEM_PROMPT's code rule) easily runs past that and
  // would get cut off mid-explanation — an answer stopping abruptly reads
  // as far more broken than a short conversational answer ever costs extra
  // to allow room for.
  maxAnswerTokens: 4096,

  // Standard (non-introductory) Sonnet 5 rates, per million tokens — used
  // only for the rough cost estimate logged after each answer. Deliberately
  // the higher standard rate rather than any temporary introductory
  // discount, so the estimate errs on the side of overstating cost.
  pricing: {
    inputPerMTok: 3.0,
    outputPerMTok: 15.0,
  },

  // Supabase (Postgres, for the saved Q&A table). The VITE_-prefixed names
  // are read so the same .env values used by the frontend build also work
  // here; SUPABASE_* names are supported as plain aliases.
  supabase: {
    url: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "",
    anonKey:
      process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || "",
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  },
};
