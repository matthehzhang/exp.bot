import { createClient } from "@supabase/supabase-js";
import { SUPABASE_KEY, SUPABASE_URL } from "./config.js";

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// Throws the API's message so callers can show it.
export async function must(promise) {
  const { data, error } = await promise;
  if (error) throw new Error(error.message);
  return data;
}
