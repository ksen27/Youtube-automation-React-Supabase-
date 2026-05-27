// Deterministic resolver: lower-third noun → canonical visual entity.
//
// The Google Doc author marks specific words in red ("Bruno Tonioli",
// "Guardian", "London Palladium", "Dixon") to attach a lower-third chip
// at the spoken moment. The matcher then has to decide what should be
// ON SCREEN behind that chip:
//
//   - Bruno Tonioli  → photo of Bruno Tonioli       (entity_type: person)
//   - Guardian       → The Guardian masthead/logo   (entity_type: company)
//   - London Palladium → photo of the venue          (entity_type: place)
//   - Dixon          → photo of Alesha Dixon         (entity_type: person)
//
// Per the client spec, ONLY six entity types are allowed to drive the
// visual: person, company, tv_show, movie, song, place. Anything else
// (abstract concepts like "lawsuit", "ceremony", "ten year run", bare
// dates, generic phrases) MUST fall back to the project celebrity —
// the resolver returns null for those and the caller leaves the existing
// item assignment alone (which is already the celebrity-default path).
//
// Inputs come from the analyze-step roster persisted to face_references —
// the same Wikipedia photos used by the verify gate. We reuse the roster
// instead of running a live image search per marker, which keeps this
// step cheap and deterministic. Entities not in the roster are silently
// skipped; the caller logs them so the writer knows which doc markers
// the system couldn't ground.

import type { FaceReferenceRow, ReferenceEntityType } from "@/lib/ai/face-references";

export interface LowerThirdResolverContext {
  // Lowercased canonical-name → reference row. Built once per project from
  // face_references; passed in instead of being looked up so the marker
  // pass can stay synchronous.
  byNameLower: Map<string, FaceReferenceRow>;
  // Lowercased last-name token → list of full-name rows. Lets us resolve
  // partial-name lower-thirds ("Dixon" → "Alesha Dixon") when exactly one
  // full-name entity ends with that token. Multi-match ("Cowell" with two
  // Cowells in the project) returns no resolution so we don't guess wrong.
  byLastNameLower: Map<string, FaceReferenceRow[]>;
}

export interface LowerThirdResolution {
  entity_type: ReferenceEntityType;
  entity_name: string;        // canonical (full) name from the roster
  reference_url: string;       // direct URL to the canonical image
  match: "exact" | "last_name";
}

// Build the resolver context from a raw set of face_references rows.
// Pure data shape — no I/O. Caller is responsible for fetching the rows.
export function buildResolverContext(rows: FaceReferenceRow[]): LowerThirdResolverContext {
  const byNameLower = new Map<string, FaceReferenceRow>();
  const byLastNameLower = new Map<string, FaceReferenceRow[]>();
  for (const row of rows) {
    if (!row.reference_url) continue;       // skip rows with no Wikipedia photo
    const nameLower = row.entity_name.trim().toLowerCase();
    if (!nameLower) continue;
    byNameLower.set(nameLower, row);
    // Last-name index ONLY for person rows — surnames are meaningless for
    // companies / shows / places ("The Guardian" → "guardian" already gets
    // exact-match priority).
    if (row.entity_type === "person") {
      const tokens = nameLower.split(/\s+/).filter(Boolean);
      const last = tokens[tokens.length - 1];
      if (last && last.length >= 2) {
        const bucket = byLastNameLower.get(last) ?? [];
        bucket.push(row);
        byLastNameLower.set(last, bucket);
      }
    }
  }
  return { byNameLower, byLastNameLower };
}

// Resolve a lower-third noun to a canonical entity. Returns null when:
//   - the noun is empty / whitespace
//   - the noun doesn't match any entity in the roster (exact or last-name)
//   - the noun matches multiple persons by last name (ambiguous)
//
// This is intentionally STRICT. The client spec says non-matching nouns
// fall back to the project celebrity — and the caller handles that by
// leaving the item's existing assignment alone (which is already the
// celebrity path). Returning null here is the signal for "do nothing".
export function resolveLowerThird(
  noun: string,
  ctx: LowerThirdResolverContext,
): LowerThirdResolution | null {
  const norm = noun.trim().replace(/\s+/g, " ");
  if (!norm) return null;
  const lower = norm.toLowerCase();

  // Exact match wins. "The Guardian" exact-matches its roster row.
  const exact = ctx.byNameLower.get(lower);
  if (exact && exact.reference_url) {
    return {
      entity_type: exact.entity_type,
      entity_name: exact.entity_name,
      reference_url: exact.reference_url,
      match: "exact",
    };
  }

  // Try stripping a leading "The " — the doc author may write "The Guardian"
  // and the roster may have "Guardian" (or vice versa). Wikipedia
  // disambiguation is loose about leading articles.
  const withoutThe = lower.startsWith("the ") ? lower.slice(4) : `the ${lower}`;
  const exactAlt = ctx.byNameLower.get(withoutThe);
  if (exactAlt && exactAlt.reference_url) {
    return {
      entity_type: exactAlt.entity_type,
      entity_name: exactAlt.entity_name,
      reference_url: exactAlt.reference_url,
      match: "exact",
    };
  }

  // Last-name resolution: the noun is a single token AND exactly one
  // person row in the roster has that surname. "Dixon" → "Alesha Dixon"
  // when Alesha is the only Dixon in the project entity list.
  const tokens = lower.split(/\s+/).filter(Boolean);
  if (tokens.length === 1) {
    const candidates = ctx.byLastNameLower.get(tokens[0]) ?? [];
    if (candidates.length === 1) {
      const row = candidates[0];
      if (row.reference_url) {
        return {
          entity_type: row.entity_type,
          entity_name: row.entity_name,
          reference_url: row.reference_url,
          match: "last_name",
        };
      }
    }
    // candidates.length === 0 → no person with this surname; fall through
    // candidates.length > 1  → ambiguous; refuse to guess
  }

  return null;
}
