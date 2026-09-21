// Run with: deno test --no-check tests/functions/   (or `npm run test:fn`)
// Everything external is faked -- no Stripe account, network or database is touched. The
// handler under test is supabase/functions/stripe-webhook/handler.ts; index.ts only wires
// real clients into it.
import assert from "node:assert/strict";
import { createHandler } from "../../supabase/functions/stripe-webhook/handler.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

interface Call { op: string; table: string; [k: string]: unknown }

interface FakeDbOptions {
  // Responder for `.from(table).select(...).eq(col, val).maybeSingle()`.
  select?: (table: string, col: string, val: unknown) => { data: unknown };
  upsertError?: { message: string; code?: string } | null;
  deleteError?: { message: string } | null;
}

function fakeSupabase(opts: FakeDbOptions = {}) {
  const calls: Call[] = [];
  const client = {
    from: (table: string) => ({
      select: (_cols: string) => ({
        eq: (col: string, val: unknown) => ({
          maybeSingle: async () => opts.select?.(table, col, val) ?? { data: null },
        }),
      }),
      upsert: async (row: unknown, options: unknown) => {
        calls.push({ op: "upsert", table, row, options });
        return { error: opts.upsertError ?? null };
      },
      delete: () => ({
        eq: (c1: string, v1: unknown) => ({
          eq: async (c2: string, v2: unknown) => {
            calls.push({ op: "delete", table, filters: { [c1]: v1, [c2]: v2 } });
            return { error: opts.deleteError ?? null };
          },
        }),
      }),
      update: (patch: unknown) => ({
        eq: async (col: string, val: unknown) => {
          calls.push({ op: "update", table, patch, filter: { [col]: val } });
          return { error: null };
        },
      }),
    }),
  };
  return { client: client as Any, calls };
}

function fakeStripe(sessionsByPaymentIntent: Record<string, Any[]> = {}) {
  const listCalls: Any[] = [];
  const stripe = {
    webhooks: {
      // Mirrors the real contract closely enough: only a request carrying the one "good"
      // signature is accepted, everything else (missing header included) throws.
      constructEventAsync: async (body: string, sig: string | null, _secret: string) => {
        if (sig !== "good") throw new Error("No signatures found matching the expected signature");
        return JSON.parse(body);
      },
    },
    checkout: {
      sessions: {
        list: async (params: { payment_intent: string }) => {
          listCalls.push(params);
          return { data: sessionsByPaymentIntent[params.payment_intent] ?? [] };
        },
      },
    },
  };
  return { stripe: stripe as Any, listCalls };
}

function setup(o: { live?: boolean; db?: FakeDbOptions; sessions?: Record<string, Any[]> } = {}) {
  const { client, calls } = fakeSupabase(o.db);
  const { stripe, listCalls } = fakeStripe(o.sessions);
  const handler = createHandler({
    stripe,
    supabaseAdmin: client,
    webhookSecret: "whsec_test",
    isLiveKey: o.live ?? false,
  });
  return { handler, calls, listCalls };
}

function event(type: string, object: Any, livemode = false) {
  return { id: "evt_1", type, livemode, data: { object } };
}

function post(handler: (r: Request) => Promise<Response>, ev: unknown, sig: string | null = "good") {
  return handler(new Request("http://localhost/stripe-webhook", {
    method: "POST",
    headers: sig ? { "stripe-signature": sig } : {},
    body: JSON.stringify(ev),
  }));
}

// The loud, greppable line the operator is meant to find when a paid session can't be granted.
function assertActionRequired(errors: unknown[][]) {
  assert.ok(
    errors.some((e) => String(e[0]).includes("ACTION REQUIRED: paid session NOT granted")),
    "expected an ACTION REQUIRED log line",
  );
}

const paidSession = (over: Record<string, unknown> = {}) => ({
  id: "cs_1",
  mode: "payment",
  payment_status: "paid",
  amount_total: 199,
  currency: "usd",
  metadata: { user_id: "user-1", skin_id: "skin-a" },
  ...over,
});

// Handler logs errors on every rejection path; keep test output readable and let tests
// assert on what was logged.
async function quietly<T>(fn: () => Promise<T>): Promise<{ result: T; errors: unknown[][] }> {
  const origError = console.error, origLog = console.log;
  const errors: unknown[][] = [];
  console.error = (...a: unknown[]) => { errors.push(a); };
  console.log = () => {};
  try {
    return { result: await fn(), errors };
  } finally {
    console.error = origError;
    console.log = origLog;
  }
}

// ---------------------------------------------------------------- signature / mode

Deno.test("rejects a bad signature with 400 and writes nothing", async () => {
  const { handler, calls } = setup();
  const { result: res } = await quietly(() => post(handler, event("checkout.session.completed", paidSession()), "forged"));
  assert.equal(res.status, 400);
  assert.deepEqual(calls, []);
});

Deno.test("rejects a request with no signature header", async () => {
  const { handler, calls } = setup();
  const { result: res } = await quietly(() => post(handler, event("checkout.session.completed", paidSession()), null));
  assert.equal(res.status, 400);
  assert.deepEqual(calls, []);
});

Deno.test("refuses a test-mode event when the configured key is live", async () => {
  const { handler, calls } = setup({ live: true });
  const { result: res } = await quietly(() => post(handler, event("checkout.session.completed", paidSession(), false)));
  assert.equal(res.status, 400);
  assert.equal(await res.text(), "Mode mismatch");
  assert.deepEqual(calls, []);
});

Deno.test("refuses a live-mode event when the configured key is a test key", async () => {
  const { handler, calls } = setup({ live: false });
  const { result: res } = await quietly(() => post(handler, event("checkout.session.completed", paidSession(), true)));
  assert.equal(res.status, 400);
  assert.deepEqual(calls, []);
});

Deno.test("accepts matching live event + live key", async () => {
  const { handler, calls } = setup({ live: true });
  const { result: res } = await quietly(() => post(handler, event("checkout.session.completed", paidSession(), true)));
  assert.equal(res.status, 200);
  assert.equal(calls.filter((c) => c.op === "upsert").length, 1);
});

Deno.test("an unrelated event type is acknowledged and ignored", async () => {
  const { handler, calls } = setup();
  const { result: res } = await quietly(() => post(handler, event("customer.created", {})));
  assert.equal(res.status, 200);
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------- granting

Deno.test("grants exactly one owned_skins row for a paid session, idempotently", async () => {
  const { handler, calls } = setup();
  const { result: res } = await quietly(() => post(handler, event("checkout.session.completed", paidSession())));
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    op: "upsert",
    table: "owned_skins",
    row: {
      user_id: "user-1",
      skin_id: "skin-a",
      stripe_checkout_session_id: "cs_1",
      amount_paid_cents: 199,
      currency: "usd",
    },
    // A Stripe retry must be a harmless no-op, not a duplicate-key error (which would 500).
    options: { onConflict: "user_id,skin_id", ignoreDuplicates: true },
  });
});

Deno.test("async_payment_succeeded grants exactly like completed", async () => {
  const { handler, calls } = setup();
  const { result: res } = await quietly(() => post(handler, event("checkout.session.async_payment_succeeded", paidSession())));
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].op, "upsert");
});

Deno.test("REGRESSION: an unpaid (delayed-method) session grants nothing but still returns 200", async () => {
  const { handler, calls } = setup();
  const { result: res } = await quietly(() =>
    post(handler, event("checkout.session.completed", paidSession({ payment_status: "unpaid" })))
  );
  // 200, not 4xx/5xx -- a non-2xx would make Stripe retry a legitimately-pending payment.
  assert.equal(res.status, 200);
  assert.deepEqual(calls, []);
});

Deno.test("REGRESSION: unpaid then async_payment_succeeded -> only the second grants", async () => {
  const { handler, calls } = setup();
  await quietly(() => post(handler, event("checkout.session.completed", paidSession({ payment_status: "unpaid" }))));
  assert.equal(calls.length, 0);
  await quietly(() => post(handler, event("checkout.session.async_payment_succeeded", paidSession())));
  assert.equal(calls.length, 1);
});

for (
  const [label, over] of [
    ["a non-payment mode", { mode: "subscription" }],
    ["amount_total 0", { amount_total: 0 }],
    ["amount_total null", { amount_total: null }],
    ["a negative amount_total", { amount_total: -5 }],
  ] as const
) {
  Deno.test(`a paid session with ${label}: no grant, 200 (no pointless retries) + ACTION REQUIRED log`, async () => {
    const { handler, calls } = setup();
    const { result: res, errors } = await quietly(() => post(handler, event("checkout.session.completed", paidSession(over))));
    assert.equal(res.status, 200);
    assert.deepEqual(calls, []);
    assertActionRequired(errors);
  });
}

for (
  const [label, metadata] of [
    ["no metadata at all", undefined],
    ["missing user_id", { skin_id: "skin-a" }],
    ["missing skin_id", { user_id: "user-1" }],
  ] as const
) {
  Deno.test(`a paid session with ${label}: no grant, 200 (no pointless retries) + ACTION REQUIRED log`, async () => {
    const { handler, calls } = setup();
    const { result: res, errors } = await quietly(() => post(handler, event("checkout.session.completed", paidSession({ metadata }))));
    assert.equal(res.status, 200);
    assert.deepEqual(calls, []);
    assertActionRequired(errors);
  });
}

Deno.test("catalog price drift is logged loudly but the purchase is still granted at the charged amount", async () => {
  const { handler, calls } = setup({
    db: { select: (table) => (table === "skins" ? { data: { price_cents: 299 } } : { data: null }) },
  });
  const { result: res, errors } = await quietly(() => post(handler, event("checkout.session.completed", paidSession())));
  assert.equal(res.status, 200);
  assert.ok(errors.some((e) => String(e[0]).includes("does not match current catalog price")));
  assert.equal(calls.length, 1);
  assert.equal((calls[0].row as Any).amount_paid_cents, 199);
});

Deno.test("a DB error while granting returns 500 so Stripe retries", async () => {
  const { handler } = setup({ db: { upsertError: { message: "boom" } } });
  const { result: res } = await quietly(() => post(handler, event("checkout.session.completed", paidSession())));
  assert.equal(res.status, 500);
});

Deno.test("a transient DB error (any code but 23503) still returns 500 and is NOT logged as unrecoverable", async () => {
  for (const code of [undefined, "08006", "57014", "40001"]) {
    const { handler } = setup({ db: { upsertError: { message: "boom", code } } });
    const { result: res, errors } = await quietly(() => post(handler, event("checkout.session.completed", paidSession())));
    assert.equal(res.status, 500, String(code));
    assert.ok(!errors.some((e) => String(e[0]).includes("ACTION REQUIRED")), String(code));
  }
});

Deno.test("an unknown skin_id (FK violation 23503): 200 so Stripe stops retrying, ACTION REQUIRED log with the details", async () => {
  const { handler } = setup({
    db: { upsertError: { message: 'insert or update on table "owned_skins" violates foreign key constraint', code: "23503" } },
  });
  const { result: res, errors } = await quietly(() => post(handler, event("checkout.session.completed", paidSession())));
  assert.equal(res.status, 200);
  assertActionRequired(errors);
  // the log must carry enough to refund/grant by hand
  const detail = JSON.stringify(errors.find((e) => String(e[0]).includes("ACTION REQUIRED")));
  for (const needle of ["cs_1", "user-1", "skin-a", "199"]) assert.ok(detail.includes(needle), needle);
});

Deno.test("async_payment_succeeded with an unknown skin is handled the same way", async () => {
  const { handler } = setup({ db: { upsertError: { message: "fk", code: "23503" } } });
  const { result: res, errors } = await quietly(() => post(handler, event("checkout.session.async_payment_succeeded", paidSession())));
  assert.equal(res.status, 200);
  assertActionRequired(errors);
});

Deno.test("an ordinary successful grant does not emit ACTION REQUIRED", async () => {
  const { handler } = setup();
  const { errors } = await quietly(() => post(handler, event("checkout.session.completed", paidSession())));
  assert.ok(!errors.some((e) => String(e[0]).includes("ACTION REQUIRED")));
});

// ---------------------------------------------------------------- revoking

const fullRefund = (over: Record<string, unknown> = {}) => ({
  id: "ch_1",
  payment_intent: "pi_1",
  amount: 199,
  amount_refunded: 199,
  ...over,
});
const sessionsFor = (pi = "pi_1") => ({ [pi]: [{ id: "cs_1", metadata: { user_id: "user-1", skin_id: "skin-a" } }] });

Deno.test("REGRESSION: a full refund revokes the skin", async () => {
  const { handler, calls, listCalls } = setup({ sessions: sessionsFor() });
  const { result: res } = await quietly(() => post(handler, event("charge.refunded", fullRefund())));
  assert.equal(res.status, 200);
  assert.deepEqual(listCalls, [{ payment_intent: "pi_1", limit: 1 }]);
  assert.deepEqual(calls.filter((c) => c.op === "delete"), [
    { op: "delete", table: "owned_skins", filters: { user_id: "user-1", skin_id: "skin-a" } },
  ]);
});

Deno.test("REGRESSION: a dispute revokes the skin", async () => {
  const { handler, calls } = setup({ sessions: sessionsFor() });
  const { result: res } = await quietly(() =>
    post(handler, event("charge.dispute.created", { id: "dp_1", payment_intent: "pi_1", amount: 199 }))
  );
  assert.equal(res.status, 200);
  assert.equal(calls.filter((c) => c.op === "delete").length, 1);
});

Deno.test("a partial refund keeps the skin (no lookup, no delete)", async () => {
  const { handler, calls, listCalls } = setup({ sessions: sessionsFor() });
  const { result: res } = await quietly(() => post(handler, event("charge.refunded", fullRefund({ amount_refunded: 1 }))));
  assert.equal(res.status, 200);
  assert.deepEqual(calls, []);
  assert.deepEqual(listCalls, []);
});

Deno.test("a dispute is not subject to the partial-refund check", async () => {
  // Disputes have no amount_refunded -- must not be mistaken for a partial refund.
  const { handler, calls } = setup({ sessions: sessionsFor() });
  await quietly(() => post(handler, event("charge.dispute.created", { id: "dp_1", payment_intent: "pi_1" })));
  assert.equal(calls.filter((c) => c.op === "delete").length, 1);
});

Deno.test("revoking the currently-equipped skin resets the profile to the default skin", async () => {
  const { handler, calls } = setup({
    sessions: sessionsFor(),
    db: {
      select: (table, col) => {
        if (table === "profiles") return { data: { equipped_skin_id: "skin-a" } };
        if (table === "skins" && col === "is_default") {
          return { data: { id: "pig", emoji: "P", color_filter: "none" } };
        }
        return { data: null };
      },
    },
  });
  await quietly(() => post(handler, event("charge.refunded", fullRefund())));
  assert.deepEqual(calls.filter((c) => c.op === "update"), [
    {
      op: "update",
      table: "profiles",
      patch: { equipped_skin_id: "pig", avatar: "P", color_filter: "none" },
      filter: { user_id: "user-1" },
    },
  ]);
});

Deno.test("revoking a skin that is NOT equipped leaves the profile alone", async () => {
  const { handler, calls } = setup({
    sessions: sessionsFor(),
    db: { select: (table) => (table === "profiles" ? { data: { equipped_skin_id: "some-other-skin" } } : { data: null }) },
  });
  await quietly(() => post(handler, event("charge.refunded", fullRefund())));
  assert.equal(calls.filter((c) => c.op === "update").length, 0);
  assert.equal(calls.filter((c) => c.op === "delete").length, 1);
});

Deno.test("an expanded payment_intent object is handled like a string id", async () => {
  const { handler, calls } = setup({ sessions: sessionsFor() });
  await quietly(() => post(handler, event("charge.refunded", fullRefund({ payment_intent: { id: "pi_1" } }))));
  assert.equal(calls.filter((c) => c.op === "delete").length, 1);
});

Deno.test("a refund with no payment_intent returns 200 and deletes nothing", async () => {
  const { handler, calls } = setup();
  const { result: res } = await quietly(() => post(handler, event("charge.refunded", fullRefund({ payment_intent: null }))));
  assert.equal(res.status, 200);
  assert.deepEqual(calls, []);
});

Deno.test("a refund whose session can't be resolved returns 200 and deletes nothing", async () => {
  const { handler, calls } = setup({ sessions: {} });
  const { result: res } = await quietly(() => post(handler, event("charge.refunded", fullRefund())));
  assert.equal(res.status, 200);
  assert.deepEqual(calls, []);
});

Deno.test("a DB error while revoking returns 500 so Stripe retries", async () => {
  const { handler } = setup({ sessions: sessionsFor(), db: { deleteError: { message: "boom" } } });
  const { result: res } = await quietly(() => post(handler, event("charge.refunded", fullRefund())));
  assert.equal(res.status, 500);
});
