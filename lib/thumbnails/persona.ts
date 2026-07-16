import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createPersona,
  pollPersona,
  getPersonaStatus,
  isPersonaEnabled,
  type PersonaStatus,
} from "@/lib/thumbnails/pikzels";

// Build-or-reuse a Pikzels PERSONA (identity lock) for an uploaded face, backed
// by the thumbnail_personas cache table (migration 0028).
//
// WHY: Pikzels regenerates a NEW person from an uploaded face unless a persona
// is supplied; the persona preserves the EXACT face. Building one is async +
// costs an API call, so we cache the persona id keyed by the face image URL and
// reuse a 'completed' persona across titles and channels.
//
// resolvePersonaForFace returns a usable persona id, or null when the face-lock
// can't be produced (disabled, no face, or the build didn't finish in the poll
// budget) — the caller then falls back to the plain uploaded-face-as-base path
// so generation is never blocked by a slow/failed persona build.

// The identity source: the FIRST uploaded subject face is what we lock onto.
// (Two-subject thumbnails are rare for the avatar use case; we lock the primary
// face and let the prompt carry the rest.)
export async function resolvePersonaForFace(
  sb: SupabaseClient,
  faceUrl: string,
  personaName: string,
): Promise<string | null> {
  if (!isPersonaEnabled()) return null;
  const face = faceUrl.trim();
  if (!face) return null;

  // 1) Cache hit? A completed persona for this exact face is reused as-is.
  const { data: existing } = await sb
    .from("thumbnail_personas")
    .select("id, persona_id, status")
    .eq("face_url", face)
    .maybeSingle();

  if (existing?.persona_id) {
    if (existing.status === "completed") return existing.persona_id;
    // A row exists but isn't confirmed complete — re-poll the live status
    // rather than rebuild (the persona may have finished since we last looked).
    if (existing.status === "processing" || existing.status === "pending") {
      const status = await pollPersonaAndSync(sb, existing.id, existing.persona_id);
      return status === "completed" ? existing.persona_id : null;
    }
    // status === 'failed' falls through to a rebuild below.
  }

  // 2) Build a new persona. Reserve the cache row FIRST (idempotent on the
  //    unique face_url index) so concurrent generations don't double-build.
  const { data: reserved, error: upErr } = await sb
    .from("thumbnail_personas")
    .upsert({ face_url: face, status: "pending", error: null }, { onConflict: "face_url" })
    .select("id")
    .single();
  if (upErr || !reserved) return null;

  let personaId: string;
  try {
    const created = await createPersona({ name: personaName, faceUrls: [face] });
    personaId = created.personaId;
  } catch (err) {
    await sb
      .from("thumbnail_personas")
      .update({ status: "failed", error: errMsg(err), updated_at: new Date().toISOString() })
      .eq("id", reserved.id);
    return null;
  }

  await sb
    .from("thumbnail_personas")
    .update({ persona_id: personaId, status: "processing", updated_at: new Date().toISOString() })
    .eq("id", reserved.id);

  // 3) Poll to completion (async build, ~60s typical). On timeout we leave the
  //    row 'processing' so a later generation can reuse it once it finishes.
  const status = await pollPersonaAndSync(sb, reserved.id, personaId);
  return status === "completed" ? personaId : null;
}

// Poll a persona to a terminal state and write the result back to its cache row.
async function pollPersonaAndSync(
  sb: SupabaseClient,
  rowId: string,
  personaId: string,
): Promise<PersonaStatus> {
  let status: PersonaStatus;
  try {
    status = await pollPersona(personaId);
  } catch {
    // A transient poll error shouldn't poison the cache row — report the live
    // status once more; if that also throws, treat as not-ready.
    try {
      status = await getPersonaStatus(personaId);
    } catch {
      return "processing";
    }
  }
  await sb
    .from("thumbnail_personas")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", rowId);
  return status;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : "persona build failed";
}
