-- A short flavor/effect line shown under a skin's name in the shop, for skins whose value isn't
-- obvious from the emoji + color swatch alone -- Dragon - Red's ember trail (see index.html's
-- dragonIsRed/spawnDragonEmber/drawDragonEmbers) is a real, always-on in-game effect, but nothing
-- in the shop card told a buyer that before they paid. Nullable: most skins are a plain recolor
-- with nothing extra to call out, and the shop only renders this line when it's present.
alter table public.skins add column if not exists description text;

update public.skins
set description = 'Leaves a trail of embers while flying.'
where id = 'dragon-red';
