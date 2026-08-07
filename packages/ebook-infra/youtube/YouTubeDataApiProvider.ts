import { google, type youtube_v3 } from 'googleapis';
import {
  Result,
  type YouTubeMetadataProvider,
  type ChannelMetadata,
  type VideoMetadata,
  type RawComment,
  type ChannelRef,
} from '@ebook/core';
import { keepAliveAgent } from '../net/keepAliveAgent';

/** YouTube Data API v3 adapter for channel/video metadata and comments. */
export class YouTubeDataApiProvider implements YouTubeMetadataProvider {
  private readonly yt: youtube_v3.Youtube;

  constructor(apiKey: string) {
    this.yt = google.youtube({ version: 'v3', auth: apiKey, agent: keepAliveAgent });
  }

  async resolveChannel(ref: ChannelRef): Promise<Result<ChannelMetadata>> {
    try {
      const params: youtube_v3.Params$Resource$Channels$List = {
        part: ['snippet', 'statistics'],
      };
      if (ref.kind === 'id') params.id = [ref.value];
      else if (ref.kind === 'handle') params.forHandle = ref.value;
      else params.forUsername = ref.value;

      const { data } = await withRetry(() => this.yt.channels.list(params));
      const ch = data.items?.[0];
      if (!ch?.id) return Result.fail('Channel not found');
      return Result.ok({
        youtubeId: ch.id,
        title: ch.snippet?.title ?? '',
        description: ch.snippet?.description ?? null,
        subscriberCount: numOrNull(ch.statistics?.subscriberCount),
        videoCount: numOrNull(ch.statistics?.videoCount),
        thumbnailUrl: ch.snippet?.thumbnails?.high?.url ?? null,
      });
    } catch (e) {
      return Result.fail(asMessage(e));
    }
  }

  async listVideos(channelId: string, candidateLimit: number): Promise<Result<VideoMetadata[]>> {
    try {
      // search.list is NOT exhaustive — it's relevance-capped and routinely returns
      // far fewer than a channel's real video count (so a 30-video request could only
      // ingest ~15). Enumerate the channel's UPLOADS playlist instead: the complete,
      // paginated video list. selectTopVideos then ranks these by engagement.
      const ch = await withRetry(() => this.yt.channels.list({ part: ['contentDetails'], id: [channelId] }));
      const uploads = ch.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
      if (!uploads) return Result.ok([]);

      const ids: string[] = [];
      let pageToken: string | undefined;
      do {
        const page = await withRetry(() =>
          this.yt.playlistItems.list({
            part: ['contentDetails'],
            playlistId: uploads,
            maxResults: 50,
            ...(pageToken ? { pageToken } : {}),
          }),
        );
        for (const item of page.data.items ?? []) {
          const vid = item.contentDetails?.videoId;
          if (vid) ids.push(vid);
        }
        pageToken = page.data.nextPageToken ?? undefined;
      } while (pageToken && ids.length < candidateLimit);
      if (ids.length === 0) return Result.ok([]);

      // Hydrate snippet/stats in batches of 50 (the videos.list id cap).
      const videos: VideoMetadata[] = [];
      for (let i = 0; i < ids.length; i += 50) {
        const details = await withRetry(() =>
          this.yt.videos.list({ part: ['snippet', 'statistics', 'contentDetails'], id: ids.slice(i, i + 50) }),
        );
        videos.push(...(details.data.items ?? []).map(mapVideo));
      }
      return Result.ok(videos);
    } catch (e) {
      return Result.fail(asMessage(e));
    }
  }

  async getVideo(videoId: string): Promise<Result<VideoMetadata>> {
    try {
      const { data } = await withRetry(() =>
        this.yt.videos.list({ part: ['snippet', 'statistics', 'contentDetails'], id: [videoId] }),
      );
      const v = data.items?.[0];
      if (!v) return Result.fail('Video not found');
      return Result.ok(mapVideo(v));
    } catch (e) {
      return Result.fail(asMessage(e));
    }
  }

  async listTopComments(videoId: string, limit: number): Promise<Result<RawComment[]>> {
    try {
      const { data } = await withRetry(() =>
        this.yt.commentThreads.list({
          part: ['snippet'],
          videoId,
          order: 'relevance',
          maxResults: Math.min(limit, 100),
        }),
      );
      const comments = (data.items ?? []).map((t) => {
        const c = t.snippet?.topLevelComment?.snippet;
        return {
          youtubeId: t.id ?? '',
          author: c?.authorDisplayName ?? null,
          text: c?.textOriginal ?? '',
          likeCount: c?.likeCount ?? 0,
          publishedAt: c?.publishedAt ? new Date(c.publishedAt) : null,
        } satisfies RawComment;
      });
      return Result.ok(comments);
    } catch (e) {
      // Comments are often disabled — treat as empty, not an error.
      return Result.ok([]);
    }
  }
}

function mapVideo(v: youtube_v3.Schema$Video): VideoMetadata {
  return {
    youtubeId: v.id ?? '',
    title: v.snippet?.title ?? '',
    description: v.snippet?.description ?? null,
    publishedAt: v.snippet?.publishedAt ? new Date(v.snippet.publishedAt) : null,
    durationSeconds: parseIsoDuration(v.contentDetails?.duration ?? null),
    viewCount: numOrNull(v.statistics?.viewCount),
    likeCount: numOrNull(v.statistics?.likeCount),
    commentCount: numOrNull(v.statistics?.commentCount),
  };
}

function numOrNull(v: string | null | undefined): number | null {
  return v == null ? null : Number(v);
}

function parseIsoDuration(iso: string | null): number | null {
  if (!iso) return null;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

function asMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Transient network failures worth retrying. These surface from gaxios WITHOUT
 * an HTTP status code (e.g. a body-stream "Premature close" when the connection
 * drops mid-response), so gaxios's own status-based retry never fires on them.
 */
const TRANSIENT_PATTERN = /premature close|ECONNRESET|ETIMEDOUT|socket hang up|EAI_AGAIN|ECONNREFUSED|network|fetch failed/i;

/**
 * Retry a YouTube Data API call on transient network errors with exponential
 * backoff (0.5s, 1s, 2s). Real errors (404, bad key, quota) don't match the
 * pattern and fail fast. BullMQ's job-level retry can't substitute for this: it
 * reuses the same client/connection pool with no backoff, so a dropped socket
 * just fails again immediately.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!TRANSIENT_PATTERN.test(asMessage(e))) throw e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
  throw lastErr;
}
