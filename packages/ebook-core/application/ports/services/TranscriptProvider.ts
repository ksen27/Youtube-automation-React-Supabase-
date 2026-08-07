import type { Result } from '../../../domain/shared/Result';
import type { TranscriptSegment } from '../../../domain/video/Transcript';

export interface RawTranscript {
  language: string | null;
  text: string;
  segments: TranscriptSegment[];
}

/**
 * YouTube transcript (captions) provider — tried first.
 * Returns Result.ok(null) when no captions exist → triggers the Whisper fallback.
 * Returns Result.fail only on transient/transport errors (retryable).
 */
export interface TranscriptProvider {
  fetch(videoId: string): Promise<Result<RawTranscript | null>>;
}
