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
    if (err.status === 429 || err.status >= 500) return true;
    // 69labs returns 403 (not 429) when its per-account concurrent-generation
    // limit is hit: {"error":"Concurrent image generation limit reached (7)..."}.
    // That is a transient rate-limit, not a permanent auth failure — riding it
    // out with backoff lets a burst of segments drain instead of failing. Match
    // the message so a genuine auth 403 (bad key) stays permanent.
    if (err.status === 403 && /concurrent.*limit reached/i.test(err.body ?? err.message)) {
      return true;
    }
    return false;
  }
  // Fetch/network-layer errors (ECONNRESET, ETIMEDOUT, DNS, abort timeouts).
  const m = (err as Error)?.message ?? "";
  return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|fetch failed|network|timeout/i.test(m);
}

// True for a PERMANENT auth 403 — a revoked/blocked/expired key (69labs:
// {"error":"Access denied","code":"FORBIDDEN"}) — as opposed to the transient
// "concurrent image generation limit reached" 403, which isRetryableHttp()
// already rides out on the SAME key. The image generator uses this to decide
// when to fail OVER to the backup key (a dead key won't recover by retrying it).
export function isAuthForbidden(err: unknown): boolean {
  if (!(err instanceof HttpError)) return false;
  if (err.status !== 403) return false;
  const text = err.body ?? err.message;
  // The concurrent-limit 403 is transient (retry same key); everything else at
  // 403 is treated as a permanent auth failure worth failing over.
  return !/concurrent.*limit reached/i.test(text);
}

// True when an error is (or was caused by) an AbortSignal firing. Node's fetch
// surfaces this as an AbortError / "The operation was aborted", which none of
// the transient patterns above match — so an aborted call is never retried.
// Callers use this to tell "we cancelled" apart from "the provider failed".
export function isAbortError(err: unknown): boolean {
  const e = err as { name?: string; message?: string };
  return e?.name === "AbortError" || /operation was aborted|aborted/i.test(e?.message ?? "");
}

/**
 * setTimeout as a promise that rejects as soon as `signal` aborts, so a backoff
 * sleep can't outlive a cancelled operation. Without this, aborting mid-retry
 * still waits out the full delay before anyone notices.
 */
export function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((r) => setTimeout(r, ms));
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function withHttpRetry<T>(
  label: string,
  fn: () => Promise<T>,
  opts: { attempts?: number; baseMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseMs = opts.baseMs ?? 1000;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    // Bail before spending an attempt on work the caller has already abandoned.
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("aborted");
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      // An abort is the caller cancelling, never a transient provider failure:
      // surface it immediately instead of burning the retry budget.
      if (i === attempts - 1 || !isRetryableHttp(e) || isAbortError(e)) throw e;
      const delay = Math.round(baseMs * Math.pow(3, i) * (0.5 + Math.random()));
      console.warn(JSON.stringify({
        msg: "synthetic.http.retry",
        op: label,
        attempt: i + 1,
        nextDelayMs: delay,
        err: (e as Error).message?.slice(0, 200),
      }));
      await sleepUnlessAborted(delay, opts.signal);
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
  const { timeoutMs, signal: callerSignal, ...rest } = init;
  // The per-request timeout and the CALLER's signal must BOTH be able to abort
  // the fetch. The old shape let the timeout controller replace rest.signal
  // outright, so a caller-supplied cancellation was silently dropped whenever a
  // timeoutMs was also set — which is every call in this module.
  const needsController = Boolean(timeoutMs || callerSignal);
  const controller = needsController ? new AbortController() : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onCallerAbort: (() => void) | undefined;
  if (controller) {
    if (callerSignal) {
      if (callerSignal.aborted) {
        controller.abort(callerSignal.reason);
      } else {
        onCallerAbort = () => controller.abort(callerSignal.reason);
        callerSignal.addEventListener("abort", onCallerAbort, { once: true });
      }
    }
    if (timeoutMs) timer = setTimeout(() => controller.abort(), timeoutMs);
  }
  try {
    const res = await fetch(url, { ...rest, signal: controller?.signal });
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
    if (callerSignal && onCallerAbort) callerSignal.removeEventListener("abort", onCallerAbort);
  }
}
