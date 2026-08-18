-- Adds a simple per-account avatar shown next to the name on the leaderboard. For now
-- this is just a fixed dragon emoji (the game's own character) assigned automatically at
-- signup -- there's no picker yet. It's modeled as its own column specifically so a future
-- color/character picker only has to update this one value per account; nothing else about
-- the leaderboard needs to change shape when that lands.

alter table public.profiles add column if not exists avatar text not null default '🐉' check (char_length(avatar) <= 8);

-- Denormalized copy on scores (same pattern as `name`) so the leaderboard list doesn't need
-- a join to profiles -- kept in sync by submit_personal_best() below. Anonymous rows have no
-- account, so this stays null for them; the client just shows no avatar in that case.
alter table public.scores add column if not exists avatar text;

create or replace function public.submit_personal_best(p_score integer)
returns integer
language plpgsql
as $$
declare
  v_name text;
  v_avatar text;
  v_result integer;
begin
  select display_name, avatar into v_name, v_avatar from public.profiles where user_id = auth.uid();
  if v_name is null then
    raise exception 'no profile found for this account';
  end if;

  insert into public.scores (user_id, name, avatar, score)
  values (auth.uid(), v_name, v_avatar, p_score)
  on conflict (user_id) do update
    set score = excluded.score, name = excluded.name, avatar = excluded.avatar, created_at = now()
    where excluded.score > public.scores.score
  returning score into v_result;

  return v_result; -- null means the existing best was already >= p_score, so nothing changed
end;
$$;

grant execute on function public.submit_personal_best(integer) to authenticated;
