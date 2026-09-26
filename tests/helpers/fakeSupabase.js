// A hand-rolled stand-in for the slice of supabase-js the js/*.js modules use. Not a
// general mock: it supports exactly the chains those modules call
//   from(t).select().eq().order().limit()        (awaited directly -- the builder is a thenable)
//   from(t).select().eq().is().maybeSingle()
//   from(t).select().eq().maybeSingle()
//   from(t).insert(row)
//   rpc(name, args)
//   functions.invoke(name, opts)
//   auth.getSession / onAuthStateChange / signInWithOtp / signOut
// and records every call so tests can assert on what was (and, just as importantly, was NOT)
// sent -- e.g. that a signed-in score submit never does a direct insert.
//
// `results` shape:
//   tables:    { [table]: { select?, insert?, upsert? } }   each a result object OR a function(query) -> result/promise
//   rpc:       { [name]: result | function(args) }
//   functions: { [name]: result | function(opts) }
//   auth:      { getSession?, signInWithOtp?, signOut? }
// A missing entry resolves to { data: null, error: null } (select on a table defaults to []).

const resolve = (v, arg) => (typeof v === 'function' ? v(arg) : v);

export function createFakeSupabase(results = {}) {
  const log = { queries: [], inserts: [], upserts: [], rpcs: [], invokes: [], authCalls: [] };
  const authListeners = [];

  function from(table) {
    const q = { table, op: 'select', filters: [], columns: null, row: null };
    const handlers = () => (results.tables && results.tables[table]) || {};

    function exec() {
      log.queries.push(q);
      const h = handlers()[q.op];
      const fallback = q.op === 'select' ? { data: [], error: null } : { data: null, error: null };
      return Promise.resolve(h === undefined ? fallback : resolve(h, q));
    }

    const builder = {
      select(cols) { q.columns = cols; return builder; },
      eq(col, val) { q.filters.push([col, val]); return builder; },
      is(col, val) { q.filters.push([col, val]); return builder; },
      order() { return builder; },
      limit() { return builder; },
      insert(row) { q.op = 'insert'; q.row = row; log.inserts.push({ table, row }); return builder; },
      upsert(row, opts) { q.op = 'upsert'; q.row = row; log.upserts.push({ table, row, opts }); return builder; },
      maybeSingle() { return exec(); },
      then(onFulfilled, onRejected) { return exec().then(onFulfilled, onRejected); },
    };
    return builder;
  }

  const client = {
    from,
    rpc(name, args) {
      log.rpcs.push({ name, args });
      const r = results.rpc && results.rpc[name];
      return Promise.resolve(r === undefined ? { data: null, error: null } : resolve(r, args));
    },
    functions: {
      invoke(name, opts) {
        log.invokes.push({ name, opts });
        const r = results.functions && results.functions[name];
        return Promise.resolve(r === undefined ? { data: null, error: null } : resolve(r, opts));
      },
    },
    auth: {
      async getSession() {
        log.authCalls.push('getSession');
        const r = results.auth && results.auth.getSession;
        return r === undefined ? { data: { session: null }, error: null } : resolve(r);
      },
      onAuthStateChange(cb) {
        authListeners.push(cb);
        return { data: { subscription: { unsubscribe() {} } } };
      },
      async signInWithOtp(args) {
        log.authCalls.push(['signInWithOtp', args]);
        const r = results.auth && results.auth.signInWithOtp;
        return r === undefined ? { error: null } : resolve(r, args);
      },
      async signOut() { log.authCalls.push('signOut'); return { error: null }; },
    },
  };

  return {
    client,
    log,
    // Simulates Supabase firing onAuthStateChange (e.g. after the magic link is clicked).
    emitAuthChange: (event, session) => Promise.all(authListeners.map((cb) => cb(event, session))),
  };
}

// A deferred promise -- lets a test hold a fetch open and release it out of order.
export function deferred() {
  let resolveFn;
  const promise = new Promise((res) => { resolveFn = res; });
  return { promise, resolve: resolveFn };
}

// Let queued microtasks/timers (the modules' un-awaited render() calls) settle.
export const flush = () => new Promise((r) => setTimeout(r, 0));

export const SESSION = { user: { id: 'user-1' } };
