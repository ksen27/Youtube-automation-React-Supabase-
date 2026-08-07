import { YoutubeTranscript } from 'youtube-transcript';
import { Result, type TranscriptProvider, type RawTranscript } from '@ebook/core';
import { ProxyRotator, youtubeProxyRotator } from '../net/ProxyRotator';

/** YouTube's per-IP captcha / rate block — distinct from "this video has no captions". */
const BLOCK_PATTERN = /too many requests|captcha|recaptcha|429|forbidden|blocked/i;
/** Definitive "no captions exist" signals — trying other proxies won't change this. */
const NO_CAPTIONS_PATTERN = /disabled|not available|no transcript/i;

/**
 * Tries YouTube captions first, routed through the rotating proxy pool (shared
 * with the yt-dlp audio path via YT_DLP_PROXIES). The scraper hits youtube.com
 * directly, so without proxies every request leaves from one IP and YouTube
 * captcha-blocks it.
 *
 * Within one call we try EVERY proxy in rotation, so a single flagged IP is
 * retried on the next. Outcomes:
 *  - captions found            → Result.ok(transcript)
 *  - definitively no captions  → Result.ok(null)  → Whisper fallback
 *  - ALL proxies captcha/block → Result.ok(null)  → Whisper fallback (last resort, never fail)
 *  - only transient/network    → Result.fail      → BullMQ retries later
 */
export class YouTubeTranscriptProvider implements TranscriptProvider {
  constructor(private readonly proxies: ProxyRotator = youtubeProxyRotator()) {}

  async fetch(videoId: string): Promise<Result<RawTranscript | null>> {
    let sawBlock = false;
    let lastError = 'transcript fetch failed';

    for (const fetchImpl of this.proxies.orderedFetches()) {
      try {
        const items = await YoutubeTranscript.fetchTranscript(videoId, { fetch: fetchImpl });
        if (!items || items.length === 0) return Result.ok(null); // no captions → Whisper
        const segments = items.map((i) => ({ start: i.offset / 1000, duration: i.duration / 1000, text: i.text }));
        return Result.ok({
          language: items[0]?.lang ?? null,
          text: segments.map((s) => s.text).join(' '),
          segments,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Captions genuinely don't exist — no proxy will help; go straight to Whisper.
        if (NO_CAPTIONS_PATTERN.test(msg)) return Result.ok(null);
        if (BLOCK_PATTERN.test(msg)) sawBlock = true;
        lastError = msg; // remember and try the next proxy
      }
    }

    // Every proxy exhausted. If any were captcha/IP-blocked, fall through to the
    // Whisper audio path as a last resort rather than failing the project.
    if (sawBlock) return Result.ok(null);
    // Purely transient (network/proxy-down) with no block seen → let BullMQ retry.
    return Result.fail(lastError);
  }
}
