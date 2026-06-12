// Persistent per-clip render cache.
//
// Why this exists: a render normalizes ~400 clips (each a libx264 pass) before
// the merge/concat stage. If the worker restarts mid-render — Fly machine
// reboot, OOM kill, redeploy — BullMQ retries the job from the top and, with
// outputs living in ephemeral /tmp, every clip is re-encoded from scratch. On a
// big project that's 10+ minutes of wasted work per restart, and a flaky host
// can loop indefinitely.
//
// The fix: write each normalized clip to a DURABLE location (the /data mount on
// the worker) keyed by a hash of the inputs that determine its bytes. On retry,
// a clip whose cache entry exists AND passes an ffprobe integrity check is
// reused instead of re-rendered. A half-written file from a crash fails the
// probe and is re-rendered, so correctness is preserved.

import path from "node:path";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { getEnv } from "@/lib/env";
import { probeFile } from "@/lib/media/probe";

// Per-clip durations the render loop computes inside each branch. Cached
// alongside the mp4 so a resumed render restores the timeline arithmetic
// without re-deriving it.
export interface CachedClipMeta {
  slotDuration: number;
  slotContentDuration: number;
  // The probed duration the cache was written with — used as a sanity bound on
  // reuse so a truncated file (probed dur wildly different) is rejected.
  probedDuration: number;
}

function cacheRoot(): string {
  return getEnv().RENDER_CACHE_DIR;
}

export function projectCacheDir(projectId: string): string {
  return path.join(cacheRoot(), projectId);
}

// Deterministic key from the inputs that fully determine a clip's bytes. Any
// change to source, timing, lower-third, or dimensions yields a new key, so a
// re-run with an edited timeline never reuses a stale clip.
export function clipCacheKey(parts: {
  itemId: string | null | undefined;
  index: number;
  type: string;
  signature: Record<string, unknown>;
}): string {
  const h = createHash("sha256");
  h.update(JSON.stringify({
    id: parts.itemId ?? null,
    i: parts.index,
    t: parts.type,
    sig: parts.signature,
  }));
  return h.digest("hex").slice(0, 32);
}

function pathsFor(projectId: string, key: string): { mp4: string; json: string } {
  const dir = projectCacheDir(projectId);
  return { mp4: path.join(dir, `${key}.mp4`), json: path.join(dir, `${key}.json`) };
}

// Look up a cached clip. Returns null on any miss reason — missing files, a
// half-written mp4 that fails ffprobe, or unreadable sidecar metadata — so the
// caller simply re-renders. Never throws.
export async function lookupCachedClip(
  projectId: string,
  key: string,
): Promise<{ mp4Path: string; meta: CachedClipMeta } | null> {
  const { mp4, json } = pathsFor(projectId, key);
  try {
    const metaRaw = await fs.readFile(json, "utf8");
    const meta = JSON.parse(metaRaw) as CachedClipMeta;
    const stat = await fs.stat(mp4);
    if (stat.size <= 0) return null;
    // Integrity gate: a crash mid-encode leaves a partial mp4. Probing it
    // forces a real demux; a truncated/corrupt file throws or returns a
    // duration that disagrees with what we wrote, and we reject it.
    const probed = await probeFile(mp4);
    if (!(probed.durationSeconds > 0)) return null;
    const expected = meta.probedDuration;
    if (expected > 0 && Math.abs(probed.durationSeconds - expected) > 0.5) return null;
    return { mp4Path: mp4, meta };
  } catch {
    return null;
  }
}

// Persist a freshly-rendered clip into the cache. Best-effort: a cache write
// failure must never fail the render (the clip is already produced in tmp), so
// errors are swallowed. Writes the mp4 first, then the sidecar — readers key
// off the sidecar, so a crash between the two just looks like a miss.
export async function storeCachedClip(
  projectId: string,
  key: string,
  producedMp4Path: string,
  meta: CachedClipMeta,
): Promise<void> {
  try {
    const dir = projectCacheDir(projectId);
    await fs.mkdir(dir, { recursive: true });
    const { mp4, json } = pathsFor(projectId, key);
    // Copy (not rename) — producedMp4Path lives in tmp and the render still
    // reads from there for the merge stage. Copy to a temp name then rename so
    // a reader never sees a partial cache mp4.
    const tmpMp4 = `${mp4}.partial`;
    await fs.copyFile(producedMp4Path, tmpMp4);
    await fs.rename(tmpMp4, mp4);
    await fs.writeFile(json, JSON.stringify(meta));
  } catch {
    /* best-effort cache write */
  }
}

// Delete a project's whole cache directory. Called after the final video
// uploads successfully — at that point the cache has served its purpose.
export async function clearProjectCache(projectId: string): Promise<void> {
  try {
    await fs.rm(projectCacheDir(projectId), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// Periodic safety net: delete cache entries older than the TTL so caches from
// abandoned/failed projects don't accumulate on the volume. Returns the number
// of project dirs removed. Never throws.
export async function sweepRenderCache(): Promise<number> {
  const root = cacheRoot();
  const ttlMs = getEnv().RENDER_CACHE_TTL_HOURS * 60 * 60 * 1000;
  const cutoff = Date.now() - ttlMs;
  let removed = 0;
  let entries: string[] = [];
  try {
    entries = await fs.readdir(root);
  } catch {
    return 0; // cache root doesn't exist yet
  }
  for (const name of entries) {
    const dir = path.join(root, name);
    try {
      const stat = await fs.stat(dir);
      if (!stat.isDirectory()) continue;
      if (stat.mtimeMs < cutoff) {
        await fs.rm(dir, { recursive: true, force: true });
        removed++;
      }
    } catch {
      /* ignore individual dir errors */
    }
  }
  return removed;
}
