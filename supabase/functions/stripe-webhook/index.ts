// Stripe calls this directly (not the browser) when a Checkout Session finishes. This is the
// only thing that's allowed to grant a skin -- js/shop.js and create-checkout never write to
// owned_skins themselves, specifically so a purchase can't be faked from the client.
//
// Deploy: supabase functions deploy stripe-webhook --no-verify-jwt
// (--no-verify-jwt because the caller is Stripe, not a signed-in player -- there's no
// Supabase session to check here. The Stripe signature check below is what verifies the
// request is genuinely from Stripe instead.)
// Secrets needed: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET (from the Stripe Dashboard/API
// after creating a webhook endpoint pointed at this function's URL -- see deploy notes),
// SUPABASE_URL (auto-provided), SUPABASE_SERVICE_ROLE_KEY (from Project Settings > API --
// needed here specifically to bypass RLS and insert into owned_skins on the buyer's behalf).
//
// Subscribed events (configure on the Stripe webhook endpoint): checkout.session.completed,
// checkout.session.async_payment_succeeded (granting -- both land here and are handled
// identically, see the payment_status check below for why two event types are needed),
// charge.refunded, charge.dispute.created (revoking -- see the block near the bottom).
import Stripe from "npm:stripe@17.5.0";
import { createClient } from "npm:@supabase/supabase-js@2";
import { createHandler } from "./handler.ts";

const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY")!;
const stripe = new Stripe(stripeSecretKey, {
  httpClient: Stripe.createFetchHttpClient(),
});

// Service-role client: RLS on owned_skins deliberately has no insert policy for anon/
// authenticated (see supabase_skins_schema.sql) -- this is the one intended way a row gets
// written, and it only runs after Stripe's signature is verified in handler.ts.
const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(createHandler({
  stripe,
  supabaseAdmin,
  webhookSecret: Deno.env.get("STRIPE_WEBHOOK_SECRET")!,
  isLiveKey: stripeSecretKey.startsWith("sk_live_"),
}));
