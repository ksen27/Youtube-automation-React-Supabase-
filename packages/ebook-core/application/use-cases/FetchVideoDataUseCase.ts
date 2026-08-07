import { Result } from '../../domain/shared/Result';
import { VideoId } from '../../domain/video/VideoId';
import { Comment } from '../../domain/video/Comment';
import type { VideoRepository } from '../ports/repositories/VideoRepository';
import type { YouTubeMetadataProvider } from '../ports/services/YouTubeMetadataProvider';
import type { JobQueue } from '../ports/services/JobQueue';
import type { VideoJob } from '../dto/jobs.dto';

const TOP_COMMENTS = 100;

/** Enriches a video with metadata + top comments, then enqueues transcript fetch. */
export class FetchVideoDataUseCase {
  constructor(
    private readonly videos: VideoRepository,
    private readonly youtube: YouTubeMetadataProvider,
    private readonly queue: JobQueue,
  ) {}

  async execute(cmd: VideoJob): Promise<Result<void>> {
    const video = await this.videos.findById(VideoId.from(cmd.videoId));
    if (!video) return Result.fail('Video not found');

    if (video.comments.length === 0) {
      const comments = await this.youtube.listTopComments(video.youtubeId, TOP_COMMENTS);
      if (comments.isFail()) return Result.fail(comments.error);
      video.setComments(comments.value.map((c) => Comment.create(c)));
      await this.videos.save(video);
    }

    await this.queue.enqueue(
      'transcript-fetch',
      { projectId: cmd.projectId, videoId: cmd.videoId },
      { jobId: `transcript-fetch:${cmd.projectId}:${cmd.videoId}` },
    );
    return Result.ok();
  }
}
