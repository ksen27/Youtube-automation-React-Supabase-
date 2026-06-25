import sharp from "sharp";
import { getEnv } from "@/lib/env";

// Low-fi "vlogging" image degrade (client requirement 2026-06).
//
// Our 69labs stills come out too clean / too sharp / too perfect, which is the
// main reason they read as AI rather than real. The client's reference channel
// looks real precisely because its footage is slightly LOW QUALITY — grainy,
// soft, lightly compressed, like an ordinary phone vlog. So we deliberately
// push every generated still toward that look BEFORE upload.
//
// Crucially this keeps the image's DIMENSIONS unchanged (the client still wants
// 1080p) — we only lower TEXTURE quality at full size:
//   1. a slight gaussian blur            -> kills the razor-sharp AI crispness
//   2. real luminance grain (noise)      -> a sensor-noise feel AI never adds
//   3. a lower-quality JPEG re-encode    -> authentic compression artifacts
//
// All amounts are env-tunable (SYNTHETIC_DEGRADE_*) with moderate defaults, and
// the whole thing is gated by SYNTHETIC_DEGRADE_ENABLED. On ANY failure we
// return the original buffer untouched — a degrade is cosmetic and must never
// fail a generation.

/**
 * Apply the low-fi degrade to a generated still. Returns a JPEG buffer at the
 * SAME pixel dimensions as the input (only texture quality is lowered). Returns
 * the input unchanged when degrade is disabled or on any processing error.
 *
 * The returned content type is always image/jpeg when degrade ran (the upload
 * caller should use the returned contentType, not assume the original).
 */
export async function degradeImageLowFi(
  image: Buffer,
): Promise<{ image: Buffer; contentType: string; degraded: boolean }> {
  const env = getEnv();
  if (!env.SYNTHETIC_DEGRADE_ENABLED) {
    return { image, contentType: "", degraded: false };
  }
  return degradeImageWith(image, {
    blur: env.SYNTHETIC_DEGRADE_BLUR_SIGMA,
    noise: env.SYNTHETIC_DEGRADE_IMAGE_NOISE,
    quality: env.SYNTHETIC_DEGRADE_IMAGE_JPEG_QUALITY,
  });
}

/** Degrade params for one pass. `noise` is the grain layer's gaussian sigma. */
export interface ImageDegradeParams {
  blur: number;
  noise: number;
  quality: number;
}

/**
 * Core degrade with EXPLICIT params (no env read). degradeImageLowFi wraps this
 * with the configured values; tuning/preview tools call it directly to sweep
 * strengths. Keeps dimensions; returns the original buffer on any error.
 */
export async function degradeImageWith(
  image: Buffer,
  params: ImageDegradeParams,
): Promise<{ image: Buffer; contentType: string; degraded: boolean }> {
  const { blur, noise, quality } = params;

  try {
    const src = sharp(image, { failOn: "none" });
    const meta = await src.metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (!width || !height) return { image, contentType: "", degraded: false };

    // 1) Slight softness — a real handheld phone frame is never perfectly sharp.
    let pipeline = sharp(image, { failOn: "none" });
    if (blur > 0) pipeline = pipeline.blur(blur);

    // 2) Real luminance grain. sharp has no native noise op, so we build a
    //    monochrome noise layer at the SAME size and overlay-blend it. Grain is
    //    luminance-only (R=G=B per pixel) so it reads as sensor noise, not color
    //    speckle. We generate it from gaussian noise then composite.
    let base = await pipeline.toColourspace("srgb").toBuffer();
    if (noise > 0) {
      const grain = await sharp({
        create: {
          width,
          height,
          channels: 3,
          // Mid-grey base; the gaussian noise modulates around it, and an
          // overlay blend then nudges the underlying pixels lighter/darker.
          background: { r: 128, g: 128, b: 128 },
          noise: { type: "gaussian", mean: 128, sigma: noise },
        },
      })
        .toColourspace("srgb")
        .png()
        .toBuffer();
      base = await sharp(base, { failOn: "none" })
        .composite([{ input: grain, blend: "overlay" }])
        .toBuffer();
    }

    // 3) Lower-quality JPEG re-encode — authentic compression artifacts, and it
    //    also drops file size. Dimensions are untouched (no resize anywhere).
    const out = await sharp(base, { failOn: "none" })
      .jpeg({ quality, mozjpeg: true, chromaSubsampling: "4:2:0" })
      .toBuffer();

    return { image: out, contentType: "image/jpeg", degraded: true };
  } catch {
    // Cosmetic step — never fail a generation because degrade threw.
    return { image, contentType: "", degraded: false };
  }
}
