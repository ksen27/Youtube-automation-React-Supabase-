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
 *
 * The database generic is deliberately untyped: this project has no generated
 * `Database` types (`supabase gen types`), so every repository already treats
 * rows as unknown shapes it validates itself. `any` here is that absence stated
 * explicitly, not a shortcut — swapping in generated types later is a one-line
 * change to this alias.
 */
/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above */
export type EbookSupabaseClient = SupabaseClient<any, typeof EBOOK_SCHEMA, any>;

/**
 * Workers and server-side handlers use the service-role key.
 * (Upstream this mattered for bypassing RLS; the ported schema has no RLS —
 * see supabase/migrations/0031_ebook_schema.sql — but the service-role key is
 * still what server-side code uses.)
 */
/**
 * Gives failed requests a non-empty error message.
 *
 * A count query uses `head: true`, which PostgREST answers with a bodiless HEAD
 * response — so on failure supabase-js has nothing to build an error from and
 * hands the caller `{ message: '' }`. Every one of the ~24
 * `throw new Error(error.message)` call sites in these repositories then throws
 * a blank `Error:`, which is what a fresh deployment actually sees first.
 *
 * The case that matters is **PGRST106 "Invalid schema: ebook"** (HTTP 406),
 * returned until `ebook` is added under Supabase → Settings → API → Exposed
 * schemas — a required manual step after the migrations. Naming it here turns a
 * blank stack trace into the actual instruction.
 *
 * Only touches responses that would otherwise be blank; anything PostgREST
 * describes itself is passed through untouched.
 */
function diagnosticFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, init).then(async (res) => {
    if (res.ok) return res;
    const text = await res.clone().text().catch(() => '');
    // A body that already names the failure needs no help.
    if (text.trim()) return res;

    // The two setup failures a fresh deployment hits, in the order it hits them.
    // Both arrive bodiless on a HEAD (count) request, so without naming them
    // here they reach the log as a blank `Error:`.
    const reason =
      res.status === 406
        ? `PGRST106: the "${EBOOK_SCHEMA}" schema is not exposed by PostgREST. ` +
          `Add it under Supabase → Data API → "Exposed schemas" ` +
          `(and confirm migrations 0031/0032 have been applied).`
        : res.status === 403
          ? `42501: permission denied for schema "${EBOOK_SCHEMA}". The Data API ` +
            `roles have no privileges on it — apply migration ` +
            `0033_ebook_schema_grants.sql.`
          : `HTTP ${res.status} ${res.statusText}`.trim();

    return new Response(JSON.stringify({ message: reason, code: String(res.status) }), {
      status: res.status,
      statusText: res.statusText,
      // Force JSON: the original HEAD reply advertises no content type, and
      // supabase-js only parses an error body when it is told it is JSON.
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

export class SupabaseClientFactory {
  static serviceRole(url: string, serviceRoleKey: string): EbookSupabaseClient {
    return createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      db: { schema: EBOOK_SCHEMA },
      global: { fetch: diagnosticFetch },
    });
  }
}
