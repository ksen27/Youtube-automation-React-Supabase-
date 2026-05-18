import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { uploadBuffer, headObject, publicUrlForKey } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Multipart fallback cap. Vercel's edge layer rejects request bodies above
// ~4.5MB, so anything larger must use the presigned-upload flow (JSON branch).
const MAX_BYTES_MULTIPART = 4 * 1024 * 1024;
// Hard ceiling for direct uploads. Music tracks are rarely huge — this is
// just a sanity guard against a runaway client pointing us at a giant object.
const MAX_BYTES_DIRECT = 200 * 1024 * 1024;

const UuidSchema = z.string().uuid();

const NotifySchema = z.object({
  storageKey: z.string().min(1).max(500),
  contentType: z.string().min(1).max(100).regex(/^audio\//),
  filename: z.string().min(1).max(255).optional(),
});

// POST: record a new bg music URL. Two shapes:
//  - application/json { storageKey, contentType }: the browser already PUT to
//    R2 via the presign route. Preferred path — sidesteps Vercel's ~4.5MB
//    request-body cap.
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

  // Lock the key to this project's prefix so callers can't point us at
  // arbitrary objects (e.g. another project's audio).
  const expectedPrefix = `projects/${id}/bg-music/`;
  if (!parsed.data.storageKey.startsWith(expectedPrefix)) {
    return NextResponse.json({ error: "storageKey outside project prefix" }, { status: 400 });
  }

  const head = await headObject(parsed.data.storageKey);
  if (!head) return NextResponse.json({ error: "uploaded object not found" }, { status: 404 });
  if (head.size <= 0) return NextResponse.json({ error: "uploaded object is empty" }, { status: 400 });
  if (head.size > MAX_BYTES_DIRECT) return NextResponse.json({ error: "uploaded object too large" }, { status: 413 });

  const publicUrl = publicUrlForKey(parsed.data.storageKey);
  return await persistAndReturn(id, publicUrl);
}

async function handleMultipartUpload(id: string, req: NextRequest) {
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "missing file" }, { status: 400 });
  if (file.size > MAX_BYTES_MULTIPART) {
    return NextResponse.json({
      error: "file too large for direct POST — use the presigned upload flow",
    }, { status: 413 });
  }
  if (!file.type.startsWith("audio/")) return NextResponse.json({ error: "must be audio/*" }, { status: 400 });

  const buf = Buffer.from(await file.arrayBuffer());
  const ext = file.name.split(".").pop()?.replace(/[^a-z0-9]/gi, "").slice(0, 6) || "mp3";
  const dest = `projects/${id}/bg-music/${Date.now()}.${ext}`;
  const up = await uploadBuffer(buf, dest, file.type || "application/octet-stream");
  return await persistAndReturn(id, up.publicUrl);
}

async function persistAndReturn(id: string, publicUrl: string) {
  const sb = getServerSupabase();
  const { data, error } = await sb
    .from("projects")
    .update({ bg_music_url: publicUrl })
    .eq("id", id)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ project: data, bg_music_url: publicUrl });
}

// PATCH: update only the gain. Range matches the slider on the export screen
// (0..0.5). Anything outside that is rejected so we can't accidentally save
// a deafening 1.0 from a stale client.
const PatchSchema = z.object({
  bg_music_gain: z.number().min(0).max(0.5),
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
    .update({ bg_music_gain: parsed.data.bg_music_gain })
    .eq("id", id)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ project: data });
}

// DELETE: clear the URL only. We leave the storage object behind — the
// user might re-upload, and stale audio under projects/.../bg-music/ is
// cheap. The clip pipeline's storage cleanup pattern is the same.
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UuidSchema.safeParse(id).success) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const sb = getServerSupabase();
  const { data, error } = await sb
    .from("projects")
    .update({ bg_music_url: null })
    .eq("id", id)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ project: data });
}
