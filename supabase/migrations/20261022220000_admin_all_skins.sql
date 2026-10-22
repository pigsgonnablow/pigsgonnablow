-- Admin accounts: an account listed in public.admins counts as owning every skin in the
-- catalog, including any added later, without a Stripe purchase or an owned_skins row. Nothing
-- is copied into owned_skins, so the purchase totals in get_stats() stay real revenue only.
-- Run after supabase_lockdown_direct_writes.sql (this redefines its equip_skin()).
--
-- To make an account an admin, from the SQL editor (the only way in -- see below):
--   insert into public.admins (user_id)
--   select id from auth.users where email = 'you@example.com'
--   on conflict do nothing;

-- Same lockdown as owned_skins: RLS on and forced, no policies at all, and every privilege
-- revoked from the client roles -- so a client can't read the list, let alone add itself to it.
-- Rows only ever come from the SQL editor (postgres) or the service role.
create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;
alter table public.admins force row level security;
revoke all on public.admins from public, anon, authenticated;

-- Whether the *caller* is an admin. Security definer so it can read public.admins without the
-- caller holding any privilege on it; it only ever answers for auth.uid(), never for an
-- arbitrary user id, so it doesn't leak who else is an admin.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and exists(select 1 from public.admins where user_id = auth.uid());
$$;

-- Same as the lockdown file's version, plus the admin bypass on the ownership check.
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

  if v_price > 0 and not public.is_admin() then
    select exists(
      select 1 from public.owned_skins where user_id = auth.uid() and skin_id = p_skin_id and revoked_at is null
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

revoke all on function public.is_admin() from public;
revoke execute on function public.is_admin() from anon;
grant execute on function public.is_admin() to authenticated;
revoke all on function public.equip_skin(text) from public;
revoke execute on function public.equip_skin(text) from anon;
grant execute on function public.equip_skin(text) to authenticated;
