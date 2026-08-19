-- Purchasable skins: a general catalog + entitlements table meant to cover both a simple
-- recolor of the current dragon and, later, a full different character -- the row shape is
-- the same either way, so the client and the Stripe webhook don't need to change when that
-- happens. Feeds into the *existing* `profiles.avatar` / `scores.avatar` columns (see
-- supabase_avatars_schema.sql), so the leaderboard rendering code needs zero changes: a skin
-- is just "the account's avatar came from the catalog instead of the fixed default."

-- The catalog. `kind` records whether a skin is a recolor of the base character ('color') or
-- a different character entirely ('character') -- purely informational for now (e.g. for
-- grouping in a future picker UI), nothing in the schema treats them differently since both
-- resolve to the same emoji/avatar swap.
create table if not exists public.skins (
  id text primary key,                 -- slug, e.g. 'dragon-default', 'dragon-red', 'griffin'
  name text not null,
  kind text not null check (kind in ('color', 'character')),
  emoji text not null check (char_length(emoji) <= 8),
  price_cents integer not null default 0 check (price_cents >= 0),
  stripe_price_id text,                -- null for the free default skin
  is_default boolean not null default false,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.skins enable row level security;
-- Catalog is public read (needed to render a picker before sign-in); writes only ever happen
-- from the SQL editor / a service-role script, never from the client.
create policy "skins_select_all" on public.skins for select using (true);

-- Seed the current fixed dragon as skin id 'dragon-default' so existing accounts' avatar
-- ('🐉', set by supabase_avatars_schema.sql) lines up with a real catalog row from day one,
-- plus two test skins with real Stripe (sandbox) Price ids already wired up, to have
-- something end-to-end to build/test the checkout + webhook flow against.
insert into public.skins (id, name, kind, emoji, price_cents, stripe_price_id, is_default, sort_order) values
  ('dragon-default', 'Dragon', 'character', '🐉', 0, null, true, 0),
  ('dragon-red', 'Dragon - Red', 'color', '🔴🐉', 199, 'price_1U5rlLEqKzqiSaAiUlyAYeZw', false, 1),
  ('griffin', 'Griffin', 'character', '🦅', 299, 'price_1U5rlNEqKzqiSaAipWmnkq0M', false, 2)
on conflict (id) do nothing;

-- Entitlements: which accounts own which skins. No insert/update policies are defined for
-- anon/authenticated on purpose -- the only way a row appears here is a Stripe webhook (an
-- Edge Function using the service-role key, which bypasses RLS entirely) confirming a real
-- payment. A signed-in user can only ever read their own purchases, never grant themselves one.
create table if not exists public.owned_skins (
  user_id uuid not null references auth.users(id) on delete cascade,
  skin_id text not null references public.skins(id),
  purchased_at timestamptz not null default now(),
  stripe_checkout_session_id text,
  primary key (user_id, skin_id)
);
alter table public.owned_skins enable row level security;
create policy "owned_skins_select_own" on public.owned_skins for select using (auth.uid() = user_id);

-- Which skin is currently equipped. Kept alongside `avatar` (rather than replacing it) so
-- nothing that already reads `profiles.avatar` / `scores.avatar` has to change; equip_skin()
-- below is the only thing that writes either column going forward.
alter table public.profiles add column if not exists equipped_skin_id text not null default 'dragon-default' references public.skins(id);

-- Switches the caller's equipped skin, after checking they actually own it (or it's free).
-- Runs as the calling user, so RLS on owned_skins/skins is still the real read-side guard --
-- this just adds the "must own it" write-side check and keeps `avatar` in sync so the
-- leaderboard/account-widget rendering code never has to know skins exist.
create or replace function public.equip_skin(p_skin_id text)
returns void
language plpgsql
as $$
declare
  v_emoji text;
  v_price integer;
  v_owns boolean;
begin
  select emoji, price_cents into v_emoji, v_price from public.skins where id = p_skin_id and active;
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

  update public.profiles set equipped_skin_id = p_skin_id, avatar = v_emoji where user_id = auth.uid();
end;
$$;

grant execute on function public.equip_skin(text) to authenticated;
