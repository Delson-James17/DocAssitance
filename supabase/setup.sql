-- Run this once in the Supabase SQL Editor (Project > SQL Editor > New query).
-- Sets up the Storage bucket the app uses for attachments and the
-- manually-curated Q&A table, plus the RLS policies that let the anon key
-- read/write both. Safe to re-run.

-- 1. Create the bucket (id must match SUPABASE_BUCKET in .env; default "attachments").
insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', false)
on conflict (id) do nothing;

-- 2. Let the anon key manage objects inside this bucket only.
--    (Skip this section entirely if you're using SUPABASE_SERVICE_ROLE_KEY
--    instead — the service-role key bypasses RLS and doesn't need policies.)
drop policy if exists "attachments anon select" on storage.objects;
create policy "attachments anon select" on storage.objects
  for select to anon using (bucket_id = 'attachments');

drop policy if exists "attachments anon insert" on storage.objects;
create policy "attachments anon insert" on storage.objects
  for insert to anon with check (bucket_id = 'attachments');

drop policy if exists "attachments anon update" on storage.objects;
create policy "attachments anon update" on storage.objects
  for update to anon using (bucket_id = 'attachments');

drop policy if exists "attachments anon delete" on storage.objects;
create policy "attachments anon delete" on storage.objects
  for delete to anon using (bucket_id = 'attachments');

-- 3. Manually-curated Q&A table (question typed in, answer saved verbatim —
--    no document search involved, so there's no risk of an unrelated
--    passage being surfaced instead).
create table if not exists public.qa_entries (
  id uuid primary key default gen_random_uuid(),
  question text not null,
  answer text not null,
  created_at timestamptz not null default now()
);

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

