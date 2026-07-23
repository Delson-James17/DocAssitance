import { supabase, supabaseEnabled } from "./supabase.client.js";
import { config } from "../config.js";

const BUCKET = config.supabase.bucket;

// A file lives at `${id}/${encodeURIComponent(name)}` — one object per
// attachment "folder", so renaming (moving to a new key) can't collide with
// another attachment, and deleting is a single object removal.
function keyFor(id, name) {
  return `${id}/${encodeURIComponent(name)}`;
}

/**
 * Checks the bucket is actually usable before ever trying to create it —
 * an anon key normally can't create buckets (blocked by RLS), so attempting
 * creation unconditionally logs a scary-looking warning on every single
 * startup even when the bucket already exists and everything works fine.
 * Only warns if the bucket turns out to be genuinely inaccessible.
 */
async function ensureBucket() {
  if (!supabaseEnabled) return;

  const { error: listErr } = await supabase.storage.from(BUCKET).list("", { limit: 1 });
  if (!listErr) return; // already exists and reachable — nothing to do

  const { error: createErr } = await supabase.storage.createBucket(BUCKET, {
    public: false,
  });
  if (createErr && !/already exists/i.test(createErr.message)) {
    console.warn(
      `[storage] Supabase bucket "${BUCKET}" isn't reachable (${listErr.message}) and ` +
        `couldn't be auto-created (${createErr.message}). Run supabase/setup.sql in the ` +
        `Supabase SQL Editor, or create the bucket by hand (Storage → New bucket).`,
    );
  }
}

/**
 * Lists every stored attachment by walking the bucket's id folders.
 * Returns `[{ id, name, mimetype, size, buffer }]`.
 */
async function listAll() {
  if (!supabaseEnabled) return [];

  const { data: folders, error } = await supabase.storage
    .from(BUCKET)
    .list("", { limit: 1000 });
  if (error) throw new Error(`Supabase list failed: ${error.message}`);

  const results = [];
  for (const folder of folders ?? []) {
    // Only real subfolders (attachment ids) represent stored files.
    if (folder.id !== null) continue;

    const { data: files, error: innerErr } = await supabase.storage
      .from(BUCKET)
      .list(folder.name, { limit: 10 });
    if (innerErr || !files?.length) continue;

    // Once a folder's one real object is deleted, Supabase drops in a
    // ".emptyFolderPlaceholder" marker so the now-empty folder still shows
    // up in the dashboard — it's bucket housekeeping, not an attachment, so
    // treat a folder that holds only that marker as deleted, not present.
    const file = files.find((f) => f.name !== ".emptyFolderPlaceholder");
    if (!file) continue;
    const path = `${folder.name}/${file.name}`;
    const { data: blob, error: dlErr } = await supabase.storage
      .from(BUCKET)
      .download(path);
    if (dlErr) continue;

    results.push({
      id: folder.name,
      name: decodeURIComponent(file.name),
      mimetype: file.metadata?.mimetype || "application/octet-stream",
      size: file.metadata?.size ?? blob.size,
      buffer: Buffer.from(await blob.arrayBuffer()),
      createdAt: file.created_at ?? null,
    });
  }

  results.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  return results;
}

async function upload({ id, name, mimetype, buffer }) {
  if (!supabaseEnabled) return;
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(keyFor(id, name), buffer, { contentType: mimetype, upsert: true });
  if (error) throw new Error(`Supabase upload failed: ${error.message}`);
}

async function rename({ id, oldName, newName }) {
  if (!supabaseEnabled) return;
  const { error } = await supabase.storage
    .from(BUCKET)
    .move(keyFor(id, oldName), keyFor(id, newName));
  if (error) throw new Error(`Supabase rename failed: ${error.message}`);
}

async function remove({ id, name }) {
  if (!supabaseEnabled) return;
  const { error } = await supabase.storage
    .from(BUCKET)
    .remove([keyFor(id, name)]);
  if (error) throw new Error(`Supabase delete failed: ${error.message}`);
}

async function removeAll() {
  if (!supabaseEnabled) return;
  const all = await listAll();
  const keys = all.map((a) => keyFor(a.id, a.name));
  if (keys.length === 0) return;
  const { error } = await supabase.storage.from(BUCKET).remove(keys);
  if (error) throw new Error(`Supabase clear failed: ${error.message}`);
}

export const storage = {
  enabled: supabaseEnabled,
  ensureBucket,
  listAll,
  upload,
  rename,
  remove,
  removeAll,
};
