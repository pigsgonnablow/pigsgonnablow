-- Closes a privilege-escalation hole: Supabase grants broad INSERT/UPDATE on every public
-- table to `anon`/`authenticated` by default (a project-level default, not anything in this
-- repo's SQL) -- RLS policies were meant to be the real restriction, but the row-level
-- `with check` clauses on scores/profiles only constrain a couple of columns (score bounds,
-- name length), not every column. That left real holes reachable via a raw PostgREST call,
-- bypassing the app entirely:
--   1. Any signed-in (or even anonymous, for scores) caller could set `scores.color_filter`
--      / `scores.avatar` to an arbitrary string, which the leaderboard used to interpolate
--      into raw HTML -- a stored-XSS vector against every visitor who viewed the board.
--   2. Any signed-in caller could set `profiles.equipped_skin_id` / `profiles.color_filter`
--      directly (via UPDATE, or via INSERT on first sign-in before a profile row exists --
--      the earlier version of this file only closed the UPDATE half), completely skipping
--      equip_skin()'s "must own it" check -- i.e. equipping any paid skin for free, no
--      Stripe purchase required.
-- Run this once in the Supabase SQL Editor, after every other schema file. Safe to re-run.

-- Only `name`/`score` may ever be written directly by anon or authenticated -- every other
-- column (avatar, color_filter, user_id) must come from the security-definer functions
-- below, which compute those values server-side instead of trusting whatever the client sent.
revoke insert, update on public.scores from anon, authenticated;
grant insert (name, score) on public.scores to anon;

-- Signed-in scores are only ever written via submit_personal_best now (security definer,
-- below) -- these two policies are unreachable without any insert/update privilege at all,
-- so drop them rather than leave dead RLS rules that look like they're still doing something.
drop policy if exists "scores_own_insert" on public.scores;
drop policy if exists "scores_own_update" on public.scores;

-- profiles: revoke both INSERT and UPDATE outright, on every column, from both roles.
-- display_name is set exclusively through set_display_name() below; equipped_skin_id/
-- avatar/color_filter exclusively through equip_skin() -- neither the first-sign-in row
-- creation nor a later display-name change ever needs a direct client write to this table.
revoke insert, update on public.profiles from anon, authenticated;

-- Signed-in profile writes now only ever happen via set_display_name()/equip_skin()
-- (security definer, below) -- same as scores_own_insert/scores_own_update above, these two
-- are unreachable without any insert/update privilege at all, so drop them too.
drop policy if exists "profiles_insert_own" on public.profiles;
drop policy if exists "profiles_update_own" on public.profiles;

-- Replaces js/auth.js's setDisplayName(), which used to do a raw client-side
-- `.from('profiles').upsert(...)`. A plain per-column GRANT can't support that: PostgREST
-- compiles an upsert into `INSERT ... ON CONFLICT DO UPDATE SET user_id = EXCLUDED.user_id,
-- display_name = ...`, and Postgres checks UPDATE privilege on every column in that SET list
-- -- including user_id -- whether or not a conflict actually happens. So there's no column
-- grant that both (a) lets a brand-new signed-in user create their first profile row and
-- (b) doesn't also let them rewrite user_id. A security definer function sidesteps this
-- entirely: it always writes `auth.uid()` itself, never a client-supplied user_id.
create or replace function public.set_display_name(p_name text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  if char_length(p_name) not between 1 and 12 then
    raise exception 'display name must be 1-12 characters';
  end if;
  insert into public.profiles (user_id, display_name)
  values (auth.uid(), p_name)
  on conflict (user_id) do update set display_name = excluded.display_name;
end;
$$;

-- security definer makes these run as their owner (the table owner, which bypasses RLS/
-- grants entirely for their own internal queries) rather than as the calling role -- so they
-- keep working correctly now that the grants above block direct writes from the client. Each
-- one re-implements its own ownership check via auth.uid(), which is what makes this safe
-- despite bypassing RLS -- the explicit `auth.uid() is null` guards make that check
-- unconditional rather than relying on it merely returning zero rows. `set search_path`
-- pins name resolution (including pg_temp, searched first by default) so a security definer
-- function can't be tricked by a caller-controlled search_path; every reference in both
-- bodies is already schema-qualified (public.profiles etc.), so this closes the gap rather
-- than just documenting an accidental one. (Full create-or-replace, not alter, since the
-- auth.uid() guard is a body change too, not just an attribute change.)
create or replace function public.submit_personal_best(p_score integer)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text;
  v_avatar text;
  v_filter text;
  v_result integer;
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;

  select display_name, avatar, color_filter into v_name, v_avatar, v_filter
  from public.profiles where user_id = auth.uid();
  if v_name is null then
    raise exception 'no profile found for this account';
  end if;

  insert into public.scores (user_id, name, avatar, color_filter, score)
  values (auth.uid(), v_name, v_avatar, v_filter, p_score)
  on conflict (user_id) do update
    set score = excluded.score, name = excluded.name, avatar = excluded.avatar,
        color_filter = excluded.color_filter, created_at = now()
    where excluded.score > public.scores.score
  returning score into v_result;

  return v_result; -- null means the existing best was already >= p_score, so nothing changed
end;
$$;

create or replace function public.equip_skin(p_skin_id text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_emoji text;
  v_filter text;
  v_price integer;
  v_owns boolean;
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;

  select emoji, color_filter, price_cents into v_emoji, v_filter, v_price
  from public.skins where id = p_skin_id and active;
  if v_emoji is null then
    raise exception 'unknown or inactive skin';
  end if;

  if v_price > 0 then
    select exists(
      select 1 from public.owned_skins where user_id = auth.uid() and skin_id = p_skin_id
    ) into v_owns;
    if not v_owns then
      raise exception 'skin not owned';
    end if;
  end if;

  update public.profiles
  set equipped_skin_id = p_skin_id, avatar = v_emoji, color_filter = v_filter
  where user_id = auth.uid();
end;
$$;

-- Kept at the END of the file, after every function above is defined, on purpose: on a fresh
-- database these `revoke ... on function` statements error if the function doesn't exist yet,
-- and a script that stopped there would leave the later create-or-replace with the default
-- EXECUTE grants still in place.
-- CREATE FUNCTION grants EXECUTE to PUBLIC by default -- meaning `anon` (holding the
-- published anon key baked into index.html) could otherwise call any of these three RPCs
-- too. None of them currently do anything exploitable as anon (auth.uid() is null, so each
-- one's own check is what stops it), but that's incidental, not intentional -- revoke
-- PUBLIC/anon explicitly so a future edit to any of these can't accidentally open one up.
revoke all on function public.set_display_name(text) from public;
revoke all on function public.submit_personal_best(integer) from public;
revoke all on function public.equip_skin(text) from public;
-- Supabase's default privileges also grant EXECUTE to `anon` directly (not via PUBLIC), so
-- the revokes above alone leave anon able to call these -- revoke it by name too.
revoke execute on function public.set_display_name(text) from anon;
revoke execute on function public.submit_personal_best(integer) from anon;
revoke execute on function public.equip_skin(text) from anon;
grant execute on function public.set_display_name(text) to authenticated;
grant execute on function public.submit_personal_best(integer) to authenticated;
grant execute on function public.equip_skin(text) to authenticated;

-- Everything above closed the specific holes RLS's `with check` clauses missed on scores/
-- profiles, but relied on "RLS holds" for skins/owned_skins rather than also revoking the
-- privileges behind it -- unlike scores/profiles, those two never got a matching
-- `revoke insert, update ...`. Today the RLS policies on skins/owned_skins do reject every
-- direct client write (skins has no write policy at all; owned_skins has none either), so
-- there's no live hole -- but it means "RLS protects it" was true for two tables and merely
-- assumed for the other two, one `alter table ... disable row level security` (or a future
-- migration that recreates either table without re-enabling RLS) away from turning "equip any
-- paid skin for free" or "grant yourself a skin directly" from theoretical into real. Revoking
-- the privilege too means a client write is rejected at the grant-check stage, before RLS is
-- even consulted -- a second, independent layer, not just a second policy to get right.
--
-- FORCE ROW LEVEL SECURITY (not just ENABLE) is added on top for these two specifically,
-- because it's safe here in a way it would NOT be on scores/profiles: nothing legitimate ever
-- writes to skins/owned_skins as the table owner (every real owned_skins row is written by the
-- Stripe webhook via the service-role key, a completely different bypass mechanism that FORCE
-- doesn't affect). scores/profiles, by contrast, ARE legitimately written as the owner --
-- that's exactly how submit_personal_best/set_display_name/equip_skin (security definer,
-- above) get past their own otherwise-empty insert/update policies -- so forcing RLS there
-- would risk breaking those RPCs' own internal writes and is deliberately left alone; the
-- privilege revoke below (delete/truncate only, since insert/update on those two were already
-- revoked above) is the safe part of the same hardening.
revoke insert, update, delete, truncate on public.skins, public.owned_skins from anon, authenticated;
revoke delete, truncate on public.scores, public.profiles from anon, authenticated;
alter table public.skins force row level security;
alter table public.owned_skins force row level security;

-- The 1,000,000 ceiling on scores.score (supabase_scores_schema.sql) was sized to obviously
-- never be hit by real play, but that headroom is exactly what makes bulk abuse effective: a
-- script with nothing but the published anon key can insert as many rows at the max value as
-- it likes (verified: 50 rows in 15ms), permanently monopolizing the public leaderboard with
-- no in-app way to clean it up. Tightening the ceiling to something still generous for a
-- genuinely long, skilled run (the game has no hard end -- showVictoryScreen() lets a player
-- keep going past level 15 for more score) but far below "obviously not real" removes the
-- worst of that headroom. This is a courtesy bound, not the real defense (see the rate limit
-- below for that) -- it stacks with, not replaces, the existing `score >= 0 and score <=
-- 1000000` check already on the column; adding a second, tighter named constraint is simpler
-- and safer than trying to locate and replace Postgres's auto-generated name for the first one.
alter table public.scores drop constraint if exists scores_score_max_check;
alter table public.scores add constraint scores_score_max_check check (score <= 100000);

-- The real defense against the bulk-insert abuse above: a global rate limit on the `scores`
-- table itself, so it applies no matter which path reaches it (the anon insert policy above,
-- or an authenticated submit_personal_best() call, which also just inserts into this table).
-- There's no per-IP/per-user identity available at this layer to throttle *fairly* -- PostgREST
-- requests don't carry a reliably-forwarded client IP into `auth.uid()`/RLS context the way an
-- app server would see one -- so this is a blunt, whole-table throttle: no more than 20 new
-- rows in any trailing 60-second window, globally. That's generous for real traffic at this
-- project's current scale (a genuine flood of *simultaneous real players* submitting scores is
-- a good problem to have, and this can be raised or replaced with a smarter per-identity limit
-- if that ever happens) and hostile to a scripted burst, which is the realistic threat today.
create table if not exists public._scores_insert_log (
  inserted_at timestamptz not null default now()
);
-- Not meant to be touched directly by anyone but the trigger function below (which runs as
-- security definer, so it doesn't need a grant of its own) -- revoke Supabase's default broad
-- grants so this bookkeeping table isn't itself a new PostgREST-reachable surface.
revoke all on public._scores_insert_log from public, anon, authenticated;

create or replace function public.enforce_scores_insert_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Only the anonymous path is the volumetric-flood risk being guarded against here: a
  -- signed-in submission (submit_personal_best) is already capped to one row per account by
  -- the unique index on user_id, so there's nothing to throttle there -- unlimited *distinct
  -- new rows* is only reachable through the anon insert policy, which is exactly what a script
  -- with nothing but the published anon key used to flood the board.
  if new.user_id is not null then
    return new;
  end if;
  delete from public._scores_insert_log where inserted_at < now() - interval '1 minute';
  if (select count(*) from public._scores_insert_log) >= 20 then
    raise exception 'too many score submissions right now -- please try again in a minute';
  end if;
  insert into public._scores_insert_log default values;
  return new;
end;
$$;
revoke all on function public.enforce_scores_insert_rate_limit() from public, anon, authenticated;

drop trigger if exists scores_insert_rate_limit on public.scores;
create trigger scores_insert_rate_limit
  before insert on public.scores
  for each row execute function public.enforce_scores_insert_rate_limit();
