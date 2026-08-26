import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NonRetryableError, Result, type AudioDownloader, type AudioDownloadTarget, type ObjectStorage } from '@ebook/core';
import { youtubeProxyList } from '../net/ProxyRotator';
import { ProxyHealth, classifyProxyFailure, maskProxy, youtubeProxyHealth, type ProxyFailureKind } from '../net/proxyHealth';
import { resolveCookiesFile } from './ytdlpCookies';

/** Trimmed so a wall of yt-dlp stderr can't drown the per-proxy tally. */
const LAST_ERROR_CHARS = 300;

/**
 * A per-proxy account of what went wrong, for the job log and the project's
 * error field. Credentials are masked — these strings are persisted and shown
 * in the UI. Previously only the LAST proxy's stderr survived, which is why a
 * pool-wide auth failure was indistinguishable from one bad proxy.
 */
function summarize(
  failures: Array<{ proxy: string | undefined; kind: ProxyFailureKind; message: string }>,
  skipped = 0,
): string {
  if (failures.length === 0) return 'no attempts were made';
  const tally = new Map<ProxyFailureKind, number>();
  for (const f of failures) tally.set(f.kind, (tally.get(f.kind) ?? 0) + 1);
  const counts = [...tally].map(([kind, n]) => `${kind}: ${n}`).join(', ');
  const perProxy = failures.map((f) => `${maskProxy(f.proxy)} ${f.kind}`).join('; ');
  const last = failures[failures.length - 1]!.message.slice(0, LAST_ERROR_CHARS);
  // Name the quarantined proxies explicitly. Without this the tried-count is
  // smaller than the configured pool for no visible reason — "7 proxies tried"
  // against a pool of 10 reads as a bug in the rotation, when it is three
  // proxies correctly sidelined for returning 407.
  const quarantined = skipped > 0 ? `, ${skipped} skipped (auth-quarantined)` : '';
  return `${failures.length} proxies tried${quarantined} (${counts}) [${perProxy}] — last error: ${last}`;
}

const AUDIO_BUCKET = 'ebook-audio';

/**
 * The storage key for a run's audio — scoped to the project AND video, never to
 * the youtube id alone. See AudioDownloadTarget for why: the Whisper stage
 * deletes the object once it has transcribed it, so a shared key lets one run
 * delete another's audio out from under it.
 */
export function audioRefFor(target: AudioDownloadTarget): string {
  return `${target.projectId}/${target.videoId}.mp3`;
}

/**
 * Downloads a video's audio with yt-dlp, uploads it to storage, returns the ref.
 * Only invoked for videos lacking captions (the Whisper path).
 */
export class YtDlpAudioDownloader implements AudioDownloader {
  // The yt-dlp binary. Defaults to bare `yt-dlp` (resolved via PATH — how the
  // Docker image runs it), but can be overridden with an absolute path via
  // YT_DLP_PATH for environments where it isn't on PATH (e.g. a pyenv-managed
  // install on Windows), mirroring Puppeteer's PUPPETEER_EXECUTABLE_PATH.
  // YouTube increasingly demands authenticated cookies ("Sign in to confirm
  // you're not a bot") for audio downloads. Supply them via either:
  //   YT_DLP_COOKIES_FROM_BROWSER=chrome|edge|firefox  (reads the local browser)
  //   YT_DLP_COOKIES_FILE=/path/to/cookies.txt          (exported Netscape file)
  //   YT_DLP_COOKIES_B64=<base64 of that file>          (for Fly: secrets, no files)
  // All unset = no cookies (works only for videos YouTube doesn't gate).
  // See ytdlpCookies.ts for why the jar is never baked into the image.
  // A proxy routes the download through a different IP to clear YouTube's
  // IP-reputation block. Residential/mobile proxies work best; datacenter ones
  // are often already flagged. Supply ONE via YT_DLP_PROXY, or a POOL via
  // YT_DLP_PROXIES (comma- or newline-separated) — the pool is tried in rotation
  // so a flagged IP is retried on the next proxy. Format per entry:
  // http://user:pass@host:port (or socks5://...).
  private cursor = 0;
  constructor(
    private readonly storage: ObjectStorage,
    private readonly binary: string = process.env.YT_DLP_PATH || 'yt-dlp',
    private readonly cookiesFromBrowser: string | undefined = process.env.YT_DLP_COOKIES_FROM_BROWSER || undefined,
    private readonly cookiesFile: string | undefined = resolveCookiesFile(),
    private readonly proxies: string[] = youtubeProxyList(),
    // ffmpeg/ffprobe do the audio extraction. Defaults to PATH lookup (Docker
    // installs them); set YT_DLP_FFMPEG_LOCATION to the bin folder (or binary)
    // when they aren't on the worker's PATH.
    private readonly ffmpegLocation: string | undefined = process.env.YT_DLP_FFMPEG_LOCATION || undefined,
    // yt-dlp needs a JS runtime (deno) to solve YouTube's player challenge;
    // without one, most downloads get the "confirm you're not a bot" block.
    // Point it at the deno binary when deno isn't on the worker's PATH.
    private readonly denoPath: string | undefined = process.env.YT_DLP_DENO_PATH || undefined,
    // Shared with the rest of the YouTube-facing pipeline: a proxy that rejected
    // our credentials here should not be re-tried elsewhere seconds later.
    private readonly health: ProxyHealth = youtubeProxyHealth,
  ) {}

  async downloadAudio(target: AudioDownloadTarget): Promise<Result<{ audioRef: string }>> {
    const { youtubeId } = target;
    // Temp file keyed by the VIDEO row, not the youtube id: two runs of the same
    // video download concurrently on one worker, and a shared temp path had them
    // overwriting (and deleting) each other's partial file.
    const localPath = join(tmpdir(), `${target.videoId}.mp3`);
    // Try each proxy in turn (a blocked IP is retried on the next one). Rotate the
    // starting proxy per call so sequential videos spread across the pool. With no
    // proxies configured, [undefined] means a single direct attempt.
    const configured = this.proxies.length > 0;
    // Proxies that rejected our credentials recently are skipped rather than
    // re-tried at three yt-dlp retries apiece, once per video.
    const live = configured ? this.health.usable(this.proxies) : [];
    if (configured && live.length === 0) {
      throw new NonRetryableError(
        `every proxy in the pool (${this.proxies.length}) recently rejected authentication — ` +
          'check the proxy account (credentials, quota, IP allow-list). Retrying cannot fix a 407.',
      );
    }
    const skipped = configured ? this.proxies.length - live.length : 0;
    const pool: Array<string | undefined> = configured ? live : [undefined];
    const start = this.cursor++ % pool.length;
    const ordered = pool.map((_, i) => pool[(start + i) % pool.length]);
    const failures: Array<{ proxy: string | undefined; kind: ProxyFailureKind; message: string }> = [];
    try {
      for (const proxy of ordered) {
        try {
          await this.runYtDlp(youtubeId, localPath, proxy);
          const bytes = await readFile(localPath);
          const audioRef = audioRefFor(target);
          const put = await this.storage.put(AUDIO_BUCKET, audioRef, new Uint8Array(bytes), 'audio/mpeg');
          if (put.isFail()) return Result.fail(put.error);
          this.health.clear(proxy); // it works — trust it again
          return Result.ok({ audioRef });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          const kind = classifyProxyFailure(message);
          this.health.record(proxy, kind);
          failures.push({ proxy, kind, message });
          await rm(localPath, { force: true }); // clear any partial file before the next proxy
        }
      }
      // Whole pool exhausted. If EVERY proxy rejected our credentials, the fault
      // is the proxy account, not this video — three more BullMQ attempts would
      // spend minutes reproducing the same 407, so stop now and say why.
      const summary = summarize(failures, skipped);
      if (configured && failures.every((f) => f.kind === 'auth')) {
        throw new NonRetryableError(`proxy pool rejected authentication — ${summary}`);
      }
      return Result.fail(`audio download failed — ${summary}`);
    } finally {
      await rm(localPath, { force: true });
    }
  }

  private runYtDlp(youtubeId: string, output: string, proxy: string | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
      // Encode to 16 kHz mono at 32 kbps. Whisper resamples to 16 kHz mono
      // internally, so this loses no transcription accuracy while shrinking the
      // file ~8x vs the previous quality-5 stereo MP3 — keeping audio under the
      // Whisper API's 25 MB upload cap (which otherwise 413s on ~25 min+ videos).
      const args = [
        '-x',
        '--audio-format', 'mp3',
        '--audio-quality', '32K',
        '--postprocessor-args', 'ffmpeg:-ac 1 -ar 16000',
      ];
      // Route through a proxy to clear YouTube's IP-reputation block when configured.
      if (proxy) args.push('--proxy', proxy);
      // Authenticate to get past YouTube's bot gate when configured.
      if (this.cookiesFromBrowser) args.push('--cookies-from-browser', this.cookiesFromBrowser);
      if (this.cookiesFile) args.push('--cookies', this.cookiesFile);
      // Tell yt-dlp where ffmpeg/ffprobe live when they're not on PATH.
      if (this.ffmpegLocation) args.push('--ffmpeg-location', this.ffmpegLocation);
      // Use deno to solve YouTube's JS challenge (cuts the bot-block rate).
      if (this.denoPath) args.push('--js-runtimes', `deno:${this.denoPath}`);
      // The JS runtime alone is not enough: YouTube also obfuscates the format
      // URLs behind a signature that this remote solver deobfuscates. The video
      // pipeline has passed it since its own bot-gate fix (lib/media/ytdlp.ts)
      // and the ebook path did not — same YouTube, same requirement. That gap is
      // why audio downloads here hit the bot gate while video downloads on the
      // same machine, through the same proxies, succeeded.
      args.push('--remote-components', 'ejs:github');
      args.push('-o', output, `https://www.youtube.com/watch?v=${youtubeId}`);
      const proc = spawn(this.binary, args);
      let stderr = '';
      proc.stderr.on('data', (d) => (stderr += d.toString()));
      proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`yt-dlp exited ${code}: ${stderr}`))));
      proc.on('error', reject);
    });
  }
}
