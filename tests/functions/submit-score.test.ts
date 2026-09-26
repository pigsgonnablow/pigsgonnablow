// Run with: deno test --no-check tests/functions/   (or `npm run test:fn`)
// Everything external is faked -- no Supabase project is touched. The handler under test is
// supabase/functions/submit-score/handler.ts; index.ts only wires the real service-role client
// and a real (Web Crypto) hasher into it.
import assert from "node:assert/strict";
import { CORS_HEADERS, createHandler } from "../../supabase/functions/submit-score/handler.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

interface Setup {
  rpcError?: Any; // what supabaseAdmin.rpc('submit_anonymous_score', ...) resolves with as its error
  hashIp?: (ip: string | null) => Promise<string | null>;
}

function setup(o: Setup = {}) {
  const rpcCalls: { name: string; args: Any }[] = [];
  const hashedIps: (string | null)[] = [];

  const supabaseAdmin = {
    rpc: async (name: string, args: Any) => {
      rpcCalls.push({ name, args });
      return { data: null, error: o.rpcError ?? null };
    },
  };

  const hashIp = o.hashIp ?? (async (ip: string | null) => {
    hashedIps.push(ip);
    return ip ? `hash(${ip})` : null;
  });

  const handler = createHandler({ supabaseAdmin: supabaseAdmin as Any, hashIp });
  return { handler, rpcCalls, hashedIps };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://x.supabase.co/functions/v1/submit-score", {
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

Deno.test("OPTIONS preflight: 200 with the CORS headers, no RPC call", async () => {
  const t = setup();
  const res = await t.handler(new Request("https://x/", { method: "OPTIONS" }));
  assert.equal(res.status, 200);
  assertCors(res);
  assert.equal(await res.text(), "");
  assert.equal(t.rpcCalls.length, 0);
});

Deno.test("rejects non-POST, non-OPTIONS methods", async () => {
  const t = setup();
  const res = await t.handler(new Request("https://x/", { method: "GET" }));
  assert.equal(res.status, 405);
  assert.equal(t.rpcCalls.length, 0);
});

Deno.test("happy path: calls submit_anonymous_score with the name, score, and a hashed IP", async () => {
  const t = setup();
  const res = await t.handler(post({ name: "Bob", score: 420 }, { "x-forwarded-for": "203.0.113.5" }));
  assert.equal(res.status, 200);
  assertCors(res);
  assert.deepEqual(await json(res), { ok: true });
  assert.deepEqual(t.rpcCalls, [{
    name: "submit_anonymous_score",
    args: { p_name: "Bob", p_score: 420, p_ip_hash: "hash(203.0.113.5)" },
  }]);
  assert.deepEqual(t.hashedIps, ["203.0.113.5"]);
});

Deno.test("x-forwarded-for: takes the LAST entry (the real client IP), not the first (client-spoofable)", async () => {
  // A caller can set any value it likes for the earliest hops in this header (or the whole
  // header, before it reaches Supabase's fronting proxy) -- only the proxy-appended last entry
  // is trustworthy. Taking the first entry would let a caller pick a fresh fake IP on every
  // request and never be rate-limited at all -- see the extractClientIp comment in handler.ts.
  const t = setup();
  await t.handler(post({ name: "Bob", score: 1 }, { "x-forwarded-for": "1.2.3.4, 10.0.0.1, 203.0.113.9" }));
  assert.deepEqual(t.hashedIps, ["203.0.113.9"]);
});

Deno.test("falls back to cf-connecting-ip, then x-real-ip, when x-forwarded-for is absent", async () => {
  const t1 = setup();
  await t1.handler(post({ name: "Bob", score: 1 }, { "cf-connecting-ip": "203.0.113.9" }));
  assert.deepEqual(t1.hashedIps, ["203.0.113.9"]);

  const t2 = setup();
  await t2.handler(post({ name: "Bob", score: 1 }, { "x-real-ip": "203.0.113.10" }));
  assert.deepEqual(t2.hashedIps, ["203.0.113.10"]);
});

Deno.test("no usable IP header at all: still submits, with a null ip_hash (falls back to the global-only budget)", async () => {
  const t = setup();
  const res = await t.handler(post({ name: "Bob", score: 1 }));
  assert.equal(res.status, 200);
  assert.equal(t.rpcCalls[0].args.p_ip_hash, null);
  assert.deepEqual(t.hashedIps, [null]);
});

Deno.test("rejects a non-JSON body", async () => {
  const t = setup();
  const res = await t.handler(post("not json"));
  assert.equal(res.status, 400);
  assert.equal(t.rpcCalls.length, 0);
});

Deno.test("rejects a missing/wrong-typed name or score before ever calling the RPC", async () => {
  for (const body of [{ score: 1 }, { name: "Bob" }, { name: 1, score: 1 }, { name: "Bob", score: "1" }, null, []]) {
    const t = setup();
    const res = await t.handler(post(body));
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(t.rpcCalls.length, 0, JSON.stringify(body));
  }
});

Deno.test("a rate-limit error from the RPC surfaces as 429 with the RPC's own message", async () => {
  const t = setup({ rpcError: { message: "too many score submissions from this connection -- please try again in a minute" } });
  const res = await t.handler(post({ name: "Bob", score: 1 }));
  assert.equal(res.status, 429);
  assert.deepEqual(await json(res), { error: "too many score submissions from this connection -- please try again in a minute" });
});

Deno.test("a validation error from the RPC surfaces as 400, not 429", async () => {
  const t = setup({ rpcError: { message: "invalid score" } });
  const res = await t.handler(post({ name: "Bob", score: 1 }));
  assert.equal(res.status, 400);
  assert.deepEqual(await json(res), { error: "invalid score" });
});

Deno.test("an unexpected throw (e.g. the hasher itself failing) is a 500, not a leaked stack trace", async () => {
  const t = setup({ hashIp: async () => { throw new Error("boom"); } });
  const res = await t.handler(post({ name: "Bob", score: 1 }));
  assert.equal(res.status, 500);
  const body = await json(res);
  assert.equal(body.error, "Couldn't submit right now.");
});
