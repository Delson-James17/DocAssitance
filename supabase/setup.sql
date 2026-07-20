-- Run this once in the Supabase SQL Editor (Project > SQL Editor > New query).
-- Sets up the Storage bucket the app uses for attachments, plus the RLS
-- policies that let the anon key read/write it. Safe to re-run.

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

