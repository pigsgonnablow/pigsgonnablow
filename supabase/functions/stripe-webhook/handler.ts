import type Stripe from "npm:stripe@17.5.0";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

// Split out of index.ts so the request handler can be imported by tests with fake Stripe/
// Supabase clients -- index.ts builds the real ones from env vars and calls Deno.serve, which
// can't be done at import time in a test. Behavior is otherwise unchanged from when this all
// lived in index.ts.
export interface WebhookDeps {
  stripe: Stripe;
  supabaseAdmin: SupabaseClient;
  webhookSecret: string;
  isLiveKey: boolean;
}

const ok = () => new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });

// A *paid* session we can never grant (bad shape, missing metadata, skin/user that doesn't
// exist). Stripe retries anything but a 2xx for ~3 days, and none of these can succeed on a
// retry, so acknowledge with a 200 and rely on this log line instead -- money was taken and
// nothing was granted, so someone has to look at it. Grep the function logs for
// "ACTION REQUIRED". Transient failures (DB down etc.) deliberately still return 500 so they
// ARE retried.
function paidButNotGranted(reason: string, session: Stripe.Checkout.Session, extra: Record<string, unknown> = {}) {
  console.error(`[stripe-webhook] ACTION REQUIRED: paid session NOT granted (${reason}) -- returning 200 so Stripe stops retrying; refund or grant manually:`, {
    session: session.id,
    payment_intent: session.payment_intent,
    amount_total: session.amount_total,
    currency: session.currency,
    metadata: session.metadata,
    ...extra,
  });
  return ok();
}

export function createHandler({ stripe, supabaseAdmin, webhookSecret, isLiveKey }: WebhookDeps) {
  return async (req: Request): Promise<Response> => {
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

    // Belt-and-suspenders against a test-mode event ever granting a real entitlement: this
    // function only ever holds one STRIPE_WEBHOOK_SECRET at a time, so in the current setup a
    // sandbox event already fails signature verification above once the secret here is the
    // live one (or vice versa) -- but that protection depends entirely on the two secrets
    // never matching, which isn't something this function can see or enforce on its own.
    // Checking event.livemode against which kind of secret is actually configured makes the
    // guarantee explicit rather than incidental.
    if (event.livemode !== isLiveKey) {
      console.error("[stripe-webhook] event.livemode mismatch with configured key -- refusing:", event.id, event.livemode);
      return new Response("Mode mismatch", { status: 400 });
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
        return paidButNotGranted("unexpected session shape", session, { mode: session.mode });
      }

      const userId = session.metadata?.user_id;
      const skinId = session.metadata?.skin_id;
      if (!userId || !skinId) {
        return paidButNotGranted("missing user_id/skin_id metadata", session);
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
      // than once for the same purchase. grant_owned_skin (supabase_owned_skins_revocation.sql)
      // upserts on the (user_id, skin_id) primary key like a plain upsert would, but with one
      // extra guard a plain upsert can't express: it refuses to resurrect a row that was
      // revoked (refund/dispute) under this exact same checkout session -- otherwise a
      // replayed/redelivered copy of *this* grant event, arriving after that revoke, would
      // silently re-grant a skin whose payment no longer holds. A genuine repurchase (a new
      // session id) still grants normally.
      const { error } = await supabaseAdmin.rpc("grant_owned_skin", {
        p_user_id: userId,
        p_skin_id: skinId,
        p_session_id: session.id,
        p_amount_paid_cents: session.amount_total,
        p_currency: session.currency,
      });
      // 23503 = foreign_key_violation: the skin_id (or user) in the metadata doesn't exist, so
      // no retry can ever succeed -- unlike every other DB error, which may be transient.
      if (error?.code === "23503") {
        return paidButNotGranted("unknown skin or user (foreign key violation)", session, { userId, skinId, dbError: error.message });
      }
      if (error) {
        console.error("[stripe-webhook] failed to grant skin:", error.message, { userId, skinId });
        return new Response("DB error", { status: 500 });
      }
    }

    // A refund or chargeback means the payment that granted a skin no longer holds -- without
    // this, buy-then-refund keeps the skin forever, since nothing else ever revisits
    // owned_skins. create-checkout never sets payment_intent_data.metadata, so user_id/skin_id
    // don't live on the charge/dispute itself -- the checkout session that produced this
    // payment_intent is the only place they're recorded, same as the grant path above.
    if (event.type === "charge.refunded" || event.type === "charge.dispute.created") {
      const obj = event.data.object as Stripe.Charge | Stripe.Dispute;

      // charge.refunded fires for partial refunds too -- a goodwill $0.01 refund on a $1.99 skin
      // shouldn't take the skin away. Only a full refund (or a dispute, which contests the whole
      // charge) means the payment that granted the entitlement no longer holds.
      if (event.type === "charge.refunded") {
        const charge = obj as Stripe.Charge;
        if (charge.amount_refunded < charge.amount) {
          console.log("[stripe-webhook] partial refund, keeping skin:", event.id, charge.amount_refunded, "of", charge.amount);
          return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
        }
      }
      const paymentIntentId = typeof obj.payment_intent === "string" ? obj.payment_intent : obj.payment_intent?.id;
      if (!paymentIntentId) {
        console.error(`[stripe-webhook] ${event.type} has no payment_intent, can't revoke:`, event.id);
        return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
      }

      const sessions = await stripe.checkout.sessions.list({ payment_intent: paymentIntentId, limit: 1 });
      const session = sessions.data[0];
      const userId = session?.metadata?.user_id;
      const skinId = session?.metadata?.skin_id;
      if (!userId || !skinId) {
        console.error(`[stripe-webhook] ${event.type}: couldn't resolve user/skin for payment_intent`, paymentIntentId);
        return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
      }

      // Tombstoned (revoked_at set), not deleted -- deleting would free up the (user_id, skin_id)
      // primary-key slot for a later-replayed grant event to silently re-fill (see
      // supabase_owned_skins_revocation.sql and grant_owned_skin's guard above).
      const { error: revokeError } = await supabaseAdmin
        .from("owned_skins")
        .update({ revoked_at: new Date().toISOString() })
        .eq("user_id", userId)
        .eq("skin_id", skinId);
      if (revokeError) {
        console.error("[stripe-webhook] failed to revoke skin after refund/dispute:", revokeError.message, { userId, skinId });
        return new Response("DB error", { status: 500 });
      }

      // If the now-revoked skin is what the account currently has equipped, fall back to the
      // free default -- otherwise its effects (recolor, ember trail, etc.) keep showing even
      // though the entitlement backing them is gone.
      const { data: profile } = await supabaseAdmin
        .from("profiles").select("equipped_skin_id").eq("user_id", userId).maybeSingle();
      if (profile?.equipped_skin_id === skinId) {
        const { data: defaultSkin } = await supabaseAdmin
          .from("skins").select("id,emoji,color_filter").eq("is_default", true).maybeSingle();
        if (defaultSkin) {
          await supabaseAdmin
            .from("profiles")
            .update({ equipped_skin_id: defaultSkin.id, avatar: defaultSkin.emoji, color_filter: defaultSkin.color_filter })
            .eq("user_id", userId);
        }
      }

      console.log(`[stripe-webhook] revoked skin after ${event.type}:`, { userId, skinId, paymentIntentId });
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { "Content-Type": "application/json" },
    });
  };
}
