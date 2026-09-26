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
  // Error from the grant_owned_skin RPC call (replaces the old plain upsert -- see
  // supabase_owned_skins_revocation.sql for why granting needs conditional logic now).
  rpcError?: { message: string; code?: string } | null;
  // Error from the owned_skins revoke (now an update that sets revoked_at, not a delete).
  revokeError?: { message: string } | null;
}

// `.update(patch).eq(...).eq(...)` (owned_skins revoke) and `.update(patch).eq(...)` (profiles
// equipped-skin reset) both need to work from the same builder -- it accumulates filters through
// as many .eq() calls as the caller makes and only records/resolves once actually awaited, by
// being thenable at every depth.
function updateBuilder(table: string, patch: unknown, calls: Call[], errorFor: { message: string } | null) {
  const filters: Record<string, unknown> = {};
  const builder: Any = {
    eq: (col: string, val: unknown) => {
      filters[col] = val;
      return builder;
    },
    then: (resolve: Any) => {
      calls.push({ op: "update", table, patch, filters: { ...filters } });
      resolve({ error: errorFor ?? null });
    },
  };
  return builder;
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
      update: (patch: unknown) => updateBuilder(table, patch, calls, table === "owned_skins" ? opts.revokeError ?? null : null),
    }),
    rpc: async (fn: string, params: unknown) => {
      calls.push({ op: "rpc", table: "owned_skins", fn, params });
      return { error: opts.rpcError ?? null };
    },
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
  assert.equal(calls.filter((c) => c.op === "rpc").length, 1);
});

Deno.test("an unrelated event type is acknowledged and ignored", async () => {
  const { handler, calls } = setup();
  const { result: res } = await quietly(() => post(handler, event("customer.created", {})));
  assert.equal(res.status, 200);
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------- granting

Deno.test("grants exactly one owned_skins row for a paid session, idempotently, via grant_owned_skin", async () => {
  const { handler, calls } = setup();
  const { result: res } = await quietly(() => post(handler, event("checkout.session.completed", paidSession())));
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    op: "rpc",
    table: "owned_skins",
    fn: "grant_owned_skin",
    // A Stripe retry (same session, same everything) must be a harmless no-op -- that's
    // grant_owned_skin's job now (see supabase_owned_skins_revocation.sql), not a plain upsert's.
    params: {
      p_user_id: "user-1",
      p_skin_id: "skin-a",
      p_session_id: "cs_1",
      p_amount_paid_cents: 199,
      p_currency: "usd",
    },
  });
});

Deno.test("async_payment_succeeded grants exactly like completed", async () => {
  const { handler, calls } = setup();
  const { result: res } = await quietly(() => post(handler, event("checkout.session.async_payment_succeeded", paidSession())));
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].op, "rpc");
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

Deno.test("REGRESSION: async_payment_failed never grants, even though it carries a full session", async () => {
  // The failure counterpart of async_payment_succeeded. It's deliberately unhandled, so the
  // only thing standing between it and a free skin is that its event type isn't matched --
  // and the session it carries would otherwise look grantable if someone widened that check
  // (note payment_status on a failed delayed payment need not have flipped back to "unpaid").
  const { handler, calls } = setup();
  const { result: res } = await quietly(() => post(handler, event("checkout.session.async_payment_failed", paidSession())));
  assert.equal(res.status, 200);
  assert.deepEqual(calls, []);
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
  assert.equal((calls[0].params as Any).p_amount_paid_cents, 199);
});

Deno.test("a DB error while granting returns 500 so Stripe retries", async () => {
  const { handler } = setup({ db: { rpcError: { message: "boom" } } });
  const { result: res } = await quietly(() => post(handler, event("checkout.session.completed", paidSession())));
  assert.equal(res.status, 500);
});

Deno.test("a transient DB error (any code but 23503) still returns 500 and is NOT logged as unrecoverable", async () => {
  for (const code of [undefined, "08006", "57014", "40001"]) {
    const { handler } = setup({ db: { rpcError: { message: "boom", code } } });
    const { result: res, errors } = await quietly(() => post(handler, event("checkout.session.completed", paidSession())));
    assert.equal(res.status, 500, String(code));
    assert.ok(!errors.some((e) => String(e[0]).includes("ACTION REQUIRED")), String(code));
  }
});

Deno.test("an unknown skin_id (FK violation 23503): 200 so Stripe stops retrying, ACTION REQUIRED log with the details", async () => {
  const { handler } = setup({
    db: { rpcError: { message: 'insert or update on table "owned_skins" violates foreign key constraint', code: "23503" } },
  });
  const { result: res, errors } = await quietly(() => post(handler, event("checkout.session.completed", paidSession())));
  assert.equal(res.status, 200);
  assertActionRequired(errors);
  // the log must carry enough to refund/grant by hand
  const detail = JSON.stringify(errors.find((e) => String(e[0]).includes("ACTION REQUIRED")));
  for (const needle of ["cs_1", "user-1", "skin-a", "199"]) assert.ok(detail.includes(needle), needle);
});

Deno.test("async_payment_succeeded with an unknown skin is handled the same way", async () => {
  const { handler } = setup({ db: { rpcError: { message: "fk", code: "23503" } } });
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

// Revoke helper -- tombstones (revoked_at set), never deletes (supabase_owned_skins_revocation.sql).
function revokeCalls(calls: Call[]) {
  return calls.filter((c) => c.op === "update" && c.table === "owned_skins");
}

Deno.test("REGRESSION: a full refund tombstones the skin (revoked_at set, row not deleted)", async () => {
  const { handler, calls, listCalls } = setup({ sessions: sessionsFor() });
  const { result: res } = await quietly(() => post(handler, event("charge.refunded", fullRefund())));
  assert.equal(res.status, 200);
  assert.deepEqual(listCalls, [{ payment_intent: "pi_1", limit: 1 }]);
  const revokes = revokeCalls(calls);
  assert.equal(revokes.length, 1);
  assert.deepEqual(revokes[0].filters, { user_id: "user-1", skin_id: "skin-a" });
  assert.equal(typeof (revokes[0].patch as Any).revoked_at, "string");
});

Deno.test("REGRESSION: a dispute revokes (tombstones) the skin", async () => {
  const { handler, calls } = setup({ sessions: sessionsFor() });
  const { result: res } = await quietly(() =>
    post(handler, event("charge.dispute.created", { id: "dp_1", payment_intent: "pi_1", amount: 199 }))
  );
  assert.equal(res.status, 200);
  assert.equal(revokeCalls(calls).length, 1);
});

Deno.test("a partial refund keeps the skin (no lookup, no revoke)", async () => {
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
  assert.equal(revokeCalls(calls).length, 1);
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
  assert.deepEqual(calls.filter((c) => c.op === "update" && c.table === "profiles"), [
    {
      op: "update",
      table: "profiles",
      patch: { equipped_skin_id: "pig", avatar: "P", color_filter: "none" },
      filters: { user_id: "user-1" },
    },
  ]);
});

Deno.test("revoking a skin that is NOT equipped leaves the profile alone", async () => {
  const { handler, calls } = setup({
    sessions: sessionsFor(),
    db: { select: (table) => (table === "profiles" ? { data: { equipped_skin_id: "some-other-skin" } } : { data: null }) },
  });
  await quietly(() => post(handler, event("charge.refunded", fullRefund())));
  assert.equal(calls.filter((c) => c.op === "update" && c.table === "profiles").length, 0);
  assert.equal(revokeCalls(calls).length, 1);
});

Deno.test("an expanded payment_intent object is handled like a string id", async () => {
  const { handler, calls } = setup({ sessions: sessionsFor() });
  await quietly(() => post(handler, event("charge.refunded", fullRefund({ payment_intent: { id: "pi_1" } }))));
  assert.equal(revokeCalls(calls).length, 1);
});

Deno.test("a refund with no payment_intent returns 200 and revokes nothing", async () => {
  const { handler, calls } = setup();
  const { result: res } = await quietly(() => post(handler, event("charge.refunded", fullRefund({ payment_intent: null }))));
  assert.equal(res.status, 200);
  assert.deepEqual(calls, []);
});

Deno.test("a refund whose session can't be resolved returns 200 and revokes nothing", async () => {
  const { handler, calls } = setup({ sessions: {} });
  const { result: res } = await quietly(() => post(handler, event("charge.refunded", fullRefund())));
  assert.equal(res.status, 200);
  assert.deepEqual(calls, []);
});

Deno.test("a DB error while revoking returns 500 so Stripe retries", async () => {
  const { handler } = setup({ sessions: sessionsFor(), db: { revokeError: { message: "boom" } } });
  const { result: res } = await quietly(() => post(handler, event("charge.refunded", fullRefund())));
  assert.equal(res.status, 500);
});

// ---------------------------------------------------------------- REGRESSION: revoke can't be undone by a replayed grant
//
// grant_owned_skin (supabase_owned_skins_revocation.sql) is what actually enforces this -- these
// tests only confirm the handler always calls through to it with the session id that lets it
// tell "replay of the revoked purchase" apart from "genuine repurchase." The two scenarios below
// are indistinguishable at the handler layer (both are just "a checkout.session.completed for
// user-1/skin-a arrives"); the RPC call it makes is identical in both cases by design, and it's
// the DB function's job -- covered by tests/sql -- to treat a matching vs. a different session
// id differently.

Deno.test("REGRESSION: a redelivered grant event for an already-revoked purchase still calls grant_owned_skin with that purchase's own session id (lets the DB refuse to resurrect it)", async () => {
  const { handler, calls } = setup();
  // Same session id ("cs_1", from paidSession()) as whatever originally granted skin-a --
  // exactly what a Stripe retry/redelivery of the *original* event looks like.
  await quietly(() => post(handler, event("checkout.session.completed", paidSession())));
  assert.equal(calls.length, 1);
  assert.equal((calls[0].params as Any).p_session_id, "cs_1");
  // The handler itself has no idea whether cs_1 was already revoked -- it always calls through;
  // grant_owned_skin is what's responsible for that no-op (see supabase_owned_skins_revocation.sql
  // and the SQL-level regression test for it).
});

Deno.test("REGRESSION: a genuine repurchase after a refund uses a new session id, distinguishing it from a replay", async () => {
  const { handler, calls } = setup();
  await quietly(() => post(handler, event("checkout.session.completed", paidSession({ id: "cs_2" }))));
  assert.equal(calls.length, 1);
  assert.equal((calls[0].params as Any).p_session_id, "cs_2");
});
