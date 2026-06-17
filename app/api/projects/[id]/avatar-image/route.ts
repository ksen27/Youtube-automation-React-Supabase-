import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getServerSupabase } from "@/lib/supabase/server";
import { uploadBuffer } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Upload the user's avatar source photo for the synthetic engine. The avatar
// video is generated FROM this image by HeyGen. Photos are small, so this uses
// a direct multipart upload (well under Vercel's ~4.5MB body limit) rather than
// the presigned flow the larger voiceover uploads use.
const MAX_BYTES = 10 * 1024 * 1024; // 10MB — generous headroom for a photo.

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "missing file" }, { status: 400 });
  if (!file.type.startsWith("image/")) return NextResponse.json({ error: "must be image/*" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "image too large (max 10MB)" }, { status: 413 });

  const sb = getServerSupabase();
  const { data: project, error: projErr } = await sb
    .from("projects")
    .select("id, engine")
    .eq("id", id)
    .single();
  if (projErr || !project) return NextResponse.json({ error: "project not found" }, { status: 404 });
  if (project.engine !== "synthetic") {
    return NextResponse.json({ error: "avatar image only applies to synthetic projects" }, { status: 400 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const ext = file.name.split(".").pop()?.replace(/[^a-z0-9]/gi, "").slice(0, 6) || "jpg";
  const key = `synthetic/${id}/avatar-source/${Date.now()}.${ext}`;
  const up = await uploadBuffer(buf, key, file.type || "image/jpeg");

  const { data, error } = await sb
    .from("projects")
    .update({ avatar_image_url: up.publicUrl })
    .eq("id", id)
    .select("id, avatar_image_url")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ project: data, avatar_image_url: up.publicUrl }, { status: 200 });
}
