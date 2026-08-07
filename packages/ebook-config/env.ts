import { z } from 'zod';

/** Single source of truth for environment configuration — validated at startup. */
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
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
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
  cached = parsed.data;
  return cached;
}
