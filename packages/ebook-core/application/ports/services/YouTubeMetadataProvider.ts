import type { Result } from '../../../domain/shared/Result';
import type { ChannelRef } from '../../../domain/channel/ChannelUrl';

export interface ChannelMetadata {
  youtubeId: string;
  title: string;
  description: string | null;
  subscriberCount: number | null;
  videoCount: number | null;
  thumbnailUrl: string | null;
}

export interface VideoMetadata {
  youtubeId: string;
  title: string;
  description: string | null;
  publishedAt: Date | null;
  durationSeconds: number | null;
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
}

export interface RawComment {
  youtubeId: string;
  author: string | null;
  text: string;
  likeCount: number;
  publishedAt: Date | null;
}

export interface YouTubeMetadataProvider {
  resolveChannel(ref: ChannelRef): Promise<Result<ChannelMetadata>>;
  /**
   * Candidate videos with full statistics (views/likes/comments) so the
   * application layer can apply the weighted selection score (Phase 2).
   */
  listVideos(channelId: string, candidateLimit: number): Promise<Result<VideoMetadata[]>>;
  getVideo(videoId: string): Promise<Result<VideoMetadata>>;
  listTopComments(videoId: string, limit: number): Promise<Result<RawComment[]>>;
}
