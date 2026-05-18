import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { uploadBuffer, headObject, publicUrlForKey } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// SFX clips are short (clicks/swipes/whooshes). Keep the per-file limit
// modest — anything bigger than a few MB is almost certainly the wrong file.
const MAX_BYTES = 5 * 1024 * 1024;
// Hard cap so a runaway upload loop can't bloat the project row's jsonb to
// the point where DB reads get slow.
const MAX_FILES = 12;

const UuidSchema = z.string().uuid();

const NotifySchema = z.object({
  storageKey: z.string().min(1).max(500),
  contentType: z.string().min(1).max(100).regex(/^audio\//),
  filename: z.string().min(1).max(255).optional(),
});

function readSfxUrls(row: { sfx_urls: unknown } | null | undefined): string[] {
  const raw = row?.sfx_urls;
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[]).filter((u): u is string => typeof u === "string" && u.length > 0);
}

// POST: append a new SFX URL to sfx_urls. We append instead of replace
// because the render rotates through the list — the operator builds up a
// palette over multiple uploads.
//
// Two request shapes:
//  - application/json { storageKey, contentType }: the browser already PUT
//    to R2 via the presign route. Preferred path — sidesteps Vercel's
//    ~4.5MB request-body cap.
//  - multipart with `file`: legacy small-file upload (<4MB).
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UuidSchema.safeParse(id).success) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const ct = req.headers.get("content-type") ?? "";
  if (ct.startsWith("application/json")) {
    return await handleDirectUpload(id, req);
  }
  return await handleMultipartUpload(id, req);
}

async function handleDirectUpload(id: string, req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = NotifySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input", issues: parsed.error.flatten() }, { status: 400 });
  }

  const expectedPrefix = `projects/${id}/sfx/`;
  if (!parsed.data.storageKey.startsWith(expectedPrefix)) {
    return NextResponse.json({ error: "storageKey outside project prefix" }, { status: 400 });
  }

  const head = await headObject(parsed.data.storageKey);
  if (!head) return NextResponse.json({ error: "uploaded object not found" }, { status: 404 });
  if (head.size <= 0) return NextResponse.json({ error: "uploaded object is empty" }, { status: 400 });
  if (head.size > MAX_BYTES) return NextResponse.json({ error: "file too large" }, { status: 413 });

  const publicUrl = publicUrlForKey(parsed.data.storageKey);
  return await appendAndReturn(id, publicUrl);
}

async function handleMultipartUpload(id: string, req: NextRequest) {
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "missing file" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "file too large" }, { status: 413 });
  if (!file.type.startsWith("audio/")) return NextResponse.json({ error: "must be audio/*" }, { status: 400 });

  const buf = Buffer.from(await file.arrayBuffer());
  const ext = file.name.split(".").pop()?.replace(/[^a-z0-9]/gi, "").slice(0, 6) || "mp3";
  const dest = `projects/${id}/sfx/${Date.now()}.${ext}`;
  const up = await uploadBuffer(buf, dest, file.type || "application/octet-stream");
  return await appendAndReturn(id, up.publicUrl);
}

async function appendAndReturn(id: string, publicUrl: string) {
  const sb = getServerSupabase();
  const { data: existing, error: readErr } = await sb
    .from("projects")
    .select("sfx_urls")
    .eq("id", id)
    .single();
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
  const current = readSfxUrls(existing);
  if (current.length >= MAX_FILES) {
    return NextResponse.json(
      { error: `at most ${MAX_FILES} SFX files per project` },
      { status: 400 },
    );
  }

  const next = [...current, publicUrl];
  const { data, error } = await sb
    .from("projects")
    .update({ sfx_urls: next })
    .eq("id", id)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ project: data, sfx_url: publicUrl });
}

// PATCH: update only the gain. Range 0..1 — voiceover sits at 1.0 and bg
// music at 0.15, so SFX between those (default 0.7) is the typical spot.
const PatchSchema = z.object({
  sfx_gain: z.number().min(0).max(1),
}).strict();

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UuidSchema.safeParse(id).success) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const body = await req.json().catch(() => ({}));
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input", issues: parsed.error.flatten() }, { status: 400 });
  }
  const sb = getServerSupabase();
  const { data, error } = await sb
    .from("projects")
    .update({ sfx_gain: parsed.data.sfx_gain })
    .eq("id", id)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ project: data });
}

// DELETE: remove a single URL from the array (specified via `?url=`), or
// clear the whole list when no url is provided. We leave the storage
// objects behind — same pattern as bg-music.
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UuidSchema.safeParse(id).success) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const url = new URL(req.url).searchParams.get("url");
  const sb = getServerSupabase();

  let next: string[] = [];
  if (url) {
    const { data: existing, error: readErr } = await sb
      .from("projects")
      .select("sfx_urls")
      .eq("id", id)
      .single();
    if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
    next = readSfxUrls(existing).filter((u) => u !== url);
  }
  const { data, error } = await sb
    .from("projects")
    .update({ sfx_urls: next })
    .eq("id", id)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ project: data });
}
