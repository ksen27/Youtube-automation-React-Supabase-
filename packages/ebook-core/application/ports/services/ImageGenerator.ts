import type { Result } from '../../../domain/shared/Result';

export interface GeneratedImage {
  bytes: Uint8Array;
  contentType: string;
}

/**
 * Generates a raster illustration from a text prompt. Implemented by an image
 * model adapter (e.g. OpenAI gpt-image-1). Kept text-free by the caller — book
 * titles are typeset in HTML over the art, never baked into the pixels.
 */
export interface ImageGenerator {
  generate(input: { prompt: string; size?: string }): Promise<Result<GeneratedImage>>;
}
