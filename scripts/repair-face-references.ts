// Repair face_references rows whose reference_url cannot be fetched.
//
// Two failure shapes, both introduced by the Wikimedia /thumb/ rewrite:
//
//   1. A baked Special:Redirect URL built from a RENDITION filename, e.g.
//      ".../Special:Redirect/file/Coat_of_arms_of_Catherine,_Princess_of_Wales.svg.png".
//      Wikimedia rasterizes SVG/PDF/TIFF sources by APPENDING a raster
//      extension, but Special:Redirect addresses the SOURCE file — so these
//      404 forever. That is the 2026-08-05 incident: 102 of 103 verifications
//      errored with "reference fetch failed" and Gemini was never called.
//
//   2. A raw /thumb/ URL that is merely oversized. Harmless on its own, but
//      it flows through the same resize path, so we normalise it too.
//
// The script re-derives the correct resized URL with the fixed
// wikimediaResizedUrl(), CONFIRMS it actually fetches, and only then writes.
// A row whose URL cannot be repaired is set to NULL: lookupReference() treats
// NULL as "no reference available" and the entity degrades gracefully, which
// is strictly better than a URL guaranteed to error every candidate.
//
// Usage:
//   npx tsx --env-file=.env.local scripts/repair-face-references.ts          # dry run
//   npx tsx --env-file=.env.local scripts/repair-face-references.ts --apply  # write

import { getServerSupabase } from "@/lib/supabase/server";
import { wikimediaResizedUrl } from "@/lib/images/wikipedia";

const APPLY = process.argv.includes("--apply");
const UA = "video-automation/1.0 (image-verify; +https://github.com/video-automation)";
const SIZE_CAP = 4 * 1024 * 1024;

interface Row {
  id: string;
  project_id: string;
  entity_type: string;
  entity_name: string;
  reference_url: string;
}

// Mirrors the verifier's fetch constraints: a URL "works" only if it returns
// an image AND lands under the 4MB cap that verify.ts enforces. A 200 that is
// too large is still a dead reference, so check both.
async function probe(url: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    let res: Response;
    try {
      res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": UA } });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return { ok: false, detail: `http ${res.status}` };
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.startsWith("image/")) return { ok: false, detail: `content-type ${ct.slice(0, 40)}` };
    const bytes = (await res.arrayBuffer()).byteLength;
    if (bytes > SIZE_CAP) return { ok: false, detail: `${(bytes / 1e6).toFixed(1)}MB over cap` };
    return { ok: true, detail: `${(bytes / 1e3).toFixed(0)}KB ${ct.split(";")[0]}` };
  } catch (e) {
    return { ok: false, detail: (e as Error).message.slice(0, 60) };
  }
}

async function main() {
  const sb = getServerSupabase();
  const { data, error } = await sb
    .from("face_references")
    .select("id, project_id, entity_type, entity_name, reference_url")
    .not("reference_url", "is", null);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Row[];
  console.log(`scanning ${rows.length} reference rows${APPLY ? "" : "  (DRY RUN — pass --apply to write)"}\n`);

  let repaired = 0, cleared = 0, fine = 0;

  for (const row of rows) {
    const current = await probe(row.reference_url);
    if (current.ok) { fine++; continue; }

    // Current URL is dead. Try to re-derive a good one with the fixed builder.
    const candidate = wikimediaResizedUrl(row.reference_url, 1024);
    const label = `${row.entity_type}/${row.entity_name} [${row.project_id.slice(0, 8)}]`;

    if (candidate && candidate !== row.reference_url) {
      const fixed = await probe(candidate);
      if (fixed.ok) {
        console.log(`REPAIR  ${label}\n  was: ${row.reference_url.slice(0, 120)}  (${current.detail})\n  now: ${candidate.slice(0, 120)}  (${fixed.detail})`);
        if (APPLY) {
          const { error: e } = await sb.from("face_references")
            .update({ reference_url: candidate }).eq("id", row.id);
          if (e) console.error(`  !! write failed: ${e.message}`);
        }
        repaired++;
        continue;
      }
    }

    console.log(`CLEAR   ${label}\n  url: ${row.reference_url.slice(0, 120)}  (${current.detail}) — unrepairable, setting NULL`);
    if (APPLY) {
      const { error: e } = await sb.from("face_references")
        .update({ reference_url: null }).eq("id", row.id);
      if (e) console.error(`  !! write failed: ${e.message}`);
    }
    cleared++;
  }

  console.log(`\nok=${fine}  repaired=${repaired}  cleared=${cleared}`);
  if (!APPLY && (repaired || cleared)) console.log("dry run — re-run with --apply to persist");
}

main().catch((e) => { console.error(e); process.exit(1); });
