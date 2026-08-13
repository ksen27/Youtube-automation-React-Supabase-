import { Result } from '../../domain/shared/Result';
import { VideoId } from '../../domain/video/VideoId';
import { Transcript } from '../../domain/video/Transcript';
import type { VideoRepository } from '../ports/repositories/VideoRepository';
import type { TranscriptProvider } from '../ports/services/TranscriptProvider';
import type { AudioDownloader } from '../ports/services/AudioDownloader';
import type { JobQueue } from '../ports/services/JobQueue';
import type { Hasher } from '../ports/Hasher';
import type { VideoJob } from '../dto/jobs.dto';

export type TranscriptOutcome = 'youtube' | 'pending-whisper' | 'skipped';

/**
 * Transcript API first; Whisper only as fallback.
 * Whisper transcription is NOT done inline — audio is downloaded and a
 * whisper-transcribe job is enqueued, so this worker stays fast and idempotent.
 */
export class FetchTranscriptUseCase {
  constructor(
    private readonly videos: VideoRepository,
    private readonly transcripts: TranscriptProvider,
    private readonly audio: AudioDownloader,
    private readonly queue: JobQueue,
    private readonly hasher: Hasher,
  ) {}

  async execute(cmd: VideoJob): Promise<Result<{ outcome: TranscriptOutcome }>> {
    const video = await this.videos.findById(VideoId.from(cmd.videoId));
    if (!video) return Result.fail('Video not found');
    if (video.hasTranscript()) return Result.ok({ outcome: 'skipped' }); // idempotent

    const fetched = await this.transcripts.fetch(video.youtubeId);
    if (fetched.isFail()) return Result.fail(fetched.error); // transient → retry

    if (fetched.value) {
      const hash = this.hasher.hash({ source: 'youtube', text: fetched.value.text });
      const attach = video.attachTranscript(Transcript.fromYouTube(fetched.value, hash));
      if (attach.isFail()) return Result.fail(attach.error);
      await this.videos.save(video);
      return Result.ok({ outcome: 'youtube' });
    }

    // No captions → download audio + enqueue Whisper fallback.
    const audio = await this.audio.downloadAudio({
      youtubeId: video.youtubeId,
      projectId: cmd.projectId,
      videoId: cmd.videoId,
    });
    if (audio.isFail()) return Result.fail(audio.error);
    video.markAwaitingTranscription(audio.value.audioRef);
    await this.videos.save(video);

    await this.queue.enqueue(
      'whisper-transcribe',
      { projectId: cmd.projectId, videoId: cmd.videoId, audioRef: audio.value.audioRef },
      { jobId: `whisper:${cmd.projectId}:${cmd.videoId}` },
    );
    return Result.ok({ outcome: 'pending-whisper' });
  }
}
