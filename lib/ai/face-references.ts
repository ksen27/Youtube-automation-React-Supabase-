// Reference roster builder for the closed-world matching refactor
// (Slice 2 of 7). Given a list of entities the script names — celebrity,
// other people, companies, TV shows, movies, songs, places — fetch a
// canonical reference image for each one and persist it to face_references.
//
// The reference image is later fed to Gemini's verification gate
// (lib/ai/verify.ts) which answers: "is this candidate clip/image actually
// of the same person / logo / poster / place as this reference?" That
// answer is what makes the matcher's identity check structural instead of
// text-match heuristic.
//
// This module is INTENTIONALLY isolated:
//   - It does not import the matcher or any processor.
//   - It does not mutate any existing tables.
//   - It is safe to call multiple times — buildReferenceRoster() upserts
//     on (project_id, entity_type, lower(entity_name)).
//
// Slice 4-6 will call buildReferenceRoster() during project setup (or
// lazily on first match) and lookupReference() at clip/image fetch time.

import { fetchWikipediaImage } from "@/lib/images/wikipedia";
import { getServerSupabase } from "@/lib/supabase/server";
import type { BlockEntityType } from "@/lib/ai/segments";

// Matchable types only — celebrity_default doesn't get its own reference
// row because the project celebrity IS one of the entities (type="person")
// and shares its row with any other named person.
export type ReferenceEntityType = Exclude<BlockEntityType, "celebrity_default">;

export interface ReferenceEntity {
  type: ReferenceEntityType;
  name: string;
}

export interface FaceReferenceRow {
  id: string;
  project_id: string;
  entity_type: ReferenceEntityType;
  entity_name: string;
  source: "wikipedia" | "operator" | "search";
  reference_url: string | null;
  source_page_url: string | null;
  metadata: Record<string, unknown>;
}

// Per-entity-type query hints. Wikipedia indexes pages by canonical title;
// adding a disambiguating suffix dramatically improves the hit rate for
// generic-sounding names (e.g. "Apple" → company, not the fruit).
//
// Returns an ordered list of query strings to try; first hit wins.
function wikipediaCandidatesFor(entity: ReferenceEntity): string[] {
  const name = entity.name.trim();
  if (!name) return [];
  switch (entity.type) {
    case "person":
      // Bare name first (most people are best-known by name alone), then
      // disambiguated fallback in case Wikipedia routes us to a different
      // article (e.g. "John Smith (cricketer)" vs the philosopher).
      return [name];
    case "company":
      // Most company pages live at the bare name. Some collide with a
      // common word ("Apple" the fruit) so we add a (company) suffix as
      // a fallback. Wikipedia disambiguation pages use this exact pattern.
      return [name, `${name} (company)`];
    case "tv_show":
      return [name, `${name} (TV series)`, `${name} (British TV series)`];
    case "movie":
      return [name, `${name} (film)`];
    case "song":
      return [name, `${name} (song)`];
    case "place":
      return [name];
  }
}

// Fetch ONE reference image for ONE entity. Returns null when no Wikipedia
// candidate matches OR when the matching page has no infobox image.
//
// The returned `source_page_url` is informational only — Gemini receives
// the image URL itself, not the page.
export async function fetchEntityReference(
  entity: ReferenceEntity,
): Promise<{ url: string; pageUrl: string; pageTitle: string } | null> {
  const queries = wikipediaCandidatesFor(entity);
  for (const q of queries) {
    const hit = await fetchWikipediaImage(q);
    if (hit) {
      return { url: hit.url, pageUrl: hit.pageUrl, pageTitle: hit.pageTitle };
    }
  }
  return null;
}

// Upsert one reference row. Always writes, even when fetch returned null —
// a row with reference_url=NULL records "we tried and failed", so the
// matcher can fast-path skip the gate for that entity instead of re-trying
// Wikipedia on every clip download.
export async function upsertReference(
  projectId: string,
  entity: ReferenceEntity,
): Promise<FaceReferenceRow> {
  const sb = getServerSupabase();
  const hit = await fetchEntityReference(entity);
  const payload = {
    project_id: projectId,
    entity_type: entity.type,
    entity_name: entity.name,
    source: "wikipedia" as const,
    reference_url: hit?.url ?? null,
    source_page_url: hit?.pageUrl ?? null,
    metadata: hit ? { wikipedia_title: hit.pageTitle } : {},
  };
  const { data, error } = await sb
    .from("face_references")
    .upsert(payload, { onConflict: "project_id,entity_type,entity_name" })
    .select("*")
    .single();
  if (error) {
    throw new Error(
      `face_references upsert failed for ${entity.type}/${entity.name}: ${error.message}`,
    );
  }
  return data as FaceReferenceRow;
}

// Build the full reference roster for a project. De-duplicates inputs by
// (type, lower(name)) so callers don't have to. Runs upserts in parallel
// with a small concurrency cap to be friendly to Wikipedia.
export async function buildReferenceRoster(
  projectId: string,
  entities: ReferenceEntity[],
  opts: { concurrency?: number } = {},
): Promise<FaceReferenceRow[]> {
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const seen = new Set<string>();
  const dedup: ReferenceEntity[] = [];
  for (const e of entities) {
    const name = e.name.trim();
    if (!name) continue;
    const key = `${e.type}::${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push({ type: e.type, name });
  }

  const out: FaceReferenceRow[] = [];
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= dedup.length) return;
      try {
        const row = await upsertReference(projectId, dedup[idx]);
        out.push(row);
      } catch (e) {
        // One entity's Wikipedia / DB failure should not poison the rest of
        // the roster. Log and continue — the matcher's fallback path handles
        // missing references gracefully.
        console.error(JSON.stringify({
          msg: "face_references.upsert_failed",
          entity: dedup[idx],
          err: (e as Error).message?.slice(0, 200),
        }));
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}

// Read a single reference. Used by the matcher gate when deciding whether
// to verify a candidate against an entity. Returns null when no row exists
// AND when the row exists but reference_url is NULL (matcher should treat
// both cases identically — "no reference available, skip the gate").
export async function lookupReference(
  projectId: string,
  type: ReferenceEntityType,
  name: string,
): Promise<FaceReferenceRow | null> {
  const sb = getServerSupabase();
  const { data, error } = await sb
    .from("face_references")
    .select("*")
    .eq("project_id", projectId)
    .eq("entity_type", type)
    .ilike("entity_name", name.trim())
    .maybeSingle();
  if (error) {
    console.error(JSON.stringify({
      msg: "face_references.lookup_failed",
      project: projectId,
      type, name,
      err: error.message,
    }));
    return null;
  }
  if (!data) return null;
  const row = data as FaceReferenceRow;
  // Treat NULL reference_url as "no reference" — caller skips the gate.
  if (!row.reference_url) return null;
  return row;
}
