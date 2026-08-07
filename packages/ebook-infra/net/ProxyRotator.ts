import { fetch as undiciFetch, ProxyAgent } from 'undici';

/**
 * Parse a proxy list from an env value (comma- or newline-separated). Each entry
 * may be either a full proxy URL (`http://user:pass@host:port`, `socks5://...`)
 * or the raw `host:port:user:pass` / `host:port` form pasted from a provider —
 * both are normalized to a URL. Returns [] for empty/undefined input.
 */
export function parseProxyList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(normalizeProxy);
}

/** Normalize a single proxy entry to a URL yt-dlp and ProxyAgent both accept. */
function normalizeProxy(entry: string): string {
  if (/^[a-z0-9]+:\/\//i.test(entry)) return entry; // already a URL (http/https/socks)
  const parts = entry.split(':');
  if (parts.length === 4) {
    const [host, port, user, pass] = parts;
    return `http://${user}:${pass}@${host}:${port}`;
  }
  if (parts.length === 2) {
    const [host, port] = parts;
    return `http://${host}:${port}`;
  }
  return entry; // unrecognized shape — pass through and let the caller surface any error
}

/**
 * Hands out a `fetch` bound to the next proxy in the pool, round-robin, so
 * sequential and concurrent requests spread across distinct IPs — clearing
 * YouTube's per-IP captcha/rate block on the transcript scraper. A ProxyAgent is
 * built once per proxy (it pools connections) and reused across calls. With no
 * proxies configured, nextFetch() returns the global fetch (direct request).
 */
export class ProxyRotator {
  private cursor = 0;
  private readonly agents: ProxyAgent[];

  constructor(proxies: string[]) {
    this.agents = proxies.map((url) => new ProxyAgent(url));
  }

  get size(): number {
    return this.agents.length;
  }

  /** A fetch routed through the next proxy (or the direct global fetch if none). */
  nextFetch(): typeof globalThis.fetch {
    return this.orderedFetches()[0]!;
  }

  /**
   * Every proxy-bound fetch, in rotated order (one per proxy) so a caller can try
   * each in turn and only give up once the whole pool is exhausted. With no
   * proxies configured, a single direct fetch — so callers can always iterate.
   */
  orderedFetches(): Array<typeof globalThis.fetch> {
    if (this.agents.length === 0) return [globalThis.fetch];
    const start = this.cursor++ % this.agents.length;
    return this.agents.map((_, i) => this.bind(this.agents[(start + i) % this.agents.length]!));
  }

  private bind(agent: ProxyAgent): typeof globalThis.fetch {
    // undici's fetch/RequestInit and the DOM's differ structurally (body, the
    // Next.js `next` augmentation, exactOptionalPropertyTypes). We only forward
    // the caller's init verbatim plus the dispatcher, so bridge the types via
    // unknown rather than reconcile two incompatible RequestInit shapes.
    const proxied = (input: unknown, init?: unknown) =>
      undiciFetch(input as Parameters<typeof undiciFetch>[0], {
        ...(init as Record<string, unknown>),
        dispatcher: agent,
      } as unknown as Parameters<typeof undiciFetch>[1]);
    return proxied as unknown as typeof globalThis.fetch;
  }
}

/**
 * The shared YouTube proxy pool from env: YT_DLP_PROXIES (pool) takes precedence
 * over YT_DLP_PROXY (single). Used by both the transcript scraper and the yt-dlp
 * audio path so one proxy list drives the whole YouTube-facing pipeline.
 */
export function youtubeProxyList(): string[] {
  const pool = parseProxyList(process.env.YT_DLP_PROXIES);
  return pool.length ? pool : parseProxyList(process.env.YT_DLP_PROXY);
}

/** Build a rotator from the shared YouTube proxy env. */
export function youtubeProxyRotator(): ProxyRotator {
  return new ProxyRotator(youtubeProxyList());
}

/**
 * Proxy pool for 69labs image requests. 69labs fails jobs from datacenter IPs, so
 * routing through residential proxies fixes it. Uses a dedicated LABS69_PROXIES /
 * LABS69_PROXY if set, otherwise falls back to the existing YouTube residential
 * pool — so a deployment that already has YT_DLP_PROXIES needs no new config.
 */
export function labs69ProxyList(): string[] {
  const own = parseProxyList(process.env.LABS69_PROXIES);
  if (own.length) return own;
  const single = parseProxyList(process.env.LABS69_PROXY);
  if (single.length) return single;
  return youtubeProxyList();
}

/** Build a rotator for 69labs from its proxy env (or the YouTube pool fallback). */
export function labs69ProxyRotator(): ProxyRotator {
  return new ProxyRotator(labs69ProxyList());
}
