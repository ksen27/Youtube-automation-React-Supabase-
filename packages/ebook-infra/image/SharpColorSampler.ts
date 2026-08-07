import sharp from 'sharp';
import { Result, type ImageColorSampler, type Rgb } from '@ebook/core';

/**
 * Samples a book cover's dominant colour, which the landing page's whole palette
 * is derived from.
 *
 * sharp's `stats().dominant` bins the image into a 4096-colour histogram and
 * returns the most populated bin — cheap, deterministic, and no extra
 * dependency. It reports the most COMMON colour, which on a cover is usually
 * the background field; that is exactly the colour the page should echo.
 */
export class SharpColorSampler implements ImageColorSampler {
  async dominantColor(bytes: Uint8Array): Promise<Result<Rgb>> {
    try {
      // Downscale first: stats() on a full-resolution cover is pointlessly slow,
      // and the dominant bin is unchanged by a resample this coarse.
      const small = await sharp(Buffer.from(bytes)).resize({ width: 160, withoutEnlargement: true }).toBuffer();
      const { dominant } = await sharp(small).stats();
      if (!dominant) return Result.fail('No dominant colour reported');
      return Result.ok({ r: dominant.r, g: dominant.g, b: dominant.b });
    } catch (e) {
      return Result.fail(e instanceof Error ? e.message : String(e));
    }
  }
}
