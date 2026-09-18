-- Closes a privilege-escalation hole: Supabase grants broad INSERT/UPDATE on every public
-- table to `anon`/`authenticated` by default (a project-level default, not anything in this
-- repo's SQL) -- RLS policies were meant to be the real restriction, but the row-level
-- `with check` clauses on scores/profiles only constrain a couple of columns (score bounds,
-- name length), not every column. That left two real holes reachable via a raw PostgREST
-- call, bypassing the app entirely:
--   1. Any signed-in (or even anonymous, for scores) caller could set `scores.color_filter`
--      / `scores.avatar` to an arbitrary string, which the leaderboard used to interpolate
--      into raw HTML -- a stored-XSS vector against every visitor who viewed the board.
--   2. Any signed-in caller could set `profiles.equipped_skin_id` / `profiles.color_filter`
--      directly, completely skipping equip_skin()'s "must own it" check -- i.e. equipping
--      (and getting all its effects: recolor, ember trail, etc.) any paid skin for free,
--      no Stripe purchase required.
-- Run this once in the Supabase SQL Editor, after every other schema file.

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

-- A signed-in player may only ever change their own display name directly. equipped_skin_id/
-- avatar/color_filter can only change via equip_skin() (security definer, below), which is
-- the one place that actually checks ownership before granting any of a skin's effects.
revoke update on public.profiles from authenticated;
grant update (display_name) on public.profiles to authenticated;

-- security definer makes both functions run as their owner (the table owner, which bypasses
-- RLS/grants entirely for its own internal queries) rather than as the calling role -- so
-- they keep working correctly now that the grants above block direct writes from the client.
-- Each function already re-implements its own ownership check via auth.uid(), which is what
-- makes this safe despite bypassing RLS. set search_path pins name resolution to `public` so
-- a security definer function can't be tricked by a caller-controlled search_path.
alter function public.submit_personal_best(integer) security definer set search_path = public;
alter function public.equip_skin(text) security definer set search_path = public;
