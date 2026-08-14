-- Leaderboard schema for Pigs Gonna Blow
-- Run this once in the Supabase SQL Editor (dashboard -> SQL Editor -> New query).

create table if not exists public.scores (
  id bigint generated always as identity primary key,
  name text not null check (char_length(name) between 1 and 12),
  score integer not null check (score >= 0 and score <= 1000000),
  created_at timestamptz not null default now()
);

create index if not exists scores_score_idx on public.scores (score desc);

alter table public.scores enable row level security;

-- Anyone (anon key) can read scores, for the leaderboard display.
create policy "scores_public_read" on public.scores
  for select
  using (true);

-- Anyone (anon key) can submit a score, within the check constraints above.
-- No update/delete policy is granted to anon, so the only way to clear the
-- table is via the Supabase dashboard (SQL Editor or Table Editor), which is
-- authenticated as you, the project owner -- that's the "admin clear."
create policy "scores_public_insert" on public.scores
  for insert
  with check (score >= 0 and score <= 1000000 and char_length(name) between 1 and 12);
