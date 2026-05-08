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
// as ready-to-pass --proxy URLs. If env is unset/empty, returns []. We pick
// a random entry per yt-dlp invocation so load is spread across the pool —
// reduces the chance any single residential IP gets rate-limited by YouTube.
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

function pickProxy(): string | null {
  const pool = getProxyPool();
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

export interface YtDlpRunOptions {
  url: string;
  outputDir: string;
  videoId: string;
  maxHeight?: number; // default 720
  signal?: AbortSignal;
  onLog?: (line: string) => void;
}

export async function downloadYoutubeVideo(opts: YtDlpRunOptions): Promise<YtDlpDownloadResult> {
  const env = getEnv();
  const maxH = opts.maxHeight ?? 720;
  await fs.mkdir(opts.outputDir, { recursive: true });
  // Output template: <id>.<ext> — yt-dlp picks ext after format selection.
  const outputTemplate = path.join(opts.outputDir, `${opts.videoId}.%(ext)s`);
  // Video-only: the final render uses the project's voiceover; source audio is
  // never used. Skipping audio dramatically reduces failure rate (no separate
  // audio fetch, no ffmpeg merge step) and shrinks the on-disk cache.
  const proxy = pickProxy();
  const args = [
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
  ];

  await runYtDlp(env.YTDLP_PATH, args, env.YTDLP_TIMEOUT_SECONDS, opts.signal, opts.onLog);

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
  const env = getEnv();
  await fs.mkdir(opts.outputDir, { recursive: true });
  const outputTemplate = path.join(opts.outputDir, `${opts.videoId}.%(ext)s`);
  const proxy = pickProxy();
  const args = [
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
  ];
  await runYtDlp(env.YTDLP_PATH, args, env.YTDLP_TIMEOUT_SECONDS, opts.signal, opts.onLog);
  const entries = await fs.readdir(opts.outputDir);
  const found = entries.find((f) => f.startsWith(opts.videoId) && f.endsWith(".m4a"))
    ?? entries.find((f) => f.startsWith(opts.videoId));
  if (!found) throw new Error(`yt-dlp audio finished but no output file found for ${opts.videoId}`);
  return { outputPath: path.join(opts.outputDir, found) };
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
