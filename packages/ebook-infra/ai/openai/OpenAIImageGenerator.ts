import OpenAI from 'openai';
import { Result, type ImageGenerator, type GeneratedImage } from '@ebook/core';
import { keepAliveAgent } from '../../net/keepAliveAgent';

/**
 * Cover-art generator backed by OpenAI's gpt-image-1. Reuses the same API key as
 * the Whisper fallback. Returns raw PNG bytes (the model replies with base64),
 * which the caller stores and renders behind the HTML-typeset title.
 */
export class OpenAIImageGenerator implements ImageGenerator {
  constructor(private readonly client: OpenAI) {}

  static fromApiKey(apiKey: string): OpenAIImageGenerator {
    return new OpenAIImageGenerator(new OpenAI({ apiKey, httpAgent: keepAliveAgent }));
  }

  async generate(input: { prompt: string; size?: string }): Promise<Result<GeneratedImage>> {
    try {
      const response = await this.client.images.generate({
        model: 'gpt-image-1',
        prompt: input.prompt,
        size: (input.size as '1024x1536' | undefined) ?? '1024x1536',
        n: 1,
      });
      const b64 = response.data?.[0]?.b64_json;
      if (!b64) return Result.fail('Image model returned no image data');
      return Result.ok({ bytes: new Uint8Array(Buffer.from(b64, 'base64')), contentType: 'image/png' });
    } catch (e) {
      return Result.fail(e instanceof Error ? e.message : String(e));
    }
  }
}
