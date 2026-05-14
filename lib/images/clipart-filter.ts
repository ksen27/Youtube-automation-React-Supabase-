// Reject image results that look like clipart / illustrations / stock
// graphics. Shared between Brave (no server-side photo filter) and Google
// CSE (imgType=photo is imperfect — Google sometimes mislabels SVGs and
// vector graphics as photos).
//
// Two signals:
//   - SVG file extension — never a photograph
//   - URL path or context URL contains a clipart-y word
//   - Host is a known stock-illustration / clipart marketplace
// False positives are acceptable here. Documentary-style videos shouldn't
// mix in clipart even when the host occasionally serves real photos —
// mixed-style results look amateurish.

const CLIPART_WORD_RE = /\b(clipart|clip-art|cartoon|illustration|illustrations|vector|vectors|icon|icons|drawing|drawings|graphic|graphics|svg)\b/i;

const CLIPART_HOSTS = new Set<string>([
  "vecteezy.com", "freepik.com", "flaticon.com",
  "clipart-library.com", "clipartof.com", "clipartmax.com",
  "shutterstock.com", "istockphoto.com", "dreamstime.com",
  "depositphotos.com", "123rf.com", "alamy.com",
  "canstockphoto.com", "stockvault.net", "pngtree.com",
  "pngwing.com", "pngitem.com", "pngegg.com", "kindpng.com",
  "publicdomainvectors.org", "openclipart.org",
]);

export function looksLikeClipart(directUrl: string, contextUrl: string): boolean {
  if (/\.svg(\?|$)/i.test(directUrl)) return true;
  if (CLIPART_WORD_RE.test(directUrl) || CLIPART_WORD_RE.test(contextUrl)) return true;
  for (const u of [directUrl, contextUrl]) {
    if (!u) continue;
    try {
      const host = new URL(u).hostname.toLowerCase().replace(/^www\./, "");
      if (CLIPART_HOSTS.has(host)) return true;
      for (const h of CLIPART_HOSTS) if (host.endsWith(`.${h}`)) return true;
    } catch { /* not a parseable URL — skip */ }
  }
  return false;
}
