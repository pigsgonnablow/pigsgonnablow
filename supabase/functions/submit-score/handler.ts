import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

// Split out of index.ts so the request handler can be imported by tests with a fake Supabase
// client and a fake hasher -- index.ts builds the real ones from env vars and calls Deno.serve,
// which can't be done at import time in a test. Behavior is otherwise unchanged from when this
// would have lived entirely in index.ts.
export interface SubmitScoreDeps {
  // Service-role client: submit_anonymous_score() is deliberately not callable by anon/
  // authenticated (see supabase_scores_rate_limit_by_ip.sql) -- this Edge Function, which is the
  // only thing that can compute a real per-caller IP hash, is the one intended way to reach it.
  supabaseAdmin: SupabaseClient;
  // Takes the raw client IP (or null if one couldn't be determined) and returns a salted hash of
  // it, or null. Split out so tests don't need real crypto or a real secret.
  hashIp: (ip: string | null) => Promise<string | null>;
}

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  // x-client-info/apikey: sent automatically by supabase-js's sb.functions.invoke() (used in
  // js/leaderboard.js) alongside content-type -- both need to be allowed or the browser's CORS
  // preflight rejects the request before it ever reaches this function. No Authorization header
  // is required here (this is the anonymous submission path -- a signed-in run goes through
  // submit_personal_best() instead, called directly, since that path is already rate-limited by
  // being capped to one row per account).
  "Access-Control-Allow-Headers": "x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// Cloudflare (fronting Supabase's Edge Runtime) and most other proxies append the real client
// IP as the LAST entry of x-forwarded-for -- everything before it is untrusted, client-suppliable
// hops. Taking the first entry (a common mistake) would let a caller simply set their own
// x-forwarded-for header to a fresh fake value on every request and never be rate-limited at all.
function extractClientIp(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return req.headers.get("cf-connecting-ip") ?? req.headers.get("x-real-ip") ?? null;
}

export function createHandler({ supabaseAdmin, hashIp }: SubmitScoreDeps) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
    if (req.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405);

    try {
      let payload: unknown;
      try {
        payload = await req.json();
      } catch {
        payload = null;
      }
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        return jsonResponse({ error: "Invalid request body." }, 400);
      }
      const { name, score } = payload as { name?: unknown; score?: unknown };
      if (typeof name !== "string" || typeof score !== "number" || !Number.isFinite(score)) {
        return jsonResponse({ error: "Invalid name or score." }, 400);
      }

      const ipHash = await hashIp(extractClientIp(req));

      const { error } = await supabaseAdmin.rpc("submit_anonymous_score", {
        p_name: name,
        p_score: score,
        p_ip_hash: ipHash,
      });
      if (error) {
        // submit_anonymous_score raises a plain exception for both "too many submissions" and
        // bad input -- Postgres surfaces both the same way through PostgREST, so this is the
        // best signal available for picking a status code; either way the message itself is
        // safe to relay verbatim (it's one of the two fixed strings the function raises, never
        // user input echoed back).
        const status = /too many/i.test(error.message) ? 429 : 400;
        return jsonResponse({ error: error.message }, status);
      }

      return jsonResponse({ ok: true });
    } catch (e) {
      console.error("[submit-score] failed:", e);
      return jsonResponse({ error: "Couldn't submit right now." }, 500);
    }
  };
}
