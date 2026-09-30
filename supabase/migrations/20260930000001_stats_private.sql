-- Makes the stats private. supabase_stats_schema.sql let anon call get_stats(), so anyone who
-- found the dashboard (or dug the publishable key out of index.html) could read the numbers,
-- including revenue. From here on:
--   * get_stats() is no longer callable by anon/authenticated at all;
--   * the dashboard calls read_stats(p_password, p_days) instead, which only answers when the
--     password matches the one the owner set with private.set_stats_password();
--   * repeated wrong guesses lock read_stats for everyone for a few minutes.
-- Writing stats (log_event) is unchanged and stays public; the game needs it.
--
-- To set or change the password (once, from the Supabase dashboard's SQL Editor, which runs as
-- the owner -- nothing here lets a client call it):
--   select private.set_stats_password('a long passphrase you will remember');
--
-- Run after supabase_stats_schema.sql.

-- Not in PostgREST's exposed schemas (public, graphql_public), and no grants to the API roles,
-- so nothing in here is reachable from a client.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- One row: the SHA-256 of the dashboard password (never the password itself).
create table if not exists private.stats_access (
  id integer primary key default 1 check (id = 1),
  key_hash text not null,
  updated_at timestamptz not null default now()
);

-- Wrong-password attempts, kept only long enough to enforce the lockout below.
create table if not exists private.stats_access_failures (
  at timestamptz not null default now()
);
create index if not exists stats_access_failures_at_idx on private.stats_access_failures (at);

create or replace function private.set_stats_password(p_password text)
returns void
language plpgsql
set search_path = private, pg_temp
as $$
begin
  if p_password is null or char_length(p_password) < 12 then
    raise exception 'use a password of at least 12 characters';
  end if;
  insert into private.stats_access (id, key_hash, updated_at)
  values (1, encode(sha256(convert_to(p_password, 'UTF8')), 'hex'), now())
  on conflict (id) do update set key_hash = excluded.key_hash, updated_at = now();
  delete from private.stats_access_failures;
end;
$$;
revoke all on function private.set_stats_password(text) from public, anon, authenticated;

-- The dashboard's only way in. Returns get_stats()'s JSON on the right password, otherwise
-- {"error": "..."} -- returned rather than raised, because raising would roll back the failure
-- row the lockout depends on.
create or replace function public.read_stats(p_password text, p_days integer default 30)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_hash text;
begin
  select key_hash into v_hash from private.stats_access where id = 1;
  if v_hash is null then
    return jsonb_build_object('error', 'no_password_set');
  end if;

  -- 10 wrong guesses in 10 minutes locks the door for everyone until they age out. A long
  -- passphrase makes guessing hopeless anyway; this just stops a script from trying.
  delete from private.stats_access_failures where at < now() - interval '10 minutes';
  if (select count(*) from private.stats_access_failures) >= 10 then
    return jsonb_build_object('error', 'locked');
  end if;

  if p_password is null or encode(sha256(convert_to(p_password, 'UTF8')), 'hex') <> v_hash then
    insert into private.stats_access_failures default values;
    return jsonb_build_object('error', 'wrong_password');
  end if;

  return public.get_stats(p_days);
end;
$$;

revoke all on function public.read_stats(text, integer) from public;
grant execute on function public.read_stats(text, integer) to anon, authenticated;

-- Close the old open door.
revoke all on function public.get_stats(integer) from public, anon, authenticated;
