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
  'supabase_owned_skins_revocation.sql',
  'supabase_scores_rate_limit_by_ip.sql',
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

  it('the scores-rate-limit-by-ip file is safe to re-run', async () => {
    await expect(db.exec(sqlOf('supabase_scores_rate_limit_by_ip.sql'))).resolves.not.toThrow();
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

  it('the dead profiles_insert_own / profiles_update_own policies are gone', async () => {
    const r = await one(`select count(*)::int as n from pg_policies
      where schemaname = 'public' and tablename = 'profiles' and policyname in ('profiles_insert_own', 'profiles_update_own')`);
    expect(r.n).toBe(0);
  });
});

describe('REGRESSION: leaderboard rows can only carry name + score from a client (stored XSS)', () => {
  // REGRESSION (second adversarial pass): anon used to be able to INSERT directly (scores_anon_
  // insert). That's exactly what let a scripted flood bypass any per-identity rate limit --
  // see supabase_scores_rate_limit_by_ip.sql -- so the privilege is gone entirely now.
  it('anon can no longer insert directly at all', async () => {
    const r = await as('anon', null, () => attempt(`insert into public.scores (name, score) values ('Guest', 42)`));
    expect(r.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('submit_anonymous_score is the only way in now, and its signature only ever accepts name + score', async () => {
    // Simulates what the submit-score Edge Function's service-role client does -- see
    // supabase_scores_rate_limit_by_ip.sql for why this can't be reached by anon/authenticated
    // directly. There's no way to smuggle avatar/color_filter/user_id through it: the function
    // simply has no parameter for them.
    await db.query(`select public.submit_anonymous_score('Guest', 42, null)`);
    const row = await one("select name, score, avatar, color_filter, user_id from public.scores where name = 'Guest'");
    expect(row).toEqual({ name: 'Guest', score: 42, avatar: null, color_filter: null, user_id: null });
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

// REGRESSION: skins/owned_skins used to be protected by RLS alone -- every write was already
// rejected (the tests above), but only because no policy allowed it, not because the privilege
// was revoked too. That's a single point of failure: one `disable row level security`, or a
// future migration that recreates either table without re-enabling it, and there'd be nothing
// left to stop it. scores/profiles got both layers (see the 'the dead ... policies are gone'
// tests above and the direct-writes-impossible tests below); this covers skins/owned_skins
// getting the same second layer, plus FORCE ROW LEVEL SECURITY so RLS would apply even to a
// table-owner-run statement (safe here specifically because nothing legitimate ever writes to
// either table as the owner -- unlike scores/profiles, whose security-definer RPCs do).
describe('REGRESSION: skins/owned_skins are locked down at the privilege layer too, not just by RLS', () => {
  it.each(['skins', 'owned_skins'])('anon and authenticated have no write privilege on %s', async (table) => {
    for (const role of ['anon', 'authenticated']) {
      for (const priv of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
        const r = await one('select has_table_privilege($1, $2, $3) as has', [role, `public.${table}`, priv]);
        expect(r.has, `${role} ${priv} on ${table}`).toBe(false);
      }
    }
  });

  it.each(['skins', 'owned_skins'])('%s has FORCE ROW LEVEL SECURITY set', async (table) => {
    const r = await one('select relforcerowsecurity as forced from pg_class where oid = $1::regclass', [`public.${table}`]);
    expect(r.forced).toBe(true);
  });

  it.each(['scores', 'profiles'])('%s (still owner-written by security-definer RPCs) does NOT force RLS, by design', async (table) => {
    const r = await one('select relforcerowsecurity as forced from pg_class where oid = $1::regclass', [`public.${table}`]);
    expect(r.forced).toBe(false);
  });

  it.each(['scores', 'profiles'])('anon and authenticated cannot DELETE or TRUNCATE %s either', async (table) => {
    for (const role of ['anon', 'authenticated']) {
      for (const priv of ['DELETE', 'TRUNCATE']) {
        const r = await one('select has_table_privilege($1, $2, $3) as has', [role, `public.${table}`, priv]);
        expect(r.has, `${role} ${priv} on ${table}`).toBe(false);
      }
    }
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

  // REGRESSION (adversarial security review): stripe-webhook used to DELETE an owned_skins row
  // on refund/dispute. Stripe redelivers webhook events for days on anything but a 2xx, and the
  // original grant is a plain upsert on (user_id, skin_id) -- so once the row was gone, a
  // redelivered copy of the *original* grant event landed on an empty primary-key slot and
  // silently re-granted a skin whose payment no longer held. Own user (U4), untouched by every
  // other describe block above, so this doesn't interact with dragon-red ownership set up
  // elsewhere in this file.
  describe('REGRESSION: grant_owned_skin/tombstoning survives a replayed grant after a refund', () => {
    const U4 = '44444444-4444-4444-4444-444444444444';
    const grant = (sessionId, amount = 199) =>
      db.query(
        `select public.grant_owned_skin($1, 'dragon-red', $2, $3, 'usd')`,
        [U4, sessionId, amount],
      );
    const rowFor = async () =>
      (await db.query(
        `select stripe_checkout_session_id, amount_paid_cents, revoked_at from public.owned_skins
         where user_id = $1 and skin_id = 'dragon-red'`,
        [U4],
      )).rows[0];
    // What stripe-webhook itself now does on charge.refunded/charge.dispute.created.
    const revoke = () =>
      db.query(
        `update public.owned_skins set revoked_at = now() where user_id = $1 and skin_id = 'dragon-red'`,
        [U4],
      );

    it('starts with no owned_skins row for the fresh U4 user', async () => {
      await db.query("insert into auth.users (id, email) values ($1, 'u4@example.test')", [U4]);
      expect((await rowFor())).toBeUndefined();
    });

    it('grants a fresh row with revoked_at null', async () => {
      await grant('cs_orig');
      expect(await rowFor()).toEqual({ stripe_checkout_session_id: 'cs_orig', amount_paid_cents: 199, revoked_at: null });
    });

    it('a plain retry of the same grant event (same session) stays a harmless no-op', async () => {
      await grant('cs_orig');
      const r = await rowFor();
      expect(r.stripe_checkout_session_id).toBe('cs_orig');
      expect(r.revoked_at).toBeNull();
      expect((await db.query("select count(*)::int as n from public.owned_skins where user_id = $1 and skin_id = 'dragon-red'", [U4])).rows[0].n).toBe(1);
    });

    it('a refund tombstones the row (revoked_at set) rather than deleting it, and equip_skin then refuses it', async () => {
      await revoke();
      const r = await rowFor();
      expect(r).toBeTruthy(); // still there -- not deleted
      expect(r.revoked_at).not.toBeNull();
      expect((await call(U4, "select public.equip_skin('dragon-red')")).message).toContain('skin not owned');
    });

    it('REGRESSION: a redelivered/replayed copy of the ORIGINAL grant event (same session id) does NOT resurrect the revoked row', async () => {
      await grant('cs_orig'); // exact same session id that was just revoked above
      const r = await rowFor();
      expect(r.revoked_at).not.toBeNull(); // still revoked
      expect((await call(U4, "select public.equip_skin('dragon-red')")).message).toContain('skin not owned');
    });

    it('a genuine repurchase (a NEW checkout session) after the refund DOES restore ownership', async () => {
      await grant('cs_new', 249);
      const r = await rowFor();
      expect(r).toEqual({ stripe_checkout_session_id: 'cs_new', amount_paid_cents: 249, revoked_at: null });
      expect((await call(U4, "select public.equip_skin('dragon-red')")).code).toBeUndefined();
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
  // actually scored -- neither is a control, since anyone can call submit_anonymous_score (via
  // the submit-score Edge Function, or -- see that function's own comment -- even directly) with
  // whatever they like.
  const submit = (name, score) => attempt('select public.submit_anonymous_score($1, $2, null)', [name, score]);

  it('accepts a legitimate guest row at the limits', async () => {
    expect((await submit('abcdefghijkl', 100_000)).code).toBeUndefined();
  });

  it.each([
    ['a 13-character name', 'abcdefghijklm', 10],
    ['an empty name', '', 10],
    ['a score above the cap', 'Cheater', 100_001],
    ['a negative score', 'Cheater', -5],
  ])('rejects %s', async (_label, name, score) => {
    const r = await submit(name, score);
    expect(r.rows).toBeUndefined();
    expect(r.message).toMatch(/invalid (name|score)/);
  });

  it("the table's own 1,000,000-ceiling check constraint still backs the RPC's tighter 100,000 one (defense in depth)", async () => {
    // submit_anonymous_score's own validation catches anything over 100,000 before this constraint
    // is ever reached in practice (there's no client path that skips the RPC's own check -- see
    // its comment in supabase_scores_rate_limit_by_ip.sql) -- this just confirms the table-level
    // backstop from supabase_lockdown_direct_writes.sql is still there too, stacked rather than
    // silently replaced, in case the RPC's own check were ever loosened by mistake.
    const r = await attempt("insert into public.scores (name, score) values ('Cheater', 1000001)");
    expect(String(r.code)).toBe('23514');
  });

  it('many anonymous rows coexist (the unique index on user_id must not apply to NULLs)', async () => {
    for (let i = 0; i < 3; i++) expect((await submit('Guest', 5)).code).toBeUndefined();
    const r = await one("select count(*)::int as n from public.scores where user_id is null and name = 'Guest'");
    expect(r.n).toBeGreaterThanOrEqual(3);
  });

  it('scores_user_id_unique is a plain, non-partial index (ON CONFLICT cannot infer a partial one)', async () => {
    const r = await one(`select indpred is null as plain, indisunique from pg_index
      where indexrelid = 'public.scores_user_id_unique'::regclass`);
    expect(r).toEqual({ plain: true, indisunique: true });
  });
});

// REGRESSION: a script with nothing but the published anon key could flood public.scores --
// verified live at 50 rows in under 20ms with the old, unthrottled anon insert policy. The
// trigger only guards the anon path (user_id is null); a signed-in submit_personal_best() call
// is already capped to one row per account by the unique index, so it's deliberately exempt --
// see the 'REGRESSION: an account never accumulates more than one row' test above.
//
// Uses its own fresh database (rather than the shared `db` every other describe block in this
// file uses) so the exact number of submissions before the budget cuts off is a reliable
// assertion, unaffected by how many submit_anonymous_score calls happen to run in describe
// blocks elsewhere in this file.
describe('REGRESSION: anonymous score submission is rate-limited', () => {
  let rdb;
  beforeAll(async () => {
    rdb = await freshDb();
    // Needed only for the "signed-in submission is exempt" test below (submit_personal_best
    // requires a profile row) -- this rdb is a from-scratch database, unlike the shared `db`
    // used everywhere else in this file, which already has one from an earlier describe block.
    await rdb.query("insert into public.profiles (user_id, display_name) values ($1, 'Test')", [U1]);
  }, 120_000);
  afterAll(async () => { await rdb?.close(); });

  const submit = (name, score, ipHash = null) =>
    rdb.query('select public.submit_anonymous_score($1, $2, $3)', [name, score, ipHash])
      .then(() => ({ ok: true }))
      .catch((e) => ({ ok: false, code: e.code, message: e.message }));

  // Local equivalents of the file's `as`/`attempt` helpers, bound to this describe block's own
  // rdb instead of the shared module-level `db`.
  async function asR(role, uid, fn) {
    await rdb.query("select set_config('request.jwt.claims', $1, false)", [uid ? JSON.stringify({ sub: uid, role }) : '']);
    await rdb.exec(`set role ${role}`);
    try {
      return await fn();
    } finally {
      await rdb.exec('reset role');
      await rdb.query("select set_config('request.jwt.claims', '', false)");
    }
  }
  async function attemptR(sql, params = []) {
    try {
      const r = await rdb.query(sql, params);
      return { rows: r.rows };
    } catch (e) {
      return { code: e.code, message: e.message };
    }
  }

  // REGRESSION (second adversarial pass): the pre-existing global budget (further down this
  // file) locks out every guest at once as soon as ONE flooder hits it -- worse than the spam it
  // was meant to stop. This is the fix: a per-caller budget layered on top, keyed by the hash the
  // submit-score Edge Function computes from the caller's real IP. Runs before the global-budget
  // block below on purpose: that block deliberately drains the shared rdb's global budget to
  // zero, which would otherwise make every one of these per-IP submissions fail on the global
  // check before its own per-IP budget was ever exercised.
  describe('the per-IP-hash budget (supabase_scores_rate_limit_by_ip.sql)', () => {
    it('one IP hash gets cut off well before the shared global budget would', async () => {
      let allowed = 0;
      let rejectedAt = null;
      for (let i = 0; i < 10; i++) {
        const r = await submit(`Flooder${i}`, 1, 'attacker-ip-hash');
        if (!r.ok) { rejectedAt = i; break; }
        allowed++;
      }
      expect(rejectedAt).not.toBeNull();
      expect(allowed).toBe(5);
      expect(rejectedAt).toBeLessThan(19); // i.e. this, not the 20-wide global budget, is what fired
    });

    it("a DIFFERENT IP hash is completely unaffected by the first one's cutoff", async () => {
      const r = await submit('Guest', 1, 'someone-elses-ip-hash');
      expect(r.ok).toBe(true);
    });

    it('a null IP hash (bypassing the intended Edge Function path) falls back to the global-only budget, not a regression', async () => {
      // Documents the known, non-attacker-triggerable ceiling described in
      // supabase_scores_rate_limit_by_ip.sql: SQL alone cannot verify an HTTP-layer fact like a
      // caller's real IP, so a caller hitting this RPC directly (skipping the Edge Function that
      // would normally supply a real hash) can dodge the per-IP check -- but not any worse than
      // before this file existed, since it then falls straight back to the pre-existing global
      // budget, which the next describe block covers -- and has plenty of headroom left at this
      // point regardless (11 of 20 spent by the two tests above).
      for (let i = 0; i < 5; i++) {
        const r = await submit(`NullHash${i}`, 1, null);
        expect(r.ok, `submission ${i} with no ip_hash`).toBe(true);
      }
    });
  });

  describe('the global budget (no usable per-caller identity)', () => {
    it('a burst of anonymous submissions is eventually rejected within the same window (the per-IP block above already spent some of it)', async () => {
      let allowed = 0;
      let rejectedAt = null;
      for (let i = 0; i < 25; i++) {
        const r = await submit(`Flood${i}`, 1, `flood-ip-${i}`); // distinct IPs -- isolates the global cap from the per-IP one
        if (!r.ok) { rejectedAt = i; break; }
        allowed++;
      }
      expect(rejectedAt, 'expected the burst to be cut off within 25 submissions').not.toBeNull();
      expect(allowed).toBeLessThan(25);
    });

    it('a signed-in submission is exempt from the same budget (already capped to one row per account)', async () => {
      // The loop above just exhausted the global budget entirely -- a signed-in submit still works.
      const r = await asR('authenticated', U1, () => attemptR('select public.submit_personal_best($1) as r', [1]));
      expect(r.code).toBeUndefined();
    });

    it('direct anon insert stays blocked no matter what -- the RPC above is the only way in or around it', async () => {
      const r = await asR('anon', null, () => attemptR(`insert into public.scores (name, score) values ('Sneaky', 1)`));
      expect(r.code).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });
});
