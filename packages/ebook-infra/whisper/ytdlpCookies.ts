import { chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Where the yt-dlp cookie jar lives, resolved from env.
 *
 * WHY THIS EXISTS: YouTube's bot gate ("Sign in to confirm you're not a bot")
 * fires on the *player* request, not the page fetch — a residential proxy can
 * load the watch page fine (verified: HTTP 200, no gate) and still be refused
 * when yt-dlp asks for a format. Authenticated cookies are what clears it, so
 * the Whisper fallback needs a cookie jar on any machine that isn't a laptop
 * with a logged-in browser.
 *
 * Two ways to supply it, checked in order:
 *
 *   YT_DLP_COOKIES_FILE  — a path to a Netscape-format cookies.txt already on
 *                          disk. Right for local dev and for images that mount
 *                          the file in.
 *   YT_DLP_COOKIES_B64   — the same file, base64-encoded. Right for Fly, which
 *                          has secrets but no way to ship a file: the worker
 *                          materializes it to a private temp path at startup.
 *
 * Neither set = no cookies, which still works for videos YouTube doesn't gate.
 *
 * NOT a build-time COPY into the image: a cookie jar is a live credential for a
 * Google account. Baking it into a layer puts it in the registry and in every
 * `docker history`, and it cannot be rotated without a rebuild.
 */

/** Materialized at most once per process — yt-dlp runs many times per book. */
let resolved: string | undefined | null = null;

export function resolveCookiesFile(): string | undefined {
  if (resolved !== null) return resolved;
  return (resolved = materialize());
}

/** Test seam: forget the memoized path so a changed env is picked up. */
export function resetCookiesFileCache(): void {
  resolved = null;
}

function materialize(): string | undefined {
  const explicit = process.env.YT_DLP_COOKIES_FILE?.trim();
  if (explicit) return explicit;

  const encoded = process.env.YT_DLP_COOKIES_B64?.trim();
  if (!encoded) return undefined;

  const path = join(tmpdir(), 'yt-dlp-cookies.txt');
  const contents = Buffer.from(encoded, 'base64').toString('utf8');
  // A cookie jar that doesn't start with the Netscape header is silently
  // ignored by yt-dlp, which then fails with the same bot-gate error as no
  // cookies at all — a mis-encoded secret would look exactly like the bug it
  // was meant to fix, so say so at startup instead.
  if (!contents.includes('# Netscape HTTP Cookie File') && !contents.includes('# HTTP Cookie File')) {
    throw new Error(
      'YT_DLP_COOKIES_B64 did not decode to a Netscape cookies.txt (no header line). ' +
        'Export it with a cookies.txt browser extension and base64 the file verbatim.',
    );
  }
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600); // mode on writeFileSync is ignored if the file already exists
  return path;
}
