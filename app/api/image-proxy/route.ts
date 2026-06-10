import { NextResponse, type NextRequest } from "next/server";

// Server-side image proxy for the editor preview.
//
// WHY THIS EXISTS: image-block thumbnails in the editor point at the RAW
// external image URL returned by the image-search step (Brave / Google CSE /
// Wikipedia / third-party CDNs). Many of those hosts serve the bytes fine to a
// SERVER fetch but block a BROWSER <img> request via referer/hotlink
// protection — so the same image that renders correctly in the final video
// (the render worker downloads it server-side) shows a broken placeholder in
// the editor. Routing the <img> through this same-origin proxy makes the
// browser load it from OUR origin while the actual cross-origin fetch happens
// server-side, exactly like the render pipeline's downloadHttp() does.
//
// Scope: read-only GET, image content only. A lightweight SSRF guard rejects
// non-http(s) schemes and obvious internal targets so the proxy can't be used
// to reach the worker's own network.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Mirror the render worker's download timeout ceiling so a slow CDN can't hang
// an editor request open indefinitely.
const FETCH_TIMEOUT_MS = 15_000;

// Sniff an image's real format from its leading magic bytes. CDNs often serve
// images with a generic Content-Type (binary/octet-stream,
// application/octet-stream) or even a wrong one, so the header alone can't be
// trusted — we look at the bytes. Returns the correct image/* MIME, or null
// when the bytes are not a recognised image (HTML challenge page, etc.).
function sniffImageMime(buf: Uint8Array): string | null {
  if (buf.length < 12) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  // GIF: "GIF8"
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "image/gif";
  // WEBP: "RIFF"...."WEBP"
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "image/webp";
  // AVIF / HEIC: bytes 4..8 == "ftyp"
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return "image/avif";
  // BMP: "BM"
  if (buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
  return null;
}

// Block private / loopback / link-local hosts so the proxy can't be aimed at
// internal services (SSRF). This is a coarse string check on the hostname —
// the proxy only ever needs to reach public image CDNs.
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "0.0.0.0" || h.endsWith(".local") || h.endsWith(".internal")) return true;
  // IPv4 private / loopback / link-local ranges.
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
  // IPv6 loopback / unique-local / link-local.
  if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true;
  return false;
}

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("url");
  if (!raw) {
    return NextResponse.json({ error: "missing url" }, { status: 400 });
  }

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return NextResponse.json({ error: "invalid url" }, { status: 400 });
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return NextResponse.json({ error: "unsupported scheme" }, { status: 400 });
  }
  if (isBlockedHost(target.hostname)) {
    return NextResponse.json({ error: "blocked host" }, { status: 400 });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(target.toString(), {
      signal: ctrl.signal,
      // A descriptive UA helps with hosts that reject the default fetch UA.
      // No Referer is sent (cross-origin server fetch), which is precisely
      // what gets past referer-based hotlink protection.
      headers: { "User-Agent": "video-automation/1.0 (editor-image-proxy)" },
      redirect: "follow",
    });
  } catch (e) {
    clearTimeout(timer);
    const aborted = (e as Error)?.name === "AbortError";
    return NextResponse.json(
      { error: aborted ? "upstream timeout" : "upstream fetch failed" },
      { status: 502 },
    );
  }
  clearTimeout(timer);

  if (!upstream.ok || !upstream.body) {
    return NextResponse.json(
      { error: `upstream ${upstream.status}` },
      { status: 502 },
    );
  }

  // Only proxy actual images — don't let this become an open relay for HTML
  // or other content types. We DON'T trust the Content-Type header alone:
  // CDNs commonly serve valid images as binary/octet-stream (purewow does this)
  // or with a wrong type. We buffer the body and sniff the magic bytes; the
  // header is just a hint. Buffering (vs streaming) is fine — these are small
  // preview thumbnails (a few hundred KB) and the result is cached a day.
  const headerType = upstream.headers.get("content-type") || "";
  let buf: ArrayBuffer;
  try {
    buf = await upstream.arrayBuffer();
  } catch {
    return NextResponse.json({ error: "upstream read failed" }, { status: 502 });
  }
  const bytes = new Uint8Array(buf);
  const sniffed = sniffImageMime(bytes);
  // Accept when EITHER the header says image/* OR the bytes are a real image.
  // Reject only when both fail (genuinely not an image — e.g. an HTML page).
  const isImage = headerType.startsWith("image/") || sniffed !== null;
  if (!isImage) {
    return NextResponse.json({ error: "not an image" }, { status: 415 });
  }

  // Serve with the most reliable type: the sniffed format when we have it,
  // else the header. Cache aggressively — image-search URLs are stable per
  // block and the editor re-renders these tiles often.
  const headers = new Headers();
  headers.set("Content-Type", sniffed ?? headerType);
  headers.set("Content-Length", String(bytes.byteLength));
  headers.set("Cache-Control", "public, max-age=86400, immutable");

  return new NextResponse(buf, { status: 200, headers });
}
