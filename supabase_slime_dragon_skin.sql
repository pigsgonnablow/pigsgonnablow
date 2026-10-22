-- Adds the Slime Dragon skin: a bright green dragon that leaves a slime trail on the ground
-- wherever it goes (see index.html's dragonIsSlime/spawnSlimePuddle/drawSlimePuddles), the slimy
-- counterpart to Dragon - Red's ember trail. Same shape as dragon-red: the base 🐉 glyph, a
-- color_filter for the emoji fallback (in game and in the menus it draws its own Blender model,
-- frame 16 of props.png), and a description line for the shop card.
--
-- Inserted INACTIVE with no Stripe price: create-checkout refuses a skin without a
-- stripe_price_id, so listing it before one exists would show a BUY button that always fails.
-- Once a $1.99 Price exists in Stripe, put it live with:
--   update public.skins set stripe_price_id = 'price_...', active = true where id = 'dragon-slime';
insert into public.skins (id, name, kind, emoji, price_cents, stripe_price_id, is_default, sort_order,
                          active, color_filter, description) values
  ('dragon-slime', 'Slime Dragon', 'color', '🐉', 199, null, false, 3, false,
   'saturate(2.2) brightness(1.25) hue-rotate(-25deg)',
   'Leaves a trail of slime wherever it goes.')
on conflict (id) do nothing;
