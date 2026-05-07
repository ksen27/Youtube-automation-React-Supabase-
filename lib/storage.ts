import { promises as fs } from "node:fs";
import path from "node:path";
import { getEnv } from "@/lib/env";
import { getServerSupabase } from "@/lib/supabase/server";

// Thin wrapper around Supabase Storage. The bucket should be created (public)
// in the Supabase dashboard under name SUPABASE_STORAGE_BUCKET.

export interface UploadResult {
  path: string;       // bucket-relative path
  publicUrl: string;  // CDN URL
}

export async function uploadFile(
  localPath: string,
  destPath: string,
  contentType: string
): Promise<UploadResult> {
  const env = getEnv();
  const sb = getServerSupabase();
  const buf = await fs.readFile(localPath);

  const { error } = await sb.storage
    .from(env.SUPABASE_STORAGE_BUCKET)
    .upload(destPath, buf, { contentType, upsert: true });
  if (error) throw new Error(`Storage upload failed (${destPath}): ${error.message}`);

  const { data } = sb.storage.from(env.SUPABASE_STORAGE_BUCKET).getPublicUrl(destPath);
  return { path: destPath, publicUrl: data.publicUrl };
}

export async function uploadBuffer(
  buf: Buffer,
  destPath: string,
  contentType: string
): Promise<UploadResult> {
  const env = getEnv();
  const sb = getServerSupabase();
  const { error } = await sb.storage
    .from(env.SUPABASE_STORAGE_BUCKET)
    .upload(destPath, buf, { contentType, upsert: true });
  if (error) throw new Error(`Storage upload failed (${destPath}): ${error.message}`);
  const { data } = sb.storage.from(env.SUPABASE_STORAGE_BUCKET).getPublicUrl(destPath);
  return { path: destPath, publicUrl: data.publicUrl };
}

// Best-effort delete. Used by the clip pipeline to remove just-uploaded
// objects when the labeler decides the frame was junk after the upload
// already started. Errors are swallowed because cleanup failure should
// never break a clip job — leftover storage is acceptable, lost work
// from a thrown error is not.
export async function removeFiles(destPaths: string[]): Promise<void> {
  if (destPaths.length === 0) return;
  const env = getEnv();
  const sb = getServerSupabase();
  try {
    await sb.storage.from(env.SUPABASE_STORAGE_BUCKET).remove(destPaths);
  } catch {
    /* ignore — best-effort cleanup */
  }
}

export async function downloadToFile(
  storagePath: string,
  destLocalPath: string
): Promise<void> {
  const env = getEnv();
  const sb = getServerSupabase();
  const { data, error } = await sb.storage
    .from(env.SUPABASE_STORAGE_BUCKET)
    .download(storagePath);
  if (error || !data) throw new Error(`Storage download failed (${storagePath}): ${error?.message}`);
  await fs.mkdir(path.dirname(destLocalPath), { recursive: true });
  const arrayBuf = await data.arrayBuffer();
  await fs.writeFile(destLocalPath, Buffer.from(arrayBuf));
}

export function tmpDir(): string {
  return getEnv().TMP_DIR;
}

export async function ensureTmp(sub: string): Promise<string> {
  const dir = path.join(tmpDir(), sub);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function safeUnlink(p: string): Promise<void> {
  try { await fs.unlink(p); } catch { /* ignore */ }
}
