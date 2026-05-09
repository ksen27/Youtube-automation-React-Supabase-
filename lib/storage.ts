import { promises as fs, createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { Agent as HttpsAgent } from "node:https";
import path from "node:path";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NodeHttpHandler } from "@smithy/node-http-handler";
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

// Single keep-alive agent shared by every S3 call. Without this, each
// upload/download pays a fresh TLS handshake (~100–300ms) — for a clip job
// doing dozens of uploads that adds 3–10s of pure overhead. maxSockets caps
// the per-host concurrency so a runaway never exhausts file descriptors.
const keepAliveAgent = new HttpsAgent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 64,
});

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
    requestHandler: new NodeHttpHandler({
      httpsAgent: keepAliveAgent,
      connectionTimeout: 5_000,
      socketTimeout: 60_000,
    }),
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
  const env = getEnv();
  // Stream the file from disk instead of loading it into memory. With
  // CLIP_PIPELINE_CONCURRENCY lanes uploading in parallel, the buffered
  // version held N×file-size in RAM at peak — on the 2GB Fly worker that
  // pushed past safe limits and triggered GC pressure. ContentLength is
  // required so S3 can size the request without buffering on its side.
  const stat = await fs.stat(localPath);
  await getR2().send(new PutObjectCommand({
    Bucket: env.R2_BUCKET,
    Key: destPath,
    Body: createReadStream(localPath),
    ContentLength: stat.size,
    ContentType: contentType,
  }));
  return { path: destPath, publicUrl: publicUrlFor(destPath) };
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
  // Pipe the response body straight to disk. The previous implementation
  // collected every chunk into an in-memory array and only wrote at the
  // end — for a 200–500MB source on a 2GB Fly machine that allocated 2×
  // the file size (chunks + Buffer.concat) and starved everything else.
  // With pipeline, peak memory stays at the stream's high-water-mark
  // (~64KB) and the disk write happens concurrently with the network read.
  await pipeline(
    res.Body as Readable,
    createWriteStream(destLocalPath),
  );
}

// Presigned PUT URL for browser-direct uploads. Returns a URL the client can
// PUT the file body to without proxying through our server. We use this for
// large uploads (voiceover audio) that exceed Vercel's ~4.5MB request body
// limit. The bucket key is decided server-side so callers can't overwrite
// arbitrary objects. The browser must send the same Content-Type the URL
// was signed with, otherwise R2 rejects the PUT with SignatureDoesNotMatch.
export async function presignPutUrl(
  destPath: string,
  contentType: string,
  expiresInSeconds: number = 900,
): Promise<{ url: string; path: string; publicUrl: string }> {
  const env = getEnv();
  const cmd = new PutObjectCommand({
    Bucket: env.R2_BUCKET,
    Key: destPath,
    ContentType: contentType,
  });
  const url = await getSignedUrl(getR2(), cmd, { expiresIn: expiresInSeconds });
  return { url, path: destPath, publicUrl: publicUrlFor(destPath) };
}

// Verify an object exists and return its size. Used after a presigned upload
// to confirm the client actually wrote something before we run downstream
// processing on it.
export async function headObject(
  storagePath: string,
): Promise<{ size: number; contentType?: string } | null> {
  const env = getEnv();
  try {
    const res = await getR2().send(new HeadObjectCommand({
      Bucket: env.R2_BUCKET,
      Key: storagePath,
    }));
    return {
      size: Number(res.ContentLength ?? 0),
      contentType: res.ContentType,
    };
  } catch {
    return null;
  }
}

export function publicUrlForKey(key: string): string {
  return publicUrlFor(key);
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
