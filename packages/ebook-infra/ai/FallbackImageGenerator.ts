import { Result, type ImageGenerator, type GeneratedImage, type Logger } from '@ebook/core';

/**
 * Image generator that tries a PRIMARY generator first and, if it fails, falls
 * back to a SECONDARY one. Used for in-chapter illustrations: 69labs (img-flux)
 * is the cheap/fast primary, OpenAI gpt-image-1 is the reliable fallback so a
 * 69labs outage or job failure no longer means a book with zero illustrations.
 *
 * The fallback only runs when the primary FAILS — a success short-circuits, so
 * we don't pay for the more expensive OpenAI image unless we have to.
 */
export class FallbackImageGenerator implements ImageGenerator {
  constructor(
    private readonly primary: ImageGenerator,
    private readonly fallback: ImageGenerator,
    private readonly logger: Logger,
  ) {}

  async generate(input: { prompt: string; size?: string }): Promise<Result<GeneratedImage>> {
    const first = await this.primary.generate(input);
    if (first.isOk()) return first;

    this.logger.warn('primary image generator failed — falling back', { error: first.error });
    const second = await this.fallback.generate(input);
    if (second.isOk()) {
      this.logger.info('fallback image generator succeeded');
      return second;
    }

    // Both failed — log AND surface both reasons so the empty slot is explained.
    this.logger.error('both primary and fallback image generators failed', {
      primaryError: first.error,
      fallbackError: second.error,
    });
    return Result.fail(`primary: ${first.error}; fallback: ${second.error}`);
  }
}
