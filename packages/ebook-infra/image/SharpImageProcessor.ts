import sharp from 'sharp';
import { Result, type ImageProcessor, type ProcessedImage } from '@ebook/core';

/**
 * sharp-backed image post-processor. Used to downscale generated illustrations
 * to a print-appropriate size and re-encode them as JPEG before storage, so the
 * exported PDF doesn't carry multi-megabyte source PNGs that slow (or time out)
 * the Puppeteer render. mozjpeg gives a smaller file at the same visual quality.
 */
export class SharpImageProcessor implements ImageProcessor {
  async downscaleToJpeg(input: { bytes: Uint8Array; maxWidth: number; quality: number }): Promise<Result<ProcessedImage>> {
    try {
      const out = await sharp(Buffer.from(input.bytes))
        .resize({ width: input.maxWidth, withoutEnlargement: true })
        .jpeg({ quality: input.quality, mozjpeg: true })
        .toBuffer();
      return Result.ok({ bytes: new Uint8Array(out), contentType: 'image/jpeg' });
    } catch (e) {
      return Result.fail(e instanceof Error ? e.message : String(e));
    }
  }

  async downscaleToDataUri(input: { bytes: Uint8Array; maxWidth: number; quality: number }): Promise<Result<string>> {
    const processed = await this.downscaleToBytes(input);
    if (processed.isFail()) return Result.fail(processed.error);
    return Result.ok(`data:image/webp;base64,${Buffer.from(processed.value.bytes).toString('base64')}`);
  }

  async downscaleToBytes(input: {
    bytes: Uint8Array;
    maxWidth: number;
    quality: number;
  }): Promise<Result<ProcessedImage>> {
    try {
      // WebP rather than mozjpeg: it keeps the alpha channel that logos and
      // transparent cover art rely on, and lands ~30% smaller at the same
      // quality — and every browser that can render a sales page supports it.
      const out = await sharp(Buffer.from(input.bytes))
        .resize({ width: input.maxWidth, withoutEnlargement: true })
        .webp({ quality: input.quality })
        .toBuffer();
      return Result.ok({ bytes: new Uint8Array(out), contentType: 'image/webp' });
    } catch (e) {
      return Result.fail(e instanceof Error ? e.message : String(e));
    }
  }
}
