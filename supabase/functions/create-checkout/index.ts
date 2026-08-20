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

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  // x-client-info/apikey: sent automatically by supabase-js's sb.functions.invoke() (used in
  // js/shop.js) alongside authorization/content-type -- all four need to be allowed or the
  // browser's CORS preflight rejects the request before it ever reaches this function.
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  httpClient: Stripe.createFetchHttpClient(),
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  try {
    // Identify the caller from their own Supabase session (the Authorization header the
    // client already sends with every Supabase call) -- never trust a user_id passed in the
    // request body, since that would let anyone buy skins for someone else's account.
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
    );
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Not signed in." }), {
        status: 401,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const { skin_id } = await req.json();
    if (!skin_id) {
      return new Response(JSON.stringify({ error: "Missing skin_id." }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const { data: skin, error: skinError } = await supabase
      .from("skins")
      .select("id,stripe_price_id,price_cents,active")
      .eq("id", skin_id)
      .maybeSingle();
    if (skinError || !skin || !skin.active || !skin.stripe_price_id || skin.price_cents <= 0) {
      return new Response(JSON.stringify({ error: "That skin isn't purchasable." }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const { data: owned } = await supabase
      .from("owned_skins")
      .select("skin_id")
      .eq("user_id", user.id)
      .eq("skin_id", skin_id)
      .maybeSingle();
    if (owned) {
      return new Response(JSON.stringify({ error: "You already own that skin." }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const siteUrl = Deno.env.get("SITE_URL")!;
    // metadata here is how the webhook (a separate, unrelated request from Stripe's servers,
    // with no access to this request's context) learns who bought what -- it can't infer
    // user_id/skin_id any other way.
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: skin.stripe_price_id, quantity: 1 }],
      success_url: `${siteUrl}?checkout=success`,
      cancel_url: `${siteUrl}?checkout=cancel`,
      metadata: { user_id: user.id, skin_id: skin.id },
    });

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[create-checkout] failed:", e);
    return new Response(JSON.stringify({ error: "Checkout unavailable right now." }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
