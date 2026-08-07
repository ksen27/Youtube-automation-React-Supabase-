import type { Result } from '../../../domain/shared/Result';
import type { RawTranscript } from './TranscriptProvider';

/** Whisper fallback — only invoked when no captions are available. */
export interface SpeechToText {
  transcribe(audioRef: string): Promise<Result<RawTranscript>>;
}
