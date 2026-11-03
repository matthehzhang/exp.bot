// The project's URL and publishable key are public by design: row-level security in
// supabase/migrations decides what a signed-in person may see. Override with VITE_ env vars.
export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "https://gqykwyqrakxcwqxlmben.supabase.co";
export const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_KEY || "sb_publishable_8ravTa6ET01z3WgfJJu6uQ_NTScqkTO";
