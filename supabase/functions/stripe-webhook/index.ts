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
import Stripe from "npm:stripe@17.5.0";
import { createClient } from "npm:@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  httpClient: Stripe.createFetchHttpClient(),
});
const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;

// Service-role client: RLS on owned_skins deliberately has no insert policy for anon/
// authenticated (see supabase_skins_schema.sql) -- this is the one intended way a row gets
// written, and it only runs after Stripe's signature is verified below.
const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req) => {
  const signature = req.headers.get("stripe-signature");
  const body = await req.text();

  let event: Stripe.Event;
  try {
    // constructEventAsync (not constructEvent) -- Deno's SubtleCrypto-based verification is
    // async, unlike Node's.
    event = await stripe.webhooks.constructEventAsync(body, signature!, webhookSecret);
  } catch (e) {
    console.error("[stripe-webhook] signature verification failed:", e);
    return new Response("Invalid signature", { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const userId = session.metadata?.user_id;
    const skinId = session.metadata?.skin_id;
    if (!userId || !skinId) {
      console.error("[stripe-webhook] session missing user_id/skin_id metadata:", session.id);
      return new Response("Missing metadata", { status: 400 });
    }

    // Stripe retries webhook delivery on anything but a 2xx response, so this can run more
    // than once for the same purchase -- upsert on the (user_id, skin_id) primary key rather
    // than insert, so a retry is a harmless no-op instead of an error.
    const { error } = await supabaseAdmin
      .from("owned_skins")
      .upsert(
        { user_id: userId, skin_id: skinId, stripe_checkout_session_id: session.id },
        { onConflict: "user_id,skin_id", ignoreDuplicates: true },
      );
    if (error) {
      console.error("[stripe-webhook] failed to grant skin:", error.message, { userId, skinId });
      return new Response("DB error", { status: 500 });
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
