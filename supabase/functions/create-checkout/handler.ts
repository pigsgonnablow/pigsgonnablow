import type Stripe from "npm:stripe@17.5.0";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

// Split out of index.ts so the request handler can be imported by tests with fake Stripe/
// Supabase clients -- index.ts builds the real ones from env vars and calls Deno.serve, which
// can't be done at import time in a test. Behavior is otherwise unchanged from when this all
// lived in index.ts.
export interface CheckoutDeps {
  stripe: Stripe;
  // Builds the per-request Supabase client from the caller's Authorization header (anon key +
  // that header, so RLS and auth.getUser() both see the caller, never a service role).
  supabaseFor: (authorizationHeader: string) => SupabaseClient;
  // A function rather than a string so SITE_URL is still read per request, as before.
  getSiteUrl: () => string;
}

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  // x-client-info/apikey: sent automatically by supabase-js's sb.functions.invoke() (used in
  // js/shop.js) alongside authorization/content-type -- all four need to be allowed or the
  // browser's CORS preflight rejects the request before it ever reaches this function.
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

export function createHandler({ stripe, supabaseFor, getSiteUrl }: CheckoutDeps) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    try {
      // Identify the caller from their own Supabase session (the Authorization header the
      // client already sends with every Supabase call) -- never trust a user_id passed in the
      // request body, since that would let anyone buy skins for someone else's account.
      const supabase = supabaseFor(req.headers.get("Authorization") ?? "");
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

      const siteUrl = getSiteUrl();
      // metadata here is how the webhook (a separate, unrelated request from Stripe's servers,
      // with no access to this request's context) learns who bought what -- it can't infer
      // user_id/skin_id any other way.
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [{ price: skin.stripe_price_id, quantity: 1 }],
        success_url: `${siteUrl}?checkout=success`,
        cancel_url: `${siteUrl}?checkout=cancel`,
        metadata: { user_id: user.id, skin_id: skin.id },
        // Stripe's account-level "Managed Payments" (on by default on newer accounts) requires
        // every product to carry a tax_code so it can calculate sales tax -- irrelevant for a
        // cosmetic digital good with no jurisdictional tax obligation, so opt this session out
        // rather than tagging every skin in the catalog with a tax code it doesn't need.
        // deno-lint-ignore no-explicit-any
        ...({ managed_payments: { enabled: false } } as any),
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
  };
}
