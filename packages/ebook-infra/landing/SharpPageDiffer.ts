import sharp from 'sharp';
import { Result, type DiffResult, type PageDiffer, type Rect, type Shot } from '@ebook/core';

/**
 * Pixel comparison between a template and the page cloned from it.
 *
 * Built on sharp, which is already a dependency, rather than pulling in a diff
 * library: decoding to raw RGBA and walking two buffers is the whole algorithm,
 * and adding a package for it would be adding a package for a loop.
 *
 * This check is only meaningful because a cloned page and its template ARE the
 * same document with different content, so a mismatch localises exactly what
 * moved. Against a model-generated page — which had no structural relationship
 * to the reference — the same measurement would have been noise.
 */

/**
 * Per-channel tolerance. Anti-aliasing, subpixel text rendering and image
 * re-encoding all shift a channel by a few counts without anything having
 * actually moved; at 0 every screenshot differs from itself.
 */
const CHANNEL_TOLERANCE = 12;

/** Channels compared per pixel. Alpha is ignored — both renders are opaque. */
const CHANNELS = 3;

export class SharpPageDiffer implements PageDiffer {
  async compare(input: {
    baseline: Shot[];
    candidate: Shot[];
    masks?: Record<number, Rect[]> | undefined;
  }): Promise<Result<DiffResult[]>> {
    const results: DiffResult[] = [];

    for (const baseline of input.baseline) {
      const candidate = input.candidate.find((c) => c.width === baseline.width);
      if (!candidate) continue;

      try {
        const a = await decode(baseline);
        const b = await decode(candidate);

        // Compare the overlap. A cloned page whose copy runs two lines longer is
        // genuinely taller, and refusing to compare at all would turn the most
        // ordinary outcome into an unmeasurable one.
        const width = Math.min(a.width, b.width);
        const height = Math.min(a.height, b.height);
        if (width === 0 || height === 0) continue;

        const masks = input.masks?.[baseline.width] ?? [];
        const counted = countMismatches(a, b, width, height, masks);

        const result: DiffResult = {
          width: baseline.width,
          mismatchRatio: counted.compared > 0 ? counted.mismatched / counted.compared : 0,
          maskedMismatchRatio: counted.maskedTotal > 0 ? counted.maskedMismatched / counted.maskedTotal : 0,
        };
        if (a.width !== b.width || a.height !== b.height) {
          result.sizeDelta = { widthPx: b.width - a.width, heightPx: b.height - a.height };
        }
        results.push(result);
      } catch (e) {
        return Result.fail(`Could not compare the ${baseline.width}px renders: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    if (results.length === 0) return Result.fail('No pair of screenshots shared a width, so nothing was compared.');
    return Result.ok(results);
  }
}

interface Decoded {
  data: Buffer;
  width: number;
  height: number;
}

async function decode(shot: Shot): Promise<Decoded> {
  const input = Buffer.from(shot.dataBase64, 'base64');
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/**
 * Walks both images once, sorting every pixel into masked or unmasked.
 *
 * Masked regions are where content was replaced on purpose. Counting those as
 * drift would make every page fail its own check — the swap IS the deliverable.
 * They are still tallied separately, because a masked region that differs by
 * almost nothing usually means a placeholder never got filled.
 */
function countMismatches(
  a: Decoded,
  b: Decoded,
  width: number,
  height: number,
  masks: Rect[],
): { mismatched: number; compared: number; maskedMismatched: number; maskedTotal: number } {
  let mismatched = 0;
  let compared = 0;
  let maskedMismatched = 0;
  let maskedTotal = 0;

  // Row bounds per mask, so the inner loop tests only the masks that can
  // possibly contain this row.
  const bounds = masks.map((m) => ({
    top: Math.max(0, Math.floor(m.y)),
    bottom: Math.min(height, Math.ceil(m.y + m.height)),
    left: Math.max(0, Math.floor(m.x)),
    right: Math.min(width, Math.ceil(m.x + m.width)),
  }));

  for (let y = 0; y < height; y++) {
    const rowMasks = bounds.filter((m) => y >= m.top && y < m.bottom);
    for (let x = 0; x < width; x++) {
      const ai = (y * a.width + x) * 4;
      const bi = (y * b.width + x) * 4;

      let differs = false;
      for (let c = 0; c < CHANNELS; c++) {
        if (Math.abs((a.data[ai + c] ?? 0) - (b.data[bi + c] ?? 0)) > CHANNEL_TOLERANCE) {
          differs = true;
          break;
        }
      }

      const masked = rowMasks.some((m) => x >= m.left && x < m.right);
      if (masked) {
        maskedTotal++;
        if (differs) maskedMismatched++;
      } else {
        compared++;
        if (differs) mismatched++;
      }
    }
  }

  return { mismatched, compared, maskedMismatched, maskedTotal };
}
