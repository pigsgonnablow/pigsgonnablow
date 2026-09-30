import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// get_stats() also reads owned_skins, scores and auth.users, so this suite applies every schema
// file in order (same list and order as lockdown.test.js) on top of a stand-in for what a hosted
// Supabase project provides.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCHEMA_FILES = [
  'supabase_scores_schema.sql',
  'supabase_accounts_schema.sql',
  'supabase_avatars_schema.sql',
  'supabase_skins_schema.sql',
  'supabase_skin_color_filter_schema.sql',
  'supabase_leaderboard_color_filter_schema.sql',
  'supabase_purchase_audit_schema.sql',
  'supabase_remove_griffin_schema.sql',
  'supabase_lockdown_direct_writes.sql',
  'supabase_owned_skins_revocation.sql',
  'supabase_scores_rate_limit_by_ip.sql',
  'supabase_skin_descriptions_schema.sql',
  'supabase_stats_schema.sql',
  'supabase_stats_private.sql',
];
const sqlOf = (f) => readFileSync(resolve(ROOT, f), 'utf8');
const STATS_SQL = sqlOf('supabase_stats_schema.sql');
const INSUFFICIENT_PRIVILEGE = '42501';
const U1 = '11111111-1111-1111-1111-111111111111';
const U2 = '22222222-2222-2222-2222-222222222222';

let db;

async function asAnon(fn) {
  await db.exec('set role anon');
  try { return await fn(); } finally { await db.exec('reset role'); }
}
async function attempt(sql, params = []) {
  try { return { rows: (await db.query(sql, params)).rows }; } catch (e) { return { code: e.code, message: e.message }; }
}
const log = (kind, level, ref, device = 'desktop', score = null, seconds = null) =>
  asAnon(() => attempt('select public.log_event($1, $2, $3, $4, $5, $6)', [kind, level, ref, device, score, seconds]));
// Aggregates are read as the owner here; how a client gets at them (read_stats + password) has
// its own tests below.
const stats = async (days = 30) => (await db.query('select public.get_stats($1) as s', [days])).rows[0].s;
const readStats = async (password, days = 30) =>
  (await asAnon(() => db.query('select public.read_stats($1, $2) as s', [password, days]))).rows[0].s;
const count = async () => (await db.query('select count(*)::int as n from public.events')).rows[0].n;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key, email text, created_at timestamptz not null default now());
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    grant usage on schema auth to anon, authenticated;
    grant usage on schema public to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on sequences to anon, authenticated;
    alter default privileges in schema public grant all on functions to anon, authenticated;
    insert into auth.users (id, email, created_at) values
      ('${U1}', 'u1@example.test', now()),
      ('${U2}', 'u2@example.test', now() - interval '400 days');
  `);
  for (const f of SCHEMA_FILES) await db.exec(sqlOf(f));
}, 120_000);
afterAll(async () => { await db?.close(); });

describe('supabase_stats_schema.sql', () => {
  it('is safe to re-run', async () => {
    await expect(db.exec(STATS_SQL)).resolves.not.toThrow();
  });

  it('anon cannot read or write events directly', async () => {
    for (const sql of [
      'select * from public.events',
      "insert into public.events (kind) values ('visit')",
      'delete from public.events',
    ]) {
      const r = await asAnon(() => attempt(sql));
      expect(r.code, sql).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  it('log_event records a valid event, clamping level and normalising ref', async () => {
    const before = await count();
    expect((await log('game_over', 5000, 'Reddit.com')).code).toBeUndefined();
    const { rows } = await db.query('select kind, level, ref from public.events order by id desc limit 1');
    expect(rows[0]).toEqual({ kind: 'game_over', level: 999, ref: 'reddit.com' });
    expect(await count()).toBe(before + 1);
  });

  it('log_event silently drops an unknown kind, and falls back to "direct" for a junk ref', async () => {
    const before = await count();
    expect((await log('drop_table', 1, 'x')).code).toBeUndefined();
    expect(await count()).toBe(before);
    await log('visit', 0, '<script>alert(1)</script>');
    const { rows } = await db.query('select ref from public.events order by id desc limit 1');
    expect(rows[0].ref).toBe('direct');
  });

  it('get_stats returns aggregates only, zero-filled per day', async () => {
    await log('visit', 0, 'bsky.app');
    await log('visit', 0, 'bsky.app');
    await log('game_start', 0, 'bsky.app');
    await log('quit', 3, 'bsky.app');
    const s = await stats(7);
    expect(s.days).toBe(7);
    expect(s.daily).toHaveLength(7);
    expect(s.daily.every((d) => Object.keys(d).sort().join() === 'day,game_over,game_start,victory,visit')).toBe(true);
    expect(s.totals.visit).toBe(3); // two bsky.app + the junk-ref one above
    expect(s.refs[0]).toEqual({ ref: 'bsky.app', visits: 2 });
    expect(s.levels).toEqual(expect.arrayContaining([{ level: 3, runs: 1 }, { level: 999, runs: 1 }]));
    expect(JSON.stringify(s)).not.toContain('"id"');
  });

  it('get_stats clamps the window to 1..365 days', async () => {
    expect((await stats(0)).days).toBe(1);
    expect((await stats(10_000)).days).toBe(365);
  });

  it('only log_event and read_stats are callable by clients; get_stats and set_stats_password are not', async () => {
    const { rows } = await db.query(`
      select p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') as authed,
             exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0) as public_exec
      from pg_proc p where p.proname in ('log_event', 'get_stats', 'read_stats', 'set_stats_password') order by 1`);
    expect(rows).toEqual([
      { proname: 'get_stats', anon: false, authed: false, public_exec: false },
      { proname: 'log_event', anon: true, authed: true, public_exec: false },
      { proname: 'read_stats', anon: true, authed: true, public_exec: false },
      { proname: 'set_stats_password', anon: false, authed: false, public_exec: false },
    ]);
  });

  it('REGRESSION: anon calling get_stats directly is denied (it used to be public)', async () => {
    const r = await asAnon(() => attempt('select public.get_stats(30)'));
    expect(r.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('anon cannot touch the private schema at all', async () => {
    for (const sql of ["select private.set_stats_password('a-long-enough-password')", 'select * from private.stats_access']) {
      const r = await asAnon(() => attempt(sql));
      expect(r.code, sql).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  describe('read_stats', () => {
    it('answers no_password_set until the owner sets one', async () => {
      expect(await readStats('anything at all')).toEqual({ error: 'no_password_set' });
    });

    it('set_stats_password refuses a short password', async () => {
      await expect(db.query("select private.set_stats_password('short')")).rejects.toThrow(/12 characters/);
    });

    it('stores only a hash, and returns the aggregates for the right password', async () => {
      await db.query("select private.set_stats_password('correct horse battery')");
      const { rows } = await db.query('select key_hash from private.stats_access');
      expect(rows[0].key_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0].key_hash).not.toContain('horse');
      const s = await readStats('correct horse battery', 7);
      expect(s.days).toBe(7);
      expect(s.daily).toHaveLength(7);
    });

    it('a wrong or missing password gets an error, not data', async () => {
      expect(await readStats('wrong guess')).toEqual({ error: 'wrong_password' });
      expect(await readStats(null)).toEqual({ error: 'wrong_password' });
    });

    it('10 wrong guesses in 10 minutes lock it, even for the right password; resetting the password clears it', async () => {
      await db.exec('delete from private.stats_access_failures');
      for (let i = 0; i < 10; i++) expect(await readStats(`guess ${i}`)).toEqual({ error: 'wrong_password' });
      expect(await readStats('correct horse battery')).toEqual({ error: 'locked' });
      await db.query("select private.set_stats_password('correct horse battery')");
      expect((await readStats('correct horse battery')).error).toBeUndefined();
    });
  });

  it('log_event stores device, score and seconds, and nulls out anything out of range', async () => {
    await log('game_over', 4, 'direct', 'mobile', 1234, 95);
    await log('game_over', 2, 'direct', 'toaster', -5, 999999);
    const { rows } = await db.query('select device, score, seconds from public.events order by id desc limit 2');
    expect(rows).toEqual([
      { device: 'unknown', score: null, seconds: null },
      { device: 'mobile', score: 1234, seconds: 95 },
    ]);
  });

  it('the narrower draft log_event(text, integer, text) overload does not exist', async () => {
    const { rows } = await db.query("select count(*)::int as n from pg_proc where proname = 'log_event'");
    expect(rows[0].n).toBe(1);
  });

  it('get_stats reports devices, run lengths and run medians', async () => {
    await log('visit', 0, 'direct', 'mobile');
    await log('quit', 1, 'direct', 'mobile', 50, 20);
    await log('game_over', 6, 'direct', 'desktop', 900, 200);
    const s = await stats(7);
    const devices = Object.fromEntries(s.devices.map((d) => [d.device, d.visits]));
    expect(devices.mobile).toBeGreaterThanOrEqual(1);
    expect(s.run_lengths.map((b) => b.bucket)).toEqual(['Under 30s', '30s to 1 min', '1 to 2 min', '2 to 5 min', '5 min or more']);
    expect(s.run_lengths[0].runs).toBeGreaterThanOrEqual(1); // the 20s quit
    expect(s.run_lengths[3].runs).toBeGreaterThanOrEqual(1); // the 200s game over
    expect(s.runs.count).toBeGreaterThanOrEqual(3);
    expect(s.runs.best_score).toBe(1234);
    expect(typeof s.runs.median_seconds).toBe('number');
  });

  it('get_stats counts real, unrefunded purchases, new accounts and leaderboard entries', async () => {
    await db.exec(`
      insert into public.owned_skins (user_id, skin_id, stripe_checkout_session_id, amount_paid_cents, currency)
        values ('${U1}', 'dragon-red', 'cs_1', 199, 'usd');
      insert into public.owned_skins (user_id, skin_id, stripe_checkout_session_id, amount_paid_cents, currency, revoked_at)
        values ('${U2}', 'dragon-red', 'cs_2', 199, 'usd', now());
      insert into public.scores (name, score) values ('Tester', 10);
    `);
    const s = await stats(30);
    expect(s.purchases).toEqual({ count: 1, revenue_cents: 199, all_time_count: 1, all_time_revenue_cents: 199 });
    expect(s.accounts).toEqual({ new: 1, total: 2 });
    expect(s.leaderboard_entries).toBeGreaterThanOrEqual(1);
  });

  it('a flood is capped at 300 rows per minute, without erroring the caller', async () => {
    await db.exec('delete from public.events');
    for (let i = 0; i < 305; i++) {
      const r = await log('visit', 0, 'flood');
      expect(r.code).toBeUndefined();
    }
    expect(await count()).toBe(300);
  });
});
