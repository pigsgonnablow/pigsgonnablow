-- Pulls the Griffin skin from the shop, leaving Dragon (free) and Dragon - Red ($1.99) as the
-- only choices. Deactivating rather than deleting: a couple of test accounts already own it
-- from testing, and owned_skins.skin_id has a foreign key to skins(id) -- deleting the row
-- would break that. `active = false` already hides it everywhere that matters: the shop's
-- catalog query filters on `active`, and equip_skin's own lookup requires it too, so an
-- existing owner can no longer re-equip it either.
update public.skins set active = false where id = 'griffin';
