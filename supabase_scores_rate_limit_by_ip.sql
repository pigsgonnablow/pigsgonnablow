-- Closes a real gap found in a second adversarial pass over supabase_lockdown_direct_writes.sql's
-- rate limiter: that limiter is a single GLOBAL budget (20 rows/60s across every anonymous
-- submitter combined), because a PostgREST request carries no identity a Postgres trigger can
-- see. That made it a denial-of-service lever, not just a spam throttle: a script making one
-- request every 3 seconds keeps the global log permanently full, and every *other* real guest's
-- submission gets rejected right along with the attacker's -- worse than the flood it was meant
-- to stop.
--
-- The fix needs a real per-caller identity, and the only place in this stack that ever sees a
-- caller's IP address is a Supabase Edge Function (supabase/functions/submit-score) -- PostgREST
-- itself does not forward it. So anonymous score submission moves behind that function, which:
--   1. reads the caller's IP from the request,
--   2. hashes it (salted, so a raw IP is never stored) before it ever reaches the database,
--   3. calls this file's submit_anonymous_score() RPC, which enforces a per-IP-hash budget on
--      top of (not instead of) the existing global one.
-- Run after supabase_lockdown_direct_writes.sql (needs its public._scores_insert_log table).

alter table public._scores_insert_log add column if not exists ip_hash text;
create index if not exists scores_insert_log_ip_hash_idx on public._scores_insert_log (ip_hash, inserted_at);

-- The direct "any anon key can INSERT into scores" path (scores_anon_insert, from
-- supabase_accounts_schema.sql) is exactly what let a scripted flood bypass any per-identity
-- check in the first place -- a client that can write the row itself can always skip whatever
-- function you'd rather it called instead. Removing it makes the function below the only way
-- an anonymous submission reaches the table.
drop policy if exists "scores_anon_insert" on public.scores;
revoke insert on public.scores from anon;

-- Redefines the existing trigger from supabase_lockdown_direct_writes.sql to add the per-IP-hash
-- budget alongside its pre-existing global one, in the same bookkeeping table. A trigger only
-- ever sees NEW's own columns (scores has no ip_hash column, and shouldn't gain one just for
-- this), so submit_anonymous_score below hands the hash across via a transaction-local setting
-- instead of a column.
create or replace function public.enforce_scores_insert_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- Only ever set (by submit_anonymous_score, just below) when this insert came from a real
  -- submit-score Edge Function call, which is the only thing that can compute a genuine
  -- per-caller hash. Missing_ok=true so a plain insert (or a direct call to the RPC with
  -- p_ip_hash left null -- see that function's own comment for why that isn't preventable from
  -- SQL alone) just falls back to the global-only check below, same as before this file existed.
  v_ip_hash text := nullif(current_setting('pigsgonnablow.score_ip_hash', true), '');
  v_recent_from_ip integer;
begin
  -- Only the anonymous path is the volumetric-flood risk being guarded against here: a
  -- signed-in submission (submit_personal_best) is already capped to one row per account by
  -- the unique index on user_id, so there's nothing to throttle there -- unlimited *distinct
  -- new rows* is only reachable through an anonymous submission.
  if new.user_id is not null then
    return new;
  end if;

  delete from public._scores_insert_log where inserted_at < now() - interval '1 minute';
  if (select count(*) from public._scores_insert_log) >= 20 then
    raise exception 'too many score submissions right now -- please try again in a minute';
  end if;

  if v_ip_hash is not null then
    select count(*) into v_recent_from_ip
      from public._scores_insert_log
      where ip_hash = v_ip_hash and inserted_at >= now() - interval '1 minute';
    if v_recent_from_ip >= 5 then
      raise exception 'too many score submissions from this connection -- please try again in a minute';
    end if;
  end if;

  insert into public._scores_insert_log (ip_hash) values (v_ip_hash);
  return new;
end;
$$;

-- security definer so it can still insert despite the anon revoke above; the checks inside are
-- what replace the dropped scores_anon_insert policy's `with check`.
create or replace function public.submit_anonymous_score(p_name text, p_score integer, p_ip_hash text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_name is null or char_length(p_name) < 1 or char_length(p_name) > 12 then
    raise exception 'invalid name';
  end if;
  if p_score is null or p_score < 0 or p_score > 100000 then
    raise exception 'invalid score';
  end if;

  -- Local to this transaction only (the `true` argument) -- never leaks to any other request
  -- sharing the connection pool. Read back by the trigger above.
  perform set_config('pigsgonnablow.score_ip_hash', coalesce(p_ip_hash, ''), true);
  insert into public.scores (name, score) values (p_name, p_score);
end;
$$;

-- Not for anon/authenticated to call directly (see the p_ip_hash comment above for why a direct
-- caller could otherwise just omit it and dodge the per-IP budget) -- only the Edge Function's
-- service-role client calls this, and service_role already bypasses grants like this by default
-- in Supabase, so no explicit grant is needed for it to keep working.
revoke all on function public.submit_anonymous_score(text, integer, text) from public, anon, authenticated;
