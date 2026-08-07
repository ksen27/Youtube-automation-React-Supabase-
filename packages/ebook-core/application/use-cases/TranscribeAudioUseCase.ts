import { Result } from '../../domain/shared/Result';
import { VideoId } from '../../domain/video/VideoId';
import { Transcript } from '../../domain/video/Transcript';
import type { VideoRepository } from '../ports/repositories/VideoRepository';
import type { SpeechToText } from '../ports/services/SpeechToText';
import type { ObjectStorage } from '../ports/services/ObjectStorage';
import type { Hasher } from '../ports/Hasher';
import type { WhisperJob } from '../dto/jobs.dto';

const AUDIO_BUCKET = 'audio';

/** Whisper fallback worker — transcribes downloaded audio, then cleans it up. */
export class TranscribeAudioUseCase {
  constructor(
    private readonly videos: VideoRepository,
    private readonly stt: SpeechToText,
    private readonly storage: ObjectStorage,
    private readonly hasher: Hasher,
  ) {}

  async execute(cmd: WhisperJob): Promise<Result<void>> {
    const video = await this.videos.findById(VideoId.from(cmd.videoId));
    if (!video) return Result.fail('Video not found');
    if (video.hasTranscript()) return Result.ok(); // idempotent

    const result = await this.stt.transcribe(cmd.audioRef);
    if (result.isFail()) return Result.fail(result.error);

    const hash = this.hasher.hash({ source: 'whisper', text: result.value.text });
    const attach = video.attachTranscript(
      Transcript.fromWhisper({ ...result.value, audioRef: cmd.audioRef }, hash),
    );
    if (attach.isFail()) return Result.fail(attach.error);
    await this.videos.save(video);

    // Audio is large; remove it once transcribed (best-effort).
    await this.storage.remove(AUDIO_BUCKET, cmd.audioRef);
    return Result.ok();
  }
}
