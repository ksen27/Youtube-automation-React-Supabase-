import { spawn } from "node:child_process";
import path from "node:path";
import { promises as fs } from "node:fs";
import { getEnv } from "@/lib/env";

// We always use spawn with an argument array (never shell strings) to prevent
// command injection from upstream values like YouTube IDs or URLs.

export interface YtDlpDownloadResult {
  outputPath: string;
}

// Parse YTDLP_PROXIES once on first read, then cache. Each entry is
// `ip:port:user:pass` (Webshare's list-export format). Returns the proxies
// as ready-to-pass --proxy URLs. If env is unset/empty, returns [].
let cachedProxies: string[] | null = null;
function getProxyPool(): string[] {
  if (cachedProxies) return cachedProxies;
  const raw = getEnv().YTDLP_PROXIES;
  if (!raw) return (cachedProxies = []);
  cachedProxies = raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => {
      const [host, port, user, pass] = line.split(":");
      if (!host || !port || !user || !pass) return null;
      return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
    })
    .filter((v): v is string => v !== null);
  return cachedProxies;
}

// Pick a proxy from the pool, optionally excluding ones already tried in
// this call. Returns null when no usable proxy exists — caller falls back
// to running yt-dlp without --proxy (direct outbound IP).
function pickProxy(excluded: Set<string> = new Set()): string | null {
  const pool = getProxyPool();
  const available = pool.filter((p) => !excluded.has(p));
  if (available.length === 0) return null;
  return available[Math.floor(Math.random() * available.length)];
}

// Errors that indicate the proxy IP got blocked / throttled — retrying
// the same call with a different proxy is likely to succeed. Anything not
// in this list (geo-block, age-gated, private video, format negotiation
// failure) is terminal and rotation won't help, so we surface it
// immediately instead of burning attempts.
function isProxyRelatedError(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return (
    s.includes("sign in to confirm") ||              // YouTube bot challenge
    s.includes("confirm you're not a bot") ||
    s.includes("http error 429") ||                  // rate limit
    s.includes("http error 403") ||                  // forbidden — often proxy-IP-block
    s.includes("too many requests") ||
    s.includes("unable to download webpage") ||      // generic network / blocked
    s.includes("unable to download api page") ||     // YT innertube API via dead proxy
    s.includes("tunnel connection failed") ||        // proxy gateway 502/503 on CONNECT
    s.includes("502 bad gateway") ||
    s.includes("503 service") ||
    s.includes("proxyerror") ||                      // python urllib ProxyError
    s.includes("unable to connect to proxy") ||      // dead/unreachable proxy endpoint
    s.includes("connection reset") ||
    s.includes("operation timed out") ||
    s.includes("read timed out")
  );
}

const YTDLP_MAX_ATTEMPTS = 3;

export interface YtDlpRunOptions {
  url: string;
  outputDir: string;
  videoId: string;
  maxHeight?: number; // default 720
  signal?: AbortSignal;
  onLog?: (line: string) => void;
}

export async function downloadYoutubeVideo(opts: YtDlpRunOptions): Promise<YtDlpDownloadResult> {
  const maxH = opts.maxHeight ?? 720;
  await fs.mkdir(opts.outputDir, { recursive: true });
  // Output template: <id>.<ext> — yt-dlp picks ext after format selection.
  const outputTemplate = path.join(opts.outputDir, `${opts.videoId}.%(ext)s`);
  // Video-only: the final render uses the project's voiceover; source audio is
  // never used. Skipping audio dramatically reduces failure rate (no separate
  // audio fetch, no ffmpeg merge step) and shrinks the on-disk cache.
  await runYtDlpWithProxyRetry({
    buildArgs: (proxy) => [
      "-f", `bestvideo[height<=${maxH}]/best[height<=${maxH}]/bestvideo/best`,
      "--no-playlist",
      "--no-warnings",
      "--no-progress",
      "--no-part",
      "--restrict-filenames",
      "--socket-timeout", "30",
      "--retries", "2",
      "--fragment-retries", "2",
      // YouTube now requires a JS runtime + remote signature solver to deobfuscate
      // download URLs; without these, formats list but downloads fail with a
      // misleading "video not available" error.
      "--js-runtimes", "node",
      "--remote-components", "ejs:github",
      ...(proxy ? ["--proxy", proxy] : []),
      "-o", outputTemplate,
      opts.url,
    ],
    label: `downloadYoutubeVideo[${opts.videoId}]`,
    signal: opts.signal,
    onLog: opts.onLog,
  });

  // After successful run, look for the produced file. With video-only formats
  // the extension can vary (mp4, webm, mkv) — scan the dir.
  const entries = await fs.readdir(opts.outputDir);
  const found = entries.find((f) => f.startsWith(opts.videoId));
  if (!found) throw new Error(`yt-dlp finished but no output file found for ${opts.videoId}`);
  return { outputPath: path.join(opts.outputDir, found) };
}

// Audio-only download. Used by the intro pipeline: the intro clip plays its
// source's original audio (the celebrity speaking) while voiceover is silent
// for the first ~5–6s. We download just the audio track to keep this fast
// and small (~1–3 MB for a 10-min source vs. 30–80 MB for the video).
//
// Output is .m4a (AAC) regardless of source codec — uniform ext keeps the
// downstream ffmpeg-cut step simple.
export async function downloadYoutubeAudio(opts: YtDlpRunOptions): Promise<YtDlpDownloadResult> {
  await fs.mkdir(opts.outputDir, { recursive: true });
  const outputTemplate = path.join(opts.outputDir, `${opts.videoId}.%(ext)s`);
  await runYtDlpWithProxyRetry({
    buildArgs: (proxy) => [
      "-f", "bestaudio[ext=m4a]/bestaudio",
      "-x",                          // extract audio
      "--audio-format", "m4a",
      "--audio-quality", "5",        // 0=best, 9=worst; 5 is plenty for narration
      "--no-playlist",
      "--no-warnings",
      "--no-progress",
      "--no-part",
      "--restrict-filenames",
      "--socket-timeout", "30",
      "--retries", "2",
      "--fragment-retries", "2",
      "--js-runtimes", "node",
      "--remote-components", "ejs:github",
      ...(proxy ? ["--proxy", proxy] : []),
      "-o", outputTemplate,
      opts.url,
    ],
    label: `downloadYoutubeAudio[${opts.videoId}]`,
    signal: opts.signal,
    onLog: opts.onLog,
  });
  const entries = await fs.readdir(opts.outputDir);
  const found = entries.find((f) => f.startsWith(opts.videoId) && f.endsWith(".m4a"))
    ?? entries.find((f) => f.startsWith(opts.videoId));
  if (!found) throw new Error(`yt-dlp audio finished but no output file found for ${opts.videoId}`);
  return { outputPath: path.join(opts.outputDir, found) };
}

// ---------------------------------------------------------------------------
// Search (quota-free fallback for the YouTube Data API)
// ---------------------------------------------------------------------------

// One raw result line from `yt-dlp ytsearchN: --dump-json --flat-playlist`.
// flat-playlist keeps it cheap (no per-video page fetch): we get id/title/
// channel/duration without hydrating each video. Fields are best-effort —
// yt-dlp's flat output omits some depending on the extractor version.
export interface YtDlpSearchResult {
  videoId: string;
  title: string;
  channelId: string | null;
  channelTitle: string | null;
  durationSeconds: number | null;
}

// Search YouTube via yt-dlp instead of the Data API. Costs ZERO API quota —
// this is the fallback for when search.list returns 403 quotaExceeded. It
// scrapes YouTube's search results page, so it's against the Data API ToS and
// more fragile than the official path; callers should prefer the API and only
// reach here when quota is exhausted.
//
// Returns up to `maxResults` results. `channelId`, when set, scopes the search
// to that channel by querying its handle via the ytsearch query — but yt-dlp
// has no reliable channel filter on ytsearch, so channel-scoped fallback is
// best-effort and the caller should filter by channelId afterwards.
export async function searchYoutubeViaYtDlp(
  query: string,
  maxResults = 15,
  signal?: AbortSignal,
): Promise<YtDlpSearchResult[]> {
  const searchSpec = `ytsearch${Math.max(1, Math.min(50, maxResults))}:${query}`;
  const lines: string[] = [];
  let buffer = "";
  await runYtDlpWithProxyRetry({
    buildArgs: (proxy) => [
      "--dump-json",
      "--flat-playlist",
      "--no-warnings",
      "--no-progress",
      "--ignore-errors",
      "--socket-timeout", "30",
      ...(proxy ? ["--proxy", proxy] : []),
      searchSpec,
    ],
    label: `searchYoutubeViaYtDlp[${query.slice(0, 40)}]`,
    signal,
    onLog: (chunk) => {
      // --dump-json emits one JSON object per line on stdout. Accumulate and
      // split on newlines; a trailing partial line is kept in `buffer`.
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.startsWith("{")) lines.push(line);
      }
    },
  });
  if (buffer.trim().startsWith("{")) lines.push(buffer.trim());

  const out: YtDlpSearchResult[] = [];
  for (const line of lines) {
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(line); } catch { continue; }
    const id = typeof obj.id === "string" ? obj.id : null;
    if (!id) continue;
    const dur = typeof obj.duration === "number" ? obj.duration : null;
    out.push({
      videoId: id,
      title: typeof obj.title === "string" ? obj.title : "",
      channelId: typeof obj.channel_id === "string" ? obj.channel_id
               : typeof obj.uploader_id === "string" ? obj.uploader_id : null,
      channelTitle: typeof obj.channel === "string" ? obj.channel
                  : typeof obj.uploader === "string" ? obj.uploader : null,
      durationSeconds: dur,
    });
  }
  return out;
}

// Run yt-dlp with proxy rotation on retry. The build callback receives the
// proxy URL (or null when the pool is empty) and returns the arg list — that
// lets each attempt swap the --proxy flag without rebuilding the rest of
// the call site. We retry only on errors that look proxy/network-related
// (see isProxyRelatedError); terminal failures surface immediately so the
// caller doesn't burn attempts on un-retryable problems.
//
// This mirrors what the BullMQ download queue does at job level (3 attempts,
// each picks a random proxy) but does it inside one yt-dlp call so the intro
// audio path — which isn't its own queued job — gets the same protection.
async function runYtDlpWithProxyRetry(opts: {
  buildArgs: (proxy: string | null) => string[];
  label: string;
  signal?: AbortSignal;
  onLog?: (line: string) => void;
}): Promise<void> {
  const env = getEnv();
  const pool = getProxyPool();
  const maxAttempts = pool.length > 0 ? Math.min(YTDLP_MAX_ATTEMPTS, pool.length) : 1;
  const tried = new Set<string>();
  let lastErr: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const proxy = pickProxy(tried);
    if (proxy) tried.add(proxy);
    const args = opts.buildArgs(proxy);
    try {
      await runYtDlp(env.YTDLP_PATH, args, env.YTDLP_TIMEOUT_SECONDS, opts.signal, opts.onLog);
      return;
    } catch (err) {
      lastErr = err as Error;
      const stderr = lastErr.message;
      // Bail on un-retryable errors so we don't waste proxies on, e.g.,
      // a private video that returns the same error from every IP.
      if (!isProxyRelatedError(stderr)) throw lastErr;
      // Drop the proxy pool cache hint by logging which one failed —
      // mostly useful when debugging which IP got blocked.
      opts.onLog?.(`[${opts.label}] attempt ${attempt}/${maxAttempts} failed via ${proxy ?? "direct"}, rotating proxy\n`);
    }
  }

  throw new Error(
    `yt-dlp failed after ${maxAttempts} attempt(s) with proxy rotation: ${lastErr?.message ?? "unknown"}`,
  );
}

function runYtDlp(
  bin: string,
  args: string[],
  timeoutSeconds: number,
  signal: AbortSignal | undefined,
  onLog?: (line: string) => void
): Promise<void> {
  // Mirror the ffmpeg approach: nice down yt-dlp on Linux so its JS-runtime
  // and remote-component fetches don't starve Redis on shared-CPU hosts.
  const niceLevel = getEnv().NICE_LEVEL;
  const useNice = niceLevel > 0 && process.platform === "linux";
  const finalBin = useNice ? "nice" : bin;
  const finalArgs = useNice ? ["-n", String(niceLevel), bin, ...args] : args;
  return new Promise((resolve, reject) => {
    const child = spawn(finalBin, finalArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutSeconds * 1000);

    child.stdout.on("data", (chunk) => { onLog?.(chunk.toString()); });
    child.stderr.on("data", (chunk) => {
      const s = chunk.toString();
      stderr += s;
      onLog?.(s);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`yt-dlp timed out after ${timeoutSeconds}s`));
      else if (code === 0) resolve();
      else reject(new Error(`yt-dlp exited ${code}: ${stderr.slice(-2000)}`));
    });
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      child.kill("SIGKILL");
    });
  });
}
