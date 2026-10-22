-- Adds the Slime Dragon skin: a bright green dragon that leaves a slime trail on the ground
-- wherever it goes (see index.html's dragonIsSlime/spawnSlimePuddle/drawSlimePuddles), the slimy
-- counterpart to Dragon - Red's ember trail. Same shape as dragon-red: the base 🐉 glyph, a
-- color_filter for the emoji fallback (in game and in the menus it draws its own Blender model,
-- frame 16 of props.png), a description line for the shop card, and its $1.99 Stripe Price.
-- Upserts the price and active flag so a re-run (or a row added by hand first) ends up the same.
insert into public.skins (id, name, kind, emoji, price_cents, stripe_price_id, is_default, sort_order,
                          active, color_filter, description) values
  ('dragon-slime', 'Slime Dragon', 'color', '🐉', 199, 'price_1UTTrhILXoyREvpyTqxfGVad', false, 3, true,
   'saturate(2.2) brightness(1.25) hue-rotate(-25deg)',
   'Leaves a trail of slime wherever it goes.')
on conflict (id) do update set
  stripe_price_id = excluded.stripe_price_id,
  active = excluded.active;
