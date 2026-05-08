import { promises as fs } from "node:fs";
import path from "node:path";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import { getEnv } from "@/lib/env";

// Storage layer backed by Cloudflare R2 (S3-compatible).
// The bucket should be public — either via the r2.dev subdomain or a custom
// domain — and R2_PUBLIC_BASE_URL must point at it (no trailing slash).
// publicUrl is built as `${R2_PUBLIC_BASE_URL}/${key}` so callers can
// reference uploaded objects directly without round-tripping through R2.

export interface UploadResult {
  path: string;       // bucket key (no leading slash)
  publicUrl: string;  // CDN URL
}

let cachedClient: S3Client | null = null;
function getR2(): S3Client {
  if (cachedClient) return cachedClient;
  const env = getEnv();
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    throw new Error("R2 not configured: set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY");
  }
  cachedClient = new S3Client({
    region: "auto",
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });
  return cachedClient;
}

function publicUrlFor(key: string): string {
  const env = getEnv();
  if (!env.R2_PUBLIC_BASE_URL) {
    throw new Error("R2_PUBLIC_BASE_URL is not set — cannot build public URL");
  }
  return `${env.R2_PUBLIC_BASE_URL}/${key}`;
}

export async function uploadFile(
  localPath: string,
  destPath: string,
  contentType: string
): Promise<UploadResult> {
  const buf = await fs.readFile(localPath);
  return uploadBuffer(buf, destPath, contentType);
}

export async function uploadBuffer(
  buf: Buffer,
  destPath: string,
  contentType: string
): Promise<UploadResult> {
  const env = getEnv();
  await getR2().send(new PutObjectCommand({
    Bucket: env.R2_BUCKET,
    Key: destPath,
    Body: buf,
    ContentType: contentType,
  }));
  return { path: destPath, publicUrl: publicUrlFor(destPath) };
}

// Best-effort delete. Used by the clip pipeline to remove just-uploaded
// objects when the labeler decides the frame was junk after the upload
// already started. Errors are swallowed because cleanup failure should
// never break a clip job — leftover storage is acceptable, lost work
// from a thrown error is not.
export async function removeFiles(destPaths: string[]): Promise<void> {
  if (destPaths.length === 0) return;
  const env = getEnv();
  try {
    await getR2().send(new DeleteObjectsCommand({
      Bucket: env.R2_BUCKET,
      Delete: { Objects: destPaths.map((Key) => ({ Key })) },
    }));
  } catch {
    /* ignore — best-effort cleanup */
  }
}

export async function downloadToFile(
  storagePath: string,
  destLocalPath: string
): Promise<void> {
  const env = getEnv();
  const res = await getR2().send(new GetObjectCommand({
    Bucket: env.R2_BUCKET,
    Key: storagePath,
  }));
  if (!res.Body) throw new Error(`Storage download failed (${storagePath}): empty body`);
  await fs.mkdir(path.dirname(destLocalPath), { recursive: true });
  // Body is a stream in Node — collect it into a buffer.
  const chunks: Buffer[] = [];
  for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  await fs.writeFile(destLocalPath, Buffer.concat(chunks));
}

// Used by the settings status route to confirm R2 credentials work and the
// bucket exists. HeadBucket returns 200 only when the key has access.
export async function checkR2Health(): Promise<boolean> {
  const env = getEnv();
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) return false;
  try {
    await getR2().send(new HeadBucketCommand({ Bucket: env.R2_BUCKET }));
    return true;
  } catch {
    return false;
  }
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
