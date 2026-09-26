// Run with: deno test --no-check tests/functions/   (or `npm run test:fn`)
// Everything external is faked -- no Stripe account, network or database is touched. The
// handler under test is supabase/functions/create-checkout/handler.ts; index.ts only wires
// real clients into it.
import assert from "node:assert/strict";
import { CORS_HEADERS, createHandler } from "../../supabase/functions/create-checkout/handler.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const USER = { id: "user-1" };
const PURCHASABLE = { id: "unicorn", stripe_price_id: "price_unicorn", price_cents: 199, active: true };

interface Setup {
  user?: Any;                // what auth.getUser() resolves to (null => signed out)
  authError?: Any;
  skin?: Any;                // row returned for the skins lookup (null => not found)
  skinError?: Any;
  owned?: Any;               // row returned for the owned_skins lookup (null => not owned)
  stripeError?: Error;
  siteUrl?: string;
}

function setup(o: Setup = {}) {
  const queries: { table: string; filters: Record<string, unknown> }[] = [];
  const sessionParams: Any[] = [];
  const authHeaders: string[] = [];

  const client = {
    auth: {
      getUser: async () => ({
        data: { user: "user" in o ? o.user : USER },
        error: o.authError ?? null,
      }),
    },
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      queries.push({ table, filters });
      const chain: Any = {
        select: (_cols: string) => chain,
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          return chain;
        },
        is: (col: string, val: unknown) => {
          filters[col] = val;
          return chain;
        },
        maybeSingle: async () => {
          if (table === "skins") {
            return { data: "skin" in o ? o.skin : PURCHASABLE, error: o.skinError ?? null };
          }
          return { data: o.owned ?? null, error: null };
        },
      };
      return chain;
    },
  };

  const sessionOptions: Any[] = [];
  const stripe = {
    checkout: {
      sessions: {
        create: async (params: Any, options: Any) => {
          sessionParams.push(params);
          sessionOptions.push(options);
          if (o.stripeError) throw o.stripeError;
          return { url: "https://checkout.stripe.com/c/pay/cs_test_1" };
        },
      },
    },
  };

  const handler = createHandler({
    stripe: stripe as Any,
    supabaseFor: (authorization) => {
      authHeaders.push(authorization);
      return client as Any;
    },
    getSiteUrl: () => o.siteUrl ?? "https://www.pigsgonnablow.com",
  });
  return { handler, queries, sessionParams, sessionOptions, authHeaders };
}

function post(body: unknown, headers: Record<string, string> = { Authorization: "Bearer jwt" }) {
  return new Request("https://x.supabase.co/functions/v1/create-checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function json(res: Response) {
  return await res.json();
}

function assertCors(res: Response) {
  for (const [k, v] of Object.entries(CORS_HEADERS)) assert.equal(res.headers.get(k), v, k);
}

Deno.test("OPTIONS preflight: 200 with the CORS headers, no auth, no Stripe call", async () => {
  const t = setup();
  const res = await t.handler(new Request("https://x/", { method: "OPTIONS" }));
  assert.equal(res.status, 200);
  assertCors(res);
  assert.equal(await res.text(), "");
  assert.equal(t.authHeaders.length, 0);
  assert.equal(t.sessionParams.length, 0);
});

Deno.test("CORS preflight allows every header supabase-js sends", () => {
  const allowed = CORS_HEADERS["Access-Control-Allow-Headers"].split(",").map((h) => h.trim());
  for (const h of ["authorization", "x-client-info", "apikey", "content-type"]) {
    assert.ok(allowed.includes(h), `missing ${h}`);
  }
});

Deno.test("happy path: creates a payment-mode session and returns its URL", async () => {
  const t = setup();
  const res = await t.handler(post({ skin_id: "unicorn" }));
  assert.equal(res.status, 200);
  assertCors(res);
  assert.equal(res.headers.get("Content-Type"), "application/json");
  assert.deepEqual(await json(res), { url: "https://checkout.stripe.com/c/pay/cs_test_1" });

  assert.equal(t.sessionParams.length, 1);
  const p = t.sessionParams[0];
  assert.equal(p.mode, "payment");
  assert.deepEqual(p.line_items, [{ price: "price_unicorn", quantity: 1 }]);
  assert.equal(p.success_url, "https://www.pigsgonnablow.com?checkout=success");
  assert.equal(p.cancel_url, "https://www.pigsgonnablow.com?checkout=cancel");
  assert.deepEqual(p.managed_payments, { enabled: false });
});

Deno.test("the caller's Authorization header is what builds the Supabase client", async () => {
  const t = setup();
  await t.handler(post({ skin_id: "unicorn" }, { Authorization: "Bearer abc.def" }));
  assert.deepEqual(t.authHeaders, ["Bearer abc.def"]);
});

Deno.test("identity comes from the session: a user_id in the body is ignored", async () => {
  const t = setup();
  await t.handler(post({ skin_id: "unicorn", user_id: "someone-else" }));
  assert.deepEqual(t.sessionParams[0].metadata, { user_id: "user-1", skin_id: "unicorn" });
  // ...and the ownership check is against the session's user too.
  const ownedQuery = t.queries.find((q) => q.table === "owned_skins")!;
  assert.equal(ownedQuery.filters.user_id, "user-1");
});

Deno.test("the price sent to Stripe comes from the catalog, never from the request", async () => {
  const t = setup();
  await t.handler(post({ skin_id: "unicorn", price: "price_free", price_id: "price_free", stripe_price_id: "price_free", price_cents: 1 }));
  assert.equal(t.sessionParams[0].line_items[0].price, "price_unicorn");
  assert.equal(t.sessionParams[0].line_items.length, 1);
  assert.equal(t.sessionParams[0].line_items[0].quantity, 1);
});

Deno.test("SITE_URL is read per request", async () => {
  const t = setup({ siteUrl: "https://staging.example.com" });
  await t.handler(post({ skin_id: "unicorn" }));
  assert.equal(t.sessionParams[0].success_url, "https://staging.example.com?checkout=success");
});

Deno.test("no Authorization header at all: 401 and nothing is created", async () => {
  const t = setup({ user: null });
  const res = await t.handler(post({ skin_id: "unicorn" }, {}));
  assert.equal(res.status, 401);
  assertCors(res);
  assert.deepEqual(await json(res), { error: "Not signed in." });
  assert.deepEqual(t.authHeaders, [""]); // falls back to an empty header, which getUser rejects
  assert.equal(t.sessionParams.length, 0);
});

Deno.test("invalid/expired token (getUser errors): 401 and nothing is created", async () => {
  const t = setup({ user: null, authError: { message: "invalid JWT" } });
  const res = await t.handler(post({ skin_id: "unicorn" }));
  assert.equal(res.status, 401);
  assert.equal(t.sessionParams.length, 0);
});

Deno.test("getUser error wins even if a user object is somehow present", async () => {
  const t = setup({ user: USER, authError: { message: "boom" } });
  const res = await t.handler(post({ skin_id: "unicorn" }));
  assert.equal(res.status, 401);
  assert.equal(t.sessionParams.length, 0);
});

Deno.test("signed out: no catalog or ownership query is even made", async () => {
  const t = setup({ user: null });
  await t.handler(post({ skin_id: "unicorn" }));
  assert.equal(t.queries.length, 0);
});

Deno.test("missing/empty skin_id: 400", async () => {
  for (const body of [{}, { skin_id: "" }, { skin_id: null }]) {
    const t = setup();
    const res = await t.handler(post(body));
    assert.equal(res.status, 400, JSON.stringify(body));
    assertCors(res);
    assert.deepEqual(await json(res), { error: "Missing skin_id." });
    assert.equal(t.sessionParams.length, 0);
  }
});

Deno.test("unparseable or non-object body: 400 (caller's mistake, not a 500), no session", async () => {
  for (const body of ["not json", "", "null", "[]", "42", '"unicorn"']) {
    const t = setup();
    const res = await t.handler(post(body));
    assert.equal(res.status, 400, JSON.stringify(body));
    assertCors(res);
    assert.deepEqual(await json(res), { error: "Invalid request body." });
    assert.equal(t.sessionParams.length, 0);
    assert.equal(t.queries.length, 0); // rejected before any catalog/ownership lookup
  }
});

Deno.test("skin lookup is by the requested id", async () => {
  const t = setup();
  await t.handler(post({ skin_id: "unicorn" }));
  const q = t.queries.find((q) => q.table === "skins")!;
  assert.deepEqual(q.filters, { id: "unicorn" });
});

const NOT_PURCHASABLE: [string, Setup][] = [
  ["unknown skin", { skin: null }],
  ["catalog lookup errors", { skin: null, skinError: { message: "db down" } }],
  ["lookup errors even if a row came back", { skin: PURCHASABLE, skinError: { message: "x" } }],
  ["inactive skin", { skin: { ...PURCHASABLE, active: false } }],
  ["no stripe_price_id (free/default skin)", { skin: { ...PURCHASABLE, stripe_price_id: null } }],
  ["empty stripe_price_id", { skin: { ...PURCHASABLE, stripe_price_id: "" } }],
  ["price_cents = 0", { skin: { ...PURCHASABLE, price_cents: 0 } }],
  ["negative price_cents", { skin: { ...PURCHASABLE, price_cents: -100 } }],
];
for (const [name, opts] of NOT_PURCHASABLE) {
  Deno.test(`not purchasable -> 400, no session: ${name}`, async () => {
    const t = setup(opts);
    const res = await t.handler(post({ skin_id: "unicorn" }));
    assert.equal(res.status, 400);
    assertCors(res);
    assert.deepEqual(await json(res), { error: "That skin isn't purchasable." });
    assert.equal(t.sessionParams.length, 0);
  });
}

Deno.test("already owned: 400 and no second session (no double-buy)", async () => {
  const t = setup({ owned: { skin_id: "unicorn" } });
  const res = await t.handler(post({ skin_id: "unicorn" }));
  assert.equal(res.status, 400);
  assertCors(res);
  assert.deepEqual(await json(res), { error: "You already own that skin." });
  assert.equal(t.sessionParams.length, 0);
});

Deno.test("ownership check is scoped to both the user and the skin, and excludes revoked rows", async () => {
  const t = setup();
  await t.handler(post({ skin_id: "unicorn" }));
  const q = t.queries.find((q) => q.table === "owned_skins")!;
  assert.deepEqual(q.filters, { user_id: "user-1", skin_id: "unicorn", revoked_at: null });
});

// REGRESSION (adversarial security review): the "already own it" check is check-then-act --
// without a stable idempotency key, two requests fired close together (double-click, a retried
// fetch, two tabs) could both pass that check before either created a session, each getting its
// own Stripe Checkout Session and letting the buyer be charged twice for one skin.
Deno.test("REGRESSION: checkout session creation carries a stable per-user-per-skin idempotency key", async () => {
  const t = setup();
  await t.handler(post({ skin_id: "unicorn" }));
  assert.equal(t.sessionOptions.length, 1);
  const key = t.sessionOptions[0]?.idempotencyKey;
  assert.equal(typeof key, "string");
  assert.ok(key.includes("user-1"), key);
  assert.ok(key.includes("unicorn"), key);
});

Deno.test("REGRESSION: the idempotency key is stable across repeated calls for the same user+skin, but differs across users/skins", async () => {
  const t1 = setup();
  await t1.handler(post({ skin_id: "unicorn" }));
  await t1.handler(post({ skin_id: "unicorn" }));
  assert.equal(t1.sessionOptions[0].idempotencyKey, t1.sessionOptions[1].idempotencyKey);

  const t2 = setup({ user: { id: "user-2" } });
  await t2.handler(post({ skin_id: "unicorn" }));
  assert.notEqual(t2.sessionOptions[0].idempotencyKey, t1.sessionOptions[0].idempotencyKey);
});

Deno.test("Stripe failure: generic 500 that doesn't leak the underlying error", async () => {
  const errors: unknown[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => errors.push(a);
  try {
    const t = setup({ stripeError: new Error("sk_live_SECRET rate limited req_123") });
    const res = await t.handler(post({ skin_id: "unicorn" }));
    assert.equal(res.status, 500);
    assertCors(res);
    const text = JSON.stringify(await json(res));
    assert.equal(text, JSON.stringify({ error: "Checkout unavailable right now." }));
    assert.ok(!text.includes("sk_live"));
    assert.equal(errors.length, 1); // but it is logged server-side
  } finally {
    console.error = orig;
  }
});

Deno.test("every response carries the CORS headers (browser can read errors)", async () => {
  const cases: [Setup, unknown][] = [
    [{ user: null }, { skin_id: "unicorn" }],
    [{}, {}],
    [{ skin: null }, { skin_id: "x" }],
    [{ owned: { skin_id: "unicorn" } }, { skin_id: "unicorn" }],
    [{}, { skin_id: "unicorn" }],
  ];
  for (const [opts, body] of cases) {
    assertCors(await setup(opts).handler(post(body)));
  }
});
