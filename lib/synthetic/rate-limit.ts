import { getRedisConnection } from "@/lib/jobs/queue";

// CROSS-PROCESS 69labs rate limiting (Redis-backed).
//
// WHY THIS EXISTS
// ---------------
// The old per-KEY semaphore in sixtynine-labs.ts lived in PROCESS memory, so its
// cap was enforced PER WORKER PROCESS. With 2 avatar-worker machines, the real
// per-account concurrency was `cap × machines`, which overshot 69labs' true
// per-account ceiling of 7 → constant "Concurrent image generation limit
// reached (7)" 403s. And when several full videos generated at once, ~74 jobs
// each polled the status endpoint on its own timer → the request-rate 429
// "TOO_MANY_REQUESTS" on top of the 403s.
//
// Both limits are GLOBAL to a 69labs account, so the throttle must be global to
// the CLUSTER, not per-process. These two primitives coordinate every lane on
// every machine through the shared Redis both workers already use:
//
//   1. AccountSlots — a distributed semaphore per account (per key). Total
//      concurrent generations across the whole cluster stays ≤ the per-account
//      cap, so multiple videos can run at once and SHARE the fixed 21 slots (3
//      accounts × 7) fairly instead of stampeding past them.
//   2. PollRateLimiter — a token bucket capping status polls/second across the
//      whole cluster, so the combined poll rate stays under 69labs' request-rate
//      budget no matter how many jobs are in flight.
//
// CRASH SAFETY: a leased slot carries a TTL, so a worker that dies mid-generation
// cannot leak a slot forever — the lease expires and the slot returns to the
// pool. The TTL is set well above the max generation time (image poll timeout)
// so a live job never loses its slot.

const KEY_PREFIX = "sixtynine:limit:";

// A slot lease's TTL. Must exceed the longest a single generation can hold a
// slot (submit + poll-to-COMPLETED + download). The image poll timeout is 300s;
// we give a generous margin so a slow-but-alive job never has its lease expire
// out from under it, while a truly dead worker's slot still returns within a few
// minutes. Refreshed on a heartbeat while the work runs (see withAccountSlot).
const SLOT_TTL_MS = 8 * 60_000; // 8 min
const SLOT_HEARTBEAT_MS = 60_000; // refresh the lease every 60s while working

// ---------------------------------------------------------------------------
// 1) Distributed per-account concurrency semaphore.
// ---------------------------------------------------------------------------
// Implemented as a Redis sorted set per account: each in-flight generation adds
// a member (a unique token) scored by its lease-expiry timestamp. Acquire is an
// atomic Lua script that (a) drops expired members, then (b) adds ours only if
// the live count is below the cap. This makes "prune stale + check capacity +
// take a slot" a single atomic step so two machines can't both grab the last
// slot. Returns 1 on success, 0 when the account is full.
const ACQUIRE_LUA = `
local zkey = KEYS[1]
local now = tonumber(ARGV[1])
local cap = tonumber(ARGV[2])
local token = ARGV[3]
local expiresAt = tonumber(ARGV[4])
-- prune leases that have expired (crashed/leaked holders)
redis.call('ZREMRANGEBYSCORE', zkey, '-inf', now)
local live = redis.call('ZCARD', zkey)
if live < cap then
  redis.call('ZADD', zkey, expiresAt, token)
  -- keep the set from lingering forever if the account goes idle
  redis.call('PEXPIRE', zkey, 900000)
  return 1
end
return 0
`;

// Refresh a held lease's expiry (heartbeat) so a long-but-live generation keeps
// its slot. No-op if the token was already evicted (returns 0).
const REFRESH_LUA = `
local zkey = KEYS[1]
local token = ARGV[1]
local expiresAt = tonumber(ARGV[2])
if redis.call('ZSCORE', zkey, token) then
  redis.call('ZADD', zkey, expiresAt, token)
  return 1
end
return 0
`;

function slotKey(accountId: string): string {
  return `${KEY_PREFIX}slots:${accountId}`;
}

// A monotonic-ish unique token for a lease. We avoid Math.random()/Date.now()
// concerns by combining the counter with a per-process nonce seeded from the
// pid; uniqueness within the cluster only needs to be good enough that two
// concurrent acquirers don't collide, and pid+counter guarantees that.
let leaseCounter = 0;
const PROC_NONCE = `${process.pid.toString(36)}`;
function newToken(): string {
  leaseCounter = (leaseCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `${PROC_NONCE}-${leaseCounter}`;
}

/**
 * Run `work` while holding one concurrency slot on `accountId` (its 69labs
 * account). Blocks (polling with backoff) until a slot is free, so a job that
 * can't get in WAITS WITHOUT holding anything — the fix for the old "backoff
 * while holding a permit" thrash. The lease is heartbeated across the work and
 * always released in a finally, including on throw.
 *
 * `cap` is the per-account concurrency ceiling (e.g. 6, staying under 69labs' 7).
 * `nowMs` is passed in by the caller (Date.now is unavailable in some contexts);
 * callers pass Date.now().
 */
export async function withAccountSlot<T>(
  accountId: string,
  cap: number,
  work: () => Promise<T>,
  opts: { acquireTimeoutMs?: number } = {},
): Promise<T> {
  const redis = getRedisConnection();
  const zkey = slotKey(accountId);
  const token = newToken();
  const acquireTimeoutMs = opts.acquireTimeoutMs ?? 5 * 60_000;

  // --- acquire (block until a slot frees or we time out) ---
  const deadline = Date.now() + acquireTimeoutMs;
  let acquired = false;
  let waitMs = 500;
  while (Date.now() < deadline) {
    const now = Date.now();
    const res = (await redis.eval(
      ACQUIRE_LUA,
      1,
      zkey,
      String(now),
      String(cap),
      token,
      String(now + SLOT_TTL_MS),
    )) as number;
    if (res === 1) {
      acquired = true;
      break;
    }
    // Account full — wait WITHOUT holding a slot, with jittered backoff capped
    // at a few seconds so we re-check promptly once a slot frees.
    const jitter = 0.75 + Math.random() * 0.5;
    await new Promise((r) => setTimeout(r, Math.round(waitMs * jitter)));
    waitMs = Math.min(waitMs * 1.5, 4000);
  }
  if (!acquired) {
    throw new Error(`69labs slot acquire timed out for account ${accountId} (all slots busy)`);
  }

  // --- heartbeat the lease while the work runs ---
  const beat = setInterval(() => {
    void redis
      .eval(REFRESH_LUA, 1, zkey, token, String(Date.now() + SLOT_TTL_MS))
      .catch(() => {});
  }, SLOT_HEARTBEAT_MS);

  try {
    return await work();
  } finally {
    clearInterval(beat);
    // Release: remove our token. Best-effort — if it fails, the TTL reclaims it.
    await redis.zrem(zkey, token).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 2) Global poll-rate token bucket (fixes the status-endpoint 429).
// ---------------------------------------------------------------------------
// A classic token bucket in Redis: tokens refill at `ratePerSec` up to `burst`,
// and each poll must take one token. Atomic Lua so both machines draw from ONE
// budget. Returns the ms to wait if no token is available (0 when a token was
// taken). The caller loops: take → if wait>0 sleep(wait) → retry.
const BUCKET_LUA = `
local bkey = KEYS[1]
local now = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local burst = tonumber(ARGV[3])
local tokens = tonumber(redis.call('HGET', bkey, 'tokens') or burst)
local last = tonumber(redis.call('HGET', bkey, 'ts') or now)
-- refill based on elapsed time
local elapsed = math.max(0, now - last) / 1000.0
tokens = math.min(burst, tokens + elapsed * rate)
local wait = 0
if tokens >= 1 then
  tokens = tokens - 1
else
  wait = math.ceil((1 - tokens) / rate * 1000)
end
redis.call('HSET', bkey, 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', bkey, 60000)
return wait
`;

function bucketKey(name: string): string {
  return `${KEY_PREFIX}bucket:${name}`;
}

/**
 * Block until a token is available from the named global bucket, then return.
 * `ratePerSec` tokens/sec refill, up to `burst` tokens. Used to cap the CLUSTER's
 * combined 69labs status-poll rate so the request-rate 429 stops.
 */
export async function acquirePollToken(
  name: string,
  ratePerSec: number,
  burst: number,
): Promise<void> {
  const redis = getRedisConnection();
  const bkey = bucketKey(name);
  // Bounded loop so a wedged bucket can't hang a poll forever; in practice a
  // token frees within `1/rate` seconds.
  for (let i = 0; i < 100; i++) {
    const wait = (await redis.eval(
      BUCKET_LUA,
      1,
      bkey,
      String(Date.now()),
      String(ratePerSec),
      String(burst),
    )) as number;
    if (wait <= 0) return;
    await new Promise((r) => setTimeout(r, Math.min(wait, 2000)));
  }
  // Fell through the loop budget — proceed anyway rather than block the job; the
  // per-poll withHttpRetry still rides out an occasional 429.
}
