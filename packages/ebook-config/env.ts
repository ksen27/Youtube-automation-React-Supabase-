import { z } from 'zod';

/** Single source of truth for environment configuration — validated at startup. */
/**
 * An env var that can actually be switched OFF.
 *
 * `z.coerce.boolean()` calls `Boolean(value)`, and `Boolean("false")` is TRUE —
 * so a flag declared that way cannot be turned off from the environment at all.
 * Setting `PAYHIP_USE_STEALTH=false` as a Fly secret enabled stealth, which
 * cost most of a day: the local CLI reads `process.env` directly and honoured
 * the "false", so the same setting behaved one way on a laptop and the opposite
 * way on the worker, and every log line insisted the flag was on while the
 * operator could see they had set it off.
 *
 * The same trap is documented at lib/env.ts:948 for `SYNTHETIC_PLAN_ALIGN_FIRST`,
 * where it was found the same way.
 */
const boolish = (fallback: boolean) =>
  z
    .preprocess(
      (v) => (typeof v === 'string' ? !/^(0|false|no|off)$/i.test(v.trim()) : v),
      z.boolean(),
    )
    .default(fallback);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_URL: z.string().url().default('http://localhost:3000'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  SUPABASE_URL: z.string().url(),
  // PORT NOTE: optional here, required upstream. The anon key is only used by a
  // BROWSER Supabase client for the per-user auth flow, which this app does not
  // have (one shared password, lib/auth.ts) — nothing in the ported code reads
  // it. Requiring it would make a worker-only deploy fail to boot over a value
  // it never uses.
  SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // PORT NOTE: upstream had ADMIN_EMAIL here to gate a Supabase-auth login page.
  // This app authenticates with one shared password (lib/auth.ts) and has no
  // user accounts, so that setting was dropped — it was declared but never read.
  //
  // The ported domain layer still threads an ownerId through the per-owner
  // concurrency cap, the queued-project promotion order, and the cross-project
  // sibling checks. With a single tenant there is exactly one owner, so the app
  // writes this fixed sentinel uuid everywhere and those limits become
  // app-global. Overridable only so a future multi-tenant migration has a seam.
  EBOOK_OWNER_ID: z.string().uuid().default('00000000-0000-0000-0000-000000000001'),

  REDIS_URL: z.string().min(1),

  // How many books one user may have in flight at once. Several projects run in
  // parallel and the queue schedules fairly between them, but each one still
  // consumes worker slots and Anthropic tokens — this bounds that.
  MAX_ACTIVE_PROJECTS_PER_USER: z.coerce.number().int().positive().default(3),

  ANTHROPIC_API_KEY: z.string().min(1),
  ANTHROPIC_MAX_TPM: z.coerce.number().int().positive().default(80_000),

  YOUTUBE_API_KEY: z.string().min(1),

  WHISPER_PROVIDER: z.enum(['openai', 'self-hosted']).default('openai'),
  OPENAI_API_KEY: z.string().optional(),

  // gpt-image-1 exposes low|medium|high|auto. LOW is the default on client
  // direction 2026-08-24 ("its very important to use the lowest quality,
  // otherwise its very expensive") — high is roughly an order of magnitude
  // dearer per image. This setting governs the in-chapter ILLUSTRATION
  // fallback, where a book can burn dozens of images and low is the right
  // trade.
  OPENAI_IMAGE_QUALITY: z.enum(['low', 'medium', 'high', 'auto']).default('low'),

  // The COVER is a different trade, and had been sharing the setting above.
  //
  // Every word of the cover — title, deck, subtitle — is drawn by the image
  // model (see html.ts: "no overlay at all, the artwork IS the cover"), and
  // small text is the first thing `low` destroys. Measured on one book, same
  // prompt and inputs each time: three generations at `low` came back with a
  // garbled deck and an invented paragraph of noise; the same call at `high`
  // rendered every line correctly.
  //
  // The comment that justified `low` for covers said the artwork sat under
  // HTML-typeset title text, so fidelity bought nothing. That stopped being
  // true when the text moved into the image, and the setting outlived its
  // reason. It is ONE image per book, against a hundred pages of Claude — the
  // cost difference is noise, and an unreadable cover is unsellable.
  OPENAI_COVER_QUALITY: z.enum(['low', 'medium', 'high', 'auto']).default('high'),

  // 69labs — generates ONLY the in-chapter illustrations. If unset, books carry
  // no illustrations.
  //
  // PORT NOTE: upstream this was its own LABS69_API_KEY. Here it reuses the
  // app-wide SIXTYNINE_LABS_API_KEY (the same var lib/env.ts reads) because both
  // products bill ONE 69labs account — see the mega-key cutover. Two separate
  // vars would let the products drift onto different keys and quietly defeat the
  // shared concurrency pool that SharedPoolImageGenerator depends on.
  SIXTYNINE_LABS_API_KEY: z.string().optional(),
  // Per-account concurrent-image ceiling, shared with the video engines via the
  // Redis slot pool in lib/synthetic/rate-limit.ts. Mirrors lib/env.ts's default
  // so a book and a render can never disagree about the account's capacity.
  SIXTYNINE_IMAGE_CONCURRENCY: z.coerce.number().int().positive().default(4),
  // Which 69labs model to use for illustrations. Defaults to "nano-banana-2"
  // (higher quality, same 1-credit cost, ~38s/image). "img-flux" (Flux Schnell)
  // is faster (~10s) but lower quality; "nano-banana-pro" is 2 credits.
  LABS69_IMAGE_MODEL: z.string().default('nano-banana-2'),

  // Netlify — hosts the generated sales landing pages. Optional: when unset the
  // pages can still be generated and previewed, they just can't be published.
  NETLIFY_AUTH_TOKEN: z.string().optional(),
  /** Team slug; only needed when the token has access to more than one team. */
  NETLIFY_ACCOUNT_SLUG: z.string().optional(),

  // ── Payhip (the store a finished book is listed on) ───────────────────────
  // Payhip has no product-creation API, so listing a book drives their real
  // dashboard in a browser. There are deliberately NO credential variables
  // here: a human logs in once via `npm run payhip:connect` and the resulting
  // session is stored encrypted in the database (ebook.payhip_sessions). A
  // worker that could read a password is a worker that could leak one.
  PAYHIP_BASE_URL: z.string().url().default('https://payhip.com'),
  /** Per-action budget. Uploads get their own, much longer allowance. */
  PAYHIP_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),
  /** Screenshots + HTML snapshots of failed runs land here. */
  PAYHIP_DEBUG_DIR: z.string().default('/tmp/payhip-debug'),
  /** Where upload files are staged before Playwright reads them off disk. */
  PAYHIP_TMP_DIR: z.string().optional(),
  /** Run the automation visibly. For local debugging only — never on a worker. */
  PAYHIP_HEADED: boolish(false),
  /** Slows a headed run down so a human can watch what it does. */
  PAYHIP_SLOWMO_MS: z.coerce.number().int().nonnegative().default(0),
  /**
   * Drive Payhip with patchright (stealth-patched Chromium) rather than vanilla
   * Playwright. ON by default: Payhip is behind Cloudflare, which serves a
   * "performing security verification" interstitial to browsers it reads as
   * bots, and a plain headless Chromium is read that way every time.
   */
  PAYHIP_USE_STEALTH: boolish(true),
  /**
   * Residential proxy for the Payhip browser — `ip:port` or `ip:port:user:pass`.
   *
   * Cloudflare scores IP reputation as heavily as browser fingerprint, and
   * datacenter ranges (Fly, most clouds) are challenged regardless of how clean
   * the browser looks. Unset means "connect directly", which is right for a
   * laptop and usually wrong for a worker.
   */
  PAYHIP_PROXY: z.string().optional(),
  /**
   * Route the one-time `payhip:connect` login through PAYHIP_PROXY too.
   *
   * Off by default because a human connects from their own machine and a broken
   * proxy there just blocks the login. Turn it ON once the proxy works: a
   * session created through the SAME exit IP the worker uses never shows Payhip
   * an IP jump between login and use, which is itself a reason to re-challenge.
   */
  PAYHIP_CONNECT_USES_PROXY: boolish(false),
  /**
   * How often the worker visits Payhip to keep the stored session from lapsing.
   *
   * Payhip's window slides on USE, and listings come in bursts, so without this
   * the session dies between them and an ordinary user meets a CLI they have no
   * way to run. Longer than HeyGen's 30 minutes because Payhip sits behind
   * Cloudflare and a needlessly chatty poll is itself a risk; an hour is ample
   * to keep a sliding window open.
   */
  PAYHIP_KEEPALIVE_MINUTES: z.coerce.number().int().positive().default(60),
  /**
   * Pin the browser's user agent for BOTH the connect CLI and the worker.
   *
   * Set the same value in `.env.local` and as a Fly secret. The point is that
   * they match: the connect runs on Windows and the worker on Linux, and a
   * session created by one browser and presented by an apparently different one
   * can be dropped — reported as a redirect to login, which reads exactly like
   * an ordinary expiry. A desktop Linux Chrome string is the honest pick, since
   * that is what the worker really is.
   */
  PAYHIP_USER_AGENT: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

/**
 * Validate an environment WITHOUT caching.
 *
 * `loadEnv` memoises for the life of the process, which is right for a
 * container and useless for testing a parse — every call after the first
 * returns the first answer regardless of input. This is the seam the flag tests
 * use, and it is the whole of `loadEnv` minus the cache.
 */
export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse({
    ...source,
    // PORT NOTE: this app names the Supabase project URL
    // NEXT_PUBLIC_SUPABASE_URL (lib/env.ts); upstream called it SUPABASE_URL.
    // Fall back to the app's name rather than making the operator set the same
    // URL twice under two keys — two copies of one value drift.
    SUPABASE_URL: source.SUPABASE_URL || source.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_ANON_KEY: source.SUPABASE_ANON_KEY || source.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  return parsed.data;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  cached = parseEnv(source);
  return cached;
}
