import OpenAI from 'openai';
import { Result, type SpeechToText, type RawTranscript, type ObjectStorage } from '@ebook/core';
import { keepAliveAgent } from '../net/keepAliveAgent';

const AUDIO_BUCKET = 'ebook-audio';

/**
 * Whisper fallback. Downloads the audio object from storage and sends it to the
 * Whisper API. Swap this adapter for a self-hosted faster-whisper HTTP service
 * without touching the application layer.
 */
export class WhisperSpeechToText implements SpeechToText {
  constructor(
    private readonly client: OpenAI,
    private readonly storage: ObjectStorage,
  ) {}

  static fromApiKey(apiKey: string, storage: ObjectStorage): WhisperSpeechToText {
    return new WhisperSpeechToText(new OpenAI({ apiKey, httpAgent: keepAliveAgent }), storage);
  }

  async transcribe(audioRef: string): Promise<Result<RawTranscript>> {
    try {
      const url = await this.storage.signedUrl(AUDIO_BUCKET, audioRef, 600);
      if (url.isFail()) return Result.fail(url.error);
      const file = await fetch(url.value);
      if (!file.ok) return Result.fail(`Failed to fetch audio: ${file.status}`);

      const transcription = await this.client.audio.transcriptions.create({
        model: 'whisper-1',
        file: new File([await file.blob()], 'audio.mp3', { type: 'audio/mpeg' }),
        response_format: 'verbose_json',
        timestamp_granularities: ['segment'],
      });

      const verbose = transcription as unknown as {
        text: string;
        language?: string;
        segments?: Array<{ start: number; end: number; text: string }>;
      };
      const segments = (verbose.segments ?? []).map((s) => ({
        start: s.start,
        duration: s.end - s.start,
        text: s.text,
      }));
      return Result.ok({ language: verbose.language ?? null, text: verbose.text, segments });
    } catch (e) {
      return Result.fail(e instanceof Error ? e.message : String(e));
    }
  }
}
