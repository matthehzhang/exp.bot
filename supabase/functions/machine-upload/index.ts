// A machine asks for signed upload URLs with its own token (header x-machine-token).
// Files land at org-files/<org_id>/<machine name>/<path>; the machine never sees another path.
//
// POST {"paths": ["logs/app.log", "run/joints.csv.gz"]}
//   -> {"uploads": [{"path": "...", "signed_url": "...", "token": "..."}]}
// Upload each file with: PUT <signed_url>  (body = file bytes, Content-Type set)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const BUCKET = "org-files";
const MAX_FILES = 50;
const SAFE = /^(?!.*\.\.)[A-Za-z0-9._\-][A-Za-z0-9._\-\/]{0,255}$/;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return "\\x" + [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const token = req.headers.get("x-machine-token") ?? "";
  if (!token.startsWith("exb_")) return json({ error: "missing machine token" }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  const { data: tok } = await admin.from("machine_tokens").select("machine_id")
    .eq("token_hash", await sha256(token)).maybeSingle();
  if (!tok) return json({ error: "unknown machine token" }, 401);
  const { data: m } = await admin.from("machines").select("id, org_id, name").eq("id", tok.machine_id).single();
  if (!m) return json({ error: "unknown machine" }, 401);

  let paths: unknown;
  try {
    paths = (await req.json())?.paths;
  } catch {
    return json({ error: "body must be JSON" }, 400);
  }
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_FILES) {
    return json({ error: `paths: 1-${MAX_FILES} relative paths` }, 400);
  }
  const uploads = [];
  for (const p of paths) {
    if (typeof p !== "string" || !SAFE.test(p) || p.startsWith("/")) {
      return json({ error: `bad path: ${String(p).slice(0, 80)}` }, 400);
    }
    const full = `${m.org_id}/${m.name}/${p}`;
    const { data, error } = await admin.storage.from(BUCKET).createSignedUploadUrl(full, { upsert: true });
    if (error) return json({ error: error.message }, 500);
    uploads.push({ path: full, signed_url: data.signedUrl, token: data.token });
  }
  return json({ uploads });
});
