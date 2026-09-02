/**
 * Idle monitor — stops the sleepable worker machines once they have proven
 * quiet, and only then.
 *
 * Runs on the ALWAYS-ON celebrity worker (WORKER_ROLE 'sourced' or 'all'). That
 * machine hosts Redis in-container and cannot itself sleep, so it is the one
 * process guaranteed to be awake and already holding a Redis connection — the
 * natural home for a watchdog over the other two apps. It deliberately does NOT
 * run on the machines it stops: a worker deciding to shut down its own machine
 * races with a job arriving on it.
 *
 * ── THE MISTAKE THIS FILE EXISTS TO AVOID ──────────────────────────────────
 *
 * "Stop when the queue is empty" is WRONG, and wrong in a way that looks right
 * in testing. A job that is being processed has already been popped off the
 * waiting list — it is `active`, not `waiting`. So a naive emptiness check sees
 * zero and stops the machine mid-render.
 *
 * That matters here more than in most pipelines. Fly caps kill_timeout at 300s
 * (fly.avatar.toml says so explicitly, and sets it), while LOCK_DURATION_MS in
 * worker/index.ts is 25 MINUTES because a single avatar job that re-renders a
 * wrong-orientation HeyGen clip runs ~22 minutes. A 5-minute drain cannot
 * cover that, so the job is SIGKILLed, its lock lapses, the stalled-job check
 * re-delivers it, and it re-renders work that was already finished — the
 * "never-clearing-spinner bug" documented at worker/index.ts:139-149.
 *
 * Hence two independent gates, both of which must be clear, for several
 * consecutive checks:
 *
 *   1. REDIS — every queue the role serves, across every NON-TERMINAL state.
 *      `delayed` is not optional: handlePoolBusy in worker/index.ts parks
 *      clips there via moveToDelayed while they wait for a free HeyGen account
 *      (AI33_SLOT_WAIT_MS is 300000 in fly.avatar.toml — five minutes invisible
 *      to both `waiting` and `active`). `waiting-children` likewise holds a
 *      planner parent whose fan-out is still running.
 *
 *   2. POSTGRES — the pipeline tracks live work in the DB as well, and the two
 *      can diverge. worker/index.ts:437-440 documents segments stranded at
 *      'pending' with NO media_job at all, because dispatchSegments died
 *      partway through /generate-assets. Redis reads empty while real work is
 *      outstanding; stopping there strands it indefinitely, because the sweep
 *      that would recover it only runs on a machine that is up.
 *
 * And a DEBOUNCE on top: a single clear reading can land in the gap between one
 * job finishing and the next being enqueued. FLY_IDLE_CHECKS_BEFORE_STOP
 * consecutive clear checks (default 6 x 5min = 30 minutes) is the margin. For
 * calibration: SWEEP_STALE_MS in worker/index.ts is 45 minutes, raised from 20
 * because the shorter window "false-killed a slow-but-alive 430-clip render".
 * A machine can look quiet and be very much alive. Do not tighten these
 * without re-reading that comment.
 */

import type { Queue } from "bullmq";
import { getEnv } from "@/lib/env";
import { getQueue, QUEUE_NAMES, type QueueName } from "@/lib/jobs/queue";
import { getServerSupabase } from "@/lib/supabase/server";
import { isMachineControlEnabled, stopMachines, type SleepableApp } from "@/lib/fly/machines";
import { EBOOK_QUEUE_PREFIX } from "@ebook/infra/queue/queues";

/**
 * Queue states that mean "work exists". Terminal states are excluded on
 * purpose: defaultJobOptions in lib/jobs/queue.ts retains 200 completed jobs
 * for 3 days and 200 failed for 7, so counting those would keep the machine
 * awake permanently after the first job it ever ran.
 */
const LIVE_STATES = ["waiting", "active", "delayed", "paused", "waiting-children"] as const;

/** The queues the avatar machine serves — mirrors the runSynthetic block in worker/index.ts. */
const AVATAR_QUEUES: QueueName[] = [
  QUEUE_NAMES.tts,
  QUEUE_NAMES.syntheticPlanner,
  QUEUE_NAMES.imageGeneration,
  QUEUE_NAMES.imageToVideo,
  QUEUE_NAMES.avatar,
  QUEUE_NAMES.pitchGen,
  // Easy to miss, and expensive to miss: a SYNTHETIC render runs on the avatar
  // machine, not the celebrity one (see enqueueRender's `synthetic` option).
  QUEUE_NAMES.renderSynthetic,
];

/**
 * media_jobs.type values owned by the synthetic engine. Same list as
 * SYNTHETIC_TYPES in worker/index.ts, including 'render' — the media_jobs type
 * is 'render' regardless of which queue ran it.
 */
const SYNTHETIC_JOB_TYPES = [
  "tts", "plan_synthetic", "image_gen", "image_to_video", "avatar", "pitch_gen", "render",
];

async function queueHasWork(q: Queue): Promise<boolean> {
  const counts = await q.getJobCounts(...LIVE_STATES);
  return Object.values(counts).some((n) => (n ?? 0) > 0);
}

/** True if ANY of the named queues holds a job in a non-terminal state. */
async function anyQueueBusy(names: string[]): Promise<boolean> {
  for (const name of names) {
    // getQueue() is typed to the video engine's QueueName union; the ebook
    // queues are plain prefixed strings on the same Redis, so they widen here.
    if (await queueHasWork(getQueue(name as QueueName))) return true;
  }
  return false;
}

/** Live ebook queue names, derived from the domain names so the two cannot drift. */
async function ebookQueueNames(): Promise<string[]> {
  const { QUEUE_NAMES: EBOOK_NAMES } = await import("@ebook/infra/queue/queues");
  return EBOOK_NAMES.map((n) => `${EBOOK_QUEUE_PREFIX}${n}`);
}

/**
 * Postgres gate for the avatar machine: any running synthetic media_job, or any
 * synthetic_segment still mid-flight.
 *
 * Fails CLOSED — a DB error returns "busy". A monitor that cannot verify the
 * system is idle must not stop a machine on that ignorance.
 */
async function syntheticDbBusy(): Promise<boolean> {
  try {
    const sb = getServerSupabase();
    const { data: jobs, error: jobErr } = await sb
      .from("media_jobs")
      .select("id")
      .in("status", ["queued", "running"])
      .in("type", SYNTHETIC_JOB_TYPES)
      .limit(1);
    if (jobErr) throw new Error(jobErr.message);
    if ((jobs ?? []).length > 0) return true;

    const { data: segs, error: segErr } = await sb
      .from("synthetic_segments")
      .select("id")
      .in("status", ["pending", "generating"])
      .limit(1);
    if (segErr) throw new Error(segErr.message);
    return (segs ?? []).length > 0;
  } catch (e) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(), msg: "fly.idle.db_check_failed",
      app: "avatar", err: (e as Error).message,
    }));
    return true; // fail closed
  }
}

/**
 * Postgres gate for the ebook machine, via its job_runs idempotency ledger.
 *
 * The ebook tables live in a DEDICATED `ebook` schema, not `public` (see
 * supabase/migrations/0031_ebook_schema.sql — the video engines already own a
 * `projects` table, so the two would collide). Reaching them needs the
 * schema-bound client from SupabaseClientFactory; getServerSupabase() is pinned
 * to `public` and would 404 here.
 *
 * job_runs is the right signal: worker/index.ts notes that the ebook stages are
 * wrapped in this ledger plus a convergence-barrier contract, so a book part-way
 * through its 18 stages has RUNNING/PENDING rows even in the moment between one
 * stage's queue draining and the next being enqueued — exactly the gap a
 * queue-only check would misread as idle.
 */
async function ebookDbBusy(): Promise<boolean> {
  try {
    const { SupabaseClientFactory } = await import(
      "@ebook/infra/persistence/supabase/SupabaseClientFactory"
    );
    const env = getEnv();
    const sb = SupabaseClientFactory.serviceRole(
      env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    );
    const { data, error } = await sb
      .from("job_runs")
      .select("job_key")
      .in("state", ["PENDING", "RUNNING"])
      .limit(1);
    if (error) throw new Error(error.message || "job_runs query failed");
    return (data ?? []).length > 0;
  } catch (e) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(), msg: "fly.idle.db_check_failed",
      app: "ebook", err: (e as Error).message,
    }));
    return true; // fail closed
  }
}

async function isIdle(app: SleepableApp): Promise<boolean> {
  if (app === "avatar") {
    if (await anyQueueBusy(AVATAR_QUEUES)) return false;
    return !(await syntheticDbBusy());
  }
  if (await anyQueueBusy(await ebookQueueNames())) return false;
  return !(await ebookDbBusy());
}

/** Consecutive clear checks per app. Reset to zero by ANY sign of work. */
const clearStreak: Record<SleepableApp, number> = { avatar: 0, ebook: 0 };

async function checkOnce(app: SleepableApp): Promise<void> {
  if (!isMachineControlEnabled(app)) return;

  let idle: boolean;
  try {
    idle = await isIdle(app);
  } catch (e) {
    // Redis hiccup mid-check (the Fly proxy recycles connections every ~10-20
    // min; see REDIS_BASE_OPTIONS). Treat as busy and reset — the cost is one
    // more idle interval, versus stopping a machine on bad information.
    console.error(JSON.stringify({
      ts: new Date().toISOString(), msg: "fly.idle.check_failed",
      app, err: (e as Error).message,
    }));
    clearStreak[app] = 0;
    return;
  }

  if (!idle) {
    clearStreak[app] = 0;
    return;
  }

  clearStreak[app] += 1;
  const needed = getEnv().FLY_IDLE_CHECKS_BEFORE_STOP;
  if (clearStreak[app] < needed) {
    console.log(JSON.stringify({
      ts: new Date().toISOString(), msg: "fly.idle.pending",
      app, clearChecks: clearStreak[app], needed,
    }));
    return;
  }

  try {
    const stopped = await stopMachines(app);
    console.log(JSON.stringify({
      ts: new Date().toISOString(), msg: "fly.machine.stopped",
      app, machines: stopped, afterClearChecks: clearStreak[app],
    }));
  } catch (e) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(), msg: "fly.machine.stop_failed",
      app, err: (e as Error).message,
    }));
  } finally {
    // Reset either way. On success there is nothing left to stop; on failure a
    // full quiet window must re-elapse before retrying, so a flapping Fly API
    // cannot turn into a stop attempt every interval.
    clearStreak[app] = 0;
  }
}

/**
 * Start the idle monitor. Returns a stop function, or undefined when the
 * monitor is not applicable (no app configured, or stopping disabled).
 */
export function startIdleMonitor(): (() => void) | undefined {
  const env = getEnv();
  if (!env.FLY_IDLE_STOP_ENABLED) return undefined;

  const apps: SleepableApp[] = (["avatar", "ebook"] as const).filter((a) => isMachineControlEnabled(a));
  if (apps.length === 0) return undefined;

  console.log(JSON.stringify({
    ts: new Date().toISOString(), msg: "fly.idle.monitor_start",
    apps, intervalMs: env.FLY_IDLE_CHECK_INTERVAL_MS,
    checksBeforeStop: env.FLY_IDLE_CHECKS_BEFORE_STOP,
  }));

  const timer = setInterval(() => {
    for (const app of apps) {
      void checkOnce(app).catch((e) =>
        console.error(JSON.stringify({
          ts: new Date().toISOString(), msg: "fly.idle.tick_error",
          app, err: (e as Error).message,
        })),
      );
    }
  }, env.FLY_IDLE_CHECK_INTERVAL_MS);

  // Never hold the process open on this timer alone.
  timer.unref?.();
  return () => clearInterval(timer);
}
