// Shared HTTP retry primitive for the synthetic provider libs. Mirrors the
// idiom in lib/ai/gemini.ts (withGeminiRetry) so the engines behave
// consistently: exponential backoff with jitter, only retrying transient
// failures (network errors, 429, 5xx). 4xx (except 429) is permanent and
// surfaces immediately so we don't burn retries on a bad request/key.

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function isRetryableHttp(err: unknown): boolean {
  if (err instanceof HttpError) {
    return err.status === 429 || err.status >= 500;
  }
  // Fetch/network-layer errors (ECONNRESET, ETIMEDOUT, DNS, abort timeouts).
  const m = (err as Error)?.message ?? "";
  return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|fetch failed|network|timeout/i.test(m);
}

export async function withHttpRetry<T>(
  label: string,
  fn: () => Promise<T>,
  opts: { attempts?: number; baseMs?: number } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseMs = opts.baseMs ?? 1000;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i === attempts - 1 || !isRetryableHttp(e)) throw e;
      const delay = Math.round(baseMs * Math.pow(3, i) * (0.5 + Math.random()));
      // eslint-disable-next-line no-console
      console.warn(JSON.stringify({
        msg: "synthetic.http.retry",
        op: label,
        attempt: i + 1,
        nextDelayMs: delay,
        err: (e as Error).message?.slice(0, 200),
      }));
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// fetch wrapper that throws HttpError on non-2xx so withHttpRetry can classify
// the failure. Supports an AbortSignal timeout. Returns the raw Response on 2xx.
export async function fetchOrThrow(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs, ...rest } = init;
  const controller = timeoutMs ? new AbortController() : undefined;
  const timer = timeoutMs ? setTimeout(() => controller!.abort(), timeoutMs) : undefined;
  try {
    const res = await fetch(url, { ...rest, signal: controller?.signal ?? rest.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // Include the response body in the message so the worker's job.failed log
      // shows WHY the API rejected us (e.g. an invalid field) — a bare status
      // code is undiagnosable for a 400.
      const snippet = body.slice(0, 300).replace(/\s+/g, " ").trim();
      throw new HttpError(
        res.status,
        `${init.method ?? "GET"} ${url} -> ${res.status}${snippet ? ` :: ${snippet}` : ""}`,
        body.slice(0, 500),
      );
    }
    return res;
  } catch (err) {
    // Node's fetch reports a bare "fetch failed" and hides the real reason in
    // err.cause (ENOTFOUND/ECONNREFUSED/CERT_*/ETIMEDOUT). Unwrap it so the
    // log tells us whether it's DNS, a refused connection, or TLS — instead of
    // an undiagnosable "fetch failed".
    if (err instanceof HttpError) throw err;
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const detail = cause?.code || cause?.message;
    if (detail) {
      const e = new Error(`${init.method ?? "GET"} ${url} -> ${(err as Error).message} (${detail})`);
      throw e;
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
