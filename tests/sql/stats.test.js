import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// supabase_stats_schema.sql stands alone (no dependency on the other schema files), so this
// suite applies just that file on top of what a hosted Supabase project grants by default.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const STATS_SQL = readFileSync(resolve(ROOT, 'supabase_stats_schema.sql'), 'utf8');
const INSUFFICIENT_PRIVILEGE = '42501';

let db;

async function asAnon(fn) {
  await db.exec('set role anon');
  try { return await fn(); } finally { await db.exec('reset role'); }
}
async function attempt(sql, params = []) {
  try { return { rows: (await db.query(sql, params)).rows }; } catch (e) { return { code: e.code, message: e.message }; }
}
const log = (kind, level, ref) => asAnon(() => attempt('select public.log_event($1, $2, $3)', [kind, level, ref]));
const stats = async (days = 30) => (await asAnon(() => db.query('select public.get_stats($1) as s', [days]))).rows[0].s;
const count = async () => (await db.query('select count(*)::int as n from public.events')).rows[0].n;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    grant usage on schema public to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on sequences to anon, authenticated;
    alter default privileges in schema public grant all on functions to anon, authenticated;
  `);
  await db.exec(STATS_SQL);
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

  it('PUBLIC holds no EXECUTE; anon and authenticated do', async () => {
    const { rows } = await db.query(`
      select p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') as authed,
             exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0) as public_exec
      from pg_proc p where p.proname in ('log_event', 'get_stats') order by 1`);
    expect(rows).toEqual([
      { proname: 'get_stats', anon: true, authed: true, public_exec: false },
      { proname: 'log_event', anon: true, authed: true, public_exec: false },
    ]);
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
