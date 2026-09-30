-- Anonymous, cookie-free play stats: how many people load the page, start a run, how far they
-- get, and which site sent them. Written by the game (js/stats.js) through log_event() below and
-- read by the local dashboard (tools/stats-dashboard.html) through get_stats().
--
-- Nothing here identifies a player: no user id, no IP, no per-visitor id, no cookie. Each row is
-- just "a <kind> happened at <level>, and the page was reached from <ref>". That's also why
-- privacy.html can keep promising "no third-party analytics" -- this is first-party, on the same
-- Supabase project the leaderboard already uses.
--
-- get_stats() only ever returns aggregate counts, and anon can call it, so those counts are
-- effectively public to anyone who digs the publishable key out of index.html (which is public
-- by design). That's a deliberate trade for a dashboard that needs no login or secret.

create table if not exists public.events (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('visit', 'game_start', 'game_over', 'victory', 'quit', 'shop_open')),
  level integer not null default 0 check (level between 0 and 999),
  ref text not null default 'direct' check (char_length(ref) between 1 and 40 and ref ~ '^[a-z0-9._-]+$'),
  created_at timestamptz not null default now()
);
create index if not exists events_created_at_idx on public.events (created_at);

-- No policies on purpose: with RLS on and no policy, anon/authenticated can neither read nor
-- write rows directly. The revoke undoes the "grant all on tables to anon, authenticated" that a
-- hosted Supabase project applies by default, so direct access fails at the privilege layer too.
alter table public.events enable row level security;
revoke all on public.events from anon, authenticated;

-- The only write path. security definer so it can insert despite the revoke above; the checks
-- inside stand in for a policy's `with check`. Bad input is dropped silently rather than raised,
-- since the caller is fire-and-forget and has nothing useful to do with an error.
create or replace function public.log_event(p_kind text, p_level integer default 0, p_ref text default 'direct')
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ref text := lower(coalesce(p_ref, ''));
begin
  if p_kind is null or p_kind not in ('visit', 'game_start', 'game_over', 'victory', 'quit', 'shop_open') then
    return;
  end if;
  if v_ref !~ '^[a-z0-9._-]{1,40}$' then
    v_ref := 'direct';
  end if;

  -- A global ceiling so a script can't bloat the table without limit. Unlike the score limiter
  -- (see supabase_scores_rate_limit_by_ip.sql) a flood here only drops *stats* rows -- gameplay
  -- never waits on this call -- so a single global budget is an acceptable DoS surface.
  if (select count(*) from public.events where created_at > now() - interval '1 minute') >= 300 then
    return;
  end if;

  insert into public.events (kind, level, ref)
  values (p_kind, least(greatest(coalesce(p_level, 0), 0), 999), v_ref);
end;
$$;

-- Aggregates only, never rows. Day buckets are UTC.
create or replace function public.get_stats(p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_days integer := least(greatest(coalesce(p_days, 30), 1), 365);
  v_since timestamptz := date_trunc('day', now() at time zone 'utc') at time zone 'utc' - make_interval(days => v_days - 1);
begin
  return jsonb_build_object(
    'days', v_days,
    'generated_at', now(),
    'totals', (
      select coalesce(jsonb_object_agg(kind, n), '{}'::jsonb)
      from (select kind, count(*) as n from public.events where created_at >= v_since group by kind) t
    ),
    'all_time', (
      select coalesce(jsonb_object_agg(kind, n), '{}'::jsonb)
      from (select kind, count(*) as n from public.events group by kind) t
    ),
    'daily', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'day', to_char(d.day, 'YYYY-MM-DD'),
        'visit', coalesce(c.visit, 0),
        'game_start', coalesce(c.game_start, 0),
        'game_over', coalesce(c.game_over, 0),
        'victory', coalesce(c.victory, 0)
      ) order by d.day), '[]'::jsonb)
      from generate_series(
        (v_since at time zone 'utc')::date,
        (now() at time zone 'utc')::date,
        interval '1 day'
      ) as d(day)
      left join (
        select (created_at at time zone 'utc')::date as day,
          count(*) filter (where kind = 'visit') as visit,
          count(*) filter (where kind = 'game_start') as game_start,
          count(*) filter (where kind = 'game_over') as game_over,
          count(*) filter (where kind = 'victory') as victory
        from public.events where created_at >= v_since group by 1
      ) c on c.day = d.day::date
    ),
    'refs', (
      select coalesce(jsonb_agg(jsonb_build_object('ref', ref, 'visits', n) order by n desc, ref), '[]'::jsonb)
      from (
        select ref, count(*) as n from public.events
        where kind = 'visit' and created_at >= v_since
        group by ref order by count(*) desc, ref limit 10
      ) t
    ),
    'levels', (
      select coalesce(jsonb_agg(jsonb_build_object('level', level, 'runs', n) order by level), '[]'::jsonb)
      from (
        select level, count(*) as n from public.events
        where kind in ('game_over', 'quit') and created_at >= v_since
        group by level
      ) t
    )
  );
end;
$$;

-- Postgres grants EXECUTE on new functions to PUBLIC by default; make the grants explicit.
revoke all on function public.log_event(text, integer, text) from public;
revoke all on function public.get_stats(integer) from public;
grant execute on function public.log_event(text, integer, text) to anon, authenticated;
grant execute on function public.get_stats(integer) to anon, authenticated;
