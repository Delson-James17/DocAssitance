-- Run this once in the Supabase SQL Editor (Project > SQL Editor > New query).
-- Sets up the manually-curated Q&A table, plus the RLS policies that let
-- the anon key read/write it. Safe to re-run.

-- Q&A table (question typed in, answer saved verbatim — no document search
-- involved, so there's no risk of an unrelated passage being surfaced
-- instead).
create table if not exists public.qa_entries (
  id uuid primary key default gen_random_uuid(),
  question text not null,
  answer text not null,
  created_at timestamptz not null default now()
);

-- Alternate phrasings for the same question ("Walk me through your resume"
-- for a "Tell me about yourself?" entry) — added after the table already
-- existed for some setups, so this is a migration, not part of the create
-- above. `add column if not exists` is safe to re-run and won't touch
-- existing rows beyond giving them the default empty array.
alter table public.qa_entries
  add column if not exists alternates text[] not null default '{}';

alter table public.qa_entries enable row level security;

drop policy if exists "qa anon select" on public.qa_entries;
create policy "qa anon select" on public.qa_entries
  for select to anon using (true);

drop policy if exists "qa anon insert" on public.qa_entries;
create policy "qa anon insert" on public.qa_entries
  for insert to anon with check (true);

drop policy if exists "qa anon update" on public.qa_entries;
create policy "qa anon update" on public.qa_entries
  for update to anon using (true);

drop policy if exists "qa anon delete" on public.qa_entries;
create policy "qa anon delete" on public.qa_entries
  for delete to anon using (true);

-- If you previously set up an "attachments" Storage bucket for an older
-- version of this app, it's no longer used and can be deleted by hand from
-- the Supabase dashboard (Storage → attachments → Delete bucket) if you
-- want to reclaim the space — this script won't touch it either way.
