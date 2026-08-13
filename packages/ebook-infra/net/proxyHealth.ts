/**
 * Telling apart the ways a proxied YouTube request fails, and remembering which
 * proxies are worth trying again.
 *
 * WHY: the pool is tried in rotation, one proxy after another, and yt-dlp adds
 * three internal retries of its own — so a pool whose credentials have expired
 * burns ~60 network attempts per video and reports only the LAST proxy's stderr.
 * The distinction that matters is auth vs everything else: a `407` is the proxy
 * refusing the credentials before the request ever reaches YouTube, and it will
 * refuse them identically forever. Retrying that is pure latency; retrying a
 * flagged IP or a dropped connection is worthwhile.
 */

export type ProxyFailureKind =
  /** Credentials rejected (407). Deterministic — the same proxy will reject them again. */
  | 'auth'
  /** Proxy unreachable / connection dropped. Often transient. */
  | 'unreachable'
  /** Reached YouTube, but YouTube refused this IP (bot gate, captcha, 429). */
  | 'blocked'
  | 'other';

const AUTH = /407|proxy authentication required|proxyerror.*authentication/i;
const UNREACHABLE = /tunnel connection failed|connection refused|connection reset|econnrefused|econnreset|etimedout|timed out|unable to connect|network is unreachable/i;
const BLOCKED = /sign in to confirm|not a bot|captcha|too many requests|http error 429|http error 403/i;

/**
 * Classify a proxy failure from a yt-dlp stderr blob (or any error message).
 *
 * Order matters: yt-dlp reports a 407 as "Tunnel connection failed: 407 Proxy
 * Authentication Required", which matches BOTH auth and unreachable. Auth is
 * checked first because it is the more specific — and more actionable — cause.
 */
export function classifyProxyFailure(message: string): ProxyFailureKind {
  if (AUTH.test(message)) return 'auth';
  if (BLOCKED.test(message)) return 'blocked';
  if (UNREACHABLE.test(message)) return 'unreachable';
  return 'other';
}

/**
 * A proxy URL with its credentials stripped, safe to put in a log line, a job
 * error, or a project's failure message. Proxy passwords must never reach any
 * of those — `user:pass@host:port` is a credential, and project error strings
 * are persisted and shown in the UI.
 */
export function maskProxy(proxy: string | undefined): string {
  if (!proxy) return 'direct';
  try {
    const url = new URL(proxy);
    return `${url.protocol}//${url.host}`;
  } catch {
    return 'proxy'; // unparseable — say nothing rather than risk echoing credentials
  }
}

/** How long an auth-rejected proxy is skipped before it's tried again. */
const DEFAULT_QUARANTINE_MS = 10 * 60 * 1000;

/**
 * Remembers proxies that rejected our credentials so the next video doesn't pay
 * to rediscover it. Deliberately in-memory and time-boxed: a quota that resets,
 * or a fixed subscription, should heal on its own without a redeploy.
 *
 * ONLY `auth` quarantines. A blocked or unreachable proxy is a per-request
 * accident — sidelining it would shrink a pool that's doing its job.
 */
export class ProxyHealth {
  private readonly quarantined = new Map<string, number>(); // proxy → expiry (ms epoch)

  constructor(
    private readonly quarantineMs: number = DEFAULT_QUARANTINE_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  record(proxy: string | undefined, kind: ProxyFailureKind): void {
    if (!proxy || kind !== 'auth') return;
    this.quarantined.set(proxy, this.now() + this.quarantineMs);
  }

  /** A proxy that works again is trusted again immediately. */
  clear(proxy: string | undefined): void {
    if (proxy) this.quarantined.delete(proxy);
  }

  /**
   * The proxies worth trying, in the order given. Returns [] when every proxy is
   * quarantined — callers treat that as "the pool is down", which is a different
   * situation from "no proxies configured".
   */
  usable(proxies: string[]): string[] {
    const now = this.now();
    return proxies.filter((p) => {
      const until = this.quarantined.get(p);
      if (until === undefined) return true;
      if (until > now) return false;
      this.quarantined.delete(p); // expired — give it another chance
      return true;
    });
  }
}

/**
 * One registry for the whole YouTube-facing pool. The audio downloader and the
 * caption scraper share the same proxies, so a proxy that rejected one should
 * not be re-tried by the other seconds later.
 */
export const youtubeProxyHealth = new ProxyHealth();
