import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { presignPutUrl } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Presigned PUT for the synthetic "sales pitch" video. Videos are far larger
// than the avatar photo (which uses multipart), so the browser uploads the
// bytes straight to R2 via this short-lived URL and then notifies the parent
// /pitch-video route with just the storage key — mirroring the voiceover flow.
const BodySchema = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1).max(100).regex(/^video\//, "must be video/*"),
  size: z.number().int().positive().max(2 * 1024 * 1024 * 1024), // 2GB hard ceiling
});

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

  // Only synthetic projects accept a pitch video; confirm before handing out a
  // write URL (and so callers can't point uploads at an arbitrary UUID).
  const sb = getServerSupabase();
  const { data: project, error } = await sb
    .from("projects")
    .select("id, engine")
    .eq("id", id)
    .single();
  if (error || !project) return NextResponse.json({ error: "project not found" }, { status: 404 });
  if (project.engine !== "synthetic") {
    return NextResponse.json({ error: "pitch video only applies to synthetic projects" }, { status: 400 });
  }

  const ext = parsed.data.filename.split(".").pop()?.replace(/[^a-z0-9]/gi, "").slice(0, 6) || "mp4";
  const key = `projects/${id}/pitch-video/${Date.now()}.${ext}`;

  const presigned = await presignPutUrl(key, parsed.data.contentType, 900);

  return NextResponse.json({
    uploadUrl: presigned.url,
    storageKey: presigned.path,
    publicUrl: presigned.publicUrl,
    contentType: parsed.data.contentType,
    expiresInSeconds: 900,
  });
}
