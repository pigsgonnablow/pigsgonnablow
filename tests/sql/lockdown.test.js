// Runs the repo's real supabase_*.sql files, in order, against an in-process Postgres
// (PGlite, no Docker) and then attacks the result as `anon` / `authenticated` -- the two roles
// a raw PostgREST call arrives as. This is the class of bug that reading the SQL can't catch:
// `revoke ... from public` looked right and still left `anon` able to call the RPCs.
//
// What is faked, and why it's a fair stand-in for a hosted Supabase project:
//   - roles anon / authenticated, and an `auth` schema with users + auth.uid() (reads the same
//     request.jwt.claims setting PostgREST sets);
//   - Supabase's default privileges on the public schema (broad grants to anon/authenticated on
//     every new table and function) -- the very thing the lockdown file has to undo.
// Not covered: PostgREST itself, and the service_role/webhook path.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// The order documented in each file's header / the CHANGELOG. lockdown must run last.
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
];
const sqlOf = (f) => readFileSync(resolve(ROOT, f), 'utf8');

const U1 = '11111111-1111-1111-1111-111111111111';
const U2 = '22222222-2222-2222-2222-222222222222';
const INSUFFICIENT_PRIVILEGE = '42501';

let db;

async function freshDb(files = SCHEMA_FILES) {
  const d = new PGlite();
  await d.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(coalesce(
        nullif(current_setting('request.jwt.claim.sub', true), ''),
        (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
      ), '')::uuid
    $$;
    grant usage on schema auth to anon, authenticated;
    grant usage on schema public to anon, authenticated;
    -- what a hosted Supabase project does out of the box:
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on sequences to anon, authenticated;
    alter default privileges in schema public grant all on functions to anon, authenticated;
    insert into auth.users (id, email) values ('${U1}', 'u1@example.test'), ('${U2}', 'u2@example.test');
  `);
  for (const f of files) await d.exec(sqlOf(f));
  return d;
}

// Run `fn` as a role with a faked JWT subject (null = no JWT), always restoring afterwards.
async function as(role, uid, fn) {
  await db.query("select set_config('request.jwt.claims', $1, false)", [uid ? JSON.stringify({ sub: uid, role }) : '']);
  await db.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claims', '', false)");
  }
}

// Resolves to { rows } or { code, message } instead of throwing, so tests can assert on either.
async function attempt(sql, params = []) {
  try {
    const r = await db.query(sql, params);
    return { rows: r.rows };
  } catch (e) {
    return { code: e.code, message: e.message };
  }
}

const one = async (sql, params) => (await db.query(sql, params)).rows[0];

beforeAll(async () => { db = await freshDb(); }, 120_000);
afterAll(async () => { await db?.close(); });

describe('the schema files', () => {
  it('apply cleanly, in order, on an empty database (the lockdown file has an ordering hazard)', () => {
    expect(db).toBeTruthy(); // beforeAll would have thrown otherwise
  });

  it('the lockdown file is safe to re-run', async () => {
    await expect(db.exec(sqlOf('supabase_lockdown_direct_writes.sql'))).resolves.not.toThrow();
  });

  it('REGRESSION: on a fresh database the grants at the END of the lockdown file really land', async () => {
    // (The bug: revokes placed before the functions existed error out, and a script that
    // stopped there would leave the default EXECUTE grants on the freshly created functions.)
    for (const fn of ['set_display_name(text)', 'submit_personal_best(integer)', 'equip_skin(text)']) {
      const r = await one('select has_function_privilege($1, $2, $3) as anon, has_function_privilege($4, $2, $3) as authed',
        ['anon', `public.${fn}`, 'EXECUTE', 'authenticated']);
      expect(r, fn).toEqual({ anon: false, authed: true });
    }
  });
});

describe('RPC execute privileges', () => {
  it.each([
    ["select public.set_display_name('x')"],
    ['select public.submit_personal_best(1)'],
    ["select public.equip_skin('dragon-default')"],
  ])('REGRESSION: anon calling %s is denied at the privilege layer', async (sql) => {
    const r = await as('anon', null, () => attempt(sql));
    expect(r.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('PUBLIC holds no EXECUTE on any of them', async () => {
    const r = await one(`
      select count(*)::int as n
      from pg_proc p, lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.pronamespace = 'public'::regnamespace
        and p.proname in ('set_display_name', 'submit_personal_best', 'equip_skin')
        and a.grantee = 0 and a.privilege_type = 'EXECUTE'`);
    expect(r.n).toBe(0);
  });

  it('all three are SECURITY DEFINER with a pinned search_path incl. pg_temp', async () => {
    const r = await db.query(`select proname, prosecdef, proconfig from pg_proc
      where pronamespace = 'public'::regnamespace
        and proname in ('set_display_name', 'submit_personal_best', 'equip_skin') order by 1`);
    expect(r.rows).toHaveLength(3);
    for (const row of r.rows) {
      expect(row.prosecdef, row.proname).toBe(true);
      expect(row.proconfig, row.proname).toContain('search_path=public, pg_temp');
    }
  });
});

describe('REGRESSION: direct writes to profiles are impossible (free-skin escalation)', () => {
  it('authenticated cannot INSERT a profile (first-sign-in path the first fix missed)', async () => {
    const r = await as('authenticated', U2, () =>
      attempt(`insert into public.profiles (user_id, display_name, equipped_skin_id) values ($1, 'Evil', 'dragon-red')`, [U2]));
    expect(r.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('authenticated cannot UPDATE equipped_skin_id / avatar / color_filter on their own row', async () => {
    await as('authenticated', U1, () => db.query("select public.set_display_name('Alice')")); // gives U1 a real row
    for (const set of ["equipped_skin_id = 'dragon-red'", "avatar = 'X'", "color_filter = 'x'", "display_name = 'hack'"]) {
      const r = await as('authenticated', U1, () => attempt(`update public.profiles set ${set} where user_id = $1`, [U1]));
      expect(r.code, set).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  it('a raw upsert (what the old client setDisplayName sent) is denied', async () => {
    const r = await as('authenticated', U1, () =>
      attempt(`insert into public.profiles (user_id, display_name) values ($1, 'x')
               on conflict (user_id) do update set user_id = excluded.user_id, display_name = excluded.display_name`, [U1]));
    expect(r.code).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

describe('REGRESSION: leaderboard rows can only carry name + score from a client (stored XSS)', () => {
  it('anon can insert a plain guest score', async () => {
    const r = await as('anon', null, () => attempt(`insert into public.scores (name, score) values ('Guest', 42)`));
    expect(r.code).toBeUndefined();
  });

  it.each(['avatar', 'color_filter', 'user_id'])('anon cannot set scores.%s', async (col) => {
    const value = col === 'user_id' ? `'${U1}'` : `'"><img src=x onerror=alert(1)>'`;
    const r = await as('anon', null, () => attempt(`insert into public.scores (name, score, ${col}) values ('Evil', 1, ${value})`));
    expect(r.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('anon cannot UPDATE any score', async () => {
    const r = await as('anon', null, () => attempt(`update public.scores set score = 999999 where name = 'Guest'`));
    expect(r.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('authenticated cannot write scores directly (only via submit_personal_best)', async () => {
    const ins = await as('authenticated', U1, () => attempt(`insert into public.scores (user_id, name, score, avatar) values ($1, 'Alice', 5, 'X')`, [U1]));
    expect(ins.code).toBe(INSUFFICIENT_PRIVILEGE);
    const upd = await as('authenticated', U1, () => attempt(`update public.scores set avatar = '<b>' where user_id = $1`, [U1]));
    expect(upd.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('the leaderboard stays publicly readable', async () => {
    const r = await as('anon', null, () => attempt('select name, score from public.scores'));
    expect(r.rows.map((x) => x.name)).toContain('Guest');
  });

  it('the dead scores_own_insert / scores_own_update policies are gone', async () => {
    const r = await one(`select count(*)::int as n from pg_policies
      where schemaname = 'public' and tablename = 'scores' and policyname in ('scores_own_insert', 'scores_own_update')`);
    expect(r.n).toBe(0);
  });
});

describe('owned_skins', () => {
  it('a client cannot grant themselves a skin (no write policy, so RLS rejects the row)', async () => {
    const r = await as('authenticated', U1, () =>
      attempt(`insert into public.owned_skins (user_id, skin_id) values ($1, 'dragon-red')`, [U1]));
    expect(r.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('has no INSERT/UPDATE/DELETE/ALL policy at all', async () => {
    const r = await one(`select count(*)::int as n from pg_policies
      where schemaname = 'public' and tablename = 'owned_skins' and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')`);
    expect(r.n).toBe(0);
  });
});

describe('RPC behaviour', () => {
  const call = (uid, sql, params) => as('authenticated', uid, () => attempt(sql, params));

  it.each([
    ["select public.set_display_name('x')"],
    ['select public.submit_personal_best(1)'],
    ["select public.equip_skin('dragon-default')"],
  ])('%s raises "not signed in" with no auth.uid()', async (sql) => {
    const r = await call(null, sql);
    expect(r.message).toContain('not signed in');
  });

  describe('set_display_name', () => {
    it.each(['', 'thirteen-char'])('rejects %j', async (name) => {
      const r = await call(U2, 'select public.set_display_name($1)', [name]);
      expect(r.message).toContain('display name must be 1-12 characters');
    });

    it('creates the first profile keyed to auth.uid(), and never touches anyone else', async () => {
      expect((await call(U2, "select public.set_display_name('Bob')")).code).toBeUndefined();
      const rows = (await db.query('select user_id, display_name from public.profiles order by display_name')).rows;
      expect(rows).toEqual([{ user_id: U1, display_name: 'Alice' }, { user_id: U2, display_name: 'Bob' }]);
    });

    it('renaming updates only the caller\'s row', async () => {
      await call(U2, "select public.set_display_name('Robert')");
      expect((await one('select display_name from public.profiles where user_id = $1', [U1])).display_name).toBe('Alice');
      expect((await one('select display_name from public.profiles where user_id = $1', [U2])).display_name).toBe('Robert');
    });
  });

  describe('equip_skin', () => {
    const equipped = async (uid) => (await one('select equipped_skin_id, avatar, color_filter from public.profiles where user_id = $1', [uid]));

    it('REGRESSION: refuses a priced skin the caller does not own, leaving the profile untouched', async () => {
      const before = await equipped(U1);
      const r = await call(U1, "select public.equip_skin('dragon-red')");
      expect(r.message).toContain('skin not owned');
      expect(await equipped(U1)).toEqual(before);
    });

    it('refuses an unknown skin', async () => {
      expect((await call(U1, "select public.equip_skin('no-such-skin')")).message).toContain('unknown or inactive skin');
    });

    it('refuses an inactive skin even for an owner (griffin was retired)', async () => {
      await db.query("insert into public.owned_skins (user_id, skin_id) values ($1, 'griffin')", [U1]);
      expect((await call(U1, "select public.equip_skin('griffin')")).message).toContain('unknown or inactive skin');
    });

    it("can't equip a skin someone ELSE owns", async () => {
      await db.query("insert into public.owned_skins (user_id, skin_id) values ($1, 'dragon-red')", [U1]);
      expect((await call(U2, "select public.equip_skin('dragon-red')")).message).toContain('skin not owned');
    });

    it('equips an owned skin, copying avatar/color_filter from the catalog (never from the client)', async () => {
      expect((await call(U1, "select public.equip_skin('dragon-red')")).code).toBeUndefined();
      const skin = await one("select emoji, color_filter from public.skins where id = 'dragon-red'");
      expect(await equipped(U1)).toEqual({ equipped_skin_id: 'dragon-red', avatar: skin.emoji, color_filter: skin.color_filter });
    });

    it('the free default skin can always be re-equipped', async () => {
      expect((await call(U1, "select public.equip_skin('dragon-default')")).code).toBeUndefined();
      expect((await equipped(U1)).equipped_skin_id).toBe('dragon-default');
    });
  });

  describe('submit_personal_best', () => {
    const scoreOf = async (uid) => (await one('select * from public.scores where user_id = $1', [uid]));
    const submit = async (uid, n) => (await call(uid, 'select public.submit_personal_best($1) as r', [n]));

    it('needs a profile', async () => {
      await db.query("insert into auth.users (id, email) values ('33333333-3333-3333-3333-333333333333', 'u3@example.test')");
      const r = await submit('33333333-3333-3333-3333-333333333333', 10);
      expect(r.message).toContain('no profile found for this account');
    });

    it('stores a first score and returns it', async () => {
      expect((await submit(U1, 500)).rows[0].r).toBe(500);
    });

    it('a lower score returns NULL and never overwrites the best', async () => {
      expect((await submit(U1, 200)).rows[0].r).toBeNull();
      expect((await scoreOf(U1)).score).toBe(500);
    });

    it('a higher score replaces it', async () => {
      expect((await submit(U1, 900)).rows[0].r).toBe(900);
      expect((await scoreOf(U1)).score).toBe(900);
    });

    it("copies name/avatar/color_filter from the caller's own profile and keys the row to auth.uid()", async () => {
      const row = await scoreOf(U1);
      const prof = await one('select display_name, avatar, color_filter from public.profiles where user_id = $1', [U1]);
      expect({ name: row.name, avatar: row.avatar, color_filter: row.color_filter }).toEqual(
        { name: prof.display_name, avatar: prof.avatar, color_filter: prof.color_filter });
      expect(row.user_id).toBe(U1);
    });

    it("one user's score can't land on another user's row", async () => {
      await submit(U2, 77);
      expect((await scoreOf(U2)).score).toBe(77);
      expect((await scoreOf(U1)).score).toBe(900);
    });

    it('rejects an out-of-range score (check constraint)', async () => {
      const r = await submit(U2, 2_000_000);
      expect(r.message).toMatch(/violates check constraint|scores_score_check/);
    });

    it('REGRESSION: an account never accumulates more than one row, however many runs it submits', async () => {
      // The ON CONFLICT (user_id) upsert is what keeps one row per account. It silently
      // stopped matching once (a *partial* unique index can't be inferred by ON CONFLICT
      // unless its WHERE clause is repeated there), which made every submit fail -- but the
      // same class of mistake the other way round would quietly append a row per run and
      // flood the board with duplicates, which is exactly what accounts were added to stop.
      for (const n of [1, 950, 20, 1000]) await submit(U1, n);
      const r = await one('select count(*)::int as n from public.scores where user_id = $1', [U1]);
      expect(r.n).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------------------
// Read-side RLS. The write side is attacked above; these cover what a raw PostgREST GET can
// *see*, which no amount of reading the client code can tell you: `anon` holds the
// publishable key baked into index.html, so every select policy here is public-facing.
// ---------------------------------------------------------------------------------------
describe('read isolation', () => {
  it("authenticated cannot read anyone else's profile (profiles_select_own)", async () => {
    const mine = await as('authenticated', U2, () => attempt('select user_id from public.profiles'));
    expect(mine.rows.map((r) => r.user_id)).toEqual([U2]); // U1's row exists but is invisible
  });

  it('anon cannot read profiles at all', async () => {
    const r = await as('anon', null, () => attempt('select * from public.profiles'));
    expect(r.rows).toEqual([]);
  });

  it('REGRESSION: an account cannot see what anyone else owns (owned_skins_select_own)', async () => {
    const u1 = await as('authenticated', U1, () => attempt('select skin_id from public.owned_skins'));
    expect(u1.rows.map((r) => r.skin_id).sort()).toEqual(['dragon-red', 'griffin']);
    const u2 = await as('authenticated', U2, () => attempt('select skin_id from public.owned_skins'));
    expect(u2.rows).toEqual([]);
    const anon = await as('anon', null, () => attempt('select skin_id from public.owned_skins'));
    expect(anon.rows).toEqual([]);
  });

  it('the skins catalog stays readable signed out (the shop renders before sign-in)', async () => {
    const r = await as('anon', null, () => attempt("select id from public.skins where id = 'dragon-red'"));
    expect(r.rows).toEqual([{ id: 'dragon-red' }]);
  });
});

describe('REGRESSION: the skins catalog is read-only to clients (free-skin escalation via price)', () => {
  // equip_skin only demands ownership when price_cents > 0 -- so a client able to write the
  // catalog could set a paid skin's price to 0 and equip it for nothing, without ever
  // touching profiles or owned_skins (the two tables the lockdown file concentrates on).
  const priceOfRed = async () => (await one("select price_cents, active from public.skins where id = 'dragon-red'"));

  it('authenticated cannot UPDATE a price down to free', async () => {
    const before = await priceOfRed();
    expect(before.price_cents).toBeGreaterThan(0);
    await as('authenticated', U2, () => attempt("update public.skins set price_cents = 0 where id = 'dragon-red'"));
    expect(await priceOfRed()).toEqual(before);
    // ...and equipping it is still refused for a non-owner
    const r = await as('authenticated', U2, () => attempt("select public.equip_skin('dragon-red')"));
    expect(r.message).toContain('skin not owned');
  });

  it('authenticated cannot INSERT a free clone of a paid skin', async () => {
    const r = await as('authenticated', U2, () =>
      attempt(`insert into public.skins (id, name, kind, emoji, price_cents) values ('free-red', 'x', 'color', 'D', 0)`));
    expect(r.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('authenticated cannot re-activate the retired griffin, or delete a catalog row', async () => {
    await as('authenticated', U1, () => attempt("update public.skins set active = true where id = 'griffin'"));
    expect((await one("select active from public.skins where id = 'griffin'")).active).toBe(false);
    await as('authenticated', U1, () => attempt("delete from public.skins where id = 'dragon-red'"));
    expect((await one("select count(*)::int as n from public.skins where id = 'dragon-red'")).n).toBe(1);
  });

  it('a client cannot revoke someone else\'s (or their own) entitlement row', async () => {
    await as('authenticated', U1, () => attempt("delete from public.owned_skins where skin_id = 'dragon-red'"));
    expect((await one("select count(*)::int as n from public.owned_skins where user_id = $1", [U1])).n).toBe(2);
  });
});

describe('guest score bounds are enforced server-side, not just by the client', () => {
  // js/leaderboard.js trims the typed name to 12 chars and only ever sends what the run
  // actually scored -- neither is a control, since anon can POST /rest/v1/scores directly.
  const insert = (name, score) =>
    as('anon', null, () => attempt('insert into public.scores (name, score) values ($1, $2)', [name, score]));
  const rejected = (r) => expect(String(r.code)).toMatch(/42501|23514/); // RLS check or table check constraint

  it('accepts a legitimate guest row at the limits', async () => {
    expect((await insert('abcdefghijkl', 1_000_000)).code).toBeUndefined();
  });

  it.each([
    ['a 13-character name', 'abcdefghijklm', 10],
    ['an empty name', '', 10],
    ['a score above the cap', 'Cheater', 1_000_001],
    ['a negative score', 'Cheater', -5],
  ])('rejects %s', async (_label, name, score) => {
    rejected(await insert(name, score));
  });

  it('many anonymous rows coexist (the unique index on user_id must not apply to NULLs)', async () => {
    for (let i = 0; i < 3; i++) expect((await insert('Guest', 5)).code).toBeUndefined();
    const r = await one("select count(*)::int as n from public.scores where user_id is null and name = 'Guest'");
    expect(r.n).toBeGreaterThanOrEqual(3);
  });

  it('scores_user_id_unique is a plain, non-partial index (ON CONFLICT cannot infer a partial one)', async () => {
    const r = await one(`select indpred is null as plain, indisunique from pg_index
      where indexrelid = 'public.scores_user_id_unique'::regclass`);
    expect(r).toEqual({ plain: true, indisunique: true });
  });
});
