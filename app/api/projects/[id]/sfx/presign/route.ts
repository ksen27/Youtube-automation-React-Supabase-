import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { presignPutUrl } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// SFX clips are short (clicks/swipes/whooshes). The same 5MB ceiling that the
// notify route enforces is checked here too so we don't even hand out a URL
// for files that would just be rejected after upload.
const MAX_BYTES = 5 * 1024 * 1024;

const BodySchema = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1).max(100).regex(/^audio\//, "must be audio/*"),
  size: z.number().int().positive().max(MAX_BYTES),
});

// Returns a short-lived PUT URL the browser uploads an SFX clip to directly,
// bypassing Vercel's ~4.5MB request-body limit. The notify step happens via
// POST on the parent /sfx route once the PUT completes.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input", issues: parsed.error.flatten() }, { status: 400 });
  }

  const sb = getServerSupabase();
  const { data: project, error } = await sb
    .from("projects")
    .select("id")
    .eq("id", id)
    .single();
  if (error || !project) return NextResponse.json({ error: "project not found" }, { status: 404 });

  const ext = parsed.data.filename.split(".").pop()?.replace(/[^a-z0-9]/gi, "").slice(0, 6) || "mp3";
  const key = `projects/${id}/sfx/${Date.now()}.${ext}`;

  const presigned = await presignPutUrl(key, parsed.data.contentType, 900);

  return NextResponse.json({
    uploadUrl: presigned.url,
    storageKey: presigned.path,
    publicUrl: presigned.publicUrl,
    contentType: parsed.data.contentType,
    expiresInSeconds: 900,
  });
}
