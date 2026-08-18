-- Adds account support on top of supabase_scores_schema.sql: signed-in players get a
-- single persistent "personal best" row on the scores table instead of a new row per
-- run, keyed to their auth.users id. Anonymous opt-in submission (the original flow)
-- keeps working unchanged for players who don't sign in.

-- One row per account: the display name shown on the leaderboard for that account.
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 12),
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
create policy "profiles_select_own" on public.profiles for select using (auth.uid() = user_id);
create policy "profiles_insert_own" on public.profiles for insert with check (auth.uid() = user_id);
create policy "profiles_update_own" on public.profiles for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Link scores to an account. Nullable so existing/anonymous rows are untouched.
alter table public.scores add column if not exists user_id uuid references auth.users(id) on delete cascade;

-- One row per account -- this is what makes the upsert in submit_personal_best() below
-- overwrite rather than add a new row on every run. Not partial: a plain unique index
-- already allows unlimited NULLs (anonymous rows), since SQL never treats two NULLs as
-- equal for uniqueness -- and ON CONFLICT (user_id) can only infer a plain index anyway
-- (a partial index needs its WHERE clause repeated in the ON CONFLICT target itself).
create unique index if not exists scores_user_id_unique on public.scores(user_id);

-- The original anon insert policy allowed any row; restrict it to true anonymous rows
-- (user_id is null) now that signed-in submissions go through their own policy below.
drop policy if exists "scores_public_insert" on public.scores;
create policy "scores_anon_insert" on public.scores for insert to anon
  with check (user_id is null and score >= 0 and score <= 1000000 and char_length(name) between 1 and 12);

-- Signed-in players may insert/update only their own row (id from the JWT, not client input).
create policy "scores_own_insert" on public.scores for insert to authenticated
  with check (auth.uid() = user_id and score >= 0 and score <= 1000000 and char_length(name) between 1 and 12);
create policy "scores_own_update" on public.scores for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id and score >= 0 and score <= 1000000 and char_length(name) between 1 and 12);

-- Upserts the caller's personal-best row. Runs as the calling user (not security definer),
-- so the RLS policies above are the real enforcement -- this function just supplies the
-- "only overwrite if the new score is higher" logic and pulls the name from the caller's
-- own profile so it can never drift from what they set at signup.
create or replace function public.submit_personal_best(p_score integer)
returns integer
language plpgsql
as $$
declare
  v_name text;
  v_result integer;
begin
  select display_name into v_name from public.profiles where user_id = auth.uid();
  if v_name is null then
    raise exception 'no profile found for this account';
  end if;

  insert into public.scores (user_id, name, score)
  values (auth.uid(), v_name, p_score)
  on conflict (user_id) do update
    set score = excluded.score, name = excluded.name, created_at = now()
    where excluded.score > public.scores.score
  returning score into v_result;

  return v_result; -- null means the existing best was already >= p_score, so nothing changed
end;
$$;

grant execute on function public.submit_personal_best(integer) to authenticated;
