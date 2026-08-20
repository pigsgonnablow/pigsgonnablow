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
// checkout.session.async_payment_succeeded. Both land here and are handled identically --
// see the payment_status check below for why two event types are needed.
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
    // async, unlike Node's. This also enforces Stripe's signing-timestamp tolerance, so an
    // old captured request can't be replayed later to re-grant something.
    event = await stripe.webhooks.constructEventAsync(body, signature!, webhookSecret);
  } catch (e) {
    console.error("[stripe-webhook] signature verification failed:", e);
    return new Response("Invalid signature", { status: 400 });
  }

  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const session = event.data.object as Stripe.Checkout.Session;

    // "completed" fires as soon as the customer finishes Checkout, which for an instant
    // method (card) also means paid -- but for a delayed method (bank debit, some Klarna
    // flows) it fires with payment_status "unpaid" while the payment is still processing,
    // and Stripe follows up with a separate async_payment_succeeded event once it actually
    // clears (or async_payment_failed, which needs no handling here since nothing was
    // granted yet). Only ever grant on a session Stripe has confirmed is actually paid --
    // an early or on-completion-only grant would hand out the skin before payment for a
    // failed/delayed method, and payment_status is the field the correction event flips.
    if (session.payment_status !== "paid") return new Response(JSON.stringify({ received: true }), {
      headers: { "Content-Type": "application/json" },
    });

    // Sessions are only ever created by create-checkout, always mode:'payment' with a real
    // priced skin -- amount_total <= 0 or a mode mismatch would mean either a bug on our
    // side or a session that didn't come from our own checkout flow, and shouldn't happen.
    if (session.mode !== "payment" || !session.amount_total || session.amount_total <= 0){
      console.error("[stripe-webhook] unexpected session shape, refusing to grant:", session.id, session.mode, session.amount_total);
      return new Response("Unexpected session", { status: 400 });
    }

    const userId = session.metadata?.user_id;
    const skinId = session.metadata?.skin_id;
    if (!userId || !skinId) {
      console.error("[stripe-webhook] session missing user_id/skin_id metadata:", session.id);
      return new Response("Missing metadata", { status: 400 });
    }

    // Cross-check against the catalog as a sanity/audit signal -- not a gate (the amount
    // actually charged, from Stripe, is always the source of truth), just something to make
    // a price drift between session-creation and payment loudly visible in logs rather than
    // silently invisible.
    const { data: skin } = await supabaseAdmin
      .from("skins")
      .select("price_cents")
      .eq("id", skinId)
      .maybeSingle();
    if (skin && skin.price_cents !== session.amount_total) {
      console.error(
        "[stripe-webhook] amount_total does not match current catalog price -- granting anyway based on what was actually charged:",
        { session: session.id, skinId, charged: session.amount_total, catalog: skin.price_cents },
      );
    }

    // Stripe retries webhook delivery on anything but a 2xx response, so this can run more
    // than once for the same purchase -- upsert on the (user_id, skin_id) primary key rather
    // than insert, so a retry is a harmless no-op instead of an error.
    const { error } = await supabaseAdmin
      .from("owned_skins")
      .upsert(
        {
          user_id: userId,
          skin_id: skinId,
          stripe_checkout_session_id: session.id,
          amount_paid_cents: session.amount_total,
          currency: session.currency,
        },
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
