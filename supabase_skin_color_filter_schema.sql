-- The dragon is a single Unicode emoji with no separately paintable parts (no way to recolor
-- just the fins, for example), so a "colored" skin variant works by applying a CSS/canvas
-- color filter over the same base glyph rather than swapping to different art. `color_filter`
-- holds that filter string, applied wherever the equipped skin is actually rendered as the
-- player's character: the shop's catalog card and the in-game sprite. (Not yet applied to the
-- leaderboard/account-widget avatar display -- those still show the plain glyph for now.)
alter table public.skins add column if not exists color_filter text;
alter table public.profiles add column if not exists color_filter text;

-- Also drop the placeholder red-circle-plus-dragon emoji combo from before this filter
-- existed (was a stand-in indicator, not a real recolor) -- the filter alone now does the
-- job, applied to the same base dragon glyph everywhere else uses.
update public.skins
set emoji = '🐉',
    color_filter = 'grayscale(1) sepia(1) hue-rotate(-48deg) saturate(10) brightness(0.8) contrast(1.1)'
where id = 'dragon-red';

create or replace function public.equip_skin(p_skin_id text)
returns void
language plpgsql
as $$
declare
  v_emoji text;
  v_filter text;
  v_price integer;
  v_owns boolean;
begin
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

grant execute on function public.equip_skin(text) to authenticated;
