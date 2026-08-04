import QRCode from "qrcode";
import sharp from "sharp";

// SALES-PITCH QR OVERLAY (client 2026-08-03).
//
// The generated pitch ends with a fixed window that scroll-records the client's
// real website. The client asked for a scannable QR code pinned over THAT
// segment (and only that segment) so a viewer can pull the site up on their
// phone while they're watching it scroll.
//
// The QR encodes the pitch's OWN website_url — the same URL Playwright records
// — so what the viewer scans always matches what's on screen. There is no
// separate QR-url input to keep in sync.
//
// Two things about how this is rendered matter for whether the code actually
// SCANS off a compressed video frame:
//
//   1. ERROR CORRECTION 'H' (~30% recoverable). x264 at crf 21 softens hard
//      black/white edges, and the overlay sits over a MOVING background (the
//      scroll), so the encoder spends fewer bits on it than on a static frame.
//      'H' buys back the margin that compression eats.
//
//   2. The card is rendered at its FINAL pixel size here, in sharp, and handed
//      to ffmpeg pre-scaled. Letting ffmpeg scale a 512px QR down to ~180px in
//      the filtergraph resamples the module grid with a smoothing kernel and
//      visibly blurs the edges. sharp's `kernel: "nearest"` keeps the modules
//      square and the transitions hard.
//
// The white rounded card is what makes it legible regardless of what's behind
// it — a bare QR over a light website section is unscannable.

/** A quiet zone of 4 modules is the QR spec minimum for reliable scanning. */
const QUIET_ZONE_MODULES = 4;

/** Card corner radius as a fraction of card size — cosmetic only. */
const CARD_CORNER_RADIUS_FRACTION = 0.08;

/**
 * Render a scannable QR code for `url` as a white rounded card, sized to
 * exactly `sizePx` square, with transparent corners (PNG, RGBA).
 *
 * `paddingPx` is the white margin between the card edge and the QR itself, on
 * top of the QR's own 4-module quiet zone.
 *
 * Throws if the URL is unusable or the QR cannot be encoded — the caller
 * decides whether that's fatal (it should not be: the overlay is cosmetic).
 */
export async function generateQRCard(opts: {
  url: string;
  sizePx: number;
  paddingPx: number;
}): Promise<Buffer> {
  const size = Math.max(1, Math.round(opts.sizePx));
  // Never let padding eat the whole card on a small size.
  const padding = Math.max(0, Math.min(Math.round(opts.paddingPx), Math.floor((size - 8) / 2)));
  const inner = size - padding * 2;

  // Render the QR itself well ABOVE the final size, then downsample once with a
  // nearest-neighbour kernel. Generating directly at `inner` px would let the
  // qrcode lib round module widths unevenly (some modules 3px, some 4px), which
  // reads as a warped grid; oversampling at a clean multiple avoids that.
  const renderPx = Math.max(inner * 2, 512);
  const qrPng = await QRCode.toBuffer(opts.url, {
    type: "png",
    errorCorrectionLevel: "H",
    margin: QUIET_ZONE_MODULES,
    width: renderPx,
    color: { dark: "#000000ff", light: "#ffffffff" },
  });

  const qrResized = await sharp(qrPng)
    .resize(inner, inner, { kernel: "nearest", fit: "fill" })
    .toBuffer();

  const radius = Math.round(size * CARD_CORNER_RADIUS_FRACTION);
  const cardSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
      `<rect x="0" y="0" width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="#ffffff"/>` +
      `</svg>`,
  );

  // Transparent base so the card's rounded corners stay rounded over the video
  // instead of being squared off by an opaque background.
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      { input: cardSvg, top: 0, left: 0 },
      { input: qrResized, top: padding, left: padding },
    ])
    .png()
    .toBuffer();
}

/** Where the QR card sits in the frame. */
export type QRPosition = "top-right" | "top-left" | "bottom-right" | "bottom-left";

/**
 * Top-left pixel offset for a `sizePx` card placed at `position` within a
 * `width` x `height` frame, inset by `marginPx` from both edges.
 */
export function qrOverlayOffset(opts: {
  position: QRPosition;
  width: number;
  height: number;
  sizePx: number;
  marginPx: number;
}): { x: number; y: number } {
  const { width, height, sizePx, marginPx } = opts;
  const right = Math.max(0, width - sizePx - marginPx);
  const bottom = Math.max(0, height - sizePx - marginPx);
  switch (opts.position) {
    case "top-left":
      return { x: marginPx, y: marginPx };
    case "bottom-left":
      return { x: marginPx, y: bottom };
    case "bottom-right":
      return { x: right, y: bottom };
    case "top-right":
    default:
      return { x: right, y: marginPx };
  }
}

/**
 * Validate a URL for QR encoding. Returns the normalized absolute URL, or null
 * if it cannot be represented as an http(s) address.
 *
 * NOTE: http is accepted, not just https. The pitch's website_url is already
 * normalized at intake and is fed to Playwright's goto; rejecting http here
 * would refuse sites the recorder happily handles today.
 */
export function normalizeQRUrl(raw: string): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}
