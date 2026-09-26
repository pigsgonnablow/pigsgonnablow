-- Run after supabase_lockdown_direct_writes.sql, which is where the revoked_at column on
-- owned_skins and the matching equip_skin() ownership-check update actually live (added there,
-- not here, specifically so that file stays self-contained and re-runnable end to end -- see its
-- own comments next to `alter table public.owned_skins add column if not exists revoked_at`).
--
-- Fixes a real gap found in an adversarial security review: stripe-webhook used to *delete* an
-- owned_skins row on a refund/dispute. Stripe retries webhook delivery on anything but a 2xx for
-- up to ~3 days, and the original grant event (checkout.session.completed /
-- async_payment_succeeded) is a plain upsert keyed on (user_id, skin_id) with
-- ignoreDuplicates:true -- so once the row was *gone*, a redelivered/replayed copy of the
-- original grant event lands on an empty primary-key slot and silently re-grants a skin whose
-- payment has since been refunded or disputed. Tombstoning (revoked_at, added in lockdown) plus
-- this conditional grant function closes that gap while still allowing a genuine repurchase
-- after a refund to grant normally.

-- Grant (or restore) ownership after a confirmed Stripe payment. Called by stripe-webhook via
-- its service-role client, which already bypasses RLS entirely -- this function exists only for
-- the conditional upsert logic below, which plain PostgREST upsert() can't express, not for any
-- privilege it grants on top of what the service role already has.
--
-- The one case this refuses to (re-)grant: a row already exists for (user_id, skin_id), it is
-- revoked, AND it was revoked while backed by this *exact* checkout session. That combination
-- only arises from a redelivered/replayed copy of the original grant event arriving *after* the
-- matching refund/dispute already revoked it -- exactly the gap described above. Every other
-- case (no row yet, an active unrevoked row, or a revoked row from a *different* session --
-- i.e. a genuine repurchase) is a legitimate grant/restore and proceeds normally.
create or replace function public.grant_owned_skin(
  p_user_id uuid,
  p_skin_id text,
  p_session_id text,
  p_amount_paid_cents integer,
  p_currency text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.owned_skins (user_id, skin_id, stripe_checkout_session_id, amount_paid_cents, currency, revoked_at)
  values (p_user_id, p_skin_id, p_session_id, p_amount_paid_cents, p_currency, null)
  on conflict (user_id, skin_id) do update
    set stripe_checkout_session_id = excluded.stripe_checkout_session_id,
        amount_paid_cents = excluded.amount_paid_cents,
        currency = excluded.currency,
        purchased_at = now(),
        revoked_at = null
    where not (
      public.owned_skins.revoked_at is not null
      and public.owned_skins.stripe_checkout_session_id = excluded.stripe_checkout_session_id
    );
end;
$$;
-- Only the stripe-webhook Edge Function (service role, which bypasses grants like this
-- entirely) is meant to call this -- revoke explicitly anyway, same defense-in-depth reasoning
-- as the other security-definer functions in supabase_lockdown_direct_writes.sql.
revoke all on function public.grant_owned_skin(uuid, text, text, integer, text) from public, anon, authenticated;
