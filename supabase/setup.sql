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

-- Quick-recall key: a single character (a digit 0-9 or a letter a-z).
-- Pressing that key in the app instantly shows this entry's answer,
-- bypassing voice/typed matching entirely — a manual fallback for the
-- questions you most need on hand. Nullable, no default, since most entries
-- won't have one; the app enforces "at most one entry per key" itself
-- rather than a DB constraint.
alter table public.qa_entries
  add column if not exists hotkey text;

-- Earlier versions stored the hotkey as a `smallint` (digits 1-9 only).
-- Widening it to `text` is what lets letters be assigned too; converting in
-- place keeps whatever numbers were already assigned working, since "7"
-- as text is still the 7 key. No-op once the column is already text, so
-- this stays safe to re-run alongside the rest of the script.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'qa_entries'
      and column_name = 'hotkey'
      and data_type <> 'text'
  ) then
    alter table public.qa_entries
      alter column hotkey type text using hotkey::text;
  end if;
end $$;

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
