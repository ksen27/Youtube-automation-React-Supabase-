import type { Result } from '../../../domain/shared/Result';

export interface ProcessedImage {
  bytes: Uint8Array;
  contentType: string;
}

/**
 * Post-processes a raster image — primarily to downscale and re-encode generated
 * illustrations before they're stored and inlined into the export. Image models
 * return needlessly large files (OpenAI gpt-image-1 PNGs are ~3MB), but
 * illustrations render at only ~76% page width, so shrinking them to a sane
 * print resolution keeps the inlined PDF small and fast to render.
 */
export interface ImageProcessor {
  /**
   * Resize to at most `maxWidth` px wide (never upscaling) and re-encode as JPEG
   * at `quality` (1–100). Returns the processed bytes and their content type.
   */
  downscaleToJpeg(input: { bytes: Uint8Array; maxWidth: number; quality: number }): Promise<Result<ProcessedImage>>;

  /**
   * The same downscale, returned as a `data:` URI ready to inline into a page.
   *
   * Separate from `downscaleToJpeg` for two reasons. The encoding is alpha-safe
   * (a channel avatar is usually a transparent PNG, and flattening it onto JPEG's
   * mandatory background turns a logo into a black box), and base64 belongs on
   * this side of the port so the application layer stays free of Node's Buffer.
   */
  downscaleToDataUri(input: { bytes: Uint8Array; maxWidth: number; quality: number }): Promise<Result<string>>;

  /**
   * The same alpha-safe downscale as `downscaleToDataUri`, returned as bytes.
   *
   * For pages that deploy as several files rather than one. A cloned template
   * ships `index.html` plus `assets/*`, so its cover and logo are files beside
   * the page rather than base64 inside it — which is also what keeps the page
   * row small enough to write in one request.
   */
  downscaleToBytes(input: { bytes: Uint8Array; maxWidth: number; quality: number }): Promise<Result<ProcessedImage>>;
}
