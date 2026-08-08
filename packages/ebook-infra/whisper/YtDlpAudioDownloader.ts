import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Result, type AudioDownloader, type ObjectStorage } from '@ebook/core';
import { youtubeProxyList } from '../net/ProxyRotator';

const AUDIO_BUCKET = 'ebook-audio';

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
  // Both unset = no cookies (works only for videos YouTube doesn't gate).
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
    private readonly cookiesFile: string | undefined = process.env.YT_DLP_COOKIES_FILE || undefined,
    private readonly proxies: string[] = youtubeProxyList(),
    // ffmpeg/ffprobe do the audio extraction. Defaults to PATH lookup (Docker
    // installs them); set YT_DLP_FFMPEG_LOCATION to the bin folder (or binary)
    // when they aren't on the worker's PATH.
    private readonly ffmpegLocation: string | undefined = process.env.YT_DLP_FFMPEG_LOCATION || undefined,
    // yt-dlp needs a JS runtime (deno) to solve YouTube's player challenge;
    // without one, most downloads get the "confirm you're not a bot" block.
    // Point it at the deno binary when deno isn't on the worker's PATH.
    private readonly denoPath: string | undefined = process.env.YT_DLP_DENO_PATH || undefined,
  ) {}

  async downloadAudio(youtubeId: string): Promise<Result<{ audioRef: string }>> {
    const localPath = join(tmpdir(), `${youtubeId}.mp3`);
    // Try each proxy in turn (a blocked IP is retried on the next one). Rotate the
    // starting proxy per call so sequential videos spread across the pool. With no
    // proxies configured, [undefined] means a single direct attempt.
    const pool = this.proxies.length ? this.proxies : [undefined];
    const start = this.cursor++ % pool.length;
    const ordered = pool.map((_, i) => pool[(start + i) % pool.length]);
    let lastError = 'audio download failed';
    try {
      for (const proxy of ordered) {
        try {
          await this.runYtDlp(youtubeId, localPath, proxy);
          const bytes = await readFile(localPath);
          const audioRef = `${youtubeId}.mp3`;
          const put = await this.storage.put(AUDIO_BUCKET, audioRef, new Uint8Array(bytes), 'audio/mpeg');
          if (put.isFail()) return Result.fail(put.error);
          return Result.ok({ audioRef });
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
          await rm(localPath, { force: true }); // clear any partial file before the next proxy
        }
      }
      return Result.fail(lastError);
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
      args.push('-o', output, `https://www.youtube.com/watch?v=${youtubeId}`);
      const proc = spawn(this.binary, args);
      let stderr = '';
      proc.stderr.on('data', (d) => (stderr += d.toString()));
      proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`yt-dlp exited ${code}: ${stderr}`))));
      proc.on('error', reject);
    });
  }
}
