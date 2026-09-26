// Anonymous (not-signed-in) score submission. Runs server-side specifically because it's the
// only place in this stack that ever sees the caller's real IP address -- PostgREST requests
// don't carry one into auth.uid()/RLS context, which is what made the DB-level rate limiter in
// supabase_lockdown_direct_writes.sql a single global budget instead of a per-caller one. See
// supabase_scores_rate_limit_by_ip.sql for the full story and the RPC this calls.
//
// Deploy: supabase functions deploy submit-score
// Secrets needed: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (service role because
// submit_anonymous_score() is deliberately not grantable to anon -- see that file for why),
// SCORE_IP_HASH_SALT (any long random string -- `openssl rand -hex 32` works; only used to
// salt the IP hash so raw IPs are never sent to or stored in the database).
import { createClient } from "npm:@supabase/supabase-js@2";
import { createHandler } from "./handler.ts";

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const salt = Deno.env.get("SCORE_IP_HASH_SALT")!;

async function hashIp(ip: string | null): Promise<string | null> {
  if (!ip) return null;
  const bytes = new TextEncoder().encode(`${salt}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(createHandler({ supabaseAdmin, hashIp }));
