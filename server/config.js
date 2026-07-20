import dotenv from "dotenv";

dotenv.config();

// Central place for environment-derived settings and tunable constants.
export const config = {
  port: Number(process.env.PORT) || 3000,
  hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY),

  // Claude
  model: "claude-sonnet-5",
  maxAnswerTokens: 1024,

  // Uploads
  maxFileBytes: 25 * 1024 * 1024, // 25 MB per file

  // Supabase (file storage). The VITE_-prefixed names are read so the same
  // .env values used by the frontend build also work here; SUPABASE_* names
  // are supported as plain aliases.
  supabase: {
    url: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "",
    anonKey:
      process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || "",
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
    bucket: process.env.SUPABASE_BUCKET || "attachments",
  },
};
