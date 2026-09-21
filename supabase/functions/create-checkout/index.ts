// Creates a Stripe Checkout Session for a priced skin and hands the client back the URL to
// redirect the browser to. Runs server-side (Supabase Edge Function) specifically because it's
// the one thing in this feature that needs the Stripe *secret* key -- that can never live in
// client code (js/shop.js), only here, as the STRIPE_SECRET_KEY env var/secret.
//
// Deploy: supabase functions deploy create-checkout
// Secrets needed (supabase secrets set ...): STRIPE_SECRET_KEY (sk_test_... in sandbox),
// SITE_URL (e.g. https://www.pigsgonnablow.com -- used to build the Checkout success/cancel
// redirect back into the game). SUPABASE_URL / SUPABASE_ANON_KEY are already provided
// automatically to every Edge Function by the platform.
import Stripe from "npm:stripe@17.5.0";
import { createClient } from "npm:@supabase/supabase-js@2";
import { createHandler } from "./handler.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  httpClient: Stripe.createFetchHttpClient(),
});

Deno.serve(createHandler({
  stripe,
  supabaseFor: (authorization) =>
    createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authorization } } },
    ),
  getSiteUrl: () => Deno.env.get("SITE_URL")!,
}));
