-- Adds the Unicorn Dragon skin: a pink dragon with a golden horn and rainbow mane that leaves a
-- trail of rainbow sprinkles and turns its thrown burgers into nyan cats (see index.html's
-- dragonIsUnicorn/spawnSprinkle/drawNyanBurger). It reuses the base 🐉 Blender model recolored with
-- a canvas filter, so the color_filter below is only the emoji fallback / menu tint.
-- Added inactive with no Stripe price: create a Stripe Price for it, then set stripe_price_id and
-- flip active to true to put it on sale. Admins can equip it meanwhile. Safe to re-run.
insert into public.skins (id, name, kind, emoji, price_cents, stripe_price_id, is_default, sort_order,
                          active, color_filter, description) values
  ('dragon-unicorn', 'Unicorn Dragon', 'color', '🐉', 199, null, false, 4, false,
   'hue-rotate(190deg) saturate(1.1) brightness(1.2)',
   'Leaves a trail of rainbow sprinkles, and turns your burgers into nyan cats.')
on conflict (id) do nothing;
