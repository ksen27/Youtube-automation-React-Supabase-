import { Result } from '../../domain/shared/Result';
import { VideoId } from '../../domain/video/VideoId';
import { Transcript } from '../../domain/video/Transcript';
import type { VideoRepository } from '../ports/repositories/VideoRepository';
import type { SpeechToText } from '../ports/services/SpeechToText';
import type { ObjectStorage } from '../ports/services/ObjectStorage';
import type { AudioDownloader } from '../ports/services/AudioDownloader';
import type { Hasher } from '../ports/Hasher';
import type { WhisperJob } from '../dto/jobs.dto';

const AUDIO_BUCKET = 'ebook-audio';

/** Whisper fallback worker — transcribes downloaded audio, then cleans it up. */
export class TranscribeAudioUseCase {
  constructor(
    private readonly videos: VideoRepository,
    private readonly stt: SpeechToText,
    private readonly storage: ObjectStorage,
    private readonly hasher: Hasher,
    private readonly audio: AudioDownloader,
  ) {}

  async execute(cmd: WhisperJob): Promise<Result<void>> {
    const video = await this.videos.findById(VideoId.from(cmd.videoId));
    if (!video) return Result.fail('Video not found');
    if (video.hasTranscript()) return Result.ok(); // idempotent

    // The audio can be gone before we get here — this stage deletes it on
    // success, and a job can be replayed (retry endpoint, stalled-job recovery)
    // after a sibling attempt already cleaned up. Signing a URL for a missing
    // object fails with a flat "Object not found", which no number of retries
    // fixes, so rebuild it instead of burning the attempts and failing the book.
    const audioRef = await this.ensureAudio(cmd, video.youtubeId);
    if (audioRef.isFail()) return Result.fail(audioRef.error);

    const result = await this.stt.transcribe(audioRef.value);
    if (result.isFail()) return Result.fail(result.error);

    const hash = this.hasher.hash({ source: 'whisper', text: result.value.text });
    const attach = video.attachTranscript(
      Transcript.fromWhisper({ ...result.value, audioRef: audioRef.value }, hash),
    );
    if (attach.isFail()) return Result.fail(attach.error);
    // Throws if the transcript row didn't land — the delete below must never run
    // against an unpersisted transcript, or the retry finds neither.
    await this.videos.save(video);

    // Audio is large; remove it once transcribed (best-effort).
    await this.storage.remove(AUDIO_BUCKET, audioRef.value);
    return Result.ok();
  }

  /** The job's audioRef if it's still in storage, otherwise a freshly downloaded one. */
  private async ensureAudio(cmd: WhisperJob, youtubeId: string): Promise<Result<string>> {
    if (await this.storage.exists(AUDIO_BUCKET, cmd.audioRef)) return Result.ok(cmd.audioRef);
    const again = await this.audio.downloadAudio({
      youtubeId,
      projectId: cmd.projectId,
      videoId: cmd.videoId,
    });
    if (again.isFail()) return Result.fail(`audio missing and re-download failed: ${again.error}`);
    return Result.ok(again.value.audioRef);
  }
}
