/**
 * Fly Machines API client — start/stop the CONSUMER worker machines on demand.
 *
 * WHY THIS EXISTS: the avatar and ebook workers are pure BullMQ consumers that
 * ran 24/7 because Fly cannot auto-start them. `auto_start_machines` fires on
 * inbound HTTP to a [[services]] block, and neither app exposes one (see the
 * NOTE blocks at the end of fly.avatar.toml / fly.ebook.toml). Both are large —
 * the avatar worker is the same performance-8x/16gb as the celebrity worker —
 * so an idle month cost the same as a busy one. This module supplies the wake
 * signal Fly can't: the enqueue path starts the machine, and an idle monitor on
 * the always-on celebrity worker stops it again.
 *
 * NOT the celebrity worker (video-automation-worker). That app hosts Redis
 * inside its own container (see the WORKER_ROLE gate in Dockerfile.worker), so
 * stopping it destroys the queue that any wake signal would have to be read
 * from — the key locked inside the room. Making it sleepable means moving Redis
 * to a managed instance first, which lib/jobs/queue.ts already supports via its
 * rediss:// TLS handling. Deliberately out of scope here.
 *
 * START, NOT SCALE. `fly scale count 0/1` destroys and recreates the machine,
 * which drops its volume attachment; the avatar worker's avatar_worker_data
 * mount holds RENDER_CACHE_DIR (/data/render-cache), the per-clip resume cache
 * that lets an interrupted render skip re-encoding ~400 clips. Starting and
 * stopping the SAME machine keeps that volume — and the cache — intact.
 */

import { getEnv } from "@/lib/env";

const FLY_API_BASE = "https://api.machines.dev/v1";

/** Which sleepable worker app to act on. Keys of the env var pair below. */
export type SleepableApp = "avatar" | "ebook";

export interface FlyMachine {
  id: string;
  name: string;
  /** "started" | "stopped" | "starting" | "stopping" | "created" | "destroyed" | … */
  state: string;
}

/** Resolve the configured Fly app name for a sleepable role, if any. */
export function flyAppName(app: SleepableApp): string | undefined {
  const env = getEnv();
  const name = app === "avatar" ? env.FLY_AVATAR_APP_NAME : env.FLY_EBOOK_APP_NAME;
  return name && name.trim() ? name.trim() : undefined;
}

/**
 * Whether on-demand start/stop is wired up for this app.
 *
 * Both the token and the app name must be present. When either is missing the
 * feature is OFF and every entry point below no-ops — that is the pre-existing
 * always-on behaviour, which must remain the safe default so a missing secret
 * degrades to "costs money" rather than "generation is broken".
 */
export function isMachineControlEnabled(app: SleepableApp): boolean {
  // sanitizeToken, not the raw value: a var holding only a BOM or stray quotes
  // is not a configured token, and must not switch the feature on only to fail
  // on the first request.
  return Boolean(sanitizeToken(getEnv().FLY_API_TOKEN)) && Boolean(flyAppName(app));
}

/**
 * Strip characters an HTTP header cannot carry from a pasted secret.
 *
 * THE BUG THIS FIXES: a token set through a shell pipeline arrived with a UTF-8
 * BOM (U+FEFF) wedged after "FlyV1 ", because PowerShell's `echo`/`Out-File`
 * writes one by default. fetch() then rejected the whole request with
 * "Cannot convert argument to a ByteString because the character at index 7 has
 * a value of 65279", which reads as a bug in this client and is really an
 * invisible character in the environment variable — the kind of thing you can
 * stare at in a dashboard and never see.
 *
 * Also trims surrounding whitespace/newlines (a trailing \n from a heredoc or a
 * copied line does the same damage) and any stray quotes, which a value pasted
 * WITH its shell quotes would otherwise carry into the header.
 */
function sanitizeToken(raw: string | undefined): string | undefined {
  if (!raw) return raw;
  const cleaned = raw
    .replace(/[\uFEFF\u200B-\u200D\u2060]/g, "") // BOM + zero-width chars
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim();
  return cleaned || undefined;
}

class FlyApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "FlyApiError";
  }
}

async function flyFetch(path: string, init?: RequestInit): Promise<unknown> {
  const token = sanitizeToken(getEnv().FLY_API_TOKEN);
  if (!token) throw new FlyApiError("FLY_API_TOKEN is not set");

  // Short timeout: this sits on the enqueue path, which a user is waiting on.
  // A hung Fly API must surface as a fast, actionable error rather than a
  // request that appears to stall on "Generate".
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), getEnv().FLY_API_TIMEOUT_MS);
  try {
    const res = await fetch(`${FLY_API_BASE}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new FlyApiError(`Fly API ${res.status} on ${path}: ${body.slice(0, 300)}`, res.status);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch (e) {
    if (e instanceof FlyApiError) throw e;
    const msg = (e as Error).name === "AbortError"
      ? `Fly API timed out after ${getEnv().FLY_API_TIMEOUT_MS}ms on ${path}`
      : `Fly API request failed on ${path}: ${(e as Error).message}`;
    throw new FlyApiError(msg);
  } finally {
    clearTimeout(timer);
  }
}

/** List the machines belonging to a sleepable app. */
export async function listMachines(app: SleepableApp): Promise<FlyMachine[]> {
  const name = flyAppName(app);
  if (!name) throw new FlyApiError(`no Fly app name configured for role '${app}'`);
  const raw = await flyFetch(`/apps/${encodeURIComponent(name)}/machines`);
  if (!Array.isArray(raw)) return [];
  return raw
    .map((m) => m as { id?: string; name?: string; state?: string })
    .filter((m): m is { id: string; name: string; state: string } => Boolean(m.id))
    .map((m) => ({ id: m.id, name: m.name ?? m.id, state: m.state ?? "unknown" }));
}

/** A machine that is running, or on its way to running. */
function isUp(state: string): boolean {
  return state === "started" || state === "starting" || state === "replacing";
}

/**
 * Start every stopped machine for this app, and WAIT until Fly reports it
 * started.
 *
 * The wait is the point. Returning as soon as the start command is accepted
 * would let the caller enqueue against a machine that is still booting, and a
 * boot here is not instant: Dockerfile.worker runs `yt-dlp -U` at CMD, and the
 * avatar worker then re-establishes its HeyGen browser session
 * (HEYGEN_SETUP_TIMEOUT_MS is 90s in fly.avatar.toml). Confirming 'started'
 * does not guarantee the BullMQ workers have attached, but it does rule out the
 * failure this is meant to prevent: a job enqueued to a machine that never
 * came up at all.
 *
 * Idempotent and safe to call on every enqueue — an already-started machine
 * costs one list call and returns immediately.
 */
export async function startMachines(app: SleepableApp): Promise<{ started: string[]; alreadyUp: string[] }> {
  const name = flyAppName(app);
  if (!name) throw new FlyApiError(`no Fly app name configured for role '${app}'`);

  const machines = await listMachines(app);
  if (machines.length === 0) {
    // No machines at all means the app was scaled to zero with `scale count 0`
    // rather than stopped. Nothing to start, and creating one is not something
    // to do implicitly from a user request — surface it instead.
    throw new FlyApiError(
      `Fly app '${name}' has no machines to start (was it scaled to 0? use 'fly scale count 1' once to recreate it)`,
    );
  }

  const alreadyUp = machines.filter((m) => isUp(m.state)).map((m) => m.id);
  const toStart = machines.filter((m) => !isUp(m.state));
  if (toStart.length === 0) return { started: [], alreadyUp };

  await Promise.all(
    toStart.map((m) =>
      flyFetch(`/apps/${encodeURIComponent(name)}/machines/${m.id}/start`, { method: "POST" }),
    ),
  );

  // Fly exposes a blocking wait endpoint; it returns as soon as the machine
  // reaches the requested state, so this is not a poll loop.
  await Promise.all(
    toStart.map((m) =>
      flyFetch(
        `/apps/${encodeURIComponent(name)}/machines/${m.id}/wait?state=started&timeout=${Math.floor(
          getEnv().FLY_START_WAIT_MS / 1000,
        )}`,
      ),
    ),
  );

  return { started: toStart.map((m) => m.id), alreadyUp };
}

/**
 * Stop every running machine for this app.
 *
 * Fly sends SIGTERM and waits kill_timeout (300s, the Fly maximum — both
 * fly.avatar.toml and fly.ebook.toml set it explicitly) before SIGKILL, and
 * worker/index.ts closes its BullMQ workers on SIGTERM. That drain window is
 * NOT long enough for a live job: LOCK_DURATION_MS is 25 minutes and the
 * comments there describe a real ~22-minute avatar job. Hence the caller — see
 * lib/fly/idle-monitor.ts — must prove nothing is running before calling this;
 * the drain is a safety net for a job that starts in the race window, not a
 * licence to stop a busy machine.
 */
export async function stopMachines(app: SleepableApp): Promise<string[]> {
  const name = flyAppName(app);
  if (!name) throw new FlyApiError(`no Fly app name configured for role '${app}'`);

  const machines = await listMachines(app);
  const running = machines.filter((m) => m.state === "started");
  await Promise.all(
    running.map((m) =>
      flyFetch(`/apps/${encodeURIComponent(name)}/machines/${m.id}/stop`, { method: "POST" }),
    ),
  );
  return running.map((m) => m.id);
}

export { FlyApiError };
