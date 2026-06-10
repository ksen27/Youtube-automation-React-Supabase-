// Client helper: route an EXTERNAL image URL through the same-origin image
// proxy (/api/image-proxy) so the browser loads it from our origin.
//
// Many image-search hosts (Brave / Google CSE / third-party CDNs) serve bytes
// fine to a server fetch but block a browser <img> via referer/hotlink
// protection — so editor previews show broken placeholders even though the
// render worker (which fetches server-side) embeds the same image correctly.
// Proxying fixes the preview without touching the render path.
//
// We pass through anything that already loads directly:
//   - non-http(s) values (data: / blob: URIs, relative paths, empty)
//   - same-origin URLs (already served by us)
// Everything else — every cross-origin http(s) URL — is proxied. That includes
// our own R2 CDN images, which is harmless: R2 is public so the proxy fetch
// succeeds, the result is cached (immutable, 1 day), and we avoid threading a
// NEXT_PUBLIC_ copy of the R2 base URL into the client just to skip one hop.

export function proxiedImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  // Only http(s) absolute URLs are candidates for proxying.
  if (!/^https?:\/\//i.test(url)) return url;
  // Same-origin already loads directly — no proxy needed.
  if (typeof window !== "undefined") {
    try {
      if (new URL(url).origin === window.location.origin) return url;
    } catch {
      return url;
    }
  }
  return `/api/image-proxy?url=${encodeURIComponent(url)}`;
}
