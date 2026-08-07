import type { Result } from '../../../domain/shared/Result';
import type { Rect } from '../../../domain/landing/TemplateManifest';
import type { Shot } from './TemplateCapturer';

/**
 * Compares two renderings of the same page pixel by pixel.
 *
 * This is only meaningful because a cloned page and its template ARE the same
 * document with different content — so a diff localises exactly what moved. The
 * previous pipeline generated a structurally unrelated page, where a pixel diff
 * would have measured nothing but noise, which is why "sections missing or
 * rearranged" was undetectable in principle rather than merely unimplemented.
 */

export interface DiffResult {
  width: number;
  /** Mismatched pixels ÷ compared pixels, outside the masked regions. */
  mismatchRatio: number;
  /** Mismatched pixels inside the masked regions — expected, reported anyway. */
  maskedMismatchRatio: number;
  /** Set when the two images differ in size; the overlap is compared. */
  sizeDelta?: { widthPx: number; heightPx: number } | undefined;
}

export interface PageDiffer {
  /**
   * @param masks Regions expected to differ — every placeholder node's captured
   *   rect. Content swapped on purpose must not count as drift, or every page
   *   fails its own check.
   */
  compare(input: { baseline: Shot[]; candidate: Shot[]; masks?: Record<number, Rect[]> | undefined }): Promise<Result<DiffResult[]>>;
}
