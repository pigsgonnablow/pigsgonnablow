-- Records what was actually charged for a skin purchase, straight from Stripe's own session
-- data (not the catalog's current price) -- an audit trail independent of whatever the
-- catalog says today, so a later price change can never retroactively make a past purchase
-- look wrong. Populated by supabase/functions/stripe-webhook, nothing else writes here (see
-- owned_skins' RLS in supabase_skins_schema.sql -- no client insert/update policy exists).
alter table public.owned_skins add column if not exists amount_paid_cents integer;
alter table public.owned_skins add column if not exists currency text;
