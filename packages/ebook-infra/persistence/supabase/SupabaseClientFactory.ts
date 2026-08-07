import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * The ebook product's 24 tables live in a dedicated Postgres schema rather than
 * `public`, because this app also hosts the video engines, whose own `projects`
 * table would otherwise collide — and whose future migrations would keep
 * colliding with generic names like `videos` / `channels` / `chapters`.
 *
 * Setting the schema HERE is what makes that namespacing free: every repository
 * takes its client by injection, so all ~65 `.from(...)` calls and the
 * `decrement_pending` RPC resolve against `ebook.*` with no per-repository edit.
 * Table names in the repositories stay unqualified — do not prefix them.
 *
 * NOTE: the schema must be exposed in Supabase's API settings (Settings → API →
 * Exposed schemas) or PostgREST answers every query with `PGRST106`.
 */
export const EBOOK_SCHEMA = 'ebook';

/**
 * A client already bound to the `ebook` schema. The bare `SupabaseClient` type
 * is pinned to `"public"`, so repositories must annotate their injected client
 * with THIS alias — otherwise the schema shows up as a type mismatch at every
 * construction site.
 */
export type EbookSupabaseClient = SupabaseClient<any, typeof EBOOK_SCHEMA, any>;

/**
 * Workers and server-side handlers use the service-role key.
 * (Upstream this mattered for bypassing RLS; the ported schema has no RLS —
 * see supabase/migrations/0031_ebook_schema.sql — but the service-role key is
 * still what server-side code uses.)
 */
export class SupabaseClientFactory {
  static serviceRole(url: string, serviceRoleKey: string): EbookSupabaseClient {
    return createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      db: { schema: EBOOK_SCHEMA },
    });
  }
}
