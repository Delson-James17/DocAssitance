import { createClient } from "@supabase/supabase-js";
import { config } from "../config.js";

/**
 * A Supabase client for server-side file storage, or `null` if Supabase
 * isn't configured. The service-role key is preferred (it bypasses Storage
 * RLS); the anon key also works as long as the bucket has policies that
 * allow it — see README.md for the setup SQL.
 */
export const supabase = (() => {
  const { url, serviceRoleKey, anonKey } = config.supabase;
  const key = serviceRoleKey || anonKey;
  if (!url || !key) return null;

  return createClient(url, key, {
    auth: { persistSession: false },
  });
})();

export const supabaseEnabled = supabase !== null;
