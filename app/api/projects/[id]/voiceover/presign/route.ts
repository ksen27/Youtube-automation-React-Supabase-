import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { presignPutUrl } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1).max(100).regex(/^audio\//, "must be audio/*"),
  size: z.number().int().positive().max(2 * 1024 * 1024 * 1024), // 2GB hard ceiling
});

// Returns a short-lived PUT URL the browser can upload the audio to directly,
// bypassing the Next.js route's body-size limit. The actual notify call (which
// runs ffprobe + Deepgram against the uploaded object) happens via POST on
// the parent /voiceover route once the PUT completes.
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

  // Confirm the project exists before we hand out a write URL — otherwise we'd
  // be willing to accept uploads pointed at any UUID.
  const sb = getServerSupabase();
  const { data: project, error } = await sb
    .from("projects")
    .select("id")
    .eq("id", id)
    .single();
  if (error || !project) return NextResponse.json({ error: "project not found" }, { status: 404 });

  const ext = parsed.data.filename.split(".").pop()?.replace(/[^a-z0-9]/gi, "").slice(0, 6) || "mp3";
  const key = `projects/${id}/voiceover/${Date.now()}.${ext}`;

  const presigned = await presignPutUrl(key, parsed.data.contentType, 900);

  return NextResponse.json({
    uploadUrl: presigned.url,
    storageKey: presigned.path,
    publicUrl: presigned.publicUrl,
    contentType: parsed.data.contentType,
    expiresInSeconds: 900,
  });
}
