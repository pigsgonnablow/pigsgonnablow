-- Denormalizes color_filter onto scores the same way avatar already is, so the leaderboard
-- can show a skin's actual color (not just its base glyph) without joining to profiles.
-- Whatever skin gets added later, as long as it follows the same "base glyph + optional CSS
-- filter" pattern (see supabase_skin_color_filter_schema.sql), this keeps working with no
-- further leaderboard-specific changes.
alter table public.scores add column if not exists color_filter text;

create or replace function public.submit_personal_best(p_score integer)
returns integer
language plpgsql
as $$
declare
  v_name text;
  v_avatar text;
  v_filter text;
  v_result integer;
begin
  select display_name, avatar, color_filter into v_name, v_avatar, v_filter
  from public.profiles where user_id = auth.uid();
  if v_name is null then
    raise exception 'no profile found for this account';
  end if;

  insert into public.scores (user_id, name, avatar, color_filter, score)
  values (auth.uid(), v_name, v_avatar, v_filter, p_score)
  on conflict (user_id) do update
    set score = excluded.score, name = excluded.name, avatar = excluded.avatar,
        color_filter = excluded.color_filter, created_at = now()
    where excluded.score > public.scores.score
  returning score into v_result;

  return v_result; -- null means the existing best was already >= p_score, so nothing changed
end;
$$;

grant execute on function public.submit_personal_best(integer) to authenticated;
